import type { addCreepConfig } from './demand'
import { hasRemoteHomeEconomy } from './remoteHomeEconomy'
import { isDevelopingRoom } from './development'
import { isRoomEvacuating } from 'room/evacuationState'
import { remoteRoadPolicy as policy } from 'settings/remoteRoads'
import { populationPolicy } from 'settings/population'
import { developmentRemotePolicy } from 'settings/developmentRemotes'
import { constructionPolicy } from 'settings/construction'
import { runtimePolicy } from 'settings/runtime'
import { canShareStructureTile, getConstructionBudget } from 'planning/construction'

interface RemoteRoadRoute {
    targetRoom: string
    sourceId: string
    signature: string
    attemptedAt: number
    plannedAt?: number
    /** Compact persistent coordinates, x * 50 + y, shared by every lane worker. */
    rooms: Record<string, number[]>
}
interface RemoteRoadState { routes: Record<string, RemoteRoadRoute>; lastConstructionAt?: number }
export interface RemoteRoadWork { roomName: string; x: number; y: number; id: string; kind: 'build' | 'repair' }
declare global { interface RoomMemory { remoteRoads?: RemoteRoadState } }

let tick = -1, shard = '', searches = 0, newSites = 0, started = 0
let safety = new Map<string, boolean>()
let indexes = new Map<string, { structures: Structure[]; sites: ConstructionSite[] }>()
function prepareTick(): void {
    if (tick === Game.time && shard === (Game.shard?.name || '')) return
    tick = Game.time; shard = Game.shard?.name || ''; searches = 0; newSites = 0
    started = Game.cpu?.getUsed() || 0; safety = new Map(); indexes = new Map()
}
function index(room: Room): { structures: Structure[]; sites: ConstructionSite[] } {
    prepareTick()
    let value = indexes.get(room.name)
    if (!value) {
        value = { structures: room.find(FIND_STRUCTURES), sites: room.constructionSites || room.find(FIND_CONSTRUCTION_SITES) }
        indexes.set(room.name, value)
    }
    return value
}
function homePaused(home: Room): boolean {
    return isRoomEvacuating(home) || (runtimePolicy.warModeScope === 'empire' ?
        Object.values(Memory.warMode || {}).some(Boolean) : Memory.warMode?.[home.name] === true)
}
export function isRemoteRoadRoomSafe(room: Room, home: Room): boolean {
    prepareTick()
    const username = home.controller?.owner?.username || home.spawns[0]?.owner?.username
    const key = `${room.name}/${username}`
    const previous = safety.get(key)
    if (previous !== undefined) return previous
    const controller = room.controller
    const safe = !Memory.warMode?.[room.name] && !isRoomEvacuating(room) &&
        (!controller?.owner || controller.my) && (!controller?.reservation || controller.reservation.username === username) &&
        !(room.enemies || room.find(FIND_HOSTILE_CREEPS)).length &&
        !room.find(FIND_HOSTILE_STRUCTURES).some(structure =>
            structure.structureType === STRUCTURE_INVADER_CORE || structure.structureType === STRUCTURE_KEEPER_LAIR ||
            structure.structureType === STRUCTURE_TOWER)
    safety.set(key, safe)
    return safe
}
function activeRemotes(home: Room): string[] {
    const manual = new Set<string>()
    for (let i = 0; i < populationPolicy.maximumRemoteRooms; i++) {
        const room = Game.flags?.[`${home.name}_OUT${i}`]?.pos.roomName
        if (room && room !== home.name) manual.add(room)
    }
    const automatic = developmentRemotePolicy.enabled && isDevelopingRoom(home) && home.level <= developmentRemotePolicy.maximumLevel &&
        home.memory.developmentRemotes?.enabled !== false ? home.memory.developmentRemotes?.selectedRooms || [] : []
    return Object.entries(home.memory.remoteCommissioning?.rooms || {}).filter(([name, record]) =>
        (record.kind === 'manual' ? manual.has(name) : automatic.includes(name)) &&
        (record.maintenance || record.admitted !== false) && !Game.rooms[name]?.controller?.owner &&
        (record.maintenance || record.phase === 'hauling' || record.phase === 'ready') && Object.keys(record.sources).length > 0)
        .map(([name]) => name)
}
export function hasRemoteRoadRoom(home: Room, roomName: string): boolean {
    const active = activeRemotes(home)
    return active.length > 0 && (roomName === home.name || active.includes(roomName) ||
        Object.values(home.memory.remoteRoads?.routes || {}).some(route => active.includes(route.targetRoom) && !!route.rooms[roomName]))
}
export function getRemoteRoadFallback(home: Room): { roomName: string; x: number; y: number; sourceId: string } | undefined {
    for (const roomName of activeRemotes(home)) {
        const target = Game.rooms[roomName]
        if (!target || !isRemoteRoadRoomSafe(target, home) || !Object.values(home.memory.remoteRoads?.routes || {})
            .some(route => route.targetRoom === roomName && route.plannedAt !== undefined && laneSafe(home, route))) continue
        const source = target.sources?.[0]
        if (source) return { roomName, x: source.pos.x, y: source.pos.y, sourceId: source.id }
    }
    return undefined
}
function laneSafe(home: Room, route: RemoteRoadRoute): boolean {
    const target = Game.rooms[route.targetRoom]
    return !!target && isRemoteRoadRoomSafe(target, home) && Object.keys(route.rooms).every(name => {
        const visible = Game.rooms[name]
        return !visible || isRemoteRoadRoomSafe(visible, home)
    })
}
function matrix(room: Room): CostMatrix {
    const costs = new PathFinder.CostMatrix()
    for (const structure of index(room).structures) {
        const { x, y } = structure.pos
        if (structure.structureType === STRUCTURE_ROAD) { if (costs.get(x, y) !== 255) costs.set(x, y, 1) }
        else if ((OBSTACLE_OBJECT_TYPES as readonly string[]).includes(structure.structureType) ||
            structure.structureType === STRUCTURE_RAMPART && !(structure as StructureRampart).my && !(structure as StructureRampart).isPublic)
            costs.set(x, y, 255)
    }
    for (const site of index(room).sites) if ((OBSTACLE_OBJECT_TYPES as readonly string[]).includes(site.structureType))
        costs.set(site.pos.x, site.pos.y, 255)
    for (const [type, positions] of Object.entries(room.memory.roomBlueprint?.structures || {}))
        if ((OBSTACLE_OBJECT_TYPES as readonly string[]).includes(type))
            for (const [x, y] of positions || []) costs.set(x, y, 255)
    for (const source of room.sources || []) costs.set(source.pos.x, source.pos.y, 255)
    for (const mineral of room.find(FIND_MINERALS)) costs.set(mineral.pos.x, mineral.pos.y, 255)
    if (room.controller) costs.set(room.controller.pos.x, room.controller.pos.y, 255)
    return costs
}
function cpuAvailable(): boolean {
    return Game.cpu.bucket >= policy.minimumBucket && Game.cpu.tickLimit - Game.cpu.getUsed() >= policy.minimumCpuHeadroom &&
        Game.cpu.getUsed() - started < policy.maximumPlanningCpu
}
function canPlan(): boolean {
    return cpuAvailable() && searches < policy.maximumPathSearchesPerTick
}
function plan(home: Room, targetRoom: string, source: { id: string; x: number; y: number }, state: RemoteRoadState): void {
    const origin = home.storage?.pos || home.spawns[0].pos
    const target = Game.rooms[targetRoom]
    if (!target || !isRemoteRoadRoomSafe(target, home)) return
    const container = index(target).structures.find(structure => structure.structureType === STRUCTURE_CONTAINER &&
        Math.max(Math.abs(structure.pos.x - source.x), Math.abs(structure.pos.y - source.y)) <= 1)
    const destination = container?.pos || new RoomPosition(source.x, source.y, targetRoom), range = container ? 0 : 1
    const key = `${targetRoom}/${source.id}`, signature = `${origin.x},${origin.y}/${destination.x},${destination.y}/${range}`
    const previous = state.routes[key]
    if (previous?.signature === signature && (previous.plannedAt !== undefined ?
        Game.time - previous.plannedAt < policy.replanInterval : Game.time - previous.attemptedAt < policy.retryInterval)) return
    if (!canPlan()) return
    searches++
    const route: RemoteRoadRoute = { targetRoom, sourceId: source.id, signature, attemptedAt: Game.time, rooms: {} }
    const allowed = new Set([home.name, targetRoom])
    const roomRoute = Game.map.findRoute(home.name, targetRoom, { routeCallback: name => {
        const visible = Game.rooms[name]
        return visible && isRemoteRoadRoomSafe(visible, home) ? 1 : Infinity
    } })
    if (!Array.isArray(roomRoute) || roomRoute.length >= policy.maximumRouteRooms) { state.routes[key] = route; return }
    for (const step of roomRoute) allowed.add(step.room)
    const costs = new Map<string, CostMatrix>()
    for (const name of allowed) {
        const room = Game.rooms[name]
        if (!room || !isRemoteRoadRoomSafe(room, home)) { state.routes[key] = route; return }
        costs.set(name, matrix(room))
    }
    const result = PathFinder.search(origin, { pos: destination, range }, {
        maxRooms: policy.maximumRouteRooms, maxOps: policy.maximumPathOps, plainCost: 2, swampCost: 10,
        roomCallback: name => costs.get(name) || false,
    })
    if (!result.incomplete && result.path.length > 0 && result.path.every(pos => allowed.has(pos.roomName))) {
        for (const pos of result.path) {
            if (pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49) continue
            const tiles = route.rooms[pos.roomName] || (route.rooms[pos.roomName] = [])
            const coordinate = pos.x * 50 + pos.y
            if (!tiles.includes(coordinate)) tiles.push(coordinate)
        }
        route.plannedAt = Game.time
    }
    state.routes[key] = route
}
function construct(home: Room, routes: RemoteRoadRoute[]): void {
    const budget = getConstructionBudget(), building = constructionPolicy.building
    for (const route of routes) {
        if (!laneSafe(home, route)) continue
        for (const [name, tiles] of Object.entries(route.rooms)) {
            if (!cpuAvailable()) return
            const room = Game.rooms[name]
            if (!room || !isRemoteRoadRoomSafe(room, home)) continue
            const { structures, sites } = index(room), intents = budget.intents.get(name) || []
            budget.intents.set(name, intents)
            const occupied = new Map<number, StructureConstant[]>()
            const privateRamparts = new Set<number>()
            for (const item of structures) {
                const coordinate = item.pos.x * 50 + item.pos.y, types = occupied.get(coordinate) || []
                types.push(item.structureType); occupied.set(coordinate, types)
                if (item.structureType === STRUCTURE_RAMPART && !(item as StructureRampart).my && !(item as StructureRampart).isPublic)
                    privateRamparts.add(coordinate)
            }
            const siteTiles = new Set(sites.map(site => site.pos.x * 50 + site.pos.y))
            for (const intent of intents) siteTiles.add(intent.position[0] * 50 + intent.position[1])
            const terrain = room.getTerrain()
            const blueprintObstacles = new Set<number>()
            for (const [type, positions] of Object.entries(room.memory.roomBlueprint?.structures || {}))
                if ((OBSTACLE_OBJECT_TYPES as readonly string[]).includes(type))
                    for (const [x, y] of positions || []) blueprintObstacles.add(x * 50 + y)
            const resources = [...(room.sources || []).map(source => source.pos), ...room.find(FIND_MINERALS).map(mineral => mineral.pos),
                ...(room.controller ? [room.controller.pos] : [])]
            for (const coordinate of tiles) {
                if (budget.remaining <= policy.freeSitesForLocalConstruction || newSites >= policy.maximumNewSitesPerTick) return
                if (intents.length >= building.maximumNewSitesPerRoom ||
                    sites.filter(site => site.my).length + intents.length >= building.maximumActiveSitesPerRoom) break
                const x = Math.floor(coordinate / 50), y = coordinate % 50
                const existing = occupied.get(coordinate) || []
                if (x <= 0 || x >= 49 || y <= 0 || y >= 49 || siteTiles.has(coordinate) || blueprintObstacles.has(coordinate) || privateRamparts.has(coordinate) ||
                    existing.includes(STRUCTURE_ROAD) || existing.some(type => !canShareStructureTile(type, STRUCTURE_ROAD)) ||
                    terrain.get(x, y) === TERRAIN_MASK_WALL || resources.some(pos => pos.x === x && pos.y === y)) continue
                const code = room.createConstructionSite(x, y, STRUCTURE_ROAD)
                if (code === ERR_FULL) { budget.remaining = 0; return }
                if (code !== OK) continue
                intents.push({ type: STRUCTURE_ROAD, position: [x, y] }); siteTiles.add(coordinate)
                budget.remaining--; newSites++; room.memory.needUpdateCache = true
            }
        }
    }
}
/** Resolve only real, visible sites/roads; never hand a builder an unmaterialized construction intent. */
export function getRemoteRoadWork(home: Room, targetRoom?: string): RemoteRoadWork | undefined {
    if (!policy.enabled || homePaused(home)) return undefined
    const configured = activeRemotes(home).filter(name => !targetRoom || name === targetRoom)
    const routes = Object.values(home.memory.remoteRoads?.routes || {}).filter(route => configured.includes(route.targetRoom) &&
        route.plannedAt !== undefined && laneSafe(home, route))
    const active = configured.filter(name => routes.some(route => route.targetRoom === name))
    const tiles = new Map<string, Set<number>>()
    for (const route of routes) for (const [name, coordinates] of Object.entries(route.rooms)) {
        const selected = tiles.get(name) || new Set<number>()
        coordinates.forEach(coordinate => selected.add(coordinate)); tiles.set(name, selected)
    }
    let build: ConstructionSite | undefined, repair: Structure | undefined
    for (const name of new Set([...active, ...tiles.keys()])) {
        const room = Game.rooms[name]
        if (!room || !isRemoteRoadRoomSafe(room, home)) continue
        const { structures, sites } = index(room), lane = tiles.get(name)
        const selected = (pos: RoomPosition): boolean => active.includes(name) || !!lane?.has(pos.x * 50 + pos.y)
        if (!build) build = sites.find(site => site.my && selected(site.pos))
        for (const road of structures) if (road.structureType === STRUCTURE_ROAD && selected(road.pos) &&
            road.hits < road.hitsMax * policy.repairRatio && (!repair || road.hits / road.hitsMax < repair.hits / repair.hitsMax)) repair = road
    }
    const target = repair || build
    if (target) return { roomName: target.pos.roomName, x: target.pos.x, y: target.pos.y, id: target.id, kind: repair ? 'repair' : 'build' }
    return undefined
}
/** Called after both manual and automatic commissioning so neither pipeline misses its lanes. */
export function releaseRemoteRoadConfigs(publish: typeof addCreepConfig): void {
    if (!policy.enabled) return
    prepareTick()
    const homes = Object.values(Game.rooms).filter(home => home.my)
    const offset = homes.length ? Math.floor(Game.time / populationPolicy.refreshInterval) % homes.length : 0
    for (const home of [...homes.slice(offset), ...homes.slice(0, offset)]) {
        if ((home.level || home.controller?.level || 0) < policy.minimumHomeLevel || !home.spawns?.length || homePaused(home)) continue
        const active = activeRemotes(home)
        if (!active.length) { if (home.memory.remoteRoads) home.memory.remoteRoads.routes = {}; continue }
        if (!hasRemoteHomeEconomy(home) || !isRemoteRoadRoomSafe(home, home)) continue
        const state = home.memory.remoteRoads || (home.memory.remoteRoads = { routes: {} })
        for (const key of Object.keys(state.routes)) if (!active.includes(state.routes[key].targetRoom)) delete state.routes[key]
        for (const targetRoom of active) {
            const target = Game.rooms[targetRoom]
            if (!target || !isRemoteRoadRoomSafe(target, home)) continue
            const sources = Object.values(home.memory.remoteCommissioning!.rooms[targetRoom].sources)
            for (const source of sources) plan(home, targetRoom, source, state)
        }
        if (cpuAvailable() && (state.lastConstructionAt === undefined || Game.time - state.lastConstructionAt >= policy.constructionInterval)) {
            construct(home, Object.values(state.routes)); state.lastConstructionAt = Game.time
        }
        const work = getRemoteRoadWork(home), source = getRemoteRoadFallback(home)
        if (!work || !source) continue
        const data: RemoteBuilderData = { sourceFlag: source.sourceId, targetFlag: source.sourceId, roadHome: home.name, targetRoom: source.roomName }
        // Reuse the legacy manual maintenance name instead of breeding another worker at migration.
        const name = publish(home, 'rBuilder', `${home.name}_OSBUILDER_${home.name}`, data)
        const config = home.memory.creepConfig[name]
        if (config) { config.spawnPriority = policy.builderPriority; config.bodyProfile = { boostTier: 0, terrain: 'plain', maximumCost: policy.builderMaximumCost } }
        if (Game.creeps[name]) {
            data.roadBuildTarget = (Game.creeps[name].memory.data as RemoteBuilderData)?.roadBuildTarget
            Game.creeps[name].memory.data = data
        }
    }
}
