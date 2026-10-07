import { runtimePolicy } from 'settings/runtime'
import { roomWorkDue } from 'runtime/roomSchedule'

export type CpuRecoveryWork = keyof typeof runtimePolicy.cpuRecovery.intervals

/** Missing CPU data in simulation keeps the ordinary schedule. */
export function isCpuRecoveryActive(): boolean {
    const policy = runtimePolicy.cpuRecovery
    const bucket = Game.cpu?.bucket
    return policy.enabled && Number.isFinite(bucket) && bucket < policy.minimumBucket &&
        (policy.shards.length === 0 || policy.shards.includes(Game.shard.name))
}

/** Replace, rather than intersect, periodic schedules so work cannot starve on incompatible phases. */
export function cpuRecoveryInterval(work: CpuRecoveryWork, normalInterval = 1): number {
    if (!isCpuRecoveryActive()) return normalInterval
    const interval = runtimePolicy.cpuRecovery.intervals[work]
    return Number.isSafeInteger(interval) && interval > 0 ? Math.max(normalInterval, interval) : normalInterval
}

export function cpuRecoveryWorkDue(roomName: string, work: CpuRecoveryWork): boolean {
    return roomWorkDue(roomName, cpuRecoveryInterval(work))
}

/** Boost compounds and their precursors retain production while a creep is waiting. */
export function hasPendingRoomBoost(room: Room): boolean {
    const needs = room.memory.boostNeed
    for (const resource in needs) if (needs[resource] > 0) return true
    return false
}
