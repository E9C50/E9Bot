import { canPrepareBoosts, reserveBoostPlan } from 'creep/boosting'
import type { DismantleTarget, TargetDismantleOrder } from 'creep/targetDismantle'
import { isRoomEvacuating } from 'room/evacuationState'
import { interShardPolicy } from 'settings/interShard'
import { cancelCreepTransfers, flushInterShardMemory, getLocalShardState, getShardTransportError,
    markShardStateDirty, readRemoteShardState } from './transport'
import { isPortalTravelData, isRecord, PortalHop, PortalTravelData, ShardEnvelope } from './types'

type TaskState = 'active' | 'paused' | 'completed' | 'cancelled'
export interface TargetDismantleTaskInput {
    sourceRoom: string
    targetShard: string
    targetRoom: string
    route: PortalHop[]
    targets: DismantleTarget[]
    controller: { x: number; y: number }
    /** Native spawn energy only; boost minerals remain subject to real-stock preflight. */
    maxEnergy?: number
}
interface UnitLease {
    name: string; generation: number; createdAt: number; expiresAt: number
    lastShard: string; seenAt?: number; locationAt: number; acknowledgedAt?: number
    leaving?: boolean; confirmed?: boolean
}
export interface TargetDismantleTask {
    id: string; key: string; sourceShard: string; input: TargetDismantleTaskInput
    state: TaskState; createdAt: number; updatedAt: number; finishedAt?: number
    generation: number; spent: number; maxEnergy: number; index: number
    lease?: UnitLease; reason?: string
}
interface Command {
    type: 'targetDismantleCommand'; missionId: string; originShard: string
    state: TaskState; generation: number; updatedAt: number; expiresAt: number
    route: PortalHop[]; reason?: string
}
interface UnitStatus {
    name: string; generation: number; index: number; done: boolean
    boostFailed: boolean; error?: string; ttl?: number; leaving: boolean
}
interface Status {
    type: 'targetDismantleStatus'; missionId: string; originShard: string
    shard: string; generation: number; updatedAt: number; units: UnitStatus[]
}
declare global { interface Memory { targetDismantleTasks?: Record<string, TargetDismantleTask> } }

const PREFIX = 'targetDismantle:'
const BODY_COST = 4500
const HISTORY_LIMIT = 20
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
function keyFor(id: string): string { return id.startsWith(PREFIX) ? id : `${PREFIX}${Game.shard.name}:${id}` }
function taskFor(id: string): TargetDismantleTask | undefined {
    return allTasks()[keyFor(id)] || Object.values(allTasks()).find(task => task.id === id && task.sourceShard === Game.shard.name)
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
function point(value: unknown): boolean {
    return isRecord(value) && Number.isInteger(value.x) && Number.isInteger(value.y) &&
        (value.x as number) >= 0 && (value.x as number) < 50 && (value.y as number) >= 0 && (value.y as number) < 50
}
function boostPlan(): CreepBoostPlan {
    return { tier: 3, steps: [
        { type: 'boostDismantle', resource: RESOURCE_CATALYZED_ZYNTHIUM_ACID, parts: 40 },
        { type: 'boostMove', resource: RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE, parts: 10 },
    ] }
}
function publish(task: TargetDismantleTask, heartbeat = false): void {
    const state = getLocalShardState(), reports = state.reports || (state.reports = {})
    const old = reports[task.key]
    if (!heartbeat && isRecord(old) && old.type === 'targetDismantleCommand' && old.state === task.state &&
        old.generation === task.generation && old.reason === task.reason) return
    const now = Date.now()
    reports[task.key] = { type: 'targetDismantleCommand', missionId: task.key, originShard: task.sourceShard,
        state: task.state, generation: task.generation, reason: task.reason, route: task.input.route,
        updatedAt: now, expiresAt: now + interShardPolicy.arrivalHistoryTtl } as Command
    markShardStateDirty()
}
function pause(task: TargetDismantleTask, reason: string): void {
    task.state = 'paused'; task.reason = reason; task.updatedAt = Date.now(); publish(task)
}
function finish(task: TargetDismantleTask, state: 'completed' | 'cancelled', reason?: string): void {
    task.state = state; task.reason = reason; task.finishedAt = task.updatedAt = Date.now(); publish(task)
}
function command(value: unknown, source: string, now: number): value is Command {
    return isRecord(value) && value.type === 'targetDismantleCommand' && value.originShard === source &&
        typeof value.missionId === 'string' && value.missionId.startsWith(`${PREFIX}${source}:`) &&
        STATES.includes(value.state as TaskState) && Number.isInteger(value.generation) && (value.generation as number) >= 0 &&
        typeof value.updatedAt === 'number' && value.updatedAt <= now + 5000 &&
        typeof value.expiresAt === 'number' && value.expiresAt > now &&
        isPortalTravelData({ missionId: value.missionId, originShard: source, route: value.route, hopIndex: 0 })
}
function fresh(time: number, now: number): boolean { return time <= now + 5000 && now - time <= interShardPolicy.reportMaxAge }
function validStatus(value: unknown, task: TargetDismantleTask, shard: string, now: number): value is Status {
    return isRecord(value) && value.type === 'targetDismantleStatus' && value.missionId === task.key &&
        task.input.route.some(hop => hop.shard === shard || hop.destinationShard === shard) &&
        value.originShard === task.sourceShard && value.shard === shard && typeof value.updatedAt === 'number' &&
        Number.isInteger(value.generation) && fresh(value.updatedAt, now) && Array.isArray(value.units) && value.units.length <= 2 &&
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
    if (unit.done && !task.finishedAt) finish(task, 'completed')
    else if (unit.boostFailed && !task.finishedAt) pause(task, `Boost failed: ${unit.error || 'exact T3 boost preparation failed'}`)
    else if (task.state === 'active') task.reason = unit.error
}

/** Explicit route and exact barrier list; there is no general attack or builder fallback. */
export function createTargetDismantleTask(id: string, input: TargetDismantleTaskInput): string {
    if (!interShardPolicy.enabled || typeof InterShardMemory === 'undefined') return '跨 shard 通信不可用'
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !isRecord(input)) return '须指定 1..64 位任务 id 和有效配置'
    const existing = taskFor(id)
    if (existing) return `精确拆除任务 ${id} 已存在（${existing.state}），不会重复派兵`
    if (Object.values(allTasks()).filter(task => !task.finishedAt).length >= interShardPolicy.maximumTasks) return '精确拆除任务数量已达上限'
    const roomNames = /^[WE]\d+[NS]\d+$/
    if (typeof input.sourceRoom !== 'string' || typeof input.targetRoom !== 'string' ||
        !roomNames.test(input.sourceRoom) || !roomNames.test(input.targetRoom) || typeof input.targetShard !== 'string' ||
        !input.targetShard || input.targetShard === Game.shard.name) return '须指定自有起点及另一个 shard 的目标房间'
    const home = Game.rooms[input.sourceRoom]
    if (!home?.controller?.my || !home.find(FIND_MY_SPAWNS).length) return '起点须有自有 Spawn'
    if (home.energyCapacityAvailable < BODY_COST) return '起点容量不足 4500，不能孵化 40 WORK / 10 MOVE'
    if (!isPortalTravelData({ missionId: keyFor(id), originShard: Game.shard.name, route: input.route, hopIndex: 0 }) ||
        !input.route?.length || input.route.length > 8 || input.route.some(hop => hop.shard === hop.destinationShard || !roomNames.test(hop.roomName)) ||
        input.route[input.route.length - 1].destinationShard !== input.targetShard) return '须指定逐跳连通并到达目标 shard 的明确 Portal 路线'
    if (!point(input.controller) || !Array.isArray(input.targets) || !input.targets.length || input.targets.length > 8 ||
        input.targets.some(target => !isRecord(target) || typeof target.id !== 'string' || !target.id || !point(target) ||
            ![STRUCTURE_WALL, STRUCTURE_RAMPART].includes(target.type)) ||
        new Set(input.targets.map(target => target.id)).size !== input.targets.length) return '须指定 controller 坐标及最多 8 个唯一的 wall/rampart ID 和坐标'
    const budget = input.maxEnergy ?? DEFAULT_BUDGET
    if (!Number.isSafeInteger(budget) || budget < BODY_COST) return '孵化能量预算须为至少 4500 的整数'
    const now = Date.now(), key = `${keyFor(id)}:${now}:${Game.time}`
    const task: TargetDismantleTask = { id, key, sourceShard: Game.shard.name, input: clone(input),
        state: 'active', createdAt: now, updatedAt: now, generation: 0, spent: 0, maxEnergy: budget, index: 0 }
    const records = Memory.targetDismantleTasks || (Memory.targetDismantleTasks = {})
    records[key] = task; publish(task)
    if (!flushInterShardMemory()) {
        delete records[key]; delete getLocalShardState().reports?.[key]; markShardStateDirty()
        return `任务未创建：${getShardTransportError() || '跨 shard 命令无法写入'}`
    }
    pruneHistory()
    return `已创建精确拆除任务 ${id}，一个名额持续补派，预算 ${budget} 能量`
}

export function listTargetDismantleTasks(): string {
    const tasks = Object.values(allTasks())
    return tasks.length ? tasks.map(task => `${task.id}: ${task.state}, ${task.sourceShard}/${task.input.sourceRoom} → ` +
        `${task.input.targetShard}/${task.input.targetRoom}, 目标 ${task.index}/${task.input.targets.length}, ` +
        `能量 ${task.spent}/${task.maxEnergy}, 单位 ${task.lease?.name || '无'}${task.reason ? `, ${task.reason}` : ''}`).join('\n') : '没有精确拆除任务'
}
export function cancelTargetDismantleTask(id: string): string {
    const task = taskFor(id)
    if (!task || task.sourceShard !== Game.shard.name) return '本 shard 未找到精确拆除任务'
    if (task.state === 'completed' || task.state === 'cancelled') return `任务已 ${task.state}`
    finish(task, 'cancelled', 'Cancelled by source shard')
    if (!flushInterShardMemory()) return `已记录取消 ${task.id}，远端广播尚未成功：${getShardTransportError() || '通信不可用'}`
    return `已取消 ${task.id}：停止续派，远端单位收到命令后停止拆除并让出通道`
}

/** Called before creep execution. A missing source heartbeat stops movement/boosting/dismantling. */
function synchronizeWorkers(commands: Map<string, Command>, now: number): void {
    for (const creep of Object.values(Game.creeps)) {
        const order = creep.memory.targetDismantle
        if (!order?.missionId || !order.sourceShard || order.generation === undefined) continue
        const source = commands.get(order.missionId)
        if (!source || !fresh(source.updatedAt, now)) {
            order.controlState = 'paused'; order.lastError = 'Waiting for source command heartbeat'; continue
        }
        order.controlState = source.generation === order.generation ? source.state : 'cancelled'
        if (order.controlState !== 'active') {
            order.lastError = source.generation !== order.generation ? 'Superseded precise dismantle generation' : source.reason || `Task ${source.state}`
            cancelCreepTransfers(creep)
        } else if (order.lastError === 'Waiting for source command heartbeat') delete order.lastError
    }
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

function spawn(task: TargetDismantleTask, now: number): void {
    if (task.state !== 'active' || task.lease) return
    if (task.spent + BODY_COST > task.maxEnergy) { pause(task, 'Native spawn energy budget exhausted'); return }
    const room = Game.rooms[task.input.sourceRoom]
    if (!room?.controller?.my) { pause(task, 'Source room is no longer owned'); return }
    if (isRoomEvacuating(room) || Memory.warMode?.[room.name] || room.enemies?.length) {
        task.reason = 'Waiting for source evacuation/hostilities to clear'; return
    }
    if ((room.memory.creepSpawnQueue || []).some(name => {
        const config = room.memory.creepConfig?.[name]
        return !!config && !Game.creeps[name] && config.spawnPriority < 3.5
    })) { task.reason = 'Waiting for higher-priority economy or defense spawn demands'; return }
    if (room.energyAvailable < BODY_COST) { task.reason = 'Waiting for 4500 spawn energy'; return }
    const nativeSpawn = room.find(FIND_MY_SPAWNS).find(candidate => !candidate.spawning && !isTargetDismantleSpawnReserved(candidate))
    if (!nativeSpawn) { task.reason = 'Waiting for an idle Spawn'; return }
    const plan = boostPlan()
    if (!canPrepareBoosts(room, plan)) { task.reason = 'Waiting for exact T3 boosts: XZH2O 1200 / XZHO2 300'; return }
    const generation = task.generation + 1, name = `td_${task.id}_${task.createdAt.toString(36)}_${generation}_${Game.time}`
    const data: PortalTravelData = { missionId: task.key, originShard: task.sourceShard, route: clone(task.input.route), hopIndex: 0 }
    const order: TargetDismantleOrder = { missionId: task.key, sourceShard: task.sourceShard, generation, controlState: 'active',
        targetShard: task.input.targetShard, targetRoom: task.input.targetRoom, targets: clone(task.input.targets), controller: clone(task.input.controller) }
    const memory: CreepMemory = { name, displayName: task.id, role: 'sBuilder', spawnRoom: room.name, spawnPriority: 3.5,
        ready: false, working: false, data, boostPlan: plan, targetDismantle: order }
    const body: BodyPartConstant[] = [...Array<BodyPartConstant>(40).fill(WORK), ...Array<BodyPartConstant>(10).fill(MOVE)]
    const result = nativeSpawn.spawnCreep(body, name, { memory })
    if (result !== OK) { task.reason = `Native spawn rejected (${result})`; return }
    if (spawnReservationTick !== Game.time || spawnReservationShard !== Game.shard.name) {
        spawnReservationTick = Game.time; spawnReservationShard = Game.shard.name; spawnReservations = new Set()
        spawnRoomReservations = new Set()
    }
    spawnReservations.add(nativeSpawn.id)
    spawnRoomReservations.add(room.name)
    task.generation = generation; task.spent += BODY_COST; task.updatedAt = now; delete task.reason
    task.lease = { name, generation, createdAt: now, expiresAt: now + interShardPolicy.leaseDuration,
        lastShard: Game.shard.name, locationAt: now }
    publish(task)
    reserveBoostPlan(room, name, plan)
}

function pruneHistory(): void {
    const records = allTasks(), done = Object.values(records).filter(task => task.finishedAt).sort((a, b) => b.finishedAt! - a.finishedAt!)
    const now = Date.now(), reports = getLocalShardState().reports
    for (let index = 0; index < done.length; index++) {
        const task = done[index]
        if (index < HISTORY_LIMIT && now - task.finishedAt! < interShardPolicy.arrivalHistoryTtl) continue
        delete records[task.key]
        if (reports) { delete reports[task.key]; delete reports[`${task.key}:status`]; markShardStateDirty() }
    }
    if (reports) for (const [key, value] of Object.entries(reports)) {
        if (!isRecord(value) || !['targetDismantleCommand', 'targetDismantleStatus'].includes(String(value.type))) continue
        if (typeof value.updatedAt === 'number' && now - value.updatedAt > interShardPolicy.arrivalHistoryTtl) {
            delete reports[key]; markShardStateDirty()
        }
    }
}

/** Source owns spawning; every route shard emits alive/empty reports and enforces source commands. */
export function runTargetDismantleControl(): void {
    if (!interShardPolicy.enabled || typeof InterShardMemory === 'undefined') return
    const tasks = Object.values(allTasks()), workers = Object.values(Game.creeps).filter(creep => !!creep.memory.targetDismantle?.missionId)
    const heartbeat = Game.time % interShardPolicy.reportInterval === 0
    if (!tasks.length && !workers.length && !knownRemoteTasks && !heartbeat) return
    // Peers may own a task even when this shard has no workers; cached transport reads stay bounded to four.
    const peers = new Set(interShardPolicy.peers)
    for (const task of tasks) for (const hop of task.input.route) { peers.add(hop.shard); peers.add(hop.destinationShard) }
    for (const creep of workers) if (creep.memory.targetDismantle?.sourceShard) peers.add(creep.memory.targetDismantle.sourceShard)
    peers.delete(Game.shard.name)
    const states = new Map(Array.from(peers, peer => [peer, readRemoteShardState(peer)] as const)), now = Date.now()
    for (const task of tasks) if (task.sourceShard === Game.shard.name) { reconcile(task, states, now); spawn(task, now); publish(task, heartbeat) }
    const commands = new Map<string, Command>()
    for (const [shard, state] of [...states, [Game.shard.name, getLocalShardState()] as const]) {
        for (const value of Object.values(state?.reports || {})) if (command(value, shard, now)) commands.set(value.missionId, value)
    }
    knownRemoteTasks = Array.from(commands.values()).some(source => source.originShard !== Game.shard.name &&
        source.route.some(hop => hop.shard === Game.shard.name || hop.destinationShard === Game.shard.name))
    synchronizeWorkers(commands, now)
    const localState = getLocalShardState()
    for (const source of commands.values()) {
        if (!source.route.some(hop => hop.shard === Game.shard.name || hop.destinationShard === Game.shard.name)) continue
        const reports = localState.reports || (localState.reports = {})
        const units = workers.filter(creep => creep.memory.targetDismantle?.missionId === source.missionId).map(unitStatus)
        const key = `${source.missionId}:status`, previous = reports[key]
        const next: Status = { type: 'targetDismantleStatus', missionId: source.missionId, originShard: source.originShard,
            shard: Game.shard.name, generation: source.generation, updatedAt: now, units }
        // TTL changes every tick; identity, progress and errors trigger immediate reports, TTL only the periodic heartbeat.
        const stable = (values: unknown) => Array.isArray(values) ? values.map(value => {
            if (!isRecord(value)) return value
            const { ttl, ...unit } = value; return unit
        }) : undefined
        if (heartbeat || !isRecord(previous) || previous.generation !== source.generation ||
            JSON.stringify(stable(previous.units)) !== JSON.stringify(stable(units))) {
            reports[key] = next; markShardStateDirty()
        }
    }
    pruneHistory()
}
