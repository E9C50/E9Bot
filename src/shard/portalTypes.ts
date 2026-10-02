import type { PortalHop } from './types'

export interface PortalRecord extends PortalHop {
    id: string
    /** Unix 毫秒；不与其它 shard 的 Game.time 比较。 */
    observedAt: number
    expiresAt?: number
}

export interface PortalIntelSnapshot {
    shard: string
    updatedAt: number
    portals: PortalRecord[]
}

/** 临时门寿命只保存在发现它的 shard，绝不把 tick 猜测换算成毫秒发布。 */
export interface LocalPortalRecord extends PortalRecord {
    expiresAtTick?: number
}

export interface PortalDiscoveryMemory {
    version: 1
    shard: string
    portals: Record<string, LocalPortalRecord>
    scannedRooms: Record<string, number>
    observerCursor: number
    lastScanAt?: number
    lastPublishTick?: number
}

export interface PortalIntelStatus {
    observers: number
    portals: number
    lastScanAt?: number
    message?: string
}
