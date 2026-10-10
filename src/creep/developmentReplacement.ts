import { previewBodySelection } from './bodySelection'
import { developmentPolicy } from 'settings/development'

export interface DevelopmentReplacementPlan {
    work: number
    carry: number
    cost: number
    spawnTicks: number
    fundingTicks: number
}

/** One full native preview per role/publication also supplies the population's part counts. */
export function developmentReplacementPlan(room: Room, role: CreepRoleConstant,
    data: CreepData, stationary?: boolean): DevelopmentReplacementPlan {
    const config = { role, data, spawnRoom: room.name,
        development: { fullBody: true, ...(stationary !== undefined ? { stationary } : {}) } } as CreepMemory
    const body = previewBodySelection(room, config, 0).body
    const cost = body.reduce((total, part) => total + BODYPART_COST[part], 0)
    return {
        work: body.filter(part => part === WORK).length,
        carry: body.filter(part => part === CARRY).length,
        cost,
        spawnTicks: body.length * CREEP_SPAWN_TIME,
        fundingTicks: 0,
    }
}

/** Use arrived income and accessible stock, rather than a future fleet's paper income. */
export function developmentReplacementFunding(room: Room, plan: DevelopmentReplacementPlan,
    income: number, stock: number, productiveSources: Source[]): void {
    const deficit = Math.max(0, plan.cost - room.energyAvailable - stock)
    const sourceEnergy = productiveSources.reduce((total, source) => total + source.energy, 0)
    const regeneration = sourceEnergy < deficit ? Math.max(0, ...productiveSources.map(source =>
        source.energy < source.energyCapacity && Number.isFinite(source.ticksToRegeneration) ? source.ticksToRegeneration! : 0)) : 0
    // No arrived delivery is a logistics problem, not evidence that a healthy new
    // miner needs another successor. Never invent one energy/tick to fund it.
    const lifetime = typeof CREEP_LIFE_TIME === 'number' ? CREEP_LIFE_TIME : 1500
    plan.fundingTicks = deficit > 0 && income > 0 ?
        Math.min(Math.floor(lifetime / 2), Math.ceil(deficit / income) + regeneration) : 0
}

/** Include sequential critical births when two mines age together at a single Spawn. */
export function developmentReplacementLead(room: Room, creep: Creep, destination: RoomPosition,
    plan: DevelopmentReplacementPlan): number {
    const travel = Math.max(Math.abs(room.spawns[0].pos.x - destination.x),
        Math.abs(room.spawns[0].pos.y - destination.y)) * developmentPolicy.replacement.travelTicksPerTile
    const busy = Math.min(...room.spawns.map(spawn => spawn.spawning?.remainingTime || 0))
    const slots = Math.max(1, Math.ceil(room.sources.length / room.spawns.length))
    return Math.max(creep.body?.length * CREEP_SPAWN_TIME || 0, plan.spawnTicks) * slots +
        travel + busy + plan.fundingTicks + developmentPolicy.replacement.leadMargin
}

export { developmentReplacementDeadline } from './developmentRecoveryPriority'

export function markDevelopmentReplacement(config: CreepMemory | undefined, predecessor: Creep | undefined): void {
    if (!config?.development || !predecessor || predecessor.ticksToLive === undefined) return
    config.development.replacement = { predecessor: predecessor.name, deadline: Game.time + predecessor.ticksToLive }
}
