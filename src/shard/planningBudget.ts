import { interShardPolicy } from 'settings/interShard'

export interface LowBucketPlanningLimits {
    maximumPlanningCpu: number
    maximumLocalRouteChecks: number
    minimumCpuHeadroom: number
    maximumCandidates: number
}

let planningTick = -1
let planningShard = ''
let plansUsed = 0

export function isLowBucketPlanning(section: 'routing' | 'exploration' = 'exploration'): boolean {
    const policy = section === 'routing' ? interShardPolicy.portalRouting : interShardPolicy.portalExploration
    return Game.cpu.bucket < policy.minimumBucket
}

/** A tick's spare CPU, rather than accumulated Bucket, funds essential small scout steps. */
export function lowBucketPlanningReady(): boolean {
    const policy = interShardPolicy.lowBucketPlanning
    if (!policy || !Number.isFinite(policy.maximumPlanningCpu) || policy.maximumPlanningCpu <= 0 ||
        !Number.isFinite(policy.minimumCpuHeadroom) || policy.minimumCpuHeadroom < 0) return false
    const used = Game.cpu.getUsed(), limit = Game.cpu.tickLimit ?? Game.cpu.limit
    return Number.isFinite(used) && (!Number.isFinite(limit) || limit - used >= policy.minimumCpuHeadroom)
}

/** Routing, source initialization and live scouts share the same small per-tick allowance. */
export function reserveLowBucketPlanning(): LowBucketPlanningLimits | undefined {
    const policy = interShardPolicy.lowBucketPlanning
    if (!lowBucketPlanningReady() || !Number.isInteger(policy.maximumPlansPerTick) || policy.maximumPlansPerTick < 1 ||
        !Number.isInteger(policy.maximumLocalRouteChecks) || policy.maximumLocalRouteChecks < 0 ||
        !Number.isInteger(policy.maximumCandidates) || policy.maximumCandidates < 1) return undefined
    if (planningTick !== Game.time || planningShard !== Game.shard.name) {
        planningTick = Game.time; planningShard = Game.shard.name; plansUsed = 0
    }
    if (plansUsed >= policy.maximumPlansPerTick) return undefined
    plansUsed++
    return { maximumPlanningCpu: policy.maximumPlanningCpu, maximumLocalRouteChecks: policy.maximumLocalRouteChecks,
        minimumCpuHeadroom: policy.minimumCpuHeadroom, maximumCandidates: policy.maximumCandidates }
}
