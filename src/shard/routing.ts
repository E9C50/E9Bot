import { interShardPolicy } from 'settings/interShard'
import { ShardMission, ShardUnitData } from './missions'
import { getKnownPortals, getPortalIntelStatus } from './portalIntel'
import { isPortalRouteKnown, planPortalRoute } from './routePlanner'
import { PortalHop, isPortalTravelData, isRecord } from './types'
import { cancelCreepTransfers, getLocalShardState, readRemoteShardState } from './transport'
import { requiresRouteScouting, routeSignature } from './verification'
import type { PortalRecord } from './portalTypes'
import { isLowBucketPlanning, lowBucketPlanningReady, reserveLowBucketPlanning } from './planningBudget'
import { planLowBucketPortalRoute } from './lowBucketRoutes'

function portalKey(hop: PortalHop): string { return `${hop.shard}/${hop.roomName}/${hop.x}/${hop.y}` }

/** 仅拓扑变化触发已就绪任务重算，观察时间刷新不触发所有任务重复寻路。 */
function portalSignature(portals: readonly PortalHop[]): string {
    let hash = 2166136261
    const keys = portals.map((hop) => `${portalKey(hop)}/${hop.destinationShard}/${hop.destinationRoom}`).sort()
    for (const key of keys) {
        for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619)
        hash = Math.imul(hash ^ 0, 16777619)
    }
    return `${keys.length}:${hash >>> 0}`
}

let planningTick = -1
let planningShard = ''
let plansUsed = 0

function reservePlan(): 'bucket' | 'budget' | undefined {
    if (planningTick != Game.time || planningShard != Game.shard.name) {
        planningTick = Game.time; planningShard = Game.shard.name; plansUsed = 0
    }
    if (Game.cpu.bucket < interShardPolicy.portalRouting.minimumBucket ||
        (Number.isFinite(Game.cpu.tickLimit) && Game.cpu.tickLimit - Game.cpu.getUsed() < interShardPolicy.portalRouting.minimumCpuHeadroom)) return 'bucket'
    if (plansUsed >= interShardPolicy.portalRouting.maximumPlansPerTick) return 'budget'
    plansUsed++
    return undefined
}

function candidateRoute(sourceShard: string, sourceRoom: string, targetShard: string, targetRoom: string,
    portals: readonly PortalRecord[]): { plan?: { route: PortalHop[]; cost: number }; deferred?: 'bucket' | 'budget' } {
    if (isLowBucketPlanning('routing')) {
        const limits = reserveLowBucketPlanning()
        if (!limits) return { deferred: lowBucketPlanningReady() ? 'budget' : 'bucket' }
        return { plan: planLowBucketPortalRoute(sourceShard, sourceRoom, targetShard, targetRoom, portals, limits) }
    }
    const deferred = reservePlan()
    return { deferred, plan: deferred === undefined ? planPortalRoute(sourceShard, sourceRoom, targetShard, targetRoom, portals) : undefined }
}

/** 规划仅消费实际观察记录；找不到入口时保持任务，等待下一轮发现。 */
export function updateMissionRouting(mission: ShardMission, force = false): void {
    const task = mission.task
    if (!task.autoRoute && !task.autoReturn) return
    if (!force && mission.routing?.nextAttemptTick != undefined && Game.time < mission.routing.nextAttemptTick) return
    const now = Date.now()
    mission.blockedPortals = (mission.blockedPortals || []).filter((entry) => entry.until > now)
    const blocked = new Set(mission.blockedPortals.map((entry) => routeSignature([entry.hop])))
    const portals = getKnownPortals([task.sourceShard, task.targetShard]).filter((hop) => !blocked.has(routeSignature([hop])))
    // Changing the selection policy must also migrate ready routes persisted before deployment.
    const signature = `${interShardPolicy.portalRouting.strategy ?? 'totalCost'}:${portalSignature(portals)}`
    const changed = signature != mission.routing?.portalSignature
    const outboundKnown = task.route.length > 0 && (!task.autoRoute || isPortalRouteKnown(task.route, portals))
    const returnKnown = !!task.returnRoute?.length && (!task.autoReturn || isPortalRouteKnown(task.returnRoute, portals))
    let cost = mission.routing?.cost
    let returnCost = mission.routing?.returnCost
    let deferred: 'bucket' | 'budget' | undefined
    let incompletePlan = false
    const lowBucket = isLowBucketPlanning('routing')
    let planned = false
    if (task.autoRoute && ((!lowBucket && changed) || !outboundKnown)) {
        planned = true
        const candidate = candidateRoute(task.sourceShard, task.sourceRoom, task.targetShard, task.targetRoom, portals)
        deferred = candidate.deferred
        const plan = candidate.plan
        if (plan == undefined) incompletePlan = true
        if (plan != undefined || !outboundKnown) { task.route = plan?.route || []; cost = plan?.cost }
    }
    if (task.autoReturn && ((!lowBucket && changed) || !returnKnown)) {
        planned = true
        const candidate = candidateRoute(task.targetShard, task.targetRoom, task.sourceShard, task.sourceRoom, portals)
        deferred = deferred || candidate.deferred
        const plan = candidate.plan
        if (plan == undefined) incompletePlan = true
        if (plan != undefined || !returnKnown) { task.returnRoute = plan?.route; returnCost = plan?.cost }
    }
    // Keep a known route usable while Bucket recovers; do not claim its policy migration was recomputed.
    if (lowBucket && changed && !planned) incompletePlan = true
    const ready = task.route.length > 0 && (!task.autoReturn || !!task.returnRoute?.length)
    const intel = getPortalIntelStatus()
    mission.routing = {
        status: ready ? 'ready' : 'waiting', updatedAt: Date.now(),
        nextAttemptTick: Game.time + (deferred == 'budget' ? 1 : interShardPolicy.portalRouting.retryInterval),
        cost, returnCost,
        portalSignature: deferred == undefined && !incompletePlan ? (lowBucket ? `lowBucket:${signature}` : signature) : mission.routing?.portalSignature,
        message: ready ? undefined : (deferred == 'bucket' ? 'CPU 余量不足，暂缓自动规划' : deferred == 'budget' ? '本 tick 路线规划预算已用完，等待下一 tick' : !task.route.length ? '等待 Observer 发现连通目标的 Portal 路线' : '等待 Observer 发现可用返程路线') +
            (intel.observers == 0 ? '；当前 shard 没有可用 Observer' : ''),
    }
}

export function clearTravelPreparation(data: ShardUnitData): void {
    delete data.transferPreparedAt
    delete data.transferPreparedHop
    delete data.transferPreparedShard
    delete data.routeRetryAt
    delete data.routeRetryShard
}

/** 在途工作单位只能采用源任务发布的已验证候选路线。 */
function verifiedReplacement(data: ShardUnitData, portals: readonly PortalRecord[]): PortalHop[] | undefined {
    const source = data.task.sourceShard == Game.shard.name ? getLocalShardState() : readRemoteShardState(data.task.sourceShard)
    const command = source?.reports?.[data.missionId]
    if (!isRecord(command) || command.type != 'command' || command.state != 'active' || command.missionId != data.missionId ||
        command.scoutStatus != 'verified' || !isRecord(command.verification)) return undefined
    const proof = command.verification
    if (proof.revision != command.scoutRevision || typeof proof.verifiedAt != 'number' || proof.verifiedAt > Date.now() ||
        Date.now() - proof.verifiedAt >= interShardPolicy.routeScouting.proofMaxAge) return undefined
    const returning = data.phase == 'return'
    const route = returning ? proof.returnRoute : proof.route
    if (!isPortalTravelData({ missionId: data.missionId, originShard: returning ? data.task.targetShard : data.task.sourceShard, route, hopIndex: 0 }) ||
        !Array.isArray(route) || !route.length || route[route.length - 1].destinationShard != (returning ? data.task.sourceShard : data.task.targetShard)) return undefined
    for (let index = 0; index < route.length; index++) {
        const remaining: PortalHop[] = route.slice(index)
        if (remaining[0].shard == Game.shard.name && isPortalRouteKnown(remaining, portals)) return remaining.map((hop) => ({ ...hop }))
    }
    return undefined
}

/** 在途路线快照独立于源任务，从当前位置重新规划，保留货物、身份和交付记录。 */
export function ensureUnitRoute(creep: Creep, data: ShardUnitData, force = false, blockedHop?: PortalHop): boolean {
    const returning = data.phase == 'return'
    if (!(returning ? data.task.autoReturn : data.task.autoRoute)) return true
    const targetShard = returning ? data.task.sourceShard : data.task.targetShard
    const targetRoom = returning ? data.task.sourceRoom : data.task.targetRoom
    if (data.hopIndex == data.route.length && Game.shard.name == targetShard) return true
    if (!force && data.routeRetryShard == Game.shard.name && data.routeRetryAt != undefined && Game.time < data.routeRetryAt) return false
    if (blockedHop != undefined) data.blockedPortal = { key: portalKey(blockedHop), until: Game.time + interShardPolicy.portalRouting.retryInterval, shard: Game.shard.name }
    if (data.blockedPortal != undefined && (data.blockedPortal.shard != Game.shard.name || data.blockedPortal.until <= Game.time)) delete data.blockedPortal
    const blocked = data.blockedPortal
    const portals = getKnownPortals([data.task.sourceShard, data.task.targetShard]).filter((portal) => blocked == undefined || portalKey(portal) != blocked.key)
    const remaining = data.route.slice(data.hopIndex)
    if (!force && remaining.length > 0 && remaining[0].shard == Game.shard.name && isPortalRouteKnown(remaining, portals)) return true
    cancelCreepTransfers(creep)
    if (data.unitKind != 'scout' && requiresRouteScouting(data.task)) {
        const issueHop = blockedHop || remaining.find((hop) => !isPortalRouteKnown([hop], portals)) || remaining[0]
        if (issueHop != undefined && (force || data.routeIssue == undefined || routeSignature([data.routeIssue.hop]) != routeSignature([issueHop]))) {
            data.routeIssue = { hop: { ...issueHop }, updatedAt: Date.now(), message: '工作单位发现 Portal 路线不可用，等待 scout 重新确认' }
        }
        const replacement = verifiedReplacement(data, portals)
        clearTravelPreparation(data)
        if (replacement == undefined) {
            data.routeRetryShard = Game.shard.name
            data.routeRetryAt = Game.time + interShardPolicy.portalRouting.retryInterval
            data.lastError = '等待源任务 scout 实地确认新路线'
            return false
        }
        data.route = replacement
        data.originShard = Game.shard.name
        data.hopIndex = 0
        delete data.routeIssue
        delete data.lastError
        return true
    }
    const candidate = candidateRoute(Game.shard.name, creep.room.name, targetShard, targetRoom, portals)
    const deferred = candidate.deferred, plan = candidate.plan
    if (plan == undefined) {
        clearTravelPreparation(data)
        data.routeRetryShard = Game.shard.name
        data.routeRetryAt = Game.time + (deferred == 'budget' ? 1 : interShardPolicy.portalRouting.retryInterval)
        data.lastError = deferred == 'bucket' ? 'CPU 余量不足，暂缓自动规划' : deferred == 'budget' ? '等待下一 tick 路线规划预算' : '等待发现可用 Portal，自动重新规划路线'
        return false
    }
    data.route = plan.route
    data.originShard = Game.shard.name
    data.hopIndex = 0
    clearTravelPreparation(data)
    delete data.lastError
    return true
}
