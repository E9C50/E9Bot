import { developmentPolicy } from 'settings/development'
import { isDevelopingRoom } from './development'
import { hasRemoteHomeEconomy } from './remoteHomeEconomy'
import { developmentBodyCostCeiling } from './developmentEconomyBudget'

/** Established rooms with stored surplus restore a missing job before expanding their fleet. */
export function prioritizeDevelopmentConsumers(room: Room, queue: string[],
    creeps: { [name: string]: Creep } = Game.creeps): string[] {
    if (!isDevelopingRoom(room) || !room.storage ||
        room.storage.store[RESOURCE_ENERGY] <= developmentPolicy.upgrading.storageReserve) return queue
    const configs = room.memory.creepConfig || {}, candidates = new Map<string, string>()
    for (const name of queue) {
        const config = configs[name]
        if (!config?.development || config.spawnRoom !== room.name || !((config.development.workParts || 0) > 0) ||
            !['builder', 'upgrader', 'repairer'].includes(config.role) || candidates.has(config.role)) continue
        if (room.storage.store[RESOURCE_ENERGY] < developmentPolicy.upgrading.storageReserve +
            developmentBodyCostCeiling(room, config.role, config)) continue
        candidates.set(config.role, name)
    }
    if (!candidates.size) return queue
    for (const creep of Object.values(creeps)) {
        if (creep.memory.spawnRoom !== room.name || !candidates.has(creep.memory.role) || creep.ticksToLive === 0) continue
        // A paid-for worker in transit or still spawning already occupies this first slot.
        if (creep.getActiveBodyparts(WORK) > 0 && creep.getActiveBodyparts(CARRY) > 0)
            candidates.delete(creep.memory.role)
    }
    if (!candidates.size || !hasRemoteHomeEconomy(room, creeps)) return queue
    const promoted = new Set(candidates.values())
    const priority = (name: string): number => promoted.has(name)
        ? Math.min(configs[name].spawnPriority, developmentPolicy.consumers.missingRolePriority)
        : configs[name].spawnPriority
    return [...queue].sort((first, second) => priority(first) - priority(second))
}
