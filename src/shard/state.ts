import type { ShardArrivalRecord, ShardUnitData } from './missions'

/** 只有下一 tick 看到 cargo 实际减少时，才将 transfer 计入持久送达量。 */
export function recordShardDelivery(data: ShardUnitData, amount: number): void {
    if (amount <= 0) return
    const all = Memory.shardArrivals || (Memory.shardArrivals = {})
    const record: ShardArrivalRecord = all[data.missionId] || (all[data.missionId] = {
        task: data.task, updatedAt: Date.now(), energyDelivered: 0,
    })
    record.energyDelivered += amount
    record.updatedAt = Date.now()
}
