import { developmentPolicy } from 'settings/development'
import { controllerEnergyBuffer } from './developmentLogistics'

/** Shared by population planning and both default/custom body selection. */
export function getDevelopmentSpawnReserve(room: Room, role: CreepRoleConstant): number {
    if (role !== 'upgrader') return 0
    // Protect the controller without waiting for extra recovery stock in the Spawn.
    if (room.controller && room.controller.ticksToDowngrade <= developmentPolicy.controller.constructionDowngradeWarningTicks) return 0
    const minimum = BODYPART_COST[WORK] + BODYPART_COST[CARRY] + BODYPART_COST[MOVE]
    const maximum = Math.max(0, room.energyCapacityAvailable - minimum)
    // An established controller supply can support a full-capacity body; a bootstrap
    // worker preserves recovery energy. Instant Spawn stock never changes this choice.
    const buffer = room.controller?.pos && controllerEnergyBuffer(room)
    const requested = buffer && buffer.store[RESOURCE_ENERGY] >= developmentPolicy.upgrading.controllerBufferReserve
        ? developmentPolicy.upgrading.suppliedSpawnEnergyReserve : developmentPolicy.bodies.spawnEnergyReserve
    return Math.min(maximum, Math.max(0, requested))
}

/** Regeneration capacity, rather than the current depleted energy, sets miner quota. */
export function getSourceMiningWorkTarget(source: Source): number {
    const capacity = source.energyCapacity
    let income = Number.isFinite(capacity) && capacity > 0 ? capacity / ENERGY_REGEN_TIME :
        developmentPolicy.mining.workPartsPerSource * HARVEST_POWER
    for (const effect of source.effects || []) if (effect.effect === PWR_REGEN_SOURCE && effect.ticksRemaining > 0 && effect.level !== undefined) {
        const power = POWER_INFO[PWR_REGEN_SOURCE]
        income += power.effect[effect.level - 1] / power.period!
    }
    return Math.max(1, Math.ceil(income / HARVEST_POWER))
}
