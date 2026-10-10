import { previewBodySelection } from './bodySelection'
import { controllerLayoutPolicy } from 'settings/controllerLayout'
import { resourcePolicy } from 'settings/resourcePolicy'
import { sourceLinkWithCenter } from 'room/sourceLinks'
import { isSpawnEnergyCarrier } from './spawnEnergyCarrier'
import { developmentPolicy } from 'settings/development'
import { haulerEnergyPickupReserved, reserveHaulerEnergyPickup } from './haulerPickup'
import { committedTerminalEnergy, recordTerminalEnergyWithdrawal } from './terminalEnergyWithdrawal'

interface RecoveryCargo { targetEnergy: number }
interface TerminalDebt { restoreEnergy: number }
declare global {
    interface CreepMemory {
        productionRecoveryCargo?: RecoveryCargo
        productionRecoverySpawn?: { roomName: string; tick: number }
        productionRecoveryLoad?: { energy: number; lastGainTick: number }
    }
    interface RoomMemory { productionRecoveryTerminalDebt?: TerminalDebt }
}

/** Collect only arrived mining output during handover, including a different mine. */
function loadTemporaryProduction(creep: Creep): boolean {
    const room = creep.room, energy = creep.store[RESOURCE_ENERGY], free = creep.store.getFreeCapacity(RESOURCE_ENERGY)
    let load = creep.memory.productionRecoveryLoad
    if (!load || load.lastGainTick > Game.time) load = creep.memory.productionRecoveryLoad = { energy, lastGainTick: Game.time }
    if (energy === 0 || energy > load.energy) load.lastGainTick = Game.time
    load.energy = energy
    if (free === 0) return true
    const mines = room.sources.filter(source => Object.values(Game.creeps).some(miner =>
        miner.memory.role === 'harvester' && miner.room.name === room.name &&
        (!miner.memory.spawnRoom || miner.memory.spawnRoom === room.name) &&
        (miner.memory.data as HarvesterData).sourceId === source.id && miner.getActiveBodyparts(WORK) > 0))
    let target: Resource | StructureContainer | StructureLink | undefined, pickup = false, amount = 0, nearest = Infinity
    const consider = (candidate: Resource | StructureContainer | StructureLink, dropped: boolean): void => {
        if (!mines.some(source => source.pos.inRangeTo(candidate, developmentPolicy.hauling.mineResourceRange)) ||
            !dropped && room.controller && candidate.pos.inRangeTo(room.controller, controllerLayoutPolicy.containerRange)) return
        const stock = dropped ? (candidate as Resource).amount : (candidate as StructureContainer | StructureLink).store[RESOURCE_ENERGY]
        const available = Math.max(0, stock - (dropped ? haulerEnergyPickupReserved(candidate as Resource) : withdrawn.get(candidate.id) || 0))
        if (dropped && Math.min(free, stock) > available) return
        const batch = Math.min(free, available), distance = creep.pos.getRangeTo(candidate)
        if (batch <= 0 || batch < amount || batch === amount && distance >= nearest) return
        target = candidate; pickup = dropped; amount = batch; nearest = distance
    }
    for (const drop of room.droppedResource || []) if (drop.resourceType === RESOURCE_ENERGY) consider(drop, true)
    for (const container of room.containers) consider(container, false)
    for (const link of room.links) consider(link, false)
    if (!target) {
        if (energy > 0 && Game.time - load.lastGainTick >= developmentPolicy.hauling.partialLoadIdleTicks) return true
        const mine = mines.reduce<Source | undefined>((selected, source) => !selected || creep.pos.getRangeTo(source) < creep.pos.getRangeTo(selected) ? source : selected, undefined)
        if (mine && !creep.pos.inRangeTo(mine, developmentPolicy.hauling.waitingRange)) creep.moveTo(mine, { range: developmentPolicy.hauling.waitingRange })
        return false
    }
    const result = pickup ? creep.pickup(target as Resource) : creep.withdraw(target as StructureContainer | StructureLink, RESOURCE_ENERGY, amount)
    if (result === ERR_NOT_IN_RANGE) creep.moveTo(target, { range: 1 })
    else if (result === OK) {
        if (pickup) reserveHaulerEnergyPickup(creep, target as Resource, amount)
        else withdrawn.set(target.id, (withdrawn.get(target.id) || 0) + amount)
    }
    return false
}
type RecoveryMemory = CreepMemory & {
    productionRecoveryCargo?: RecoveryCargo
    productionRecoverySpawn?: { roomName: string; tick: number }
}
type RecoveryRoomMemory = RoomMemory & { productionRecoveryTerminalDebt?: TerminalDebt }

/** Reserve borrowing is restricted to a complete loss of local mining. */
export const fillerProductionRecoveryPolicy = { borrowTerminalReserve: true }

/** The queue and temporary carrier must fund the same complete native miner. */
export function getProductionRecoveryMiner(room: Room): { name: string; cost: number } | undefined {
    let selected: { name: string; cost: number } | undefined
    for (const name in room.memory.creepConfig || {}) {
        const config = room.memory.creepConfig[name]
        if (config.role !== 'harvester' || Game.creeps[name] || config.spawnRoom && config.spawnRoom !== room.name ||
            !room.sources.some(source => source.id === (config.data as HarvesterData).sourceId)) continue
        const { body } = previewBodySelection(room, config, 0)
        if (!body.includes(WORK)) continue
        const cost = body.reduce((total, part) => total + BODYPART_COST[part], 0)
        if (cost > 0 && (selected === undefined || cost < selected.cost)) selected = { name, cost }
    }
    return selected
}

export function getProductionRecoveryDistributor(room: Room): { name: string; cost: number } | undefined {
    if (!room.storage) return undefined
    let selected: { name: string; cost: number } | undefined
    for (const name in room.memory.creepConfig || {}) {
        const config = room.memory.creepConfig[name], data = config.data as FillerData
        if (config.role !== 'filler' || Game.creeps[name] || config.spawnRoom && config.spawnRoom !== room.name ||
            data.sourceId !== room.storage.id || data.mineId) continue
        const { body } = previewBodySelection(room, config, 0)
        if (!body.includes(CARRY) || !body.includes(MOVE)) continue
        const cost = body.reduce((total, part) => total + BODYPART_COST[part], 0)
        if (cost > 0 && (selected === undefined || cost < selected.cost)) selected = { name, cost }
    }
    return selected
}

function hasPermanentDistributor(room: Room): boolean {
    for (const name in Game.creeps) {
        const carrier = Game.creeps[name], data = carrier.memory.data as FillerData
        // A native Storage survivor can take back its own job; a temporary mine
        // carrier still needs a separate permanent Storage distributor to arrive.
        if (carrier.memory.role !== 'filler' ||
            (room.storage ? data?.sourceId !== room.storage.id || data.mineId || carrier.memory.developmentHauler?.mineId :
                (carrier.memory as RecoveryMemory).productionRecoverySpawn !== undefined)) continue
        if (isSpawnEnergyCarrier(room, carrier)) return true
    }
    return false
}

/** A paid travelling/spawning miner already restores production; damaged Link-only bodies do not. */
export function hasProductionRecoveryMiner(room: Room, creeps: { [name: string]: Creep } = Game.creeps): boolean {
    for (const name in creeps) if (usableMiner(room, creeps[name])) return true
    return false
}

function usableMiner(room: Room, creep: Creep): boolean {
    const memory = creep.memory
    if (memory.role !== 'harvester' || memory.spawnRoom && memory.spawnRoom !== room.name ||
        creep.room.name !== room.name || creep.ticksToLive === 0 || creep.getActiveBodyparts(WORK) <= 0) return false
    const source = room.sources.find(source => source.id === (memory.data as HarvesterData).sourceId)
    if (!source || !creep.spawning && creep.getActiveBodyparts(MOVE) <= 0 && !creep.pos.isNearTo(source) ||
        memory.boostPlan?.steps.length && !memory.boostPlan.completed && !memory.boostPlan.failed) return false
    return creep.getActiveBodyparts(CARRY) > 0 || sourceLinkWithCenter(room, source) === undefined
}

let tick = -1, shard = ''
const withdrawn = new Map<string, number>(), delivered = new Map<string, number>()
const productionRooms = new Map<Room, boolean>()
let productionIndexed = false
function sync(): void {
    if (tick === Game.time && shard === Game.shard.name) return
    tick = Game.time; shard = Game.shard.name; withdrawn.clear(); delivered.clear(); productionRooms.clear(); productionIndexed = false
}

function productionForTick(room: Room): boolean {
    if (!productionIndexed) {
        productionIndexed = true
        // One shared pass serves every owned room; unrelated roles never read bodies.
        for (const name in Game.creeps) {
            const miner = Game.creeps[name]
            if (miner.memory.role !== 'harvester' || productionRooms.has(miner.room)) continue
            if (usableMiner(miner.room, miner)) productionRooms.set(miner.room, true)
        }
    }
    return productionRooms.get(room) || false
}

function deliverRecoveryCargo(creep: Creep, targetEnergy: number): boolean {
    const room = creep.room, memory = creep.memory as RecoveryMemory
    const committed = delivered.get(room.name) || 0
    const remaining = Math.max(0, targetEnergy - room.energyAvailable - committed)
    if (remaining <= 0 || creep.store[RESOURCE_ENERGY] <= 0) { delete memory.productionRecoveryCargo; return false }
    let selected: StructureSpawn | StructureExtension | undefined, nearest = Infinity
    for (const target of [...room.spawns, ...room.extensions]) {
        const free = target.store.getFreeCapacity(RESOURCE_ENERGY) - (delivered.get(target.id) || 0)
        const distance = creep.pos.getRangeTo(target)
        if (target.my === false || free <= 0 || distance >= nearest) continue
        selected = target; nearest = distance
    }
    if (!selected) return false
    const amount = Math.min(remaining, creep.store[RESOURCE_ENERGY],
        selected.store.getFreeCapacity(RESOURCE_ENERGY) - (delivered.get(selected.id) || 0))
    const result = creep.transfer(selected, RESOURCE_ENERGY, amount)
    if (result === ERR_NOT_IN_RANGE) creep.moveTo(selected, { range: 1 })
    else if (result === OK) {
        delivered.set(selected.id, (delivered.get(selected.id) || 0) + amount)
        delivered.set(room.name, committed + amount)
    }
    creep.memory.dontPullMe = false
    return true
}

/** Repay just the critical loan even when the room's Manager has not returned yet. */
function repayTerminal(creep: Creep): boolean {
    const memory = creep.room.memory as RecoveryRoomMemory, debt = memory.productionRecoveryTerminalDebt
    const terminal = creep.room.terminal
    if (!debt || !terminal) return false
    if (terminal.store[RESOURCE_ENERGY] >= debt.restoreEnergy) { delete memory.productionRecoveryTerminalDebt; return false }
    const amount = Math.min(creep.store[RESOURCE_ENERGY], debt.restoreEnergy - terminal.store[RESOURCE_ENERGY] -
        (delivered.get(terminal.id) || 0), terminal.store.getFreeCapacity(RESOURCE_ENERGY))
    if (amount <= 0) return false
    const result = creep.transfer(terminal, RESOURCE_ENERGY, amount)
    if (result === ERR_NOT_IN_RANGE) creep.moveTo(terminal, { range: 1 })
    else if (result === OK) delivered.set(terminal.id, (delivered.get(terminal.id) || 0) + amount)
    creep.memory.dontPullMe = false
    return true
}

/** Borrow an existing carrier temporarily; its permanent mine and loading state stay untouched. */
export function runFillerProductionRecovery(creep: Creep): boolean {
    const room = creep.room, memory = creep.memory as RecoveryMemory
    if (memory.role !== 'filler' || room.controller?.my !== true || memory.spawnRoom && memory.spawnRoom !== room.name ||
        creep.spawning || !Number.isFinite(room.energyCapacityAvailable) || room.energyCapacityAvailable <= 0) return false
    // The common healthy/full-pool path never scans the demand catalog or previews bodies.
    if (!memory.productionRecoveryCargo && !memory.productionRecoverySpawn && !(room.memory as RecoveryRoomMemory).productionRecoveryTerminalDebt &&
        room.energyAvailable >= room.energyCapacityAvailable) return false
    sync()
    const production = productionForTick(room)
    const bridge = memory.productionRecoverySpawn?.roomName === room.name
    const permanentDistributor = (bridge || (room.memory as RecoveryRoomMemory).productionRecoveryTerminalDebt !== undefined) && hasPermanentDistributor(room)
    if (production && permanentDistributor) { delete memory.productionRecoverySpawn; delete memory.productionRecoveryLoad }
    else if (bridge) memory.productionRecoverySpawn!.tick = Game.time
    if (memory.productionRecoveryCargo && creep.store[RESOURCE_ENERGY] > 0 &&
        deliverRecoveryCargo(creep, memory.productionRecoveryCargo.targetEnergy)) return true
    delete memory.productionRecoveryCargo
    if (production && permanentDistributor) return repayTerminal(creep)
    if (production) {
        if (!bridge) return false
        // Keep the replacement miner on its workstation until real home distribution
        // arrives. A spawning distributor does not take over this temporary lane yet.
        const target = getProductionRecoveryDistributor(room)?.cost || room.energyCapacityAvailable
        if (room.energyAvailable >= target) return true
        if (loadTemporaryProduction(creep) && creep.store[RESOURCE_ENERGY] > 0) {
            memory.productionRecoveryCargo = { targetEnergy: target }
            return deliverRecoveryCargo(creep, target)
        }
        return true
    }
    if (creep.getActiveBodyparts(CARRY) <= 0 || creep.getActiveBodyparts(MOVE) <= 0) return false
    const miner = getProductionRecoveryMiner(room)
    if (!miner) return false
    if (room.energyAvailable >= miner.cost) return bridge
    if (creep.store[RESOURCE_ENERGY] > 0) {
        memory.productionRecoverySpawn = { roomName: room.name, tick: Game.time }
        memory.productionRecoveryCargo = { targetEnergy: miner.cost }
        return deliverRecoveryCargo(creep, miner.cost)
    }
    let inTransit = 0
    for (const name in Game.creeps) {
        const carrier = Game.creeps[name]
        if (carrier.room.name === room.name && (carrier.memory as RecoveryMemory).productionRecoveryCargo)
            inTransit += carrier.store[RESOURCE_ENERGY]
    }
    const needed = miner.cost - room.energyAvailable - inTransit - (withdrawn.get(room.name) || 0) - (delivered.get(room.name) || 0)
    if (needed <= 0) return bridge
    let stock: StructureStorage | StructureContainer | StructureTerminal | undefined
    const available = (target: StructureStorage | StructureContainer | StructureTerminal): number =>
        Math.max(0, target.store[RESOURCE_ENERGY] -
            (target === room.terminal ? committedTerminalEnergy(target) : withdrawn.get(target.id) || 0))
    if (room.storage && room.storage.my !== false && available(room.storage) > 0) stock = room.storage
    if (!stock) for (const container of room.containers) {
        if (available(container) <= 0 || room.controller &&
            container.pos.inRangeTo(room.controller, controllerLayoutPolicy.containerRange)) continue
        if (!stock || creep.pos.getRangeTo(container) < creep.pos.getRangeTo(stock)) stock = container
    }
    if (!stock && room.terminal?.my !== false && room.terminal &&
        available(room.terminal) > (fillerProductionRecoveryPolicy.borrowTerminalReserve ? 0 : resourcePolicy.terminalEnergyReserve)) stock = room.terminal
    if (!stock) return false
    const reserve = stock === room.terminal && !fillerProductionRecoveryPolicy.borrowTerminalReserve ? resourcePolicy.terminalEnergyReserve : 0
    const stockEnergy = available(stock)
    const amount = Math.min(needed, creep.store.getFreeCapacity(RESOURCE_ENERGY), stockEnergy - reserve)
    if (amount <= 0) return false
    memory.productionRecoverySpawn = { roomName: room.name, tick: Game.time }
    const result = creep.withdraw(stock, RESOURCE_ENERGY, amount)
    if (result === ERR_NOT_IN_RANGE) creep.moveTo(stock, { range: 1 })
    else if (result === OK) {
        memory.productionRecoveryCargo = { targetEnergy: miner.cost }
        withdrawn.set(stock.id, (withdrawn.get(stock.id) || 0) + amount)
        withdrawn.set(room.name, (withdrawn.get(room.name) || 0) + amount)
        if (stock === room.terminal) recordTerminalEnergyWithdrawal(stock, amount)
        if (stock === room.terminal && stockEnergy - amount < resourcePolicy.terminalEnergyReserve) {
            const roomMemory = room.memory as RecoveryRoomMemory
            roomMemory.productionRecoveryTerminalDebt ||= { restoreEnergy: Math.min(resourcePolicy.terminalEnergyReserve, stockEnergy) }
        }
    }
    creep.memory.dontPullMe = false
    return true
}
