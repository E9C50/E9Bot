import { controllerEnergyBuffer, controllerUpgradePosition } from 'creep/developmentLogistics'
import { developmentWorkAllowed } from 'creep/development'

interface WorkSeat {
    id: string
    roomName: string
    controllerId: string
    bufferId?: string
    x: number
    y: number
}

let tick: number | undefined, shard: string | undefined
const destinations = new Map<string, WorkSeat>()
let reservations = new Map<string, string>()

function sync(): void {
    if (tick === Game.time && shard === Game.shard.name) return
    if (shard !== Game.shard.name || tick !== undefined && Game.time < tick) destinations.clear()
    tick = Game.time
    shard = Game.shard.name
    reservations = new Map()
    for (const [name, seat] of destinations) {
        const creep = Game.creeps[name]
        if (creep === undefined || creep.id !== seat.id || !creep.memory.working || creep.room.name !== seat.roomName) destinations.delete(name)
    }
}

function range(first: { x: number; y: number }, second: { x: number; y: number }): number {
    return Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y))
}

function seatKey(room: string, x: number, y: number): string { return `${room}/${x}/${y}` }

function openSeat(creep: Creep, controller: StructureController, x: number, y: number): boolean {
    const room = creep.room
    if (x <= 0 || x >= 49 || y <= 0 || y >= 49 || x === controller.pos.x && y === controller.pos.y ||
        room.sources.some(source => source.pos.x === x && source.pos.y === y) ||
        room.mineral?.pos.x === x && room.mineral.pos.y === y ||
        (room.getTerrain().get(x, y) & TERRAIN_MASK_WALL) !== 0) return false
    const reserved = reservations.get(seatKey(room.name, x, y))
    if (reserved !== undefined && reserved !== creep.name) return false
    for (const structure of room.lookForAt(LOOK_STRUCTURES, x, y)) {
        if (structure.structureType !== STRUCTURE_ROAD && structure.structureType !== STRUCTURE_CONTAINER &&
            !(structure.structureType === STRUCTURE_RAMPART && ((structure as StructureRampart).my || (structure as StructureRampart).isPublic))) return false
    }
    return !room.lookForAt(LOOK_CREEPS, x, y).some(unit => unit.name !== creep.name) &&
        !room.lookForAt(LOOK_POWER_CREEPS, x, y).some(unit => unit.name !== creep.name)
}

function mobileSeat(creep: Creep, controller: StructureController, retained?: WorkSeat): RoomPosition | undefined {
    let selected: { x: number; y: number } | undefined
    let distance = Infinity
    if (retained !== undefined && range(retained, controller.pos) <= 3 && openSeat(creep, controller, retained.x, retained.y)) selected = retained
    else for (let x = controller.pos.x - 3; x <= controller.pos.x + 3; x++) for (let y = controller.pos.y - 3; y <= controller.pos.y + 3; y++) {
        if (!openSeat(creep, controller, x, y)) continue
        const next = range(creep.pos, { x, y })
        if (next < distance) { selected = { x, y }; distance = next }
    }
    if (selected === undefined) return undefined
    reservations.set(seatKey(creep.room.name, selected.x, selected.y), creep.name)
    return new RoomPosition(selected.x, selected.y, creep.room.name)
}

function adjacentBuffer(creep: Creep, controller: StructureController): StructureLink | StructureContainer | undefined {
    const usable = (buffer: StructureLink | StructureContainer | undefined): buffer is StructureLink | StructureContainer =>
        buffer !== undefined && buffer.pos.roomName === creep.room.name && range(buffer.pos, controller.pos) <= 3 &&
        range(creep.pos, buffer.pos) <= 1 && (!('my' in buffer) || buffer.my !== false) &&
        (!('isActive' in buffer) || buffer.isActive())
    const preferred = controllerEnergyBuffer(creep.room)
    if (usable(preferred)) return preferred
    // A different valid buffer may be beside the current seat; refilling never requires moving a working builder.
    for (const buffer of creep.room.links) if (usable(buffer)) return buffer
    for (const buffer of creep.room.containers) if (usable(buffer)) return buffer
    return undefined
}

/** Aid builders hold any productive current tile and never ask BetterMove to swap another worker out of it. */
export function upgradeBuilderAtStablePosition(creep: Creep, controller: StructureController): boolean {
    sync()
    const energy = creep.store[RESOURCE_ENERGY]
    if (range(creep.pos, controller.pos) <= 3) {
        destinations.delete(creep.name)
        const buffer = adjacentBuffer(creep, controller)
        creep.memory.working = energy > 0
        let supplied = false
        if (energy > 0 && developmentWorkAllowed(creep)) creep.upgradeController(controller)
        if (buffer !== undefined && buffer.store[RESOURCE_ENERGY] > 0 && creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            supplied = creep.withdraw(buffer, RESOURCE_ENERGY) === OK
        }
        // CARRY supply and WORK upgrade are independent native intents. Empty native cargo only receives a withdraw.
        const staying = energy > 0 || supplied
        creep.memory.dontPullMe = staying
        if (staying) reservations.set(seatKey(creep.room.name, creep.pos.x, creep.pos.y), creep.name)
        return staying
    }
    if (energy <= 0) {
        creep.memory.working = false
        creep.memory.dontPullMe = false
        destinations.delete(creep.name)
        return false
    }
    creep.memory.dontPullMe = false
    const buffer = controllerEnergyBuffer(creep.room)
    const previous = destinations.get(creep.name)
    const retained = previous?.id === creep.id && previous.controllerId === controller.id && previous.bufferId === buffer?.id ? previous : undefined
    const seat = buffer !== undefined ? controllerUpgradePosition(creep, buffer, retained) : mobileSeat(creep, controller, retained)
    if (seat === undefined) { destinations.delete(creep.name); return false }
    destinations.set(creep.name, { id: creep.id, roomName: creep.room.name, controllerId: controller.id, bufferId: buffer?.id, x: seat.x, y: seat.y })
    const result = creep.moveTo(seat, { range: 0, ignoreCreeps: false })
    if (result === ERR_NO_PATH || result === ERR_INVALID_TARGET) destinations.delete(creep.name)
    return result === OK || creep.fatigue > 0
}
