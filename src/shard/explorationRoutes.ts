import { interShardPolicy } from 'settings/interShard'
import { findPathAvoidRooms } from 'settings/settings'
import type { PortalRecord } from './portalTypes'
import type { PortalHop } from './types'

interface RoomPoint { x: number; y: number }
export interface ExplorationPlanningOptions {
    maximumPlanningCpu?: number
    maximumLocalRouteChecks?: number
    minimumCpuHeadroom?: number
    maximumCandidates?: number
    /** Scout candidates use geometry; actual movement and verification establish reachability. */
    candidateOnly?: boolean
    /** Bounds the search area without anchoring walking distances to the original arrival room. */
    searchOriginRoom?: string
    /** Stop once unqueried rooms cannot improve the nearest result. */
    nearestOnly?: boolean
}
interface Budget {
    within(): boolean
    reserveNative(): boolean
    maximumCandidates: number
}

let lastPlanning: { tick: number; shard: string; deferred: boolean } | undefined
function beginPlanning(): void {
    lastPlanning = typeof Game == 'undefined' ? undefined : { tick: Game.time, shard: Game.shard.name, deferred: false }
}
function deferPlanning(): void { if (lastPlanning != undefined) lastPlanning.deferred = true }
/** Empty results caused by the last call's budget must be retried, not reported as no route. */
export function isExplorationPlanningDeferred(): boolean {
    return typeof Game != 'undefined' && lastPlanning?.tick == Game.time && lastPlanning.shard == Game.shard.name && lastPlanning.deferred
}

function point(value: unknown): RoomPoint | undefined {
    if (typeof value != 'string') return undefined
    const match = /^([WE])(0|[1-9]\d*)([NS])(0|[1-9]\d*)$/.exec(value)
    if (match == null) return undefined
    const x = Number(match[2]), y = Number(match[4])
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return undefined
    return { x: match[1] == 'W' ? -x - 1 : x, y: match[3] == 'N' ? -y - 1 : y }
}

function shard(value: unknown): value is string { return typeof value == 'string' && value.length > 0 }
function roomName(x: number, y: number): string { return `${x < 0 ? 'W' + (-x - 1) : 'E' + x}${y < 0 ? 'N' + (-y - 1) : 'S' + y}` }
function hopKey(value: PortalHop): string { return JSON.stringify([value.shard, value.roomName, value.x, value.y, value.destinationShard, value.destinationRoom]) }
/** An itinerary describes what to search for; it never supplies portal coordinates. */
function records(portals: readonly PortalRecord[]): PortalRecord[] {
    const maximum = interShardPolicy.portalRouting.maximumNodes * Math.max(1, interShardPolicy.portalRouting.maximumHops)
    if (!Array.isArray(portals) || portals.length > maximum) return []
    const now = Date.now(), entrances = new Map<string, PortalRecord>()
    for (const value of portals) {
        if (value == null || typeof value != 'object' || typeof value.id != 'string' || !value.id ||
            !shard(value.shard) || !shard(value.destinationShard) || value.shard == value.destinationShard ||
            point(value.roomName) == undefined || point(value.destinationRoom) == undefined ||
            !Number.isInteger(value.x) || !Number.isInteger(value.y) || value.x < 0 || value.x > 49 || value.y < 0 || value.y > 49 ||
            !Number.isFinite(value.observedAt) || value.observedAt < 0 || value.observedAt > now ||
            now - value.observedAt > interShardPolicy.portalDiscovery.intelMaxAge ||
            (value.expiresAt != undefined && (!Number.isFinite(value.expiresAt) || value.expiresAt <= now))) continue
        const key = JSON.stringify([value.shard, value.roomName, value.x, value.y]), previous = entrances.get(key)
        if (previous == undefined || value.observedAt > previous.observedAt) entrances.set(key, value)
    }
    return Array.from(entrances.values())
}

function itinerary(source: string, target: string, valid: readonly PortalRecord[], excluded: ReadonlySet<string> = new Set()): string[] | undefined {
    if (!shard(source) || !shard(target) || (excluded.has(target) && source != target)) return undefined
    if (source == target) return [source]
    const graph = new Map<string, Set<string>>()
    const add = (first: string, second: string): void => {
        if (!shard(first) || !shard(second) || first == second || (excluded.has(second) && second != source)) return
        if (!graph.has(first)) graph.set(first, new Set())
        graph.get(first)!.add(second)
    }
    for (const value of valid) add(value.shard, value.destinationShard)
    for (const [first, connections] of Object.entries(interShardPolicy.portalExploration.shardConnections)) {
        if (Array.isArray(connections)) for (const second of connections) add(first, second)
    }
    const pending = [source], previous = new Map<string, string | undefined>([[source, undefined]])
    for (let cursor = 0; cursor < pending.length && cursor < interShardPolicy.portalRouting.maximumNodes; cursor++) {
        for (const next of graph.get(pending[cursor]) || []) {
            if (previous.has(next)) continue
            previous.set(next, pending[cursor])
            if (next == target) {
                const result: string[] = []
                for (let current: string | undefined = next; current != undefined; current = previous.get(current)) result.push(current)
                result.reverse()
                return result.length - 1 <= interShardPolicy.portalRouting.maximumHops ? result : undefined
            }
            if (previous.size >= interShardPolicy.portalRouting.maximumNodes) return undefined
            pending.push(next)
        }
    }
    return undefined
}

export function getExplorationItinerary(sourceShard: string, targetShard: string, portals: readonly PortalRecord[]): string[] | undefined {
    return itinerary(sourceShard, targetShard, records(portals))
}

function budget(options: ExplorationPlanningOptions = {}): Budget {
    const policy = interShardPolicy.portalExploration
    const maximumPlanningCpu = Math.min(policy.maximumPlanningCpu, options.maximumPlanningCpu ?? policy.maximumPlanningCpu)
    const maximumLocalRouteChecks = Math.min(policy.maximumLocalRouteChecks, options.maximumLocalRouteChecks ?? policy.maximumLocalRouteChecks)
    const minimumCpuHeadroom = options.minimumCpuHeadroom ?? policy.minimumCpuHeadroom
    const maximumCandidates = Math.min(policy.maximumCandidates, options.maximumCandidates ?? policy.maximumCandidates)
    const cpu = typeof Game == 'undefined' ? undefined : Game.cpu
    const start = typeof cpu?.getUsed == 'function' ? cpu.getUsed() : undefined
    let nativeChecks = 0
    const within = (): boolean => {
        if (!Number.isFinite(maximumPlanningCpu) || maximumPlanningCpu <= 0 ||
            !Number.isInteger(maximumLocalRouteChecks) || maximumLocalRouteChecks < 0 ||
            !Number.isInteger(maximumCandidates) || maximumCandidates < 1 ||
            !Number.isFinite(minimumCpuHeadroom) || minimumCpuHeadroom < 0) { deferPlanning(); return false }
        if (start == undefined) return true
        const current = cpu!.getUsed(), limit = cpu!.tickLimit ?? cpu!.limit
        const available = Number.isFinite(current) && current - start < maximumPlanningCpu &&
            !(Number.isFinite(limit) && limit - current < minimumCpuHeadroom)
        if (!available) deferPlanning()
        return available
    }
    const reserveNative = (): boolean => {
        if (!within() || nativeChecks >= maximumLocalRouteChecks) { deferPlanning(); return false }
        nativeChecks++
        return true
    }
    return { within, reserveNative, maximumCandidates }
}

/** Commit only the nearest local crossing; the scout chooses the following door after landing. */
export function planExplorationEntry(sourceShard: string, sourceRoom: string, targetShard: string, targetRoom: string, portals: readonly PortalRecord[]): PortalHop[] {
    const next = selectExplorationPortal(sourceShard, sourceRoom, targetShard, targetRoom, portals)
    return next == undefined ? [] : [next]
}

/** Prefer a real goal portal, otherwise a real crossing to the next search shard. */
export function selectExplorationPortal(currentShard: string, currentRoom: string, goalShard: string, goalRoom: string,
    portals: readonly PortalRecord[], visitedShards: readonly string[] = [], options: ExplorationPlanningOptions = {}): PortalHop | undefined {
    beginPlanning()
    if (typeof Game == 'undefined' || Game.shard?.name != currentShard || point(currentRoom) == undefined || point(goalRoom) == undefined ||
        !shard(goalShard) || goalShard == currentShard || !Array.isArray(visitedShards)) return undefined
    const planning = budget(options), excluded = new Set(visitedShards.filter(value => value != currentShard))
    if (!planning.within() || excluded.has(goalShard)) return undefined
    let valid = records(portals).filter(value => !excluded.has(value.destinationShard) && (!excluded.has(value.shard) || value.shard == currentShard))
    const local = valid.filter(value => value.shard == currentShard)
    const direct = local.filter(value => value.destinationShard == goalShard)
    if (direct.length > 0) {
        const result = nearestPortal(currentRoom, direct, planning, options.candidateOnly)
        if (result != undefined) return result
        if (isExplorationPlanningDeferred()) return undefined
        valid = valid.filter(value => value.shard != currentShard || value.destinationShard != goalShard)
    }
    if (!planning.within()) return undefined
    const order = itinerary(currentShard, goalShard, valid, excluded), next = order?.[1]
    if (next == undefined || excluded.has(next)) return undefined
    const candidates = valid.filter(value => value.shard == currentShard && value.destinationShard == next)
    return nearestPortal(currentRoom, candidates, planning, options.candidateOnly)
}

let walkingTick: number | undefined
let walkingShard: string | undefined
let walkingAvoid = ''
let walkingCache = new Map<string, number>()

function walkingContext(): (name: string) => boolean {
    const avoid = new Set(findPathAvoidRooms), avoidSignature = JSON.stringify(Array.from(avoid).sort())
    if (walkingTick != Game.time || walkingShard != Game.shard.name || walkingAvoid != avoidSignature) {
        walkingTick = Game.time; walkingShard = Game.shard.name; walkingAvoid = avoidSignature; walkingCache = new Map()
    }
    const statuses = new Map<string, boolean>()
    return (name: string): boolean => {
        const known = statuses.get(name)
        if (known != undefined) return known
        let normal = false
        try { normal = point(name) != undefined && !avoid.has(name) && Game.map.getRoomStatus(name)?.status == 'normal' } catch (_) {}
        statuses.set(name, normal)
        return normal
    }
}

function nearestPortal(currentRoom: string, portals: readonly PortalRecord[], planning: Budget, candidateOnly = false): PortalHop | undefined {
    const current = point(currentRoom)!, avoided = new Set(findPathAvoidRooms)
    const allowed = candidateOnly ? (name: string): boolean => !avoided.has(name) : walkingContext()
    if (!allowed(currentRoom)) return undefined
    const candidates = portals.filter(value => allowed(value.roomName)).map(value => {
        const entrance = point(value.roomName)!
        return { portal: value, estimated: Math.abs(entrance.x - current.x) + Math.abs(entrance.y - current.y), key: hopKey(value) }
    }).sort((first, second) => first.estimated - second.estimated || first.key.localeCompare(second.key))
    let best: { portal: PortalRecord; distance: number; estimated: number; key: string } | undefined
    let attempts = 0
    for (const candidate of candidates) {
        // Landing-room and final-room distances are deliberately absent: scout
        // exploration chooses one actual local entrance and replans after crossing.
        if (best != undefined && candidate.estimated >= best.distance) break
        if (!planning.within() || attempts++ >= planning.maximumCandidates) { deferPlanning(); return undefined }
        if (candidateOnly) {
            const portal = candidate.portal
            return { shard: portal.shard, roomName: portal.roomName, x: portal.x, y: portal.y,
                destinationShard: portal.destinationShard, destinationRoom: portal.destinationRoom }
        }
        const distance = localWalk(currentRoom, candidate.portal.roomName, planning, allowed)
        if (distance == undefined) return undefined
        if (!Number.isFinite(distance)) continue
        if (best == undefined || distance < best.distance || (distance == best.distance &&
            (candidate.estimated < best.estimated || (candidate.estimated == best.estimated && candidate.key.localeCompare(best.key) < 0)))) best = { ...candidate, distance }
    }
    if (best == undefined) return undefined
    const { portal } = best
    return { shard: portal.shard, roomName: portal.roomName, x: portal.x, y: portal.y,
        destinationShard: portal.destinationShard, destinationRoom: portal.destinationRoom }
}

function localWalk(from: string, to: string, planning: Budget, allowed: (name: string) => boolean): number | undefined {
    const key = JSON.stringify([from, to]), cached = walkingCache.get(key)
    if (cached != undefined) return cached
    if (!allowed(from) || !allowed(to)) return Infinity
    if (from == to) return 0
    if (!planning.reserveNative()) return undefined
    let distance = Infinity
    try {
        const route = Game.map.findRoute(from, to, { routeCallback: name => allowed(name) ? 1 : Infinity })
        if (Array.isArray(route) && route.length > 0 && route[route.length - 1].room == to && route.every(step => allowed(step.room))) distance = route.length
    } catch (_) {}
    if (walkingCache.size >= interShardPolicy.portalExploration.maximumCandidates * Math.max(1, interShardPolicy.portalExploration.maximumLocalRouteChecks)) walkingCache.clear()
    walkingCache.set(key, distance)
    return planning.within() ? distance : undefined
}

/** Screeps highway crossings use displayed room numbers divisible by ten. */
function highwayCoordinates(origin: number, radius: number, limit: number): number[] {
    const minimum = origin - radius, maximum = origin + radius, result: number[] = []
    const collect = (first: number, last: number, sign: 1 | -1): void => {
        if (first > last) return
        const count = Math.floor((last - first) / 10) + 1
        const desired = sign == 1 ? origin : -origin - 1
        const closest = Math.max(0, Math.min(count - 1, Math.round((desired - first) / 10)))
        let added = 0
        for (let offset = 0; added < limit && offset < count; offset++) for (const index of offset == 0 ? [closest] : [closest - offset, closest + offset]) {
            if (index < 0 || index >= count || added >= limit) continue
            result.push(sign == 1 ? first + index * 10 : -first - index * 10 - 1); added++
        }
    }
    collect(Math.ceil(Math.max(0, minimum) / 10) * 10, Math.floor(maximum / 10) * 10, 1)
    collect(Math.ceil(Math.max(0, -maximum - 1) / 10) * 10, Math.floor((-minimum - 1) / 10) * 10, -1)
    return result.sort((a, b) => Math.abs(a - origin) - Math.abs(b - origin) || a - b).slice(0, limit)
}

/** Search around the arrival area, but prioritize reachable crossroads from the scout's current room. */
export function getExplorationRooms(currentRoom: string, visitedRooms: readonly string[] = [], excludedRooms: readonly string[] = [], options: ExplorationPlanningOptions = {}): string[] {
    beginPlanning()
    const current = point(currentRoom), origin = point(options.searchOriginRoom ?? currentRoom), policy = interShardPolicy.portalExploration
    if (current == undefined || origin == undefined || typeof Game == 'undefined' || !shard(Game.shard?.name) || !Array.isArray(visitedRooms) || !Array.isArray(excludedRooms) ||
        !Number.isInteger(policy.searchRadius) || policy.searchRadius < 0 || !Number.isInteger(policy.maximumCandidates) || policy.maximumCandidates < 1 ||
        !Number.isSafeInteger(origin.x - policy.searchRadius) || !Number.isSafeInteger(origin.x + policy.searchRadius) ||
        !Number.isSafeInteger(origin.y - policy.searchRadius) || !Number.isSafeInteger(origin.y + policy.searchRadius)) return []
    const planning = budget(options)
    if (!planning.within()) return []
    const avoided = new Set(findPathAvoidRooms)
    const allowed = options.candidateOnly ? (name: string): boolean => !avoided.has(name) : walkingContext()
    if (!allowed(currentRoom)) return []
    const excluded = new Set([...visitedRooms, ...excludedRooms]), candidates: Array<{ name: string; estimated: number }> = []
    const horizontal = highwayCoordinates(origin.x, policy.searchRadius, planning.maximumCandidates)
    const vertical = highwayCoordinates(origin.y, policy.searchRadius, planning.maximumCandidates)
    for (const x of horizontal) for (const y of vertical) {
        if (!planning.within()) return []
        const name = roomName(x, y)
        if (!excluded.has(name) && allowed(name)) candidates.push({ name, estimated: Math.abs(x - current.x) + Math.abs(y - current.y) })
    }
    candidates.sort((a, b) => a.estimated - b.estimated || a.name.localeCompare(b.name))
    if (options.candidateOnly) return planning.within() ? candidates.slice(0, options.nearestOnly ? 1 : planning.maximumCandidates).map(value => value.name) : []
    const result: Array<{ name: string; distance: number; estimated: number }> = []
    let bestDistance = Infinity
    const ordered = (): string[] => result.sort((a, b) => a.distance - b.distance || a.estimated - b.estimated || a.name.localeCompare(b.name)).map(value => value.name)
    for (const candidate of candidates) {
        // Every unchecked route is at least this Manhattan distance. Earlier ties
        // also win by geometry/name, so the nearest result is already proven.
        const nearestProven = candidate.estimated >= bestDistance
        if (options.nearestOnly && nearestProven) break
        if (!planning.within()) return nearestProven ? ordered() : []
        if (result.length >= planning.maximumCandidates) break
        const distance = localWalk(currentRoom, candidate.name, planning, allowed)
        if (distance == undefined) {
            if (!planning.within()) return nearestProven ? ordered() : []
            break
        }
        if (Number.isFinite(distance)) {
            result.push({ name: candidate.name, distance, estimated: candidate.estimated })
            bestDistance = Math.min(bestDistance, distance)
        }
    }
    return ordered()
}
