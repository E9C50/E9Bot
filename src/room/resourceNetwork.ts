import { basicMinerals, ordinaryRoomResourceKeep, ordinaryResourceTarget, resourcePolicy, t3Resources } from 'settings/resourcePolicy'
import { isRoomEvacuating } from './evacuationState'

type Amounts = Record<string, number>
export type ResourceJob = RoomMemory['terminalSendJob'][string]
interface PlanningInventory {
    available(room: Room, resource: ResourceConstant): number
    projected(room: Room, resource: ResourceConstant): number
    headroom(room: Room): number
}
export interface ResourceInventory {
    roomAmount(room: Room, resource: ResourceConstant): number
    globalAmount(resource: ResourceConstant): number
}
let tick = -1, shard = ''
let rooms: Room[] = []
let roomNames = new Set<string>()
let incoming = new Map<string, Amounts>(), outgoing = new Map<string, Amounts>()
let localCargo = new Map<string, Amounts>()
let sent = new Map<string, Amounts>(), received = new Map<string, Amounts>()
let globalChanges: Amounts = {}
let terminalWithdrawals = new Map<string, Amounts>()
let usedTerminals = new Set<string>()
let planned = false
let reconciled = false

function add(map: Map<string, Amounts>, name: string, resource: string, value: number): void {
    const amounts = map.get(name) || {}
    amounts[resource] = (amounts[resource] || 0) + value
    map.set(name, amounts)
}
function positive(value: number | undefined): number { return Math.max(0, value || 0) }
function eligible(room: Room): boolean {
    return (room.controller?.my === true || room.my === true) && !!room.storage && !!room.terminal &&
        room.terminal.my !== false && (typeof room.terminal.isActive !== 'function' || room.terminal.isActive()) &&
        !isRoomEvacuating(room)
}
function prepare(): void {
    if (tick === Game.time && shard === (Game.shard?.name || '')) return
    tick = Game.time; shard = Game.shard?.name || ''
    rooms = Object.values(Game.rooms).filter(eligible)
    roomNames = new Set(rooms.map(room => room.name))
    incoming = new Map(); outgoing = new Map(); localCargo = new Map()
    sent = new Map(); received = new Map(); usedTerminals = new Set(); planned = false; reconciled = false
    globalChanges = {}
    terminalWithdrawals = new Map()
    for (const room of rooms) {
        room.memory.terminalSendJob ||= {}
        for (const id in room.memory.terminalSendJob) {
            const job = room.memory.terminalSendJob[id]
            if (!Number.isFinite(job.amount) || job.amount <= 0 || job.targetRoom === room.name) {
                delete room.memory.terminalSendJob[id]; continue
            }
            if (isRoomEvacuating(job.targetRoom)) continue
            const resource = job.resourceType
            add(incoming, job.targetRoom, resource, job.amount)
            add(outgoing, room.name, resource, job.amount)
        }
    }
    // Count in-transit local logistics once; their cargo must not look like new shortages every tick.
    for (const name in Game.creeps || {}) {
        const creep = Game.creeps[name]
        if (!['manager', 'processer'].includes(creep.memory?.role) || !creep.room) continue
        for (const resource in creep.store) if (typeof creep.store[resource] === 'number')
            add(localCargo, creep.room.name, resource, creep.store[resource])
    }
}

export function getResourceRooms(): readonly Room[] { prepare(); return rooms }
export function isWarehouseRoom(room: Room): boolean {
    return room.controller?.isPowerEnabled === true &&
        (room.storage?.store.getCapacity() || 0) >= resourcePolicy.warehouseCapacity
}
export function getRoomResourceAmount(room: Room, resource: ResourceConstant): number {
    prepare()
    let result = positive(room.storage?.store[resource]) + positive(room.terminal?.store[resource]) +
        positive(room.factory?.store[resource]) + positive(localCargo.get(room.name)?.[resource])
    for (const lab of room.labs || []) result += positive(lab.store[resource])
    return result + positive(received.get(room.name)?.[resource]) - positive(sent.get(room.name)?.[resource])
}
export function getGlobalResourceAmount(resource: ResourceConstant): number {
    return getResourceRooms().reduce((total, room) => total + getRoomResourceAmount(room, resource), 0)
}
/** Read native inventory once inside a synchronous planning pass. Intent debits remain live. */
export function createResourceInventory(): ResourceInventory {
    prepare()
    const stocks = new Map<Room, { labs: Amounts; resources: Map<ResourceConstant, number> }>()
    const totals = new Map<ResourceConstant, number>()
    function nativeAmount(room: Room, resource: ResourceConstant): number {
        let stock = stocks.get(room)
        if (!stock) {
            const labs: Amounts = {}
            for (const lab of room.labs || []) for (const key of Object.keys(lab.store)) {
                const amount = positive(lab.store[key as ResourceConstant])
                if (amount) labs[key] = (labs[key] || 0) + amount
            }
            stock = { labs, resources: new Map() }; stocks.set(room, stock)
        }
        if (!stock.resources.has(resource)) stock.resources.set(resource,
            positive(room.storage?.store[resource]) + positive(room.terminal?.store[resource]) +
            positive(room.factory?.store[resource]) + positive(localCargo.get(room.name)?.[resource]) +
            positive(stock.labs[resource]))
        return stock.resources.get(resource)!
    }
    return {
        roomAmount(room, resource) {
            return nativeAmount(room, resource) + positive(received.get(room.name)?.[resource]) -
                positive(sent.get(room.name)?.[resource])
        },
        globalAmount(resource) {
            if (!totals.has(resource)) totals.set(resource, rooms.reduce((total, room) => total + nativeAmount(room, resource), 0))
            return totals.get(resource)! + (globalChanges[resource] || 0)
        },
    }
}
/** Terminal intents settle later; logistics must not withdraw already dispatched cargo or fees. */
export function getTerminalResourceAmount(room: Room, resource: ResourceConstant): number {
    prepare()
    return Math.max(0, positive(room.terminal?.store[resource]) - positive(sent.get(room.name)?.[resource]) -
        positive(terminalWithdrawals.get(room.name)?.[resource]))
}
export function recordTerminalWithdrawal(room: Room, resource: ResourceConstant, amount: number): void {
    prepare()
    if (Number.isFinite(amount) && amount > 0) add(terminalWithdrawals, room.name, resource, amount)
}
export function getIncomingResourceAmount(roomName: string, resource: ResourceConstant): number {
    prepare(); return positive(incoming.get(roomName)?.[resource])
}
export function getOutgoingResourceAmount(roomName: string, resource: ResourceConstant): number {
    prepare(); return positive(outgoing.get(roomName)?.[resource])
}
export function getProductionReserve(room: Room, resource: ResourceConstant): number {
    return positive(room.memory.productionReserve?.lab?.[resource]) + positive(room.memory.productionReserve?.factory?.[resource])
}
export function getResourceKeep(room: Room, resource: ResourceConstant): number {
    const base = resource === 'energy' ? resourcePolicy.terminalEnergyReserve :
        isWarehouseRoom(room) ? 0 : ordinaryRoomResourceKeep(room, resource)
    return Math.max(base, positive(room.memory.boostNeed?.[resource])) + getProductionReserve(room, resource)
}
export function getAvailableResource(room: Room, resource: ResourceConstant, inventory?: ResourceInventory): number {
    // Only storage/terminal cargo is immediately dispatchable; labs/factories keep their contents.
    prepare()
    const liquid = positive(room.storage?.store[resource]) + getTerminalResourceAmount(room, resource)
    return Math.max(0, Math.min(liquid, (inventory ? inventory.roomAmount(room, resource) : getRoomResourceAmount(room, resource)) - getResourceKeep(room, resource)) -
        getOutgoingResourceAmount(room.name, resource))
}
export function projectedResource(room: Room, resource: ResourceConstant): number {
    return getRoomResourceAmount(room, resource) + getIncomingResourceAmount(room.name, resource) -
        getOutgoingResourceAmount(room.name, resource)
}
function incomingTotal(room: Room): number {
    return Object.values(incoming.get(room.name) || {}).reduce((total, amount) => total + Math.max(0, amount), 0)
}
function receivingSpace(room: Room): number {
    const delivered = Object.values(received.get(room.name) || {}).reduce((total, amount) => total + Math.max(0, amount), 0)
    return (room.storage?.store.getFreeCapacity() || 0) + (room.terminal?.store.getFreeCapacity() || 0) -
        resourcePolicy.terminalFreeReserve - delivered
}
function receivingHeadroom(room: Room): number {
    return Math.max(0, receivingSpace(room) - incomingTotal(room))
}
/** Only the synchronous balancing pass shares stock reads; job promises remain live. */
function planningInventory(): PlanningInventory {
    const inventory = createResourceInventory()
    const stocks = new Map<Room, Map<ResourceConstant, { total: number, dispatchable: number }>>()
    const space = new Map<Room, number>()
    function stock(room: Room, resource: ResourceConstant): { total: number, dispatchable: number } {
        let resources = stocks.get(room)
        if (!resources) { resources = new Map(); stocks.set(room, resources) }
        let value = resources.get(resource)
        if (!value) {
            const total = inventory.roomAmount(room, resource)
            const liquid = positive(room.storage?.store[resource]) + getTerminalResourceAmount(room, resource)
            value = { total, dispatchable: Math.min(liquid, total - getResourceKeep(room, resource)) }
            resources.set(resource, value)
        }
        return value
    }
    return {
        available: (room, resource) => Math.max(0, stock(room, resource).dispatchable - getOutgoingResourceAmount(room.name, resource)),
        projected: (room, resource) => stock(room, resource).total + getIncomingResourceAmount(room.name, resource) -
            getOutgoingResourceAmount(room.name, resource),
        headroom: room => {
            if (!space.has(room)) space.set(room, receivingSpace(room))
            return Math.max(0, space.get(room)! - incomingTotal(room))
        },
    }
}
export function updateResourceJob(room: Room, id: string, job?: ResourceJob): void {
    prepare()
    const old = room.memory.terminalSendJob[id]
    if (old && !isRoomEvacuating(old.targetRoom)) {
        add(outgoing, room.name, old.resourceType, -old.amount)
        add(incoming, old.targetRoom, old.resourceType, -old.amount)
    }
    if (!job || job.amount <= 0) { delete room.memory.terminalSendJob[id]; return }
    room.memory.terminalSendJob[id] = job
    if (!isRoomEvacuating(job.targetRoom)) {
        add(outgoing, room.name, job.resourceType, job.amount)
        add(incoming, job.targetRoom, job.resourceType, job.amount)
    }
}
function queue(room: Room, target: Room, resource: ResourceConstant, amount: number, kind: NonNullable<ResourceJob['kind']>, inventory?: PlanningInventory): number {
    if (room === target || !eligible(target)) return 0
    amount = Math.floor(Math.min(amount, inventory ? inventory.available(room, resource) : getAvailableResource(room, resource),
        inventory ? inventory.headroom(target) : receivingHeadroom(target)))
    if (amount <= 0) return 0
    const id = `auto_${kind}_${room.name}_${target.name}_${resource}`
    const old = room.memory.terminalSendJob[id]
    updateResourceJob(room, id, { targetRoom: target.name, resourceType: resource,
        amount: amount + (old?.amount || 0), kind, createdAt: old?.createdAt ?? Game.time })
    return amount
}

/** Ensure total local + already promised incoming stock, with warehouses as first suppliers. */
export function requestRoomResource(room: Room, resource: ResourceConstant, targetAmount: number): number {
    prepare()
    if (!eligible(room)) return 0
    let needed = Math.max(0, targetAmount - getRoomResourceAmount(room, resource) - getIncomingResourceAmount(room.name, resource))
    if (needed <= 0) return getIncomingResourceAmount(room.name, resource)
    const donors = rooms.filter(candidate => candidate !== room).map(candidate => ({ room: candidate,
        available: getAvailableResource(candidate, resource), warehouse: isWarehouseRoom(candidate), cooldown: candidate.terminal!.cooldown || 0 }))
        .filter(candidate => candidate.available > 0)
        .sort((a, b) => Number(b.warehouse) - Number(a.warehouse) || a.cooldown - b.cooldown || b.available - a.available)
    for (const { room: donor } of donors) {
        if (needed <= 0) break
        needed -= queue(donor, room, resource, needed, 'production')
    }
    return getIncomingResourceAmount(room.name, resource)
}

export function terminalUsed(room: Room): boolean { prepare(); return usedTerminals.has(room.name) }
export function markTerminalUsed(room: Room): void { prepare(); usedTerminals.add(room.name) }
export function recordResourceSend(room: Room, target: string, resource: ResourceConstant, amount: number, fee: number): void {
    recordResourceDebit(room, resource, amount, fee)
    add(received, target, resource, amount)
    if (roomNames.has(target)) globalChanges[resource] = (globalChanges[resource] || 0) + amount
}
export function recordResourceDebit(room: Room, resource: ResourceConstant, amount: number, fee: number): void {
    prepare(); markTerminalUsed(room)
    add(sent, room.name, resource, amount); add(sent, room.name, 'energy', fee)
    if (roomNames.has(room.name)) {
        globalChanges[resource] = (globalChanges[resource] || 0) - amount
        globalChanges.energy = (globalChanges.energy || 0) - fee
    }
}

/** Drop unfulfillable automatic promises after production reservations are refreshed. */
function reconcileResourceJobs(): void {
    if (reconciled) return
    reconciled = true
    for (const room of rooms) {
        const budget: Amounts = {}, manual: Amounts = {}
        const entries = Object.entries(room.memory.terminalSendJob)
        for (const [, job] of entries) if (!job.kind) manual[job.resourceType] = (manual[job.resourceType] || 0) + job.amount
        entries.sort((a, b) => Number(b[1].kind === 'production') - Number(a[1].kind === 'production'))
        for (const [id, job] of entries) {
            if (!job.kind) continue
            const target = Game.rooms[job.targetRoom]
            if (!target || !eligible(target)) { updateResourceJob(room, id); continue }
            const resource = job.resourceType
            if (budget[resource] === undefined) budget[resource] = Math.max(0,
                Math.min((room.storage?.store[resource] || 0) + (room.terminal?.store[resource] || 0),
                    getRoomResourceAmount(room, resource) - getResourceKeep(room, resource)) - (manual[resource] || 0))
            const amount = Math.min(job.amount, budget[resource])
            budget[resource] -= amount
            if (amount < job.amount) updateResourceJob(room, id, amount > 0 ? { ...job, amount } : undefined)
        }
    }
}

/** One global plan each interval; projected inventories include all existing promises. */
export function planResourceDistribution(): void {
    prepare()
    reconcileResourceJobs()
    if (planned) return
    if (Game.time % resourcePolicy.distributionInterval !== resourcePolicy.distributionPhase % resourcePolicy.distributionInterval) return
    planned = true
    // Re-evaluate automated balancing; explicit console jobs and lab import requests persist.
    for (const room of rooms) for (const id in room.memory.terminalSendJob) {
        const job = room.memory.terminalSendJob[id]
        if (job.kind && job.kind !== 'production') updateResourceJob(room, id)
    }
    const warehouses = rooms.filter(isWarehouseRoom)
    const warehouseSet = new Set(warehouses)
    const ordinary = rooms.filter(room => !warehouseSet.has(room))
    const inventory = planningInventory()
    const required: ResourceConstant[] = [...t3Resources, ...basicMinerals, 'G', 'ops', 'power']
    for (const room of ordinary) for (const resource of required) {
        const target = ordinaryResourceTarget(resource)
        let needed = Math.max(0, target - inventory.projected(room, resource))
        if (needed <= 0) continue
        const donors = rooms.filter(candidate => candidate !== room).map(candidate => ({ room: candidate,
            available: inventory.available(candidate, resource), warehouse: warehouseSet.has(candidate) }))
            .filter(candidate => candidate.available > 0)
            .sort((a, b) => Number(b.warehouse) - Number(a.warehouse) || b.available - a.available)
        for (const { room: donor } of donors) {
            if (needed <= 0) break
            needed -= queue(donor, room, resource, needed, 'refill', inventory)
        }
    }
    for (const room of ordinary) {
        const resources = new Set<string>([...Object.keys(room.storage!.store), ...Object.keys(room.terminal!.store)])
        for (const key of resources) {
            const resource = key as ResourceConstant
            if (resource === 'energy' || inventory.available(room, resource) <= 0) continue
            const targets = warehouses.filter(target => inventory.headroom(target) > 0)
                .sort((a, b) => inventory.projected(a, resource) - inventory.projected(b, resource))
            let excess = inventory.available(room, resource), remaining = excess
            let level = targets.length ? inventory.projected(targets[0], resource) : 0, count = 1
            // Raise the least stocked group first, avoiding an extra warehouse-to-warehouse hop.
            while (count < targets.length) {
                const next = inventory.projected(targets[count], resource)
                const cost = (next - level) * count
                if (cost > remaining) break
                remaining -= cost; level = next; count++
            }
            level += remaining / count
            for (const target of targets) {
                if (excess <= 0) break
                const share = Math.ceil(Math.max(0, level - inventory.projected(target, resource)))
                excess -= queue(room, target, resource, Math.min(excess, share), 'surplus', inventory)
            }
        }
    }
    const resources = new Set<string>()
    for (const room of warehouses) {
        for (const key in room.storage!.store) resources.add(key)
        for (const key in room.terminal!.store) resources.add(key)
    }
    for (const key of resources) {
        const resource = key as ResourceConstant
        const ordered = [...warehouses].sort((a, b) => inventory.projected(a, resource) - inventory.projected(b, resource))
        const average = ordered.reduce((total, room) => total + inventory.projected(room, resource), 0) / ordered.length
        // Small commodity inventories must also converge instead of sitting below the bulk threshold forever.
        const tolerance = Math.max(1, Math.min(resourcePolicy.warehouseBalanceTolerance, Math.floor(average * 0.01)))
        for (const target of ordered) {
            let needed = Math.floor(average - inventory.projected(target, resource))
            if (needed < tolerance) continue
            for (let index = ordered.length - 1; index >= 0 && needed > 0; index--) {
                const donor = ordered[index]
                const excess = Math.floor(inventory.projected(donor, resource) - average)
                if (excess < tolerance) continue
                needed -= queue(donor, target, resource, Math.min(needed, excess), 'balance', inventory)
            }
        }
    }
    planEnergySupport(inventory)
}

function planEnergySupport(inventory: PlanningInventory): void {
    // Energy support is independent of warehouse classification.
    for (const target of rooms) {
        const stock = inventory.projected(target, 'energy')
        if (stock >= 350000) continue
        let needed = Math.min(50000, 350000 - stock)
        for (const donor of [...rooms].sort((a, b) => inventory.projected(b, 'energy') - inventory.projected(a, 'energy'))) {
            if (donor === target || needed <= 0) continue
            const excess = inventory.projected(donor, 'energy') - 450000
            if (excess > 0) needed -= queue(donor, target, 'energy', Math.min(needed, excess), 'energy', inventory)
        }
    }
}
