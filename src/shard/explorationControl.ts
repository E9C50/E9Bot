import { addCreepConfig, createCreepName } from 'creep/demand'
import { interShardPolicy } from 'settings/interShard'
import { isShardUnitData, PortalExplorationReport, ShardMission, ShardUnitData } from './missions'
import { getKnownPortals } from './portalIntel'
import { planExplorationEntry } from './explorationRoutes'
import { isPortalRouteKnown } from './routePlanner'
import { isPortalTravelData, isRecord } from './types'
import { routeSignature } from './verification'
import { cancelCreepTransfers } from './transport'
import { getScoutDanger } from './scoutSafety'
import { isLowBucketPlanning, lowBucketPlanningReady } from './planningBudget'

let planningTick = -1
let planningShard = ''
let plansUsed = 0
let scoutDemandTick = -1
let scoutDemandShard = ''
let scoutDemandsUsed = 0
const SCOUT_SAFETY_VERSION = 1

/** 低 bucket 的新 scout 共用每 tick 名额；已有租约重发配置不消耗名额。 */
export function reserveLowBucketScoutDemand(): boolean {
    if (!isLowBucketPlanning()) return true
    if (!lowBucketPlanningReady()) return false
    if (scoutDemandTick != Game.time || scoutDemandShard != Game.shard.name) {
        scoutDemandTick = Game.time; scoutDemandShard = Game.shard.name; scoutDemandsUsed = 0
    }
    const maximum = interShardPolicy.lowBucketPlanning?.maximumScoutDemandsPerTick || 0
    if (scoutDemandsUsed >= maximum) return false
    scoutDemandsUsed++
    return true
}

/** 仅未出生的必要 scout 提高优先级，存活单位及正常 bucket 沿用角色默认值。 */
export function prioritizeLowBucketScout(source: Room, name: string): void {
    if (!isLowBucketPlanning() || Game.creeps[name] != undefined) return
    const config = source.memory.creepConfig?.[name], priority = interShardPolicy.lowBucketPlanning?.scoutSpawnPriority
    if (config != undefined && typeof priority == 'number' && Number.isFinite(priority)) config.spawnPriority = priority
}

function healthyExplorer(creep: Creep | undefined, mission: ShardMission): creep is Creep {
    if (creep == undefined || creep.spawning || creep.memory.role != 'sScout' || !isShardUnitData(creep.memory.data)) return false
    const data = creep.memory.data
    return data.missionId == mission.task.key && data.task.sourceShard == Game.shard.name && data.unitKind == 'scout' &&
        data.exploration != undefined &&
        creep.hits >= creep.hitsMax && (creep.ticksToLive == undefined ||
            creep.ticksToLive > interShardPolicy.portalExploration.minimumRemainingTicks + interShardPolicy.portalExploration.roomTimeout)
}

function reusableExplorer(creep: Creep | undefined, mission: ShardMission): creep is Creep {
    return healthyExplorer(creep, mission) && (creep.memory.data as ShardUnitData).done === true &&
        (creep.memory.data as ShardUnitData).exploration?.reportPending !== true
}

function explorerData(mission: ShardMission, now: number): ShardUnitData {
    const progress = mission.exploration!
    return {
        missionId: mission.task.key, originShard: mission.task.sourceShard, task: mission.task,
        route: progress.entryRoute.map((hop) => ({ ...hop })), hopIndex: 0, unitKind: 'scout', phase: 'outbound',
        exploration: {
            revision: progress.revision, goalShard: mission.task.targetShard, goalRoom: mission.task.targetRoom,
            returnGoal: mission.task.autoReturn ? { shard: mission.task.sourceShard, roomName: mission.task.sourceRoom } : undefined,
            stage: 'outbound', startedAt: progress.startedAt ?? 0, elapsedTicks: 0,
            visitedRooms: progress.visitedRooms.slice(), visitedShards: [mission.task.sourceShard], status: 'exploring',
            excludedRooms: (mission.blockedPortals || []).filter((entry) => entry.until > now).map((entry) => ({
                shard: entry.hop.shard, roomName: entry.hop.roomName, until: entry.until,
            })),
        },
    }
}

function clearLegacyThreatBlocks(mission: ShardMission): boolean {
    if (!mission.blockedPortals?.length) return false
    // 旧版把途经公路的远处攻击兵关联到尚未抵达的门；只撤销有活单位证据的误封。
    const falseBlocks = new Set<string>()
    for (const name in Game.creeps) {
        const unit = Game.creeps[name]
        const data = unit.memory.data
        if (!isShardUnitData(data) || data.missionId !== mission.task.key || data.lastError !== '探门房间存在敌对攻击单位') continue
        const hop = data.routeIssue?.hop
        if (hop !== undefined && hop.shard === Game.shard.name && hop.roomName !== unit.room.name &&
            hop.roomName !== data.exploration?.lastPosition?.roomName) falseBlocks.add(routeSignature([hop]))
    }
    if (!falseBlocks.size) return false
    const count = mission.blockedPortals.length
    mission.blockedPortals = mission.blockedPortals.filter(entry => !falseBlocks.has(routeSignature([entry.hop])))
    return mission.blockedPortals.length !== count
}

function rearmExplorer(mission: ShardMission, creep: Creep, now: number): void {
    const previous = mission.exploration!, existing = mission.leases['explorer:0']
    cancelCreepTransfers(creep)
    // 同身份、同探索版本重试；旧失败报告通过 updatedAt/lastReportAt 隔离。
    mission.exploration = { revision: previous.revision, safetyVersion: SCOUT_SAFETY_VERSION, status: 'exploring', startedAt: now, updatedAt: now,
        lastReportAt: previous.lastReportAt, entryRoute: [], visitedRooms: previous.visitedRooms.slice() }
    mission.leases['explorer:0'] = existing?.name == creep.name ? existing : {
        name: creep.name, displayName: creep.memory.name || creep.name, kind: 'scout', generation: mission.generation,
        createdAt: now, expiresAt: now + interShardPolicy.leaseDuration,
    }
    const lease = mission.leases['explorer:0']
    lease.seenAt = now; lease.locationUpdatedAt = now; lease.expiresAt = now + interShardPolicy.leaseDuration
    lease.lastShard = Game.shard.name; lease.departed = false; lease.leaving = false
    // 从真实位置重新择门，清掉原 sourceRoom 前置路线和所有过门准备。
    creep.memory.data = explorerData(mission, now)
    creep.memory.ready = false; creep.memory.working = false
    delete mission.lastError
}

export function needsPortalExploration(mission: ShardMission): boolean {
    return interShardPolicy.portalExploration.enabled && (mission.task.explorePortals ?? true) && mission.state == 'active' &&
        !!(mission.task.autoRoute || mission.task.autoReturn) && mission.routing?.status != 'ready'
}

export function failPortalExploration(mission: ShardMission, message: string): void {
    const progress = mission.exploration
    if (progress == undefined || progress.status == 'failed' || progress.status == 'complete') return
    progress.status = 'failed'
    progress.lastError = message
    progress.retryAt = Date.now() + interShardPolicy.portalExploration.retryDelay
    mission.lastError = message
}

/** 探索代际与验证路线版本独立，发现新入口不会反复撤回正在中转的探门单位。 */
export function refreshPortalExploration(mission: ShardMission): void {
    const previous = mission.exploration, now = Date.now(), policy = interShardPolicy.portalExploration
    if (!needsPortalExploration(mission)) {
        if (mission.state != 'paused' && previous != undefined && previous.status != 'complete') {
            previous.status = 'complete'; previous.updatedAt = now
        }
        return
    }
    const legacy = previous !== undefined && previous.safetyVersion !== SCOUT_SAFETY_VERSION
    const previousBlocks = mission.blockedPortals
    const blocksChanged = clearLegacyThreatBlocks(mission)
    if (legacy && previous !== undefined) previous.safetyVersion = SCOUT_SAFETY_VERSION
    if (legacy || blocksChanged) {
        const oldBlockedRooms = new Set((previousBlocks || []).map(entry => `${entry.hop.shard}/${entry.hop.roomName}`))
        if (mission.routing !== undefined) mission.routing.nextAttemptTick = Game.time
        if (mission.task.autoRoute) {
            if (previous !== undefined) previous.entryRoute = []
            const current = Game.creeps[mission.leases['explorer:0']?.name || '']
            const data = current?.memory.data
            if (isShardUnitData(data) && data.exploration !== undefined && !data.done && data.hopIndex === 0) {
                // 存量在途探门爬同样撤掉误封后选择的远路，保留身份、版本及已走跳数。
                cancelCreepTransfers(current)
                data.route = []
                delete data.exploration.selectedPortalHop
                delete data.transferPreparedAt; delete data.transferPreparedHop; delete data.transferPreparedShard
                data.exploration.excludedRooms = (data.exploration.excludedRooms || []).filter(entry =>
                    !oldBlockedRooms.has(`${entry.shard}/${entry.roomName}`) ||
                    (mission.blockedPortals || []).some(blocked => blocked.hop.shard === entry.shard && blocked.hop.roomName === entry.roomName))
            }
        }
    }
    const lease = mission.leases['explorer:0'], live = lease == undefined ? undefined : Game.creeps[lease.name]
    if (previous != undefined && ['pending', 'exploring'].includes(previous.status) && lease != undefined && !lease.departed &&
        (lease.lastShard == undefined || lease.lastShard == Game.shard.name)) {
        if (live?.spawning || (live == undefined && lease.seenAt == undefined && previous.startedAt == lease.createdAt)) {
            // 兼容旧版排队时已经开始的时钟；等待孵化不算探索寿命。
            delete previous.startedAt
        } else if (live != undefined && !live.spawning && previous.startedAt == undefined) {
            previous.status = 'exploring'; previous.startedAt = now
            const data = live.memory.data as ShardUnitData
            if (data.exploration != undefined) data.exploration.startedAt = now
        }
        const data = live?.memory.data as ShardUnitData | undefined, waiting = data?.exploration
        if (waiting != undefined && waiting.revision == previous.revision) {
            const currentWait = waiting.cpuWaitStartedAt == undefined ? 0 : Math.max(0, now - waiting.cpuWaitStartedAt)
            previous.cpuWaitMilliseconds = Math.max(previous.cpuWaitMilliseconds || 0, (waiting.cpuWaitMilliseconds || 0) + currentWait)
        }
    }
    if (previous?.status == 'exploring' && previous.startedAt != undefined &&
        now - previous.startedAt - (previous.cpuWaitMilliseconds || 0) >= policy.maximumAge) {
        failPortalExploration(mission, '主动探门超时，等待重新派出 scout')
    }
    if (previous != undefined && (previous.status == 'pending' || previous.status == 'exploring' || now < (previous.retryAt || 0))) return
    if (previous != undefined) {
        const currentName = mission.leases['explorer:0']?.name, current = currentName == undefined ? undefined : Game.creeps[currentName]
        if (healthyExplorer(current, mission)) {
            // 当前近敌单位先等待脱离危险，不以新单位替代并持续堆积退休 scout。
            if (!reusableExplorer(current, mission) || getScoutDanger(current) != undefined) return
            rearmExplorer(mission, current, now); return
        }
        let candidate: Creep | undefined
        for (const name in Game.creeps) {
            const creep = Game.creeps[name]
            if (reusableExplorer(creep, mission) && getScoutDanger(creep) == undefined &&
                (candidate == undefined || (creep.ticksToLive || 0) > (candidate.ticksToLive || 0))) candidate = creep
        }
        if (candidate != undefined) { rearmExplorer(mission, candidate, now); return }
    }
    let entryRoute: ShardMission['task']['route'] = []
    if (isLowBucketPlanning()) {
        // 低预算先发布一只 MOVE scout，从出生后的真实位置逐段探门。
        if (!lowBucketPlanningReady()) return
    } else {
        if (Number.isFinite(Game.cpu.tickLimit) && Game.cpu.tickLimit - Game.cpu.getUsed() < policy.minimumCpuHeadroom) return
        if (planningTick != Game.time || planningShard != Game.shard.name) { planningTick = Game.time; planningShard = Game.shard.name; plansUsed = 0 }
        if (plansUsed >= policy.maximumPlansPerTick) return
        plansUsed++
        const blocked = new Set((mission.blockedPortals || []).filter((entry) => entry.until > now).map((entry) => routeSignature([entry.hop])))
        const portals = getKnownPortals([mission.task.sourceShard, mission.task.targetShard]).filter((hop) => !blocked.has(routeSignature([hop])))
        const task = mission.task
        const outboundKnown = task.route.length > 0 && (!task.autoRoute || isPortalRouteKnown(task.route, portals))
        entryRoute = outboundKnown && !task.autoRoute ? task.route.map((hop) => ({ ...hop })) :
            planExplorationEntry(task.sourceShard, task.sourceRoom, task.targetShard, task.targetRoom, portals)
    }
    mission.exploration = {
        revision: `${mission.createdAt}:explore:${++mission.generation}`, safetyVersion: SCOUT_SAFETY_VERSION, status: 'pending', entryRoute,
        visitedRooms: previous?.visitedRooms.slice(-policy.maximumVisitedRooms) || [], updatedAt: now,
    }
    delete mission.leases['explorer:0']
}

export function keepPortalExplorer(mission: ShardMission, data: ShardUnitData, name?: string): boolean {
    const lease = mission.leases['explorer:0']
    return needsPortalExploration(mission) && ['pending', 'exploring'].includes(mission.exploration?.status || '') && data.unitKind == 'scout' &&
        data.exploration != undefined && data.exploration.revision == mission.exploration?.revision &&
        (name == undefined || (name == lease?.name && !lease.departed && (lease.lastShard == undefined || lease.lastShard == Game.shard.name)))
}

/** 仅 source 派一只探门 scout；没有 Spawn 的中转 shard 只执行恢复和移动。 */
export function releasePortalExplorer(mission: ShardMission, source: Room): void {
    if (!needsPortalExploration(mission)) return
    const now = Date.now(), policy = interShardPolicy.portalExploration
    refreshPortalExploration(mission)
    const progress = mission.exploration
    if (progress == undefined || progress.status == 'failed' || progress.status == 'complete' || now < (progress.retryAt || 0)) return
    let lease = mission.leases['explorer:0']
    if (lease != undefined && lease.seenAt == undefined && !lease.departed && !lease.leaving &&
        (lease.lastShard == undefined || lease.lastShard == Game.shard.name)) lease.expiresAt = now + interShardPolicy.leaseDuration
    if (lease != undefined && Game.creeps[lease.name] == undefined &&
        (lease.expiresAt <= now || (lease.seenAt != undefined && lease.lastShard == Game.shard.name && !lease.departed && !lease.leaving))) {
        failPortalExploration(mission, '探门 scout 死亡或失联，等待重试')
        return
    }
    if (lease == undefined) {
        if (!reserveLowBucketScoutDemand()) return
        const generation = ++mission.generation
        const displayName = `${mission.task.key}_explorer_${generation}_${mission.createdAt}`
        lease = mission.leases['explorer:0'] = {
            name: createCreepName('sScout', displayName), displayName, kind: 'scout', generation,
            createdAt: now, expiresAt: now + interShardPolicy.leaseDuration,
        }
        progress.status = 'exploring'
    }
    if (lease.departed || (lease.lastShard != undefined && lease.lastShard != Game.shard.name)) return
    const live = Game.creeps[lease.name]
    const data = live != undefined && isShardUnitData(live.memory.data) ? live.memory.data : explorerData(mission, now)
    const name = addCreepConfig(source, 'sScout', lease.displayName, data)
    // 历史单位的显示名可能缺失，源配置仍必须沿用实际 Creep 名，不能另生一个 hash 名。
    if (typeof name == 'string' && name != lease.name && source.memory.creepConfig[name] != undefined) {
        source.memory.creepConfig[lease.name] = source.memory.creepConfig[name]
        delete source.memory.creepConfig[name]
        source.memory.creepConfig[lease.name].displayName = lease.name
    }
    prioritizeLowBucketScout(source, lease.name)
}

/** 情报报告只维护探索状态，绝不代替完整路线的 scoutProof。 */
export function acceptPortalExplorationReport(mission: ShardMission, value: unknown, peer: string): boolean {
    const progress = mission.exploration, lease = mission.leases['explorer:0'], now = Date.now(), policy = interShardPolicy.portalExploration
    if (!needsPortalExploration(mission) || progress == undefined || progress.status == 'failed' || lease == undefined ||
        !isRecord(value) || value.missionId != mission.task.key || value.sourceShard != mission.task.sourceShard || value.explorerName != lease.name ||
        value.revision != progress.revision || value.shard != peer || typeof value.roomName != 'string' || !/^[WE]\d+[NS]\d+$/.test(value.roomName) ||
        typeof value.updatedAt != 'number' || !Number.isFinite(value.updatedAt) || value.updatedAt < lease.createdAt || value.updatedAt > now ||
        now - value.updatedAt >= policy.reportMaxAge || value.updatedAt < (progress.updatedAt || 0) || value.updatedAt <= (progress.lastReportAt ?? -Infinity) ||
        !['exploring', 'failed', 'complete'].includes(String(value.status)) || !Number.isInteger(value.elapsedTicks) || (value.elapsedTicks as number) < 0 ||
        (value.cpuWaitMilliseconds != undefined && (typeof value.cpuWaitMilliseconds != 'number' ||
            !Number.isFinite(value.cpuWaitMilliseconds) || value.cpuWaitMilliseconds < 0)) ||
        !Array.isArray(value.visitedRooms) || value.visitedRooms.length > policy.maximumVisitedRooms ||
        !value.visitedRooms.every((room) => typeof room == 'string' && /^[^/]+\/[WE]\d+[NS]\d+$/.test(room)) ||
        (value.route != undefined && (!Array.isArray(value.route) || value.route.length > interShardPolicy.portalRouting.maximumHops ||
            !isPortalTravelData({ missionId: mission.task.key, originShard: mission.task.sourceShard, route: value.route, hopIndex: 0 })))) return false
    const report = value as unknown as PortalExplorationReport
    if (report.status == 'complete' && (report.shard != (mission.task.autoReturn ? mission.task.sourceShard : mission.task.targetShard) ||
        report.roomName != (mission.task.autoReturn ? mission.task.sourceRoom : mission.task.targetRoom))) return false
    if (report.failedHop != undefined && (!isRecord(report.failedHop) || !report.route?.some((hop) => routeSignature([hop]) == routeSignature([report.failedHop!])))) return false
    progress.updatedAt = report.updatedAt
    if (progress.startedAt == undefined) progress.startedAt = report.updatedAt
    progress.cpuWaitMilliseconds = Math.max(progress.cpuWaitMilliseconds || 0, report.cpuWaitMilliseconds || 0)
    progress.lastReportAt = report.updatedAt
    progress.lastShard = peer; progress.lastRoom = report.roomName
    progress.visitedRooms = Array.from(new Set([...progress.visitedRooms, ...report.visitedRooms])).slice(-policy.maximumVisitedRooms)
    lease.seenAt = now; lease.expiresAt = now + interShardPolicy.leaseDuration
    // 探索进度与位置事件分别处理：前一 tick 的本地失败报告仍应被采纳，
    // 但它不能覆盖当前本地视野或更新的跨门位置。
    if (Game.creeps[lease.name] == undefined && report.updatedAt >= (lease.locationUpdatedAt ?? lease.acknowledgedAt ?? lease.createdAt)) {
        lease.lastShard = peer; lease.departed = peer != mission.task.sourceShard
        lease.locationUpdatedAt = report.updatedAt
    }
    if (report.lastError) { progress.lastError = report.lastError; mission.lastError = report.lastError }
    if (report.status == 'failed') {
        failPortalExploration(mission, report.lastError || 'scout 主动探门失败')
        if (report.failedHop != undefined) {
            const blocked = (mission.blockedPortals || []).filter((entry) => entry.until > now && routeSignature([entry.hop]) != routeSignature([report.failedHop!]))
            blocked.push({ hop: { ...report.failedHop }, until: now + interShardPolicy.routeScouting.blockedPortalTtl })
            mission.blockedPortals = blocked.slice(-interShardPolicy.routeScouting.maximumBlockedPortals)
            if (mission.routing != undefined) mission.routing.nextAttemptTick = Game.time
        }
    } else if (report.status == 'complete') {
        // 等待目录合并与全图规划，报告到达不能放行工作单位。
        progress.status = 'complete'; progress.retryAt = now + policy.retryDelay
    }
    return true
}
