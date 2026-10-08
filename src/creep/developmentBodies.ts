import { isDevelopingRoom } from './development'
import { getDevelopmentSpawnReserve } from './developmentEconomy'
import { planCreepBody, previewCreepBody } from './bodyPlanner'
import { bodyPolicy } from 'settings/bodyPolicy'
import { needsEmergencyBody } from './spawnEnergyPolicy'
export { needsEmergencyBody } from './spawnEnergyPolicy'

function developmentConfig(room: Room, config: CreepMemory): CreepMemory {
    const profile = config.development!
    const preference = { ...bodyPolicy.profiles[config.role], ...room.memory.bodyProfiles?.[config.role], ...config.bodyProfile }
    const capacity = Math.max(0, Math.floor(room.energyCapacityAvailable))
    const reserve = getDevelopmentSpawnReserve(room, config.role)
    const maximumCost = !profile.fullBody && Number.isFinite(profile.maximumCost) && (profile.maximumCost as number) >= 0
        ? Math.floor(profile.maximumCost as number) : capacity
    return { ...config, bodyProfile: {
        boostTier: 0,
        ...(profile.stationary !== undefined ? { stationary: profile.stationary } : {}),
        ...(!profile.fullBody && profile.workParts !== undefined ? { workParts: profile.workParts } : {}),
        ...(!profile.fullBody && profile.carryParts !== undefined ? { carryParts: profile.carryParts } : {}),
        ...preference,
        maximumCost: Math.min(capacity - reserve, maximumCost, preference.maximumCost ?? capacity),
    } }
}

/** Population counts income needs separately from each full-size physical body. */
export function developmentPartCapacity(room: Room, role: CreepRoleConstant, part: BodyPartConstant,
    data: CreepData = {}, stationary?: boolean): number {
    const config = developmentConfig(room, {
        role, data, spawnRoom: room.name, development: { ...(stationary !== undefined ? { stationary } : {}) },
    } as CreepMemory)
    return previewCreepBody(room, config, 0).body.filter(type => type === part).length
}

/** Explicit development constraints share the native planner and always wait for the selected complete body. */
export function getDevelopmentBody(room: Room, config: CreepMemory): BodyPartConstant[] | undefined {
    if (!config.development || !isDevelopingRoom(room)) return undefined
    if (!['harvester', 'rHarvester', 'upgrader', 'builder', 'rBuilder', 'repairer',
        'filler', 'rFiller', 'manager', 'reserver', 'scout'].includes(config.role)) return undefined
    const plan = planCreepBody(room, developmentConfig(room, config), needsEmergencyBody(room))
    const cost = plan.body.reduce((total, part) => total + BODYPART_COST[part], 0)
    return cost + getDevelopmentSpawnReserve(room, config.role) <= room.energyAvailable ? plan.body : []
}
