import { redundantSourceContainer, sourceLink, sourceLinkContainerSeats, sourceLinkWithCenter } from 'room/sourceLinks'
import { sourceLinkPolicy } from 'settings/sourceLinks'

const inspected = new WeakMap<Room, number>()

const positionKey = (x: number, y: number): number => x * 50 + y
const nearSource = (source: Source, x: number, y: number): boolean =>
    Math.max(Math.abs(source.pos.x - x), Math.abs(source.pos.y - y)) <= sourceLinkPolicy.containerRange

/** Restore only missing mine buffers; preserve controller/mineral plans and the native Container quota. */
function restoreSourceContainers(room: Room, containers: StructureContainer[], sites: ConstructionSite[]): void {
    const blueprint = room.memory.roomBlueprint
    if (blueprint === undefined) return
    const positions = blueprint.structures.container || []
    const limit = CONTROLLER_STRUCTURES[STRUCTURE_CONTAINER][room.controller!.level] || 0
    if (limit <= 0) return
    const occupied = new Set(positions.map(([x, y]) => positionKey(x, y)))
    for (const item of [...containers, ...sites]) {
        if (item.structureType === STRUCTURE_CONTAINER) occupied.add(positionKey(item.pos.x, item.pos.y))
    }
    let miners: Creep[] | undefined
    for (const source of room.sources || room.find(FIND_SOURCES)) {
        const link = sourceLink(room, source)
        if (link === undefined || 'progressTotal' in link || sourceLinkWithCenter(room, source) !== undefined ||
            positions.some(([x, y]) => nearSource(source, x, y))) continue
        // An existing buffer or unfinished site keeps its original position, even outside Link range.
        const existing = [...containers, ...sites].find(item => item.structureType === STRUCTURE_CONTAINER &&
            (!('my' in item) || item.my !== false) && nearSource(source, item.pos.x, item.pos.y))
        let position: [number, number] | undefined
        if (existing !== undefined) position = [existing.pos.x, existing.pos.y]
        else {
            if (occupied.size >= limit) continue
            const candidates = sourceLinkContainerSeats(room, source).filter(([x, y]) => {
                if (sites.some(site => site.pos.x === x && site.pos.y === y && site.structureType !== STRUCTURE_CONTAINER)) return false
                for (const type in blueprint.structures) {
                    if (type === STRUCTURE_CONTAINER || type === STRUCTURE_ROAD || type === STRUCTURE_RAMPART) continue
                    if (blueprint.structures[type as BuildableStructureConstant]?.some(p => p[0] === x && p[1] === y)) return false
                }
                return true
            })
            // Preserve the current miner's seat when the old snapshot lost its Container coordinates.
            miners ||= Object.values(Game.creeps || {}).filter(creep => !creep.spawning &&
                (creep.memory.role === 'harvester' || creep.memory.role === 'rHarvester'))
            const miner = miners.find(creep => (creep.memory.data as HarvesterData)?.sourceId === source.id &&
                creep.pos.roomName === room.name && candidates.some(p => p[0] === creep.pos.x && p[1] === creep.pos.y))
            position = miner === undefined ? candidates[0] : [miner.pos.x, miner.pos.y]
        }
        if (position === undefined || occupied.size >= limit && !occupied.has(positionKey(...position))) continue
        positions.push(position)
        occupied.add(positionKey(...position))
        blueprint.structures.container = positions
        room.memory.needUpdateCache = true
    }
}

/** Complete central transport replaces Containers; incomplete networks recover their missing buffers. */
export function cleanupSourceLinkContainers(room: Room): void {
    if (!sourceLinkPolicy.enabled || !room.controller?.my || inspected.get(room) === Game.time) return
    inspected.set(room, Game.time)
    const containers = room.containers || (room.structures || room.find(FIND_STRUCTURES))
        .filter(item => item.structureType === STRUCTURE_CONTAINER)
    const sites = room.constructionSites || room.find(FIND_MY_CONSTRUCTION_SITES)
    for (const item of [...containers, ...sites]) {
        if (item.structureType !== STRUCTURE_CONTAINER || ('my' in item && item.my === false) ||
            !redundantSourceContainer(room, item.pos.x, item.pos.y)) continue
        const result = 'progressTotal' in item ? (item as ConstructionSite).remove() : item.destroy()
        if (result === OK) room.memory.needUpdateCache = true
    }
    const blueprint = room.memory.roomBlueprint
    if (blueprint?.structures.container) {
        const positions = blueprint.structures.container.filter(([x, y]) => !redundantSourceContainer(room, x, y))
        if (positions.length !== blueprint.structures.container.length) {
            blueprint.structures.container = positions
            room.memory.needUpdateCache = true
        }
    }
    restoreSourceContainers(room, containers, sites)
}
