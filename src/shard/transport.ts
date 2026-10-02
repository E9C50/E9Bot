import { interShardPolicy } from 'settings/interShard'
import { isPortalTravelData, isRecord, SHARD_TRANSPORT_VERSION, ShardAcknowledgement, ShardEnvelope, ShardTransfer } from './types'

interface TickCache {
    shard: string
    tick: number
    root: Record<string, unknown>
    local: ShardEnvelope
    writable: boolean
    dirty: boolean
    remote: Map<string, ShardEnvelope | undefined>
}

let cache: TickCache | undefined

function emptyEnvelope(): ShardEnvelope {
    return { version: SHARD_TRANSPORT_VERSION, transfers: {}, acks: {} }
}

function fail(state: TickCache, message: string): false {
    state.local.lastError = message
    return false
}

function available(): boolean {
    return interShardPolicy.enabled && typeof InterShardMemory !== 'undefined' &&
        typeof InterShardMemory.getLocal === 'function' && typeof InterShardMemory.setLocal === 'function'
}

/** JSON UTF-8 长度；不依赖 Screeps 运行时未提供的 Buffer/TextEncoder。 */
export function serializedByteLength(text: string): number {
    let bytes = 0
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index)
        if (code < 0x80) bytes++
        else if (code < 0x800) bytes += 2
        else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length &&
            text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++ }
        else bytes += 3
    }
    return bytes
}

function normalizeEnvelope(value: unknown): ShardEnvelope | undefined {
    if (!isRecord(value) || value.version !== SHARD_TRANSPORT_VERSION ||
        (value.transfers !== undefined && !isRecord(value.transfers)) ||
        (value.acks !== undefined && !isRecord(value.acks)) ||
        (value.reports !== undefined && !isRecord(value.reports))) return undefined
    return { ...value, version: SHARD_TRANSPORT_VERSION,
        transfers: (value.transfers || {}) as Record<string, ShardTransfer>,
        acks: (value.acks || {}) as Record<string, ShardAcknowledgement> }
}

function tickCache(): TickCache {
    const shard = Game.shard.name
    if (cache != undefined && cache.shard === shard && cache.tick === Game.time) return cache
    const next: TickCache = { shard, tick: Game.time, root: {}, local: emptyEnvelope(), writable: false, dirty: false, remote: new Map() }
    cache = next
    if (!available()) { fail(next, 'InterShardMemory is unavailable or disabled'); return next }
    try {
        const text = InterShardMemory.getLocal()
        const root: unknown = text ? JSON.parse(text) : {}
        if (!isRecord(root)) { fail(next, 'Local InterShardMemory JSON must be an object'); return next }
        next.root = root
        const value = root[interShardPolicy.namespace]
        if (value !== undefined) {
            const envelope = normalizeEnvelope(value)
            if (envelope === undefined) { fail(next, 'Unsupported or malformed local shard envelope'); return next }
            next.local = envelope
        }
        next.writable = true
    } catch (error) {
        fail(next, `Cannot read local InterShardMemory: ${error instanceof Error ? error.message : String(error)}`)
    }
    return next
}

export function getLocalShardState(): ShardEnvelope { return tickCache().local }
export function getShardTransportError(): string | undefined { return tickCache().local.lastError }
export function markShardStateDirty(): void { tickCache().dirty = true }

/** 放弃旧路线时撤销该单位的本地待迁移快照，避免未来行程误用。 */
export function cancelCreepTransfers(creep: Creep): void {
    if (!isPortalTravelData(creep.memory.data)) return
    const state = tickCache()
    for (const [id, transfer] of Object.entries(state.local.transfers)) {
        if (isRecord(transfer) && transfer.creepName == creep.name && transfer.missionId == creep.memory.data.missionId) {
            delete state.local.transfers[id]
            state.dirty = true
        }
    }
}

/** 同一 tick、同一个 peer 最多读取/解析一次；坏 JSON 或未来版本作为不可用 peer。 */
export function readRemoteShardState(shard: string): ShardEnvelope | undefined {
    const state = tickCache()
    if (shard === state.shard) return state.local
    if (state.remote.has(shard)) return state.remote.get(shard)
    let result: ShardEnvelope | undefined
    if (available() && typeof InterShardMemory.getRemote === 'function') {
        try {
            const text = InterShardMemory.getRemote(shard)
            const root: unknown = text ? JSON.parse(text) : undefined
            if (isRecord(root)) result = normalizeEnvelope(root[interShardPolicy.namespace])
        } catch { /* 单个 peer 的数据损坏不影响其它 shard。 */ }
    }
    state.remote.set(shard, result)
    return result
}

function validTransfer(value: unknown, sourceShard: string, now: number): value is ShardTransfer {
    if (!isRecord(value) || typeof value.id !== 'string' || value.fromShard !== sourceShard ||
        typeof value.toShard !== 'string' || typeof value.creepName !== 'string' || typeof value.missionId !== 'string' ||
        typeof value.expiresAt !== 'number' || value.expiresAt <= now || typeof value.createdAt !== 'number' ||
        !Number.isInteger(value.nextHopIndex) || !isRecord(value.memory) ||
        typeof value.memory.role !== 'string' || !interShardPolicy.allowedRoles.includes(value.memory.role) ||
        !isPortalTravelData(value.memory.data)) return false
    const data = value.memory.data
    const index = value.nextHopIndex as number
    return data.missionId === value.missionId && data.hopIndex === index && index > 0 &&
        index <= data.route.length && data.route[index - 1].shard === sourceShard &&
        data.route[index - 1].destinationShard === value.toShard
}

function prune(state: TickCache): void {
    const now = Date.now()
    for (const [id, transfer] of Object.entries(state.local.transfers)) {
        let acknowledged = false
        if (validTransfer(transfer, state.shard, now)) {
            const ack = readRemoteShardState(transfer.toShard)?.acks[id]
            acknowledged = ack != undefined && ack.id === id && ack.fromShard === transfer.toShard &&
                ack.toShard === state.shard && ack.creepName === transfer.creepName && ack.expiresAt > now
        }
        if (!validTransfer(transfer, state.shard, now) || acknowledged) {
            delete state.local.transfers[id]
            state.dirty = true
        }
    }
    for (const [id, ack] of Object.entries(state.local.acks)) {
        if (!isRecord(ack) || ack.id !== id || ack.fromShard !== state.shard ||
            typeof ack.toShard !== 'string' || typeof ack.creepName !== 'string' ||
            typeof ack.createdAt !== 'number' || typeof ack.expiresAt !== 'number' || ack.expiresAt <= now) {
            delete state.local.acks[id]
            state.dirty = true
        }
    }
    const acks = Object.values(state.local.acks)
    if (acks.length <= interShardPolicy.maximumAcks) return
    acks.sort((a, b) => a.createdAt - b.createdAt)
    while (acks.length > interShardPolicy.maximumAcks) {
        delete state.local.acks[acks.shift()!.id]
        state.dirty = true
    }
}

function serializedState(state: TickCache): string | undefined {
    try {
        const text = JSON.stringify({ ...state.root, [interShardPolicy.namespace]: state.local })
        if (serializedByteLength(text) > Math.min(interShardPolicy.maximumBytes, 100000)) {
            fail(state, 'InterShardMemory capacity exceeded')
            return undefined
        }
        return text
    } catch (error) {
        fail(state, `Cannot serialize shard state: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
    }
}

/** 写入其它 namespace 的字段保持原值；容量/版本/损坏错误时绝不覆盖原串。 */
export function flushInterShardMemory(): boolean {
    const state = tickCache()
    if (!state.writable || !available()) return false
    prune(state)
    if (!state.dirty) return true
    const text = serializedState(state)
    if (text === undefined) return false
    try {
        InterShardMemory.setLocal(text)
        state.root[interShardPolicy.namespace] = state.local
        state.dirty = false
        return true
    } catch (error) {
        return fail(state, `Cannot write InterShardMemory: ${error instanceof Error ? error.message : String(error)}`)
    }
}

/** 发送的是独立 JSON 快照；原 shard 的 Memory.creeps 被 GC 后仍可完成握手。 */
export function publishCreepTransfer(creep: Creep, destinationShard: string, nextHopIndex: number): boolean {
    const state = tickCache()
    if (!state.writable || !available()) return false
    if (!interShardPolicy.allowedRoles.includes(creep.memory.role) || !isPortalTravelData(creep.memory.data))
        return fail(state, 'Only configured inter-shard mission roles can transfer')
    const data = creep.memory.data
    if (nextHopIndex !== data.hopIndex + 1 || nextHopIndex > data.route.length ||
        data.route[data.hopIndex]?.shard !== state.shard || data.route[data.hopIndex]?.destinationShard !== destinationShard)
        return fail(state, 'Transfer does not match the current portal hop')
    prune(state)
    // 个体 id 区分同名补兵，时间 nonce 区分同一运送者后续再次经过相同入口。
    const prefix = `${state.shard}:${creep.name}:${creep.id}:${data.missionId}:${nextHopIndex}:`
    const previous = Object.values(state.local.transfers).find(transfer => transfer.id.startsWith(prefix))
    const id = previous?.id || `${prefix}${Date.now()}:${Game.time}`
    if (previous === undefined && Object.keys(state.local.transfers).length >= interShardPolicy.maximumTransfers)
        return fail(state, 'Pending transfer capacity exceeded')
    try {
        const memory = JSON.parse(JSON.stringify(creep.memory)) as CreepMemory
        const copiedData = memory.data as unknown as Record<string, unknown>
        copiedData.hopIndex = nextHopIndex
        delete copiedData.transferPreparedAt
        delete copiedData.transferPreparedHop
        delete copiedData.transferPreparedShard
        const now = Date.now()
        state.local.transfers[id] = { id, fromShard: state.shard, toShard: destinationShard, creepName: creep.name,
            missionId: data.missionId, createdAt: previous?.createdAt || now, expiresAt: now + interShardPolicy.transferTtl,
            nextHopIndex, memory }
        if (serializedState(state) === undefined) {
            if (previous === undefined) delete state.local.transfers[id]
            else state.local.transfers[id] = previous
            return false
        }
        state.dirty = true
        return true
    } catch (error) {
        return fail(state, `Cannot copy creep memory: ${error instanceof Error ? error.message : String(error)}`)
    }
}

/** 只恢复无角色的入境单位；现有普通角色和持久任务内存不会被远端覆盖。 */
export function restoreArrivingCreeps(extraPeers: readonly string[] = []): number {
    const state = tickCache()
    if (!state.writable || !available()) return 0
    const now = Date.now()
    const peers = Array.from(new Set([...interShardPolicy.peers, ...extraPeers])).filter(shard => shard !== state.shard)
    prune(state)
    if (!Object.values(Game.creeps).some(creep => creep.my !== false && creep.memory.role === undefined)) return 0
    let restored = 0
    const arrivals: ShardTransfer[] = []
    for (const peer of peers) {
        const remote = readRemoteShardState(peer)
        if (remote === undefined) continue
        for (const transfer of Object.values(remote.transfers)) {
            if (validTransfer(transfer, peer, now) && transfer.toShard === state.shard) arrivals.push(transfer)
        }
    }
    // 先比较所有 peer 的候选，旧未确认行程不能因 peer 枚举顺序覆盖新行程。
    arrivals.sort((a, b) => b.createdAt - a.createdAt || b.expiresAt - a.expiresAt)
    for (const transfer of arrivals) {
        const peer = transfer.fromShard
        const creep = Game.creeps[transfer.creepName]
        if (creep === undefined || creep.my === false || creep.memory.role !== undefined) continue
        if (state.local.acks[transfer.id] !== undefined) continue
        const ack: ShardAcknowledgement = { id: transfer.id, fromShard: state.shard, toShard: peer,
            creepName: transfer.creepName, createdAt: now, expiresAt: now + interShardPolicy.ackTtl }
        const previous = state.local.acks[transfer.id]
        state.local.acks[transfer.id] = ack
        if (serializedState(state) === undefined) {
            if (previous === undefined) delete state.local.acks[transfer.id]
            else state.local.acks[transfer.id] = previous
            continue
        }
        try {
            creep.memory = JSON.parse(JSON.stringify(transfer.memory)) as CreepMemory
            state.dirty = true
            restored++
        } catch (error) {
            if (previous === undefined) delete state.local.acks[transfer.id]
            else state.local.acks[transfer.id] = previous
            fail(state, `Cannot restore ${transfer.creepName}: ${error instanceof Error ? error.message : String(error)}`)
        }
    }
    prune(state)
    return restored
}
