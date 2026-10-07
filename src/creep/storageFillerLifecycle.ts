import { isDevelopingRoom } from './development'
import { isRoomEvacuating } from 'room/evacuationState'

/** Two reusable slots permit one handover without increasing the permanent quota. */
export function storageFillerNames(room: Room): [string, string] {
    const name = `${room.name}_FILLER_STORAGE_0`
    return [name, `${name}_RECOVERY`]
}

export function isMatureStorageFiller(room: Room, memory: CreepMemory): boolean {
    const data = memory.data as FillerData
    return room.controller?.my === true && room.controller.level === 8 && !isDevelopingRoom(room) &&
        room.storage !== undefined && !isRoomEvacuating(room) && memory.role === 'filler' &&
        memory.spawnRoom === room.name && memory.development === undefined &&
        data.sourceId === room.storage.id && !data.mineId && !data.evacuationRoom
}

export function usableStorageFiller(room: Room, creep: Creep): boolean {
    const boost = creep.memory.boostPlan
    return isMatureStorageFiller(room, creep.memory) && creep.room.name === room.name && !creep.spawning &&
        creep.getActiveBodyparts(CARRY) > 0 && creep.getActiveBodyparts(MOVE) > 0 &&
        !boost?.failed && (!boost?.steps.length || boost.completed === true)
}

export function hasUsableStorageFiller(room: Room, creeps: { [name: string]: Creep } = Game.creeps): boolean {
    return Object.values(creeps).some(creep => usableStorageFiller(room, creep))
}

/** An empty carrier with no surviving CARRY can vacate a blocked slot by walking to recycling. */
export function recyclableDisabledStorageFiller(room: Room, creep: Creep): boolean {
    return isMatureStorageFiller(room, creep.memory) && creep.room.name === room.name && !creep.spawning &&
        creep.getActiveBodyparts(CARRY) === 0 && creep.getActiveBodyparts(MOVE) > 0 &&
        creep.store.getUsedCapacity() === 0
}

/** Keep delivering until a published successor can actually take over in this room. */
export function retireSupersededStorageFiller(creep: Creep): boolean {
    const home = Game.rooms[creep.memory.spawnRoom]
    if (!home || !isMatureStorageFiller(home, creep.memory) || isRoomEvacuating(creep.room) ||
        !storageFillerNames(home).includes(creep.memory.name) ||
        home.memory.creepConfig === undefined || home.memory.creepConfig[creep.name]) return false
    const successor = Object.values(Game.creeps).some(candidate => candidate.name !== creep.name &&
        storageFillerNames(home).includes(candidate.memory.name) &&
        home.memory.creepConfig?.[candidate.name] !== undefined && usableStorageFiller(home, candidate))
    const emergencyVacancy = home.memory.storageFillerHandover?.replacement === creep.memory.name &&
        recyclableDisabledStorageFiller(home, creep) && !hasUsableStorageFiller(home)
    if (!successor && !emergencyVacancy) return false

    creep.memory.dontPullMe = false
    const resource = (Object.keys(creep.store) as ResourceConstant[]).find(resource => creep.store[resource] > 0)
    if (resource) {
        const receiver = [home.storage, ...home.spawns, ...home.extensions, ...home.containers]
            .find(target => target !== undefined && (target.store.getFreeCapacity(resource) || 0) > 0)
        if (receiver) {
            if (creep.transfer(receiver, resource) === ERR_NOT_IN_RANGE) creep.moveTo(receiver, { range: 1 })
        }
        // A full depot must not discard the old carrier's remaining cargo.
        return true
    }
    const spawn = home.spawns[0]
    if (spawn) {
        if (creep.pos.inRangeTo(spawn, 1)) spawn.recycleCreep(creep)
        else creep.moveTo(spawn, { range: 1 })
    }
    return true
}
