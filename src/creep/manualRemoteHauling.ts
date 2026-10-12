import { haulerEnergyPickupReserved, reserveHaulerEnergyPickup } from './haulerPickup'

interface SourcePosition { x: number; y: number; roomName: string }
interface SourceIndex { tick: number; shard: string; sources: Map<string, SourcePosition> }
const indexes = new WeakMap<Room, SourceIndex>()

const distance = (first: SourcePosition, second: SourcePosition): number => first.roomName === second.roomName ?
    Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y)) : Infinity

/** Commissioned Source coordinates survive the loss of the previous remote fleet's vision. */
function assignedSource(creep: Creep, data: RemoteFillerData): SourcePosition | undefined {
    if (Game.flags?.[data.sourceFlag]) return undefined
    const home = Game.rooms[creep.memory.spawnRoom]
    if (!home) return undefined
    const shard = Game.shard?.name || ''
    let index = indexes.get(home)
    if (!index || index.tick !== Game.time || index.shard !== shard) {
        const sources = new Map<string, SourcePosition>()
        for (const [roomName, record] of Object.entries(home.memory.remoteCommissioning?.rooms || {})) {
            if (record.kind !== 'manual') continue
            for (const source of Object.values(record.sources)) {
                if (Number.isInteger(source.x) && Number.isInteger(source.y) && source.x >= 0 && source.x < 50 && source.y >= 0 && source.y < 50)
                    sources.set(source.id, { x: source.x, y: source.y, roomName })
            }
        }
        index = { tick: Game.time, shard, sources }; indexes.set(home, index)
    }
    return index.sources.get(data.sourceFlag)
}

/** Undefined leaves unrelated RF_S/RF_T resource jobs with their original behavior. */
export function collectManualRemoteEnergy(creep: Creep, data: RemoteFillerData): boolean | undefined {
    const source = assignedSource(creep, data)
    if (!source) return undefined
    const sourcePos = new RoomPosition(source.x, source.y, source.roomName)
    if (creep.room.name !== source.roomName) {
        creep.moveTo(sourcePos, { range: 3 })
        return true
    }

    const free = creep.store.getFreeCapacity(RESOURCE_ENERGY)
    let dropped: Resource | undefined, largest = 0, nearest = Infinity
    for (const item of creep.room.droppedResource || []) {
        if (item.resourceType !== RESOURCE_ENERGY || distance(item.pos, source) > 3) continue
        const batch = Math.min(free, item.amount)
        if (!(batch > 0) || batch > item.amount - haulerEnergyPickupReserved(item)) continue
        const range = distance(creep.pos, item.pos)
        if (batch > largest || batch === largest && range < nearest) { dropped = item; largest = batch; nearest = range }
    }
    if (dropped) {
        const result = creep.pickup(dropped)
        if (result === ERR_NOT_IN_RANGE) creep.moveTo(dropped, { range: 1 })
        else if (result === OK) reserveHaulerEnergyPickup(creep, dropped, largest)
        return true
    }

    let container = data.withdrawTarget ? Game.getObjectById<StructureContainer>(data.withdrawTarget) || undefined : undefined
    if (!container || container.structureType !== STRUCTURE_CONTAINER || distance(container.pos, source) > 1 ||
        !(container.store[RESOURCE_ENERGY] > 0)) {
        container = undefined; delete data.withdrawTarget
        largest = 0; nearest = Infinity
        for (const item of creep.room.containers) {
            if (distance(item.pos, source) > 1) continue
            const batch = Math.min(free, item.store[RESOURCE_ENERGY]), range = distance(creep.pos, item.pos)
            if (batch > largest || batch > 0 && batch === largest && range < nearest) {
                container = item; largest = batch; nearest = range
            }
        }
    }
    if (container) {
        data.withdrawTarget = container.id
        if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.moveTo(container, { range: 1 })
        return true
    }
    if (creep.store.getUsedCapacity() > 0) { creep.memory.working = true; return false }
    if (distance(creep.pos, source) > 3) creep.moveTo(sourcePos, { range: 3 })
    return true
}
