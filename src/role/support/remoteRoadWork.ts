import { getRemoteRoadFallback, getRemoteRoadWork, hasRemoteRoadRoom, isRemoteRoadRoomSafe } from 'creep/remoteRoads'
import type { RemoteRoadWork } from 'creep/remoteRoads'
import { isRoomEvacuating } from 'room/evacuationState'
import { runtimePolicy } from 'settings/runtime'
import { acquireBuilderEnergy, updateBuilderEnergyPhase } from './builderEnergy'

interface RoadContext { home: Room; work: RemoteRoadWork }
let checkedTick = -1, checkedShard = ''
let contexts = new WeakMap<Creep, RoadContext | undefined>()

function goHome(creep: Creep, home: Room | undefined): void {
    creep.memory.dontPullMe = false
    if (!home || creep.room.name === home.name) return
    const destination = home.storage || home.spawns[0]
    creep.moveTo(destination || new RoomPosition(25, 25, home.name), { range: destination ? 3 : 20, reusePath: 20 })
}

/** The shared planner owns admission, safety and targets; a worker never replans its road. */
function context(creep: Creep, data: RemoteBuilderData): RoadContext | undefined {
    if (checkedTick !== Game.time || checkedShard !== Game.shard.name) {
        checkedTick = Game.time; checkedShard = Game.shard.name; contexts = new WeakMap()
    }
    if (contexts.has(creep)) return contexts.get(creep)
    contexts.set(creep, undefined)
    creep.memory.dontPullMe = false
    const home = data.roadHome ? Game.rooms[data.roadHome] : undefined
    if (!home?.my) return
    const atWar = runtimePolicy.warModeScope === 'empire' ? Object.values(Memory.warMode || {}).some(Boolean) :
        Memory.warMode?.[home.name] || Memory.warMode?.[creep.room.name]
    if (atWar || isRoomEvacuating(home) || !hasRemoteRoadRoom(home, creep.room.name) || !isRemoteRoadRoomSafe(creep.room, home)) {
        goHome(creep, home); return
    }
    const work = getRemoteRoadWork(home, undefined, data.buildTarget)
    if (!work) { goHome(creep, home); return }
    const value = { home, work }
    contexts.set(creep, value)
    return value
}

export function prepareRemoteRoadWork(creep: Creep, data: RemoteBuilderData): boolean {
    const previous = data.roadBuildTarget
    if (previous && !Game.getObjectById(previous.id)) {
        const room = Game.rooms[previous.roomName]
        if (room) room.memory.needUpdateCache = true
        delete data.roadBuildTarget
    }
    return !creep.spawning && context(creep, data) !== undefined
}

export function sourceRemoteRoadWork(creep: Creep, data: RemoteBuilderData): boolean {
    const active = context(creep, data)
    if (!active) return true
    updateBuilderEnergyPhase(creep)
    if (creep.memory.working) return false
    // Containers and dropped mining energy precede direct harvesting, without a flag-distance restriction.
    if (acquireBuilderEnergy(creep)) return true
    if (creep.store[RESOURCE_ENERGY] > 0) { creep.memory.working = true; return false }
    if (creep.room.name !== active.work.roomName) {
        creep.moveTo(new RoomPosition(active.work.x, active.work.y, active.work.roomName), { range: 3, reusePath: 20 })
        return true
    }
    // A transit room can have no Source at all; load at an admitted visible mine instead of waiting forever.
    const source = getRemoteRoadFallback(active.home)
    if (source && source.roomName !== creep.room.name) {
        creep.moveTo(new RoomPosition(source.x, source.y, source.roomName), { range: 1, reusePath: 20 })
        return true
    }
    return false
}

export function targetRemoteRoadWork(creep: Creep, data: RemoteBuilderData): boolean {
    const active = context(creep, data)
    if (!active) return true
    if (!(creep.store[RESOURCE_ENERGY] > 0)) { creep.memory.working = false; return false }
    const target = Game.getObjectById<ConstructionSite | StructureRoad>(active.work.id)
    if (!target) { delete data.buildTarget; return false }
    data.buildTarget = target.id
    const result = active.work.kind === 'build' ? creep.build(target as ConstructionSite) : creep.repair(target as StructureRoad)
    if (result === ERR_NOT_IN_RANGE) creep.moveTo(target, { range: 3, reusePath: 20 })
    // Incremental building must not invalidate all hauler paths; refresh only after the site actually disappears.
    else if (result === OK && active.work.kind === 'build') {
        data.roadBuildTarget = { id: target.id, roomName: target.pos.roomName }
    }
    return true
}
