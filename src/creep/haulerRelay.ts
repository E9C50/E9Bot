import { isDevelopingRoom } from './development'
import { isDevelopmentRemoteData, canRelayDevelopmentHauler } from './developmentRemotes'
import { haulerRelayPolicy as policy } from 'settings/haulerRelay'
import { runtimePolicy } from 'settings/runtime'
import type { CachedMovementPath, CachedMovementStep } from 'utils/cachedMovement'
import { blockHaulerEnergyPickup } from './haulerPickup'
import { isRoomEvacuating } from 'room/evacuationState'

interface Lane {
    key: string
    home: Room
    source: { x: number; y: number; roomName: string }
    local: boolean
}
interface Carrier { creep: Creep; lane: Lane; cache: CachedMovementPath; next: CachedMovementStep }
interface RelaySample { tick: number; candidates: number; checks: number; pairs: number; energy: number }
let shard = '', tick = -1
let current: RelaySample = { tick: -1, candidates: 0, checks: 0, pairs: 0, energy: 0 }
const history: RelaySample[] = []
const handled = new Set<string>()
const range = (first: { x: number; y: number; roomName: string }, second: typeof first): number =>
    first.roomName === second.roomName ? Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y)) : Infinity
const key = (position: { x: number; y: number; roomName: string }): string => `${position.roomName}/${position.x}/${position.y}`

function reset(): void {
    if (tick === Game.time && shard === Game.shard.name) return
    if (shard !== Game.shard.name || Game.time < tick) history.length = 0
    else if (tick >= 0) history.push(current)
    while (history.length && history[0].tick <= Game.time - policy.statisticsWindow) history.shift()
    tick = Game.time; shard = Game.shard.name; handled.clear()
    current = { tick, candidates: 0, checks: 0, pairs: 0, energy: 0 }
}

function atWar(home: Room): boolean {
    const wars = Memory.warMode || {}
    return runtimePolicy.warModeScope === 'empire' ? Object.values(wars).some(Boolean) : !!wars[home.name]
}

/** Relay only established energy lanes; portals, mixed cargo and retreating missions keep their own protocols. */
function laneFor(creep: Creep): Lane | undefined {
    const home = Game.rooms[creep.memory.spawnRoom]
    if (isRoomEvacuating(creep.room) || isRoomEvacuating(creep.memory.spawnRoom)) return undefined
    if (!isDevelopingRoom(home) || home!.enemies?.length || atWar(home!)) return undefined
    const data = creep.memory.data
    if (creep.memory.role === 'rFiller' && isDevelopmentRemoteData(data)) {
        const task = data.developmentRemote
        if (!task.source || !canRelayDevelopmentHauler(creep, data)) return undefined
        return { key: `${home!.name}/remote/${task.source.id}`, home: home!, local: false,
            source: { x: task.source.x, y: task.source.y, roomName: task.targetRoom } }
    }
    if (creep.memory.role !== 'filler' || creep.room.name !== home!.name) return undefined
    const config = home!.memory.creepConfig?.[creep.name]
    const binding = (config?.role === 'filler' ? config.data : data) as FillerData
    let id = binding.mineId || (data as FillerData).mineId || creep.memory.developmentHauler?.mineId
    if (!id) {
        const name = creep.memory.name, prefix = `${home!.name}_DEVELOP_FILLER_`
        if (name?.startsWith(prefix) && !name.startsWith(`${prefix}STORAGE_`)) id = name.slice(prefix.length, name.lastIndexOf('_'))
    }
    let source = home!.sources.find(source => source.id === (id || binding.sourceId))
    if (!source && !id && binding.sourceId) {
        const endpoint = Game.getObjectById<StructureContainer | StructureLink>(binding.sourceId)
        if (endpoint && [STRUCTURE_CONTAINER, STRUCTURE_LINK].includes(endpoint.structureType)) {
            source = home!.sources.find(source => source.pos.isNearTo(endpoint))
        }
    }
    if (!source) return undefined
    return { key: `${home!.name}/local/${source.id}`, home: home!, local: true, source: source.pos }
}

function homeEndpoint(home: Room, position: Lane['source'], workers: Map<string, RoomPosition[]>): boolean {
    if (position.roomName !== home.name) return false
    // A route retained from the old policy must not carry a relayed load to a Link.
    if (home.links.some(link => range(position, link.pos) === 0)) return false
    // Opportunistic refills happen only beside a carrier's current tile. They do
    // not justify retaining an old trip toward a distant controller or building.
    if (home.storage) return home.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && range(position, home.storage.pos) === 0
    return [home.terminal, ...home.spawns, ...home.extensions, ...home.towers, ...home.labs,
        ...home.containers.filter(container => range(container.pos, home.controller!.pos) <= 3)]
        .some(target => target && range(position, target.pos) <= 1) ||
        (workers.get(home.name) || []).some(target => range(position, target) <= 1)
}

function setPhase(carrier: Carrier, phase: 'load' | 'deliver'): void {
    const creep = carrier.creep
    creep.memory.working = phase === 'deliver'
    creep.memory.dontPullMe = false
    if (carrier.lane.local) {
        const id = carrier.lane.key.slice(carrier.lane.key.lastIndexOf('/') + 1)
        creep.memory.developmentHauler = { shard: Game.shard.name, roomName: carrier.lane.home.name, mineId: id,
            phase, energy: phase === 'deliver' ? 0 : creep.store[RESOURCE_ENERGY], lastGainTick: Game.time }
    } else delete (creep.memory.data as RemoteFillerData).withdrawTarget
}

/** Harabi-style whole-load handoff with shared cached routes, without new path searches or identity swaps. */
export function runHaulerRelays(): void {
    reset()
    const movement = global.BetterMove
    if (!policy.enabled || !movement?.getNextCachedStep || !movement.creepPathCache || Game.cpu.bucket < policy.minimumBucket ||
        Game.cpu.tickLimit - Game.cpu.getUsed() < policy.minimumCpuHeadroom ||
        !Object.values(Game.rooms).some(isDevelopingRoom)) return
    const started = Game.cpu.getUsed()
    const donors: Carrier[] = [], fetchers = new Map<string, Carrier>()
    const workers = new Map<string, RoomPosition[]>()
    for (const name in Game.creeps) {
        if (Game.cpu.getUsed() - started >= policy.maximumCpu || Game.cpu.tickLimit - Game.cpu.getUsed() < policy.minimumCpuHeadroom) break
        const creep = Game.creeps[name]
        if (isRoomEvacuating(creep.room) || isRoomEvacuating(creep.memory.spawnRoom)) continue
        const role = creep.memory.role
        if (!creep.spawning && (role === 'upgrader' || role === 'builder' || role === 'rBuilder' || role === 'sBuilder') &&
            isDevelopingRoom(creep.room) && !creep.room.storage && range(creep.pos, creep.room.controller!.pos) <= 3 &&
            creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            let targets = workers.get(creep.room.name)
            if (!targets) { targets = []; workers.set(creep.room.name, targets) }
            targets.push(creep.pos)
        }
        if ((creep.memory.role !== 'filler' && creep.memory.role !== 'rFiller') || creep.spawning || creep.fatigue > 0 || creep.memory.isTeam || creep.memory.combatTaskId ||
            (creep.ticksToLive ?? 0) <= policy.minimumTicksToLive || creep.store.getUsedCapacity() !== creep.store[RESOURCE_ENERGY] ||
            (creep.memory.boostPlan?.steps.length && !creep.memory.boostPlan.completed && !creep.memory.boostPlan.failed)) continue
        const lane = laneFor(creep), cache = movement.creepPathCache[name]
        if (!lane || !cache?.path || !cache.dst || range(creep.pos, lane.source) <= policy.endpointRange) continue
        const next = movement.getNextCachedStep(creep)
        if (!next || next.roomName !== creep.room.name) continue
        const carrier = { creep, lane, cache, next }
        const energy = creep.store[RESOURCE_ENERGY]
        if (energy > 0 && (creep.memory.working || creep.memory.developmentHauler?.phase === 'deliver' || creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) &&
            range(creep.pos, cache.dst) > policy.endpointRange) donors.push(carrier)
        else if (energy === 0 && range(cache.dst, lane.source) <= policy.sourceGoalRange && creep.fatigue === 0) fetchers.set(key(creep.pos), carrier)
        else continue
        current.candidates++
    }
    for (const donor of donors) {
        if (current.pairs >= policy.maximumPairsPerTick || Game.cpu.getUsed() - started >= policy.maximumCpu ||
            Game.cpu.tickLimit - Game.cpu.getUsed() < policy.minimumCpuHeadroom) break
        if (handled.has(donor.creep.name) || !homeEndpoint(donor.lane.home, donor.cache.dst, workers)) continue
        current.checks++
        const receiver = fetchers.get(key(donor.next))
        if (!receiver || handled.has(receiver.creep.name) || receiver.lane.key !== donor.lane.key ||
            key(receiver.next) !== key(donor.creep.pos)) continue
        const donorStep = donor.cache.path!.posArray[donor.next.index], receiverStep = receiver.cache.path!.posArray[receiver.next.index]
        if (!donorStep || !receiverStep || range(donorStep, receiver.creep.pos) !== 0 || range(receiverStep, donor.creep.pos) !== 0) continue
        const amount = donor.creep.store[RESOURCE_ENERGY]
        if (amount <= 0 || receiver.creep.store.getFreeCapacity(RESOURCE_ENERGY) < amount) continue
        if (donor.creep.transfer(receiver.creep, RESOURCE_ENERGY, amount) !== OK) continue
        blockHaulerEnergyPickup(donor.creep); blockHaulerEnergyPickup(receiver.creep)
        handled.add(donor.creep.name); handled.add(receiver.creep.name)
        setPhase(donor, 'load'); setPhase(receiver, 'deliver')
        // Each new route already contains this unit's current tile as the opposing next step.
        donor.cache.idx = donor.next.index; receiver.cache.idx = receiver.next.index
        movement.creepPathCache[donor.creep.name] = receiver.cache
        movement.creepPathCache[receiver.creep.name] = donor.cache
        donor.creep.moveTo(new RoomPosition(receiver.cache.dst.x, receiver.cache.dst.y, receiver.cache.dst.roomName),
            { range: 1, ignoreDestructibleStructures: !!receiver.cache.path!.ignoreStructures })
        receiver.creep.moveTo(new RoomPosition(donor.cache.dst.x, donor.cache.dst.y, donor.cache.dst.roomName),
            { range: 1, ignoreDestructibleStructures: !!donor.cache.path!.ignoreStructures })
        current.pairs++; current.energy += amount
    }
}

export function haulerRelayHandled(creep: Creep): boolean {
    return tick === Game.time && shard === Game.shard.name && handled.has(creep.name)
}

/** Bounded RAM-only diagnostics; no creep/store state is changed by reading it. */
export function getHaulerRelayStatus(): object {
    reset()
    return { enabled: policy.enabled, current: { ...current }, windowSize: policy.statisticsWindow,
        rolling: [...history, current].reduce((total, sample) => ({ ticks: total.ticks + 1, candidates: total.candidates + sample.candidates,
            checks: total.checks + sample.checks, pairs: total.pairs + sample.pairs, energy: total.energy + sample.energy }),
        { ticks: 0, candidates: 0, checks: 0, pairs: 0, energy: 0 }) }
}
