import { combatSnapshot, combatPower, effectiveDamage, incomingDamage, towerDamage } from './intelligence'
import { defenseGroups } from './defenseGroups'
import { enemyHealing, runRoomTowerDefense } from './towers'
import { combatDefensePolicy } from 'settings/combatDefense'

type Position = { x: number; y: number; roomName: string }
type Enemy = Creep | PowerCreep
interface GuardData extends DefenderData { groupKey?: string; guardPosition?: Position; pursuitStartedAt?: number }
interface Geometry { ramparts: StructureRampart[]; blocked: Set<number>; occupants: Map<number, string>; terrain?: RoomTerrain; matrix?: CostMatrix }
let tick: number | undefined, shard: string | undefined, geometries = new WeakMap<Room, Geometry>()
let claimedSeats = new Map<string, string>()
let enemyPresence = new WeakMap<Room, boolean>()
const code = (pos: { x: number; y: number }): number => pos.y * 50 + pos.x
const range = (first: Position, second: { x: number; y: number }): number => Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y))
const isGuard = (creep: Creep | PowerCreep): boolean => ['defender', 'rdefender'].includes((creep.memory as CreepMemory)?.role)

function syncGuardTick(): void {
    if (tick !== Game.time || shard !== Game.shard?.name) {
        tick = Game.time; shard = Game.shard?.name; geometries = new WeakMap(); claimedSeats = new Map(); enemyPresence = new WeakMap()
    }
}

function roomHasEnemies(room: Room): boolean {
    syncGuardTick()
    let result = enemyPresence.get(room)
    if (result == undefined) { result = room.enemies.length > 0; enemyPresence.set(room, result) }
    return result
}

function geometry(room: Room): Geometry {
    syncGuardTick()
    const cached = geometries.get(room)
    if (cached != undefined) return cached
    const blocked = new Set<number>(), occupants = new Map<number, string>()
    for (const structure of room.structures || []) {
        if (structure.structureType === STRUCTURE_ROAD || structure.structureType === STRUCTURE_CONTAINER ||
            structure.structureType === STRUCTURE_RAMPART && ((structure as StructureRampart).my || (structure as StructureRampart).isPublic)) continue
        blocked.add(code(structure.pos))
    }
    for (const source of room.sources || []) blocked.add(code(source.pos))
    if (room.mineral != undefined) blocked.add(code(room.mineral.pos))
    if (room.controller?.pos != undefined) blocked.add(code(room.controller.pos))
    const manager = room.memory.roomPosition?.managerPos
    if (manager != undefined) blocked.add(code(manager))
    const snapshot = combatSnapshot(room)
    for (const friendly of snapshot.friendlies) occupants.set(code(friendly.pos), friendly.name)
    for (const enemy of snapshot.enemies) blocked.add(code(enemy.pos))
    const terrain = typeof Room !== 'undefined' && typeof Room.Terrain === 'function' ? new Room.Terrain(room.name) :
        typeof room.getTerrain === 'function' ? room.getTerrain() : undefined
    const value: Geometry = { ramparts: room.ramparts || [], blocked, occupants, terrain }
    geometries.set(room, value)
    return value
}

function walkable(pos: Position, creep: Creep, map: Geometry): boolean {
    if (pos.x <= 0 || pos.y <= 0 || pos.x >= 49 || pos.y >= 49 || pos.roomName !== creep.room.name || map.blocked.has(code(pos))) return false
    if (map.terrain != undefined && (map.terrain.get(pos.x, pos.y) & TERRAIN_MASK_WALL) !== 0) return false
    const occupied = map.occupants.get(code(pos)), claimed = claimedSeats.get(`${pos.roomName}:${code(pos)}`)
    return (occupied == undefined || occupied === creep.name) && (claimed == undefined || claimed === creep.name)
}

function roomPosition(pos: Position): RoomPosition { return new RoomPosition(pos.x, pos.y, pos.roomName) }

function selectGuardPosition(creep: Creep, target: Enemy, data: GuardData, map: Geometry): Position | undefined {
    let best: Position | undefined, bestScore = Infinity
    if (map.ramparts.length > 0 && map.matrix == undefined && typeof creep.room.getDefenderCostMatrix === 'function') {
        map.matrix = creep.room.getDefenderCostMatrix()
        const manager = creep.room.memory.roomPosition?.managerPos
        if (manager != undefined && typeof map.matrix?.clone === 'function') {
            map.matrix = map.matrix.clone(); map.matrix.set(manager.x, manager.y, 255)
        }
    }
    for (const rampart of map.ramparts) {
        if (rampart.my === false || rampart.hits <= 0 || !walkable(rampart.pos, creep, map) || map.matrix?.get(rampart.pos.x, rampart.pos.y) === 255) continue
        const score = range(rampart.pos, target.pos) * combatDefensePolicy.threat.guardDistanceWeight + range(creep.pos, rampart.pos)
        if (score < bestScore) { best = rampart.pos; bestScore = score }
    }
    const previous = data.guardPosition
    if (previous != undefined && walkable(previous, creep, map) && map.ramparts.some(rampart => range(previous, rampart.pos) === 0 && rampart.my !== false) &&
        (best == undefined || range(previous, target.pos) <= range(best, target.pos) + combatDefensePolicy.guards.positionSlack)) best = previous
    if (best == undefined) {
        const anchor = creep.room.spawns?.[0]?.pos || creep.room.storage?.pos || creep.pos
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            const candidate = { x: anchor.x + dx, y: anchor.y + dy, roomName: creep.room.name }
            if (!walkable(candidate, creep, map)) continue
            const score = range(candidate, target.pos) * combatDefensePolicy.threat.guardDistanceWeight + range(creep.pos, candidate)
            if (score < bestScore) { best = candidate; bestScore = score }
        }
    }
    if (best == undefined) return undefined
    const result = { x: best.x, y: best.y, roomName: creep.room.name }
    claimedSeats.set(`${result.roomName}:${code(result)}`, creep.name)
    data.guardPosition = result
    return result
}

function moveToGuard(creep: Creep, guard: Position, map: Geometry): void {
    if (range(creep.pos, guard) === 0) return
    creep.moveTo(roomPosition(guard), {
        range: 0, maxRooms: 1, reusePath: combatDefensePolicy.guards.reusePath,
        costCallback: () => map.matrix,
    })
}

/** A local connected grid proves the same short corridor remains available for returning. */
function pursuitStep(creep: Creep, target: Enemy, guard: Position, map: Geometry, attackRange: number): Position | undefined {
    const policy = combatDefensePolicy.pursuit
    const positions: Position[] = [guard], visited = new Set([code(guard)])
    for (let index = 0; index < positions.length && index < policy.maximumSearchNodes; index++) {
        const current = positions[index]
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue
            const next = { x: current.x + dx, y: current.y + dy, roomName: guard.roomName }
            if (visited.has(code(next)) || range(next, guard) > policy.maximumRange || !walkable(next, creep, map)) continue
            visited.add(code(next)); positions.push(next)
        }
    }
    if (!visited.has(code(creep.pos))) return undefined
    let result: Position | undefined, bestDistance = range(creep.pos, target.pos)
    for (const pos of positions) {
        if (range(creep.pos, pos) !== 1) continue
        const distance = range(pos, target.pos)
        if (distance < bestDistance && distance >= attackRange) { result = pos; bestDistance = distance }
    }
    return result
}

function canPursue(creep: Creep, target: Enemy, guard: Position, candidate: Position, data: GuardData): boolean {
    const policy = combatDefensePolicy.pursuit, snapshot = combatSnapshot(creep.room)
    if (!policy.enabled || creep.fatigue > 0 || creep.hits / creep.hitsMax < policy.minimumHealthRatio ||
        data.pursuitStartedAt != undefined && Game.time - data.pursuitStartedAt >= policy.maximumTicks) return false
    if (snapshot.structures.some(structure => structure.structureType === STRUCTURE_RAMPART && structure.hits > 0 && range(target.pos, structure.pos) === 0)) return false
    if (incomingDamage(creep, roomPosition(candidate), snapshot) * policy.reactionTicks > creep.hits * policy.maximumDamageFraction ||
        incomingDamage(creep, roomPosition(guard), snapshot) * policy.reactionTicks >= creep.hits) return false
    let backup = false
    for (const friendly of snapshot.friendlies) if (friendly.name !== creep.name && isGuard(friendly) && range(guard, friendly.pos) <= 1 &&
        friendly.hits / friendly.hitsMax >= policy.retreatHealthRatio) { backup = true; break }
    if (!backup && snapshot.enemies.some(enemy => range(guard, enemy.pos) <= policy.criticalEntranceRange &&
        combatPower(enemy).attack + combatPower(enemy).dismantle + combatPower(enemy).claim > 0)) return false
    const support = (creep.room.towers || []).reduce((sum, tower) => sum + (tower.my === false ? 0 : towerDamage(tower, target.pos)), 0)
    if (policy.requireTowerSupport && support <= 0) return false
    const own = combatPower(creep)
    return effectiveDamage(target, support + own.attack + own.ranged) > enemyHealing(target, snapshot.enemies)
}

export function runDefender(creep: Creep, supplied: CreepData, ranged: boolean): boolean {
    const data = supplied as GuardData
    runRoomTowerDefense(creep.room)
    if (!roomHasEnemies(creep.room)) {
        delete data.pursuitStartedAt
        if (data.guardPosition != undefined && range(creep.pos, data.guardPosition) !== 0)
            creep.moveTo(roomPosition(data.guardPosition), { range: 0, maxRooms: 1, reusePath: combatDefensePolicy.guards.reusePath })
        return true
    }
    const snapshot = combatSnapshot(creep.room)
    if (snapshot.enemies.length === 0) { delete data.pursuitStartedAt; return true }
    const groups = defenseGroups(creep.room)
    const group = groups.find(candidate => candidate.key === data.groupKey || candidate.enemies.some(enemy => enemy.id === data.targetEnemy))
    let target: Enemy | undefined = group?.target || snapshot.enemies.find(enemy => enemy.id === data.targetEnemy)
    if (group != undefined) data.groupKey = group.key
    if (target == undefined) {
        let closest = Infinity
        for (const enemy of snapshot.enemies) {
            const distance = range(creep.pos, enemy.pos)
            if (distance < closest) { target = enemy; closest = distance }
        }
    }
    if (target == undefined) return true
    data.targetEnemy = target.id
    let attackTarget: Enemy | undefined, attackScore = -Infinity, massDamage = 0
    const own = combatPower(creep), attackRange = ranged ? 3 : 1
    for (const enemy of snapshot.enemies) {
        const distance = range(creep.pos, enemy.pos)
        if (distance > attackRange) continue
        const damage = ranged ? own.ranged : own.attack
        const score = effectiveDamage(enemy, damage) / Math.max(1, enemy.hits) + (enemy === target ? 1 : 0)
        if (score > attackScore) { attackTarget = enemy; attackScore = score }
        if (ranged) massDamage += effectiveDamage(enemy, damage * (distance <= 1 ? 1 : distance === 2 ? 0.4 : 0.1))
    }
    if (attackTarget != undefined) {
        if (ranged && massDamage > effectiveDamage(attackTarget, own.ranged)) creep.rangedMassAttack()
        else if (ranged) creep.rangedAttack(attackTarget)
        else creep.attack(attackTarget)
        data.lastEnemy = attackTarget.id
    }
    if (own.heal > 0 && creep.hits < creep.hitsMax && (ranged || attackTarget == undefined)) creep.heal(creep)
    const map = geometry(creep.room), guard = selectGuardPosition(creep, target, data, map)
    if (guard == undefined) return true
    if (data.pursuitStartedAt == undefined && range(creep.pos, guard) > 0) { moveToGuard(creep, guard, map); return true }
    if (range(creep.pos, guard) === 0 && data.pursuitStartedAt != undefined) { delete data.pursuitStartedAt; return true }
    if (range(creep.pos, guard) > combatDefensePolicy.pursuit.maximumRange || creep.hits / creep.hitsMax < combatDefensePolicy.pursuit.retreatHealthRatio ||
        data.pursuitStartedAt != undefined && Game.time - data.pursuitStartedAt >= combatDefensePolicy.pursuit.maximumTicks) {
        moveToGuard(creep, guard, map); return true
    }
    if (range(creep.pos, target.pos) > attackRange) {
        const next = pursuitStep(creep, target, guard, map, attackRange)
        if (next != undefined && canPursue(creep, target, guard, next, data)) {
            data.pursuitStartedAt ??= Game.time
            creep.moveTo(roomPosition(next), { range: 0, maxRooms: 1, reusePath: 0 })
            return true
        }
    }
    moveToGuard(creep, guard, map)
    return true
}
