import {
    centerResourceSales,
    centerTerminalResources,
    roomPolicy,
    roomResourceSales,
} from 'settings/roomPolicy'
import { roomWorkDue } from 'runtime/roomSchedule'
import { cpuRecoveryInterval } from 'runtime/cpuRecovery'
import { basicMinerals, resourcePolicy } from 'settings/resourcePolicy'
import {
    getAvailableResource, getOutgoingResourceAmount, getResourceKeep, getRoomResourceAmount,
    getTerminalResourceAmount, isWarehouseRoom, recordResourceDebit, terminalUsed,
} from './resourceNetwork'
import { affordableSendAmount, resourceTransactionCost } from './terminal'
import { isRoomEvacuating } from './evacuationState'

interface EnergySalePlan {
    orderId: string
    amount: number
    stagedTick?: number
    stagedTarget?: number
}
interface EnergyOrderCache {
    scannedAt: number
    orders: Order[]
    byId: Map<string, Order>
}
let marketShard = '', marketTick = -1, dealAttempts = 0
let energyOrders: EnergyOrderCache | undefined
let resourceOrdersThisTick = new Map<ResourceConstant, Order[]>()
let soldThisTick = new Map<string, number>()
let energyPlans = new Map<string, EnergySalePlan>()
let invalidOrdersThisTick = new Set<string>(), retryEnergyRooms = new Set<string>()

function prepareMarket(): void {
    const shard = Game.shard?.name || ''
    if (shard !== marketShard) {
        marketShard = shard
        marketTick = -1
        energyOrders = undefined
        energyPlans = new Map()
        retryEnergyRooms = new Set()
    }
    if (marketTick === Game.time) return
    marketTick = Game.time
    dealAttempts = 0
    soldThisTick = new Map()
    resourceOrdersThisTick = new Map()
    invalidOrdersThisTick = new Set()
}
/** `amount` is presently executable stock; remainingAmount also includes unfunded stock. */
function executableAmount(order: Order): number {
    if (invalidOrdersThisTick.has(order.id)) return 0
    const amount = Math.min(order.remainingAmount, order.amount ?? order.remainingAmount)
    return Math.max(0, Math.floor(amount - (energyOrders?.byId.get(order.id) === order ? 0 : soldThisTick.get(order.id) || 0)))
}
function cachedEnergyOrders(): EnergyOrderCache {
    prepareMarket()
    const interval = cpuRecoveryInterval('market', roomPolicy.market.scanInterval)
    if (!energyOrders || Game.time < energyOrders.scannedAt || Game.time - energyOrders.scannedAt >= interval) {
        const orders = Game.market.getAllOrders({ type: ORDER_BUY, resourceType: RESOURCE_ENERGY }).map(order => {
            const sold = soldThisTick.get(order.id) || 0
            return { ...order, amount: Math.max(0, (order.amount ?? order.remainingAmount) - sold),
                remainingAmount: Math.max(0, order.remainingAmount - sold) }
        })
        energyOrders = { scannedAt: Game.time, orders, byId: new Map(orders.map(order => [order.id, order])) }
    }
    return energyOrders
}
/** Native order queries are expensive; rooms share one filtered result per resource/tick. */
function buyOrders(resource: ResourceConstant): Order[] {
    if (resource === RESOURCE_ENERGY) return cachedEnergyOrders().orders
    let orders = resourceOrdersThisTick.get(resource)
    if (!orders) {
        orders = Game.market.getAllOrders({ type: ORDER_BUY, resourceType: resource })
        resourceOrdersThisTick.set(resource, orders)
    }
    // Successful deals debit executableAmount through soldThisTick, never stale raw orders.
    return orders
}
function dealResource(room: Room, order: Order, resource: ResourceConstant, amount: number): boolean {
    prepareMarket()
    const maximumDeals = roomPolicy.market.maximumDealsPerTick ?? 10
    if (dealAttempts >= maximumDeals || amount <= 0 || amount > executableAmount(order)) return false
    dealAttempts++
    const result = Game.market.deal(order.id, amount, room.name)
    if (result !== OK) {
        if (result === ERR_FULL) dealAttempts = maximumDeals
        else if (result === ERR_INVALID_ARGS || result === ERR_NOT_ENOUGH_RESOURCES || result === ERR_NOT_FOUND) {
            invalidOrdersThisTick.add(order.id)
            const cached = energyOrders?.byId.get(order.id)
            if (cached) cached.amount = 0
        }
        return false
    }
    soldThisTick.set(order.id, (soldThisTick.get(order.id) || 0) + amount)
    const cached = energyOrders?.byId.get(order.id)
    if (cached) {
        cached.amount = Math.max(0, cached.amount - amount)
        cached.remainingAmount = Math.max(0, cached.remainingAmount - amount)
    }
    recordResourceDebit(room, resource, amount, resourceTransactionCost(room, order.roomName!, amount))
    return true
}

/** Local cargo remains part of the batch while Manager moves it out of Storage. */
function energySaleBudget(room: Room): number {
    let fixed = room.factory?.store.energy || 0
    for (const lab of room.labs || []) fixed += lab.store.energy || 0
    const movable = getRoomResourceAmount(room, RESOURCE_ENERGY) - fixed
    const storageReserve = roomPolicy.market.ordinaryEnergyStorageReserve
    return Math.max(0, Math.min(movable - storageReserve - resourcePolicy.terminalEnergyReserve,
        movable - storageReserve - getResourceKeep(room, RESOURCE_ENERGY) - getOutgoingResourceAmount(room.name, RESOURCE_ENERGY)))
}
function terminalEnergyHeadroom(room: Room): number {
    const store = room.terminal!.store
    // A sale consumes its staged energy and frees space itself. Reserving another 10k here
    // would deadlock a full terminal even after its first surplus-energy sale succeeds.
    return Math.max(0, (store.energy || 0) + store.getFreeCapacity() - resourcePolicy.terminalEnergyReserve)
}
function selectEnergyPlan(room: Room, budget: number, headroom: number): EnergySalePlan | undefined {
    const cache = cachedEnergyOrders()
    let bestPrice = 0, selected: Order | undefined
    for (const order of cache.orders) {
        if (!order.roomName || !Number.isFinite(order.price) || order.price <= 0 || Game.market.orders?.[order.id]) continue
        const sample = Math.min(executableAmount(order), roomPolicy.market.ordinaryEnergyMaximumSaleAmount, budget, headroom)
        if (sample <= 0) continue
        // One fee calculation per candidate; only the winning order needs an exact budget search.
        const price = order.price * sample / (sample + resourceTransactionCost(room, order.roomName, sample))
        if (price > bestPrice) { bestPrice = price; selected = order }
    }
    if (!selected) return undefined
    const amount = affordableSendAmount(room, RESOURCE_ENERGY, selected.roomName!,
        Math.min(executableAmount(selected), roomPolicy.market.ordinaryEnergyMaximumSaleAmount),
        resourcePolicy.terminalEnergyReserve + Math.min(budget, headroom))
    return amount > 0 ? { orderId: selected.id, amount } : undefined
}

/** Stage an entire ordinary-room surplus batch, including its fee, before making a deal. */
export function processOrdinaryEnergySale(room: Room, due = true): void {
    prepareMarket()
    if (!room.storage || !room.terminal || isWarehouseRoom(room) || isRoomEvacuating(room)) return
    const reserve = resourcePolicy.terminalEnergyReserve
    room.memory.terminalAmount ||= { energy: reserve }
    let plan = energyPlans.get(room.name)
    const demand = room.memory.terminalAmount
    const ownDemand = plan?.stagedTick === Game.time && demand.energy === plan.stagedTarget
    // Terminal refresh has already chosen an actual send job; keep all of its staging priority.
    if (Object.keys(demand).some(resource => resource !== RESOURCE_ENERGY && demand[resource] > 0) ||
        (demand.energy || 0) > reserve && !ownDemand) return
    const clear = (): void => {
        energyPlans.delete(room.name)
        retryEnergyRooms.delete(room.name)
        demand.energy = reserve
    }
    const budget = energySaleBudget(room), headroom = terminalEnergyHeadroom(room)
    if (budget <= 0 || headroom <= 0) { clear(); return }
    const retry = retryEnergyRooms.delete(room.name)
    if (due || retry) {
        plan = selectEnergyPlan(room, budget, headroom)
        if (plan) energyPlans.set(room.name, plan)
        else { clear(); return }
    }
    const order = plan && energyOrders?.byId.get(plan.orderId)
    if (!plan || !order?.roomName || order.price <= 0 || executableAmount(order) <= 0) { clear(); return }
    let fee = resourceTransactionCost(room, order.roomName, plan.amount)
    if (plan.amount > executableAmount(order) || plan.amount + fee > Math.min(budget, headroom)) {
        plan.amount = affordableSendAmount(room, RESOURCE_ENERGY, order.roomName,
            Math.min(plan.amount, executableAmount(order)), reserve + Math.min(budget, headroom))
        if (plan.amount <= 0) { clear(); return }
        fee = resourceTransactionCost(room, order.roomName, plan.amount)
    }
    demand.energy = reserve + plan.amount + fee
    plan.stagedTick = Game.time
    plan.stagedTarget = demand.energy
    if (room.terminal.cooldown > 0 || terminalUsed(room)) return
    const terminalEnergy = getTerminalResourceAmount(room, RESOURCE_ENERGY)
    const liquidBudget = Math.min((room.storage.store.energy || 0) + terminalEnergy -
        roomPolicy.market.ordinaryEnergyStorageReserve - reserve,
        getAvailableResource(room, RESOURCE_ENERGY) - roomPolicy.market.ordinaryEnergyStorageReserve)
    if (terminalEnergy < demand.energy || plan.amount + fee > liquidBudget) return
    if (dealResource(room, order, RESOURCE_ENERGY, plan.amount)) {
        console.log(`卖出energy [${room.name}] => [${order.roomName}]，单价为：${order.price}，数量为：${plan.amount}`)
        clear()
    } else if (executableAmount(order) <= 0) {
        clear()
        retryEnergyRooms.add(room.name)
    }
}

export function sellResource(
    room: Room,
    resourceType: ResourceConstant,
    threshold: number,
    minPrice: number = roomPolicy.market.defaultMinimumPrice,
    sellAmount: number = roomPolicy.market.defaultSaleAmount
): void {
    prepareMarket()
    if (
        room.storage == undefined ||
        room.storage.store[resourceType] <= threshold ||
        room.terminal == undefined ||
        dealAttempts >= (roomPolicy.market.maximumDealsPerTick ?? 10) ||
        room.terminal.cooldown > 0 || terminalUsed(room)
    )
        return

    // Storage surplus may still be reserved or unstaged; do not query native market orders until it can sell.
    const localAvailable = Math.min(sellAmount, getTerminalResourceAmount(room, resourceType), getAvailableResource(room, resourceType))
    if (localAvailable <= 0) return
    let bestPrice = 0
    let selectedOrder: Order | undefined
    const orders = buyOrders(resourceType)
    for (const order of orders) {
        if (
            order.roomName == undefined ||
            executableAmount(order) <= roomPolicy.market.minimumOrderAmount
        )
            continue
        const energyCost = Game.market.calcTransactionCost(
            sellAmount,
            room.name,
            order.roomName
        )
        const price =
            resourceType == RESOURCE_ENERGY
                ? (order.price * sellAmount) / (sellAmount + energyCost)
                : (order.price * sellAmount -
                      energyCost * roomPolicy.market.energyValue) /
                  sellAmount
        if (price > bestPrice) {
            bestPrice = price
            selectedOrder = order
        }
    }
    if (selectedOrder == undefined || bestPrice <= minPrice) return
    const available = Math.min(executableAmount(selectedOrder), localAvailable)
    const amount = affordableSendAmount(room, resourceType, selectedOrder.roomName!, available, getTerminalResourceAmount(room, 'energy'))
    if (amount <= 0) return
    if (dealResource(room, selectedOrder, resourceType, amount)) {
        console.log(
            `卖出${resourceType} [${room.name}] => [${selectedOrder.roomName}]，单价为：${selectedOrder.price}，数量为：${amount}，综合单价为：${bestPrice}`
        )
    }
}

/** 保持原出售尝试顺序；资源种类、阈值、价格和批次数量来自配置。 */
export function processRoomMarket(room: Room): void {
    const due = roomWorkDue(room.name, cpuRecoveryInterval('market', roomPolicy.market.scanInterval), roomPolicy.market.staggerScans)
    const warehouse = isWarehouseRoom(room)
    // Warehouse raw surplus feeds compression; selling it would compete with that stock policy.
    const canAutoSell = (resource: ResourceConstant): boolean =>
        !warehouse || !basicMinerals.includes(resource) && resource !== 'G'
    if (!warehouse) processOrdinaryEnergySale(room, due)
    if (due) for (const sale of roomResourceSales)
        if ((warehouse || sale.resourceType !== RESOURCE_ENERGY) && canAutoSell(sale.resourceType))
        sellResource(
            room,
            sale.resourceType,
            sale.threshold,
            sale.minPrice,
            sale.sellAmount
        )
    if (!warehouse) return

    for (const resourceType of centerTerminalResources) {
        room.memory.terminalAmount[resourceType] =
            Math.max(room.memory.terminalAmount[resourceType] || 0, roomPolicy.terminal.centerResourceReserve)
    }
    if (due) for (const sale of centerResourceSales) {
        if (!canAutoSell(sale.resourceType)) continue
        sellResource(
            room,
            sale.resourceType,
            sale.threshold,
            sale.minPrice,
            sale.sellAmount
        )
    }
}
