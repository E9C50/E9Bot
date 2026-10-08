import type { ShardMissionState, ShardUnitData } from './missions'
import { getLocalShardState, readRemoteShardState } from './transport'
import { isRecord } from './types'

export interface ShardMissionStop {
    state: 'complete' | 'cancelled'
    updatedAt: number
    expiresAt: number
    published?: boolean
}

declare global {
    interface Memory { shardMissionStops?: Record<string, ShardMissionStop> }
}

export interface ShardMissionControl {
    state: ShardMissionState
    updatedAt?: number
    scoutRevision?: string
    scoutStatus?: string
    explorerRevision?: string
    explorerStatus?: string
}

function command(value: unknown, missionId: string): ShardMissionControl | undefined {
    if (!isRecord(value) || value.type !== 'command' ||
        value.missionId !== undefined && value.missionId !== missionId ||
        !['active', 'paused', 'complete', 'cancelled'].includes(String(value.state))) return undefined
    return {
        state: value.state as ShardMissionState,
        updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : undefined,
        scoutRevision: typeof value.scoutRevision === 'string' ? value.scoutRevision : undefined,
        scoutStatus: typeof value.scoutStatus === 'string' ? value.scoutStatus : undefined,
        explorerRevision: typeof value.explorerRevision === 'string' ? value.explorerRevision : undefined,
        explorerStatus: typeof value.explorerStatus === 'string' ? value.explorerStatus : undefined,
    }
}

/** Persistent terminal control survives removing the full mission and failed ISM publication. */
export function getShardMissionControl(data: ShardUnitData): ShardMissionControl | undefined {
    if (data.task.sourceShard !== Game.shard.name)
        return command(readRemoteShardState(data.task.sourceShard)?.reports?.[data.missionId], data.missionId)
    const mission = Memory.shardMissions?.[data.missionId]
    if (mission !== undefined) return {
        state: mission.state,
        scoutRevision: mission.scouting?.revision,
        scoutStatus: mission.scouting?.status,
        explorerRevision: mission.exploration?.revision,
        explorerStatus: mission.exploration?.status,
    }
    const stop = Memory.shardMissionStops?.[data.missionId]
    // The controller owns expiry and publication retries; an unpublished stop must still stop local units.
    if (stop?.state === 'complete' || stop?.state === 'cancelled') return { state: stop.state, updatedAt: stop.updatedAt }
    const retained = command(getLocalShardState().reports?.[data.missionId], data.missionId)
    if (retained !== undefined) return retained
    // An initialized source catalogue is authoritative even after a very late traveller outlives its stop record.
    return isRecord(Memory.shardMissions) ? { state: 'cancelled' } : undefined
}
