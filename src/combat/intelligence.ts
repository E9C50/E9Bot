import { creepWhiteList } from 'settings/settings'

export type CombatUnit = Creep | PowerCreep
export interface CombatPower { attack: number; ranged: number; heal: number; rangedHeal: number; dismantle: number; claim: number }
export interface CombatSnapshot {
    enemies: CombatUnit[]
    towers: StructureTower[]
    structures: AnyStructure[]
    friendlies: Creep[]
}

let snapshotTick: number | undefined
let snapshotShard: string | undefined
let snapshots = new Map<string, CombatSnapshot>()
let powers = new WeakMap<object, CombatPower>()

function tickCache(): void {
    if (snapshotTick === Game.time && snapshotShard === Game.shard.name) return
    snapshotTick = Game.time
    snapshotShard = Game.shard.name
    snapshots = new Map()
    powers = new WeakMap()
}

export function combatRange(first: RoomPosition, second: RoomPosition): number {
    return first.roomName === second.roomName ? Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y)) : Infinity
}

export function isInvulnerable(target: RoomObject): boolean {
    return (target.effects || []).some(effect => effect.effect === EFFECT_INVULNERABILITY && effect.ticksRemaining > 0)
}

/** The existing player whitelist applies equally to units, owned structures and room barriers. */
export function isCombatHostile(target: RoomObject, room?: Room): boolean {
    const owned = target as RoomObject & { my?: boolean; owner?: Owner }
    if (owned.my === true || owned.owner && creepWhiteList.includes(owned.owner.username)) return false
    if (owned.owner) return true
    const structure = target as Structure
    if (structure.structureType !== STRUCTURE_WALL && structure.structureType !== STRUCTURE_RAMPART) return false
    const controller = (room || target.room)?.controller
    return controller?.my !== true && (!controller?.owner || !creepWhiteList.includes(controller.owner.username))
}

export function combatSnapshot(room: Room): CombatSnapshot {
    tickCache()
    const known = snapshots.get(room.name)
    if (known) return known
    const structures = (room.structures || room.find(FIND_STRUCTURES)).filter(structure =>
        structure.hits !== undefined && structure.hits > 0 && isCombatHostile(structure, room) && !isInvulnerable(structure))
    const snapshot: CombatSnapshot = {
        enemies: room.enemies.filter(enemy => !enemy.my && !isInvulnerable(enemy)),
        towers: structures.filter((structure): structure is StructureTower => structure.structureType === STRUCTURE_TOWER),
        structures: structures as AnyStructure[],
        friendlies: room.find(FIND_MY_CREEPS),
    }
    snapshots.set(room.name, snapshot)
    return snapshot
}

function boostedPower(part: BodyPartDefinition, action: string, nativePower: number): number {
    if (part.hits <= 0) return 0
    const effects = part.boost ? BOOSTS[part.type][part.boost] as { [action: string]: number } | undefined : undefined
    return nativePower * (effects?.[action] || 1)
}

export function combatPower(creep: CombatUnit): CombatPower {
    tickCache()
    const known = powers.get(creep)
    if (known) return known
    const result: CombatPower = { attack: 0, ranged: 0, heal: 0, rangedHeal: 0, dismantle: 0, claim: 0 }
    for (const part of 'body' in creep ? creep.body : []) {
        if (part.type === ATTACK) result.attack += boostedPower(part, 'attack', ATTACK_POWER)
        if (part.type === RANGED_ATTACK) result.ranged += boostedPower(part, 'rangedAttack', RANGED_ATTACK_POWER)
        if (part.type === HEAL) {
            result.heal += boostedPower(part, 'heal', HEAL_POWER)
            result.rangedHeal += boostedPower(part, 'rangedHeal', RANGED_HEAL_POWER)
        }
        if (part.type === WORK) result.dismantle += boostedPower(part, 'dismantle', DISMANTLE_POWER)
        if (part.type === CLAIM && part.hits > 0) result.claim++
    }
    powers.set(creep, result)
    return result
}

/** Consume each live front part before moving on; excess damage remains visible for kill planning. */
export function effectiveDamage(creep: CombatUnit, rawDamage: number): number {
    const raw = Math.max(0, rawDamage)
    let remaining = raw, damage = 0
    for (const part of 'body' in creep ? creep.body : []) {
        if (part.hits <= 0 || remaining <= 0) continue
        const boost = part.type === TOUGH && part.boost ? BOOSTS[TOUGH][part.boost] : undefined
        const multiplier = boost && 'damage' in boost ? boost.damage : 1
        const absorbed = Math.min(remaining, part.hits / multiplier)
        remaining -= absorbed
        damage += absorbed * multiplier
    }
    // Native engine rounds the total reduction, rather than rounding each damage segment upwards.
    return raw - Math.round(raw - damage - remaining)
}

function towerPower(tower: StructureTower, pos: RoomPosition, nativePower: number): number {
    if (combatRange(tower.pos, pos) === Infinity || tower.store[RESOURCE_ENERGY] < TOWER_ENERGY_COST || !tower.isActive()) return 0
    const distance = combatRange(tower.pos, pos)
    const falloff = Math.min(1, Math.max(0, (distance - TOWER_OPTIMAL_RANGE) / (TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE)))
    let power = nativePower * (1 - TOWER_FALLOFF * falloff)
    for (const active of tower.effects || []) {
        if (active.ticksRemaining <= 0 || !('level' in active) || active.level === undefined) continue
        if (active.effect === PWR_OPERATE_TOWER || active.effect === PWR_DISRUPT_TOWER)
            power *= POWER_INFO[active.effect].effect[active.level - 1]
    }
    return Math.floor(power)
}

export function towerDamage(tower: StructureTower, pos: RoomPosition): number { return towerPower(tower, pos, TOWER_POWER_ATTACK) }
export function towerHeal(tower: StructureTower, pos: RoomPosition): number { return towerPower(tower, pos, TOWER_POWER_HEAL) }

function enemyCanStep(enemy: CombatUnit, pos: RoomPosition, attackRange: number): boolean {
    if (!('body' in enemy) || enemy.fatigue > 0 || !enemy.body.some(part => part.type === MOVE && part.hits > 0)) return false
    const room = enemy.room
    const terrain = room.getTerrain()
    const natural = [...(room.sources || []), ...(room.mineral ? [room.mineral] : []), ...(room.controller ? [room.controller] : [])]
    for (let x = Math.max(0, enemy.pos.x - 1); x <= Math.min(49, enemy.pos.x + 1); x++) {
        for (let y = Math.max(0, enemy.pos.y - 1); y <= Math.min(49, enemy.pos.y + 1); y++) {
            if (Math.max(Math.abs(pos.x - x), Math.abs(pos.y - y)) > attackRange || (terrain.get(x, y) & TERRAIN_MASK_WALL) !== 0 ||
                natural.some(object => object.pos.x === x && object.pos.y === y)) continue
            const blocked = room.lookForAt(LOOK_STRUCTURES, x, y).some(structure =>
                (OBSTACLE_OBJECT_TYPES as readonly string[]).includes(structure.structureType) ||
                structure.structureType === STRUCTURE_RAMPART && !(structure as StructureRampart).isPublic &&
                    (structure as StructureRampart).owner.username !== enemy.owner.username)
            if (!blocked) return true
        }
    }
    return false
}

/** Conservative next-tick pressure; one ranged intent per enemy, with melee added independently. */
export function incomingDamage(creep: CombatUnit, pos: RoomPosition, snapshot: CombatSnapshot, predictMovement: boolean = true): number {
    const room = Game.rooms[pos.roomName]
    if (creep.my && room?.controller?.my && room.controller.safeMode) return 0
    let damage = snapshot.towers.reduce((sum, tower) => sum + towerDamage(tower, pos), 0)
    for (const enemy of snapshot.enemies) {
        const distance = combatRange(enemy.pos, pos)
        if (distance === Infinity) continue
        const power = combatPower(enemy)
        if (distance <= 1 || predictMovement && distance === 2 && enemyCanStep(enemy, pos, 1)) damage += power.attack
        if (distance <= 3 || predictMovement && distance === 4 && enemyCanStep(enemy, pos, 3)) damage += power.ranged
    }
    // A friendly rampart absorbs incoming pressure before the occupant's TOUGH parts.
    const cover = room?.lookForAt(LOOK_STRUCTURES, pos.x, pos.y).find((structure): structure is StructureRampart =>
        structure.structureType === STRUCTURE_RAMPART && (structure as StructureRampart).my && structure.hits > 0)
    if (cover) damage = Math.max(0, damage - cover.hits)
    return effectiveDamage(creep, damage)
}
