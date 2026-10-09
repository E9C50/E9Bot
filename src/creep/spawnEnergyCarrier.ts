import { isDevelopingRoom } from './development'

/** A ready local distributor can refill Spawn energy; mine imports may only feed Storage. */
export function isSpawnEnergyCarrier(room: Room, creep: Creep): boolean {
    const memory = creep.memory
    if (memory.role !== 'filler' || creep.spawning || creep.ticksToLive === 0) return false
    if (memory.spawnRoom && memory.spawnRoom !== room.name || creep.room.name !== room.name) return false
    if (creep.getActiveBodyparts(CARRY) <= 0 || creep.getActiveBodyparts(MOVE) <= 0 ||
        memory.boostPlan?.steps.length && !memory.boostPlan.completed && !memory.boostPlan.failed) return false
    return !(isDevelopingRoom(room) && room.storage &&
        ((memory.data as FillerData | undefined)?.mineId || memory.developmentHauler?.mineId))
}
