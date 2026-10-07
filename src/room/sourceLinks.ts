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
}
const indexes = new WeakMap<Room, LinkIndex>()
const tile = (x: number, y: number): number => x * 50 + y

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
        if (link.my !== false && (!link.isActive || link.isActive())) links.push(link)
    }
    index = { tick: Game.time, shard, links,
        terrain: room.getTerrain(), blocked, sources, selected: new Map(), checkedSeats: new Map() }
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
        for (let x = Math.max(1, source.pos.x - 1); x <= Math.min(48, source.pos.x + 1); x++) {
            for (let y = Math.max(1, source.pos.y - 1); y <= Math.min(48, source.pos.y + 1); y++) {
                if (Math.max(Math.abs(x - link.pos.x), Math.abs(y - link.pos.y)) > 1 || !seatIsOpen(room, index, x, y)) continue
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
    const receiver = (target: StructureLink | undefined): boolean => target !== undefined && target.id !== origin.id &&
        target.my !== false && (!target.isActive || target.isActive())
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
