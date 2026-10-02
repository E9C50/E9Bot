import { combatSnapshot, combatPower, effectiveDamage, incomingDamage, towerDamage, towerHeal, isCombatHostile, isInvulnerable } from './intelligence'
import { combatDefensePolicy } from 'settings/combatDefense'

export interface TowerSupportOptions { healFriendly?: boolean }
type TowerAction = 'attack' | 'heal' | 'repair'
type CombatUnit = Creep | PowerCreep
let tick: number | undefined, shard: string | undefined
let intents = new WeakMap<StructureTower, TowerAction>()
let claimedTowerIds = new Set<string>()
let resolvedRooms = new WeakSet<Room>()
let woundedByRoom: Map<string, CombatUnit[]> | undefined
let healingCache = new WeakMap<CombatUnit, { enemies: readonly CombatUnit[]; amount: number }>()
let mobilityCache = new WeakMap<CombatUnit, boolean>()

function sync(): void {
    if (tick === Game.time && shard === Game.shard?.name) return
    tick = Game.time; shard = Game.shard?.name
    intents = new WeakMap(); claimedTowerIds = new Set(); resolvedRooms = new WeakSet(); woundedByRoom = undefined
    healingCache = new WeakMap(); mobilityCache = new WeakMap()
}

function woundedFriendlies(roomName: string): CombatUnit[] {
    if (woundedByRoom == undefined) {
        woundedByRoom = new Map()
        const include = (creep: CombatUnit): void => {
            if (creep.room == undefined || creep.hits >= creep.hitsMax) return
            const group = woundedByRoom!.get(creep.room.name)
            if (group == undefined) woundedByRoom!.set(creep.room.name, [creep])
            else group.push(creep)
        }
        for (const name in Game.creeps || {}) include(Game.creeps[name])
        for (const name in Game.powerCreeps || {}) include(Game.powerCreeps[name])
    }
    return woundedByRoom.get(roomName) || []
}

export function hasTowerIntent(tower: StructureTower): boolean { sync(); return intents.has(tower) || claimedTowerIds.has(tower.id) }

function usable(tower: StructureTower): boolean {
    return !hasTowerIntent(tower) && tower.my !== false && tower.store[RESOURCE_ENERGY] >= TOWER_ENERGY_COST &&
        (typeof tower.isActive !== 'function' || tower.isActive())
}

function issue(tower: StructureTower, action: TowerAction, target: CombatUnit | Structure): boolean {
    if (!usable(tower)) return false
    const result = action === 'attack' ? tower.attack(target) : action === 'heal' ? tower.heal(target as Creep) : tower.repair(target as Structure)
    if (result === OK || result === undefined) { intents.set(tower, action); if (tower.id) claimedTowerIds.add(tower.id); return true }
    return false
}

export function issueTowerRepair(tower: StructureTower, target: Structure): boolean { return issue(tower, 'repair', target) }

function distance(first: RoomPosition, second: RoomPosition): number {
    return Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y))
}

/** A healer can support one target; each candidate conservatively receives all reachable support. */
export function enemyHealing(target: CombatUnit, enemies: readonly CombatUnit[]): number {
    sync()
    const cached = healingCache.get(target)
    if (cached?.enemies === enemies) return cached.amount
    let total = 0
    for (const enemy of enemies) {
        const power = combatPower(enemy)
        if (power.heal <= 0 && power.rangedHeal <= 0) continue
        let range = distance(enemy.pos, target.pos)
        let mobile = mobilityCache.get(enemy)
        if (mobile == undefined) {
            mobile = 'body' in enemy && !enemy.fatigue && enemy.body.some(part => part.type === MOVE && part.hits > 0)
            mobilityCache.set(enemy, mobile)
        }
        if (enemy !== target && combatDefensePolicy.towers.predictedHealMovement && mobile) range = Math.max(0, range - 1)
        if (range <= 1) total += power.heal
        else if (range <= 3) total += power.rangedHeal
    }
    healingCache.set(target, { enemies, amount: total })
    return total
}

function threat(creep: CombatUnit): number {
    const power = combatPower(creep)
    return power.attack + power.ranged + power.dismantle + power.heal * combatDefensePolicy.threat.healingWeight + power.claim * combatDefensePolicy.threat.claimWeight
}

function allocateHeal(target: CombatUnit, towers: StructureTower[], predicted = 0, rescue = false): void {
    const goal = rescue ? Math.max(target.hitsMax * combatDefensePolicy.towers.criticalHealthRatio,
        predicted * combatDefensePolicy.pursuit.reactionTicks) : target.hitsMax + predicted
    let needed = Math.min(Math.max(0, goal - target.hits), target.hitsMax)
    // At most six native towers: sorting this small private array never touches shared room lists.
    const candidates = towers.filter(usable).sort((a, b) => towerHeal(b, target.pos) - towerHeal(a, target.pos))
    for (const tower of candidates) {
        if (needed <= 0) break
        const healing = towerHeal(tower, target.pos)
        if (healing > 0 && issue(tower, 'heal', target)) needed -= healing
    }
}

/** One shared decision per room and tick. Accepted tower intents cannot be overwritten later. */
export function runRoomTowerDefense(room: Room): void {
    sync()
    if (resolvedRooms.has(room)) return
    resolvedRooms.add(room)
    if (!room.towers?.length) return
    // Peaceful rooms need no native structure/friendly scans; one empire injury index serves every room.
    if (room.enemies.length === 0) {
        const wounded = woundedFriendlies(room.name)
        if (wounded.length > 0) for (const friendly of wounded) allocateHeal(friendly, room.towers)
        return
    }
    const snapshot = combatSnapshot(room)
    // snapshot.towers contains hostile towers for incomingDamage; room.towers supplies our own defenses.
    const towers = room.towers.filter(usable)
    if (towers.length === 0) return
    const enemies = snapshot.enemies.filter(enemy => !isInvulnerable(enemy))
    let critical: CombatUnit | undefined, criticalIncoming = 0
    for (const friendly of snapshot.friendlies) {
        if (friendly.hits >= friendly.hitsMax) continue
        const predicted = enemies.length > 0 ? incomingDamage(friendly, friendly.pos, snapshot) : 0
        const role = (friendly.memory as CreepMemory)?.role
        const important = role === 'defender' || role === 'rdefender' || predicted > 0
        if (enemies.length > 0 && important && (friendly.hits / friendly.hitsMax <= combatDefensePolicy.towers.criticalHealthRatio || predicted >= friendly.hits)) {
            if (critical == undefined || friendly.hits / friendly.hitsMax < critical.hits / critical.hitsMax) {
                critical = friendly; criticalIncoming = predicted
            }
        }
    }
    if (critical != undefined) allocateHeal(critical, towers, criticalIncoming, true)
    const coversByPosition = new Map<number, StructureRampart>()
    for (const structure of snapshot.structures) if (structure.structureType === STRUCTURE_RAMPART && structure.hits > 0)
        coversByPosition.set(structure.pos.y * 50 + structure.pos.x, structure as StructureRampart)
    const barriers = new Map<StructureRampart, number>(), remainingTargets = new Set<CombatUnit>()
    for (const enemy of enemies) {
        const cover = coversByPosition.get(enemy.pos.y * 50 + enemy.pos.x)
        if (cover == undefined) remainingTargets.add(enemy)
        else barriers.set(cover, Math.max(barriers.get(cover) || 0, threat(enemy)))
    }
    const damageByTarget = new Map(enemies.map(target => [target,
        towers.map(tower => ({ tower, damage: towerDamage(tower, target.pos) })).filter(entry => entry.damage > 0).sort((a, b) => b.damage - a.damage)]))
    while (remainingTargets.size > 0) {
        const available = towers.filter(usable)
        if (available.length === 0) break
        let kill: { target: CombatUnit; towers: StructureTower[]; threat: number } | undefined
        for (const target of remainingTargets) {
            const ranked = damageByTarget.get(target)!.filter(entry => usable(entry.tower))
            const threshold = target.hits + enemyHealing(target, enemies)
            let raw = 0
            for (let index = 0; index < ranked.length; index++) {
                raw += ranked[index].damage
                if (effectiveDamage(target, raw) < threshold) continue
                const count = index + 1, value = threat(target)
                if (kill == undefined || count < kill.towers.length || count === kill.towers.length && value > kill.threat)
                    kill = { target, towers: ranked.slice(0, count).map(entry => entry.tower), threat: value }
                break
            }
        }
        if (kill == undefined) break
        let issued = false
        for (const tower of kill.towers) issued = issue(tower, 'attack', kill.target) || issued
        remainingTargets.delete(kill.target)
        if (!issued) break
    }
    const available = towers.filter(usable)
    if (remainingTargets.size > 0 && available.length > 0) {
        let best: CombatUnit | undefined, bestScore = -Infinity
        for (const enemy of remainingTargets) {
            const raw = available.reduce((sum, tower) => sum + towerDamage(tower, enemy.pos), 0)
            const net = effectiveDamage(enemy, raw) - enemyHealing(enemy, enemies)
            const score = net / Math.max(1, enemy.hits) + threat(enemy) / Math.max(1, enemy.hitsMax)
            if (score > bestScore) { best = enemy; bestScore = score }
        }
        let guard: CombatUnit | undefined
        for (const friendly of snapshot.friendlies) {
            if (friendly.hits / friendly.hitsMax >= combatDefensePolicy.towers.guardedHealthRatio ||
                !['defender', 'rdefender'].includes((friendly.memory as CreepMemory)?.role)) continue
            if (guard == undefined || friendly.hits / friendly.hitsMax < guard.hits / guard.hitsMax) guard = friendly
        }
        if (guard != undefined && best != undefined && effectiveDamage(best, available.reduce((sum, tower) => sum + towerDamage(tower, best!.pos), 0)) <= enemyHealing(best, enemies))
            allocateHeal(guard, available)
        if (best != undefined) for (const tower of available) issue(tower, 'attack', best)
    }
    // Damage lands on hostile cover before its occupant, so never claim the occupant was killed.
    while (barriers.size > 0) {
        const available = towers.filter(usable)
        if (available.length === 0) break
        let best: StructureRampart | undefined, priority = -Infinity
        for (const [barrier, value] of barriers) if (value > priority) { priority = value; best = barrier }
        if (best == undefined) break
        const ranked = available.map(tower => ({ tower, damage: towerDamage(tower, best!.pos) })).sort((a, b) => b.damage - a.damage)
        let damage = 0
        for (const entry of ranked) {
            if (entry.damage > 0 && issue(entry.tower, 'attack', best)) damage += entry.damage
            if (damage >= best.hits) break
        }
        barriers.delete(best)
    }
    // Peaceful healing retains the first friendly tie and leaves unused towers available for normal repairs.
    if (enemies.length === 0 || remainingTargets.size === 0) {
        for (const friendly of snapshot.friendlies) if (friendly.hits < friendly.hitsMax) allocateHeal(friendly, towers)
    }
}

export function requestTowerSupport(target: CombatUnit | Structure | undefined, options: TowerSupportOptions = {}): void {
    const room = target?.room
    if (target == undefined || room == undefined || !room.towers?.length) return
    runRoomTowerDefense(room)
    if (('body' in target || 'powers' in target) && target.my) {
        if (options.healFriendly && target.hits < target.hitsMax) allocateHeal(target, room.towers)
        return
    }
    // A hostile structure outside the enemy creep snapshot can receive only unused towers.
    if ('structureType' in target && isCombatHostile(target, room) && !isInvulnerable(target))
        for (const tower of room.towers) issue(tower, 'attack', target)
}
