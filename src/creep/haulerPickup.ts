import { haulerPickupPolicy as policy } from 'settings/haulerPickup'
import type { CachedMovementStep } from 'utils/cachedMovement'

interface DropIndex { room: Room; tiles: Map<string, Resource[]> }
let tick = -1, shard = ''
const rooms = new Map<string, DropIndex>(), committed = new Map<string, number>()
const picked = new Set<string>(), blocked = new Set<string>()

function sync(): void {
    const currentTick = Game.time ?? 0, currentShard = Game.shard?.name || ''
    if (tick === currentTick && shard === currentShard) return
    tick = currentTick; shard = currentShard
    rooms.clear(); committed.clear(); picked.clear(); blocked.clear()
}

function range(a: { x: number; y: number; roomName: string }, b: typeof a): number {
    return a.roomName === b.roomName ? Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) : Infinity
}

function index(room: Room): Map<string, Resource[]> {
    const old = rooms.get(room.name)
    if (old?.room === room) return old.tiles
    const tiles = new Map<string, Resource[]>()
    for (const drop of room.droppedResource || []) {
        if (drop.resourceType !== RESOURCE_ENERGY || !(drop.amount > 0) || drop.pos.roomName !== room.name) continue
        const key = `${drop.pos.x}/${drop.pos.y}`, list = tiles.get(key)
        if (list) list.push(drop)
        else tiles.set(key, [drop])
    }
    rooms.set(room.name, { room, tiles })
    return tiles
}

export function haulerEnergyPickupHandled(creep: Creep): boolean { sync(); return picked.has(creep.name) }
export function haulerEnergyPickupReserved(drop: Resource): number { sync(); return committed.get(drop.id) || 0 }

/** Native pickup has no amount argument: other collectors share its complete native batch reservation. */
export function reserveHaulerEnergyPickup(creep: Creep, drop: Resource, amount: number): void {
    sync()
    if (!(amount > 0)) return
    picked.add(creep.name); committed.set(drop.id, (committed.get(drop.id) || 0) + amount)
}

/** A handoff's recipient capacity and donor cargo remain the beginning-of-tick Store snapshot. */
export function blockHaulerEnergyPickup(creep: Creep): void { sync(); blocked.add(creep.name) }

function sourceGoal(creep: Creep): { x: number; y: number; roomName: string } | undefined {
    const data = creep.memory.data as FillerData & RemoteFillerData & { developmentRemote?: { kind: string; targetRoom: string; source?: { x: number; y: number } } }
    if (!data) return undefined
    const remote = data.developmentRemote
    if (remote?.kind === 'hauler' && remote.source) return { ...remote.source, roomName: remote.targetRoom }
    const id = creep.memory.role === 'filler' ? data.mineId || creep.memory.developmentHauler?.mineId || data.sourceId : data.sourceFlag
    const target = id && (creep.memory.role === 'rFiller' ? Game.flags?.[id] || Game.getObjectById<Source | Structure>(id) : Game.getObjectById<Source | Structure>(id))
    return target ? target.pos : undefined
}

function cachedStep(creep: Creep, sourceOnly: boolean): CachedMovementStep | undefined {
    const movement = global.BetterMove, cache = movement?.creepPathCache?.[creep.name]
    if (!movement?.getNextCachedStep || !cache?.dst) return undefined
    if (sourceOnly) {
        const source = sourceGoal(creep)
        if (!source || range(source, cache.dst) > policy.sourceEndpointRange || range(creep.pos, source) <= policy.sourceEndpointRange) return undefined
    }
    // Never continue an old controller-Link delivery route after the storage policy changes.
    if (!sourceOnly && creep.room.links?.some(link => range(link.pos, cache.dst) === 0)) return undefined
    const next = movement.getNextCachedStep(creep)
    return next && next.roomName === creep.room.name && range(creep.pos, next) === 1 ? next : undefined
}

/** Native movement follows the already cached adjacent step; no new moveTo/PathFinder query is made. */
export function continueCachedHaulerRoute(creep: Creep, sourceOnly = false): void {
    if (typeof creep.move !== 'function' || typeof creep.pos.getDirectionTo !== 'function' || creep.fatigue > 0) return
    const next = cachedStep(creep, sourceOnly)
    if (next) creep.move(creep.pos.getDirectionTo(next.x, next.y))
}

/** Recover only current adjacent energy; incoming handoffs and future transfers never provide capacity or cargo. */
export function pickupAdjacentHaulerEnergy(creep: Creep, sourceRouteOnly = false): boolean {
    sync()
    if (!policy.enabled || !['filler', 'rFiller'].includes(creep.memory.role) || creep.spawning || picked.has(creep.name) || blocked.has(creep.name) ||
        creep.memory.isTeam || creep.memory.combatTaskId || creep.room.enemies?.length) return false
    const boost = creep.memory.boostPlan
    if (boost?.steps.length && !boost.completed && !boost.failed) return false
    const free = creep.store.getFreeCapacity(RESOURCE_ENERGY), energy = creep.store[RESOURCE_ENERGY] || 0
    if (!(free > 0) || creep.store.getUsedCapacity() > energy || sourceRouteOnly && !cachedStep(creep, true)) return false
    const tiles = index(creep.room)
    let selected: Resource | undefined, batch = 0, distance = Infinity
    for (let dx = -policy.pickupRange; dx <= policy.pickupRange; dx++) for (let dy = -policy.pickupRange; dy <= policy.pickupRange; dy++) {
        for (const drop of tiles.get(`${creep.pos.x + dx}/${creep.pos.y + dy}`) || []) {
            const amount = Math.min(free, drop.amount), remaining = drop.amount - haulerEnergyPickupReserved(drop)
            if (!(amount > 0) || amount > remaining) continue
            const away = Math.max(Math.abs(dx), Math.abs(dy))
            if (!selected || amount > batch || amount === batch && (away < distance || away === distance && drop.id < selected.id)) {
                selected = drop; batch = amount; distance = away
            }
        }
    }
    if (!selected || creep.pickup(selected) !== OK) return false
    reserveHaulerEnergyPickup(creep, selected, batch)
    return true
}
