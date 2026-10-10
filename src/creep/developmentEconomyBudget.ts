import { bodyPolicy } from 'settings/bodyPolicy'
import { developmentPolicy as policy } from 'settings/development'

/** A conservative full-body price without another native body preview. */
export function developmentBodyCostCeiling(room: Room, role: CreepRoleConstant, config?: CreepMemory): number {
    const profile = { ...bodyPolicy.profiles[role], ...room.memory.bodyProfiles?.[role], ...config?.bodyProfile }
    return Math.max(0, Math.min(room.energyCapacityAvailable,
        Number.isFinite(profile.maximumCost) ? profile.maximumCost! : room.energyCapacityAvailable))
}

export interface DevelopmentEconomyBudget {
    income: number
    upkeep: number
    maintenance: number
    repairing: number
    building: number
    upgrading: number
}

/** Charge one permanent fleet, never both the old body and its overlapping successor. */
export function applyDevelopmentEconomyBudget(room: Room, income: number, upgradeIncome: number,
    essentialUpkeep: number, bonusIncome: number, residents?: ReadonlyMap<string, Creep>): DevelopmentEconomyBudget {
    const lifetime = typeof CREEP_LIFE_TIME === 'number' ? CREEP_LIFE_TIME : 1500
    const configs = room.memory.creepConfig
    const maintenance = Math.min(1, Math.max(0, income - essentialUpkeep))
    let remaining = Math.max(0, income + bonusIncome - essentialUpkeep - maintenance)
    const budget: DevelopmentEconomyBudget = { income: income + bonusIncome,
        upkeep: essentialUpkeep, maintenance, repairing: 0, building: 0, upgrading: 0 }
    const consumer = (key: string, config: CreepMemory, energyPerWork: number, ceiling: number, exception: boolean): number => {
        const cost = developmentBodyCostCeiling(room, config.role, config) / lifetime
        const resident = residents ? residents.has(`${config.role}\0${config.name}`) : Game.creeps[key] !== undefined
        const available = Math.max(0, Math.min(remaining - cost, ceiling))
        const desired = Math.max(0, Math.floor(config.development?.workParts || 0))
        const work = Math.min(desired, Math.floor(available / energyPerWork))
        if (work === 0 && !resident && !exception) { delete configs[key]; return 0 }
        budget.upkeep += cost
        remaining = Math.max(0, remaining - cost)
        const selected = exception ? Math.max(1, work) : work
        config.development!.workParts = selected
        const spending = selected * energyPerWork
        remaining = Math.max(0, remaining - spending)
        return spending
    }
    // Historical resident upgraders intentionally keep their paid-for behaviour.
    // Account for that real fixed consumption before granting any new work.
    const legacy = new Set<string>()
    for (const [key, config] of Object.entries(configs)) if (config.role === 'upgrader' && config.development) {
        const resident = residents?.get(`${config.role}\0${config.name}`) || Game.creeps[key]
        if (!resident || resident.memory.development?.fullBody) continue
        legacy.add(key)
        const cost = developmentBodyCostCeiling(room, config.role, config) / lifetime
        const work = resident.getActiveBodyparts(WORK)
        config.development.workParts = work
        budget.upkeep += cost; budget.upgrading += work
        remaining = Math.max(0, remaining - cost - work)
    }
    // Permanent repair capacity stays in the catalog even when its current action quota is zero.
    for (const config of Object.values(configs)) if (config.role === 'repairer' && config.development) {
        const cost = developmentBodyCostCeiling(room, config.role, config) / lifetime
        budget.upkeep += cost; remaining = Math.max(0, remaining - cost)
        const work = Math.min(Math.max(0, Math.floor(config.development.workParts || 0)), Math.floor(remaining))
        config.development.workParts = work; remaining -= work; budget.repairing += work
    }
    // Infrastructure receives the first useful construction intent. New idle consumers
    // cannot absorb another complete body's upkeep before that work can be funded.
    for (const [key, config] of Object.entries(configs)) if (config.role === 'builder' && config.development) {
        const bootstrap = config.spawnPriority === policy.building.firstCreepPriority
        budget.building += consumer(key, config, BUILD_POWER, Infinity, bootstrap)
    }
    for (const [key, config] of Object.entries(configs)) if (config.role === 'upgrader' && config.development && !legacy.has(key)) {
        const emergency = config.spawnPriority === policy.upgrading.downgradeRecoveryPriority
        const ceiling = Math.max(0, Math.min(upgradeIncome + bonusIncome, remaining))
        budget.upgrading += consumer(key, config, 1, ceiling, emergency)
    }
    return budget
}
