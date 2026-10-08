import { previewCreepBody, BodyPlan } from './bodyPlanner'

export interface DismantleBodyOptions {
    /** Omit to select the largest plain-terrain body the room can support. */
    workParts?: number
    boostTier?: CreepBoostTier
}

export interface DismantleBodyPlan extends BodyPlan { cost: number; error?: string }

/** Capacity-based preview: current energy and mineral shortages never silently shrink the order. */
export function planDismantleBody(room: Room, options: DismantleBodyOptions = {}): DismantleBodyPlan {
    const tier = options.boostTier ?? 3
    const empty = (error: string): DismantleBodyPlan => ({ body: [], boostPlan: { tier: 0, steps: [] }, cost: 0, error })
    if (![0, 1, 2, 3].includes(tier)) return empty('boostTier 须为 0、1、2 或 3')
    if (options.workParts !== undefined && (!Number.isSafeInteger(options.workParts) ||
        options.workParts < 1 || options.workParts > MAX_CREEP_SIZE)) return empty('workParts 须为 1..50 的整数')
    const config: CreepMemory = {
        name: 'dismantlePreview', displayName: 'dismantlePreview', role: 'dismantler', spawnRoom: room.name,
        spawnPriority: 3.5, isTeam: false, working: false, ready: false, data: {},
        bodyProfile: { boostTier: tier, boostFallback: 'wait', terrain: 'plain',
            combatPrimaryParts: options.workParts, combatToughParts: 0, combatHealParts: 0,
            maximumCost: room.energyCapacityAvailable },
    }
    const plan = previewCreepBody(room, config, tier)
    const cost = plan.body.reduce((total, part) => total + BODYPART_COST[part], 0)
    if (!cost || plan.body.length > MAX_CREEP_SIZE) return empty('指定身体无法满足房间能量容量和 50 部件上限')
    return { ...plan, cost }
}
