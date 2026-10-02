import { CombatSnapshot, CombatUnit, combatPower, combatRange, combatSnapshot,
    effectiveDamage, incomingDamage, isCombatHostile, towerHeal } from './intelligence'
import { CombatFormation, PositionPlan, planSquadMovement, squadBreachTarget, translateSquad } from './squadMovement'
import { combatTacticsPolicy } from 'settings/combatTactics'
export { combatTacticsPolicy } from 'settings/combatTactics'

export interface CombatSquadOptions {
    targetRoom: string
    mode: 'attack' | 'hold'
    retreatRoom?: string
    formation?: CombatFormation
}

type Target = CombatUnit | AnyStructure
type IntentState = { primary: boolean; ranged: boolean; move: boolean; healing?: { target: Creep; amount: number; range: number } }
type SquadState = { order: string[]; lastSeen: number; retreatUntil: number }
let intentTick: number | undefined
let intentShard: string | undefined
let intents = new Map<string, IntentState>()
let executed = new Set<string>()
let collateral = new Map<string, RoomObject[]>()
const squads = new Map<string, SquadState>()

function tickIntents(): void {
    if (intentTick === Game.time && intentShard === Game.shard.name) return
    if (intentShard !== Game.shard.name) squads.clear()
    intentTick = Game.time; intentShard = Game.shard.name; intents = new Map(); executed = new Set()
    collateral = new Map()
    for (const [key, state] of squads) if (state.lastSeen + combatTacticsPolicy.stateRetentionTicks < Game.time) squads.delete(key)
}

function intent(member: Creep): IntentState {
    const known = intents.get(member.name)
    if (known) return known
    const created = { primary: false, ranged: false, move: false }
    intents.set(member.name, created)
    return created
}

function orderedMembers(members: Creep[], options: CombatSquadOptions): { members: Creep[]; state: SquadState } {
    const key = `${options.targetRoom}:${options.formation}:${members.map(member => member.name).sort().join(',')}`
    let state = squads.get(key)
    if (!state) {
        const ordered = members.slice().sort((first, second) => {
            const a = combatPower(first), b = combatPower(second)
            return (b.attack + b.ranged + b.dismantle) - (a.attack + a.ranged + a.dismantle) || first.name.localeCompare(second.name)
        })
        state = { order: ordered.map(member => member.name), lastSeen: Game.time, retreatUntil: 0 }
        squads.set(key, state)
    }
    state.lastSeen = Game.time
    return { members: state.order.map(name => members.find(member => member.name === name)!).filter(Boolean), state }
}

function structure(target: Target): target is AnyStructure { return 'structureType' in target }
function canDismantle(target: Target): target is AnyStructure {
    return structure(target) && target.structureType !== STRUCTURE_INVADER_CORE
}

function protectedTarget(target: Target, snapshot: CombatSnapshot): Target {
    return snapshot.structures.find(candidate => candidate.structureType === STRUCTURE_RAMPART &&
        combatRange(candidate.pos, target.pos) === 0) || target
}

function priority(target: Target): number {
    const policy = combatTacticsPolicy.targeting
    if (!structure(target)) {
        const power = combatPower(target)
        return power.heal > 0 ? policy.healer : power.attack + power.ranged > 0 ? policy.fighter : policy.civilian
    }
    if (target.structureType === STRUCTURE_TOWER) return policy.tower
    if (target.structureType === STRUCTURE_SPAWN || target.structureType === STRUCTURE_INVADER_CORE) return policy.spawnOrCore
    if (target.structureType === STRUCTURE_RAMPART || target.structureType === STRUCTURE_WALL) return policy.barrier
    return policy.otherStructure
}

function chooseTarget(leader: Creep, snapshot: CombatSnapshot, mode: 'attack' | 'hold'): Target | undefined {
    const candidates: Target[] = [...snapshot.enemies, ...(mode === 'attack' ? snapshot.structures : [])]
    let selected: Target | undefined, best = Infinity
    for (const candidate of candidates) {
        const protectedCandidate = protectedTarget(candidate, snapshot)
        const score = priority(candidate) * combatTacticsPolicy.targeting.priorityWeight +
            combatRange(leader.pos, candidate.pos) * combatTacticsPolicy.targeting.rangeWeight +
            Math.min(combatTacticsPolicy.targeting.maximumHitsPenalty, protectedCandidate.hits / combatTacticsPolicy.targeting.hitsScale)
        if (score < best) { selected = protectedCandidate; best = score }
    }
    return selected
}

function snapshotFor(member: Creep): CombatSnapshot { return combatSnapshot(member.room) }

function healSquad(members: Creep[]): void {
    const targets = new Map<string, Creep>()
    for (const member of members) {
        targets.set(member.name, member)
        for (const ally of snapshotFor(member).friendlies) targets.set(ally.name, ally)
    }
    const unmet = new Map<Creep, number>()
    const pressure = new Map<Creep, number>(), assigned = new Map<Creep, number>()
    for (const target of targets.values()) {
        const damage = incomingDamage(target, target.pos, snapshotFor(target))
        pressure.set(target, damage); unmet.set(target, target.hitsMax - target.hits + damage)
    }
    const healers = members.slice().sort((a, b) => combatPower(b).heal - combatPower(a).heal)
    for (const healer of healers) {
        const used = intent(healer), power = combatPower(healer)
        if (used.primary || power.heal === 0) continue
        let selected: Creep | undefined, score = 0, amount = 0, selectedCritical = false
        for (const target of targets.values()) {
            const distance = combatRange(healer.pos, target.pos), need = unmet.get(target) || 0
            if (need <= 0 || distance > 3 || distance > 1 && used.ranged) continue
            const available = distance <= 1 ? power.heal : power.rangedHeal
            const critical = members.includes(target) && (pressure.get(target) || 0) >= target.hits + (assigned.get(target) || 0)
            const value = Math.min(available, need) * (members.includes(target) ? combatTacticsPolicy.healing.squadPriorityMultiplier : 1) +
                (target.hits < target.hitsMax * combatTacticsPolicy.retreatHealthRatio ? available : 0)
            if (critical && !selectedCritical || critical === selectedCritical && value > score) {
                selected = target; score = value; amount = available; selectedCritical = critical
            }
        }
        if (!selected) continue
        const ranged = combatRange(healer.pos, selected.pos) > 1
        const result = ranged ? healer.rangedHeal(selected) : healer.heal(selected)
        if (result === OK) {
            used.primary = true
            if (ranged) used.ranged = true
            used.healing = { target: selected, amount, range: ranged ? 3 : 1 }
            unmet.set(selected, Math.max(0, (unmet.get(selected) || 0) - amount))
            assigned.set(selected, (assigned.get(selected) || 0) + amount)
        }
    }
}

function enemyHealing(target: Target, snapshot: CombatSnapshot): number {
    if (structure(target)) return 0
    let heal = 0
    for (const enemy of snapshot.enemies) {
        const power = combatPower(enemy), distance = combatRange(enemy.pos, target.pos)
        if (distance <= 1) heal += power.heal
        else if (distance <= 3) heal += power.rangedHeal
    }
    for (const tower of snapshot.towers) heal += towerHeal(tower, target.pos)
    return heal
}

function engagementTicks(members: Creep[], target: Target | undefined, snapshot: CombatSnapshot): number {
    if (!target) return combatTacticsPolicy.maximumEngagementTicks
    let raw = 0
    for (const member of members) {
        const power = combatPower(member), used = intent(member)
        raw += !used.ranged ? power.ranged : 0
        if (!used.primary) raw += canDismantle(target) ? Math.max(power.attack, power.dismantle) : power.attack
    }
    const damage = structure(target) ? raw : effectiveDamage(target, raw)
    const net = damage - enemyHealing(target, snapshot)
    return net > 0 ? Math.ceil(target.hits / net) : Infinity
}

function forecastHealing(members: Creep[], positions: PositionPlan, damage: Map<Creep, number>): Map<Creep, number> {
    const healing = new Map<Creep, number>(), unmet = new Map<Creep, number>()
    if (positions.size === 0) {
        // The current tick can use only the targets whose healing intents actually succeeded.
        for (const healer of members) {
            const actual = intent(healer).healing
            if (actual && members.includes(actual.target) && combatRange(healer.pos, actual.target.pos) <= actual.range)
                healing.set(actual.target, (healing.get(actual.target) || 0) + actual.amount)
        }
        return healing
    }
    // These positions forecast the following tick, when each healer can choose one new target.
    for (const member of members) unmet.set(member, member.hitsMax - member.hits + (damage.get(member) || 0))
    for (const healer of members.slice().sort((a, b) => combatPower(b).heal - combatPower(a).heal)) {
        const power = combatPower(healer)
        if (power.heal === 0) continue
        let selected: Creep | undefined, amount = 0, score = 0
        for (const member of members) {
            const distance = combatRange(positions.get(healer) || healer.pos, positions.get(member) || member.pos)
            const available = distance <= 1 ? power.heal : distance <= 3 ? power.rangedHeal : 0
            const value = Math.min(available, unmet.get(member) || 0)
            if (value > score) { selected = member; amount = available; score = value }
        }
        if (selected) {
            healing.set(selected, (healing.get(selected) || 0) + amount)
            unmet.set(selected, Math.max(0, (unmet.get(selected) || 0) - amount))
        }
    }
    return healing
}

function unsafePositions(members: Creep[], positions: PositionPlan, target: Target | undefined,
    ticks: number, minimumHealth: boolean = true): boolean {
    const pressures = new Map<Creep, number>()
    for (const member of members) {
        const pos = positions.get(member) || member.pos
        const room = Game.rooms[pos.roomName]
        if (!room) continue
        const snapshot = combatSnapshot(room)
        let damage = incomingDamage(member, pos, snapshot)
        // Melee counterattack is additional to the enemy's regular intent; do not assume it costs their action.
        if (target && !structure(target) && !intent(member).primary && combatPower(member).attack > 0 &&
            combatRange(pos, target.pos) <= 1) damage += combatPower(target).attack
        pressures.set(member, damage)
    }
    const assignedHealing = forecastHealing(members, positions, pressures)
    for (const member of members) {
        const damage = pressures.get(member) || 0, healing = assignedHealing.get(member) || 0
        if (minimumHealth && member.hits < member.hitsMax * combatTacticsPolicy.retreatHealthRatio) return true
        // Healing and damage settle together, but each healer can support only one member per tick.
        if (damage >= member.hits + healing) return true
        const net = Math.max(0, damage - healing)
        if (net > 0 && (member.hits - member.hitsMax * combatTacticsPolicy.retreatHealthRatio) / net <
            ticks + combatTacticsPolicy.retreatBufferTicks) return true
    }
    return false
}

function rangedTargets(member: Creep, snapshot: CombatSnapshot, mode: 'attack' | 'hold'): Target[] {
    const targets = new Map<string, Target>()
    for (const raw of [...snapshot.enemies, ...(mode === 'attack' ? snapshot.structures : [])]) {
        const target = protectedTarget(raw, snapshot)
        if (combatRange(member.pos, target.pos) <= 3) targets.set(target.id, target)
    }
    return [...targets.values()]
}

function safeMassAttack(member: Creep): boolean {
    // Native mass attack would also hit whitelisted players and some neutral destructible objects.
    let protectedObjects = collateral.get(member.room.name)
    if (!protectedObjects) {
        protectedObjects = [...member.room.find(FIND_CREEPS), ...member.room.find(FIND_POWER_CREEPS)]
            .filter(creep => !creep.my && !isCombatHostile(creep))
        protectedObjects.push(...(member.room.structures || member.room.find(FIND_STRUCTURES)).filter(target =>
            target.hits !== undefined && !('my' in target && target.my) && !isCombatHostile(target, member.room)))
        collateral.set(member.room.name, protectedObjects)
    }
    return !protectedObjects.some(target => combatRange(member.pos, target.pos) <= 3)
}

function fire(member: Creep, target: Target | undefined, snapshot: CombatSnapshot, mode: 'attack' | 'hold'): void {
    const power = combatPower(member), used = intent(member)
    const reachable = rangedTargets(member, snapshot, mode)
    const selected = target && combatRange(member.pos, target.pos) <= 3 ? target :
        reachable.slice().sort((a, b) => priority(a) - priority(b) || a.hits - b.hits)[0]
    if (!used.ranged && power.ranged > 0 && selected) {
        const damage = (object: Target, raw: number): number => structure(object) ? raw : effectiveDamage(object, raw)
        const single = damage(selected, power.ranged)
        const mass = reachable.reduce((sum, object) => sum + damage(object, power.ranged *
            (combatRange(member.pos, object.pos) <= 1 ? 1 : combatRange(member.pos, object.pos) === 2 ? 0.4 : 0.1)), 0)
        if (mass > single * combatTacticsPolicy.massAttackAdvantage && safeMassAttack(member)) member.rangedMassAttack()
        else member.rangedAttack(selected)
        used.ranged = true
    }
    if (used.primary) return
    const adjacent = target && combatRange(member.pos, target.pos) <= 1 ? target :
        [...snapshot.enemies, ...(mode === 'attack' ? snapshot.structures : [])].map(object => protectedTarget(object, snapshot))
            .filter(object => combatRange(member.pos, object.pos) <= 1)
            .sort((a, b) => priority(a) - priority(b) || a.hits - b.hits)[0]
    if (!adjacent) return
    if (canDismantle(adjacent) && power.dismantle > power.attack && power.dismantle > 0) {
        member.dismantle(adjacent); used.primary = true
    } else if (power.attack > 0) { member.attack(adjacent); used.primary = true }
}

function move(members: Creep[], positions: PositionPlan): void {
    for (const member of members) {
        const next = positions.get(member), used = intent(member)
        if (!next || used.move || member.fatigue > 0 || combatRange(member.pos, next) === 0) continue
        if (next.roomName === member.pos.roomName) member.move(member.pos.getDirectionTo(next))
        else member.moveTo(next, { range: 0, reusePath: 0, maxRooms: 2 })
        used.move = true
    }
}

function saferTranslation(members: Creep[], target: Target | undefined, retreat: boolean): PositionPlan | undefined {
    const threat = target?.pos
    let best: PositionPlan | undefined, score = Infinity
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue
        const candidate = translateSquad(members, dx, dy)
        if (!candidate) continue
        let candidateScore = 0
        for (const member of members) {
            const pos = candidate.get(member)!, damage = incomingDamage(member, pos, snapshotFor(member))
            const distance = threat ? combatRange(pos, threat) : 0
            const kiteDistance = distance < combatTacticsPolicy.rangedKiteDistance ?
                (combatTacticsPolicy.rangedKiteDistance - distance) * combatTacticsPolicy.movementDangerWeight : distance
            candidateScore += damage * combatTacticsPolicy.movementDangerWeight + (retreat ? -distance : kiteDistance)
        }
        if (candidateScore < score) { best = candidate; score = candidateScore }
    }
    return best
}

function runSquad(active: Creep[], options: CombatSquadOptions, formation: CombatFormation): void {
    const { members, state } = orderedMembers(active, { ...options, formation })
    const leader = members[0], snapshot = snapshotFor(leader)
    let target = chooseTarget(leader, snapshot, options.mode)
    const attackRange = members.some(member => combatPower(member).attack + combatPower(member).dismantle > 0) ? 1 : 3
    if (target && options.mode === 'attack' && leader.pos.roomName === options.targetRoom)
        target = squadBreachTarget(members, target.pos, attackRange, formation) || target
    healSquad(members)
    const ticks = engagementTicks(members, target, snapshot)
    const brokenFormation = formation === 'quad' && members.length < 4 || formation === 'duo' && members.length < 2
    const unsafe = unsafePositions(members, new Map(), target, ticks)
    if (unsafe || brokenFormation) state.retreatUntil = Game.time + combatTacticsPolicy.retreatHysteresisTicks
    const retreating = state.retreatUntil > Game.time
    const hostileSafeMode = leader.room.controller?.safeMode && !leader.room.controller.my
    if (!hostileSafeMode) for (const member of members)
        fire(member, target?.pos.roomName === member.pos.roomName ? target : undefined, snapshotFor(member), options.mode)
    if (members.some(member => member.fatigue > 0)) return
    if (retreating) {
        let retreat: PositionPlan | undefined
        if (options.retreatRoom) {
            retreat = planSquadMovement(members, new RoomPosition(25, 25, options.retreatRoom), combatTacticsPolicy.formation.roomRallyRange, formation)
            if (retreat.size === 0 || unsafePositions(members, retreat, undefined, 0, false)) retreat = undefined
        }
        if (options.retreatRoom === leader.pos.roomName && members.every(member =>
            incomingDamage(member, member.pos, snapshotFor(member)) === 0)) { move(members, retreat || new Map()); return }
        move(members, retreat || saferTranslation(members, target, true) || new Map())
        return
    }
    if (hostileSafeMode) return
    const ranged = combatPower(leader).ranged > 0 && combatPower(leader).attack === 0 && combatPower(leader).dismantle === 0
    const closeMelee = snapshot.enemies.find(enemy => combatPower(enemy).attack > 0 &&
        combatRange(enemy.pos, leader.pos) <= combatTacticsPolicy.rangedKiteDistance)
    if (ranged && closeMelee) {
        const kite = saferTranslation(members, closeMelee, false)
        if (kite && !unsafePositions(members, kite, target, ticks)) move(members, kite)
        return
    }
    if (leader.pos.roomName !== options.targetRoom || members.some(member => member.pos.roomName !== options.targetRoom)) {
        const travel = planSquadMovement(members, new RoomPosition(25, 25, options.targetRoom), combatTacticsPolicy.formation.roomRallyRange, formation)
        if (!unsafePositions(members, travel, target, ticks)) move(members, travel)
        return
    }
    if (members.some(member => member.pos.x === 0 || member.pos.x === 49 || member.pos.y === 0 || member.pos.y === 49)) {
        const margin = combatTacticsPolicy.formation.borderRegroupMargin
        const interior = new RoomPosition(Math.max(margin, Math.min(49 - margin, leader.pos.x)),
            Math.max(margin, Math.min(49 - margin, leader.pos.y)), leader.pos.roomName)
        const regroup = planSquadMovement(members, interior, 0, formation)
        if (!unsafePositions(members, regroup, target, ticks)) move(members, regroup)
        return
    }
    if (!target) {
        const regroup = planSquadMovement(members, leader.pos, 0, formation)
        if (!unsafePositions(members, regroup, target, ticks)) move(members, regroup)
        return
    }
    if (ticks === Infinity) return
    const advance = planSquadMovement(members, target.pos, attackRange, formation)
    if (!unsafePositions(members, advance, target, ticks)) move(members, advance)
}

/** One decision pass owns each primary, ranged and movement intent; flags never override safety. */
export function executeCombatSquad(members: Creep[], options: CombatSquadOptions): void {
    tickIntents()
    const active = members.filter(member => member.my && !member.spawning && member.hits > 0)
    if (active.length === 0) return
    if (active.some(member => executed.has(member.name))) return
    const pendingBoost = active.some(member => member.memory.boostPlan?.failed || member.memory.boostPlan &&
        member.memory.boostPlan.tier > 0 && !member.memory.boostPlan.completed && member.memory.boostPlan.steps.length > 0)
    if (pendingBoost) return
    for (const member of active) executed.add(member.name)
    const formation = options.formation || (active.length === 4 ? 'quad' : active.length === 2 ? 'duo' : 'solo')
    const size = formation === 'quad' ? 4 : formation === 'duo' ? 2 : 1
    for (let index = 0; index < active.length; index += size) runSquad(active.slice(index, index + size), options, formation)
}
