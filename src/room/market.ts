import {
    centerResourceSales,
    centerTerminalResources,
    roomPolicy,
    roomResourceSales,
} from 'settings/roomPolicy'
import { roomWorkDue } from 'runtime/roomSchedule'
import { cpuRecoveryInterval } from 'runtime/cpuRecovery'
import { getAvailableResource, getTerminalResourceAmount, isWarehouseRoom, recordResourceDebit, terminalUsed } from './resourceNetwork'
import { affordableSendAmount, resourceTransactionCost } from './terminal'

export function sellResource(
    room: Room,
    resourceType: ResourceConstant,
    threshold: number,
    minPrice: number = roomPolicy.market.defaultMinimumPrice,
    sellAmount: number = roomPolicy.market.defaultSaleAmount
): void {
    if (
        room.storage == undefined ||
        room.storage.store[resourceType] <= threshold ||
        room.terminal == undefined ||
        room.terminal.cooldown > 0 || terminalUsed(room)
    )
        return

    let bestPrice = 0
    let selectedOrder: Order | undefined
    const orders = Game.market.getAllOrders({ type: ORDER_BUY, resourceType })
    for (const order of orders) {
        if (
            order.roomName == undefined ||
            order.remainingAmount <= roomPolicy.market.minimumOrderAmount
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
    const available = Math.min(selectedOrder.remainingAmount, sellAmount, getTerminalResourceAmount(room, resourceType),
        getAvailableResource(room, resourceType))
    const amount = affordableSendAmount(room, resourceType, selectedOrder.roomName!, available, getTerminalResourceAmount(room, 'energy'))
    if (amount <= 0) return
    const result = Game.market.deal(selectedOrder.id, amount, room.name)
    if (result == OK) {
        recordResourceDebit(room, resourceType, amount, resourceTransactionCost(room, selectedOrder.roomName!, amount))
        console.log(
            `卖出${resourceType} [${room.name}] => [${selectedOrder.roomName}]，单价为：${selectedOrder.price}，数量为：${amount}，综合单价为：${bestPrice}`
        )
    }
}

/** 保持原出售尝试顺序；资源种类、阈值、价格和批次数量来自配置。 */
export function processRoomMarket(room: Room): void {
    const due = roomWorkDue(room.name, cpuRecoveryInterval('market', roomPolicy.market.scanInterval), roomPolicy.market.staggerScans)
    if (due) for (const sale of roomResourceSales)
        sellResource(
            room,
            sale.resourceType,
            sale.threshold,
            sale.minPrice,
            sale.sellAmount
        )
    if (!isWarehouseRoom(room)) return

    for (const resourceType of centerTerminalResources) {
        room.memory.terminalAmount[resourceType] =
            Math.max(room.memory.terminalAmount[resourceType] || 0, roomPolicy.terminal.centerResourceReserve)
    }
    if (due) for (const sale of centerResourceSales)
        sellResource(
            room,
            sale.resourceType,
            sale.threshold,
            sale.minPrice,
            sale.sellAmount
        )
}
