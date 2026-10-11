import { interShardPolicy } from 'settings/interShard'
import { getFindPathAvoidRooms } from 'settings/settings'
import type { PortalRecord } from './portalTypes'
import type { PortalHop } from './types'
import type { LowBucketPlanningLimits } from './planningBudget'

function coordinates(room: unknown): [number, number] | undefined {
    if (typeof room !== 'string') return undefined
    const match = /^([WE])(0|[1-9]\d*)([NS])(0|[1-9]\d*)$/.exec(room)
    if (!match) return undefined
    const x = Number(match[2]), y = Number(match[4])
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return undefined
    return [match[1] === 'W' ? -x - 1 : x, match[3] === 'N' ? -y - 1 : y]
}

/**
 * Only proposes observed doors in nearest-hop order. A scout must verify the
 * walking legs before workers can use this candidate; no native route search runs.
 */
export function planLowBucketPortalRoute(sourceShard: string, sourceRoom: string, targetShard: string, targetRoom: string,
    portals: readonly PortalRecord[], limits: LowBucketPlanningLimits): { route: PortalHop[]; cost: number } | undefined {
    const policy = interShardPolicy.portalRouting, now = Date.now(), start = Game.cpu.getUsed()
    const within = (): boolean => {
        const used = Game.cpu.getUsed(), limit = Game.cpu.tickLimit ?? Game.cpu.limit
        return Number.isFinite(used) && used - start < limits.maximumPlanningCpu &&
            (!Number.isFinite(limit) || limit - used >= limits.minimumCpuHeadroom)
    }
    const first = coordinates(sourceRoom), goal = coordinates(targetRoom)
    if (!first || !goal || sourceShard === targetShard ||
        getFindPathAvoidRooms(sourceShard).includes(sourceRoom) || getFindPathAvoidRooms(targetShard).includes(targetRoom) || !within() ||
        portals.length > policy.maximumNodes * Math.max(1, policy.maximumHops)) return undefined
    const outgoing = new Map<string, PortalRecord[]>(), incoming = new Map<string, Set<string>>()
    for (let index = 0; index < portals.length; index++) {
        if (!within()) return undefined
        const entry = portals[index]
        if (!entry || typeof entry.shard !== 'string' || typeof entry.destinationShard !== 'string' ||
            entry.shard === entry.destinationShard || !coordinates(entry.roomName) || !coordinates(entry.destinationRoom) ||
            !Number.isInteger(entry.x) || !Number.isInteger(entry.y) || entry.x < 0 || entry.x > 49 || entry.y < 0 || entry.y > 49 ||
            !Number.isFinite(entry.observedAt) || entry.observedAt > now || now - entry.observedAt > interShardPolicy.portalDiscovery.intelMaxAge ||
            (entry.expiresAt !== undefined && entry.expiresAt <= now) ||
            getFindPathAvoidRooms(entry.shard).includes(entry.roomName) ||
            getFindPathAvoidRooms(entry.destinationShard).includes(entry.destinationRoom!)) continue
        if (!outgoing.has(entry.shard)) outgoing.set(entry.shard, [])
        outgoing.get(entry.shard)!.push(entry)
        if (!incoming.has(entry.destinationShard)) incoming.set(entry.destinationShard, new Set())
        incoming.get(entry.destinationShard)!.add(entry.shard)
    }
    const route: PortalHop[] = [], visited = new Set<string>(), roomCost = policy.roomCost
    let current = sourceShard, position = first, cost = 0
    while (current !== targetShard) {
        if (!within() || route.length >= policy.maximumHops) return undefined
        visited.add(current)
        const distances = new Map<string, number>([[targetShard, 0]]), pending = [targetShard]
        for (let cursor = 0; cursor < pending.length; cursor++) {
            if (!within()) return undefined
            for (const previous of incoming.get(pending[cursor]) || []) {
                if (visited.has(previous) || distances.has(previous)) continue
                distances.set(previous, distances.get(pending[cursor])! + 1); pending.push(previous)
            }
        }
        let best: PortalRecord | undefined, bestHops = Infinity, bestDistance = Infinity, bestKey = ''
        for (const entry of outgoing.get(current) || []) {
            if (!within()) return undefined
            const hops = distances.get(entry.destinationShard)
            if (visited.has(entry.destinationShard) || hops === undefined || route.length + 1 + hops > policy.maximumHops) continue
            const entrance = coordinates(entry.roomName)!
            const distance = Math.abs(position[0] - entrance[0]) + Math.abs(position[1] - entrance[1])
            const key = `${entry.roomName}/${entry.x}/${entry.y}/${entry.destinationRoom}`
            if (hops < bestHops || (hops === bestHops && (distance < bestDistance || (distance === bestDistance && key < bestKey)))) {
                best = entry; bestHops = hops; bestDistance = distance; bestKey = key
            }
        }
        if (!best) return undefined
        route.push({ shard: best.shard, roomName: best.roomName, x: best.x, y: best.y,
            destinationShard: best.destinationShard, destinationRoom: best.destinationRoom })
        cost += bestDistance * roomCost + policy.portalCost
        current = best.destinationShard; position = coordinates(best.destinationRoom)!
    }
    return within() ? { route, cost: cost + (Math.abs(position[0] - goal[0]) + Math.abs(position[1] - goal[1])) * roomCost } : undefined
}
