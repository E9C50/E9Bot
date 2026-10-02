export const SHARD_TRANSPORT_VERSION = 1

/** 每一跳都指向出发 shard 上的一个确定 Portal，可来自自动规划或显式路线。 */
export interface PortalHop {
    shard: string
    roomName: string
    x: number
    y: number
    destinationShard: string
    destinationRoom?: string
}

export interface PortalTravelData {
    missionId: string
    originShard: string
    route: PortalHop[]
    hopIndex: number
    /** 仅在出发 shard 比较 Game.time；目标 shard 使用信封中的下一跳索引。 */
    transferPreparedAt?: number
    transferPreparedHop?: number
    transferPreparedShard?: string
}

export interface ShardTransfer {
    id: string
    fromShard: string
    toShard: string
    creepName: string
    missionId: string
    createdAt: number
    expiresAt: number
    nextHopIndex: number
    memory: CreepMemory
}

export interface ShardAcknowledgement {
    id: string
    fromShard: string
    toShard: string
    creepName: string
    createdAt: number
    expiresAt: number
}

export interface ShardEnvelope {
    version: typeof SHARD_TRANSPORT_VERSION
    transfers: Record<string, ShardTransfer>
    acks: Record<string, ShardAcknowledgement>
    reports?: Record<string, unknown>
    /** 当前运行时错误，可供任务状态展示。损坏原串不会被写回覆盖。 */
    lastError?: string
    [key: string]: unknown
}

export interface PortalTravelResult {
    status: 'arrived' | 'moving' | 'waiting' | 'error'
    message?: string
    reason?: 'portal-missing' | 'portal-destination' | 'no-path'
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isPortalTravelData(value: unknown): value is PortalTravelData {
    if (!isRecord(value) || typeof value.missionId !== 'string' || value.missionId.length === 0 ||
        typeof value.originShard !== 'string' || value.originShard.length === 0 || !Array.isArray(value.route) ||
        !Number.isInteger(value.hopIndex) || (value.hopIndex as number) < 0 || (value.hopIndex as number) > value.route.length) return false
    const route = value.route
    return route.every((hop: unknown, index: number) => {
        if (!isRecord(hop) || typeof hop.shard !== 'string' || !hop.shard ||
            typeof hop.roomName !== 'string' || !hop.roomName || typeof hop.destinationShard !== 'string' || !hop.destinationShard ||
            !Number.isInteger(hop.x) || !Number.isInteger(hop.y) ||
            (hop.x as number) < 0 || (hop.x as number) >= 50 || (hop.y as number) < 0 || (hop.y as number) >= 50 ||
            (hop.destinationRoom !== undefined && (typeof hop.destinationRoom !== 'string' || !hop.destinationRoom))) return false
        const previous = route[index - 1]
        return index === 0 ? hop.shard === value.originShard : isRecord(previous) && hop.shard === previous.destinationShard
    })
}
