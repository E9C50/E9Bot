import { runtimePolicy } from 'settings/runtime'

export function generatePixel(): void {
    const policy = runtimePolicy.pixel
    if (
        policy.enabled &&
        !policy.excludedShards.includes(Game.shard.name) &&
        Game.cpu.bucket >= policy.minimumBucket &&
        typeof Game.cpu.generatePixel === 'function'
    ) {
        Game.cpu.generatePixel()
    }
}

export function recordCpuHistory(): void {
    const policy = runtimePolicy.cpuHistory
    if (!policy.shards.includes(Game.shard.name) || policy.sampleCount <= 0)
        return
    const samples: number[] = global['cpuList'] || (global['cpuList'] = [])
    samples.push(Game.cpu.getUsed())
    while (samples.length > policy.sampleCount) samples.shift()
}

/** 私服补能；每房每 tick 最多一次成功成交。 */
export function purchasePrivateServerEnergy(): void {
    const policy = runtimePolicy.privateServer
    if (
        !policy.enabled ||
        Game.shard.name !== policy.shard ||
        Game.time % policy.interval !== 0
    )
        return

    for (const room of Object.values(Game.rooms)) {
        if (
            !room.my ||
            !room.storage ||
            !room.terminal ||
            room.terminal.cooldown > 0
        )
            continue
        const needed =
            policy.targetEnergy -
            room.storage.store[RESOURCE_ENERGY] -
            room.terminal.store[RESOURCE_ENERGY]
        if (needed <= 0) continue
        const orders = Game.market
            .getAllOrders({ type: ORDER_SELL, resourceType: RESOURCE_ENERGY })
            .sort((a, b) => a.price - b.price)
        for (const order of orders) {
            let amount = Math.floor(
                Math.min(
                    needed,
                    order.amount,
                    policy.maximumPurchase,
                    room.terminal.store.getFreeCapacity(RESOURCE_ENERGY),
                    order.price > 0
                        ? Game.market.credits / order.price
                        : Infinity
                )
            )
            if (order.roomName) {
                // 整数二分，确保传输费用不超过终端当前能量。
                let lower = 0
                let upper = amount
                while (lower < upper) {
                    const candidate = Math.ceil((lower + upper) / 2)
                    if (
                        Game.market.calcTransactionCost(
                            candidate,
                            room.name,
                            order.roomName
                        ) <= room.terminal.store[RESOURCE_ENERGY]
                    )
                        lower = candidate
                    else upper = candidate - 1
                }
                amount = lower
            }
            if (
                amount > 0 &&
                Game.market.deal(order.id, amount, room.name) === OK
            )
                break
        }
    }
}
