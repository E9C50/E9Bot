import { developmentPolicy } from 'settings/development'
import { haulerDeliveryPolicy } from 'settings/haulerDelivery'

export interface DevelopmentHaulerState {
    shard: string
    roomName: string
    mineId?: string
    phase: 'load' | 'deliver'
    energy: number
    lastGainTick: number
}

type EnergyBatch = { target: Resource | AnyStoreStructure; pickup: boolean; amount: number; distance: number }
let reservationTick = -1, reservationShard = ''
const reserved = new Map<string, number>()

function reservations(): Map<string, number> {
    if (reservationTick !== Game.time || reservationShard !== Game.shard.name) {
        reservationTick = Game.time; reservationShard = Game.shard.name; reserved.clear()
    }
    return reserved
}

/** Recover the immutable mine even for live units whose old fallback rewrote sourceId. */
function assignedMine(creep: Creep, data: FillerData): Source | undefined {
    const planned = creep.room.memory.creepConfig?.[creep.name]
    let explicitMine = false
    if (planned?.role === 'filler' && planned.development) {
        const binding = planned.data as FillerData
        if (binding.mineId) { data.mineId = binding.mineId; data.sourceId = binding.sourceId; explicitMine = true }
        else if (planned.name?.startsWith(`${creep.room.name}_DEVELOP_FILLER_STORAGE_`)) {
            data.sourceId = binding.sourceId
            delete data.mineId
            return undefined
        }
    }
    // Surviving small bodies may outlive a removed population demand after an RCL
    // transition. Their original demand name still identifies the assigned mine.
    const prefix = `${creep.room.name}_DEVELOP_FILLER_`, name = creep.memory.name || planned?.name
    if (!explicitMine && name?.startsWith(prefix)) {
        const id = name.slice(prefix.length, name.lastIndexOf('_'))
        if (creep.room.sources.some(source => source.id === id)) data.mineId = id
    }
    if (data.mineId) return creep.room.sources.find(source => source.id === data.mineId)
    const target = data.sourceId ? Game.getObjectById<Source | AnyStoreStructure>(data.sourceId) : null
    const mineEndpoint = target != undefined && (!('store' in target) ||
        target.structureType === STRUCTURE_CONTAINER || target.structureType === STRUCTURE_LINK)
    const mine = !mineEndpoint ? undefined : creep.room.sources.find(source => source.id === target.id ||
        source.pos.inRangeTo(target.pos, developmentPolicy.hauling.mineResourceRange))
    if (mine) data.mineId = mine.id
    return mine
}

function distance(creep: Creep, target: RoomObject): number { return creep.pos.getRangeTo(target.pos) }

function energyBatch(creep: Creep, data: FillerData, mine: Source | undefined, excludedId?: string): EnergyBatch | undefined {
    const free = creep.store.getFreeCapacity(RESOURCE_ENERGY), ledger = reservations()
    let best: EnergyBatch | undefined
    const consider = (target: Resource | AnyStoreStructure, pickup: boolean): void => {
        if (target.id === excludedId || target.pos.roomName !== creep.room.name || mine &&
            !target.pos.inRangeTo(mine.pos, developmentPolicy.hauling.mineResourceRange)) return
        // Distribution must not withdraw the controller's own supply and deliver it back.
        if (!mine && !pickup && creep.room.controller &&
            ((target as AnyStoreStructure).structureType === STRUCTURE_CONTAINER || (target as AnyStoreStructure).structureType === STRUCTURE_LINK) &&
            target.pos.inRangeTo(creep.room.controller.pos, haulerDeliveryPolicy.controllerRange)) return
        const available = (pickup ? (target as Resource).amount : (target as AnyStoreStructure).store[RESOURCE_ENERGY]) - (ledger.get(target.id) || 0)
        const amount = Math.min(free, available)
        if (amount <= 0) return
        const range = distance(creep, target)
        // A few nearby energy units never beat a full batch. At a mine, clear decay-prone
        // overflow first when both targets can supply the same load.
        const preferOverflow = mine !== undefined && best !== undefined && pickup !== best.pickup
        const betterTie = best !== undefined && (preferOverflow ? pickup :
            range < best.distance || range === best.distance && pickup && !best.pickup)
        if (best === undefined || amount > best.amount || amount === best.amount && betterTie) {
            best = { target, pickup, amount, distance: range }
        }
    }
    if (!mine && creep.room.storage) {
        consider(creep.room.storage, false)
        if (best) return best
    }
    for (const drop of creep.room.droppedResource) if (drop.resourceType === RESOURCE_ENERGY) consider(drop, true)
    if (mine) {
        for (const container of creep.room.containers) consider(container, false)
        for (const link of creep.room.links) consider(link, false)
    } else {
        const configured = data.sourceId ? Game.getObjectById<AnyStoreStructure | Source>(data.sourceId) : null
        if (configured != undefined && 'store' in configured) consider(configured, false)
        // Explicit store carriers keep their lane while stock exists. Unbound or dry
        // store carriers may recover without replacing their persistent assignment.
        if (best === undefined || best.amount < free) {
            for (const container of creep.room.containers) consider(container, false)
            for (const link of creep.room.links) consider(link, false)
            if (creep.room.storage) consider(creep.room.storage, false)
            if (creep.room.terminal) consider(creep.room.terminal, false)
        }
    }
    return best
}

/** Returns true while collecting; delivery callers use memory.working after this call. */
export function loadDevelopmentHauler(creep: Creep, data: FillerData, excludedId?: string): boolean {
    const policy = developmentPolicy.hauling, mine = assignedMine(creep, data)
    const energy = creep.store[RESOURCE_ENERGY], capacity = creep.store.getCapacity(RESOURCE_ENERGY) || 0
    let state = creep.memory.developmentHauler
    if (state === undefined || state.shard !== Game.shard.name || state.roomName !== creep.room.name ||
        state.mineId !== mine?.id || state.lastGainTick > Game.time) {
        state = { shard: Game.shard.name, roomName: creep.room.name, mineId: mine?.id,
            phase: mine ? 'load' : energy > 0 ? 'deliver' : 'load', energy, lastGainTick: Game.time }
        creep.memory.developmentHauler = state
    }
    if (energy === 0) {
        state.phase = 'load'
        state.lastGainTick = Game.time
    } else if (energy > state.energy) state.lastGainTick = Game.time
    state.energy = energy
    if (state.phase === 'load' && (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0 ||
        capacity > 0 && energy >= capacity * policy.minimumLoadRatio)) state.phase = 'deliver'
    if (state.phase === 'deliver') { creep.memory.working = true; return false }

    const batch = energyBatch(creep, data, mine, excludedId)
    const atMine = mine !== undefined && creep.pos.inRangeTo(mine.pos, policy.waitingRange)
    const urgent = energy >= policy.emergencyLoadEnergy && creep.room.energyAvailable < developmentPolicy.logistics.emergencySpawnEnergy &&
        creep.room.spawns.some(spawn => creep.pos.isNearTo(spawn))
    if (energy > 0 && (urgent || !mine && batch === undefined ||
        batch === undefined && atMine && Game.time - state.lastGainTick >= policy.partialLoadIdleTicks)) {
        state.phase = 'deliver'; creep.memory.working = true; return false
    }
    creep.memory.working = false
    if (batch !== undefined) {
        const result = batch.pickup ? creep.pickup(batch.target as Resource) :
            creep.withdraw(batch.target as AnyStoreStructure, RESOURCE_ENERGY, batch.amount)
        if (result === ERR_NOT_IN_RANGE) creep.moveTo(batch.target, { range: 1 })
        else if (result === OK) {
            const ledger = reservations()
            ledger.set(batch.target.id, (ledger.get(batch.target.id) || 0) + batch.amount)
        }
        return true
    }
    if (mine && !atMine) creep.moveTo(mine, { range: policy.waitingRange })
    return false
}
