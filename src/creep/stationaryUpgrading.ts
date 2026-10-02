function range(position: RoomPosition, target: RoomPosition): number {
    return position.roomName === target.roomName ? Math.max(Math.abs(position.x - target.x), Math.abs(position.y - target.y)) : Infinity
}

function freeSeat(room: Room, x: number, y: number, creep: Creep): boolean {
    if (x <= 0 || y <= 0 || x >= 49 || y >= 49 || (room.getTerrain().get(x, y) & TERRAIN_MASK_WALL) !== 0) return false
    if (room.sources.some(source => source.pos.x === x && source.pos.y === y) ||
        (room.mineral?.pos.x === x && room.mineral.pos.y === y) ||
        (room.controller?.pos.x === x && room.controller.pos.y === y)) return false
    if (room.lookForAt(LOOK_STRUCTURES, x, y).some(structure =>
        structure.structureType !== STRUCTURE_ROAD && structure.structureType !== STRUCTURE_CONTAINER &&
        !(structure.structureType === STRUCTURE_RAMPART && ((structure as StructureRampart).my || (structure as StructureRampart).isPublic)))) return false
    return !room.lookForAt(LOOK_CREEPS, x, y).some(other => other.name !== creep.name)
}

/** New small-CARRY bodies need a shared controller/supply seat, including at RCL8. */
export function runStationaryUpgrading(creep: Creep, data: UpgraderData): boolean | undefined {
    if (creep.memory.boostPlan === undefined || !creep.room.controller?.my) return undefined
    const supply = Game.getObjectById<AnyStoreStructure>(data.sourceId)
    const controller = creep.room.controller
    if (!supply || !('store' in supply) || ('my' in supply && supply.my === false) ||
        range(supply.pos, controller.pos) > 4 || ('isActive' in supply && !supply.isActive())) return undefined
    const flag = Game.flags[creep.name]
    if (flag && (range(flag.pos, controller.pos) > 3 || range(flag.pos, supply.pos) > 1)) return undefined
    let seat = range(creep.pos, controller.pos) <= 3 && range(creep.pos, supply.pos) <= 1 ? creep.pos : undefined
    if (flag) seat = flag.pos
    if (!seat) {
        let nearest = Infinity
        for (let x = supply.pos.x - 1; x <= supply.pos.x + 1; x++) for (let y = supply.pos.y - 1; y <= supply.pos.y + 1; y++) {
            const position = new RoomPosition(x, y, creep.room.name)
            if (range(position, controller.pos) > 3 || !freeSeat(creep.room, x, y, creep)) continue
            const distance = range(creep.pos, position)
            if (distance < nearest) { nearest = distance; seat = position }
        }
    }
    if (!seat) return undefined
    creep.memory.working = creep.store[RESOURCE_ENERGY] > 0
    if (!creep.pos.isEqualTo(seat)) creep.moveTo(seat, { range: 0 })
    if (range(creep.pos, controller.pos) <= 3 && creep.store[RESOURCE_ENERGY] > 0) creep.upgradeController(controller)
    if (range(creep.pos, supply.pos) <= 1 && creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && supply.store[RESOURCE_ENERGY] > 0)
        creep.withdraw(supply, RESOURCE_ENERGY)
    return true
}
