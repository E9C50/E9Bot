import { interShardPolicy } from 'settings/interShard'
import { ShardMission, ShardScoutProof, ShardTaskSpec } from './missions'
import { isPortalTravelData, isRecord, PortalHop } from './types'

export function requiresRouteScouting(task: ShardTaskSpec): boolean {
    return interShardPolicy.routeScouting.enabled && (task.verifyRoute ?? !!(task.autoRoute || task.autoReturn))
}

export function scoutNeedsReturn(task: ShardTaskSpec): boolean {
    return task.haulers > 0 && !!task.returnRoute?.length
}

export function routeSignature(route: readonly PortalHop[]): string {
    return JSON.stringify(route.map((hop) => [hop.shard, hop.roomName, hop.x, hop.y, hop.destinationShard, hop.destinationRoom]))
}

function planSignature(task: ShardTaskSpec): string {
    return JSON.stringify([task.sourceShard, task.sourceRoom, task.targetShard, task.targetRoom,
        routeSignature(task.route), scoutNeedsReturn(task) ? routeSignature(task.returnRoute!) : null])
}

export function refreshMissionScouting(mission: ShardMission): void {
    if (!requiresRouteScouting(mission.task) || mission.state != 'active') return
    const now = Date.now(), signature = planSignature(mission.task), previous = mission.scouting
    const expired = previous?.status == 'verified' && (previous.verifiedAt == undefined || now - previous.verifiedAt >= interShardPolicy.routeScouting.proofMaxAge)
    const retry = previous?.status == 'failed' && now >= (previous.retryAt || 0)
    if (previous != undefined && previous.planSignature == signature && !expired && !retry) return
    mission.scouting = {
        revision: `${mission.createdAt}:${++mission.generation}`, planSignature: signature,
        status: 'pending', retryAt: previous?.retryAt != undefined && previous.retryAt > now ? previous.retryAt : undefined,
    }
    delete mission.leases['scout:0']
}

export function isMissionVerified(mission: ShardMission): boolean {
    if (!requiresRouteScouting(mission.task)) return true
    const scouting = mission.scouting
    return scouting?.status == 'verified' && scouting.outbound === true &&
        (!scoutNeedsReturn(mission.task) || scouting.returning === true) && scouting.planSignature == planSignature(mission.task) &&
        scouting.verifiedAt != undefined && Date.now() - scouting.verifiedAt < interShardPolicy.routeScouting.proofMaxAge
}

export function failMissionScouting(mission: ShardMission, message: string, failedHop?: PortalHop): void {
    if (mission.scouting == undefined || mission.scouting.status == 'failed') return
    const now = Date.now()
    mission.scouting.status = 'failed'
    mission.scouting.lastError = message
    mission.scouting.retryAt = now + interShardPolicy.routeScouting.retryDelay
    mission.scouting.outbound = false
    mission.scouting.returning = false
    mission.lastError = message
    if (failedHop != undefined) {
        const key = routeSignature([failedHop])
        const blocked = (mission.blockedPortals || []).filter((entry) => entry.until > now && routeSignature([entry.hop]) != key)
        blocked.push({ hop: { ...failedHop }, until: now + interShardPolicy.routeScouting.blockedPortalTtl })
        mission.blockedPortals = blocked.slice(-interShardPolicy.routeScouting.maximumBlockedPortals)
        if (mission.routing != undefined) mission.routing.nextAttemptTick = Game.time
    }
}

/** 单个来源的旧/伪造/其他单位证明不能放行当前候选行程。 */
export function acceptScoutProof(mission: ShardMission, value: unknown, peer: string): boolean {
    const scouting = mission.scouting, lease = mission.leases['scout:0'], now = Date.now()
    if (mission.state != 'active' || !requiresRouteScouting(mission.task) || scouting == undefined || lease == undefined ||
        scouting.status == 'failed' || !isRecord(value) || value.missionId != mission.task.key || value.sourceShard != mission.task.sourceShard ||
        value.scoutName != lease.name || value.revision != scouting.revision || value.shard != peer ||
        !['outbound', 'return'].includes(String(value.leg)) || !['verified', 'failed'].includes(String(value.result)) ||
        typeof value.updatedAt != 'number' || !Number.isFinite(value.updatedAt) || value.updatedAt < lease.createdAt || value.updatedAt > now ||
        now - value.updatedAt >= interShardPolicy.routeScouting.proofMaxAge || !Number.isInteger(value.elapsedTicks) || (value.elapsedTicks as number) < 0 ||
        typeof value.roomName != 'string' || !/^[WE]\d+[NS]\d+$/.test(value.roomName) ||
        !isPortalTravelData({ missionId: mission.task.key, originShard: value.leg == 'return' ? mission.task.targetShard : mission.task.sourceShard,
            route: value.route, hopIndex: 0 })) return false
    const proof = value as unknown as ShardScoutProof
    const expected = proof.leg == 'outbound' ? mission.task.route : mission.task.returnRoute
    if (expected == undefined || routeSignature(proof.route) != routeSignature(expected) ||
        (proof.leg == 'return' && !scoutNeedsReturn(mission.task))) return false
    if (proof.result == 'failed') {
        const failedHop = proof.failedHop
        if (failedHop != undefined && (!isRecord(failedHop) || !expected.some((hop) => routeSignature([hop]) == routeSignature([failedHop])))) return false
        failMissionScouting(mission, typeof proof.message == 'string' ? proof.message : 'scout 实地侦察失败', failedHop)
        return true
    }
    const shard = proof.leg == 'outbound' ? mission.task.targetShard : mission.task.sourceShard
    const room = proof.leg == 'outbound' ? mission.task.targetRoom : mission.task.sourceRoom
    if (proof.shard != shard || proof.roomName != room) return false
    if (proof.leg == 'outbound') {
        if (proof.updatedAt <= (scouting.outboundVerifiedAt ?? -Infinity)) return false
        scouting.outbound = true; scouting.outboundTicks = proof.elapsedTicks; scouting.outboundVerifiedAt = proof.updatedAt
    } else {
        if (proof.updatedAt <= (scouting.returnVerifiedAt ?? -Infinity)) return false
        scouting.returning = true; scouting.returnTicks = proof.elapsedTicks; scouting.returnVerifiedAt = proof.updatedAt
    }
    if (scouting.outbound && (!scoutNeedsReturn(mission.task) || scouting.returning)) {
        scouting.status = 'verified'
        scouting.verifiedAt = Math.min(scouting.outboundVerifiedAt!, scouting.returnVerifiedAt ?? scouting.outboundVerifiedAt!)
        delete scouting.lastError
    }
    return true
}
