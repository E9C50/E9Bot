import { interShardPolicy } from 'settings/interShard'
import { findPathAvoidRooms } from 'settings/settings'
import { getKnownPortals } from './portalIntel'
import { isPortalRouteKnown, PortalRoutePlanningOptions } from './routePlanner'
import type { PortalRecord } from './portalTypes'
import type { ShardMission } from './missions'
import { isMissionVerified } from './verification'
import { isPortalTravelData, isRecord, PortalHop } from './types'

interface CachedRoute {
    sourceShard: string
    sourceRoom: string
    targetShard: string
    targetRoom: string
    route: PortalHop[]
    cost?: number
    topology: string
    storedAt: number
    usedAt: number
}

export interface PortalRouteCacheMemory {
    version: 1
    shard: string
    entries: Record<string, CachedRoute>
}

function cacheKey(sourceShard: string, sourceRoom: string, targetShard: string, targetRoom: string): string {
    const policy = interShardPolicy.portalRouting
    return JSON.stringify([sourceShard, sourceRoom, targetShard, targetRoom, policy.strategy ?? 'totalCost',
        [...new Set(findPathAvoidRooms)].sort(), policy.maximumHops, policy.maximumNodes, policy.roomCost, policy.portalCost])
}

/** Observation timestamps do not change a route; endpoints and policy changes do. */
export function portalTopologySignature(portals: readonly PortalHop[]): string {
    let hash = 2166136261
    const keys = portals.map(hop => JSON.stringify([hop.shard, hop.roomName, hop.x, hop.y, hop.destinationShard, hop.destinationRoom])).sort()
    for (const key of keys) {
        for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619)
        hash = Math.imul(hash ^ 0, 16777619)
    }
    return `${keys.length}:${hash >>> 0}`
}

function enabled(): boolean {
    const policy = interShardPolicy.portalRouteCache
    return !!policy && Number.isSafeInteger(policy.maximumEntries) && policy.maximumEntries > 0 &&
        Number.isFinite(policy.ttl) && policy.ttl > 0
}

function state(create = false): PortalRouteCacheMemory | undefined {
    const previous = Memory.shardRouteCache
    if (previous?.version === 1 && previous.shard === Game.shard.name && isRecord(previous.entries)) return previous
    if (!create) return undefined
    return Memory.shardRouteCache = { version: 1, shard: Game.shard.name, entries: {} }
}

function prune(memory: PortalRouteCacheMemory, now: number): void {
    for (const [key, entry] of Object.entries(memory.entries)) {
        if (!isRecord(entry) || !Number.isFinite(entry.storedAt) || entry.storedAt > now ||
            now - entry.storedAt >= interShardPolicy.portalRouteCache.ttl) delete memory.entries[key]
    }
    const keys = Object.keys(memory.entries)
    if (keys.length <= interShardPolicy.portalRouteCache.maximumEntries) return
    keys.sort((a, b) => (memory.entries[a].usedAt || memory.entries[a].storedAt) -
        (memory.entries[b].usedAt || memory.entries[b].storedAt))
    while (keys.length > interShardPolicy.portalRouteCache.maximumEntries) delete memory.entries[keys.shift()!]
}

function validRoute(sourceShard: string, sourceRoom: string, targetShard: string, targetRoom: string,
    route: readonly PortalHop[], portals: readonly PortalRecord[]): boolean {
    return typeof sourceShard === 'string' && !!sourceShard && typeof targetShard === 'string' && !!targetShard &&
        sourceShard !== targetShard && coordinates(sourceRoom) !== undefined && coordinates(targetRoom) !== undefined && Array.isArray(route) &&
        route.length > 0 && route.length <= interShardPolicy.portalRouting.maximumHops &&
        isPortalTravelData({ missionId: 'route-cache', originShard: sourceShard, route, hopIndex: 0 }) &&
        route.every(hop => hop.shard !== hop.destinationShard) && route[route.length - 1].destinationShard === targetShard &&
        isPortalRouteKnown(route, portals)
}

/** Store candidate geometry only. Scout identity, task state, proof and leases never enter this directory. */
export function storePortalRoute(sourceShard: string, sourceRoom: string, targetShard: string, targetRoom: string,
    plan: { route: readonly PortalHop[]; cost?: number }, portals: readonly PortalRecord[]): boolean {
    if (!enabled() || !validRoute(sourceShard, sourceRoom, targetShard, targetRoom, plan.route, portals)) return false
    const now = Date.now(), memory = state(true)!
    prune(memory, now)
    memory.entries[cacheKey(sourceShard, sourceRoom, targetShard, targetRoom)] = {
        sourceShard, sourceRoom, targetShard, targetRoom, route: plan.route.map(hop => ({ ...hop })),
        ...(Number.isFinite(plan.cost) && plan.cost! >= 0 ? { cost: plan.cost } : {}),
        topology: portalTopologySignature(portals), storedAt: now, usedAt: now,
    }
    prune(memory, now)
    return true
}

function coordinates(room: string): [number, number] | undefined {
    if (typeof room !== 'string') return undefined
    const parsed = /^([WE])(0|[1-9]\d*)([NS])(0|[1-9]\d*)$/.exec(room)
    if (parsed === null) return undefined
    const x = parsed[1] === 'W' ? -Number(parsed[2]) - 1 : Number(parsed[2])
    const y = parsed[3] === 'N' ? -Number(parsed[4]) - 1 : Number(parsed[4])
    return Number.isSafeInteger(x) && Number.isSafeInteger(y) ? [x, y] : undefined
}

/** Native local walking legs remain live checks within the caller's normal planning allowance. */
export function getCachedPortalRoute(sourceShard: string, sourceRoom: string, targetShard: string, targetRoom: string,
    portals: readonly PortalRecord[], options: PortalRoutePlanningOptions = {}): { route: PortalHop[]; cost: number } | undefined {
    if (!enabled()) return undefined
    const memory = state(), now = Date.now()
    if (!memory) return undefined
    prune(memory, now)
    const key = cacheKey(sourceShard, sourceRoom, targetShard, targetRoom), cached = memory.entries[key]
    if (!cached) return undefined
    if (cached.topology !== portalTopologySignature(portals) ||
        !validRoute(sourceShard, sourceRoom, targetShard, targetRoom, cached.route, portals)) {
        delete memory.entries[key]
        return undefined
    }
    const policy = { ...interShardPolicy.portalRouting, ...options }, cpu = Game.cpu
    const started = cpu?.getUsed?.(), avoided = new Set(findPathAvoidRooms), statuses = new Map<string, boolean>()
    const withinBudget = (): boolean => {
        if (started === undefined) return true
        const used = cpu.getUsed(), limit = cpu.tickLimit ?? cpu.limit
        return Number.isFinite(used) &&
            !(Number.isFinite(policy.maximumPlanningCpu) && used - started >= policy.maximumPlanningCpu!) &&
            !(Number.isFinite(limit) && Number.isFinite(policy.minimumCpuHeadroom) && limit - used < policy.minimumCpuHeadroom!)
    }
    const allowed = (room: string): boolean => {
        if (statuses.has(room)) return statuses.get(room)!
        let result = false
        try { result = !avoided.has(room) && Game.map.getRoomStatus(room)?.status === 'normal' } catch (_) {}
        statuses.set(room, result)
        return result
    }
    let checks = 0, cost = 0, currentShard = sourceShard, currentRoom = sourceRoom
    const walk = (shard: string, first: string, last: string): number | undefined => {
        if (!withinBudget()) return undefined
        if (shard !== Game.shard.name) {
            const a = coordinates(first), b = coordinates(last)
            if (a === undefined || b === undefined) return undefined
            return (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])) * policy.roomCost
        }
        if (!allowed(first) || !allowed(last)) return undefined
        if (first === last) return 0
        if (checks >= policy.maximumLocalRouteChecks || options.onLocalRouteCheck?.() === false) return undefined
        checks++
        try {
            const route = Game.map.findRoute(first, last, { routeCallback: room => allowed(room) ? 1 : Infinity })
            if (Array.isArray(route) && route.length > 0 && route[route.length - 1].room === last &&
                route.every(step => allowed(step.room))) return route.length * policy.roomCost
        } catch (_) {}
        return undefined
    }
    for (const hop of cached.route) {
        const walking = walk(currentShard, currentRoom, hop.roomName)
        if (walking === undefined) return undefined
        cost += walking + policy.portalCost
        currentShard = hop.destinationShard; currentRoom = hop.destinationRoom!
    }
    const finalWalking = walk(currentShard, currentRoom, targetRoom)
    if (finalWalking === undefined || !withinBudget()) return undefined
    cached.usedAt = now
    return { route: cached.route.map(hop => ({ ...hop })), cost: cost + finalWalking }
}

/** Terminal cleanup preserves lightweight candidates without native searches or extending old scout proofs. */
export function cacheMissionRoutes(mission: ShardMission): void {
    if (!enabled()) return
    if (mission.routing?.portalSignature?.startsWith('lowBucket:') &&
        (mission.scouting?.status !== 'verified' || !isMissionVerified(mission))) return
    const task = mission.task
    const peers = [task.sourceShard, task.targetShard]
    for (const hop of [...task.route, ...(task.returnRoute || [])]) peers.push(hop.shard, hop.destinationShard)
    const portals = getKnownPortals(peers)
    storePortalRoute(task.sourceShard, task.sourceRoom, task.targetShard, task.targetRoom,
        { route: task.route, cost: mission.routing?.cost }, portals)
    if (task.returnRoute?.length) storePortalRoute(task.targetShard, task.targetRoom, task.sourceShard, task.sourceRoom,
        { route: task.returnRoute, cost: mission.routing?.returnCost }, portals)
}
