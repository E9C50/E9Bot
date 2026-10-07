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

/** A receiving Link must exist; Storage alone cannot drain a Source Link. */
export function hasSourceLinkTransport(room: Room, source: Source, buffer?: StructureLink | StructureContainer): boolean {
    const origin = sourceLink(room, source)
    if (origin === undefined) return false
    const index = indexFor(room)
    const receiver = (target: StructureLink | undefined): boolean => target !== undefined && target.id !== origin.id &&
        // An adapter-supplied receiver outside the complete Link list cannot share its topology proof.
        (index.links.some(link => link.id === target.id) ? linkIsActive(index, target) :
            target.my !== false && (!target.isActive || target.isActive()))
    const storage = room.storage
    if (storage !== undefined && storage.my !== false && (!storage.isActive || storage.isActive()) && receiver(room.centerLink)) return true
    return receiver(buffer?.structureType === STRUCTURE_LINK ? buffer as StructureLink : room.controllerLink)
}

/** Used by both the blueprint builder and cleanup; non-source Containers retain their role. */
export function redundantSourceContainer(room: Room, x: number, y: number): boolean {
    if (!sourceLinkPolicy.enabled) return false
    const controllerContainer = room.memory.roomBlueprint?.controllerContainer
    if (controllerContainer?.[0] === x && controllerContainer[1] === y) return false
    // Mature snapshots and manual layouts may not have explicit controller metadata.
    if (room.controller && Math.max(Math.abs(room.controller.pos.x - x), Math.abs(room.controller.pos.y - y)) <= controllerLayoutPolicy.containerRange) return false
    if (room.mineral && Math.max(Math.abs(room.mineral.pos.x - x), Math.abs(room.mineral.pos.y - y)) <= sourceLinkPolicy.containerRange) return false
    let covered = false
    for (const source of indexFor(room).sources) {
        if (Math.max(Math.abs(source.pos.x - x), Math.abs(source.pos.y - y)) > sourceLinkPolicy.containerRange) continue
        if (sourceLink(room, source) === undefined) return false
        covered = true
    }
    return covered
}
