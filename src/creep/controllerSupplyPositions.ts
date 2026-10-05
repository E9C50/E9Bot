import { isDevelopingRoom } from './development'
import { controllerEnergyBuffer, controllerUpgradeSeats } from './developmentLogistics'
import { prepareControllerEnergyRelay } from './controllerEnergyRelay'
import { developmentPolicy } from 'settings/development'

type Buffer = StructureLink | StructureContainer
export interface ControllerSupplyPosition { buffer?: Buffer; requireAdjacent: boolean }
interface SupplyPlan { room: Room; buffer?: Buffer; root?: string }
let tick = -1, shard = ''
const plans = new Map<string, SupplyPlan>()
const roots = new Map<string, { buffer: string; name: string; id: string }>()

function range(a: { x: number; y: number }, b: { x: number; y: number }): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
}

/** Seat planning can prefer stored energy without changing the Link controller used by infrastructure. */
export function controllerSupplyPosition(creep: Creep): ControllerSupplyPosition {
    const room = creep.room
    if (!isDevelopingRoom(room)) return { requireAdjacent: false }
    if (tick !== Game.time || shard !== Game.shard.name) {
        if (shard !== Game.shard.name || Game.time < tick) roots.clear()
        tick = Game.time; shard = Game.shard.name; plans.clear()
        if (Game.rooms && tick % developmentPolicy.controller.geometryCacheTicks === 0)
            for (const name of roots.keys()) if (!Game.rooms[name]) roots.delete(name)
    }
    let plan = plans.get(room.name)
    if (plan?.room !== room) {
        let buffer = controllerEnergyBuffer(room)
        if (developmentPolicy.controller.preferStockedContainers) {
            let container: StructureContainer | undefined
            for (const target of room.containers) {
                if (range(target.pos, room.controller!.pos) > 3 || !(target.store[RESOURCE_ENERGY] > 0) ||
                    ('isActive' in target && !target.isActive()) ||
                    !controllerUpgradeSeats(room, target).some(seat => range(seat, target.pos) <= 1)) continue
                if (!container || target.store[RESOURCE_ENERGY] > container.store[RESOURCE_ENERGY] ||
                    target.store[RESOURCE_ENERGY] === container.store[RESOURCE_ENERGY] && target.id < container.id) container = target
            }
            if (container) buffer = container
        }
        plan = { room, buffer }
        const relay = buffer && prepareControllerEnergyRelay(room, buffer)
        if (buffer && buffer.store[RESOURCE_ENERGY] > 0 && relay) {
            let covered = false, candidate: Creep | undefined, nearest = Infinity
            const previous = roots.get(room.name)
            const node = previous?.buffer === buffer.id ? relay.nodes.get(previous.name) : undefined
            const pending = previous?.buffer === buffer.id ? node?.creep || Game.creeps?.[previous.name] : undefined
            const boost = pending?.memory.boostPlan
            if (pending?.id === previous?.id && pending?.room.name === room.name && pending.my !== false &&
                !pending.spawning && pending.memory.role === 'upgrader' && pending.store.getCapacity(RESOURCE_ENERGY) > 0 &&
                (node || pending.getActiveBodyparts(WORK) > 0 && (!boost || !(boost.tier > 0) || boost.completed || boost.failed))) candidate = pending
            for (const node of relay.nodes.values()) {
                const unit = node.creep
                if (unit.store.getCapacity(RESOURCE_ENERGY) <= 0) continue
                const distance = range(unit.pos, buffer.pos)
                if (distance <= 1) { covered = true; break }
                if (pending !== undefined && pending === candidate || unit.memory.role !== 'upgrader') continue
                if (!candidate || distance < nearest || distance === nearest && unit.name < candidate.name) {
                    nearest = distance; candidate = unit
                }
            }
            if (!covered && candidate) {
                plan.root = candidate.name
                roots.set(room.name, { buffer: buffer.id, name: candidate.name, id: candidate.id })
            } else roots.delete(room.name)
        } else roots.delete(room.name)
        plans.set(room.name, plan)
    }
    return { buffer: plan.buffer, requireAdjacent: plan.root === creep.name }
}
