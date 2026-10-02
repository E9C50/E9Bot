import { interShardPolicy } from 'settings/interShard'
import { findPathAvoidRooms } from 'settings/settings'
import type { PortalRecord } from './portalTypes'
import type { PortalHop } from './types'

interface RoomPoint { shard: string; roomName: string; x: number; y: number }
interface GraphPortal { hop: PortalHop; from: RoomPoint; to: RoomPoint; node: number }
interface Candidate { route: PortalHop[]; cost: number }
interface QueueItem { state: number; cost: number; order: number }

export interface PortalRoutePlanningOptions {
    strategy?: 'nearestHop' | 'totalCost'
    maximumPlanningCpu?: number
    maximumLocalRouteChecks?: number
    minimumCpuHeadroom?: number
    /** 多次规划共用原生查询预算，false 表示等待以后再规划。 */
    onLocalRouteCheck?: () => boolean
}

/** Small stable min-heap; all search data belongs to one planning call. */
class SearchQueue {
    private readonly entries: QueueItem[] = []
    private sequence = 0
    public get length(): number { return this.entries.length }
    private before(a: QueueItem, b: QueueItem): boolean {
        return a.cost < b.cost || (a.cost === b.cost && a.order < b.order)
    }
    public push(state: number, cost: number): void {
        const item = { state, cost, order: this.sequence++ }
        let index = this.entries.length
        this.entries.push(item)
        while (index > 0) {
            const parent = (index - 1) >> 1
            if (!this.before(item, this.entries[parent])) break
            this.entries[index] = this.entries[parent]
            index = parent
        }
        this.entries[index] = item
    }
    public pop(): QueueItem {
        const first = this.entries[0]
        const last = this.entries.pop()!
        if (this.entries.length > 0) {
            let index = 0
            while (index * 2 + 1 < this.entries.length) {
                let child = index * 2 + 1
                if (child + 1 < this.entries.length && this.before(this.entries[child + 1], this.entries[child])) child++
                if (!this.before(this.entries[child], last)) break
                this.entries[index] = this.entries[child]
                index = child
            }
            this.entries[index] = last
        }
        return first
    }
}

function point(shard: unknown, roomName: unknown): RoomPoint | undefined {
    if (typeof shard !== 'string' || !shard || typeof roomName !== 'string') return undefined
    const parsed = /^([WE])(0|[1-9]\d*)([NS])(0|[1-9]\d*)$/.exec(roomName)
    if (parsed === null) return undefined
    const horizontal = Number(parsed[2])
    const vertical = Number(parsed[4])
    const x = parsed[1] === 'W' ? -horizontal - 1 : horizontal
    const y = parsed[3] === 'N' ? -vertical - 1 : vertical
    return Number.isSafeInteger(x) && Number.isSafeInteger(y) ? { shard, roomName, x, y } : undefined
}

function portal(record: PortalRecord, now: number): GraphPortal | undefined {
    if (record === null || typeof record !== 'object' || typeof record.id !== 'string' || !record.id ||
        !Number.isFinite(record.observedAt) || record.observedAt < 0 || record.observedAt > now ||
        now - record.observedAt > interShardPolicy.portalDiscovery.intelMaxAge ||
        (record.expiresAt !== undefined && (!Number.isFinite(record.expiresAt) || record.expiresAt <= now)) ||
        !Number.isInteger(record.x) || !Number.isInteger(record.y) || record.x < 0 || record.x >= 50 || record.y < 0 || record.y >= 50)
        return undefined
    const from = point(record.shard, record.roomName)
    const to = point(record.destinationShard, record.destinationRoom)
    if (from === undefined || to === undefined || from.shard === to.shard) return undefined
    return {
        from, to, node: -1,
        hop: { shard: from.shard, roomName: from.roomName, x: record.x, y: record.y,
            destinationShard: to.shard, destinationRoom: to.roomName }
    }
}

function hopKey(hop: PortalHop): string {
    return JSON.stringify([hop.shard, hop.roomName, hop.x, hop.y, hop.destinationShard, hop.destinationRoom])
}

function reachable(start: string, edges: Map<string, Set<string>>): Set<string> {
    const reached = new Set([start])
    const pending = [start]
    for (let cursor = 0; cursor < pending.length; cursor++) {
        for (const next of edges.get(pending[cursor]) ?? []) {
            if (reached.has(next)) continue
            reached.add(next)
            pending.push(next)
        }
    }
    return reached
}

// Native room-route results are shared only within this shard's current tick.
let cacheTick: number | undefined
let cacheShard: string | undefined
let cacheAvoid = ''
let cacheEntries = 0
let localWalking = new Map<string, Map<string, number>>()

/**
 * Costs estimate ticks: room transitions * roomCost plus each portalCost.
 * Remote walks use a non-wrapping cardinal-grid estimate; remote exits, status,
 * terrain, fatigue and within-room paths cannot be verified from this shard.
 * nearestHop compares each entrance independently; totalCost optimizes the sum.
 */
export function planPortalRoute(
    sourceShard: string, sourceRoom: string, targetShard: string, targetRoom: string,
    portals: readonly PortalRecord[], options: PortalRoutePlanningOptions = {}
): Candidate | undefined {
    const source = point(sourceShard, sourceRoom)
    const target = point(targetShard, targetRoom)
    const policy = { ...interShardPolicy.portalRouting, ...options }
    if (source === undefined || target === undefined || !Array.isArray(portals) ||
        (policy.strategy !== undefined && policy.strategy !== 'nearestHop' && policy.strategy !== 'totalCost') ||
        !Number.isInteger(policy.maximumNodes) || policy.maximumNodes < 1 ||
        !Number.isInteger(policy.maximumHops) || policy.maximumHops < 0 ||
        !Number.isInteger(policy.maximumLocalRouteChecks) || policy.maximumLocalRouteChecks < 0 ||
        !Number.isFinite(policy.portalCost) || policy.portalCost < 0 ||
        !Number.isFinite(policy.roomCost) || policy.roomCost <= 0 ||
        portals.length > policy.maximumNodes * Math.max(1, policy.maximumHops) ||
        typeof Game === 'undefined' || typeof Game.shard?.name !== 'string') return undefined
    const currentShard = Game.shard.name
    const maximumHops = Math.min(policy.maximumHops, policy.maximumNodes)
    const cpu = Game.cpu
    const startCpu = typeof cpu?.getUsed === 'function' ? cpu.getUsed() : undefined
    const withinBudget = (): boolean => {
        if (startCpu === undefined) return true
        const used = cpu.getUsed()
        const limit = cpu.tickLimit ?? cpu.limit
        return Number.isFinite(used) &&
            !(Number.isFinite(policy.maximumPlanningCpu) && used - startCpu >= policy.maximumPlanningCpu) &&
            !(Number.isFinite(limit) && Number.isFinite(policy.minimumCpuHeadroom) && limit - used < policy.minimumCpuHeadroom)
    }
    const avoided = new Set(findPathAvoidRooms)
    const avoidSignature = JSON.stringify(Array.from(avoided).sort())
    if (cacheTick !== Game.time || cacheShard !== currentShard || cacheAvoid !== avoidSignature) {
        cacheTick = Game.time
        cacheShard = currentShard
        cacheAvoid = avoidSignature
        cacheEntries = 0
        localWalking = new Map()
    }
    const statuses = new Map<string, boolean>()
    const allowed = (roomName: string): boolean => {
        const cached = statuses.get(roomName)
        if (cached !== undefined) return cached
        let result = false
        try { result = !avoided.has(roomName) && Game.map.getRoomStatus(roomName)?.status === 'normal' } catch (_) {}
        statuses.set(roomName, result)
        return result
    }
    if ((source.shard === currentShard && !allowed(source.roomName)) ||
        (target.shard === currentShard && !allowed(target.roomName)) || !withinBudget()) return undefined
    const now = Date.now()
    const valid: GraphPortal[] = []
    const outgoing = new Map<string, Set<string>>()
    const incoming = new Map<string, Set<string>>()
    for (let index = 0; index < portals.length; index++) {
        if (index % 64 === 0 && !withinBudget()) return undefined
        const entry = portal(portals[index], now)
        if (entry === undefined ||
            (entry.from.shard === currentShard && !allowed(entry.from.roomName)) ||
            (entry.to.shard === currentShard && !allowed(entry.to.roomName))) continue
        valid.push(entry)
        if (!outgoing.has(entry.from.shard)) outgoing.set(entry.from.shard, new Set())
        if (!incoming.has(entry.to.shard)) incoming.set(entry.to.shard, new Set())
        outgoing.get(entry.from.shard)!.add(entry.to.shard)
        incoming.get(entry.to.shard)!.add(entry.from.shard)
    }
    const fromSource = reachable(source.shard, outgoing)
    const toTarget = reachable(target.shard, incoming)
    if (!fromSource.has(target.shard)) return undefined
    const usable: GraphPortal[] = []
    const seen = new Set<string>()
    for (const entry of valid) {
        if (!fromSource.has(entry.from.shard) || !toTarget.has(entry.to.shard)) continue
        const key = hopKey(entry.hop)
        if (seen.has(key)) continue
        seen.add(key)
        usable.push(entry)
        if (usable.length > policy.maximumNodes) return undefined
    }

    const nodes = [source]
    const byShard = new Map<string, GraphPortal[]>()
    const nodeIds = new Map<string, number>([[JSON.stringify([source.shard, source.roomName]), 0]])
    for (const entry of usable) {
        const key = JSON.stringify([entry.to.shard, entry.to.roomName])
        let node = nodeIds.get(key)
        if (node === undefined) {
            node = nodes.length
            nodes.push(entry.to)
            nodeIds.set(key, node)
        }
        entry.node = node
        if (!byShard.has(entry.from.shard)) byShard.set(entry.from.shard, [])
        byShard.get(entry.from.shard)!.push(entry)
    }
    const estimatedWalk = (from: RoomPoint, to: RoomPoint): number =>
        (Math.abs(from.x - to.x) + Math.abs(from.y - to.y)) * policy.roomCost
    const walkCost = (from: RoomPoint, to: RoomPoint): number => {
        if (from.shard === currentShard) {
            const cached = localWalking.get(from.roomName)?.get(to.roomName)
            if (cached !== undefined) return cached * policy.roomCost
        }
        return estimatedWalk(from, to)
    }
    const rememberWalk = (from: string, to: string, distance: number): void => {
        const capacity = Math.max(1, policy.maximumNodes * Math.max(1, policy.maximumLocalRouteChecks))
        if (cacheEntries >= capacity) { localWalking.clear(); cacheEntries = 0 }
        if (!localWalking.has(from)) localWalking.set(from, new Map())
        const group = localWalking.get(from)!
        if (!group.has(to)) cacheEntries++
        group.set(to, distance)
    }
    let localChecks = 0
    const verifyWalk = (from: RoomPoint, to: RoomPoint): number | undefined => {
        const cached = localWalking.get(from.roomName)?.get(to.roomName)
        if (cached !== undefined) return cached * policy.roomCost
        if (!allowed(from.roomName) || !allowed(to.roomName)) return Infinity
        if (from.roomName === to.roomName) return 0
        if (localChecks >= policy.maximumLocalRouteChecks || !withinBudget() || options.onLocalRouteCheck?.() === false) return undefined
        localChecks++
        let distance = Infinity
        try {
            const route = Game.map.findRoute(from.roomName, to.roomName, {
                routeCallback: (roomName: string) => allowed(roomName) ? 1 : Infinity
            })
            if (Array.isArray(route) && route.length > 0 && route[route.length - 1].room === to.roomName &&
                route.every(step => allowed(step.room))) distance = route.length
        } catch (_) {}
        rememberWalk(from.roomName, to.roomName, distance)
        return distance * policy.roomCost
    }

    if (policy.strategy === 'nearestHop') {
        // Shard connectivity decides the next crossing, not the total remaining walk.
        const route: PortalHop[] = []
        const visited = new Set([source.shard])
        let position = source, cost = 0
        while (position.shard !== target.shard) {
            if (route.length >= maximumHops || !withinBudget()) return undefined
            const shardDistances = new Map<string, number>([[target.shard, 0]])
            const pending = [target.shard]
            for (let cursor = 0; cursor < pending.length; cursor++) {
                if (!withinBudget()) return undefined
                for (const previous of incoming.get(pending[cursor]) ?? []) {
                    if (visited.has(previous) || shardDistances.has(previous)) continue
                    shardDistances.set(previous, shardDistances.get(pending[cursor])! + 1)
                    pending.push(previous)
                }
            }
            const candidates = (byShard.get(position.shard) ?? []).filter(entry => !visited.has(entry.to.shard) &&
                shardDistances.has(entry.to.shard) && route.length + 1 + shardDistances.get(entry.to.shard)! <= maximumHops)
                .map(entry => ({ entry, remainingHops: shardDistances.get(entry.to.shard)!, estimated: estimatedWalk(position, entry.from), key: hopKey(entry.hop) }))
                .sort((a, b) => a.remainingHops - b.remainingHops || a.estimated - b.estimated || a.key.localeCompare(b.key))
            let best: { entry: GraphPortal; distance: number; estimated: number; remainingHops: number; key: string } | undefined
            for (const candidate of candidates) {
                if (best !== undefined && (candidate.remainingHops > best.remainingHops || candidate.estimated >= best.distance)) break
                if (!withinBudget()) return undefined
                const distance = position.shard === currentShard ? verifyWalk(position, candidate.entry.from) : candidate.estimated
                if (distance === undefined || !withinBudget()) return undefined
                if (candidate.entry.to.shard === target.shard && target.shard === currentShard) {
                    const landingWalk = verifyWalk(candidate.entry.to, target)
                    if (landingWalk === undefined || !withinBudget()) return undefined
                    if (!Number.isFinite(landingWalk)) continue
                }
                if (Number.isFinite(distance) && (best === undefined || distance < best.distance ||
                    (distance === best.distance && (candidate.estimated < best.estimated ||
                        (candidate.estimated === best.estimated && candidate.key.localeCompare(best.key) < 0))))) {
                    best = { ...candidate, distance }
                }
            }
            if (best === undefined) return undefined
            route.push({ ...best.entry.hop })
            cost += best.distance + policy.portalCost
            position = best.entry.to
            visited.add(position.shard)
        }
        const finalWalk = position.shard === currentShard ? verifyWalk(position, target) : estimatedWalk(position, target)
        return finalWalk === undefined || !Number.isFinite(finalWalk) || !withinBudget() ? undefined : { route, cost: cost + finalWalk }
    }

    const search = (): Candidate | undefined => {
        const width = nodes.length
        const distances = new Float64Array(width * (maximumHops + 1)).fill(Infinity)
        const parents = new Int32Array(distances.length).fill(-1)
        const traversed: Array<PortalHop | undefined> = new Array(distances.length)
        const queue = new SearchQueue()
        distances[0] = 0
        queue.push(0, 0)
        let goal = -1
        let goalCost = Infinity
        let pops = 0
        while (queue.length > 0) {
            if (++pops % 64 === 0 && !withinBudget()) return undefined
            const item = queue.pop()
            if (item.cost !== distances[item.state]) continue
            if (item.cost >= goalCost) break
            const hops = Math.floor(item.state / width)
            const node = nodes[item.state % width]
            if (node.shard === target.shard) {
                const cost = item.cost + walkCost(node, target)
                if (cost < goalCost) { goalCost = cost; goal = item.state }
            }
            if (hops === maximumHops) continue
            for (const entry of byShard.get(node.shard) ?? []) {
                const cost = item.cost + walkCost(node, entry.from) + policy.portalCost
                if (!Number.isFinite(cost) || cost >= goalCost) continue
                const state = (hops + 1) * width + entry.node
                let dominated = false
                for (let lowerHops = 0; lowerHops <= hops + 1; lowerHops++) {
                    if (distances[lowerHops * width + entry.node] <= cost) { dominated = true; break }
                }
                if (dominated) continue
                distances[state] = cost
                parents[state] = item.state
                traversed[state] = entry.hop
                queue.push(state, cost)
            }
        }
        if (goal < 0) return undefined
        const route: PortalHop[] = []
        for (let state = goal; parents[state] >= 0; state = parents[state]) route.push(traversed[state]!)
        route.reverse()
        return { route, cost: goalCost }
    }

    // Native checks only refine a chosen lower-bound path, never all graph edges.
    for (let attempt = 0; attempt <= policy.maximumLocalRouteChecks; attempt++) {
        if (!withinBudget()) return undefined
        const candidate = search()
        if (candidate === undefined) return undefined
        let position = source
        let changed = false
        for (let hopIndex = 0; hopIndex <= candidate.route.length; hopIndex++) {
            const hop = candidate.route[hopIndex]
            const destination = hop === undefined ? target : point(hop.shard, hop.roomName)!
            if (position.shard === currentShard) {
                const previous = walkCost(position, destination)
                const verified = verifyWalk(position, destination)
                if (verified === undefined || !withinBudget()) return undefined
                if (verified !== previous) { changed = true; break }
            }
            if (hop !== undefined) position = point(hop.destinationShard, hop.destinationRoom)!
        }
        if (!changed) return candidate
    }
    return undefined
}

/** Match exact observed endpoints, not Portal ids or inferred shard numbering. */
export function isPortalRouteKnown(route: readonly PortalHop[], portals: readonly PortalRecord[]): boolean {
    const maximum = interShardPolicy.portalRouting.maximumNodes * Math.max(1, interShardPolicy.portalRouting.maximumHops)
    if (!Array.isArray(route) || !Array.isArray(portals) || route.length > maximum || portals.length > maximum) return false
    const now = Date.now()
    const known = new Set<string>()
    for (const record of portals) {
        const entry = portal(record, now)
        if (entry !== undefined) known.add(hopKey(entry.hop))
    }
    return route.every((hop, index) => hop !== null && typeof hop === 'object' &&
        Number.isInteger(hop.x) && Number.isInteger(hop.y) &&
        point(hop.shard, hop.roomName) !== undefined && point(hop.destinationShard, hop.destinationRoom) !== undefined &&
        (index === 0 || route[index - 1].destinationShard === hop.shard) && known.has(hopKey(hop)))
}
