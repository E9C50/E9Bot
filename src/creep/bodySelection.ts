import { getDevelopmentBody, needsEmergencyBody } from './developmentBodies'
import { planCreepBody, previewCreepBody, BodyPlan } from './bodyPlanner'
import { getDevelopmentSpawnReserve } from './developmentEconomy'
import { isDevelopingRoom } from './development'
import { bodyPolicy } from 'settings/bodyPolicy'

/** Population quotas remain authoritative when a room opts into custom bodies. */
function developmentConfig(room: Room, config: CreepMemory): { config: CreepMemory; reserve: number } {
    const development = config.development!
    const capacity = Math.max(0, room.energyCapacityAvailable)
    const reserve = getDevelopmentSpawnReserve(room, config.role)
    const preference = { ...bodyPolicy.profiles[config.role], ...room.memory.bodyProfiles?.[config.role], ...config.bodyProfile }
    const bounded = (value: number | undefined, limit: number | undefined): number | undefined =>
        Number.isFinite(limit) && (limit as number) > 0
            ? Math.min(Number.isFinite(value) && (value as number) > 0 ? value as number : Infinity, limit as number)
            : value
    return {
        reserve,
        config: {
            ...config,
            bodyProfile: {
                ...preference,
                workParts: bounded(preference.workParts, development.workParts),
                carryParts: bounded(preference.carryParts, development.carryParts),
                stationary: development.stationary === true,
                maximumCost: Math.max(0, Math.min(capacity - reserve,
                    Number.isFinite(preference.maximumCost) ? preference.maximumCost! : capacity,
                    Number.isFinite(development.maximumCost) ? development.maximumCost! : capacity)),
            },
        },
    }
}

export function selectCreepBody(room: Room, config: CreepMemory, forceSpawn: boolean): BodyPlan {
    if (!config.development || !isDevelopingRoom(room)) return planCreepBody(room, config, forceSpawn)
    const preference = { ...bodyPolicy.profiles[config.role], ...room.memory.bodyProfiles?.[config.role], ...config.bodyProfile }
    if (Object.keys(preference).length === 0) {
        const body = getDevelopmentBody(room, config)
        if (body !== undefined) return { body, boostPlan: { tier: 0, steps: [] } }
        return planCreepBody(room, config, forceSpawn)
    }
    const customized = developmentConfig(room, config)
    const plan = planCreepBody(room, customized.config, needsEmergencyBody(room, config.role))
    const cost = plan.body.reduce((total, part) => total + BODYPART_COST[part], 0)
    if (cost + customized.reserve > room.energyAvailable) return { body: [], boostPlan: { tier: 0, steps: [] } }
    return plan
}

/** Preview does not reserve minerals, spend energy, or alter a population demand. */
export function previewBodySelection(room: Room, config: CreepMemory, tier: CreepBoostTier): BodyPlan {
    const selected = config.development && isDevelopingRoom(room) ? developmentConfig(room, config).config : config
    return previewCreepBody(room, selected, tier)
}
