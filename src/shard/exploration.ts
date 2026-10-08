import { interShardPolicy } from 'settings/interShard'
import { isShardUnitData, PortalExplorationReport, ShardUnitData } from './missions'
import { getExplorationRooms, isExplorationPlanningDeferred, selectExplorationPortal } from './explorationRoutes'
import { forgetPortal, getKnownPortals, runPortalDiscovery } from './portalIntel'
import { cancelCreepTransfers, flushInterShardMemory, getLocalShardState, getShardTransportError, markShardStateDirty } from './transport'
import { getShardMissionControl } from './missionControl'
import { isPortalTravelData, isRecord, PortalHop } from './types'
import { travelPortalRoute } from './travel'
import { scoutMovementOptions } from './scoutMovement'
import { getScoutDanger } from './scoutSafety'
import { isLowBucketPlanning, lowBucketPlanningReady, reserveLowBucketPlanning } from './planningBudget'

type Progress = NonNullable<ShardUnitData['exploration']>
const ROOM_NAME = /^[WE]\d+[NS]\d+$/
function policy() { return interShardPolicy.portalExploration }
function copyHop(hop: PortalHop): PortalHop {
    return { shard: hop.shard, roomName: hop.roomName, x: hop.x, y: hop.y, destinationShard: hop.destinationShard,
        ...(hop.destinationRoom === undefined ? {} : { destinationRoom: hop.destinationRoom }) }
}
function clearPreparation(data: ShardUnitData): void {
    delete data.transferPreparedAt; delete data.transferPreparedHop; delete data.transferPreparedShard
}
function clearSearch(progress: Progress): void {
    delete progress.searchOrigin; delete progress.searchTarget; delete progress.targetStartedTick
    delete progress.lastPosition; progress.stuckTicks = 0
}
function cpuWaitMilliseconds(progress: Progress): number {
    return (progress.cpuWaitMilliseconds || 0) + (progress.cpuWaitStartedAt === undefined ? 0 : Math.max(0, Date.now() - progress.cpuWaitStartedAt))
}
function resumeAfterCpuWait(progress: Progress): void {
    if (progress.cpuWaitStartedAt !== undefined) {
        progress.cpuWaitMilliseconds = cpuWaitMilliseconds(progress)
        delete progress.cpuWaitStartedAt
    }
}
function waitForCpu(progress: Progress, elapsed: number, wasWaiting: boolean): void {
    if (!wasWaiting) progress.elapsedTicks = Math.max(0, progress.elapsedTicks - elapsed)
    if (progress.cpuWaitStartedAt === undefined) progress.cpuWaitStartedAt = Date.now()
    progress.stuckTicks = 0; delete progress.lastPosition
}
function retire(data: ShardUnitData, creep: Creep): void {
    data.done = true; data.phase = 'done'
    clearPreparation(data); cancelCreepTransfers(creep)
    delete data.exploration!.reportPending
}

/** 独立情报进度，不构成路线验证证明；写入失败保留旧目录并留待原地重试。 */
export function reportPortalExploration(data: ShardUnitData, creep: Creep, status: PortalExplorationReport['status'], message?: string, failedHop?: PortalHop): boolean {
    const progress = data.exploration
    if (progress === undefined) return false
    progress.status = status; progress.reportPending = true
    const endpoint = progress.returnGoal || { shard: progress.goalShard, roomName: progress.goalRoom }
    if (status === 'complete' && (Game.shard.name !== endpoint.shard || creep.room.name !== endpoint.roomName ||
        (progress.returnGoal !== undefined && progress.stage !== 'return'))) {
        data.lastError = '探门单位尚未抵达完整行程的实际终点'; return false
    }
    const local = getLocalShardState(), previous = local.explorationReports
    if (previous !== undefined && !isRecord(previous)) { if (status !== 'failed') data.lastError = 'Portal 探索报告目录损坏，保留原值'; return false }
    const now = Date.now(), next: Record<string, unknown> = { ...(previous as Record<string, unknown> | undefined) }
    for (const [key, value] of Object.entries(next)) {
        if (isRecord(value) && typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) && now - value.updatedAt > policy().reportTtl) delete next[key]
    }
    if (next[data.missionId] === undefined && Object.keys(next).length >= policy().maximumReports) {
        if (status !== 'failed') data.lastError = 'Portal 探索报告容量已满，等待过期记录释放'; return false
    }
    const report: PortalExplorationReport = {
        missionId: data.missionId, sourceShard: data.task.sourceShard, explorerName: creep.name, revision: progress.revision,
        status, shard: Game.shard.name, roomName: creep.room.name, updatedAt: now, elapsedTicks: progress.elapsedTicks,
        cpuWaitMilliseconds: cpuWaitMilliseconds(progress),
        visitedRooms: progress.visitedRooms.slice(-policy().maximumVisitedRooms), route: data.route.map(copyHop),
        ...(message === undefined ? {} : { lastError: message }), ...(failedHop === undefined ? {} : { failedHop: copyHop(failedHop) }),
    }
    next[data.missionId] = report; local.explorationReports = next; markShardStateDirty()
    if (!flushInterShardMemory()) {
        if (previous === undefined) delete local.explorationReports
        else local.explorationReports = previous
        markShardStateDirty(); if (status !== 'failed') data.lastError = getShardTransportError() || 'Portal 探索报告尚未成功发布'
        return false
    }
    progress.reportAt = Game.time; progress.reportShard = Game.shard.name; delete progress.reportPending
    return true
}

function fail(data: ShardUnitData, creep: Creep, message: string, hop?: PortalHop): boolean {
    data.lastError = message
    if (hop !== undefined) data.routeIssue = { hop: copyHop(hop), updatedAt: Date.now(), message }
    clearPreparation(data); cancelCreepTransfers(creep)
    if (reportPortalExploration(data, creep, 'failed', message, hop)) retire(data, creep)
    return false
}

function advanceClock(progress: Progress): number {
    const current = Game.shard.name
    const elapsed = progress.lastShard === current && progress.lastTick !== undefined && Game.time >= progress.lastTick ? Game.time - progress.lastTick : progress.lastShard === undefined ? 0 : 1
    progress.elapsedTicks += elapsed; progress.lastTick = Game.time; progress.lastShard = current
    if (!progress.visitedShards.includes(current)) progress.visitedShards.push(current)
    if (progress.searchOrigin !== undefined && progress.searchOrigin.shard !== current) clearSearch(progress)
    return elapsed
}

function visit(progress: Progress, roomName: string): void {
    const key = `${Game.shard.name}/${roomName}`
    if (!progress.visitedRooms.includes(key)) progress.visitedRooms.push(key)
    if (progress.visitedRooms.length > policy().maximumVisitedRooms) progress.visitedRooms.splice(0, progress.visitedRooms.length - policy().maximumVisitedRooms)
}

function exclude(progress: Progress, roomName: string): void {
    progress.excludedRooms = (progress.excludedRooms || []).filter(entry => entry.until > Date.now() && (entry.shard !== Game.shard.name || entry.roomName !== roomName))
    progress.excludedRooms.push({ shard: Game.shard.name, roomName, until: Date.now() + policy().blockedRoomTtl })
    progress.excludedRooms = progress.excludedRooms.slice(-policy().maximumVisitedRooms)
    delete progress.searchTarget; delete progress.targetStartedTick
    progress.stuckTicks = 0; delete progress.lastPosition
}

function budgetReady(): boolean {
    return isLowBucketPlanning() ? lowBucketPlanningReady() :
        (!Number.isFinite(Game.cpu.tickLimit) || Game.cpu.tickLimit - Game.cpu.getUsed() >= policy().minimumCpuHeadroom)
}

function followPortal(data: ShardUnitData, creep: Creep): boolean {
    const hop = data.route[data.hopIndex]
    const result = travelPortalRoute(creep, data)
    if (result.reason === 'portal-missing' || result.reason === 'portal-destination') forgetPortal(hop)
    if (result.status === 'error' || result.reason !== undefined) return fail(data, creep, result.message || '探门 Portal 行程失败', hop)
    data.lastError = result.message
    return false
}

function run(data: ShardUnitData, creep: Creep): boolean {
    const progress = data.exploration!, wasWaiting = progress.cpuWaitStartedAt !== undefined, elapsed = advanceClock(progress)
    if (progress.startedAt <= 0) progress.startedAt = Date.now()
    if (wasWaiting) progress.elapsedTicks = Math.max(0, progress.elapsedTicks - elapsed)
    const command = getShardMissionControl(data)
    const state = command?.state
    const revision = command?.explorerRevision
    const explorerStatus = command?.explorerStatus
    if (state === 'cancelled' || state === 'complete' || explorerStatus === 'complete' || explorerStatus === 'failed' || (revision !== undefined && revision !== progress.revision)) {
        retire(data, creep); return false
    }
    if (state === 'paused') { progress.stuckTicks = 0; delete progress.lastPosition; return false }
    if (progress.status === 'failed' || progress.status === 'complete') {
        if (!progress.reportPending || reportPortalExploration(data, creep, progress.status, data.lastError, data.routeIssue?.hop)) retire(data, creep)
        return false
    }
    const danger = getScoutDanger(creep)
    if (danger !== undefined) {
        const hop = data.route[data.hopIndex]
        return fail(data, creep, danger, hop?.roomName === creep.room.name ? hop : undefined)
    }
    if (progress.elapsedTicks > policy().maximumSearchTicks || Date.now() - progress.startedAt - cpuWaitMilliseconds(progress) > policy().maximumAge) return fail(data, creep, 'Portal 探索超过允许时长', data.route[data.hopIndex])
    if (creep.ticksToLive !== undefined && creep.ticksToLive < policy().minimumRemainingTicks) return fail(data, creep, '探门单位剩余寿命不足', data.route[data.hopIndex])
    if (progress.reportPending && !reportPortalExploration(data, creep, 'exploring', data.lastError)) return false
    runPortalDiscovery()
    if (interShardPolicy.portalDiscovery?.enabled) {
        for (const roomName of Object.keys(Game.rooms)) {
            const match = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName)
            if (match !== null && Number(match[2]) % 10 === 0 && Number(match[4]) % 10 === 0) visit(progress, roomName)
        }
    }
    visit(progress, creep.room.name)
    if (progress.reportShard !== Game.shard.name || progress.reportAt === undefined || Game.time - progress.reportAt >= policy().reportInterval) {
        if (!reportPortalExploration(data, creep, 'exploring', data.lastError)) return false
    }
    const previous = progress.lastPosition
    const samePosition = previous !== undefined && previous.shard === Game.shard.name && previous.roomName === creep.room.name && previous.x === creep.pos.x && previous.y === creep.pos.y
    if (previous !== undefined && previous.shard === Game.shard.name && previous.roomName !== creep.room.name && progress.searchTarget !== undefined) progress.targetStartedTick = Game.time
    progress.stuckTicks = samePosition && creep.fatigue === 0 ? (progress.stuckTicks || 0) + elapsed : 0
    progress.lastPosition = { shard: Game.shard.name, roomName: creep.room.name, x: creep.pos.x, y: creep.pos.y }
    if (progress.stuckTicks >= policy().stuckTicks) return fail(data, creep, '探门单位长时间没有移动', data.route[data.hopIndex])
    if (data.hopIndex < data.route.length) {
        if (progress.selectedPortalHop === data.hopIndex || (progress.stage === 'outbound' && data.task.autoRoute === false)) {
            resumeAfterCpuWait(progress); return followPortal(data, creep)
        }
        // Existing scouts may carry a full prefix chosen using total journey cost.
        // Keep crossed hops; select only the next door from the actual current room.
        data.route = data.route.slice(0, data.hopIndex)
        clearPreparation(data); cancelCreepTransfers(creep)
    }
    const goal = progress.stage === 'return' && progress.returnGoal !== undefined ? progress.returnGoal : { shard: progress.goalShard, roomName: progress.goalRoom }
    if (Game.shard.name === goal.shard) {
        resumeAfterCpuWait(progress)
        if (creep.room.name !== goal.roomName) {
            const code = creep.moveTo(new RoomPosition(25, 25, goal.roomName), { ...scoutMovementOptions, range: 20 })
            if (code === ERR_NO_PATH) return fail(data, creep, '探门单位无法从 Portal 落地房间抵达目标', data.route[data.route.length - 1])
            if (code !== OK && code !== ERR_TIRED) return fail(data, creep, `探门单位前往目标失败: ${code}`)
            return false
        }
        if (progress.stage === 'outbound' && progress.returnGoal !== undefined) {
            progress.stage = 'return'; progress.visitedShards = [Game.shard.name]; clearSearch(progress)
            delete data.lastError
            return false
        }
        if (reportPortalExploration(data, creep, 'complete')) retire(data, creep)
        return true
    }
    // Bucket/headroom restrict choosing new routes, not following an already
    // selected entrance or crossroad. Otherwise a safe scout can freeze at an exit.
    if (!budgetReady()) {
        if (progress.searchTarget !== undefined && !progress.visitedRooms.includes(`${Game.shard.name}/${progress.searchTarget}`)) {
            resumeAfterCpuWait(progress)
            const code = creep.moveTo(new RoomPosition(25, 25, progress.searchTarget), { ...scoutMovementOptions, range: 20 })
            if (code === ERR_NO_PATH) { exclude(progress, progress.searchTarget); data.lastError = '探索房间无路可达，暂时跳过'; return false }
            if (code !== OK && code !== ERR_TIRED) return fail(data, creep, `探门移动失败: ${code}`)
            delete data.lastError; return false
        }
        waitForCpu(progress, elapsed, wasWaiting); data.lastError = 'CPU 不足，暂缓主动探门'; return false
    }
    const limits = isLowBucketPlanning() ? reserveLowBucketPlanning() : undefined
    if (isLowBucketPlanning() && limits === undefined) {
        if (progress.searchTarget !== undefined && !progress.visitedRooms.includes(`${Game.shard.name}/${progress.searchTarget}`)) {
            resumeAfterCpuWait(progress)
            const code = creep.moveTo(new RoomPosition(25, 25, progress.searchTarget), { ...scoutMovementOptions, range: 20 })
            if (code === ERR_NO_PATH) { exclude(progress, progress.searchTarget); data.lastError = '探索房间无路可达，暂时跳过'; return false }
            if (code !== OK && code !== ERR_TIRED) return fail(data, creep, `探门移动失败: ${code}`)
            delete data.lastError; return false
        }
        waitForCpu(progress, elapsed, wasWaiting); data.lastError = '本 tick 探门预算已用完，等待下一 tick'; return false
    }
    resumeAfterCpuWait(progress)
    const planningCpu = Game.cpu.getUsed()
    const maximumPlanningCpu = limits?.maximumPlanningCpu ?? policy().maximumPlanningCpu
    const planningBudget = (): boolean => budgetReady() && Game.cpu.getUsed() - planningCpu < maximumPlanningCpu
    const planningOptions = () => ({ ...limits, ...(limits == undefined ? {} : { candidateOnly: true }),
        maximumPlanningCpu: Math.max(0, maximumPlanningCpu - (Game.cpu.getUsed() - planningCpu)) })
    progress.excludedRooms = (progress.excludedRooms || []).filter(entry => entry.until > Date.now())
    const excluded = progress.excludedRooms.filter(entry => entry.shard === Game.shard.name).map(entry => entry.roomName)
    const portals = getKnownPortals([data.task.sourceShard, progress.goalShard, goal.shard]).filter(hop => hop.shard !== Game.shard.name || !excluded.includes(hop.roomName))
    const hop = selectExplorationPortal(Game.shard.name, creep.room.name, goal.shard, goal.roomName, portals, progress.visitedShards, planningOptions())
    if (hop !== undefined) {
        const route = [...data.route, copyHop(hop)]
        if (route.length > interShardPolicy.portalRouting.maximumHops || !isPortalTravelData({ ...data, route }) || hop.shard !== Game.shard.name) return fail(data, creep, '探门行程超过跳数上限或真实 Portal 链不连续')
        data.route = route; progress.selectedPortalHop = data.hopIndex
        clearPreparation(data); delete progress.searchTarget; delete progress.targetStartedTick
        return followPortal(data, creep)
    }
    if (isExplorationPlanningDeferred()) { waitForCpu(progress, elapsed, wasWaiting); data.lastError = '本 tick 探门预算已用完，等待下一 tick'; return false }
    if (!planningBudget()) { waitForCpu(progress, elapsed, wasWaiting); data.lastError = 'CPU 不足，等待下一 tick 选择探索房间'; return false }
    if (progress.searchOrigin === undefined) progress.searchOrigin = { shard: Game.shard.name, roomName: creep.room.name }
    if (progress.searchTarget !== undefined && progress.visitedRooms.includes(`${Game.shard.name}/${progress.searchTarget}`)) {
        delete progress.searchTarget; delete progress.targetStartedTick
    }
    if (progress.searchTarget !== undefined && progress.targetStartedTick !== undefined && Game.time - progress.targetStartedTick >= policy().roomTimeout) {
        const skipped = progress.searchTarget
        exclude(progress, skipped); excluded.push(skipped); data.lastError = '探索房间连续无跨房间进展，暂时跳过'
    }
    if (progress.searchTarget === undefined) {
        const prefix = `${Game.shard.name}/`, visited = progress.visitedRooms.filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length))
        // Keep the bounded search area, but choose each next crossroad from the scout's actual location.
        let candidates = getExplorationRooms(creep.room.name, visited, excluded, {
            ...planningOptions(), searchOriginRoom: progress.searchOrigin.roomName, nearestOnly: true,
        })
        if (!candidates.length && isExplorationPlanningDeferred()) { waitForCpu(progress, elapsed, wasWaiting); data.lastError = '本 tick 探索房间预算已用完，等待下一 tick'; return false }
        if (!candidates.length && creep.room.name !== progress.searchOrigin.roomName && planningBudget()) {
            progress.searchOrigin.roomName = creep.room.name
            candidates = getExplorationRooms(creep.room.name, visited, excluded, {
                ...planningOptions(), searchOriginRoom: progress.searchOrigin.roomName, nearestOnly: true,
            })
            if (!candidates.length && isExplorationPlanningDeferred()) { waitForCpu(progress, elapsed, wasWaiting); return false }
        }
        if (!candidates.length) {
            if (!planningBudget()) { waitForCpu(progress, elapsed, wasWaiting); return false }
            return fail(data, creep, '限定探索范围内没有尚未访问的可达高速路交叉房')
        }
        progress.searchTarget = candidates[0]; progress.targetStartedTick = Game.time
    }
    const code = creep.moveTo(new RoomPosition(25, 25, progress.searchTarget), { ...scoutMovementOptions, range: 20 })
    if (code === ERR_NO_PATH) { exclude(progress, progress.searchTarget); data.lastError = '探索房间无路可达，暂时跳过'; return false }
    if (code !== OK && code !== ERR_TIRED) return fail(data, creep, `探门移动失败: ${code}`)
    return false
}

function valid(data: CreepData): data is ShardUnitData {
    if (!isShardUnitData(data) || data.unitKind !== 'scout' || !isRecord(data.exploration)) return false
    const progress = data.exploration, integer = (value: unknown): boolean => Number.isInteger(value) && (value as number) >= 0
    return typeof progress.revision === 'string' && progress.revision.length > 0 && typeof progress.goalShard === 'string' && !!progress.goalShard &&
        typeof progress.goalRoom === 'string' && ROOM_NAME.test(progress.goalRoom) && ['outbound', 'return'].includes(progress.stage) &&
        Number.isFinite(progress.startedAt) && integer(progress.elapsedTicks) && Array.isArray(progress.visitedRooms) && progress.visitedRooms.every(name => typeof name === 'string') &&
        (progress.cpuWaitStartedAt === undefined || (Number.isFinite(progress.cpuWaitStartedAt) && progress.cpuWaitStartedAt >= 0)) &&
        (progress.cpuWaitMilliseconds === undefined || (Number.isFinite(progress.cpuWaitMilliseconds) && progress.cpuWaitMilliseconds >= 0)) &&
        Array.isArray(progress.visitedShards) && progress.visitedShards.every(name => typeof name === 'string') &&
        (progress.selectedPortalHop === undefined || integer(progress.selectedPortalHop)) &&
        (progress.lastTick === undefined || integer(progress.lastTick)) &&
        (progress.lastShard === undefined || typeof progress.lastShard === 'string') &&
        (progress.searchOrigin === undefined || (isRecord(progress.searchOrigin) && typeof progress.searchOrigin.shard === 'string' &&
            typeof progress.searchOrigin.roomName === 'string' && ROOM_NAME.test(progress.searchOrigin.roomName))) &&
        (progress.searchTarget === undefined || (typeof progress.searchTarget === 'string' && ROOM_NAME.test(progress.searchTarget))) &&
        (progress.targetStartedTick === undefined || integer(progress.targetStartedTick)) &&
        (progress.stuckTicks === undefined || integer(progress.stuckTicks)) &&
        (progress.reportAt === undefined || integer(progress.reportAt)) &&
        (progress.reportPending === undefined || typeof progress.reportPending === 'boolean') &&
        (progress.status === undefined || ['exploring', 'failed', 'complete'].includes(progress.status)) &&
        (progress.stage !== 'return' || progress.returnGoal !== undefined) &&
        (progress.returnGoal === undefined || (isRecord(progress.returnGoal) && typeof progress.returnGoal.shard === 'string' &&
            typeof progress.returnGoal.roomName === 'string' && ROOM_NAME.test(progress.returnGoal.roomName))) &&
        (progress.lastPosition === undefined || (isRecord(progress.lastPosition) && typeof progress.lastPosition.shard === 'string' &&
            typeof progress.lastPosition.roomName === 'string' && integer(progress.lastPosition.x) && integer(progress.lastPosition.y))) &&
        (progress.excludedRooms === undefined || (Array.isArray(progress.excludedRooms) && progress.excludedRooms.every(entry => isRecord(entry) &&
            typeof entry.shard === 'string' && typeof entry.roomName === 'string' && Number.isFinite(entry.until))))
}

/** 没有 Observer/自有房也能用本单位的真实视野寻找 Portal，但不会认证工作路线。 */
export function createPortalExplorerRole(data: CreepData): ICreepConfig {
    const work = (creep: Creep): boolean => valid(data) && interShardPolicy.enabled && policy().enabled && creep.memory.role === 'sScout' ? run(data, creep) : false
    return { isNeed: () => true,
        prepare: creep => !creep.spawning && valid(data) && creep.memory.role === 'sScout' && (!data.done || data.exploration?.reportPending === true),
        source: work, target: work }
}
