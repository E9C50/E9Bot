import { isCombatHostile, isInvulnerable } from 'combat/intelligence'
import { travelPortalRoute } from 'shard/travel'
import { isPortalTravelData } from 'shard/types'

export interface DismantleTarget { id: string; x: number; y: number; type: 'rampart' | 'constructedWall' }
export interface TargetDismantleOrder {
    /** Optional persistent controller identity; old explicit one-unit orders remain supported. */
    missionId?: string
    sourceShard?: string
    generation?: number
    controlState?: 'active' | 'paused' | 'completed' | 'cancelled'
    targetShard: string
    targetRoom: string
    targets: DismantleTarget[]
    controller: { x: number; y: number }
    waitPos?: { x: number; y: number }
    index?: number
    done?: boolean
    lastError?: string
    lastPathCheck?: number
}
declare global { interface CreepMemory { targetDismantle?: TargetDismantleOrder } }

function coordinates(value: { x: number; y: number } | undefined): boolean {
    return !!value && Number.isInteger(value.x) && Number.isInteger(value.y) &&
        value.x >= 0 && value.x < 50 && value.y >= 0 && value.y < 50
}
function valid(order: TargetDismantleOrder): boolean {
    return typeof order.targetShard === 'string' && !!order.targetShard &&
        typeof order.targetRoom === 'string' && /^[WE]\d+[NS]\d+$/.test(order.targetRoom) &&
        Array.isArray(order.targets) && order.targets.length > 0 && order.targets.length <= 8 &&
        order.targets.every(target => target && typeof target.id === 'string' && !!target.id && coordinates(target) &&
            (target.type === STRUCTURE_RAMPART || target.type === STRUCTURE_WALL)) && coordinates(order.controller) &&
        (order.waitPos === undefined || coordinates(order.waitPos)) &&
        (order.index === undefined || Number.isInteger(order.index) && order.index >= 0 && order.index <= order.targets.length)
}
function passable(room: Room, x: number, y: number): boolean {
    if (x < 0 || y < 0 || x > 49 || y > 49 || room.getTerrain().get(x, y) & TERRAIN_MASK_WALL) return false
    if (room.sources?.some(source => source.pos.x === x && source.pos.y === y) ||
        room.mineral?.pos.x === x && room.mineral.pos.y === y || room.controller?.pos.x === x && room.controller.pos.y === y) return false
    return !room.lookForAt(LOOK_STRUCTURES, x, y).some(structure =>
        (OBSTACLE_OBJECT_TYPES as readonly string[]).includes(structure.structureType) ||
        structure.structureType === STRUCTURE_RAMPART && !(structure as StructureRampart).my && !(structure as StructureRampart).isPublic)
}
function controllerReachable(creep: Creep, controller: StructureController): boolean {
    const room = creep.room, matrix = new PathFinder.CostMatrix()
    for (const structure of room.structures || room.find(FIND_STRUCTURES)) {
        if ((OBSTACLE_OBJECT_TYPES as readonly string[]).includes(structure.structureType) ||
            structure.structureType === STRUCTURE_RAMPART && !(structure as StructureRampart).my && !(structure as StructureRampart).isPublic)
            matrix.set(structure.pos.x, structure.pos.y, 255)
    }
    for (const object of [...(room.sources || []), ...(room.mineral ? [room.mineral] : []), controller])
        matrix.set(object.pos.x, object.pos.y, 255)
    return !PathFinder.search(creep.pos, { pos: controller.pos, range: 1 }, {
        maxRooms: 1, maxOps: 2500, plainCost: 2, swampCost: 10,
        roomCallback: name => name === room.name ? matrix : false,
    }).incomplete
}
function park(creep: Creep, order: TargetDismantleOrder): void {
    const room = creep.room
    if (room.name !== order.targetRoom) return
    if (order.waitPos && (!passable(room, order.waitPos.x, order.waitPos.y) ||
        Math.max(Math.abs(order.waitPos.x - order.controller.x), Math.abs(order.waitPos.y - order.controller.y)) <= 2 ||
        room.lookForAt(LOOK_CREEPS, order.waitPos.x, order.waitPos.y).some(unit => unit.name !== creep.name) ||
        room.lookForAt(LOOK_POWER_CREEPS, order.waitPos.x, order.waitPos.y).length > 0)) delete order.waitPos
    if (!order.waitPos) {
        // Leave the opened passage empty for the reserver, without walking through another barrier.
        const queue = [creep.pos], seen = new Set([creep.pos.x * 50 + creep.pos.y])
        for (let index = 0; index < queue.length; index++) {
            const point = queue[index]
            const empty = !room.lookForAt(LOOK_CREEPS, point.x, point.y).some(unit => unit.name !== creep.name) &&
                room.lookForAt(LOOK_POWER_CREEPS, point.x, point.y).length === 0
            if (point.x > 0 && point.x < 49 && point.y > 0 && point.y < 49 && empty &&
                Math.max(Math.abs(point.x - order.controller.x), Math.abs(point.y - order.controller.y)) > 2 &&
                !room.lookForAt(LOOK_STRUCTURES, point.x, point.y).some(structure => structure.structureType === STRUCTURE_ROAD)) {
                order.waitPos = { x: point.x, y: point.y }; break
            }
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
                const x = point.x + dx, y = point.y + dy, key = x * 50 + y
                if (seen.has(key) || Math.max(Math.abs(x - creep.pos.x), Math.abs(y - creep.pos.y)) > 5 || !passable(room, x, y)) continue
                seen.add(key); queue.push(new RoomPosition(x, y, room.name))
            }
        }
    }
    if (order.waitPos && (creep.pos.x !== order.waitPos.x || creep.pos.y !== order.waitPos.y))
        creep.moveTo(new RoomPosition(order.waitPos.x, order.waitPos.y, room.name), { range: 0, ignoreCreeps: false })
}

/** Explicit one-creep order. Returning true also consumes invalid, blocked and completed orders. */
export function runTargetDismantle(creep: Creep): boolean {
    const order = creep.memory.targetDismantle
    if (!order) return false
    creep.memory.dontPullMe = false
    if (!valid(order)) { order.lastError = 'Invalid precise dismantle order'; return true }
    if (order.done) { park(creep, order); return true }
    if (order.controlState && order.controlState !== 'active') { park(creep, order); return true }
    if (creep.memory.boostPlan?.failed) { order.lastError = 'Boost preparation failed'; return true }
    if (creep.memory.boostPlan?.steps.length && !creep.memory.boostPlan.completed) {
        order.lastError = 'Waiting for the exact boost plan'; return true
    }
    if (creep.getActiveBodyparts(WORK) <= 0) { order.lastError = 'No live WORK parts'; return true }
    if (creep.spawning) return true
    const data = creep.memory.data
    if (!isPortalTravelData(data)) { order.lastError = 'Invalid portal travel data'; return true }
    const travel = travelPortalRoute(creep, data)
    if (travel.status !== 'arrived') { order.lastError = travel.message || 'Travelling to the target shard'; return true }
    if (Game.shard.name !== order.targetShard) { order.lastError = 'Portal route ended on another shard'; return true }
    if (creep.room.name !== order.targetRoom) {
        delete order.lastError
        creep.moveTo(new RoomPosition(25, 25, order.targetRoom), { range: 20 }); return true
    }
    const room = creep.room
    if (room.controller?.safeMode && !room.controller.my) { order.lastError = 'Target is in safe mode'; return true }
    let index = order.index || 0
    while (index < order.targets.length) {
        const expected = order.targets[index], target = Game.getObjectById<Structure>(expected.id)
        if (!target || target.hits <= 0) { order.index = ++index; continue }
        if (target.structureType !== expected.type || target.pos.roomName !== order.targetRoom ||
            target.pos.x !== expected.x || target.pos.y !== expected.y || !isCombatHostile(target, room)) {
            order.lastError = 'Explicit barrier type, position or ownership no longer matches'; return true
        }
        if (isInvulnerable(target)) { order.lastError = 'Explicit barrier is invulnerable'; return true }
        const result = creep.dismantle(target)
        if (result === ERR_NOT_IN_RANGE) {
            const move = creep.moveTo(target, { range: 1, maxRooms: 1, ignoreCreeps: false })
            order.lastError = move === ERR_NO_PATH ? 'No path to the explicit barrier; no other barrier will be dismantled' : undefined
        } else order.lastError = result === OK ? undefined : `dismantle rejected (${result})`
        return true
    }
    const controller = room.controller
    if (!controller || controller.pos.x !== order.controller.x || controller.pos.y !== order.controller.y) {
        order.lastError = 'Expected controller is not present'; return true
    }
    if (order.lastPathCheck !== undefined && Game.time - order.lastPathCheck < 25) return true
    order.lastPathCheck = Game.time
    if (!controllerReachable(creep, controller)) {
        order.lastError = 'Explicit barriers are gone, but controller range 1 is still unreachable'; return true
    }
    order.done = true; delete order.lastError
    park(creep, order)
    return true
}
