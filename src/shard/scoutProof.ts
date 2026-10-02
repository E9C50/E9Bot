import { interShardPolicy } from 'settings/interShard'
import type { ShardScoutProof, ShardUnitData } from './missions'
import { flushInterShardMemory, getLocalShardState, getShardTransportError, markShardStateDirty } from './transport'
import { isRecord, PortalHop } from './types'

export type { ShardScoutProof } from './missions'

export function scoutProofKey(missionId: string, leg: 'outbound' | 'return'): string { return `${missionId}:${leg}` }

/** 与 route 的字段顺序、JSON 的 undefined 省略无关，入口与落地房间必须完全一致。 */
export function sameScoutRoute(first: readonly PortalHop[], second: readonly PortalHop[]): boolean {
    return Array.isArray(first) && Array.isArray(second) && first.length === second.length && first.every((hop, index) => {
        const other = second[index]
        return isRecord(hop) && isRecord(other) && hop.shard === other.shard && hop.roomName === other.roomName &&
            hop.x === other.x && hop.y === other.y && hop.destinationShard === other.destinationShard && hop.destinationRoom === other.destinationRoom
    })
}

function copyHop(hop: PortalHop): PortalHop {
    return { shard: hop.shard, roomName: hop.roomName, x: hop.x, y: hop.y, destinationShard: hop.destinationShard,
        ...(hop.destinationRoom === undefined ? {} : { destinationRoom: hop.destinationRoom }) }
}

/**
 * 只有成功持久化后才清除 proofPending。失败恢复此前的证明目录，调用者留在原地重试，
 * 不因容量或 InterShardMemory 错误丢弃已验证的去程证明、提前开始返程或标记 done。
 */
export function reportScoutProof(data: ShardUnitData, creep: Creep, leg: 'outbound' | 'return', result: 'verified' | 'failed', message?: string): void {
    const progress = data.scouting
    if (progress === undefined) return
    progress.proofPending = { leg, result, ...(message === undefined ? {} : { message }) }
    const endpointShard = leg === 'outbound' ? data.task.targetShard : data.task.sourceShard
    const endpointRoom = leg === 'outbound' ? data.task.targetRoom : data.task.sourceRoom
    if (result === 'verified' && (Game.shard.name !== endpointShard || creep.room.name !== endpointRoom)) {
        data.lastError = 'Scout 尚未到达该行程的实际终点'
        return
    }
    const local = getLocalShardState(), previous = local.scoutProofs
    if (previous !== undefined && !isRecord(previous)) { data.lastError = 'Scout 证明目录损坏，保留原值'; return }
    const now = Date.now(), next: Record<string, unknown> = { ...(previous as Record<string, unknown> | undefined) }
    for (const [key, proof] of Object.entries(next)) {
        if (isRecord(proof) && typeof proof.updatedAt === 'number' && Number.isFinite(proof.updatedAt) &&
            now - proof.updatedAt > interShardPolicy.routeScouting.proofMaxAge) delete next[key]
    }
    const key = scoutProofKey(data.missionId, leg)
    if (next[key] === undefined && Object.keys(next).length >= interShardPolicy.routeScouting.maximumProofs) {
        data.lastError = 'Scout 证明容量已满，等待过期记录释放'
        return
    }
    const route = leg === 'outbound' ? progress.outboundRoute : progress.returnRoute || []
    const controller = creep.room.controller
    const currentHop = data.routeIssue?.hop || data.route[data.hopIndex]
    const failedHop = result === 'failed' && currentHop !== undefined && route.some(hop => sameScoutRoute([hop], [currentHop])) ? copyHop(currentHop) : undefined
    const proof: ShardScoutProof = {
        missionId: data.missionId, sourceShard: data.task.sourceShard, scoutName: creep.name, revision: progress.revision,
        leg, result, route: route.map(copyHop), shard: Game.shard.name, roomName: creep.room.name, updatedAt: now,
        elapsedTicks: progress.legs?.[leg] ?? Math.max(0, progress.elapsedTicks - (progress.legStartedTicks || 0)),
        ...(message === undefined ? {} : { message }), ...(failedHop === undefined ? {} : { failedHop }),
        observation: { controllerPresent: controller !== undefined, my: controller?.my === true,
            ...(controller?.owner === undefined ? {} : { owner: controller.owner.username }),
            ...(controller?.reservation === undefined ? {} : { reservation: controller.reservation.username }) },
    }
    next[key] = proof
    local.scoutProofs = next
    markShardStateDirty()
    if (!flushInterShardMemory()) {
        if (previous === undefined) delete local.scoutProofs
        else local.scoutProofs = previous
        markShardStateDirty()
        data.lastError = getShardTransportError() || 'Scout 证明尚未成功发布'
        return
    }
    delete progress.proofPending
}
