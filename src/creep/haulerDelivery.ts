import { haulerDeliveryPolicy as policy } from 'settings/haulerDelivery'
import { continueCachedHaulerRoute, haulerEnergyPickupHandled, pickupAdjacentHaulerEnergy } from './haulerPickup'
import { recordRemoteEnergyDelivery } from './remoteCommissioning'

type Receiver = AnyStoreStructure | Creep
interface RoomDelivery { room: Room; structures: AnyStoreStructure[]; workers?: Creep[] }
let tick = -1, shard = ''
const rooms = new Map<string, RoomDelivery>()
const committed = new Map<string, number>()
let activation = new WeakMap<Receiver, boolean>()

/** Haulers have no fixed work tile; every action, including idle and mineral work, must yield. */
export function withHaulerTraffic(behavior: ICreepConfig): ICreepConfig {
    const action = (run: (creep: Creep) => boolean, phase: 'prepare' | 'source' | 'target') => function (this: ICreepConfig, creep: Creep): boolean {
        creep.memory.dontPullMe = false
        try {
            if (phase !== 'prepare') {
                const source = phase === 'source'
                const delivering = !source && creep.memory.working && creep.memory.developmentHauler?.phase !== 'load'
                if (haulerEnergyPickupHandled(creep) || (source || delivering) && pickupAdjacentHaulerEnergy(creep, source)) {
                    continueCachedHaulerRoute(creep, source)
                    return true
                }
            }
            const result = run.call(this, creep)
            if (phase === 'source' && !result && !creep.memory.working) pickupAdjacentHaulerEnergy(creep)
            return result
        }
        finally { creep.memory.dontPullMe = false }
    }
    return { ...behavior, prepare: action(behavior.prepare, 'prepare'), source: action(behavior.source, 'source'), target: action(behavior.target, 'target') }
}

function sync(): void {
    if (tick === Game.time && shard === Game.shard.name) return
    tick = Game.time; shard = Game.shard.name; rooms.clear(); committed.clear()
    activation = new WeakMap()
}

function range(first: RoomPosition, second: RoomPosition): number {
    return first.roomName === second.roomName ? Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y)) : Infinity
}

function free(target: Receiver | undefined): number {
    if (!target || 'structureType' in target && target.structureType === STRUCTURE_LINK || (target as OwnedStructure).my === false) return 0
    const capacity = Math.max(0, target.store.getFreeCapacity(RESOURCE_ENERGY) - (committed.get(target.id) || 0))
    if (capacity <= 0) return 0
    // Activation may scan every structure in the room. Share only this tick's result,
    // while capacity and transfer commitments remain live for every carrier.
    if ('isActive' in target) {
        let active = activation.get(target)
        if (active === undefined) { active = target.isActive(); activation.set(target, active) }
        if (!active) return 0
    }
    return capacity
}

function inventory(room: Room): RoomDelivery {
    const old = rooms.get(room.name)
    if (old?.room === room) return old
    const entry: RoomDelivery = { room, structures: [
        ...room.spawns, ...room.extensions, ...(room.towers || []), ...(room.labs || []),
        ...(room.nuker ? [room.nuker] : []), ...(room.powerSpawn ? [room.powerSpawn] : []),
    ] }
    rooms.set(room.name, entry)
    return entry
}

function closest(creep: Creep, candidates: Receiver[], adjacent = false): Receiver | undefined {
    let selected: Receiver | undefined, nearest = Infinity
    for (const target of candidates) {
        const capacity = free(target)
        if (capacity <= 0 || adjacent && capacity < policy.minimumWaypointEnergy) continue
        const distance = range(creep.pos, target.pos)
        if (adjacent && distance > policy.deliveryRange) continue
        if (distance < nearest) { selected = target; nearest = distance }
    }
    return selected
}

/** All returned receivers exclude Link, including stale job/cache assignments. */
function receiver(creep: Creep, room: Room): Receiver | undefined {
    const storage = room.storage
    if (free(storage) > 0) {
        if (range(creep.pos, storage!.pos) <= policy.deliveryRange) return storage
        const waypoint = policy.fillAdjacentOnStorageRoute && closest(creep, inventory(room).structures, true)
        return waypoint || storage
    }
    const entry = inventory(room)
    const production = closest(creep, entry.structures)
    if (production) return production
    // A full Storage can spill into Terminal instead of pulling import fleets into the controller area.
    if (storage && free(room.terminal) > 0) return room.terminal
    if (room.controller) {
        const containers = (room.containers || []).filter(target => range(target.pos, room.controller!.pos) <= policy.controllerRange)
        const buffer = closest(creep, containers)
        if (buffer) return buffer
    }
    if (entry.workers === undefined) entry.workers = room.find(FIND_MY_CREEPS).filter(worker =>
        !worker.spawning && worker.room.name === room.name && ['upgrader', 'builder', 'rBuilder'].includes(worker.memory.role))
    return closest(creep, entry.workers)
}

/** One transfer intent; adjacent waypoints and remaining cargo continue toward Storage in the same tick. */
export function deliverHaulerEnergy(creep: Creep, room: Room = creep.room): boolean {
    sync()
    creep.memory.dontPullMe = false
    if (creep.room.name !== room.name || creep.store[RESOURCE_ENERGY] <= 0) return false
    const target = receiver(creep, room)
    if (!target) return false
    const amount = Math.min(creep.store[RESOURCE_ENERGY], free(target))
    if (amount <= 0) return false
    const result = creep.transfer(target, RESOURCE_ENERGY, amount)
    if (result === ERR_NOT_IN_RANGE) creep.moveTo(target, { range: policy.deliveryRange })
    else if (result === OK) {
        committed.set(target.id, (committed.get(target.id) || 0) + amount)
        recordRemoteEnergyDelivery(creep, amount)
        const storage = room.storage
        if (storage && storage.id !== target.id && free(storage) > 0 && creep.store[RESOURCE_ENERGY] > amount &&
            range(creep.pos, storage.pos) > policy.deliveryRange) creep.moveTo(storage, { range: policy.deliveryRange })
    }
    // The legacy moveTo wrapper locks stationary creeps after repeated calls;
    // delivery carriers must remain yieldable even while waiting at a depot.
    creep.memory.dontPullMe = false
    return true
}
