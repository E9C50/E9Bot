import { interShardPolicy } from 'settings/interShard'
import type { ShardUnitData } from './missions'
import type { PortalHop } from './types'

type Life = NonNullable<ShardUnitData['life']>
type Leg = 'outbound' | 'return'
const policy = interShardPolicy.haulerLifetime

function positive(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
}
function ttl(creep: Creep): number | undefined {
    return positive(creep.ticksToLive) ? creep.ticksToLive : undefined
}
function routeSignature(route: readonly PortalHop[] | undefined): string {
    if (route === undefined) return '-'
    // Invalid overlong routes cannot be estimated; keep signature work bounded too.
    const bounded = route.slice(0, interShardPolicy.portalRouting.maximumHops)
    return JSON.stringify([route.length, bounded.map(hop => [hop.shard, hop.roomName, hop.x, hop.y, hop.destinationShard, hop.destinationRoom])])
}
function revision(data: ShardUnitData): string {
    const task = data.task
    return JSON.stringify([task.sourceShard, task.sourceRoom, task.targetShard, task.targetRoom,
        task.sourceEnergyId, task.targetEnergyId, routeSignature(task.route), routeSignature(task.returnRoute)])
}

/** MOVE power is native fatigue removal; empty CARRY does not add movement weight. */
function stepTicks(creep: Creep): { loaded: number; empty: number; key: string } {
    if (!Array.isArray(creep.body) || creep.body.length === 0)
        return { loaded: policy.unknownLoadedStepTicks, empty: policy.unknownEmptyStepTicks, key: 'unknown' }
    let power = 0, loaded = 0, empty = 0
    for (const part of creep.body.slice(0, 50)) {
        if (part.type === MOVE) {
            if (part.hits > 0) {
                const boost = part.boost && typeof BOOSTS !== 'undefined' ? BOOSTS[MOVE]?.[part.boost] as { fatigue?: number } | undefined : undefined
                power += 2 * (positive(boost?.fatigue) ? boost!.fatigue! : 1)
            }
        } else {
            // Counting damaged non-MOVE parts is conservative if an engine excludes their weight.
            loaded++
            if (part.type !== CARRY) empty++
        }
    }
    const full = power > 0 ? Math.max(1, Math.ceil(loaded * 10 / power)) : Infinity
    const light = power > 0 ? Math.max(1, Math.ceil(empty * 10 / power)) : Infinity
    return { loaded: full, empty: light, key: `${full}/${light}` }
}

function sync(creep: Creep, data: ShardUnitData): Life {
    const next = revision(data), speed = stepTicks(creep).key
    if (!data.life || data.life.revision !== next || data.life.bodySpeed !== speed)
        data.life = { revision: next, bodySpeed: speed }
    return data.life
}
function legFor(phase: ShardUnitData['phase']): Leg | undefined {
    return phase === 'outbound' || phase === 'return' ? phase : undefined
}
function updateLegRoute(data: ShardUnitData, life: Life, leg: Leg): boolean {
    const next = routeSignature(data.route)
    const original = routeSignature(leg === 'outbound' ? data.task.route : data.task.returnRoute)
    const previous = leg === 'outbound' ? life.outboundSignature || original : life.returnSignature || original
    const changed = next !== previous
    if (leg === 'outbound') {
        life.outboundSignature = next
        if (changed) {
            delete life.loadedOutboundTicks; delete life.scoutOutboundTicks
            life.outboundRoute = data.route.slice(0, interShardPolicy.portalRouting.maximumHops + 1).map(hop => ({ ...hop }))
        }
    } else {
        life.returnSignature = next
        if (changed) {
            delete life.returnTicks; delete life.scoutReturnTicks
            life.returnRoute = data.route.slice(0, interShardPolicy.portalRouting.maximumHops + 1).map(hop => ({ ...hop }))
        }
    }
    return changed
}
function record(life: Life, name: 'loadedOutboundTicks' | 'returnTicks' | 'loadTicks' | 'unloadTicks', currentTtl: number | undefined): void {
    if (currentTtl === undefined || life.phaseStartedTtl === undefined || currentTtl > life.phaseStartedTtl) return
    life[name] = Math.max(life[name] || 0, life.phaseStartedTtl - currentTtl)
}

/** Call before work and after phase changes. Same-tick calls and different shard clocks are harmless. */
export function observeHaulerLifetime(creep: Creep, data: ShardUnitData): void {
    const life = sync(creep, data), current = ttl(creep), phase = data.phase || 'load', previous = life.phase
    // Renewal or a replaced native body must never produce a negative/partial elapsed sample.
    if (current !== undefined && life.lastTtl !== undefined && current > life.lastTtl) delete life.phaseStartedTtl
    if (phase !== previous) {
        if (previous === 'load' && phase === 'outbound') {
            record(life, 'loadTicks', current)
            life.sourcePosition = { x: creep.pos.x, y: creep.pos.y }
        } else if (previous === 'outbound' && phase === 'work') record(life, 'loadedOutboundTicks', current)
        else if (previous === 'return' && phase === 'load') record(life, 'returnTicks', current)
        else if (previous === 'work' && !life.workUnloaded && (phase === 'return' || phase === 'done')) record(life, 'unloadTicks', current)
        life.phase = phase
        life.phaseStartedTtl = current
        delete life.workUnloaded
        if (phase === 'load' && Game.shard.name === data.task.sourceShard && creep.pos.roomName === data.task.sourceRoom)
            life.sourcePosition = { x: creep.pos.x, y: creep.pos.y }
        if (phase === 'work') life.targetPosition = { x: creep.pos.x, y: creep.pos.y }
    }
    const leg = legFor(phase)
    if (leg && updateLegRoute(data, life, leg) && phase === previous) delete life.phaseStartedTtl
    if (phase === 'work' && !life.workUnloaded && creep.store?.[RESOURCE_ENERGY] === 0 && data.pendingDelivery === undefined) {
        record(life, 'unloadTicks', current)
        life.workUnloaded = true
        life.targetPosition = { x: creep.pos.x, y: creep.pos.y }
    }
    life.lastTtl = current
}

/** Hints must come from proof of these exact task routes, never from an unverified plan. */
export function seedHaulerLifetime(creep: Creep, data: ShardUnitData, hints: { outboundTicks?: number; returnTicks?: number }): void {
    const life = sync(creep, data)
    if (positive(hints.outboundTicks) && (!life.outboundSignature || life.outboundSignature === routeSignature(data.task.route)))
        life.scoutOutboundTicks = hints.outboundTicks
    if (positive(hints.returnTicks) && (!life.returnSignature || life.returnSignature === routeSignature(data.task.returnRoute)))
        life.scoutReturnTicks = hints.returnTicks
}

export function hasMeasuredHaulerOutbound(data: ShardUnitData): boolean {
    return positive(data.life?.loadedOutboundTicks)
}

function roomCoordinates(room: string): { x: number; y: number } | undefined {
    const match = /^([WE])(\d+)([NS])(\d+)$/.exec(room)
    if (!match) return undefined
    return { x: match[1] === 'W' ? -Number(match[2]) - 1 : Number(match[2]),
        y: match[3] === 'N' ? -Number(match[4]) - 1 : Number(match[4]) }
}
function localSteps(from: string, to: string, start?: { x: number; y: number }, end?: { x: number; y: number }): number {
    if (from === to) return start && end ? Math.max(Math.abs(start.x - end.x), Math.abs(start.y - end.y)) : 49
    const first = roomCoordinates(from), second = roomCoordinates(to)
    if (!first || !second) return Infinity
    // Room Manhattan distance plus an unknown edge/landing approach, with a fixed detour allowance.
    return (Math.abs(first.x - second.x) + Math.abs(first.y - second.y) + 1) * 50
}
function routeTicks(creep: Creep, data: ShardUnitData, leg: Leg): number {
    const task = data.task, life = data.life!, returning = leg === 'return'
    const route = (returning ? life.returnRoute : life.outboundRoute) || (returning ? task.returnRoute : task.route)
    const sourceShard = returning ? task.targetShard : task.sourceShard, targetShard = returning ? task.sourceShard : task.targetShard
    const sourceRoom = returning ? task.targetRoom : task.sourceRoom, targetRoom = returning ? task.sourceRoom : task.targetRoom
    const speed = stepTicks(creep), pace = returning ? speed.empty : speed.loaded
    if (!route || route.length > interShardPolicy.portalRouting.maximumHops || !Number.isFinite(pace)) return Infinity
    let shard = sourceShard, room = sourceRoom, position = returning ? life.targetPosition : life.sourcePosition, steps = 0
    for (const hop of route) {
        if (hop.shard !== shard || !hop.destinationRoom) return Infinity
        steps += localSteps(room, hop.roomName, position, hop) + 1
        shard = hop.destinationShard; room = hop.destinationRoom; position = undefined
    }
    if (shard !== targetShard) return Infinity
    steps += localSteps(room, targetRoom, position)
    return Math.ceil(steps * policy.routeDetourFactor * pace)
}
function legTicks(creep: Creep, data: ShardUnitData, leg: Leg): number {
    const life = data.life!, speed = stepTicks(creep)
    const measured = leg === 'outbound' ? life.loadedOutboundTicks : life.returnTicks
    if (positive(measured)) return measured
    const hint = leg === 'outbound' ? life.scoutOutboundTicks : life.scoutReturnTicks
    if (positive(hint)) return Math.ceil(hint * (leg === 'outbound' ? speed.loaded : speed.empty))
    return routeTicks(creep, data, leg)
}
function remainingLoad(creep: Creep, data: ShardUnitData): number {
    const life = data.life!, estimate = Math.max(1, life.loadTicks === undefined ? policy.loadFallbackTicks : life.loadTicks)
    if (life.phase !== 'load' || life.phaseStartedTtl === undefined || ttl(creep) === undefined) return estimate
    // Loaded cargo is still checked by the caller before it commits departure.
    return Math.max(1, estimate - Math.max(0, life.phaseStartedTtl - ttl(creep)!))
}
function unloadTicks(data: ShardUnitData): number {
    return Math.max(1, data.life!.unloadTicks === undefined ? policy.unloadFallbackTicks : data.life!.unloadTicks)
}

/** At an empty destination: return, reload, another loaded delivery, unloading, and the safety margin. */
export function estimateHaulerNextTrip(creep: Creep, data: ShardUnitData): number {
    sync(creep, data)
    return legTicks(creep, data, 'return') + Math.max(1, data.life!.loadTicks === undefined ? policy.loadFallbackTicks : data.life!.loadTicks) +
        legTicks(creep, data, 'outbound') + unloadTicks(data) + policy.safetyTicks
}

/** Before reloading/departing at home: finish loading and get the next payload fully delivered. */
export function estimateHaulerOutbound(creep: Creep, data: ShardUnitData): number {
    sync(creep, data)
    return remainingLoad(creep, data) + legTicks(creep, data, 'outbound') + unloadTicks(data) + policy.safetyTicks
}
