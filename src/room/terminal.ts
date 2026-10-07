import { resourcePolicy } from 'settings/resourcePolicy'
import { isRoomEvacuating } from './evacuationState'
import { getEvacuationIncomingCapacity, reserveEvacuationIncoming } from './evacuation'
import {
    getAvailableResource, getResourceKeep, getRoomResourceAmount, getTerminalResourceAmount,
    planResourceDistribution, recordResourceSend, ResourceJob, terminalUsed, updateResourceJob,
} from './resourceNetwork'

/** Native transaction cost, including an active operate-terminal fee reduction. */
export function resourceTransactionCost(room: Room, target: string, amount: number): number {
    let cost = Game.market.calcTransactionCost(amount, room.name, target)
    if (typeof PWR_OPERATE_TERMINAL !== 'undefined' && typeof POWER_INFO !== 'undefined') {
        const effect = room.terminal?.effects?.find(item => item.effect === PWR_OPERATE_TERMINAL && item.ticksRemaining > 0)
        if (effect && 'level' in effect) cost = Math.ceil(cost * POWER_INFO[PWR_OPERATE_TERMINAL].effect[effect.level - 1])
    }
    return cost
}

/** Find the largest affordable integer shipment while preserving 50k terminal energy. */
export function affordableSendAmount(room: Room, resource: ResourceConstant, target: string, maximum: number, energy: number): number {
    let low = 0, high = Math.max(0, Math.floor(maximum))
    const budget = Math.max(0, energy - resourcePolicy.terminalEnergyReserve)
    while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        const cost = resourceTransactionCost(room, target, middle) + (resource === 'energy' ? middle : 0)
        if (cost <= budget) low = middle
        else high = middle - 1
    }
    return low
}
function priority(job: ResourceJob): number {
    if (!job.kind) return 0
    return ({ production: 1, refill: 2, energy: 3, surplus: 4, balance: 5 })[job.kind]
}
function limitJob(room: Room, job: ResourceJob): number {
    return Math.min(job.amount, getAvailableResource(room, job.resourceType) + job.amount,
        Math.max(0, getRoomResourceAmount(room, job.resourceType) - getResourceKeep(room, job.resourceType)))
}
function readyBatch(room: Room, job: ResourceJob, target?: Room): number {
    const terminal = room.terminal!
    const capacity = terminal.store.getCapacity() || 300000
    let maximum = Math.min(limitJob(room, job), resourcePolicy.maximumSendAmount)
    if (target?.terminal) maximum = Math.min(maximum, getEvacuationIncomingCapacity(target))
    let low = 0, high = Math.max(0, Math.floor(maximum))
    const roomEnergy = (room.storage?.store.energy || 0) + getTerminalResourceAmount(room, 'energy')
    while (low < high) {
        const middle = Math.ceil((low + high) / 2), fee = resourceTransactionCost(room, job.targetRoom, middle)
        const energy = resourcePolicy.terminalEnergyReserve + fee + (job.resourceType === 'energy' ? middle : 0)
        const used = energy + (job.resourceType === 'energy' ? 0 : middle) + resourcePolicy.terminalFreeReserve
        if (used <= capacity && energy <= roomEnergy) low = middle
        else high = middle - 1
    }
    return low
}

/** Only stage the next useful shipment; queued stock must never fill the whole terminal. */
export function refreshTerminalDemand(room: Room): void {
    room.memory.terminalAmount = { energy: resourcePolicy.terminalEnergyReserve }
    const jobs = Object.entries(room.memory.terminalSendJob || {})
        .filter(([, job]) => job.amount > 0 && !isRoomEvacuating(job.targetRoom) && (job.retryAfter || 0) <= Game.time)
        .sort((a, b) => priority(a[1]) - priority(b[1]) ||
            (a[1].createdAt || 0) - (b[1].createdAt || 0) || b[1].amount - a[1].amount)
    for (const [, job] of jobs) {
        const target = Game.rooms[job.targetRoom]
        if (target && (!target.terminal || target.terminal.my === false)) continue
        const amount = readyBatch(room, job, target)
        if (amount <= 0) continue
        if (amount < resourcePolicy.minimumSendAmount && job.amount > resourcePolicy.minimumSendAmount) continue
        room.memory.terminalAmount.energy += resourceTransactionCost(room, job.targetRoom, amount)
        room.memory.terminalAmount[job.resourceType] = (room.memory.terminalAmount[job.resourceType] || 0) + amount
        break
    }
}

export function processTerminalResource(room: Room): void {
    const terminal = room.terminal
    if (!terminal || isRoomEvacuating(room)) return
    planResourceDistribution()
    refreshTerminalDemand(room)
    if (terminal.cooldown > 0 || terminalUsed(room)) return
    const jobs = Object.entries(room.memory.terminalSendJob || {})
        .sort((a, b) => priority(a[1]) - priority(b[1]) ||
            (a[1].createdAt || 0) - (b[1].createdAt || 0) || b[1].amount - a[1].amount)
    for (const [id, job] of jobs) {
        if (isRoomEvacuating(job.targetRoom) || (job.retryAfter || 0) > Game.time) continue
        const target = Game.rooms[job.targetRoom]
        if (target && (!target.terminal || target.terminal.my === false)) continue
        const amount = readyBatch(room, job, target)
        if (amount <= 0 || amount < resourcePolicy.minimumSendAmount && job.amount > resourcePolicy.minimumSendAmount) continue
        if (getTerminalResourceAmount(room, job.resourceType) < amount) continue
        if (affordableSendAmount(room, job.resourceType, job.targetRoom, amount, getTerminalResourceAmount(room, 'energy')) < amount) continue
        const result = terminal.send(job.resourceType, amount, job.targetRoom)
        if (result !== OK) {
            job.failures = (job.failures || 0) + 1
            job.lastError = result
            job.retryAfter = Game.time + Math.min(1000, 30 * Math.pow(2, Math.min(job.failures - 1, 5)))
            continue
        }
        const fee = resourceTransactionCost(room, job.targetRoom, amount)
        const remainder = job.amount - amount
        updateResourceJob(room, id, remainder > 0 ? { ...job, amount: remainder, failures: 0, retryAfter: 0 } : undefined)
        recordResourceSend(room, job.targetRoom, job.resourceType, amount, fee)
        if (target?.terminal) reserveEvacuationIncoming(target, amount)
        refreshTerminalDemand(room)
        break
    }
    refreshTerminalDemand(room)
}
