import { isPortalTravelData, isRecord, PortalHop, PortalTravelData } from './types'

export type ShardUnitKind = 'claimer' | 'builder' | 'hauler' | 'scout'
export type ShardMissionState = 'active' | 'paused' | 'complete' | 'cancelled'

export interface ShardTaskInput {
    id?: string
    sourceRoom: string
    targetShard: string
    targetRoom: string
    /** 省略时由 Observer 情报自动规划。 */
    route?: PortalHop[]
    returnRoute?: PortalHop[]
    /** 自动规划任务的运能单位默认往返；false 表示单程。 */
    roundTrip?: boolean
    /** 自动路线默认先由 scout 实地验证；固定路线可显式启用。 */
    verifyRoute?: boolean
    /** 自动路线缺少情报时派 scout 主动探门，默认开启。 */
    explorePortals?: boolean
    claim?: boolean
    builders?: number
    haulers?: number
    /** 建设任务达到该等级且有 Spawn 后停止续派，默认 RCL4。 */
    targetLevel?: number
    /** 0 表示持续运输；正数表示确认送达该量后停止运输。 */
    energyAmount?: number
    sourceEnergyId?: string
    targetEnergyId?: string
    homeEnergyReserve?: number
}

export interface ShardTaskSpec extends ShardTaskInput {
    id: string
    route: PortalHop[]
    autoRoute?: boolean
    autoReturn?: boolean
    sourceShard: string
    key: string
    claim: boolean
    builders: number
    haulers: number
    targetLevel: number
    energyAmount: number
    homeEnergyReserve: number
}

export interface ShardUnitData extends PortalTravelData {
    task: ShardTaskSpec
    unitKind: ShardUnitKind
    phase?: 'load' | 'outbound' | 'work' | 'return' | 'done'
    done?: boolean
    loadStarted?: number
    lastClaimTick?: number
    lastError?: string
    pendingDelivery?: { amount: number; energyBefore: number; tick: number }
    routeRetryAt?: number
    routeRetryShard?: string
    blockedPortal?: { key: string; until: number; shard: string }
    exploration?: {
        revision: string
        goalShard: string
        goalRoom: string
        returnGoal?: { shard: string; roomName: string }
        stage: 'outbound' | 'return'
        startedAt: number
        elapsedTicks: number
        /** CPU waits consume native lifespan, but not the active exploration timeout. */
        cpuWaitStartedAt?: number
        cpuWaitMilliseconds?: number
        visitedRooms: string[]
        visitedShards: string[]
        /** 已在当前 shard 从当前位置选择的入口，过门后重新选择下一段。 */
        selectedPortalHop?: number
        lastTick?: number
        lastShard?: string
        searchOrigin?: { shard: string; roomName: string }
        searchTarget?: string
        targetStartedTick?: number
        lastPosition?: { shard: string; roomName: string; x: number; y: number }
        stuckTicks?: number
        reportAt?: number
        reportShard?: string
        status?: 'exploring' | 'failed' | 'complete'
        reportPending?: boolean
        excludedRooms?: { shard: string; roomName: string; until: number }[]
    }
    scouting?: {
        revision: string
        outboundRoute: PortalHop[]
        returnRoute?: PortalHop[]
        leg: 'outbound' | 'return'
        elapsedTicks: number
        lastTick?: number
        lastShard?: string
        legStartedTicks?: number
        legs?: { outbound?: number; return?: number }
        lastPosition?: { shard: string; roomName: string; x: number; y: number }
        stuckTicks?: number
        proofPending?: { leg: 'outbound' | 'return'; result: 'verified' | 'failed'; message?: string }
    }
    routeIssue?: { hop: PortalHop; updatedAt: number; message: string }
}

export interface ShardUnitLease {
    name: string
    displayName: string
    kind: ShardUnitKind
    generation: number
    createdAt: number
    expiresAt: number
    seenAt?: number
    leaving?: boolean
    departed?: boolean
    lastShard?: string
    acknowledgedAt?: number
    /** 原始位置事件的 UTC 时间，防旧 shard 快照覆盖更新的过门确认。 */
    locationUpdatedAt?: number
}

export interface ShardMission {
    task: ShardTaskSpec
    state: ShardMissionState
    createdAt: number
    generation: number
    leases: Record<string, ShardUnitLease>
    energyDelivered: number
    targetOwned?: boolean
    targetLevel?: number
    targetSpawns?: number
    lastReportAt?: number
    lastError?: string
    exploration?: {
        revision: string
        /** 安全判定升级后，存量探门任务只迁移一次旧前置路线。 */
        safetyVersion?: number
        status: 'pending' | 'exploring' | 'failed' | 'complete'
        startedAt?: number
        updatedAt?: number
        retryAt?: number
        lastShard?: string
        lastRoom?: string
        lastError?: string
        entryRoute: PortalHop[]
        visitedRooms: string[]
        lastReportAt?: number
        cpuWaitMilliseconds?: number
    }
    scouting?: {
        revision: string
        planSignature: string
        status: 'pending' | 'scouting' | 'verified' | 'failed'
        outbound?: boolean
        returning?: boolean
        verifiedAt?: number
        lastError?: string
        retryAt?: number
        startedAt?: number
        outboundTicks?: number
        returnTicks?: number
        outboundVerifiedAt?: number
        returnVerifiedAt?: number
    }
    blockedPortals?: { hop: PortalHop; until: number }[]
    routing?: {
        status: 'planning' | 'ready' | 'waiting'
        updatedAt: number
        nextAttemptTick?: number
        message?: string
        cost?: number
        returnCost?: number
        portalSignature?: string
    }
}

export interface ShardMissionReport {
    type: 'status'
    missionId: string
    originShard: string
    shard: string
    updatedAt: number
    energyDelivered: number
    targetOwned?: boolean
    targetLevel?: number
    targetSpawns?: number
    units: { name: string; kind: ShardUnitKind; done: boolean; ttl?: number; error?: string; routeIssue?: ShardUnitData['routeIssue'] }[]
}

export interface ShardScoutProof {
    missionId: string
    sourceShard: string
    scoutName: string
    revision: string
    leg: 'outbound' | 'return'
    result: 'verified' | 'failed'
    route: PortalHop[]
    shard: string
    roomName: string
    updatedAt: number
    elapsedTicks: number
    message?: string
    failedHop?: PortalHop
    observation?: { controllerPresent: boolean; my: boolean; owner?: string; reservation?: string }
}

export interface ShardArrivalRecord {
    task: ShardTaskSpec
    updatedAt: number
    energyDelivered: number
}

export interface PortalExplorationReport {
    missionId: string
    sourceShard: string
    explorerName: string
    revision: string
    status: 'exploring' | 'failed' | 'complete'
    shard: string
    roomName: string
    updatedAt: number
    elapsedTicks: number
    cpuWaitMilliseconds?: number
    visitedRooms: string[]
    route?: PortalHop[]
    lastError?: string
    failedHop?: PortalHop
}

export function isShardUnitData(data: CreepData): data is ShardUnitData {
    if (!isPortalTravelData(data) || !isRecord(data) || !isRecord(data.task)) return false
    const task = data.task
    return typeof task.key == 'string' && data.missionId == task.key &&
        ['claimer', 'builder', 'hauler', 'scout'].includes(String(data.unitKind)) &&
        ['sourceShard', 'sourceRoom', 'targetShard', 'targetRoom'].every((key) => typeof task[key] == 'string' && (task[key] as string).length > 0) &&
        ['builders', 'haulers', 'targetLevel', 'energyAmount', 'homeEnergyReserve'].every((key) => Number.isInteger(task[key]) && (task[key] as number) >= 0) &&
        typeof task.claim == 'boolean' && Array.isArray(task.route)
}
