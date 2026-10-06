import { rolePolicy } from 'settings/rolePolicy'

interface RepairIndex {
    targets: Map<string, Structure>
    ordinaryIds: Set<string>
    emergency?: Structure
    ordinary?: Structure
    barrier?: Structure
}
let tick: number | undefined, shard: string | undefined
let indexes = new WeakMap<Room, RepairIndex>()

function repairIndex(room: Room): RepairIndex {
    if (tick !== Game.time || shard !== Game.shard?.name) {
        tick = Game.time; shard = Game.shard?.name; indexes = new WeakMap()
    }
    const previous = indexes.get(room)
    if (previous) return previous
    const index: RepairIndex = { targets: new Map(), ordinaryIds: new Set() }
    const costs = Memory.warMode?.[room.name] ? room.getDefenderCostMatrix() : undefined
    const eligible = (target: Structure): boolean => target.hits < target.hitsMax &&
        (!('my' in target) || (target as OwnedStructure).my !== false) &&
        (costs === undefined || costs.get(target.pos.x, target.pos.y) !== 255)
    for (const target of room.wallsNeedRepair || []) {
        if (!eligible(target)) continue
        index.targets.set(target.id, target)
        if (target.structureType === STRUCTURE_RAMPART && target.hits < rolePolicy.builder.emergencyRampartHits &&
            (!index.emergency || target.hits < index.emergency.hits)) index.emergency = target
        if (!index.barrier || target.hits < index.barrier.hits) index.barrier = target
    }
    for (const target of room.structuresNeedRepair || []) {
        if (!eligible(target)) continue
        index.targets.set(target.id, target)
        index.ordinaryIds.add(target.id)
        if (!index.ordinary || target.hits / target.hitsMax < index.ordinary.hits / index.ordinary.hitsMax) index.ordinary = target
    }
    indexes.set(room, index)
    return index
}

/** Existing Room repair lists retain their configured wall/rampart health goals. */
export function builderHasWork(room: Room): boolean {
    return (room.constructionSites?.length || 0) > 0 || repairIndex(room).targets.size > 0
}

/** Idle workers hold their current tile and energy, while remaining movable by traffic. */
export function idleBuilderIfNoWork(creep: Creep): boolean {
    if (builderHasWork(creep.room)) return false
    creep.memory.dontPullMe = false
    if (!(creep.store[RESOURCE_ENERGY] > 0)) creep.memory.working = false
    const data = creep.memory.data as BuilderData
    delete data.buildTarget
    delete data.repairTarget
    return true
}

/** No upgrade fallback: maintenance is followed by waiting until the next real job. */
export function runBuilderMaintenance(creep: Creep): boolean {
    creep.memory.dontPullMe = false
    const index = repairIndex(creep.room), data = creep.memory.data as BuilderData
    const cached = data.repairTarget ? index.targets.get(data.repairTarget) : undefined
    const ordinary = cached && index.ordinaryIds.has(cached.id) ? cached : index.ordinary
    const critical = index.barrier && index.barrier.hits <= rolePolicy.repairer.cpuMaintenance.criticalHits ? index.barrier : undefined
    const target = index.emergency || ordinary || critical || cached || index.barrier
    if (!target) { delete data.repairTarget; return true }
    data.repairTarget = target.id
    if (!(creep.store[RESOURCE_ENERGY] > 0)) { creep.memory.working = false; return false }
    const policy = rolePolicy.repairer.cpuMaintenance
    if (!index.ordinaryIds.has(target.id) && target !== index.emergency) {
        if (Game.cpu?.bucket < policy.minimumBucket && !Memory.warMode?.[creep.room.name] && !creep.room.enemies?.length &&
            target.hits > policy.criticalHits) {
            const interval = Math.max(1, Math.floor(policy.interval))
            let offset = 0
            for (let i = 0; i < creep.name.length; i++) offset = (offset + creep.name.charCodeAt(i)) % interval
            if (Game.time % interval !== offset) return true
        }
    }
    if (creep.repair(target) === ERR_NOT_IN_RANGE) creep.moveTo(target, { range: 3 })
    return true
}
