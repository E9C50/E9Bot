import { selectControllerContainer } from './controllerContainer'
import { BlueprintPosition, positionKey, RoomBlueprint } from './types'
import { controllerLayoutPolicy as policy } from 'settings/controllerLayout'

const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
    Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
const point = ([x, y]: BlueprintPosition): { x: number; y: number } => ({ x, y })

/** Adjust only this resource station; mature snapshots and existing buildings remain untouched. */
export function migrateControllerContainer(room: Room, blueprint: RoomBlueprint): boolean {
    const controller = room.controller
    if (!controller || controller.level >= 8 || blueprint.origin !== 'planner63') return false
    if (blueprint.controllerContainer && distance(point(blueprint.controllerContainer), controller.pos) === policy.containerRange) return false
    const state = room.memory.roomBlueprintState || (room.memory.roomBlueprintState = {})
    if (state.lastControllerContainerAttempt !== undefined && Game.time - state.lastControllerContainerAttempt < policy.migrationInterval) return false
    if (Game.cpu.bucket < policy.minimumBucket || Game.cpu.tickLimit - Game.cpu.getUsed() < policy.minimumCpuHeadroom) return false
    state.lastControllerContainerAttempt = Game.time
    const sources = room.find(FIND_SOURCES), minerals = room.find(FIND_MINERALS)
    const resources = [...sources, ...minerals]
    const containers = blueprint.structures.container || []
    const legacy = blueprint.controllerContainer || containers.filter(position =>
        distance(point(position), controller.pos) <= policy.containerRange &&
        !resources.some(resource => distance(point(position), resource.pos) <= 1))
        .sort((a, b) => distance(point(a), controller.pos) - distance(point(b), controller.pos))[0]
    if (!legacy || resources.some(resource => distance(point(legacy), resource.pos) <= 1)) return false
    if (distance(point(legacy), controller.pos) === policy.containerRange) {
        blueprint.controllerContainer = [...legacy]; return false
    }
    const structures = room.find(FIND_STRUCTURES), sites = room.find(FIND_CONSTRUCTION_SITES)
    const terrain = room.getTerrain(), blocked = new Set<string>()
    const natural = [controller, ...resources]
    for (const object of natural) blocked.add(`${object.pos.x},${object.pos.y}`)
    const walkableType = (type: StructureConstant): boolean =>
        type === STRUCTURE_ROAD || type === STRUCTURE_CONTAINER || type === STRUCTURE_RAMPART
    for (const [type, positions] of Object.entries(blueprint.structures))
        if (!walkableType(type as StructureConstant)) for (const position of positions || []) blocked.add(positionKey(position))
    for (const object of [...structures, ...sites]) if (!walkableType(object.structureType) ||
        object.structureType === STRUCTURE_RAMPART && object.my === false && !(object as StructureRampart).isPublic)
        blocked.add(`${object.pos.x},${object.pos.y}`)
    const canWalk = (x: number, y: number): boolean => x > 0 && y > 0 && x < 49 && y < 49 &&
        (terrain.get(x, y) & TERRAIN_MASK_WALL) === 0 && !blocked.has(`${x},${y}`)
    const oldKey = positionKey(legacy)
    const reserved = new Set(containers.filter(position => positionKey(position) !== oldKey).map(positionKey))
    for (const site of sites) reserved.add(`${site.pos.x},${site.pos.y}`)
    for (const structure of structures) if (structure.structureType === STRUCTURE_CONTAINER)
        reserved.add(`${structure.pos.x},${structure.pos.y}`)
    const anchor = blueprint.center ? point(blueprint.center) : structures.find(structure =>
        structure.structureType === STRUCTURE_SPAWN && (structure as StructureSpawn).my)?.pos
    if (!anchor) return false
    const selected = selectControllerContainer(controller.pos, canWalk,
        (x, y) => canWalk(x, y) && !reserved.has(`${x},${y}`), anchor)
    if (!selected) return false
    const position = point(selected), outer: { x: number; y: number }[] = []
    for (let x = position.x - 1; x <= position.x + 1; x++) for (let y = position.y - 1; y <= position.y + 1; y++)
        if (canWalk(x, y) && distance({ x, y }, controller.pos) > policy.containerRange) outer.push({ x, y })
    if (!outer.length) return false
    outer.sort((a, b) => distance(a, anchor) - distance(b, anchor))
    const costs = new PathFinder.CostMatrix()
    for (const key of blocked) { const [x, y] = key.split(',').map(Number); costs.set(x, y, 255) }
    for (const [x, y] of blueprint.structures.road || []) if (!blocked.has(`${x},${y}`)) costs.set(x, y, 1)
    const route = PathFinder.search(new RoomPosition(anchor.x, anchor.y, room.name), outer.map(seat => ({
        pos: new RoomPosition(seat.x, seat.y, room.name), range: 0,
    })), { maxRooms: 1, maxOps: policy.maximumPathOps, plainCost: 2, swampCost: 10, roomCallback: () => costs })
    if (route.incomplete) return false
    const oldSite = sites.find(site => site.my && site.structureType === STRUCTURE_CONTAINER &&
        site.pos.x === legacy[0] && site.pos.y === legacy[1])
    // An unstarted site can be replaced without losing construction energy; invested work is preserved.
    if (oldSite?.progress === 0 && oldSite.remove() !== OK) return false
    blueprint.structures.container = containers.filter(candidate => positionKey(candidate) !== oldKey)
    blueprint.structures.container.splice(Math.max(0, containers.findIndex(candidate => positionKey(candidate) === oldKey)), 0, selected)
    blueprint.controllerContainer = [...selected]
    const roads = blueprint.structures.road || (blueprint.structures.road = [])
    const roadKeys = new Set(roads.map(positionKey))
    for (const pos of route.path) if (!roadKeys.has(`${pos.x},${pos.y}`)) {
        roads.push([pos.x, pos.y]); roadKeys.add(`${pos.x},${pos.y}`)
    }
    room.memory.needUpdateCache = true
    console.log(`[layout] ${room.name}: controller container ${oldKey} -> ${positionKey(selected)}, range ${policy.containerRange}`)
    return true
}
