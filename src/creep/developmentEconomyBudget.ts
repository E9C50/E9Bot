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
    const residentFor = (key: string, config: CreepMemory): Creep | undefined =>
        residents?.get(`${config.role}\0${config.name}`) || Game.creeps[key]
    const prepaid = new Set<string>()
    const consumer = (key: string, config: CreepMemory, energyPerWork: number, ceiling: number, exception: boolean): number => {
        const cost = prepaid.has(key) ? 0 : developmentBodyCostCeiling(room, config.role, config) / lifetime
        const resident = residentFor(key, config) !== undefined
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
        const resident = residentFor(key, config)
        if (!resident || resident.memory.development?.fullBody) continue
        legacy.add(key)
        const cost = developmentBodyCostCeiling(room, config.role, config) / lifetime
        const work = resident.getActiveBodyparts(WORK)
        config.development.workParts = work
        budget.upkeep += cost; budget.upgrading += work
        remaining = Math.max(0, remaining - cost - work)
    }
    // Existing full consumers remain paid-for even while their action allowance is zero.
    // Charge this fixed upkeep before deciding whether a new useful controller worker fits.
    for (const [key, config] of Object.entries(configs)) if (config.development && !legacy.has(key) &&
        (config.role === 'builder' || config.role === 'upgrader') && residentFor(key, config)) {
        const cost = developmentBodyCostCeiling(room, config.role, config) / lifetime
        prepaid.add(key); budget.upkeep += cost; remaining = Math.max(0, remaining - cost)
    }
    // Permanent repair capacity stays in the catalog even when its current action quota is zero.
    for (const config of Object.values(configs)) if (config.role === 'repairer' && config.development) {
        const cost = developmentBodyCostCeiling(room, config.role, config) / lifetime
        budget.upkeep += cost; remaining = Math.max(0, remaining - cost)
        const work = Math.min(Math.max(0, Math.floor(config.development.workParts || 0)), Math.floor(remaining))
        config.development.workParts = work; remaining -= work; budget.repairing += work
    }
    // A funded controller worker must survive ordinary construction demand. Otherwise
    // a room with a permanent building backlog can spend its entire income on builders forever.
    const upgrades = Object.entries(configs).filter(([key, config]) => config.role === 'upgrader' &&
        config.development && !legacy.has(key) && (config.development.workParts || 0) > 0)
    const first = upgrades.find(([key, config]) => residentFor(key, config)) || upgrades[0]
    let reserved: { key: string; desired: number; work: number } | undefined
    if (first && budget.upgrading === 0) {
        const [key, config] = first
        const cost = prepaid.has(key) ? 0 : developmentBodyCostCeiling(room, config.role, config) / lifetime
        if (remaining >= cost + 1 && upgradeIncome + bonusIncome >= 1) {
            const desired = Math.floor(config.development!.workParts || 0)
            const available = Math.floor(Math.max(0, Math.min(remaining - cost, upgradeIncome + bonusIncome)))
            const building = Object.values(configs).some(candidate => candidate.role === 'builder' &&
                (candidate.development?.workParts || 0) > 0)
            const share = building ? policy.upgrading.incomeShareWhileBuilding : policy.upgrading.incomeShare
            const work = Math.min(desired, available, Math.max(1, Math.floor(available * share)))
            reserved = { key, desired, work }
            config.development!.workParts = work
            budget.upkeep += cost; budget.upgrading += work; remaining -= cost + work
        }
    }
    // Remaining construction and upgrading demand shares the real arrived-income budget.
    for (const [key, config] of Object.entries(configs)) if (config.role === 'builder' && config.development) {
        const bootstrap = config.spawnPriority === policy.building.firstCreepPriority
        budget.building += consumer(key, config, BUILD_POWER, Infinity, bootstrap)
    }
    for (const [key, config] of Object.entries(configs)) if (config.role === 'upgrader' && config.development && !legacy.has(key)) {
        if (key === reserved?.key) {
            const extra = Math.min(reserved.desired - reserved.work, Math.floor(Math.max(0,
                Math.min(remaining, upgradeIncome + bonusIncome - budget.upgrading))))
            config.development.workParts = reserved.work + extra
            remaining -= extra; budget.upgrading += extra
            continue
        }
        const emergency = config.spawnPriority === policy.upgrading.downgradeRecoveryPriority
        const ceiling = Math.max(0, Math.min(upgradeIncome + bonusIncome - budget.upgrading, remaining))
        budget.upgrading += consumer(key, config, 1, ceiling, emergency)
    }
    return budget
}
