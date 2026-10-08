import { populationPolicy } from 'settings/population'
import { hasRemoteHomeEconomy } from './remoteHomeEconomy'
import { getRemoteRoadWork } from './remoteRoads'
import { reserveFlagSpawnAllowed } from './reserveFlags'

export interface RemoteCommissioningSource { id: string; x: number; y: number }
export type RemoteCommissioningPhase = 'scouting' | 'reserving' | 'mining' | 'hauling' | 'ready' | 'waiting'
export interface RemoteCommissioningOptions {
    kind: 'manual' | 'automatic'
    reserveRequired: boolean
    haulerCounts?: Record<string, number>
    planningComplete?: boolean
}
export interface RemoteCommissioningDecision {
    admitted: boolean
    maintenance: boolean
    phase: RemoteCommissioningPhase
    reason?: string
}
interface SourceState extends RemoteCommissioningSource {
    haulers: number
    delivered?: boolean
    /** A paid hauler remains commissioned while empty on its normal return trip. Native ids distinguish replacements. */
    haulersSeen?: Record<string, true>
}
export interface CommissionedRemoteRoom {
    kind: RemoteCommissioningOptions['kind']
    reserveRequired: boolean
    planningComplete?: boolean
    sources: Record<string, SourceState>
    phase: RemoteCommissioningPhase
    maintenance: boolean
    /** Ever fully commissioned; this durable latch controls maintenance, not current fleet health. */
    ready: boolean
    operational?: boolean
    admitted?: boolean
    reason?: string
    controllerPos?: { x: number; y: number }
    reserveConfirmed?: boolean
}
export interface RemoteCommissioningState {
    current?: string
    rooms: Record<string, CommissionedRemoteRoom>
}
declare global { interface RoomMemory { remoteCommissioning?: RemoteCommissioningState } }

const ROOM_NAME = /^[WE]\d+[NS]\d+$/
let tick = -1, shard = '', byHome = new Map<string, Creep[]>()

function units(home: Room): Creep[] {
    if (tick !== Game.time || shard !== Game.shard.name) {
        tick = Game.time; shard = Game.shard.name; byHome = new Map()
        for (const creep of Object.values(Game.creeps || {})) {
            const name = creep.memory.spawnRoom
            if (!name || !['reserver', 'rHarvester', 'rFiller'].includes(creep.memory.role)) continue
            const group = byHome.get(name)
            if (group) group.push(creep); else byHome.set(name, [creep])
        }
    }
    return byHome.get(home.name) || []
}
function stateFor(home: Room): RemoteCommissioningState {
    const state = home.memory.remoteCommissioning || (home.memory.remoteCommissioning = { rooms: {} })
    if (!state.rooms || typeof state.rooms !== 'object' || Array.isArray(state.rooms)) state.rooms = {}
    return state
}
function manualTargets(home: Room): string[] {
    const targets: string[] = []
    for (let index = 0; index < populationPolicy.maximumRemoteRooms; index++) {
        const room = Game.flags?.[`${home.name}_OUT${index}`]?.pos.roomName
        if (!room || room === home.name || !ROOM_NAME.test(room) || targets.includes(room)) continue
        const visible = Game.rooms?.[room]
        // A known occupied/non-controller room cannot be an energy remote for this flag.
        if (visible && (!visible.controller || visible.controller.owner || visible.sources?.length === 0)) continue
        targets.push(room)
    }
    return targets
}
function sourceId(creep: Pick<Creep, 'memory'>): string | undefined {
    const data = (creep.memory.data || {}) as Partial<RemoteFillerData & RemoteHarvesterData> & {
        developmentRemote?: { source?: { id: string }; targetRoom?: string }
    }
    return data.developmentRemote?.source?.id || (creep.memory.role === 'rHarvester' ? data.sourceId : data.sourceFlag)
}
function targetOf(creep: Pick<Creep, 'memory'>, sources: Record<string, SourceState>): string | undefined {
    const data = (creep.memory.data || {}) as Partial<ReserverData & RemoteHarvesterData> & {
        developmentRemote?: { targetRoom?: string }
    }
    const target = data.developmentRemote?.targetRoom || data.targetRoom
    if (target) return target
    const id = sourceId(creep)
    return id && sources[id] ? '__source__' : undefined
}
function assigned(creep: Creep, roomName: string, sources: Record<string, SourceState>): boolean {
    const target = targetOf(creep, sources)
    return target === roomName || target === '__source__'
}
function boosted(creep: Creep): boolean {
    const plan = creep.memory.boostPlan
    return !plan || !plan.failed && (plan.completed === true || plan.steps.length === 0)
}
function live(creep: Creep, part: BodyPartConstant): boolean {
    if ((creep.memory.data as { developmentRemote?: { retiring?: boolean } } | undefined)?.developmentRemote?.retiring) return false
    const active = typeof creep.getActiveBodyparts === 'function' ? creep.getActiveBodyparts(part) :
        (creep.body || []).filter(value => value.type === part && value.hits > 0).length
    return !creep.spawning && boosted(creep) && active > 0
}
function range(creep: Creep, targetRoom: string, point: { x: number; y: number }): number {
    return creep.pos.roomName === targetRoom ? Math.max(Math.abs(creep.pos.x - point.x), Math.abs(creep.pos.y - point.y)) : Infinity
}
function usableSource(source: RemoteCommissioningSource): boolean {
    return !!source && typeof source.id === 'string' && !!source.id && Number.isInteger(source.x) &&
        Number.isInteger(source.y) && source.x >= 0 && source.y >= 0 && source.x < 50 && source.y < 50
}
function setSources(record: CommissionedRemoteRoom, sources: RemoteCommissioningSource[] | undefined,
    options: RemoteCommissioningOptions): void {
    if (sources === undefined) return
    const next: Record<string, SourceState> = options.planningComplete === false ? { ...record.sources } : {}
    for (const source of sources) {
        if (!usableSource(source)) continue
        const requested = options.haulerCounts?.[source.id]
        const haulers = Number.isSafeInteger(requested) && requested! > 0 ? requested! : 1
        next[source.id] = { ...record.sources[source.id], ...source, haulers }
    }
    record.sources = next
}
function reserveReady(home: Room, targetRoom: string, record: CommissionedRemoteRoom, members: Creep[]): boolean {
    if (!record.reserveRequired) return true
    const target = Game.rooms?.[targetRoom], controller = target?.controller
    if (controller) {
        record.controllerPos = { x: controller.pos.x, y: controller.pos.y }
        record.reserveConfirmed = controller.reservation?.username === home.controller?.owner?.username &&
            (controller.reservation?.ticksToEnd || 0) > 0
    }
    return record.reserveConfirmed === true && !!record.controllerPos && members.some(creep =>
        creep.memory.role === 'reserver' && assigned(creep, targetRoom, record.sources) && live(creep, CLAIM) &&
        range(creep, targetRoom, record.controllerPos!) <= 1)
}
function evaluate(home: Room, targetRoom: string, record: CommissionedRemoteRoom): { phase: RemoteCommissioningPhase; reason?: string } {
    if (record.reserveRequired && home.energyCapacityAvailable < BODYPART_COST[CLAIM] + BODYPART_COST[MOVE])
        return { phase: 'waiting', reason: 'Waiting for 650 energy capacity to commission the remote reserver' }
    const sources = Object.values(record.sources), members = units(home)
    if (!sources.length) return { phase: 'scouting', reason: 'Waiting for remote Source visibility and planning' }
    const target = Game.rooms?.[targetRoom]
    if (target?.controller?.owner) return { phase: 'waiting', reason: 'Remote Controller is owned; no new mining can start' }
    if (!reserveReady(home, targetRoom, record, members))
        return { phase: 'reserving', reason: 'Waiting for a live reserver at Controller and our active reservation; a blocked entrance must be opened' }
    for (const source of sources) if (!members.some(creep => creep.memory.role === 'rHarvester' &&
        sourceId(creep) === source.id && assigned(creep, targetRoom, record.sources) && live(creep, WORK) && range(creep, targetRoom, source) <= 1))
        return { phase: 'mining', reason: `Waiting for an operational miner at Source ${source.id}` }
    for (const source of sources) {
        const candidates = members.filter(creep => creep.memory.role === 'rFiller' && sourceId(creep) === source.id &&
            assigned(creep, targetRoom, record.sources))
        const seen = source.haulersSeen || (source.haulersSeen = {})
        const current = new Set(candidates.filter(creep => live(creep, CARRY) && live(creep, MOVE)).map(creep => creep.id))
        for (const id in seen) if (!current.has(id as Id<Creep>)) delete seen[id]
        let ready = 0
        for (const creep of candidates) {
            if (!live(creep, CARRY) || !live(creep, MOVE)) continue
            if (range(creep, targetRoom, source) <= 3 || creep.memory.working && (creep.store?.[RESOURCE_ENERGY] || 0) > 0) seen[creep.id] = true
            if (seen[creep.id]) ready++
        }
        if (ready < source.haulers) return { phase: 'hauling', reason: `Waiting for operational haulers at Source ${source.id} (${ready}/${source.haulers})` }
        if (!source.delivered) return { phase: 'hauling', reason: `Waiting for the first successful energy delivery from Source ${source.id}` }
    }
    if (record.planningComplete === false) return { phase: 'hauling', reason: 'Waiting for complete Source planning before opening another remote' }
    return { phase: 'ready' }
}

/** One new remote at a time; already paid or commissioned remotes retain their maintenance demands. */
export function remoteCommissioningDecision(home: Room, targetRoom: string, sources: RemoteCommissioningSource[] | undefined,
    options: RemoteCommissioningOptions): RemoteCommissioningDecision {
    const state = stateFor(home), manual = manualTargets(home)
    if (state.current && state.rooms[state.current]?.kind === 'manual' && !manual.includes(state.current)) delete state.current
    let record = state.rooms[targetRoom]
    if (!record) {
        record = state.rooms[targetRoom] = { kind: options.kind, reserveRequired: options.reserveRequired,
            sources: {}, phase: 'scouting', maintenance: false, ready: false }
        setSources(record, sources, options)
        // Only an existing paid mining/hauling fleet proves migration. A freshly born reserver cannot bypass stages.
        record.maintenance = units(home).some(creep => ['rHarvester', 'rFiller'].includes(creep.memory.role) &&
            assigned(creep, targetRoom, record.sources))
    } else setSources(record, sources, options)
    record.kind = options.kind; record.reserveRequired = options.reserveRequired
    if (options.planningComplete !== undefined) record.planningComplete = options.planningComplete
    if (options.kind === 'manual' && !manual.includes(targetRoom)) {
        record.phase = 'waiting'; record.operational = false; record.reason = 'Manual OUT target is absent or cannot be a remote mining room'
        if (state.current === targetRoom) delete state.current
        return { admitted: false, maintenance: record.maintenance, phase: 'waiting', reason: record.reason }
    }
    if (options.kind === 'manual' && state.current && state.current !== targetRoom) {
        const current = state.rooms[state.current]
        // An automatic scout can lose its scoutTarget when OUT flags consume the remote budget. Let manual work take
        // this unstarted slot, but retain any remote whose reservation or paid mining/hauling fleet has already begun.
        if (current?.kind === 'automatic' && current.phase === 'scouting' && !current.maintenance &&
            !units(home).some(creep => ['rHarvester', 'rFiller'].includes(creep.memory.role) &&
                assigned(creep, state.current!, current.sources)))
            releaseRemoteCommissioning(home, state.current, 'Automatic scouting yields to manual OUT commissioning')
    }
    const progress = evaluate(home, targetRoom, record)
    record.operational = progress.phase === 'ready'; record.phase = progress.phase; record.reason = progress.reason
    if (record.operational) {
        record.ready = true; record.admitted = true
        record.maintenance = true
        if (state.current === targetRoom) delete state.current
        return { admitted: true, maintenance: true, phase: 'ready' }
    }
    const earlier = manual.find(name => state.rooms[name]?.ready !== true)
    let waiting = state.current && state.current !== targetRoom ? `Waiting for current remote ${state.current}` :
        options.kind === 'automatic' && earlier ? `Waiting for manual OUT remote ${earlier}` :
        options.kind === 'manual' && earlier && earlier !== targetRoom ? `Waiting for earlier OUT remote ${earlier}` : undefined
    if (!record.maintenance && state.current !== targetRoom) for (const [name, established] of Object.entries(state.rooms)) {
        if (name === targetRoom || !established.maintenance || established.kind === 'manual' && !manual.includes(name) ||
            established.kind === 'automatic' && !home.memory.developmentRemotes?.selectedRooms?.includes(name)) continue
        const health = evaluate(home, name, established)
        established.operational = health.phase === 'ready'; established.phase = health.phase; established.reason = health.reason
        if (!established.operational) { waiting = `Waiting to restore commissioned remote ${name}: ${health.reason || health.phase}`; break }
    }
    if (waiting && !record.maintenance && state.current !== targetRoom) {
        record.phase = 'waiting'; record.reason = waiting
        return { admitted: false, maintenance: false, phase: 'waiting', reason: waiting }
    }
    if (!state.current && !record.ready && (!earlier || options.kind === 'manual' && earlier === targetRoom || record.maintenance)) state.current = targetRoom
    record.admitted = true
    return { admitted: true, maintenance: record.maintenance, ...progress }
}

/** Read-only cached positions keep commissioned mining demand alive when an observer loses visibility. */
export function getRemoteCommissioningSources(home: Room, targetRoom: string): RemoteCommissioningSource[] {
    return Object.values(home.memory.remoteCommissioning?.rooms[targetRoom]?.sources || {}).map(({ id, x, y }) => ({ id, x, y }))
}

/** A proven unreachable route relinquishes the new-remote slot without discarding paid fleet/history. */
export function releaseRemoteCommissioning(home: Room, targetRoom: string, reason = 'Remote route is unreachable'): void {
    const state = home.memory.remoteCommissioning
    if (!state) return
    if (state.current === targetRoom) delete state.current
    const room = state.rooms[targetRoom]
    if (room) { room.phase = 'waiting'; room.operational = false; room.admitted = false; room.reason = reason }
}

/** Record only a real accepted energy-transfer intent from a registered remote source, at its home. */
export function recordRemoteEnergyDelivery(creep: Creep, amount: number): void {
    if (!(amount > 0) || !Number.isFinite(amount) || creep.memory.role !== 'rFiller' || !creep.memory.spawnRoom ||
        creep.pos?.roomName !== creep.memory.spawnRoom) return
    const home = Game.rooms?.[creep.memory.spawnRoom], state = home?.memory.remoteCommissioning
    if (!state) return
    const id = sourceId(creep)
    if (!id) return
    for (const [targetRoom, room] of Object.entries(state.rooms)) {
        const source = room.sources[id]
        if (!source || !assigned(creep, targetRoom, room.sources)) continue
        source.delivered = true
        const seen = source.haulersSeen || (source.haulersSeen = {})
        seen[creep.id] = true
        return
    }
}

/** Current-tick birth guard for stale queues; unrelated RF_S/RB_S work remains ordinary demand. */
export function remoteSpawnAllowed(home: Room, config: CreepMemory): boolean {
    if (!['reserver', 'rHarvester', 'rFiller', 'rBuilder', 'scout'].includes(config.role)) return true
    if (!home.name || !home.memory) return true
    const data = (config.data || {}) as Partial<ReserverData & RemoteHarvesterData & RemoteFillerData & RemoteBuilderData & ScoutData> & {
        developmentRemote?: { targetRoom?: string; source?: { id: string } }
    }
    // Spawnless newly claimed rooms use their own bootstrap pipeline, even when a Source belonged to an old OUT mine.
    if (config.role === 'reserver' && data.reserveFlag) return reserveFlagSpawnAllowed(home, data as ReserverData)
    if (config.role === 'rBuilder' && data.bootstrap === true) return true
    if (config.role === 'rBuilder' && data.roadHome &&
        (data.roadHome !== home.name || !getRemoteRoadWork(home))) return false
    const state = home.memory.remoteCommissioning, manual = manualTargets(home)
    let target = data.developmentRemote?.targetRoom || data.targetRoom
    const outScout = !!data.targetFlag && new RegExp(`^${home.name}_OUT\\d+$`).test(data.targetFlag)
    const flag = data.targetFlag && Game.flags?.[data.targetFlag]
    if (outScout && !flag) return false
    if (!target && flag && outScout) target = flag.pos.roomName
    const id = config.role === 'rHarvester' ? data.sourceId : data.developmentRemote?.source?.id || data.sourceFlag
    if (!target && id) {
        target = Object.entries(state?.rooms || {}).find(([, room]) => !!room.sources[id])?.[0]
        if (!target && typeof Game.getObjectById === 'function') target = Game.getObjectById<Source>(id)?.pos.roomName
    }
    if (!target) return true
    const record = state?.rooms[target], automatic = home.memory.developmentRemotes?.selectedRooms?.includes(target) === true ||
        config.role === 'scout' && home.memory.developmentRemotes?.scoutTarget === target
    const registered = manual.includes(target) || automatic || !!record
    if (!registered) return true
    if (!hasRemoteHomeEconomy(home)) return false
    if (record?.kind === 'manual' && !manual.includes(target) || data.developmentRemote && !automatic) return false
    if (!record) return false
    if (record.maintenance) return true
    if (state?.current !== target) return false
    if (config.role === 'reserver' || config.role === 'scout') return true
    if (config.role === 'rHarvester') return ['mining', 'hauling', 'ready'].includes(record.phase)
    return ['hauling', 'ready'].includes(record.phase)
}
