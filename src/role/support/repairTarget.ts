interface RepairCycleData { repairTarget?: string }

/** Keep a paid energy load on the same native target, even after a room repair threshold is reached. */
export function repairCycleTarget(creep: Creep, data: RepairCycleData): Structure | undefined {
    const target = data.repairTarget ? Game.getObjectById<Structure>(data.repairTarget) : null
    if (target != undefined && target.hits < target.hitsMax && target.pos.roomName === creep.room.name &&
        (!('my' in target) || (target as OwnedStructure).my !== false) &&
        (!Memory.warMode?.[creep.room.name] || creep.room.getDefenderCostMatrix().get(target.pos.x, target.pos.y) !== 255)) return target
    data.repairTarget = ''
    return undefined
}

/** Release only at the native empty Store boundary or while refilling, never after a repair intent. */
export function resetRepairCycle(data: RepairCycleData): void {
    data.repairTarget = ''
}
