import { sourceLinkWithCenter } from 'room/sourceLinks'

type SourceLinkMinerMemory = CreepMemory & { sourceLinkRetiring?: boolean }

/** A zero-CARRY body cannot deposit native harvest overflow into a Link. */
export function sourceLinkMinerIncompatible(creep: Creep, source: Source): boolean {
    if (creep.store.getCapacity(RESOURCE_ENERGY) !== 0) return false
    const room = source.room || (source.pos.roomName === creep.room.name ? creep.room : Game.rooms?.[source.pos.roomName])
    return room !== undefined && sourceLinkWithCenter(room, source) !== undefined
}

/** Free the mining seat even when the room temporarily has no usable home Spawn. */
function leaveSource(creep: Creep, source?: Source): void {
    if (source === undefined || !creep.pos.isNearTo(source)) return
    const room = creep.room, terrain = room.getTerrain()
    let position: RoomPosition | undefined, distance = Infinity
    for (let x = Math.max(1, source.pos.x - 2); x <= Math.min(48, source.pos.x + 2); x++) {
        for (let y = Math.max(1, source.pos.y - 2); y <= Math.min(48, source.pos.y + 2); y++) {
            if (Math.max(Math.abs(x - source.pos.x), Math.abs(y - source.pos.y)) !== 2 ||
                (terrain.get(x, y) & TERRAIN_MASK_WALL) !== 0 ||
                room.sources.some(item => item.pos.x === x && item.pos.y === y) ||
                room.mineral?.pos.x === x && room.mineral.pos.y === y ||
                room.controller?.pos.x === x && room.controller.pos.y === y) continue
            if ((room.lookForAt(LOOK_STRUCTURES, x, y) || []).some(item => item.structureType !== STRUCTURE_ROAD &&
                item.structureType !== STRUCTURE_CONTAINER && !(item.structureType === STRUCTURE_RAMPART &&
                    ((item as StructureRampart).my || (item as StructureRampart).isPublic))) ||
                (room.lookForAt(LOOK_CREEPS, x, y) || []).some(item => item.name !== creep.name)) continue
            const range = Math.max(Math.abs(x - creep.pos.x), Math.abs(y - creep.pos.y))
            if (range < distance) { position = new RoomPosition(x, y, room.name); distance = range }
        }
    }
    if (position !== undefined) creep.moveTo(position, { range: 0 })
}

/** Persist retirement so a remote miner cannot turn back once the Source loses vision. */
export function retireSourceLinkMiner(creep: Creep, source?: Source): boolean {
    const memory = creep.memory as SourceLinkMinerMemory
    if (!memory.sourceLinkRetiring && (source === undefined || !sourceLinkMinerIncompatible(creep, source))) return false
    memory.sourceLinkRetiring = true
    memory.ready = false; memory.working = false; memory.dontPullMe = false
    const homeRoom = memory.spawnRoom || creep.room.name
    const home = Game.rooms?.[homeRoom] || (homeRoom === creep.room.name ? creep.room : undefined)
    const spawn = home?.spawns?.[0]
    if (spawn !== undefined) {
        if (creep.pos.isNearTo(spawn)) {
            if (spawn.recycleCreep(creep) !== OK) leaveSource(creep, source)
        }
        else creep.moveTo(spawn, { range: 1 })
    } else if (creep.room.name !== homeRoom) {
        creep.moveTo(new RoomPosition(25, 25, homeRoom), { range: 1 })
    } else leaveSource(creep, source)
    // Movement helpers can mark stalled movers immovable; retirement must yield the mining seat.
    memory.dontPullMe = false
    return true
}
