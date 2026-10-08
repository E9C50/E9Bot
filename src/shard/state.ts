import { isShardUnitData, ShardArrivalRecord, ShardMissionReport, ShardUnitData } from './missions'
import { interShardPolicy } from 'settings/interShard'
import { cancelCreepTransfers, flushInterShardMemory, getLocalShardState, getShardTransportError, markShardStateDirty } from './transport'

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

/** Build live status and terminal identities together; periodic reports must not erase a just-retired hauler. */
export function createShardArrivalReport(missionId: string, record: ShardArrivalRecord,
    units: ShardMissionReport['units']): ShardMissionReport {
    const now = Date.now(), retired = record.retiredUnits || {}
    const ttl = interShardPolicy.leaseDuration + interShardPolicy.reportMaxAge
    for (const [name, unit] of Object.entries(retired)) {
        if (unit?.kind !== 'hauler' || !Number.isFinite(unit.retiredAt) || unit.retiredAt > now || now - unit.retiredAt > ttl)
            delete retired[name]
    }
    const report: ShardMissionReport = {
        type: 'status', missionId, originShard: record.task.sourceShard, shard: Game.shard.name,
        updatedAt: now, energyDelivered: record.energyDelivered,
        units: [...units.filter(unit => retired[unit.name] === undefined),
            ...Object.keys(retired).map(name => ({ name, kind: 'hauler' as const, done: true }))],
    }
    if (Game.shard.name === record.task.targetShard) {
        const room = Game.rooms?.[record.task.targetRoom]
        if (room !== undefined) {
            report.targetOwned = room.controller?.my === true
            report.targetLevel = room.controller?.level || 0
            report.targetSpawns = room.find(FIND_MY_SPAWNS).length
        }
    }
    return report
}

/** Publish the empty hauler's confirmed delivery and durable done status before submitting its suicide intent. */
export function retireShardHauler(creep: Creep, data: ShardUnitData): boolean {
    if (data.unitKind !== 'hauler' || creep.spawning || Game.shard.name !== data.task.targetShard ||
        creep.room.name !== data.task.targetRoom || creep.store[RESOURCE_ENERGY] !== 0 || data.pendingDelivery !== undefined) return false
    data.retireForLifetime = true
    const all = Memory.shardArrivals || (Memory.shardArrivals = {})
    const record = all[data.missionId] || (all[data.missionId] = { task: data.task, updatedAt: Date.now(), energyDelivered: 0 })
    // Prune only expired entries; live terminal identities are never evicted to admit another retirement.
    createShardArrivalReport(data.missionId, record, [])
    const previousRetired = record.retiredUnits
    if (previousRetired?.[creep.name] === undefined && Object.keys(previousRetired || {}).length >= interShardPolicy.maximumTransfers) {
        data.lastError = '退休报告容量已满，原地等待过期记录释放'
        return false
    }
    record.retiredUnits = { ...previousRetired,
        [creep.name]: previousRetired?.[creep.name] || { kind: 'hauler', retiredAt: Date.now() } }
    record.updatedAt = Date.now()
    const local = getLocalShardState(), previousReport = local.reports?.[data.missionId]
    if (local.reports === undefined) local.reports = {}
    const units: ShardMissionReport['units'] = []
    for (const unit of Object.values(Game.creeps || {})) {
        const unitData = unit.memory?.data
        if (!isShardUnitData(unitData) || unitData.missionId !== data.missionId) continue
        units.push({ name: unit.name, kind: unitData.unitKind, done: unitData.done === true,
            ttl: unit.ticksToLive, error: unitData.lastError, routeIssue: unitData.routeIssue })
    }
    local.reports[data.missionId] = createShardArrivalReport(data.missionId, record, units)
    cancelCreepTransfers(creep)
    markShardStateDirty()
    if (!flushInterShardMemory()) {
        if (previousReport === undefined) delete local.reports[data.missionId]
        else local.reports[data.missionId] = previousReport
        if (previousRetired === undefined) delete record.retiredUnits
        else record.retiredUnits = previousRetired
        markShardStateDirty()
        data.lastError = getShardTransportError() || '退休报告尚未成功发布，原地等待重试'
        return false
    }
    data.done = true; data.phase = 'done'
    const result = creep.suicide()
    if (result !== OK) data.lastError = `suicide: ${result}`
    else delete data.lastError
    return true
}
