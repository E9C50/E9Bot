import { developmentPolicy } from 'settings/development'
import { isDevelopingRoom } from './development'
import { getDevelopmentSpawnReserve } from './developmentEconomy'

/** Positive, bounded part counts keep stale or user-edited Memory from producing invalid bodies. */
function partCount(value: number | undefined, fallback: number): number {
    return Number.isFinite(value) && (value as number) > 0
        ? Math.min(MAX_CREEP_SIZE, Math.floor(value as number))
        : fallback
}

function bodyCost(body: BodyPartConstant[]): number {
    return body.reduce((cost, part) => cost + BODYPART_COST[part], 0)
}

function body(work: number, carry: number, move: number, claim: number = 0): BodyPartConstant[] {
    return [
        ...Array<BodyPartConstant>(work).fill(WORK),
        ...Array<BodyPartConstant>(carry).fill(CARRY),
        ...Array<BodyPartConstant>(claim).fill(CLAIM),
        ...Array<BodyPartConstant>(move).fill(MOVE),
    ]
}

/** Only local production can spend a partial energy pool to restart a stalled economy. */
export function needsEmergencyBody(room: Room, role: CreepRoleConstant): boolean {
    if (role !== 'harvester' && role !== 'filler') return false
    let hasHarvester = false
    let hasFiller = false
    for (const creep of Object.values(Game.creeps)) {
        if (creep.memory.spawnRoom !== room.name && creep.room.name !== room.name) continue
        if (creep.memory.role === 'harvester') hasHarvester = true
        if (creep.memory.role === 'filler') hasFiller = true
    }
    if (role === 'harvester') return !hasHarvester
    return !hasFiller || (!hasHarvester && room.energyAvailable < developmentPolicy.bodies.emergencySpawnEnergy)
}

function workerBody(role: CreepRoleConstant, profile: NonNullable<CreepMemory['development']>, budget: number): BodyPartConstant[] {
    const policy = developmentPolicy.bodies
    const mining = role === 'harvester' || role === 'rHarvester'
    const stationary = mining || profile.stationary === true
    const maximumWork = mining ? policy.minerWorkParts :
        role === 'upgrader' ? policy.maximumUpgraderWorkParts : MAX_CREEP_SIZE
    const desiredWork = Math.min(maximumWork, partCount(profile.workParts, maximumWork))
    for (let work = desiredWork; work > 0; work--) {
        const carry = mining ? 1 : Math.max(
            policy.minimumWorkerCarryParts,
            partCount(profile.carryParts, stationary
                ? Math.ceil(work * policy.stationaryCarryTicks / CARRY_CAPACITY)
                : Math.ceil(work * policy.workerCarryPerWork)),
        )
        // Miners need at least one MOVE per two WORK; stationary consumers use the same conservative floor.
        const move = Math.max(1, Math.ceil((stationary ? work : work + carry) / 2))
        const candidate = body(work, carry, move)
        if (candidate.length <= MAX_CREEP_SIZE && bodyCost(candidate) <= budget) return candidate
    }
    // A first mobile upgrader must still exist at 300 capacity while preserving a small spawn reserve.
    const minimum = body(1, policy.minimumWorkerCarryParts, 1)
    if (minimum.length <= MAX_CREEP_SIZE && bodyCost(minimum) <= budget) return minimum
    return []
}

function haulerBody(profile: NonNullable<CreepMemory['development']>, budget: number): BodyPartConstant[] {
    const policy = developmentPolicy.bodies
    const predictedCarry = Number.isFinite(profile.travelTicks) && (profile.travelTicks as number) > 0 &&
        Number.isFinite(profile.workParts) && (profile.workParts as number) > 0
        ? Math.ceil((profile.travelTicks as number) * (profile.workParts as number) * HARVEST_POWER / CARRY_CAPACITY)
        : policy.defaultHaulerCarryParts
    const desiredCarry = Math.max(policy.minimumCarryParts, partCount(profile.carryParts, predictedCarry))
    for (let carry = Math.min(desiredCarry, Math.floor(MAX_CREEP_SIZE / 2)); carry > 0; carry--) {
        // Until the population planner confirms roads, a loaded hauler keeps one MOVE per CARRY.
        const candidate = body(0, carry, profile.stationary === true ? 1 : carry)
        if (bodyCost(candidate) <= budget) return candidate
    }
    return []
}

/**
 * Explicit development profiles customize RCL1–7 bodies. Undefined preserves the legacy strategy;
 * an empty body waits for sufficient energy instead of publishing an unaffordable spawn intent.
 */
export function getDevelopmentBody(room: Room, config: CreepMemory): BodyPartConstant[] | undefined {
    const profile = config.development
    if (!profile || !isDevelopingRoom(room)) return undefined
    const role = config.role
    const worker = role === 'harvester' || role === 'rHarvester' || role === 'upgrader' ||
        role === 'builder' || role === 'rBuilder' || role === 'repairer'
    const hauler = role === 'filler' || role === 'rFiller' || role === 'manager'
    if (!worker && !hauler && role !== 'reserver' && role !== 'scout') return undefined

    const capacity = Math.max(0, Math.floor(room.energyCapacityAvailable))
    const available = Math.max(0, Math.floor(room.energyAvailable))
    const maximumCost = Number.isFinite(profile.maximumCost) && (profile.maximumCost as number) >= 0
        ? Math.floor(profile.maximumCost as number) : capacity
    const reserve = getDevelopmentSpawnReserve(room, role)
    const ceiling = Math.min(capacity - reserve, maximumCost)
    const budget = needsEmergencyBody(room, role) ? Math.min(ceiling, available) : ceiling
    let selected: BodyPartConstant[]
    if (worker) selected = workerBody(role, profile, budget)
    else if (hauler) selected = haulerBody(profile, budget)
    else selected = role === 'reserver' ? [CLAIM, MOVE] : [MOVE]
    if (selected.length === 0 || bodyCost(selected) > budget || bodyCost(selected) + reserve > available) return []
    return selected
}
