import { isDevelopingRoom } from './development'
import { controllerLayoutPolicy } from 'settings/controllerLayout'
import { developmentPolicy } from 'settings/development'

function range(first: { x: number; y: number }, second: { x: number; y: number }): number {
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

function findControllerEnergyBuffer(room: Room): StructureLink | StructureContainer | undefined {
    const controller = room.controller!
    const hasAdjacentSeat = (target: StructureLink | StructureContainer): boolean => {
        const checked = checkedGeometry.get(room.name)
        if (geometryTick === Game.time && geometryShard === Game.shard.name && checked?.room === room) {
            return checked.geometry.seats.some(seat => range(seat, target.pos) <= 1)
        }
        // Link/filler queries need one usable neighboring tile, not the entire upgrade-area graph.
        for (let x = target.pos.x - 1; x <= target.pos.x + 1; x++) for (let y = target.pos.y - 1; y <= target.pos.y + 1; y++) {
            if (range({ x, y }, controller.pos) <= 3 && walkable(room, x, y)) return true
        }
        return false
    }
    const usable = (target: StructureLink | StructureContainer | undefined): target is StructureLink | StructureContainer =>
        target != undefined && target.pos.roomName == room.name && range(target.pos, controller.pos) <= 3 &&
        (!('my' in target) || target.my !== false) && (!('isActive' in target) || target.isActive()) &&
        hasAdjacentSeat(target)
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

interface ControllerSeat { x: number; y: number }
interface Geometry { signature: string; checkedAt: number; seats: ControllerSeat[]; connected: Map<string, ControllerSeat[]> }
const geometries = new Map<string, Geometry>()
let geometryTick: number | undefined, geometryShard: string | undefined
let checkedGeometry = new Map<string, { room: Room; geometry: Geometry }>()
let occupiedSeats = new Map<string, { room: Room; tiles: Map<string, string> }>()
const controllerDestinations = new Map<string, { id: string; room: string; buffer?: string; x: number; y: number }>()

function syncControllerSeats(): void {
    if (geometryTick === Game.time && geometryShard === Game.shard.name) return
    if (geometryShard !== Game.shard.name || geometryTick !== undefined && Game.time < geometryTick) { geometries.clear(); controllerDestinations.clear() }
    geometryTick = Game.time; geometryShard = Game.shard.name
    checkedGeometry = new Map(); occupiedSeats = new Map()
    if (Game.creeps !== undefined) for (const [name, seat] of controllerDestinations) {
        const creep = Game.creeps[name]
        if (creep === undefined || creep.id !== seat.id || creep.room.name !== seat.room) controllerDestinations.delete(name)
    }
    if (Game.rooms !== undefined && Game.time % developmentPolicy.controller.geometryCacheTicks === 0) {
        for (const name of geometries.keys()) if (Game.rooms[name] === undefined) geometries.delete(name)
    }
    if (reservationTick !== Game.time || reservationShard !== Game.shard.name) {
        reservationTick = Game.time; reservationShard = Game.shard.name; reservedSeats = new Map()
    }
}

function geometry(room: Room): Geometry | undefined {
    syncControllerSeats()
    const controller = room.controller
    if (controller === undefined) return undefined
    const checked = checkedGeometry.get(room.name)
    if (checked?.room === room) return checked.geometry
    // RoomExtension already indexes structures once per tick. Only scalar geometry survives to the next tick.
    const structures = (room.structures || room.find(FIND_STRUCTURES)).filter(item => range(item.pos, controller.pos) <= 3)
    const natural = [controller.pos, ...room.sources.map(source => source.pos), ...(room.mineral ? [room.mineral.pos] : [])]
    const signature = `${controller.pos.x}/${controller.pos.y}:` + structures.map(item =>
        `${item.pos.x}/${item.pos.y}/${item.structureType}/${(item as StructureRampart).my}/${(item as StructureRampart).isPublic}`).join(';') +
        ':' + natural.map(pos => `${pos.x}/${pos.y}`).join(';')
    let cached = geometries.get(room.name)
    if (cached === undefined || cached.signature !== signature || Game.time - cached.checkedAt >= developmentPolicy.controller.geometryCacheTicks) {
        const blocked = new Set(natural.map(pos => `${pos.x}/${pos.y}`))
        for (const structure of structures) {
            const rampart = structure as StructureRampart
            if (structure.structureType !== STRUCTURE_ROAD && structure.structureType !== STRUCTURE_CONTAINER &&
                !(structure.structureType === STRUCTURE_RAMPART && (rampart.my || rampart.isPublic))) blocked.add(`${structure.pos.x}/${structure.pos.y}`)
        }
        const terrain = room.getTerrain(), seats: ControllerSeat[] = []
        for (let x = controller.pos.x - 3; x <= controller.pos.x + 3; x++) for (let y = controller.pos.y - 3; y <= controller.pos.y + 3; y++) {
            if (x <= 0 || x >= 49 || y <= 0 || y >= 49 || blocked.has(`${x}/${y}`) || (terrain.get(x, y) & TERRAIN_MASK_WALL) !== 0) continue
            seats.push({ x, y })
        }
        cached = { signature, checkedAt: Game.time, seats, connected: new Map() }
        geometries.set(room.name, cached)
    }
    checkedGeometry.set(room.name, { room, geometry: cached })
    return cached
}

/** All static upgrade tiles connected to the buffer; neither live occupancy nor reservations reduce capacity. */
export function controllerUpgradeSeats(room: Room, buffer?: StructureLink | StructureContainer): readonly ControllerSeat[] {
    const area = geometry(room)
    if (area === undefined || buffer === undefined) return area?.seats || []
    const key = `${buffer.id}/${buffer.pos.x}/${buffer.pos.y}`
    const cached = area.connected.get(key)
    if (cached !== undefined) return cached
    const remaining = new Map(area.seats.map(seat => [`${seat.x}/${seat.y}`, seat]))
    const connected = area.seats.filter(seat => range(seat, buffer.pos) <= 1)
    for (const seat of connected) remaining.delete(`${seat.x}/${seat.y}`)
    for (let index = 0; index < connected.length; index++) {
        const seat = connected[index]
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            const key = `${seat.x + dx}/${seat.y + dy}`, next = remaining.get(key)
            if (next !== undefined) { connected.push(next); remaining.delete(key) }
        }
    }
    area.connected.set(key, connected)
    return connected
}

export function controllerUpgradeSeatCount(room: Room, buffer?: StructureLink | StructureContainer): number {
    return controllerUpgradeSeats(room, buffer).length
}

function occupancy(room: Room): Map<string, string> {
    const cached = occupiedSeats.get(room.name)
    if (cached?.room === room) return cached.tiles
    const tiles = new Map<string, string>()
    for (const unit of [...room.find(FIND_CREEPS), ...room.find(FIND_POWER_CREEPS)]) tiles.set(`${unit.pos.x}/${unit.pos.y}`, unit.name)
    occupiedSeats.set(room.name, { room, tiles })
    return tiles
}

/** Keep productive current positions; approaching workers prefer the buffer side without swapping occupants. */
export function controllerUpgradePosition(creep: Creep, buffer?: StructureLink | StructureContainer, preferred?: { x: number; y: number }, retainCurrent = true, requireAdjacent = false, construction?: ConstructionSite): RoomPosition | undefined {
    if (!isDevelopingRoom(creep.room)) return undefined
    const area = controllerUpgradeSeats(creep.room, buffer), occupied = occupancy(creep.room)
    const previous = controllerDestinations.get(creep.name)
    if (preferred === undefined && previous?.id === creep.id && previous.room === creep.room.name && previous.buffer === buffer?.id) preferred = previous
    const current = controllerUpgradeSeats(creep.room).find(seat => seat.x === creep.pos.x && seat.y === creep.pos.y)
    const currentOwner = reservedSeats.get(`${creep.room.name}/${creep.pos.x}/${creep.pos.y}`)
    if (retainCurrent && current !== undefined && (construction === undefined || range(current, construction.pos) <= 3) &&
        (currentOwner === undefined || currentOwner === creep.name)) {
        reservedSeats.set(`${creep.room.name}/${current.x}/${current.y}`, creep.name)
        controllerDestinations.delete(creep.name); creep.memory.dontPullMe = true
        return creep.pos
    }
    const available = area.filter(seat => {
        if (construction !== undefined && range(seat, construction.pos) > 3) return false
        if (requireAdjacent && buffer !== undefined && range(seat, buffer.pos) > 1) return false
        if (!retainCurrent && seat.x === creep.pos.x && seat.y === creep.pos.y) return false
        const owner = reservedSeats.get(`${creep.room.name}/${seat.x}/${seat.y}`)
        const occupant = occupied.get(`${seat.x}/${seat.y}`)
        return (owner == undefined || owner == creep.name) && (occupant === undefined || occupant === creep.name)
    })
    available.sort((a, b) => {
        // An occupied legal seat is already productive; do not trade it for a theoretically better inner seat.
        const current = (seat: { x: number; y: number }): number => seat.x === creep.pos.x && seat.y === creep.pos.y ? 0 : 1
        const retained = (seat: { x: number; y: number }): number => preferred?.x === seat.x && preferred?.y === seat.y ? 0 : 1
        const supply = (seat: ControllerSeat): number => buffer === undefined ? 0 : Math.max(1, range(seat, buffer.pos))
        const inner = (seat: { x: number; y: number }): number => Math.max(Math.abs(seat.x - creep.room.controller!.pos.x),
            Math.abs(seat.y - creep.room.controller!.pos.y)) < controllerLayoutPolicy.containerRange ? 0 : 1
        return current(a) - current(b) || retained(a) - retained(b) || supply(a) - supply(b) || inner(a) - inner(b) || Math.max(Math.abs(a.x - creep.pos.x), Math.abs(a.y - creep.pos.y)) -
            Math.max(Math.abs(b.x - creep.pos.x), Math.abs(b.y - creep.pos.y))
    })
    const selected = available[0]
    creep.memory.dontPullMe = selected !== undefined && selected.x === creep.pos.x && selected.y === creep.pos.y
    if (selected == undefined) { controllerDestinations.delete(creep.name); return undefined }
    reservedSeats.set(`${creep.room.name}/${selected.x}/${selected.y}`, creep.name)
    controllerDestinations.set(creep.name, { id: creep.id, room: creep.room.name, buffer: buffer?.id, x: selected.x, y: selected.y })
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
    // Prefer the container itself even when the miner already has a usable
    // adjacent seat. Occupied/reserved containers still allow carrier miners
    // to share production from another source/buffer intersection.
    if (target.structureType === STRUCTURE_CONTAINER && source.pos.isNearTo(target) &&
        owned(target.pos.x, target.pos.y) && walkable(creep.room, target.pos.x, target.pos.y, creep.name)) {
        reservedSeats.set(`${creep.room.name}/${target.pos.x}/${target.pos.y}`, creep.name)
        return target.pos
    }
    // New arrivals cannot reserve the same workstation this tick.
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
