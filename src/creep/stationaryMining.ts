import { getHarvestPower } from 'runtime/harvestPower'
import { sourceLinkWithCenter } from 'room/sourceLinks'
import { retireSourceLinkMiner } from './sourceLinkMining'

interface MiningStation {
    position: RoomPosition
    link?: StructureLink
    container?: StructureContainer
}

interface UnloadPhase {
    id: Id<Creep>
    period: number
    phase: number
    lastSeen: number
}

interface CachedStation {
    source: Source
    room: Room
    position: RoomPosition
    x: number
    y: number
    station: MiningStation | null | undefined
}

let reservationTick: number | undefined
let reservationShard: string | undefined
let reservations = new Map<string, string>()
let unloadPhases = new Map<string, UnloadPhase>()
let lastPhaseCleanup: number | undefined
let stations = new WeakMap<Creep, CachedStation>()

function seatKey(room: Room, x: number, y: number): string { return `${room.name}/${x}/${y}` }

function resetReservations(): void {
    if (reservationTick != Game.time || reservationShard != Game.shard.name) {
        if (reservationShard != Game.shard.name || (reservationTick != undefined && Game.time < reservationTick)) {
            unloadPhases = new Map(); lastPhaseCleanup = undefined
        }
        reservationTick = Game.time; reservationShard = Game.shard.name; reservations = new Map(); stations = new WeakMap()
        if (lastPhaseCleanup == undefined || Game.time - lastPhaseCleanup >= CREEP_LIFE_TIME) {
            for (const [name, phase] of unloadPhases) if (Game.time - phase.lastSeen >= CREEP_LIFE_TIME) unloadPhases.delete(name)
            lastPhaseCleanup = Game.time
        }
    }
}

/** A steady full batch repeats at the same capacity-limited period, after one startup alignment. */
function phaseDue(creep: Creep, capacity: number, batch: number): boolean {
    if (batch <= 0 || capacity < batch * 2) return false
    const period = Math.max(1, Math.floor(capacity / batch) - 1)
    let phase = unloadPhases.get(creep.name)
    if (phase === undefined || phase.id !== creep.id || phase.period !== period) {
        let hash = 2166136261
        for (let index = 0; index < creep.name.length; index++) hash = Math.imul(hash ^ creep.name.charCodeAt(index), 16777619)
        phase = { id: creep.id, period, phase: (hash >>> 0) % period, lastSeen: Game.time }
        unloadPhases.set(creep.name, phase)
    }
    phase.lastSeen = Game.time
    return Game.time % period === phase.phase
}

function walkable(creep: Creep, source: Source, x: number, y: number): boolean {
    const room = creep.room
    if (x <= 0 || x >= 49 || y <= 0 || y >= 49 || (source.pos.x == x && source.pos.y == y)) return false
    if (room.sources.some(candidate => candidate.pos.x == x && candidate.pos.y == y) ||
        (room.mineral?.pos.x == x && room.mineral.pos.y == y) ||
        (room.controller?.pos.x == x && room.controller.pos.y == y)) return false
    const terrain = room.getTerrain?.()
    if (terrain != undefined && (terrain.get(x, y) & TERRAIN_MASK_WALL) != 0) return false
    for (const structure of room.lookForAt?.(LOOK_STRUCTURES, x, y) || []) {
        const rampart = structure as StructureRampart
        if (structure.structureType != STRUCTURE_ROAD && structure.structureType != STRUCTURE_CONTAINER &&
            !(structure.structureType == STRUCTURE_RAMPART && (rampart.my || rampart.isPublic))) return false
    }
    return true
}

function unoccupied(creep: Creep, x: number, y: number): boolean {
    const owner = reservations.get(seatKey(creep.room, x, y))
    return (owner == undefined || owner == creep.name) &&
        !(creep.room.lookForAt?.(LOOK_CREEPS, x, y) || []).some(unit => unit.name != creep.name)
}

/** Keep a seated miner still; moving miners reserve separate source/buffer intersections. */
function miningPosition(creep: Creep, source: Source, buffer: StructureLink | StructureContainer): { position?: RoomPosition; occupied: boolean } {
    const direct = creep.store.getCapacity(RESOURCE_ENERGY) === 0 && buffer.structureType === STRUCTURE_CONTAINER
    if (creep.pos.isNearTo(source) && creep.pos.isNearTo(buffer) && (!direct || creep.pos.isEqualTo(buffer)))
        return { position: creep.pos, occupied: false }
    let selected: RoomPosition | undefined, preferred = Infinity, distance = Infinity
    let hasSeat = false
    for (let x = source.pos.x - 1; x <= source.pos.x + 1; x++) for (let y = source.pos.y - 1; y <= source.pos.y + 1; y++) {
        if (Math.max(Math.abs(x - buffer.pos.x), Math.abs(y - buffer.pos.y)) > 1 ||
            direct && (x !== buffer.pos.x || y !== buffer.pos.y) || !walkable(creep, source, x, y)) continue
        hasSeat = true
        if (!unoccupied(creep, x, y)) continue
        const preference = buffer.structureType == STRUCTURE_CONTAINER && x == buffer.pos.x && y == buffer.pos.y ? 0 : 1
        const range = Math.max(Math.abs(x - creep.pos.x), Math.abs(y - creep.pos.y))
        if (preference < preferred || (preference == preferred && range < distance)) {
            selected = new RoomPosition(x, y, creep.room.name); preferred = preference; distance = range
        }
    }
    return { position: selected, occupied: selected == undefined && hasSeat }
}

function resolveStation(creep: Creep, source: Source): MiningStation | null | undefined {
    if (source.pos.roomName != creep.room.name) return undefined
    const link = sourceLinkWithCenter(creep.room, source)
    if (link !== undefined) {
        const seat = miningPosition(creep, source, link)
        if (seat.position === undefined) return null
        reservations.set(seatKey(creep.room, seat.position.x, seat.position.y), creep.name)
        // Only complete central transport owns this mine; other Containers retain their supply role.
        return { position: seat.position, link }
    }
    let station: MiningStation | undefined
    let occupied = false
    let minimumEnergy = Infinity
    for (const container of creep.room.containers) {
        if (!source.pos.isNearTo(container)) continue
        const seat = station == undefined ? miningPosition(creep, source, container) : undefined
        occupied = occupied || seat?.occupied === true
        const position = station?.position || seat?.position
        if (position == undefined || !position.isNearTo(container)) continue
        const energy = container.store[RESOURCE_ENERGY]
        if (station == undefined) station = { position, container }
        if (energy < minimumEnergy) { station.container = container; minimumEnergy = energy }
    }
    if (station != undefined) reservations.set(seatKey(creep.room, station.position.x, station.position.y), creep.name)
    // A temporarily occupied station must not trigger bootstrap container creation.
    return station || (occupied ? null : undefined)
}

/** Preparation and work share geometry only; Store, decay and transfer choices are always read at work time. */
function findStation(creep: Creep, source: Source): MiningStation | null | undefined {
    resetReservations()
    const previous = stations.get(creep)
    if (previous?.source === source && previous.room === creep.room && previous.position === creep.pos &&
        previous.x === creep.pos.x && previous.y === creep.pos.y) return previous.station
    const station = resolveStation(creep, source)
    stations.set(creep, { source, room: creep.room, position: creep.pos, x: creep.pos.x, y: creep.pos.y, station })
    return station
}

/** Undefined means no real workstation exists, so the role must keep its bootstrap behavior. */
export function prepareStationaryMining(creep: Creep, source: Source): boolean | undefined {
    if (retireSourceLinkMiner(creep, source)) return false
    const station = findStation(creep, source)
    if (station === undefined) return undefined
    if (station === null) { creep.memory.ready = false; return false }
    if (!creep.pos.isEqualTo(station.position)) {
        creep.memory.ready = false
        creep.moveTo(station.position, { range: 0 })
        return false
    }
    creep.memory.ready = true
    return true
}

/** Batch transfers while keeping enough snapshot capacity to harvest on every productive tick. */
export function runStationaryMining(creep: Creep, source: Source): boolean {
    if (retireSourceLinkMiner(creep, source)) return true
    const station = findStation(creep, source)
    if (station === undefined) return false
    if (station === null) { creep.memory.ready = false; return true }
    if (!creep.pos.isEqualTo(station.position)) {
        creep.memory.ready = false
        creep.moveTo(station.position, { range: 0 })
        return true
    }
    creep.memory.working = false
    const energy = creep.store[RESOURCE_ENERGY]
    // An empty depleted station has no harvest or unload to schedule. Keep geometry live,
    // and retain the critical Container refill/repair path while awaiting regeneration.
    if (energy <= 0 && source.energy <= 0 &&
        (station.container === undefined || station.container.hits > CONTAINER_DECAY)) return true
    const free = creep.store.getFreeCapacity(RESOURCE_ENERGY)
    const capacity = creep.store.getCapacity(RESOURCE_ENERGY)
    const batch = getHarvestPower(creep)
    // Repair consumes the WORK intent; avoid a decay loss without repairing every missing hit.
    if (station.container != undefined && station.container.hits <= CONTAINER_DECAY) {
        if (energy > 0) { creep.repair(station.container); return true }
        // A depleted source can outlast the next remote-container decay interval.
        if (free > 0 && station.container.store[RESOURCE_ENERGY] > 0) {
            creep.withdraw(station.container, RESOURCE_ENERGY)
            return true
        }
    }
    const deposit = station.link != undefined && station.link.store.getFreeCapacity(RESOURCE_ENERGY) > 0 ? station.link :
        station.container != undefined && station.container.store.getFreeCapacity(RESOURCE_ENERGY) > 0 ? station.container : undefined
    // Unload before this harvest would leave less than one more full batch of space.
    // Equality is safe: a 5WORK/50-capacity miner unloads at 40, rather than at 30.
    // A depleted source still flushes its final partial batch for the local economy.
    if (energy > 0 && deposit != undefined && (source.energy <= 0 || batch <= 0 || free < batch * 2 || phaseDue(creep, capacity, batch)))
        creep.transfer(deposit, RESOURCE_ENERGY)
    // Store reads are snapshots: a transfer intent has not created free capacity yet.
    if (source.energy > 0 && batch > 0 && (free >= Math.min(batch, source.energy) || capacity == 0)) {
        if (creep.harvest(source) == ERR_NOT_IN_RANGE) creep.memory.ready = false
    }
    return true
}
