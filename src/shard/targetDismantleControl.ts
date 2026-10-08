import { canPrepareBoosts, invalidateBoostRequestIndex, reserveBoostPlan } from 'creep/boosting'
import { planDismantleBody } from 'creep/dismantleBody'
import { getFlagDismantleSnapshot } from 'creep/targetDismantle'
import type { DismantleTarget, FlagDismantleSnapshot, TargetDismantleOrder } from 'creep/targetDismantle'
import { isRoomEvacuating } from 'room/evacuationState'
import { interShardPolicy } from 'settings/interShard'
import { cancelCreepTransfers, flushInterShardMemory, getLocalShardState, getShardTransportError,
    markShardStateDirty, readRemoteShardState } from './transport'
import { isPortalTravelData, isRecord, PortalHop, PortalTravelData, ShardEnvelope } from './types'
import { getKnownPortals } from './portalIntel'
import { storePortalRoute } from './routeCache'

type TaskState = 'active' | 'paused' | 'completed' | 'cancelled'
export interface TargetDismantleTaskInput {
    sourceRoom: string
    targetShard?: string
    targetRoom?: string
    route?: PortalHop[]
    targets?: DismantleTarget[]
    controller?: { x: number; y: number }
    flagName?: string
    workParts?: number
    boostTier?: 0 | 1 | 2 | 3
    /** Native spawn energy only; boost minerals remain subject to real-stock preflight. */
    maxEnergy?: number
}
export interface FlagDismantleTaskOptions {
    id?: string
    targetShard?: string
    route?: PortalHop[]
    maxEnergy?: number
    workParts?: number
    boostTier?: 0 | 1 | 2 | 3
}
interface NormalizedTaskInput extends TargetDismantleTaskInput {
    targetShard: string
    route: PortalHop[]
    targets: DismantleTarget[]
}
interface UnitLease {
    name: string; generation: number; createdAt: number; expiresAt: number
    lastShard: string; seenAt?: number; locationAt: number; acknowledgedAt?: number
    leaving?: boolean; confirmed?: boolean
}
export interface TargetDismantleTask {
    id: string; key: string; sourceShard: string; input: NormalizedTaskInput
    state: TaskState; createdAt: number; updatedAt: number; finishedAt?: number
    generation: number; spent: number; maxEnergy: number; index: number
    lease?: UnitLease; reason?: string
    lastFlag?: FlagDismantleSnapshot | null
    clearedFlag?: string
    flagReady?: boolean
}
interface Command {
    type: 'targetDismantleCommand'; missionId: string; originShard: string
    state: TaskState; generation: number; updatedAt: number; expiresAt: number
    route: PortalHop[]; reason?: string; targetShard?: string; flagName?: string
    flagReady?: boolean; clearedFlag?: string
}
interface UnitStatus {
    name: string; generation: number; index: number; done: boolean
    boostFailed: boolean; error?: string; ttl?: number; leaving: boolean
}
interface Status {
    type: 'targetDismantleStatus'; missionId: string; originShard: string
    shard: string; generation: number; updatedAt: number; units: UnitStatus[]
    flag?: FlagDismantleSnapshot | null
}
declare global { interface Memory {
    targetDismantleTasks?: Record<string, TargetDismantleTask>
    /** Temporary stop broadcasts are independent of the active task catalogue. */
    targetDismantleStops?: Record<string, Command>
    targetDismantleSequence?: number
} }

const PREFIX = 'targetDismantle:'
const DEFAULT_BUDGET = 180000
const STATES: TaskState[] = ['active', 'paused', 'completed', 'cancelled']
let spawnReservationTick = -1, spawnReservationShard = '', spawnReservations = new Set<string>(), spawnRoomReservations = new Set<string>()
let knownRemoteTasks = false

/** A later ordinary Spawn controller must not replace an already accepted native intent. */
export function isTargetDismantleSpawnReserved(spawn: StructureSpawn): boolean {
    return spawnReservationTick === Game.time && spawnReservationShard === Game.shard.name &&
        (spawnReservations.has(spawn.id) || !!spawn.room?.name && spawnRoomReservations.has(spawn.room.name))
}

function allTasks(): Record<string, TargetDismantleTask> { return Memory.targetDismantleTasks || {} }
function allStops(): Record<string, Command> { return Memory.targetDismantleStops || {} }
function keyFor(id: string): string { return id.startsWith(PREFIX) ? id : `${PREFIX}${Game.shard.name}:${id}` }
function taskFor(id: string): TargetDismantleTask | undefined {
    return allTasks()[keyFor(id)] || Object.values(allTasks()).find(task => task.id === id && task.sourceShard === Game.shard.name)
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
function point(value: unknown): boolean {
    return isRecord(value) && Number.isInteger(value.x) && Number.isInteger(value.y) &&
        (value.x as number) >= 0 && (value.x as number) < 50 && (value.y as number) >= 0 && (value.y as number) < 50
}
function communicationAvailable(): boolean { return interShardPolicy.enabled && typeof InterShardMemory !== 'undefined' }
function crossShard(task: TargetDismantleTask): boolean { return task.input.targetShard !== task.sourceShard }
function commandFor(task: TargetDismantleTask, now = Date.now()): Command {
    return { type: 'targetDismantleCommand', missionId: task.key, originShard: task.sourceShard,
        state: task.state, generation: task.generation, reason: task.reason, route: task.input.route,
        flagName: task.input.flagName, targetShard: task.input.targetShard,
        flagReady: task.flagReady, clearedFlag: task.clearedFlag,
        updatedAt: now, expiresAt: now + interShardPolicy.arrivalHistoryTtl }
}
function publish(task: TargetDismantleTask, heartbeat = false): void {
    if (!crossShard(task) || !communicationAvailable()) return
    const state = getLocalShardState(), reports = state.reports || (state.reports = {})
    const old = reports[task.key]
    if (!heartbeat && isRecord(old) && old.type === 'targetDismantleCommand' && old.state === task.state &&
        old.generation === task.generation && old.reason === task.reason && old.flagReady === task.flagReady && old.clearedFlag === task.clearedFlag) return
    reports[task.key] = commandFor(task)
    markShardStateDirty()
}
function pause(task: TargetDismantleTask, reason: string): void {
    task.state = 'paused'; task.reason = reason; task.updatedAt = Date.now(); publish(task)
}
function finish(task: TargetDismantleTask, state: 'completed' | 'cancelled', reason?: string): void {
    task.state = state; task.reason = reason; task.finishedAt = task.updatedAt = Date.now()
    retireTask(task)
}
function terminal(state: TaskState | undefined): boolean { return state === 'completed' || state === 'cancelled' }
function retireTask(task: TargetDismantleTask): void {
    if (!terminal(task.state)) return
    if (task.sourceShard === Game.shard.name) {
        const targetRoom = task.lastFlag?.roomName || task.input.targetRoom
        if (crossShard(task) && targetRoom && task.input.route.length) {
            const peers: string[] = []
            for (const hop of task.input.route) peers.push(hop.shard, hop.destinationShard)
            storePortalRoute(task.sourceShard, task.input.sourceRoom, task.input.targetShard, targetRoom,
                { route: task.input.route }, getKnownPortals(peers))
        }
        const stops = Memory.targetDismantleStops || (Memory.targetDismantleStops = {})
        const now = Date.now(), finishedAt = task.finishedAt ?? task.updatedAt
        const stop = stops[task.key] || { type: 'targetDismantleCommand' as const, missionId: task.key,
            originShard: task.sourceShard, state: task.state, generation: task.generation, route: clone(task.input.route),
            ...(task.reason ? { reason: task.reason } : {}), updatedAt: finishedAt,
            expiresAt: finishedAt + interShardPolicy.arrivalHistoryTtl }
        if (stop.expiresAt > now) stops[task.key] = stop
        let changed = false
        for (const creep of Object.values(Game.creeps)) {
            const order = creep.memory.targetDismantle
            if (order?.missionId !== task.key) continue
            order.controlState = order.generation === stop.generation ? stop.state : 'cancelled'
            order.lastError = stop.reason || `Task ${order.controlState}`
            synchronizeBoostClock(creep); changed = true
        }
        if (changed) invalidateBoostRequestIndex()
        if (stop.expiresAt > now) publishStop(stop)
    }
    delete allTasks()[task.key]
}
function publishStop(stop: Command, heartbeat = false): void {
    if (!stop.route.length || !communicationAvailable()) return
    const state = getLocalShardState(), reports = state.reports || (state.reports = {})
    const old = reports[stop.missionId]
    if (!heartbeat && isRecord(old) && old.type === stop.type && old.state === stop.state &&
        old.generation === stop.generation && old.expiresAt === stop.expiresAt) return
    reports[stop.missionId] = { ...stop, updatedAt: Date.now() }
    markShardStateDirty()
}
function retireFinishedTasks(): void {
    for (const task of Object.values(allTasks())) if (terminal(task.state)) retireTask(task)
}
function command(value: unknown, source: string, now: number): value is Command {
    return isRecord(value) && value.type === 'targetDismantleCommand' && value.originShard === source &&
        typeof value.missionId === 'string' && value.missionId.startsWith(`${PREFIX}${source}:`) &&
        STATES.includes(value.state as TaskState) && Number.isInteger(value.generation) && (value.generation as number) >= 0 &&
        typeof value.updatedAt === 'number' && value.updatedAt <= now + 5000 &&
        typeof value.expiresAt === 'number' && value.expiresAt > now &&
        (value.flagName === undefined || typeof value.flagName === 'string' && !!value.flagName && typeof value.targetShard === 'string') &&
        (value.flagReady === undefined || typeof value.flagReady === 'boolean') &&
        (value.clearedFlag === undefined || typeof value.clearedFlag === 'string') &&
        isPortalTravelData({ missionId: value.missionId, originShard: source, route: value.route, hopIndex: 0 })
}
function fresh(time: number, now: number): boolean { return time <= now + 5000 && now - time <= interShardPolicy.reportMaxAge }
function flagSnapshot(value: unknown): value is FlagDismantleSnapshot | null {
    return value === null || isRecord(value) && typeof value.roomName === 'string' && /^[WE]\d+[NS]\d+$/.test(value.roomName) &&
        point(value) && (value.hasWork === undefined || typeof value.hasWork === 'boolean')
}
function validStatus(value: unknown, task: TargetDismantleTask, shard: string, now: number): value is Status {
    return isRecord(value) && value.type === 'targetDismantleStatus' && value.missionId === task.key &&
        task.input.route.some(hop => hop.shard === shard || hop.destinationShard === shard) &&
        value.originShard === task.sourceShard && value.shard === shard && typeof value.updatedAt === 'number' &&
        Number.isInteger(value.generation) && fresh(value.updatedAt, now) && Array.isArray(value.units) && value.units.length <= 2 &&
        (value.flag === undefined || flagSnapshot(value.flag)) &&
        value.units.every(unit => isRecord(unit) && typeof unit.name === 'string' && Number.isInteger(unit.generation) &&
            Number.isInteger(unit.index) && (unit.index as number) >= 0 && (unit.index as number) <= task.input.targets.length &&
            typeof unit.done === 'boolean' && typeof unit.boostFailed === 'boolean' && typeof unit.leaving === 'boolean')
}
function unitStatus(creep: Creep): UnitStatus {
    const order = creep.memory.targetDismantle!, data = creep.memory.data
    return { name: creep.name, generation: order.generation!, index: order.index || 0, done: order.done === true,
        boostFailed: creep.memory.boostPlan?.failed === true, error: order.lastError || creep.memory.boostPlan?.failureReason,
        ttl: creep.ticksToLive, leaving: isPortalTravelData(data) && data.transferPreparedAt !== undefined }
}
function acceptUnit(task: TargetDismantleTask, unit: UnitStatus, shard: string, now: number, updatedAt: number): void {
    const lease = task.lease!
    lease.lastShard = shard; lease.seenAt = Math.max(lease.seenAt || 0, updatedAt); lease.expiresAt = now + interShardPolicy.leaseDuration
    lease.locationAt = Math.max(lease.locationAt, updatedAt); lease.leaving = unit.leaving; lease.confirmed = true
    task.index = Math.max(task.index, unit.index)
    if (unit.done && !task.input.flagName && !task.finishedAt) finish(task, 'completed')
    else if (unit.boostFailed && !task.finishedAt) pause(task, `Boost failed: ${unit.error || 'exact T3 boost preparation failed'}`)
    else if (task.state === 'active') task.reason = unit.error
}

/** A named flag controls position; legacy explicit barrier lists remain supported. */
export function createTargetDismantleTask(id: string, input: TargetDismantleTaskInput): string {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !isRecord(input)) return '须指定 1..64 位任务 id 和有效配置'
    retireFinishedTasks()
    const existing = taskFor(id)
    if (existing) return `拆迁任务 ${id} 已存在（${existing.state}），不会重复派兵`
    if (Object.values(allTasks()).filter(task => !task.finishedAt).length >= interShardPolicy.maximumTasks) return '拆迁任务数量已达上限'
    const roomNames = /^[WE]\d+[NS]\d+$/
    const targetShard = input.targetShard ?? Game.shard.name, route = input.route ?? [], targets = input.targets ?? []
    if (typeof input.sourceRoom !== 'string' || !roomNames.test(input.sourceRoom) || typeof targetShard !== 'string' || !targetShard ||
        input.targetRoom !== undefined && (typeof input.targetRoom !== 'string' || !roomNames.test(input.targetRoom))) return '须指定自有起点及有效目标 shard/房间'
    if (input.flagName !== undefined && (typeof input.flagName !== 'string' || !input.flagName || input.flagName.length > 100)) return '须指定有效旗名'
    const remote = targetShard !== Game.shard.name
    if (remote && !communicationAvailable()) return '跨 shard 通信不可用'
    const home = Game.rooms[input.sourceRoom]
    if (!home?.controller?.my || !home.find(FIND_MY_SPAWNS).length) return '起点须有自有 Spawn'
    const body = planDismantleBody(home, input)
    if (body.error || !body.body.length || body.cost <= 0) return body.error || '起点容量不能孵化有效拆迁身体'
    if (!isPortalTravelData({ missionId: keyFor(id), originShard: Game.shard.name, route, hopIndex: 0 }) ||
        route.length > 8 || route.some(hop => hop.shard === hop.destinationShard || !roomNames.test(hop.roomName)) ||
        (remote ? !route.length || route[route.length - 1].destinationShard !== targetShard : route.length !== 0))
        return '须指定逐跳连通并到达目标 shard 的明确 Portal 路线；同 shard 不需要路线'
    if (!input.flagName && (typeof input.targetRoom !== 'string' || !point(input.controller) || !Array.isArray(targets) || !targets.length || targets.length > 8 ||
        targets.some(target => !isRecord(target) || typeof target.id !== 'string' || !target.id || !point(target) ||
            ![STRUCTURE_WALL, STRUCTURE_RAMPART].includes(target.type)) ||
        new Set(targets.map(target => target.id)).size !== targets.length)) return '须指定旗名，或 controller 坐标及最多 8 个唯一的 wall/rampart ID 和坐标'
    const budget = input.maxEnergy ?? DEFAULT_BUDGET
    if (!Number.isSafeInteger(budget) || budget < body.cost) return `孵化能量预算须为至少 ${body.cost} 的整数`
    const now = Date.now()
    Memory.targetDismantleSequence = Math.max(0, Number.isSafeInteger(Memory.targetDismantleSequence)
        ? Memory.targetDismantleSequence! : 0) + 1
    const key = `${keyFor(id)}:${now}:${Game.time}:${Memory.targetDismantleSequence}`
    const normalized: NormalizedTaskInput = { ...input, targetShard, route, targets: input.flagName ? [] : targets }
    const task: TargetDismantleTask = { id, key, sourceShard: Game.shard.name, input: clone(normalized),
        state: 'active', createdAt: now, updatedAt: now, generation: 0, spent: 0, maxEnergy: budget, index: 0 }
    const records = Memory.targetDismantleTasks || (Memory.targetDismantleTasks = {})
    records[key] = task; publish(task)
    if (remote && !flushInterShardMemory()) {
        delete records[key]; delete getLocalShardState().reports?.[key]; markShardStateDirty()
        return `任务未创建：${getShardTransportError() || '跨 shard 命令无法写入'}`
    }
    pruneHistory()
    return `已创建${input.flagName ? `旗帜拆迁任务 ${id}（${input.flagName}）` : `精确拆除任务 ${id}`}，一个名额持续补派，预算 ${budget} 能量`
}

export function createFlagDismantleTask(home: string, flagName: string, options: FlagDismantleTaskOptions = {}): string {
    if (!isRecord(options)) return '须指定有效拆迁选项'
    if (typeof home !== 'string' || typeof flagName !== 'string' || !flagName ||
        options.targetShard !== undefined && typeof options.targetShard !== 'string') return '须指定有效起点、旗名和目标 shard'
    if (options.id !== undefined && typeof options.id !== 'string') return '须指定有效任务 id'
    const identity = JSON.stringify([home, options.targetShard ?? Game.shard.name, flagName])
    // Two independent hashes preserve arbitrary native flag names without replacement collisions.
    let first = 2166136261, second = 5381
    for (let index = 0; index < identity.length; index++) {
        first = Math.imul(first ^ identity.charCodeAt(index), 16777619)
        second = Math.imul(second, 33) ^ identity.charCodeAt(index)
    }
    const id = options.id ?? `flag_${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`
    return createTargetDismantleTask(id, { ...options, sourceRoom: home, flagName })
}

export function listTargetDismantleTasks(id?: string): string {
    retireFinishedTasks()
    const tasks = id === undefined ? Object.values(allTasks()) : [taskFor(id)].filter((task): task is TargetDismantleTask => !!task)
    return tasks.length ? tasks.map(task => `${task.id}: ${task.state}, ${task.sourceShard}/${task.input.sourceRoom} → ` +
        `${task.input.targetShard}/${task.lastFlag?.roomName || task.input.targetRoom || '?'}, ` +
        (task.input.flagName ? `旗 ${task.input.flagName}${task.lastFlag ? ` (${task.lastFlag.x},${task.lastFlag.y})` : ' 未放置'}, ` : `目标 ${task.index}/${task.input.targets.length}, `) +
        `能量 ${task.spent}/${task.maxEnergy}, 单位 ${task.lease?.name || '无'}${task.reason ? `, ${task.reason}` : ''}`).join('\n') : '没有拆迁任务'
}
function flushTask(task: TargetDismantleTask): boolean { return !crossShard(task) || flushInterShardMemory() }
export function pauseTargetDismantleTask(id: string): string {
    const task = taskFor(id)
    if (!task || task.sourceShard !== Game.shard.name) return '本 shard 未找到拆迁任务'
    if (task.finishedAt) return `任务已 ${task.state}`
    pause(task, 'Paused by source shard')
    if (!flushTask(task)) return `已记录暂停 ${task.id}，远端广播尚未成功：${getShardTransportError() || '通信不可用'}`
    return `已暂停 ${task.id}：保留现有单位名额，停止出生及拆除`
}
export function resumeTargetDismantleTask(id: string, options: { maxEnergy?: number } = {}): string {
    const task = taskFor(id)
    if (!task || task.sourceShard !== Game.shard.name) return '本 shard 未找到拆迁任务'
    if (task.finishedAt) return `任务已 ${task.state}，请用新 id 创建任务`
    if (!isRecord(options)) return '须指定有效恢复选项'
    if (options.maxEnergy !== undefined) {
        const home = Game.rooms[task.input.sourceRoom], body = home && planDismantleBody(home, task.input)
        if (!Number.isSafeInteger(options.maxEnergy) || options.maxEnergy < task.spent || options.maxEnergy < (body?.cost || 1))
            return '预算须为整数，且不能低于已花费能量或一个有效身体的出生成本'
        task.maxEnergy = options.maxEnergy; task.input.maxEnergy = options.maxEnergy
    }
    task.state = 'active'; task.updatedAt = Date.now(); delete task.reason; publish(task)
    if (!flushTask(task)) return `已记录恢复 ${task.id}，远端广播尚未成功：${getShardTransportError() || '通信不可用'}`
    return `已恢复 ${task.id}：保留现有单位名额及代次，预算 ${task.maxEnergy}`
}
export function cancelTargetDismantleTask(id: string): string {
    const task = taskFor(id)
    if (!task || task.sourceShard !== Game.shard.name) return '本 shard 未找到拆迁任务'
    if (task.state === 'completed' || task.state === 'cancelled') return `任务已 ${task.state}`
    finish(task, 'cancelled', 'Cancelled by source shard')
    if (!flushTask(task)) return `已记录取消 ${task.id}，远端广播尚未成功：${getShardTransportError() || '通信不可用'}`
    return `已取消 ${task.id}：停止续派，远端单位收到命令后停止拆除并让出通道`
}

/** Pause time cannot exhaust an unfinished exact boost; shard clocks are never subtracted across portals. */
function synchronizeBoostClock(creep: Creep): void {
    const order = creep.memory.targetDismantle!, plan = creep.memory.boostPlan
    if (!plan?.steps.length || plan.completed || plan.failed) { delete order.boostClock; return }
    let clock = order.boostClock
    const migrated = !!clock && clock.shard !== Game.shard.name || !clock && order.sourceShard !== Game.shard.name
    const invalidClock = !!clock && clock.pausedAt !== undefined &&
        (!Number.isSafeInteger(clock.pausedAt) || clock.pausedAt < 0 || clock.pausedAt > Game.time)
    if (!clock || migrated || invalidClock) {
        if ((migrated || invalidClock) && plan.startedAt !== undefined) plan.startedAt = Game.time
        clock = order.boostClock = { shard: Game.shard.name }
    }
    if (order.controlState !== 'active') {
        if (clock.pausedAt === undefined) clock.pausedAt = Game.time
    } else if (clock.pausedAt !== undefined) {
        if (plan.startedAt !== undefined) plan.startedAt = Math.min(Game.time, plan.startedAt + Game.time - clock.pausedAt)
        delete clock.pausedAt
    }
}

/** Called before creep execution. A missing source heartbeat stops movement/boosting/dismantling. */
function synchronizeWorkers(commands: Map<string, Command>, now: number): void {
    let changed = false
    for (const creep of Object.values(Game.creeps)) {
        const order = creep.memory.targetDismantle
        if (!order?.missionId || !order.sourceShard || order.generation === undefined) continue
        const previous = order.controlState
        const source = commands.get(order.missionId)
        if (!source || !fresh(source.updatedAt, now)) {
            if (terminal(previous)) { synchronizeBoostClock(creep); continue }
            order.controlState = 'paused'; order.lastError = 'Waiting for source command heartbeat'
            synchronizeBoostClock(creep); changed ||= previous !== order.controlState
            continue
        }
        order.controlState = terminal(previous) ? previous : source.generation === order.generation ? source.state : 'cancelled'
        if (order.controlState === 'active' && source.flagName) {
            // The target shard sees flag movement immediately, even before its next report reaches the source.
            const localFlag = source.targetShard === Game.shard.name ? getFlagDismantleSnapshot(source.flagName) : undefined
            const idle = localFlag === null || localFlag?.hasWork === false || localFlag?.hasWork === undefined &&
                !!localFlag && source.clearedFlag === flagSignature(localFlag)
            if (source.targetShard === Game.shard.name ? idle : source.flagReady === false) {
                order.controlState = 'paused'
                order.lastError = 'Waiting for a placed flag with dismantle work'
            } else if (order.lastError === 'Waiting for a placed flag with dismantle work') delete order.lastError
        }
        if (order.controlState !== 'active') {
            if (order.lastError !== 'Waiting for a placed flag with dismantle work' || source.state !== 'active')
                order.lastError = source.generation !== order.generation ? 'Superseded precise dismantle generation' : source.reason || `Task ${source.state}`
            // Stop new travel without deleting snapshots needed by a creep that has already crossed a portal.
            if (order.controlState === 'paused') cancelCreepTransfers(creep)
        } else if (order.lastError === 'Waiting for source command heartbeat') delete order.lastError
        synchronizeBoostClock(creep); changed ||= previous !== order.controlState
    }
    if (changed) invalidateBoostRequestIndex()
}

function flagSignature(flag: FlagDismantleSnapshot): string { return `${flag.roomName}:${flag.x}:${flag.y}` }
/** Report absence/cleared state even without workers; only a moved flag forgets an idle tile. */
function updateFlag(task: TargetDismantleTask, peers: Map<string, ShardEnvelope | undefined>, now: number): boolean {
    if (!task.input.flagName) return true
    let flag: FlagDismantleSnapshot | null | undefined
    if (!crossShard(task)) flag = getFlagDismantleSnapshot(task.input.flagName)
    else {
        const status = peers.get(task.input.targetShard)?.reports?.[`${task.key}:status`]
        if (!validStatus(status, task, task.input.targetShard, now) || status.flag === undefined) {
            task.reason = 'Waiting for a fresh target-shard flag report'; return false
        }
        flag = status.flag
    }
    task.lastFlag = flag && clone(flag)
    if (!flag) { task.reason = `Waiting for flag ${task.input.flagName} on ${task.input.targetShard}`; return false }
    const signature = flagSignature(flag)
    if (task.clearedFlag && task.clearedFlag !== signature) delete task.clearedFlag
    if (flag.hasWork === false) {
        task.clearedFlag = signature; task.reason = 'Flag tile is clear; move the flag to the next dismantle position'; return false
    }
    if (flag.hasWork === undefined && task.clearedFlag === signature) {
        task.reason = 'Previously cleared flag tile has no vision; move the flag to choose new work'; return false
    }
    return true
}

function reconcile(task: TargetDismantleTask, peers: Map<string, ShardEnvelope | undefined>, now: number): void {
    const lease = task.lease
    if (!lease) return
    const local = Game.creeps[lease.name]
    if (local?.memory.targetDismantle?.missionId === task.key && local.memory.targetDismantle.generation === lease.generation) {
        acceptUnit(task, unitStatus(local), Game.shard.name, now, now); return
    }
    // A destination acknowledgement moves the lease before an old source absence can release it.
    for (const [shard, state] of peers) for (const ack of Object.values(state?.acks || {})) {
        if (!isRecord(ack) || typeof ack.id !== 'string' || !Number.isFinite(ack.createdAt) || !Number.isFinite(ack.expiresAt) ||
            ack.createdAt > now + 5000 || ack.creepName !== lease.name || ack.fromShard !== shard || ack.toShard !== lease.lastShard ||
            ack.createdAt < lease.createdAt || ack.createdAt <= (lease.acknowledgedAt || 0) || ack.expiresAt <= now ||
            !ack.id.includes(`:${task.key}:`) || !task.input.route.some(hop => hop.shard === ack.toShard && hop.destinationShard === shard)) continue
        lease.lastShard = shard; lease.locationAt = lease.acknowledgedAt = ack.createdAt
        lease.seenAt = Math.max(lease.seenAt || 0, ack.createdAt)
        lease.expiresAt = now + interShardPolicy.leaseDuration; lease.leaving = false; lease.confirmed = true
    }
    // Positive evidence on any valid route shard always takes precedence over an empty older report.
    let latest: { unit: UnitStatus; shard: string; time: number } | undefined
    for (const [shard, state] of peers) {
        const report = state?.reports?.[`${task.key}:status`]
        if (!validStatus(report, task, shard, now) || report.updatedAt < lease.locationAt) continue
        const unit = report.units.find(unit => unit.name === lease.name && unit.generation === lease.generation)
        if (unit && (!latest || report.updatedAt > latest.time)) latest = { unit, shard, time: report.updatedAt }
    }
    if (latest) acceptUnit(task, latest.unit, latest.shard, now, latest.time)
    // The source can miss a short intermediate-shard leaving report. A still-valid transfer
    // is independent proof that an empty report is a hand-off, rather than confirmed death.
    const pending = Object.values(peers.get(lease.lastShard)?.transfers || getLocalShardState().transfers).some(transfer =>
        isRecord(transfer) && transfer.creepName === lease.name && transfer.missionId === task.key && transfer.fromShard === lease.lastShard &&
        transfer.expiresAt > now && transfer.createdAt >= lease.locationAt &&
        isPortalTravelData(transfer.memory?.data) && transfer.memory.data.hopIndex === transfer.nextHopIndex &&
        transfer.memory?.targetDismantle?.generation === lease.generation &&
        task.input.route.some(hop => hop.shard === transfer.fromShard && hop.destinationShard === transfer.toShard))
    if (pending) { lease.leaving = true; return }
    if (latest) return
    if (lease.lastShard === Game.shard.name && lease.confirmed && !lease.leaving) { delete task.lease; return }
    const status = peers.get(lease.lastShard)?.reports?.[`${task.key}:status`]
    if (lease.lastShard === task.input.targetShard && validStatus(status, task, lease.lastShard, now) &&
        status.generation === lease.generation && lease.confirmed &&
        status.updatedAt >= lease.locationAt && !lease.leaving &&
        now - (lease.seenAt || lease.locationAt) >= interShardPolicy.missingUnitGrace) { delete task.lease; return }
    if (now >= lease.expiresAt && task.state === 'active') pause(task, 'Cross-shard heartbeat expired; death is unconfirmed, preserving the single slot')
}

function spawn(task: TargetDismantleTask, now: number, flagReady = true): void {
    if (task.state !== 'active' || task.lease) return
    if (!flagReady) return
    if (crossShard(task) && !communicationAvailable()) { task.reason = 'Waiting for cross-shard communication'; return }
    const room = Game.rooms[task.input.sourceRoom]
    if (!room?.controller?.my) { pause(task, 'Source room is no longer owned'); return }
    const selected = planDismantleBody(room, task.input)
    if (selected.error || !selected.body.length || selected.cost <= 0) { pause(task, selected.error || 'Cannot select a valid dismantle body'); return }
    if (task.spent + selected.cost > task.maxEnergy) { pause(task, 'Native spawn energy budget exhausted'); return }
    if (isRoomEvacuating(room) || Memory.warMode?.[room.name] || room.enemies?.length) {
        task.reason = 'Waiting for source evacuation/hostilities to clear'; return
    }
    if ((room.memory.creepSpawnQueue || []).some(name => {
        const config = room.memory.creepConfig?.[name]
        return !!config && !Game.creeps[name] && config.spawnPriority < 3.5
    })) { task.reason = 'Waiting for higher-priority economy or defense spawn demands'; return }
    if (room.energyAvailable < selected.cost) { task.reason = `Waiting for ${selected.cost} spawn energy`; return }
    const nativeSpawn = room.find(FIND_MY_SPAWNS).find(candidate => !candidate.spawning && !isTargetDismantleSpawnReserved(candidate))
    if (!nativeSpawn) { task.reason = 'Waiting for an idle Spawn'; return }
    const plan = selected.boostPlan
    if (plan.steps.length && !canPrepareBoosts(room, plan)) {
        task.reason = `Waiting for exact T${plan.tier} boosts: ${plan.steps.map(step => `${step.resource} ${step.parts * 30}`).join(' / ')}`; return
    }
    const generation = task.generation + 1, name = `td_${task.id}_${task.createdAt.toString(36)}_${generation}_${Game.time}`
    const data: PortalTravelData = { missionId: task.key, originShard: task.sourceShard, route: clone(task.input.route), hopIndex: 0 }
    const order: TargetDismantleOrder = { missionId: task.key, sourceShard: task.sourceShard, generation, controlState: 'active',
        targetShard: task.input.targetShard, targetRoom: task.lastFlag?.roomName || task.input.targetRoom || room.name,
        flagName: task.input.flagName, targets: clone(task.input.targets),
        ...(task.input.controller ? { controller: clone(task.input.controller) } : {}) }
    const memory: CreepMemory = { name, displayName: task.id, role: 'sBuilder', spawnRoom: room.name, spawnPriority: 3.5,
        ready: false, working: false, data, boostPlan: plan, targetDismantle: order }
    const result = nativeSpawn.spawnCreep(selected.body, name, { memory })
    if (result !== OK) { task.reason = `Native spawn rejected (${result})`; return }
    if (spawnReservationTick !== Game.time || spawnReservationShard !== Game.shard.name) {
        spawnReservationTick = Game.time; spawnReservationShard = Game.shard.name; spawnReservations = new Set()
        spawnRoomReservations = new Set()
    }
    spawnReservations.add(nativeSpawn.id)
    spawnRoomReservations.add(room.name)
    task.generation = generation; task.spent += selected.cost; task.updatedAt = now; delete task.reason
    task.lease = { name, generation, createdAt: now, expiresAt: now + interShardPolicy.leaseDuration,
        lastShard: Game.shard.name, locationAt: now }
    publish(task)
    if (plan.steps.length) reserveBoostPlan(room, name, plan)
}

function pruneHistory(): void {
    retireFinishedTasks()
    const now = Date.now(), reports = communicationAvailable() ? getLocalShardState().reports : undefined
    for (const [key, stop] of Object.entries(allStops())) {
        if (stop.expiresAt > now) continue
        delete allStops()[key]
        if (reports && (reports[key] !== undefined || reports[`${key}:status`] !== undefined)) {
            delete reports[key]; delete reports[`${key}:status`]; markShardStateDirty()
        }
    }
    if (reports) for (const [key, value] of Object.entries(reports)) {
        if (!isRecord(value) || !['targetDismantleCommand', 'targetDismantleStatus'].includes(String(value.type))) continue
        if (typeof value.expiresAt === 'number' && value.expiresAt <= now ||
            typeof value.updatedAt === 'number' && now - value.updatedAt > interShardPolicy.arrivalHistoryTtl) {
            delete reports[key]; markShardStateDirty()
        }
    }
}

/** Source owns spawning; every route shard emits alive/empty reports and enforces source commands. */
export function runTargetDismantleControl(): void {
    retireFinishedTasks()
    const tasks = Object.values(allTasks()), workers = Object.values(Game.creeps).filter(creep => !!creep.memory.targetDismantle?.missionId)
    const communication = communicationAvailable()
    const heartbeat = Game.time % interShardPolicy.reportInterval === 0
    const now = Date.now()
    if (Object.keys(allStops()).length) {
        pruneHistory()
        for (const stop of Object.values(allStops())) publishStop(stop, heartbeat)
    }
    if (!tasks.length && !workers.length && (!communication || !knownRemoteTasks && !heartbeat)) return
    // Peers may own a task even when this shard has no workers; cached transport reads stay bounded to four.
    const peers = new Set(communication ? interShardPolicy.peers : [])
    for (const task of tasks) for (const hop of task.input.route) { peers.add(hop.shard); peers.add(hop.destinationShard) }
    for (const creep of workers) if (creep.memory.targetDismantle?.sourceShard) peers.add(creep.memory.targetDismantle.sourceShard)
    peers.delete(Game.shard.name)
    const states = new Map<string, ShardEnvelope | undefined>(communication ? Array.from(peers, peer => [peer, readRemoteShardState(peer)] as const) : [])
    for (const task of tasks) if (task.sourceShard === Game.shard.name) {
        reconcile(task, states, now)
        const ready = task.state === 'active' ? updateFlag(task, states, now) : false
        if (task.input.flagName && task.state === 'active') task.flagReady = ready
        spawn(task, now, ready)
        if (!terminal(task.state)) publish(task, heartbeat)
    }
    const commands = new Map<string, Command>()
    for (const [shard, state] of [...states, ...(communication ? [[Game.shard.name, getLocalShardState()] as const] : [])]) {
        for (const value of Object.values(state?.reports || {})) if (command(value, shard, now)) commands.set(value.missionId, value)
    }
    // Same-shard control never depends on InterShardMemory, its policy, or an old serialized heartbeat.
    for (const task of tasks) if (task.sourceShard === Game.shard.name) {
        const local = commandFor(task, now)
        if (crossShard(task) && !communication) { local.state = 'paused'; local.reason = 'Waiting for cross-shard communication' }
        commands.set(task.key, local)
    }
    for (const stop of Object.values(allStops())) if (stop.originShard === Game.shard.name)
        commands.set(stop.missionId, { ...stop, updatedAt: now })
    knownRemoteTasks = communication && Array.from(commands.values()).some(source => source.originShard !== Game.shard.name &&
        source.route.some(hop => hop.shard === Game.shard.name || hop.destinationShard === Game.shard.name))
    synchronizeWorkers(commands, now)
    const localState = communication ? getLocalShardState() : undefined
    for (const source of commands.values()) {
        if (!localState) break
        if (!source.route.some(hop => hop.shard === Game.shard.name || hop.destinationShard === Game.shard.name)) continue
        const reports = localState.reports || (localState.reports = {})
        const units = workers.filter(creep => creep.memory.targetDismantle?.missionId === source.missionId).map(unitStatus)
        if (terminal(source.state) && !units.length) continue
        const key = `${source.missionId}:status`, previous = reports[key]
        const next: Status = { type: 'targetDismantleStatus', missionId: source.missionId, originShard: source.originShard,
            shard: Game.shard.name, generation: source.generation, updatedAt: now, units }
        if (source.flagName && source.targetShard === Game.shard.name) next.flag = getFlagDismantleSnapshot(source.flagName)
        // TTL changes every tick; identity, progress and errors trigger immediate reports, TTL only the periodic heartbeat.
        const stable = (values: unknown) => Array.isArray(values) ? values.map(value => {
            if (!isRecord(value)) return value
            const { ttl, ...unit } = value; return unit
        }) : undefined
        if (heartbeat || !isRecord(previous) || previous.generation !== source.generation ||
            JSON.stringify(previous.flag) !== JSON.stringify(next.flag) ||
            JSON.stringify(stable(previous.units)) !== JSON.stringify(stable(units))) {
            reports[key] = next; markShardStateDirty()
        }
    }
    pruneHistory()
}
