import type { addCreepConfig } from './demand'
import { developmentRemotePolicy as policy } from 'settings/developmentRemotes'
import { scoutMovementOptions } from 'shard/scoutMovement'
import { runtimePolicy } from 'settings/runtime'
import { isDevelopingRoom } from './development'
import { deliverHaulerEnergy } from './haulerDelivery'

const ROOM_NAME = /^[WE]\d+[NS]\d+$/
type Kind = 'scout' | 'harvester' | 'hauler' | 'reserver'
type DemandPublisher = typeof addCreepConfig
export interface DevelopmentRemoteSource {
    id: string; x: number; y: number
    /** Empty outward path plus loaded return path, for one MOVE per CARRY. */
    travelTicks?: number
    energyPerTick?: number
}
export interface DevelopmentRemoteIntel {
    seenAt: number
    status: 'safe' | 'blocked' | 'unreachable' | 'unknown'
    sources: DevelopmentRemoteSource[]
    blockedUntil?: number
    reason?: string
}
export interface DevelopmentRemoteState {
    enabled?: boolean
    lastScanTick?: number
    candidates: string[]
    selectedRooms: string[]
    intel: Record<string, DevelopmentRemoteIntel>
    scoutTarget?: string
}
export interface DevelopmentRemoteData {
    developmentRemote: { homeRoom: string; targetRoom: string; kind: Kind; homePosition: { x: number; y: number }; source?: DevelopmentRemoteSource; retiring?: boolean; lastContainerAttempt?: number }
    sourceId?: string
    targetRoom?: string
    sourceFlag?: string
    targetFlag?: string
}

let safetyTick = -1, manualTick = -1, budgetTick = -1
let safetyShard = '', manualShard = '', budgetShard = ''
let safety = new Map<string, string | undefined>()
let manualTargets = new Set<string>(), manualCounts = new Map<string, number>()
let routeChecks = 0, planningStarted = 0
let warTick = -1, empireAtWar = false

function coordinate(value: unknown): value is number { return Number.isInteger(value) && (value as number) >= 0 && (value as number) < 50 }
export function isDevelopmentRemoteData(value: unknown): value is DevelopmentRemoteData {
    if (value === null || typeof value !== 'object') return false
    const data = (value as DevelopmentRemoteData).developmentRemote
    return data !== undefined && data !== null && typeof data === 'object' && typeof data.homeRoom === 'string' && typeof data.targetRoom === 'string' &&
        ROOM_NAME.test(data.homeRoom) && ROOM_NAME.test(data.targetRoom) &&
        ['scout', 'harvester', 'hauler', 'reserver'].includes(data.kind) && data.homePosition !== undefined && data.homePosition !== null &&
        coordinate(data.homePosition.x) && coordinate(data.homePosition.y) && (data.source === undefined ||
            (data.source !== null && typeof data.source.id === 'string' && coordinate(data.source.x) && coordinate(data.source.y))) &&
        ((data.kind !== 'harvester' && data.kind !== 'hauler') || data.source !== undefined)
}

function atWar(home: Room): boolean {
    if (runtimePolicy.warModeScope === 'room') return Memory.warMode?.[home.name] === true
    if (warTick !== Game.time) { warTick = Game.time; empireAtWar = Object.values(Memory.warMode || {}).some(Boolean) }
    return empireAtWar
}

function manualRooms(): Set<string> {
    if (manualTick === Game.time && manualShard === Game.shard.name) return manualTargets
    manualTick = Game.time; manualShard = Game.shard.name; manualTargets = new Set(); manualCounts = new Map()
    for (const name in Game.flags) {
        const match = /^([WE]\d+[NS]\d+)_OUT\d+$/.exec(name)
        if (match === null) continue
        manualTargets.add(Game.flags[name].pos.roomName)
        manualCounts.set(match[1], (manualCounts.get(match[1]) || 0) + 1)
    }
    return manualTargets
}

function enabled(home: Room | undefined): home is Room {
    return policy.enabled && isDevelopingRoom(home) && home !== undefined && home.controller!.level <= policy.maximumLevel &&
        home.memory.developmentRemotes?.enabled !== false && home.spawns.length > 0
}
function username(home: Room): string | undefined { return home.controller?.owner?.username || home.spawns[0]?.owner?.username }
function issue(room: Room, home: Room): string | undefined {
    if (safetyTick !== Game.time || safetyShard !== Game.shard.name) { safetyTick = Game.time; safetyShard = Game.shard.name; safety = new Map() }
    const key = `${room.name}/${username(home) || ''}`
    if (safety.has(key)) return safety.get(key)
    let result: string | undefined
    const controller = room.controller
    if (controller === undefined) result = '没有可预定 Controller'
    else if (controller.owner !== undefined) result = '房间已被占领'
    else if (controller.reservation !== undefined && controller.reservation.username !== username(home)) result = '房间已被他人预定'
    else if (room.find(FIND_HOSTILE_STRUCTURES).some(structure => structure.structureType === STRUCTURE_INVADER_CORE ||
        (structure.structureType === STRUCTURE_TOWER && (structure as StructureTower).isActive() && (structure as StructureTower).store[RESOURCE_ENERGY] >= TOWER_ENERGY_COST))) result = '入侵核心或敌方 Tower'
    else if (room.find(FIND_HOSTILE_CREEPS).some(creep => [ATTACK, RANGED_ATTACK, WORK, HEAL].some(part => creep.getActiveBodyparts(part) > 0))) result = '存在活动敌对单位'
    safety.set(key, result)
    return result
}
function stateFor(home: Room): DevelopmentRemoteState {
    const state = home.memory.developmentRemotes || (home.memory.developmentRemotes = { candidates: [], selectedRooms: [], intel: {} })
    if (!Array.isArray(state.candidates)) state.candidates = []
    if (!Array.isArray(state.selectedRooms)) state.selectedRooms = []
    if (state.intel === null || typeof state.intel !== 'object' || Array.isArray(state.intel)) state.intel = {}
    return state
}
function block(home: Room, targetRoom: string, reason: string, status: DevelopmentRemoteIntel['status'] = 'blocked'): void {
    const state = stateFor(home)
    state.intel[targetRoom] = { seenAt: Game.time, status, sources: [], reason, blockedUntil: Game.time + policy.blockedRoomTicks }
    state.selectedRooms = state.selectedRooms.filter(name => name !== targetRoom)
}
function planningReady(): boolean {
    if (Game.cpu.bucket < policy.minimumBucket || Game.cpu.tickLimit - Game.cpu.getUsed() < policy.minimumCpuHeadroom) return false
    if (budgetTick !== Game.time || budgetShard !== Game.shard.name) {
        budgetTick = Game.time; budgetShard = Game.shard.name; routeChecks = 0; planningStarted = Game.cpu.getUsed()
    }
    return routeChecks < policy.maximumRouteChecksPerTick && Game.cpu.getUsed() - planningStarted < policy.maximumPlanningCpu
}
function ordinaryRoom(name: string): boolean {
    const match = /^[WE](\d+)[NS](\d+)$/.exec(name)
    if (match === null) return false
    const x = Number(match[1]) % 10, y = Number(match[2]) % 10
    return x !== 0 && y !== 0 && !(x >= 4 && x <= 6 && y >= 4 && y <= 6)
}
function discover(home: Room, state: DevelopmentRemoteState): void {
    if (!planningReady()) return
    const manual = manualRooms(), candidates: string[] = []
    for (const target of Object.values(Game.map.describeExits(home.name) || {})) {
        if (!ordinaryRoom(target) || manual.has(target)) continue
        if (Game.map.getRoomStatus(target)?.status !== 'normal') continue
        const route = Game.map.findRoute(home.name, target, { routeCallback: roomName => roomName === home.name || roomName === target ? 1 : Infinity })
        if (!Array.isArray(route) || route.length !== 1) { block(home, target, '邻房出口不可达', 'unreachable'); continue }
        candidates.push(target)
    }
    state.candidates = candidates.sort()
    state.lastScanTick = Game.time
}
function costs(room: Room): CostMatrix {
    const matrix = new PathFinder.CostMatrix()
    for (const structure of room.find(FIND_STRUCTURES)) {
        if (structure.structureType === STRUCTURE_ROAD) matrix.set(structure.pos.x, structure.pos.y, 1)
        else if ((OBSTACLE_OBJECT_TYPES as readonly string[]).includes(structure.structureType) || (structure.structureType === STRUCTURE_RAMPART && !(structure as StructureRampart).my && !(structure as StructureRampart).isPublic)) matrix.set(structure.pos.x, structure.pos.y, 255)
    }
    for (const resource of [...room.find(FIND_SOURCES), ...room.find(FIND_MINERALS)]) matrix.set(resource.pos.x, resource.pos.y, 255)
    if (room.controller) matrix.set(room.controller.pos.x, room.controller.pos.y, 255)
    return matrix
}
function observe(home: Room, target: Room, state: DevelopmentRemoteState): void {
    const unsafe = issue(target, home)
    if (unsafe !== undefined) { block(home, target.name, unsafe); return }
    const previous = state.intel[target.name]
    const energyPerTick = (target.controller?.reservation?.username === username(home) ? SOURCE_ENERGY_CAPACITY : SOURCE_ENERGY_NEUTRAL_CAPACITY) / ENERGY_REGEN_TIME
    if (previous?.status === 'safe') for (const source of previous.sources) source.energyPerTick = energyPerTick
    if (previous?.status === 'safe' && Game.time - previous.seenAt < policy.scanInterval) return
    if (!planningReady()) return
    const resources = target.find(FIND_SOURCES).slice(0, policy.maximumSourcesPerRoom)
    const matrices = new Map([[home.name, costs(home)], [target.name, costs(target)]])
    const terrain = new Map([[home.name, Game.map.getRoomTerrain(home.name)], [target.name, Game.map.getRoomTerrain(target.name)]])
    const sources: DevelopmentRemoteSource[] = []
    for (const source of resources) {
        if (!planningReady()) {
            if (sources.length > 0) state.intel[target.name] = { seenAt: Game.time, status: 'safe', sources }
            return
        }
        routeChecks++
        const result = PathFinder.search(home.spawns[0].pos, { pos: source.pos, range: 1 }, {
            maxRooms: 2, maxOps: policy.routeMaximumOps, plainCost: 2, swampCost: 10,
            roomCallback: name => matrices.get(name) || false,
        })
        if (!result.incomplete) {
            let loadedTicks = 0
            for (const position of result.path) {
                const road = matrices.get(position.roomName)?.get(position.x, position.y) === 1
                const tile = terrain.get(position.roomName)!.get(position.x, position.y)
                // Loaded CARRY weighs one part: one MOVE offsets a plain step, or one fifth of a swamp step.
                loadedTicks += !road && (tile & TERRAIN_MASK_SWAMP) !== 0 ? 5 : 1
            }
            sources.push({ id: source.id, x: source.pos.x, y: source.pos.y, travelTicks: Math.max(1, result.path.length + loadedTicks), energyPerTick })
        }
    }
    if (sources.length === 0) { block(home, target.name, '没有两房内可达的 Source', 'unreachable'); return }
    state.intel[target.name] = { seenAt: Game.time, status: 'safe', sources }
}
function fresh(intel: DevelopmentRemoteIntel | undefined): intel is DevelopmentRemoteIntel {
    return intel?.status === 'safe' && Game.time >= intel.seenAt && Game.time - intel.seenAt < policy.intelMaxAge
}
function averageTravel(intel: DevelopmentRemoteIntel): number {
    return intel.sources.reduce((total, source) => total + (source.travelTicks || policy.travelTicksPerRoom * 2), 0) /
        Math.max(1, intel.sources.length)
}
function activeTarget(state: DevelopmentRemoteState | undefined, task: DevelopmentRemoteData['developmentRemote']): boolean {
    const intel = state?.intel[task.targetRoom]
    return state?.selectedRooms.includes(task.targetRoom) === true && fresh(intel) &&
        (task.source === undefined || intel.sources.some(source => source.id === task.source!.id))
}
/** Read-only safety gate for a handoff that skips this tick's ordinary remote prepare hook. */
export function canRelayDevelopmentHauler(creep: Creep, data: DevelopmentRemoteData): boolean {
    const task = data.developmentRemote, home = Game.rooms[creep.memory.spawnRoom]
    if (task.kind !== 'hauler' || task.retiring || task.homeRoom !== creep.memory.spawnRoom || !enabled(home) || atWar(home) ||
        manualRooms().has(task.targetRoom) || !activeTarget(home.memory.developmentRemotes, task)) return false
    const intel = home.memory.developmentRemotes!.intel[task.targetRoom]
    if ((intel.blockedUntil || 0) > Game.time) return false
    const visible = Game.rooms[task.targetRoom]
    return visible === undefined || issue(visible, home) === undefined
}
function localEconomyReady(home: Room): boolean {
    if (home.energyCapacityAvailable < policy.minimumMiningCapacity) return false
    const sourceIds = new Set<string>(home.sources.map(source => source.id))
    let miner = false, filler = false
    for (const name in Game.creeps) {
        const creep = Game.creeps[name]
        if (creep.spawning || creep.memory.spawnRoom !== home.name || creep.room.name !== home.name) continue
        if (creep.memory.role === 'filler' && creep.getActiveBodyparts(CARRY) > 0) filler = true
        if (creep.memory.role === 'harvester' && creep.getActiveBodyparts(WORK) > 0 && sourceIds.has((creep.memory.data as HarvesterData).sourceId)) {
            const source = Game.getObjectById<Source>((creep.memory.data as HarvesterData).sourceId)
            if (source && creep.pos.isNearTo(source)) miner = true
        }
        if (miner && filler) return true
    }
    return false
}
function publish(addDemand: DemandPublisher, home: Room, role: CreepRoleConstant, displayName: string, data: DevelopmentRemoteData,
    body?: CreepMemory['development']): void {
    const name = addDemand(home, role, displayName, data)
    const config = home.memory.creepConfig[name]
    if (config && body) config.development = body
    const live = Game.creeps[name]
    if (live && isDevelopmentRemoteData(live.memory.data) && live.memory.data.developmentRemote.homeRoom === home.name) {
        // Only the single automatic scout is retargeted; worker caches remain intact.
        if (data.developmentRemote.kind === 'scout') live.memory.data = data
        else {
            live.memory.data.developmentRemote.homePosition = { ...data.developmentRemote.homePosition }
            live.memory.data.developmentRemote.source = data.developmentRemote.source && { ...data.developmentRemote.source }
            if (data.targetFlag !== undefined) live.memory.data.targetFlag = data.targetFlag
        }
    }
}

/** 在人工外矿需求之后调用；不创建旗帜，也不改满级房间的运营配置。 */
export function releaseDevelopmentRemoteConfigs(addDemand: DemandPublisher): void {
    const assigned = new Set<string>()
    for (const home of Object.values(Game.rooms)) {
        if (!enabled(home) || atWar(home)) continue
        const state = stateFor(home), manual = manualRooms()
        if (state.lastScanTick === undefined || Game.time - state.lastScanTick >= policy.scanInterval) discover(home, state)
        for (const roomName of state.candidates) {
            if (manual.has(roomName)) continue
            const target = Game.rooms[roomName]
            if (target) observe(home, target, state)
        }
        const available = Math.max(0, policy.maximumRooms - (manualCounts.get(home.name) || 0))
        state.selectedRooms = state.candidates.filter(name => !manual.has(name) && !assigned.has(name) && fresh(state.intel[name]))
            .sort((first, second) => state.intel[second].sources.length - state.intel[first].sources.length ||
                averageTravel(state.intel[first]) - averageTravel(state.intel[second]) || first.localeCompare(second)).slice(0, available)
        for (const selected of state.selectedRooms) assigned.add(selected)
        const homePosition = { x: home.spawns[0].pos.x, y: home.spawns[0].pos.y }
        const unknown = available > 0 ? state.candidates.find(name => !manual.has(name) && !fresh(state.intel[name]) &&
            (state.intel[name]?.blockedUntil || 0) <= Game.time) : undefined
        state.scoutTarget = unknown
        if (unknown) publish(addDemand, home, 'scout', `${home.name}_DEVELOPMENT_SCOUT`, {
            developmentRemote: { homeRoom: home.name, targetRoom: unknown, kind: 'scout', homePosition },
        }, { maximumCost: 50 })
        if (!localEconomyReady(home)) continue
        for (const targetRoom of state.selectedRooms) {
            const info = state.intel[targetRoom]
            for (const source of info.sources) {
                const metadata = { homeRoom: home.name, targetRoom, source: { ...source }, homePosition }
                const travelTicks = source.travelTicks || policy.travelTicksPerRoom * 2
                const rate = source.energyPerTick || SOURCE_ENERGY_NEUTRAL_CAPACITY / ENERGY_REGEN_TIME
                publish(addDemand, home, 'rHarvester', `${home.name}_DEVELOPMENT_HARVESTER_${source.id}`, {
                    developmentRemote: { ...metadata, kind: 'harvester' }, sourceId: source.id, targetRoom,
                }, { workParts: policy.harvesterWorkParts, carryParts: 1, stationary: true, travelTicks,
                    maximumCost: Math.min(home.energyCapacityAvailable, policy.harvesterMaximumCost) })
                const maximumCost = Math.min(home.energyCapacityAvailable, policy.haulerMaximumCost)
                const carryLimit = Math.max(1, Math.min(policy.maximumCarryPartsPerHauler, Math.floor(maximumCost / (BODYPART_COST[CARRY] + BODYPART_COST[MOVE]))))
                const totalCarry = Math.max(1, Math.ceil(rate * travelTicks * policy.haulingTravelMargin / CARRY_CAPACITY))
                const haulers = Math.min(policy.maximumHaulersPerSource, Math.ceil(totalCarry / carryLimit))
                const carryParts = Math.min(carryLimit, Math.ceil(totalCarry / haulers))
                for (let index = 0; index < haulers; index++) publish(addDemand, home, 'rFiller', `${home.name}_DEVELOPMENT_HAULER_${source.id}_${index}`, {
                    developmentRemote: { ...metadata, kind: 'hauler' }, sourceFlag: source.id, targetFlag: home.spawns[0].id,
                }, { carryParts, travelTicks, maximumCost })
            }
            if (home.controller!.level >= policy.reserveMinimumLevel && home.energyCapacityAvailable >= policy.minimumReserveCapacity)
                publish(addDemand, home, 'reserver', `${home.name}_DEVELOPMENT_RESERVER_${targetRoom}`, {
                    developmentRemote: { homeRoom: home.name, targetRoom, kind: 'reserver', homePosition }, targetRoom,
                }, { maximumCost: policy.minimumReserveCapacity })
        }
    }
}

function goHome(creep: Creep, data: DevelopmentRemoteData): void {
    const target = data.developmentRemote
    const position = new RoomPosition(target.homePosition.x, target.homePosition.y, target.homeRoom)
    if (creep.pos.inRangeTo(position, 1)) { creep.memory.dontPullMe = false; return }
    const code = creep.moveTo(position, { range: 1 })
    // BetterMove may lock a repeatedly stalled mover; withdrawing units must remain swappable.
    creep.memory.dontPullMe = false
    if (code === ERR_NO_PATH) creep.say('撤离无路')
}
function retire(creep: Creep, data: DevelopmentRemoteData): void {
    const target = data.developmentRemote; target.retiring = true
    if (creep.room.name !== target.homeRoom) { goHome(creep, data); return }
    const home = creep.room
    if (creep.store[RESOURCE_ENERGY] > 0) {
        const receiver = [home.storage, ...home.spawns, ...home.extensions].find(value => value?.store.getFreeCapacity(RESOURCE_ENERGY)! > 0)
        if (receiver) { if (creep.transfer(receiver, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.moveTo(receiver, { range: 1 }); return }
    }
    const spawn = home.spawns[0]
    if (spawn) {
        if (!creep.pos.isNearTo(spawn)) creep.moveTo(spawn, { range: 1 })
        else spawn.recycleCreep(creep)
    }
}

function distance(first: RoomPosition, second: RoomPosition): number {
    return first.roomName === second.roomName ? Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y)) : Infinity
}
function sourceContainer(creep: Creep, source: Source): StructureContainer | undefined {
    return creep.room.containers.find(container => source.pos.isNearTo(container))
}
function sourceSite(creep: Creep, source: Source): ConstructionSite | undefined {
    return creep.room.constructionSites.find(site => site.my && site.structureType === STRUCTURE_CONTAINER && source.pos.isNearTo(site))
}
function prepareMiner(creep: Creep, data: DevelopmentRemoteData): boolean {
    const source = Game.getObjectById<Source>(data.developmentRemote.source!.id)
    if (!source) return false
    const station = sourceContainer(creep, source) || sourceSite(creep, source)
    if (station && distance(creep.pos, station.pos) !== 0) { creep.moveTo(station, { range: 0 }); return false }
    if (!creep.pos.isNearTo(source)) { creep.moveTo(source, { range: 1 }); return false }
    creep.memory.ready = true
    return true
}
function runMiner(creep: Creep, data: DevelopmentRemoteData): boolean {
    const source = Game.getObjectById<Source>(data.developmentRemote.source!.id)
    if (!source || !creep.pos.isNearTo(source)) { creep.memory.ready = false; return false }
    const energy = creep.store[RESOURCE_ENERGY], free = creep.store.getFreeCapacity(RESOURCE_ENERGY)
    const container = sourceContainer(creep, source)
    if (container && container.hits <= CONTAINER_DECAY * policy.containerRepairDecayCycles && energy > 0) {
        creep.repair(container)
        return true
    }
    const site = container ? undefined : sourceSite(creep, source)
    if (site && energy > 0) { creep.build(site); return true }
    if (!container && !site && (data.developmentRemote.lastContainerAttempt === undefined ||
        Game.time - data.developmentRemote.lastContainerAttempt >= policy.containerAttemptInterval)) {
        data.developmentRemote.lastContainerAttempt = Game.time
        creep.room.createConstructionSite(creep.pos.x, creep.pos.y, STRUCTURE_CONTAINER)
        creep.room.memory.needUpdateCache = true
    }
    // Actions read the beginning-of-tick Store: never assume transfer has already freed capacity.
    if (energy > 0) {
        if (container && creep.pos.isNearTo(container) && container.store.getFreeCapacity(RESOURCE_ENERGY) > 0) creep.transfer(container, RESOURCE_ENERGY)
        else creep.drop(RESOURCE_ENERGY)
    }
    creep.memory.working = false
    if (source.energy > 0 && free > 0 && creep.harvest(source) === ERR_NOT_IN_RANGE) creep.memory.ready = false
    return true
}
function runHaulerSource(creep: Creep, data: DevelopmentRemoteData): boolean {
    if (creep.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) { creep.memory.working = true; goHome(creep, data); return false }
    const marker = data.developmentRemote, sourcePos = new RoomPosition(marker.source!.x, marker.source!.y, marker.targetRoom)
    let dropped: Resource | undefined, nearest = Infinity
    for (const item of creep.room.find(FIND_DROPPED_RESOURCES)) {
        if (item.resourceType !== RESOURCE_ENERGY || item.amount <= 0 || distance(item.pos, sourcePos) > 3) continue
        const range = distance(creep.pos, item.pos)
        if (range < nearest) { dropped = item; nearest = range }
    }
    if (dropped) {
        if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) creep.moveTo(dropped, { range: 1 })
        return true
    }
    const logistics = data as RemoteFillerData
    let container = logistics.withdrawTarget === undefined ? undefined : Game.getObjectById<StructureContainer>(logistics.withdrawTarget) || undefined
    if (!container || container.structureType !== STRUCTURE_CONTAINER || container.pos.roomName !== marker.targetRoom ||
        distance(container.pos, sourcePos) > 1 || container.store[RESOURCE_ENERGY] <= 0) {
        container = undefined; delete logistics.withdrawTarget
        nearest = Infinity
        for (const item of creep.room.containers) {
            if (distance(item.pos, sourcePos) > 1 || item.store[RESOURCE_ENERGY] <= 0) continue
            const range = distance(creep.pos, item.pos)
            if (range < nearest) { container = item; nearest = range }
        }
    }
    if (container) {
        logistics.withdrawTarget = container.id
        if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.moveTo(container, { range: 1 })
        return true
    }
    if (creep.store[RESOURCE_ENERGY] > 0) { creep.memory.working = true; goHome(creep, data); return false }
    if (distance(creep.pos, sourcePos) > 3) creep.moveTo(sourcePos, { range: 3 })
    return true
}
function runHaulerTarget(creep: Creep, data: DevelopmentRemoteData): boolean {
    if (creep.store[RESOURCE_ENERGY] <= 0) { creep.memory.working = false; return false }
    deliverHaulerEnergy(creep)
    return true
}
function runReserver(creep: Creep): boolean {
    const controller = creep.room.controller
    if (!controller) return false
    if (!creep.pos.isNearTo(controller)) creep.moveTo(controller, { range: 1 })
    else if (controller.reservation === undefined || controller.reservation.ticksToEnd < CONTROLLER_RESERVE_MAX) creep.reserveController(controller)
    return true
}

/** 仅自动标记单位改变行为；人工角色保持原输入和原工厂结果。 */
export function withDevelopmentRemoteRole(data: CreepData, behavior: ICreepConfig): ICreepConfig {
    if (!isDevelopmentRemoteData(data)) return behavior
    const run = (creep: Creep): boolean => data.developmentRemote.kind === 'harvester' ? runMiner(creep, data) :
        data.developmentRemote.kind === 'hauler' ? (creep.memory.working ? runHaulerTarget(creep, data) : runHaulerSource(creep, data)) :
        data.developmentRemote.kind === 'reserver' ? runReserver(creep) : false
    return { ...behavior, source: run, target: run, isNeed(home, creepName) {
        const task = data.developmentRemote
        if (task.retiring || !enabled(home) || atWar(home) || manualRooms().has(task.targetRoom)) return false
        if (creepName !== undefined) {
            const current = home.memory.creepConfig[creepName]?.data
            if (!isDevelopmentRemoteData(current) || current.developmentRemote.homeRoom !== task.homeRoom ||
                current.developmentRemote.targetRoom !== task.targetRoom || current.developmentRemote.kind !== task.kind ||
                current.developmentRemote.source?.id !== task.source?.id) return false
        }
        const state = home.memory.developmentRemotes
        return task.kind === 'scout' ? state?.scoutTarget === task.targetRoom :
            activeTarget(state, task)
    }, prepare(creep) {
        const task = data.developmentRemote, home = Game.rooms[task.homeRoom]
        if (task.retiring || !enabled(home) || manualRooms().has(task.targetRoom)) { retire(creep, data); return false }
        const state = stateFor(home), visible = Game.rooms[task.targetRoom]
        if (visible) {
            const unsafe = issue(visible, home)
            if (unsafe !== undefined) block(home, task.targetRoom, unsafe)
        }
        if (atWar(home)) {
            if (task.kind === 'hauler' && creep.room.name === task.homeRoom && creep.store[RESOURCE_ENERGY] > 0) runHaulerTarget(creep, data)
            else goHome(creep, data)
            return false
        }
        if (task.kind === 'scout') {
            if (state.scoutTarget !== task.targetRoom) { retire(creep, data); return false }
            if ((state.intel[task.targetRoom]?.blockedUntil || 0) > Game.time) { goHome(creep, data); return false }
            if (creep.room.name !== task.targetRoom) {
                const code = creep.moveTo(new RoomPosition(25, 25, task.targetRoom), { ...scoutMovementOptions, range: 20, maxRooms: 2 })
                if (code === ERR_NO_PATH) block(home, task.targetRoom, '侦察单位无法进入邻房', 'unreachable')
                return false
            }
            observe(home, creep.room, state)
            return false
        }
        if (!activeTarget(state, task)) {
            if (task.kind === 'hauler' && creep.room.name === task.homeRoom && creep.store[RESOURCE_ENERGY] > 0) runHaulerTarget(creep, data)
            else goHome(creep, data)
            return false
        }
        if (task.kind === 'hauler') {
            if (creep.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) creep.memory.working = true
            else if (creep.store[RESOURCE_ENERGY] <= 0) creep.memory.working = false
        }
        if (task.kind === 'hauler' && creep.memory.working) {
            if (creep.room.name !== task.homeRoom) { goHome(creep, data); return false }
        } else if (creep.room.name !== task.targetRoom) {
            const destination = task.source || { x: 25, y: 25 }
            const code = creep.moveTo(new RoomPosition(destination.x, destination.y, task.targetRoom), { range: 1, maxRooms: 2 })
            if (code === ERR_NO_PATH) block(home, task.targetRoom, '自动外矿单位无路可达', 'unreachable')
            return false
        }
        if (task.source && creep.room.name === task.targetRoom && !Game.getObjectById(task.source.id)) { block(home, task.targetRoom, 'Source 现场信息已失效'); return false }
        if (task.kind === 'hauler') {
            const logistics = data as RemoteFillerData
            if (logistics.withdrawTarget !== undefined && !Game.getObjectById(logistics.withdrawTarget)) delete logistics.withdrawTarget
        }
        if (task.kind === 'harvester') return prepareMiner(creep, data)
        creep.memory.ready = true
        return true
    } }
}
