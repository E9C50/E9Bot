import { redundantSourceContainer } from 'room/sourceLinks'
import { sourceLinkPolicy } from 'settings/sourceLinks'

const inspected = new WeakMap<Room, number>()

/** Source Link conversion is independent of automatic layout opt-out. */
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
    if (!blueprint?.structures.container) return
    const positions = blueprint.structures.container.filter(([x, y]) => !redundantSourceContainer(room, x, y))
    if (positions.length !== blueprint.structures.container.length) {
        blueprint.structures.container = positions
        room.memory.needUpdateCache = true
    }
}
