import { sourceLinkPolicy } from 'settings/sourceLinks'
import { controllerLayoutPolicy } from 'settings/controllerLayout'

interface LinkIndex {
    tick: number
    shard: string
    links: StructureLink[]
    blocked: Set<number>
    structures?: Structure[]
    checkedSeats: Map<number, boolean>
    terrain: RoomTerrain
    sources: Source[]
    selected: Map<string, StructureLink | undefined>
    active: Map<string, boolean>
    seats: Map<string, number>
}
const indexes = new WeakMap<Room, LinkIndex>()
const tile = (x: number, y: number): number => x * 50 + y

interface StaticLinkCache {
    signature: string
    active: Map<string, boolean>
    seats: Map<string, number>
}
// Native Room/Source/Structure objects expire each tick. Only IDs, coordinates and booleans live here.
const staticIndexes = new Map<string, StaticLinkCache>()
let staticShard: string | undefined
let staticTick: number | undefined

function staticIndex(room: Room, links: StructureLink[], shard: string): { cache: StaticLinkCache; cacheActive: boolean } {
    if (staticShard !== shard || staticTick !== undefined && Game.time < staticTick) staticIndexes.clear()
    staticShard = shard; staticTick = Game.time
    const maximum = Number.isSafeInteger(sourceLinkPolicy.maximumCachedRooms) && sourceLinkPolicy.maximumCachedRooms > 0 ?
        sourceLinkPolicy.maximumCachedRooms : 0
    // Runtime disable/resize applies to existing signatures as well as newly visible rooms.
    while (staticIndexes.size > maximum) staticIndexes.delete(staticIndexes.keys().next().value)
    const controller = room.controller
    // Partial Room adapters cannot prove the native controller activation inputs; keep their live checks.
    const cacheActive = controller?.my === true && controller.id !== undefined &&
        controller.owner?.username !== undefined && Number.isInteger(controller.level)
    let signature = `${controller?.id}/${controller?.level}/${controller?.my}/${controller?.owner?.username}/${controller?.pos.x}/${controller?.pos.y}`
    // Link order matters for equal-distance ties in the engine's controller quota calculation.
    for (const link of links) signature += `|${link.id}/${link.pos.x}/${link.pos.y}/${link.my}/${link.owner?.username}`
    let cache = staticIndexes.get(room.name)
    if (cache === undefined || cache.signature !== signature) {
        cache = { signature, active: new Map(), seats: new Map() }
        staticIndexes.set(room.name, cache)
        while (staticIndexes.size > maximum) staticIndexes.delete(staticIndexes.keys().next().value)
    }
    return { cache, cacheActive }
}

function linkIsActive(index: LinkIndex, link: StructureLink): boolean {
    if (link.my === false) return false
    const previous = index.active.get(link.id)
    if (previous !== undefined) return previous
    const active = !link.isActive || link.isActive()
    index.active.set(link.id, active)
    return active
}

function indexFor(room: Room): LinkIndex {
    let index = indexes.get(room)
    const shard = Game.shard?.name || ''
    if (index?.tick === Game.time && index.shard === shard) return index
    const sources = room.sources || room.find(FIND_SOURCES)
    const minerals = room.mineral ? [room.mineral] : room.find(FIND_MINERALS)
    const blocked = new Set<number>()
    const links: StructureLink[] = []
    for (const item of [...sources, ...minerals, ...(room.controller ? [room.controller] : [])]) blocked.add(tile(item.pos.x, item.pos.y))
    for (const item of room.links || room.structures || room.find(FIND_STRUCTURES)) {
        if (item.structureType !== STRUCTURE_LINK) continue
        const link = item as StructureLink
        links.push(link)
    }
    const { cache, cacheActive } = staticIndex(room, links, shard)
    index = { tick: Game.time, shard, links,
        terrain: room.getTerrain(), blocked, sources, selected: new Map(), checkedSeats: new Map(),
        active: cacheActive ? cache.active : new Map(), seats: cache.seats }
    indexes.set(room, index)
    return index
}

/** Only candidate source/Link seats need static obstruction checks, shared across this room's mines. */
function seatIsOpen(room: Room, index: LinkIndex, x: number, y: number): boolean {
    const key = tile(x, y)
    if (index.blocked.has(key) || (index.terrain.get(x, y) & TERRAIN_MASK_WALL) !== 0) return false
    const previous = index.checkedSeats.get(key)
    if (previous !== undefined) return previous
    let open = true
    const nativeLookup = typeof room.lookForAt === 'function' && typeof LOOK_STRUCTURES !== 'undefined'
    // Standalone Room adapters may provide only structure arrays; native rooms use the tile lookup.
    const structures = nativeLookup ? room.lookForAt(LOOK_STRUCTURES, x, y) :
        index.structures || (index.structures = room.structures || room.find(FIND_STRUCTURES))
    for (const item of structures) {
        if (!nativeLookup && (item.pos.x !== x || item.pos.y !== y)) continue
        if (item.structureType === STRUCTURE_ROAD || item.structureType === STRUCTURE_CONTAINER ||
            item.structureType === STRUCTURE_RAMPART && ((item as StructureRampart).my !== false || (item as StructureRampart).isPublic)) continue
        open = false
        break
    }
    index.checkedSeats.set(key, open)
    return open
}

/** Ignore temporary creep occupancy: a miner can wait for its static harvesting seat. */
export function sourceLink(room: Room, source: Source): StructureLink | undefined {
    if (!sourceLinkPolicy.enabled || source.pos.roomName !== room.name) return undefined
    if (room.links?.length === 0) return undefined
    const index = indexFor(room)
    if (index.selected.has(source.id)) return index.selected.get(source.id)
    for (const link of index.links) {
        if (Math.max(Math.abs(source.pos.x - link.pos.x), Math.abs(source.pos.y - link.pos.y)) > sourceLinkPolicy.sourceRange) continue
        if (!linkIsActive(index, link)) continue
        const seatKey = `${source.id}/${source.pos.x}/${source.pos.y}/${link.id}`
        const previous = index.seats.get(seatKey)
        if (previous !== undefined && seatIsOpen(room, index, Math.floor(previous / 50), previous % 50)) {
            index.selected.set(source.id, link)
            return link
        }
        index.seats.delete(seatKey)
        for (let x = Math.max(1, source.pos.x - 1); x <= Math.min(48, source.pos.x + 1); x++) {
            for (let y = Math.max(1, source.pos.y - 1); y <= Math.min(48, source.pos.y + 1); y++) {
                if (Math.max(Math.abs(x - link.pos.x), Math.abs(y - link.pos.y)) > 1 || !seatIsOpen(room, index, x, y)) continue
                index.seats.set(seatKey, tile(x, y))
                index.selected.set(source.id, link)
                return link
            }
        }
    }
    index.selected.set(source.id, undefined)
    return undefined
}

/** Only complete central transport replaces carriers that supply the whole room. */
export function hasSourceLinkTransport(room: Room, source: Source, _buffer?: StructureLink | StructureContainer): boolean {
    const origin = sourceLinkWithCenter(room, source)
    if (origin === undefined) return false
    const storage = room.storage
    return storage === undefined || storage.my !== false && (!storage.isActive || storage.isActive())
}

/** Only a built, active central receiver can replace the Container's general room supply. */
function centralReceiver(room: Room): StructureLink | undefined {
    if (!sourceLinkPolicy.enabled) return undefined
    const center = room.centerLink
    if (center === undefined || center.structureType !== STRUCTURE_LINK || center.pos.roomName !== room.name ||
        'progressTotal' in center) return undefined
    // A planned site or a stale cached receiver cannot replace an operating Container.
    const index = indexFor(room)
    const receiver = index.links.find(link => link.id === center.id)
    return receiver !== undefined && !('progressTotal' in receiver) && linkIsActive(index, receiver) ? receiver : undefined
}

/** Controller-only transport must retain the Source Container for spawn and extension supply. */
export function sourceLinkWithCenter(room: Room, source: Source): StructureLink | undefined {
    const receiver = centralReceiver(room)
    if (receiver === undefined) return undefined
    const origin = sourceLink(room, source)
    return origin !== undefined && origin.id !== receiver.id && !('progressTotal' in origin) ? origin : undefined
}

/** Legal recovery seats share the existing Source and Link geometry without replanning the room. */
export function sourceLinkContainerSeats(room: Room, source: Source): [number, number][] {
    const link = sourceLink(room, source)
    if (link === undefined) return []
    const index = indexFor(room), positions: [number, number][] = []
    const seat = index.seats.get(`${source.id}/${source.pos.x}/${source.pos.y}/${link.id}`)
    if (seat !== undefined) positions.push([Math.floor(seat / 50), seat % 50])
    for (let x = Math.max(1, source.pos.x - 1); x <= Math.min(48, source.pos.x + 1); x++) {
        for (let y = Math.max(1, source.pos.y - 1); y <= Math.min(48, source.pos.y + 1); y++) {
            if (Math.max(Math.abs(x - link.pos.x), Math.abs(y - link.pos.y)) > 1 ||
                !seatIsOpen(room, index, x, y) || positions.some(position => position[0] === x && position[1] === y)) continue
            positions.push([x, y])
        }
    }
    return positions
}

/** Cleanup and construction agree: both built, usable Source and central Links must exist. */
export function redundantSourceContainer(room: Room, x: number, y: number): boolean {
    const receiver = centralReceiver(room)
    if (receiver === undefined) return false
    const index = indexFor(room)
    const controllerContainer = room.memory.roomBlueprint?.controllerContainer
    if (controllerContainer?.[0] === x && controllerContainer[1] === y) return false
    // Mature snapshots and manual layouts may not have explicit controller metadata.
    if (room.controller && Math.max(Math.abs(room.controller.pos.x - x), Math.abs(room.controller.pos.y - y)) <= controllerLayoutPolicy.containerRange) return false
    if (room.mineral && Math.max(Math.abs(room.mineral.pos.x - x), Math.abs(room.mineral.pos.y - y)) <= sourceLinkPolicy.containerRange) return false
    let covered = false
    for (const source of index.sources) {
        if (Math.max(Math.abs(source.pos.x - x), Math.abs(source.pos.y - y)) > sourceLinkPolicy.containerRange) continue
        const origin = sourceLink(room, source)
        if (origin === undefined || origin.id === receiver.id || 'progressTotal' in origin) return false
        covered = true
    }
    return covered
}
