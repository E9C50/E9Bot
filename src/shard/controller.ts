import { addCreepConfig, createCreepName } from 'creep/demand'
import { interShardPolicy } from 'settings/interShard'
import { isCpuProfilingEnabled, profileCpuTask } from 'runtime/profiling'
import { ShardMission, ShardMissionReport, ShardMissionState, ShardTaskInput, ShardTaskSpec, ShardUnitData, ShardUnitKind, ShardUnitLease, isShardUnitData } from './missions'
import { flushInterShardMemory, getLocalShardState, getShardTransportError, markShardStateDirty, readRemoteShardState, restoreArrivingCreeps } from './transport'
import { isPortalTravelData, isRecord } from './types'
import { runPortalDiscovery, getKnownPortals, getPortalIntelStatus } from './portalIntel'
import { updateMissionRouting } from './routing'
import { acceptScoutProof, failMissionScouting, isMissionVerified, refreshMissionScouting, requiresRouteScouting, routeSignature, scoutNeedsReturn } from './verification'
import { acceptPortalExplorationReport, failPortalExploration, keepPortalExplorer, prioritizeLowBucketScout, refreshPortalExploration, releasePortalExplorer, reserveLowBucketScoutDemand } from './explorationControl'
import { createShardArrivalReport } from './state'
export { recordShardDelivery } from './state'

const roles: Record<ShardUnitKind, ShardRoleConstant> = { claimer: 'sClaimer', builder: 'sBuilder', hauler: 'sHauler', scout: 'sScout' }
const ROOM_NAME = /^[WE]\d+[NS]\d+$/

/** 本地非孵化单位或远端存在证据确认出生后，才启动 scout 的源任务时钟。 */
function confirmScoutBirth(mission: ShardMission, lease: ShardUnitLease, now: number, data?: ShardUnitData): void {
    if (lease.kind != 'scout') return
    if (mission.leases['explorer:0']?.name == lease.name) {
        const progress = mission.exploration
        if (progress == undefined || !['pending', 'exploring'].includes(progress.status)) return
        progress.status = 'exploring'
        if (progress.startedAt == undefined) progress.startedAt = now
        if (data?.exploration != undefined && data.exploration.startedAt <= 0) data.exploration.startedAt = progress.startedAt
    } else {
        const progress = mission.scouting
        if (progress == undefined || !['pending', 'scouting'].includes(progress.status)) return
        progress.status = 'scouting'
        if (progress.startedAt == undefined) progress.startedAt = now
    }
}

function tasks(): Record<string, ShardMission> {
    return Memory.shardMissions || (Memory.shardMissions = {})
}

function keyFor(id: string): string {
    return id.includes(':') ? id : `${Game.shard.name}:${id}`
}

/** 撤回已过期的孵化配置（包括仍存活单位的配置），不会修改在途单位 Memory。 */
function withdrawQueuedUnits(mission: ShardMission, keep: (data: ShardUnitData, name: string) => boolean = () => false): void {
    const source = Game.rooms[mission.task.sourceRoom]
    if (source == undefined) return
    for (const [name, config] of Object.entries(source.memory.creepConfig || {})) {
        if (isShardUnitData(config.data) && config.data.missionId == mission.task.key && !keep(config.data, name)) delete source.memory.creepConfig[name]
    }
    source.memory.creepSpawnQueue = (source.memory.creepSpawnQueue || []).filter((name) => source.memory.creepConfig?.[name] != undefined)
}

function command(mission: ShardMission, heartbeat = false): void {
    const local = getLocalShardState()
    if (local.reports == undefined) local.reports = {}
    const previous = local.reports[mission.task.key]
    if (!heartbeat && isRecord(previous) && previous.type == 'command' && previous.state == mission.state &&
        previous.scoutRevision == mission.scouting?.revision && previous.scoutStatus == mission.scouting?.status &&
        previous.explorerRevision == mission.exploration?.revision && previous.explorerStatus == mission.exploration?.status &&
        (!requiresRouteScouting(mission.task) || isMissionVerified(mission) == isRecord(previous.verification))) return
    // 只有已实地验证的路线可供在途工作单位换线；候选路线不会被广播为可用路线。
    local.reports[mission.task.key] = {
        type: 'command', state: mission.state, missionId: mission.task.key, updatedAt: Date.now(),
        scoutRevision: mission.scouting?.revision, scoutStatus: mission.scouting?.status,
        explorerRevision: mission.exploration?.revision, explorerStatus: mission.exploration?.status,
        verification: requiresRouteScouting(mission.task) && isMissionVerified(mission) ? {
            revision: mission.scouting!.revision, verifiedAt: mission.scouting!.verifiedAt,
            route: mission.task.route.map((hop) => ({ ...hop })),
            returnRoute: scoutNeedsReturn(mission.task) ? mission.task.returnRoute!.map((hop) => ({ ...hop })) : undefined,
            outboundTicks: mission.scouting!.outboundTicks, returnTicks: mission.scouting!.returnTicks,
        } : undefined,
    }
    markShardStateDirty()
}

/** 只创建配置任务；实际派工经过常规人口/孵化队列。 */
export function createShardTask(inputOrSource: ShardTaskInput | string, target?: string, options: Partial<ShardTaskInput> = {}): string {
    if (!interShardPolicy.enabled || typeof InterShardMemory === 'undefined') return '跨 shard 通信未启用或当前环境不支持 InterShardMemory'
    let input: ShardTaskInput
    if (typeof inputOrSource == 'string') {
        const source = inputOrSource.split('/')
        const destination = typeof target == 'string' ? target.split('/') : undefined
        if (source.length > 2 || (source.length == 2 && source[0] != Game.shard.name) || destination?.length != 2) return '使用 shardTask("起点房间", "目标shard/终点房间", 可选配置)'
        input = { ...options, sourceRoom: source[source.length - 1], targetShard: destination[0], targetRoom: destination[1] }
    } else input = inputOrSource
    if (!isRecord(input)) return '须提供任务配置或起点与终点房间'
    const id = input.id === undefined ? `auto_${input.sourceRoom}_${input.targetShard}_${input.targetRoom}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) : input.id
    if (typeof id != 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return '任务 id 须为 1..64 位字母、数字、下划线或短横线'
    if (typeof input.sourceRoom != 'string' || typeof input.targetRoom != 'string' || typeof input.targetShard != 'string' ||
        !ROOM_NAME.test(input.sourceRoom) || !ROOM_NAME.test(input.targetRoom) || !input.targetShard || input.targetShard == Game.shard.name) return '须指定有效起点房间及另一个 shard 的目标房间'
    const source = Game.rooms[input.sourceRoom]
    if (!source?.controller?.my || source.find(FIND_MY_SPAWNS).length == 0) return '起点须为当前 shard 有 Spawn 的自有房间'
    const autoRoute = input.route === undefined
    if (!autoRoute && (!isPortalTravelData({ missionId: id, originShard: Game.shard.name, route: input.route, hopIndex: 0 }) ||
        !Array.isArray(input.route) ||
        input.route.length == 0 || input.route.some((hop) => hop.shard == hop.destinationShard) ||
        input.route[input.route.length - 1].destinationShard != input.targetShard)) return '出发路线须从当前 shard 开始，逐跳连通并到达目标 shard'
    if (input.returnRoute != undefined && (!isPortalTravelData({ missionId: id, originShard: input.targetShard, route: input.returnRoute, hopIndex: 0 }) ||
        input.returnRoute.length == 0 || input.returnRoute.some((hop) => hop.shard == hop.destinationShard) ||
        input.returnRoute[input.returnRoute.length - 1].destinationShard != Game.shard.name)) return '返程路线须从目标 shard 开始并回到起点 shard'
    const builders = input.builders ?? 2
    const haulers = input.haulers ?? 0
    const claim = input.claim ?? true
    const targetLevel = input.targetLevel ?? interShardPolicy.defaultTargetLevel
    const energyAmount = input.energyAmount ?? 0
    const reserve = input.homeEnergyReserve ?? interShardPolicy.minimumHomeEnergyReserve
    if (typeof claim != 'boolean' || (input.roundTrip != undefined && typeof input.roundTrip != 'boolean') || (input.verifyRoute != undefined && typeof input.verifyRoute != 'boolean') || (input.explorePortals != undefined && typeof input.explorePortals != 'boolean') || [input.sourceEnergyId, input.targetEnergyId].some((id) => id != undefined && typeof id != 'string') ||
        ![builders, haulers, targetLevel, energyAmount, reserve].every(Number.isInteger) || builders < 0 || haulers < 0 ||
        builders + haulers + (claim ? 1 : 0) > interShardPolicy.maximumUnitsPerTask || targetLevel < 1 || targetLevel > 8 || energyAmount < 0 || reserve < 0 ||
        (!claim && builders == 0 && haulers == 0)) return '人数、目标等级、能量量和保留库存无效，或超过任务人数上限'
    if (claim && source.energyCapacityAvailable < BODYPART_COST[CLAIM] + BODYPART_COST[MOVE]) return '起点能量容量不足以孵化跨 shard claimer'
    const all = tasks()
    const key = keyFor(id)
    if (all[key] != undefined) return `任务已存在：${key}`
    if (Object.values(all).filter((mission) => mission.state == 'active' || mission.state == 'paused').length >= interShardPolicy.maximumTasks) return '已达到跨 shard 活动任务上限'
    const autoReturn = input.returnRoute == undefined && haulers > 0 && input.roundTrip !== false && (autoRoute || input.roundTrip === true)
    const task: ShardTaskSpec = {
        ...input, id, sourceShard: Game.shard.name, key, claim, builders, haulers, targetLevel, autoRoute,
        autoReturn, verifyRoute: input.verifyRoute ?? (autoRoute || autoReturn), explorePortals: input.explorePortals ?? (autoRoute || autoReturn),
        energyAmount, homeEnergyReserve: reserve,
        route: input.route?.map((hop) => ({ ...hop })) || [], returnRoute: input.returnRoute?.map((hop) => ({ ...hop })),
    }
    all[key] = { task, state: 'active', createdAt: Date.now(), generation: 0, leases: {}, energyDelivered: 0 }
    updateMissionRouting(all[key], true)
    refreshMissionScouting(all[key])
    refreshPortalExploration(all[key])
    command(all[key])
    if (!flushInterShardMemory()) all[key].lastError = getShardTransportError()
    return `已创建：${key}${all[key].routing?.status == 'waiting' ? '；' + all[key].routing!.message : ''}`
}

export function setShardTaskState(id: string, state: ShardMissionState): string {
    const mission = tasks()[keyFor(id)]
    if (mission == undefined) return '任务不存在'
    if (!['active', 'paused', 'cancelled'].includes(state)) return '只支持 active / paused / cancelled'
    mission.state = state
    if (state == 'active') {
        updateMissionRouting(mission, true)
        refreshMissionScouting(mission)
        refreshPortalExploration(mission)
        if (!isMissionVerified(mission) || ((mission.task.autoRoute || mission.task.autoReturn) && mission.routing?.status != 'ready')) withdrawQueuedUnits(mission)
    }
    if (state != 'active') {
        const room = Game.rooms[mission.task.sourceRoom]
        if (room != undefined) {
            for (const [name, config] of Object.entries(room.memory.creepConfig || {})) {
                if (isShardUnitData(config.data) && config.data.missionId == mission.task.key) delete room.memory.creepConfig[name]
            }
            room.memory.creepSpawnQueue = (room.memory.creepSpawnQueue || []).filter((name) => room.memory.creepConfig?.[name] != undefined)
        }
    }
    command(mission)
    flushInterShardMemory()
    return `${mission.task.key}: ${state}`
}

export function listShardTasks(): string {
    return JSON.stringify(Object.values(tasks()).map((mission) => ({
        id: mission.task.id, key: mission.task.key, state: mission.state,
        from: `${mission.task.sourceShard}/${mission.task.sourceRoom}`,
        to: `${mission.task.targetShard}/${mission.task.targetRoom}`,
        targetOwned: mission.targetOwned, level: mission.targetLevel, spawns: mission.targetSpawns,
        energyDelivered: mission.energyDelivered, energyGoal: mission.task.energyAmount,
        routing: mission.routing, exploration: mission.exploration, scouting: mission.scouting, route: mission.task.route, returnRoute: mission.task.returnRoute,
        units: Object.values(mission.leases).map((lease) => ({ name: lease.name, kind: lease.kind, shard: lease.lastShard, departed: lease.departed })),
        lastError: mission.lastError,
    })), null, 2)
}

/** 控制台读取当前有视野的跨 shard Portal，坐标可直接用于 route。 */
export function listShardPortals(): string {
    return JSON.stringify({ ...getPortalIntelStatus(), portals: getKnownPortals(peerShards()) }, null, 2)
}

function peerShards(): string[] {
    const peers = new Set(interShardPolicy.peers)
    for (const mission of Object.values(tasks())) {
        peers.add(mission.task.targetShard)
        for (const hop of [...mission.task.route, ...(mission.task.returnRoute || [])]) {
            peers.add(hop.shard); peers.add(hop.destinationShard)
        }
    }
    for (const record of Object.values(Memory.shardArrivals || {})) peers.add(record.task.sourceShard)
    peers.delete(Game.shard.name)
    return Array.from(peers)
}

function acceptRouteIssue(mission: ShardMission, issue: ShardUnitData['routeIssue']): void {
    if (!isMissionVerified(mission) || !requiresRouteScouting(mission.task) || !isRecord(issue) ||
        typeof issue.updatedAt != 'number' || issue.updatedAt > Date.now() || issue.updatedAt <= (mission.scouting?.verifiedAt || 0) ||
        !isRecord(issue.hop) || ![...mission.task.route, ...(mission.task.returnRoute || [])].some((hop) => routeSignature([hop]) == routeSignature([issue.hop]))) return
    failMissionScouting(mission, typeof issue.message == 'string' ? issue.message : '工作单位发现路线失效，等待重新侦察', issue.hop)
    withdrawQueuedUnits(mission)
    command(mission)
}

function acceptReport(mission: ShardMission, report: ShardMissionReport): void {
    const now = Date.now()
    if (!isRecord(report) || report.type != 'status' || report.missionId != mission.task.key || report.originShard != Game.shard.name ||
        !Number.isFinite(report.updatedAt) || report.updatedAt > now || now - report.updatedAt > interShardPolicy.reportMaxAge || !Array.isArray(report.units) ||
        !report.units.every((unit) => isRecord(unit) && typeof unit.name == 'string' && ['claimer', 'builder', 'hauler', 'scout'].includes(String(unit.kind)))) return
    for (const [slot, lease] of Object.entries(mission.leases)) {
        if (Game.creeps[lease.name] != undefined) continue
        // 多 shard 读取顺序不等于实际移动顺序；旧快照不能将已过门单位拉回旧位置。
        if (report.updatedAt < (lease.locationUpdatedAt ?? lease.acknowledgedAt ?? lease.createdAt)) continue
        const unit = report.units.find((item) => item.name == lease.name)
        if (unit != undefined) {
            if (unit.kind != lease.kind) continue
            confirmScoutBirth(mission, lease, report.updatedAt)
            if (unit.done && lease.kind != 'scout') { delete mission.leases[slot]; continue }
            lease.seenAt = now
            lease.expiresAt = now + interShardPolicy.leaseDuration
            lease.lastShard = report.shard
            lease.departed = report.shard != Game.shard.name
            lease.locationUpdatedAt = report.updatedAt
            if (unit.error) mission.lastError = unit.error
            if (lease.kind != 'scout') acceptRouteIssue(mission, unit.routeIssue)
        } else if (lease.lastShard == report.shard && lease.seenAt != undefined &&
            now - lease.seenAt > interShardPolicy.missingUnitGrace && report.updatedAt > lease.seenAt) {
            if (lease.kind == 'scout') {
                if (slot == 'explorer:0') failPortalExploration(mission, '探门 scout 在途中失联，等待重试')
                else if (mission.scouting?.status == 'scouting') failMissionScouting(mission, 'scout 在途中失联，等待重新侦察')
            } else delete mission.leases[slot]
        }
    }
    if (report.shard != mission.task.targetShard) return
    mission.lastReportAt = report.updatedAt
    mission.energyDelivered = Math.max(mission.energyDelivered, Number.isFinite(report.energyDelivered) ? report.energyDelivered : 0)
    mission.targetOwned = report.targetOwned
    mission.targetLevel = report.targetLevel
    mission.targetSpawns = report.targetSpawns
    const buildGoal = !mission.task.claim && mission.task.builders == 0 ||
        (report.targetOwned === true && (report.targetLevel || 0) >= mission.task.targetLevel && (report.targetSpawns || 0) > 0)
    const haulGoal = mission.task.haulers == 0 || (mission.task.energyAmount > 0 && mission.energyDelivered >= mission.task.energyAmount)
    if (mission.state == 'active' && isMissionVerified(mission) && buildGoal && haulGoal) {
        mission.state = 'complete'
        withdrawQueuedUnits(mission)
        command(mission, true)
    }
}

/** 每 tick 先恢复入境 Memory；报告与维护按周期发布，不进行全 shard Creep 扫描式补兵。 */
export function runShardController(): void {
    if (!interShardPolicy.enabled) return
    const profiling = isCpuProfilingEnabled()
    if (profiling) profileCpuTask('shard:portalDiscovery', runPortalDiscovery)
    else runPortalDiscovery()
    for (const mission of Object.values(tasks())) {
        if (mission.state == 'active') {
            const revision = mission.scouting?.revision
            const routingStatus = mission.routing?.status
            const explorationState = `${mission.exploration?.revision}:${mission.exploration?.status}`
            if (profiling) profileCpuTask('shard:routing', () => updateMissionRouting(mission))
            else updateMissionRouting(mission)
            refreshMissionScouting(mission)
            refreshPortalExploration(mission)
            if (revision != mission.scouting?.revision) command(mission)
            if (explorationState != `${mission.exploration?.revision}:${mission.exploration?.status}`) command(mission)
            if (revision != mission.scouting?.revision || routingStatus != mission.routing?.status || explorationState != `${mission.exploration?.revision}:${mission.exploration?.status}`) {
                if ((mission.task.autoRoute || mission.task.autoReturn) && mission.routing?.status != 'ready') withdrawQueuedUnits(mission, (data, name) => keepPortalExplorer(mission, data, name))
                else if (!isMissionVerified(mission)) withdrawQueuedUnits(mission, (data) => data.unitKind == 'scout' &&
                    mission.scouting?.status != 'failed' && data.scouting?.revision == mission.scouting?.revision)
                else withdrawQueuedUnits(mission, (data) => data.exploration == undefined)
            }
        }
    }
    const peers = peerShards()
    if (profiling) profileCpuTask('shard:restoreArrivals', () => restoreArrivingCreeps(peers))
    else restoreArrivingCreeps(peers)
    const now = Date.now()
    const reporting = Game.time % interShardPolicy.reportInterval == 0
    const unitsByMission = reporting ? new Map<string, ShardMissionReport['units']>() : undefined
    for (const mission of Object.values(tasks())) {
        for (const lease of Object.values(mission.leases)) {
            const creep = Game.creeps[lease.name]
            if (creep == undefined) {
                if (lease.seenAt != undefined && lease.lastShard == Game.shard.name) lease.departed = lease.leaving === true
                continue
            }
            lease.seenAt = now
            lease.expiresAt = now + interShardPolicy.leaseDuration
            lease.lastShard = Game.shard.name
            lease.departed = false
            lease.locationUpdatedAt = now
            const data = creep.memory.data as ShardUnitData
            if (!creep.spawning) confirmScoutBirth(mission, lease, now, data)
            lease.leaving = data.transferPreparedAt != undefined
            if (data.lastError) mission.lastError = data.lastError
            if (lease.kind != 'scout') acceptRouteIssue(mission, data.routeIssue)
        }
    }
    for (const name in Game.creeps) {
        const creep = Game.creeps[name]
        if (!isShardUnitData(creep.memory?.data)) continue
        const data = creep.memory.data
        if (data.task.sourceShard == Game.shard.name) continue
        const arrivals = Memory.shardArrivals || (Memory.shardArrivals = {})
        const record = arrivals[data.missionId] || (arrivals[data.missionId] = { task: data.task, updatedAt: now, energyDelivered: 0 })
        record.updatedAt = now
        if (unitsByMission != undefined) {
            const units = unitsByMission.get(data.missionId) || []
            units.push({ name: creep.name, kind: data.unitKind, done: data.done === true, ttl: creep.ticksToLive, error: data.lastError, routeIssue: data.routeIssue })
            unitsByMission.set(data.missionId, units)
        }
    }
    if (!reporting) return
    for (const mission of Object.values(tasks())) {
        if (mission.state != 'active' && mission.state != 'paused') continue
        const scoutingStatus = mission.scouting?.status
        const explorationStatus = mission.exploration?.status
        const localExploration = getLocalShardState().explorationReports
        if (isRecord(localExploration)) acceptPortalExplorationReport(mission, localExploration[mission.task.key], Game.shard.name)
        const localProofs = getLocalShardState().scoutProofs
        if (isRecord(localProofs)) for (const leg of ['outbound', 'return']) acceptScoutProof(mission, localProofs[`${mission.task.key}:${leg}`], Game.shard.name)
        for (const peer of peers) {
            const remote = readRemoteShardState(peer)
            const remoteProofs = remote?.scoutProofs
            const remoteExploration = remote?.explorationReports
            if (isRecord(remoteExploration)) acceptPortalExplorationReport(mission, remoteExploration[mission.task.key], peer)
            if (isRecord(remoteProofs)) for (const leg of ['outbound', 'return']) acceptScoutProof(mission, remoteProofs[`${mission.task.key}:${leg}`], peer)
            // 确认入境的位置，即便单位在首次状态报告前死亡，也能在 grace 后补员。
            for (const lease of Object.values(mission.leases)) {
                if (Game.creeps[lease.name] != undefined) continue
                for (const ack of Object.values(remote?.acks || {})) {
                    if (!isRecord(ack) || ack.creepName != lease.name || ack.fromShard != peer ||
                        typeof ack.createdAt != 'number' || ack.createdAt < lease.createdAt ||
                        ack.createdAt < (lease.locationUpdatedAt ?? lease.acknowledgedAt ?? lease.createdAt) ||
                        typeof ack.expiresAt != 'number' || ack.expiresAt <= now || ack.createdAt <= (lease.acknowledgedAt || 0) ||
                        (!mission.task.autoRoute && !mission.task.autoReturn && ![...mission.task.route, ...(mission.task.returnRoute || [])].some((hop) => hop.shard == ack.toShard && hop.destinationShard == peer))) continue
                    lease.acknowledgedAt = ack.createdAt
                    confirmScoutBirth(mission, lease, ack.createdAt)
                    lease.lastShard = peer
                    lease.departed = true
                    lease.locationUpdatedAt = ack.createdAt
                    lease.seenAt = Math.max(lease.seenAt || 0, ack.createdAt)
                    lease.expiresAt = now + interShardPolicy.leaseDuration
                }
            }
            const report = remote?.reports?.[mission.task.key] as ShardMissionReport | undefined
            if (report != undefined) acceptReport(mission, report)
        }
        const error = getShardTransportError()
        if (error != undefined) mission.lastError = error
        if (scoutingStatus != 'failed' && mission.scouting?.status == 'failed') withdrawQueuedUnits(mission)
        if (explorationStatus != 'failed' && mission.exploration?.status == 'failed') withdrawQueuedUnits(mission)
        command(mission, true)
    }
    const local = getLocalShardState()
    for (const [key, record] of Object.entries(Memory.shardArrivals || {})) {
        if (record.task.sourceShard == Game.shard.name) continue
        if (now - record.updatedAt > interShardPolicy.arrivalHistoryTtl) {
            delete Memory.shardArrivals![key]
            if (local.reports) delete local.reports[key]
            markShardStateDirty()
            continue
        }
        const report = createShardArrivalReport(key, record, unitsByMission!.get(key) || [])
        if (local.reports == undefined) local.reports = {}
        local.reports[key] = report
        markShardStateDirty()
    }
}

/** source shard 使用有租约的逻辑槽位；离开本 shard 的 Creep 不被当作死亡。 */
export function releaseShardCreepConfig(): void {
    if (!interShardPolicy.enabled) return
    const now = Date.now()
    for (const mission of Object.values(tasks())) {
        if (mission.state != 'active') continue
        const source = Game.rooms[mission.task.sourceRoom]
        if (!source?.controller?.my || source.find(FIND_MY_SPAWNS).length == 0) continue
        refreshMissionScouting(mission)
        refreshPortalExploration(mission)
        if ((mission.task.autoRoute || mission.task.autoReturn) && mission.routing?.status != 'ready') {
            releasePortalExplorer(mission, source)
            withdrawQueuedUnits(mission, (data, name) => keepPortalExplorer(mission, data, name))
            command(mission)
            continue
        }
        if (requiresRouteScouting(mission.task) && mission.scouting?.status == 'scouting') {
            const scout = mission.leases['scout:0']
            const live = scout == undefined ? undefined : Game.creeps[scout.name]
            if (scout != undefined && !scout.departed && (scout.lastShard == undefined || scout.lastShard == Game.shard.name)) {
                if (live?.spawning || (live == undefined && scout.seenAt == undefined && mission.scouting.startedAt == scout.createdAt)) {
                    // 排队或正在孵化的存量任务也清除旧的提前计时。
                    delete mission.scouting.startedAt
                } else if (live != undefined && !live.spawning) confirmScoutBirth(mission, scout, now, live.memory.data as ShardUnitData)
                if (scout.seenAt == undefined) scout.expiresAt = now + interShardPolicy.leaseDuration
            }
            if (scout != undefined && Game.creeps[scout.name] == undefined &&
                (scout.expiresAt <= now || (scout.seenAt != undefined && scout.lastShard == Game.shard.name && !scout.departed && !scout.leaving))) {
                failMissionScouting(mission, 'scout 死亡或租约超时，等待重新侦察')
            } else if (mission.scouting.startedAt != undefined && now - mission.scouting.startedAt >= interShardPolicy.routeScouting.maximumScoutingAge) {
                failMissionScouting(mission, 'scout 侦察超时，等待重新侦察')
            }
        }
        const verified = isMissionVerified(mission)
        const counts: Record<ShardUnitKind, number> = {
            claimer: verified && mission.task.claim && !mission.targetOwned ? 1 : 0,
            builder: verified ? mission.task.builders : 0,
            hauler: verified && !(mission.task.energyAmount > 0 && mission.energyDelivered >= mission.task.energyAmount) ? mission.task.haulers : 0,
            scout: !verified && mission.scouting?.status != 'failed' && now >= (mission.scouting?.retryAt || 0) ? 1 : 0,
        }
        // 失效的候选路线和过期证明必须撤回尚未出生的派工。
        for (const [name, config] of Object.entries(source.memory.creepConfig || {})) {
            if (!isShardUnitData(config.data) || config.data.missionId != mission.task.key) continue
            if (counts[config.data.unitKind] == 0 || (config.data.exploration != undefined && !keepPortalExplorer(mission, config.data)) ||
                !Object.values(mission.leases).some((lease) => lease.name == name)) delete source.memory.creepConfig[name]
        }
        source.memory.creepSpawnQueue = (source.memory.creepSpawnQueue || []).filter((name) => source.memory.creepConfig?.[name] != undefined)
        for (const kind of Object.keys(counts) as ShardUnitKind[]) {
            for (let slot = 0; slot < counts[kind]; slot++) {
                const slotKey = `${kind}:${slot}`
                let lease: ShardUnitLease | undefined = mission.leases[slotKey]
                if (lease != undefined && !Game.creeps[lease.name] &&
                    (lease.expiresAt < now || (lease.seenAt != undefined && lease.lastShard == Game.shard.name && !lease.departed && !lease.leaving))) {
                    delete mission.leases[slotKey]
                    lease = undefined
                }
                if (lease == undefined) {
                    if (kind == 'scout' && !reserveLowBucketScoutDemand()) continue
                    const generation = ++mission.generation
                    const displayName = `${mission.task.key}_${kind}_${slot}_${generation}_${mission.createdAt}`
                    lease = mission.leases[slotKey] = {
                        name: createCreepName(roles[kind], displayName), displayName, kind, generation,
                        createdAt: now, expiresAt: now + interShardPolicy.leaseDuration,
                    }
                }
                if (lease.departed || (lease.lastShard != undefined && lease.lastShard != Game.shard.name)) continue
                const data: ShardUnitData = {
                    missionId: mission.task.key, originShard: mission.task.sourceShard,
                    task: mission.task, route: mission.task.route, hopIndex: 0, unitKind: kind,
                    phase: kind == 'hauler' ? 'load' : 'outbound',
                }
                if (kind == 'scout') {
                    const scouting = mission.scouting!
                    if (scouting.status == 'pending') scouting.status = 'scouting'
                    data.scouting = {
                        revision: scouting.revision, leg: 'outbound', elapsedTicks: 0,
                        outboundRoute: mission.task.route.map((hop) => ({ ...hop })),
                        returnRoute: scoutNeedsReturn(mission.task) ? mission.task.returnRoute!.map((hop) => ({ ...hop })) : undefined,
                    }
                }
                addCreepConfig(source, roles[kind], lease.displayName, data)
                if (kind == 'scout') prioritizeLowBucketScout(source, lease.name)
            }
        }
        if (requiresRouteScouting(mission.task)) command(mission)
    }
}
