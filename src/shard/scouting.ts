import { interShardPolicy } from 'settings/interShard'
import { isShardUnitData, ShardUnitData } from './missions'
import { isPortalTravelData, isRecord } from './types'
import { readRemoteShardState } from './transport'
import { reportScoutProof, sameScoutRoute } from './scoutProof'
import { travelPortalRoute } from './travel'
import { createPortalExplorerRole } from './exploration'
import { scoutMovementOptions } from './scoutMovement'
import { getScoutDanger } from './scoutSafety'
import { withScoutRetirement } from './scoutRetirement'

type Progress = NonNullable<ShardUnitData['scouting']>

function clearPreparation(data: ShardUnitData): void {
    delete data.transferPreparedAt
    delete data.transferPreparedHop
    delete data.transferPreparedShard
}

/** 只累计每一 shard 自己的 tick 差；迁移后的新 shard 只记一次到达 tick。 */
function advanceClock(progress: Progress): number {
    let elapsed = 0
    if (progress.lastShard === Game.shard.name && progress.lastTick !== undefined && Game.time >= progress.lastTick) elapsed = Game.time - progress.lastTick
    else if (progress.lastShard !== undefined) elapsed = 1
    progress.elapsedTicks += elapsed
    progress.lastTick = Game.time
    progress.lastShard = Game.shard.name
    return elapsed
}

function finishLeg(data: ShardUnitData): boolean {
    const progress = data.scouting!
    if (progress.leg === 'outbound' && progress.returnRoute?.length) {
        progress.leg = 'return'
        progress.legStartedTicks = progress.elapsedTicks
        progress.stuckTicks = 0
        delete progress.lastPosition
        data.route = progress.returnRoute.map(hop => ({ ...hop }))
        data.originShard = data.task.targetShard
        data.hopIndex = 0
        data.phase = 'return'
        clearPreparation(data)
    } else { data.done = true; data.phase = 'done'; clearPreparation(data) }
    delete data.lastError
    return true
}

function fail(data: ShardUnitData, creep: Creep, message: string): boolean {
    const progress = data.scouting!
    if (progress.legs === undefined) progress.legs = {}
    progress.legs[progress.leg] = progress.elapsedTicks - (progress.legStartedTicks || 0)
    data.lastError = message
    clearPreparation(data)
    reportScoutProof(data, creep, progress.leg, 'failed', message)
    if (progress.proofPending === undefined) { data.done = true; data.phase = 'done' }
    return false
}

function claimTargetIssue(data: ShardUnitData, creep: Creep): string | undefined {
    if (data.scouting?.leg !== 'outbound' || !data.task.claim || Game.shard.name !== data.task.targetShard || creep.room.name !== data.task.targetRoom) return undefined
    const controller = creep.room.controller
    return controller === undefined || (controller.owner !== undefined && controller.my !== true) ||
        (controller.reservation !== undefined && controller.reservation.username !== creep.owner?.username) ?
        'Scout 实地发现目标 Controller 当前无法认领' : undefined
}

function run(creep: Creep, data: ShardUnitData): boolean {
    const progress = data.scouting!
    const elapsed = advanceClock(progress)
    const command = data.task.sourceShard === Game.shard.name ? Memory.shardMissions?.[data.missionId] :
        readRemoteShardState(data.task.sourceShard)?.reports?.[data.missionId] as { type?: string; state?: string; scoutRevision?: string } | undefined
    const revision = data.task.sourceShard === Game.shard.name ? Memory.shardMissions?.[data.missionId]?.scouting?.revision :
        (command as { scoutRevision?: string } | undefined)?.scoutRevision
    if (command?.state === 'cancelled' || command?.state === 'complete' || (revision !== undefined && revision !== progress.revision)) {
        data.done = true; data.phase = 'done'; clearPreparation(data)
        delete progress.proofPending
        return false
    }
    if (command?.state === 'paused') { progress.stuckTicks = 0; delete progress.lastPosition; return false }
    if (progress.proofPending !== undefined) {
        const pending = progress.proofPending
        if (pending.result === 'verified') {
            const unsafe = getScoutDanger(creep) || claimTargetIssue(data, creep)
            if (unsafe !== undefined) return fail(data, creep, unsafe)
        }
        reportScoutProof(data, creep, pending.leg, pending.result, pending.message)
        if (progress.proofPending !== undefined) return false
        if (pending.result === 'failed') { data.done = true; data.phase = 'done'; data.lastError = pending.message; return false }
        return finishLeg(data)
    }
    if (data.done) return false
    const candidate = progress.leg === 'outbound' ? progress.outboundRoute : progress.returnRoute
    const origin = progress.leg === 'outbound' ? data.task.sourceShard : data.task.targetShard
    const endpointShard = progress.leg === 'outbound' ? data.task.targetShard : data.task.sourceShard
    const endpointRoom = progress.leg === 'outbound' ? data.task.targetRoom : data.task.sourceRoom
    if (!candidate?.length || !isPortalTravelData({ missionId: data.missionId, originShard: origin, route: candidate, hopIndex: 0 }) ||
        candidate[candidate.length - 1].destinationShard !== endpointShard || data.originShard !== origin || !sameScoutRoute(data.route, candidate))
        return fail(data, creep, 'Scout 路线已偏离待验证候选，停止出发')
    const unsafe = getScoutDanger(creep)
    if (unsafe !== undefined) return fail(data, creep, unsafe)
    if (progress.elapsedTicks - (progress.legStartedTicks || 0) > interShardPolicy.routeScouting.maximumLegTicks)
        return fail(data, creep, 'Scout 验证行程超过允许的 tick 数')
    if (creep.ticksToLive !== undefined && creep.ticksToLive < interShardPolicy.routeScouting.minimumRemainingTicks)
        return fail(data, creep, 'Scout 剩余寿命不足，无法继续验证')
    const previous = progress.lastPosition
    const samePosition = previous !== undefined && previous.shard === Game.shard.name && previous.roomName === creep.pos.roomName &&
        previous.x === creep.pos.x && previous.y === creep.pos.y
    progress.stuckTicks = samePosition && creep.fatigue === 0 ? (progress.stuckTicks || 0) + elapsed : 0
    progress.lastPosition = { shard: Game.shard.name, roomName: creep.pos.roomName, x: creep.pos.x, y: creep.pos.y }
    if ((progress.stuckTicks || 0) >= interShardPolicy.routeScouting.stuckTicks) return fail(data, creep, 'Scout 长时间停在同一位置，路线不可通行')
    const result = travelPortalRoute(creep, data)
    if (result.status === 'error' || result.reason !== undefined) return fail(data, creep, result.message || 'Scout Portal 行程失败')
    if (result.status !== 'arrived') { data.lastError = result.message; return false }
    if (Game.shard.name !== endpointShard) return fail(data, creep, 'Scout 行程结束在错误的 shard')
    if (creep.room.name !== endpointRoom) {
        const moved = creep.moveTo(new RoomPosition(25, 25, endpointRoom), { ...scoutMovementOptions, range: 20 })
        if (moved === ERR_NO_PATH) {
            const message = 'Scout 无法从 Portal 落地房间到达任务终点'
            data.routeIssue = { hop: { ...candidate[candidate.length - 1] }, updatedAt: Date.now(), message }
            return fail(data, creep, message)
        }
        if (moved !== OK && moved !== ERR_TIRED) return fail(data, creep, `Scout 前往终点失败: ${moved}`)
        return false
    }
    const claimIssue = claimTargetIssue(data, creep)
    if (claimIssue !== undefined) return fail(data, creep, claimIssue)
    if (progress.legs === undefined) progress.legs = {}
    progress.legs[progress.leg] = progress.elapsedTicks - (progress.legStartedTicks || 0)
    reportScoutProof(data, creep, progress.leg, 'verified')
    return progress.proofPending === undefined ? finishLeg(data) : false
}

/** 低成本 scout 只移动、检查现场并发布证据，始终执行候选路线的独立快照。 */
export function createShardScoutRole(data: CreepData): ICreepConfig {
    if (isShardUnitData(data) && data.exploration !== undefined) return withScoutRetirement(data, createPortalExplorerRole(data))
    const valid = (value: CreepData): value is ShardUnitData => {
        if (!isShardUnitData(value) || value.unitKind !== 'scout' || !isRecord(value.scouting)) return false
        const progress = value.scouting
        const integer = (number: unknown): boolean => Number.isInteger(number) && (number as number) >= 0
        return typeof progress.revision === 'string' && progress.revision.length > 0 && Array.isArray(progress.outboundRoute) &&
            (progress.returnRoute === undefined || Array.isArray(progress.returnRoute)) &&
            ['outbound', 'return'].includes(progress.leg) && integer(progress.elapsedTicks) &&
            (progress.lastTick === undefined || integer(progress.lastTick)) &&
            (progress.legStartedTicks === undefined || integer(progress.legStartedTicks)) &&
            (progress.lastPosition === undefined || (isRecord(progress.lastPosition) && typeof progress.lastPosition.shard === 'string' &&
                typeof progress.lastPosition.roomName === 'string' && integer(progress.lastPosition.x) && integer(progress.lastPosition.y))) &&
            (progress.proofPending === undefined || (isRecord(progress.proofPending) && ['outbound', 'return'].includes(progress.proofPending.leg) &&
                ['verified', 'failed'].includes(progress.proofPending.result)))
    }
    const work = (creep: Creep): boolean => valid(data) && interShardPolicy.enabled && interShardPolicy.routeScouting.enabled && creep.memory.role === 'sScout' ? run(creep, data) : false
    return withScoutRetirement(data, { isNeed: () => true, prepare: creep => !creep.spawning && valid(data) && creep.memory.role === 'sScout' && (!data.done || data.scouting?.proofPending !== undefined), source: work, target: work })
}
