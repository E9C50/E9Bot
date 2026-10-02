import { isDevelopingRoom } from './development'
import { controllerLayoutPolicy } from 'settings/controllerLayout'

function range(first: RoomPosition, second: RoomPosition): number {
    return Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y))
}

function walkable(room: Room, x: number, y: number, creepName?: string): boolean {
    if (x <= 0 || x >= 49 || y <= 0 || y >= 49 || (room.controller?.pos.x == x && room.controller.pos.y == y)) return false
    if (room.sources.some(source => source.pos.x == x && source.pos.y == y) ||
        (room.mineral?.pos.x == x && room.mineral.pos.y == y)) return false
    const terrain = room.getTerrain?.()
    if (terrain != undefined && (terrain.get(x, y) & TERRAIN_MASK_WALL) != 0) return false
    for (const structure of room.lookForAt?.(LOOK_STRUCTURES, x, y) || []) {
        const rampart = structure as StructureRampart
        if (structure.structureType != STRUCTURE_ROAD && structure.structureType != STRUCTURE_CONTAINER &&
            !(structure.structureType == STRUCTURE_RAMPART && (rampart.my || rampart.isPublic))) return false
    }
    if (creepName != undefined && (room.lookForAt?.(LOOK_CREEPS, x, y) || []).some(creep => creep.name != creepName)) return false
    return true
}

function seats(room: Room, buffer: StructureLink | StructureContainer, creepName?: string): Array<{ x: number; y: number }> {
    const controller = room.controller
    if (controller == undefined) return []
    const result: Array<{ x: number; y: number }> = []
    for (let x = buffer.pos.x - 1; x <= buffer.pos.x + 1; x++) for (let y = buffer.pos.y - 1; y <= buffer.pos.y + 1; y++) {
        if (Math.max(Math.abs(x - controller.pos.x), Math.abs(y - controller.pos.y)) <= 3 && walkable(room, x, y, creepName)) result.push({ x, y })
    }
    return result
}

function findControllerEnergyBuffer(room: Room): StructureLink | StructureContainer | undefined {
    const controller = room.controller!
    const usable = (target: StructureLink | StructureContainer | undefined): target is StructureLink | StructureContainer =>
        target != undefined && target.pos.roomName == room.name && range(target.pos, controller.pos) <= 3 &&
        (!('my' in target) || target.my !== false) && (!('isActive' in target) || target.isActive()) && seats(room, target).length > 0
    const linked = room.controllerLink
    if (usable(linked)) return linked
    for (const link of room.links) if (usable(link)) return link
    let selected: StructureContainer | undefined
    for (const container of room.containers) {
        if (!usable(container)) continue
        const preferred = range(container.pos, controller.pos) === controllerLayoutPolicy.containerRange
        const selectedPreferred = selected !== undefined && range(selected.pos, controller.pos) === controllerLayoutPolicy.containerRange
        if (selected == undefined || preferred && !selectedPreferred || preferred === selectedPreferred &&
            range(container.pos, controller.pos) < range(selected.pos, controller.pos)) selected = container
    }
    return selected
}

let bufferTick: number | undefined
let bufferShard: string | undefined
let controllerBuffers = new Map<string, { room: Room; target: StructureLink | StructureContainer | undefined }>()

/** Cache only the selected structure for this tick; its Store and occupied seats stay live. */
export function controllerEnergyBuffer(room: Room): StructureLink | StructureContainer | undefined {
    if (!isDevelopingRoom(room)) return undefined
    if (bufferTick != Game.time || bufferShard != Game.shard.name) {
        bufferTick = Game.time; bufferShard = Game.shard.name; controllerBuffers = new Map()
    }
    const cached = controllerBuffers.get(room.name)
    if (cached?.room == room) return cached.target
    const target = findControllerEnergyBuffer(room)
    controllerBuffers.set(room.name, { room, target })
    return target
}

let reservationTick: number | undefined
let reservationShard: string | undefined
let reservedSeats = new Map<string, string>()

/** Permanent upgrade/withdraw geometry; current creeps do not reduce the room's seat capacity. */
export function controllerUpgradeSeatCount(room: Room, buffer: StructureLink | StructureContainer): number {
    return seats(room, buffer).length
}

/** Reserve a walkable tile that supports both native upgrade and withdraw ranges. */
export function controllerUpgradePosition(creep: Creep, buffer: StructureLink | StructureContainer, preferred?: { x: number; y: number }): RoomPosition | undefined {
    if (!isDevelopingRoom(creep.room)) return undefined
    if (reservationTick != Game.time || reservationShard != Game.shard.name) {
        reservationTick = Game.time; reservationShard = Game.shard.name; reservedSeats = new Map()
    }
    const available = seats(creep.room, buffer, creep.name).filter(seat => {
        const owner = reservedSeats.get(`${creep.room.name}/${seat.x}/${seat.y}`)
        return owner == undefined || owner == creep.name
    })
    available.sort((a, b) => {
        // An occupied legal seat is already productive; do not trade it for a theoretically better inner seat.
        const current = (seat: { x: number; y: number }): number => seat.x === creep.pos.x && seat.y === creep.pos.y ? 0 : 1
        const retained = (seat: { x: number; y: number }): number => preferred?.x === seat.x && preferred?.y === seat.y ? 0 : 1
        // Keep the outer face available to haulers; every selected seat can still withdraw directly.
        const inner = (seat: { x: number; y: number }): number => Math.max(Math.abs(seat.x - creep.room.controller!.pos.x),
            Math.abs(seat.y - creep.room.controller!.pos.y)) < controllerLayoutPolicy.containerRange ? 0 : 1
        return current(a) - current(b) || retained(a) - retained(b) || inner(a) - inner(b) || Math.max(Math.abs(a.x - creep.pos.x), Math.abs(a.y - creep.pos.y)) -
            Math.max(Math.abs(b.x - creep.pos.x), Math.abs(b.y - creep.pos.y))
    })
    const selected = available[0]
    creep.memory.dontPullMe = selected !== undefined && selected.x === creep.pos.x && selected.y === creep.pos.y
    if (selected == undefined) return undefined
    reservedSeats.set(`${creep.room.name}/${selected.x}/${selected.y}`, creep.name)
    return new RoomPosition(selected.x, selected.y, creep.room.name)
}

/** A source miner can unload beside a link or stand on its source container. */
export function sourceHarvestPosition(creep: Creep, source: Source, target: StructureLink | StructureContainer): RoomPosition | undefined {
    if (!isDevelopingRoom(creep.room)) return undefined
    const directMining = creep.store.getCapacity(RESOURCE_ENERGY) === 0
    if (directMining && target.structureType !== STRUCTURE_CONTAINER) return undefined
    if (reservationTick != Game.time || reservationShard != Game.shard.name) {
        reservationTick = Game.time; reservationShard = Game.shard.name; reservedSeats = new Map()
    }
    const owned = (x: number, y: number): boolean => {
        const owner = reservedSeats.get(`${creep.room.name}/${x}/${y}`)
        return owner == undefined || owner == creep.name
    }
    // A functioning source/buffer intersection wins over the preferred container
    // tile. New arrivals cannot reserve the same workstation this tick.
    if (creep.pos.isNearTo(source) && creep.pos.isNearTo(target) && (!directMining || creep.pos.isEqualTo(target)) && owned(creep.pos.x, creep.pos.y) &&
        walkable(creep.room, creep.pos.x, creep.pos.y, creep.name)) {
        reservedSeats.set(`${creep.room.name}/${creep.pos.x}/${creep.pos.y}`, creep.name)
        return creep.pos
    }
    const available: Array<{ x: number; y: number }> = []
    for (let x = source.pos.x - 1; x <= source.pos.x + 1; x++) for (let y = source.pos.y - 1; y <= source.pos.y + 1; y++) {
        if ((x == source.pos.x && y == source.pos.y) || Math.max(Math.abs(x - target.pos.x), Math.abs(y - target.pos.y)) > 1 ||
            (directMining && (x !== target.pos.x || y !== target.pos.y)) ||
            !owned(x, y) || !walkable(creep.room, x, y, creep.name)) continue
        available.push({ x, y })
    }
    available.sort((a, b) => {
        const preferred = (seat: { x: number; y: number }): number => target.structureType == STRUCTURE_CONTAINER && seat.x == target.pos.x && seat.y == target.pos.y ? 0 : 1
        return preferred(a) - preferred(b) || Math.max(Math.abs(a.x - creep.pos.x), Math.abs(a.y - creep.pos.y)) -
            Math.max(Math.abs(b.x - creep.pos.x), Math.abs(b.y - creep.pos.y))
    })
    const selected = available[0]
    if (selected != undefined) reservedSeats.set(`${creep.room.name}/${selected.x}/${selected.y}`, creep.name)
    return selected == undefined ? undefined : new RoomPosition(selected.x, selected.y, creep.room.name)
}
