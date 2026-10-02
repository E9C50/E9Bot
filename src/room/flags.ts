import { roomPolicy } from 'settings/roomPolicy'

function processPositionFlag(
    flagName: string,
    memoryKey: keyof IRoomPositionList
): void {
    const flag = Game.flags[flagName]
    if (flag == undefined) return
    const room = Game.rooms[flag.pos.roomName]
    if (room == undefined) return
    room.memory.roomPosition[memoryKey] = flag.pos
    flag.remove()
}

function processStructureFlag(
    flagName: string,
    structureType: StructureConstant,
    apply: (room: Room, id: string) => void
): void {
    const flag = Game.flags[flagName]
    if (flag == undefined) return
    const room = Game.rooms[flag.pos.roomName]
    if (room == undefined) return
    const structure = flag.pos
        .lookFor(LOOK_STRUCTURES)
        .find((item) => item.structureType == structureType)
    // 无视野或旗帜下没有对应建筑时保留旗帜，待条件满足再消费。
    if (structure == undefined) return
    apply(room, structure.id)
    flag.remove()
}

/** 名称及写入的 Memory 字段与原旗帜协议一致。 */
export function processRoomFlags(): void {
    const flags = roomPolicy.flags
    processPositionFlag(flags.managerPosition, 'managerPos')
    processPositionFlag(flags.centerPosition, 'centerPos')
    processStructureFlag(
        flags.repairTower,
        STRUCTURE_TOWER,
        (room, id) => (room.memory.roomStructure.towerAllowRepair = id)
    )
    processStructureFlag(
        flags.sourceLab1,
        STRUCTURE_LAB,
        (room, id) => (room.memory.roomLabConfig.sourceLab1 = id)
    )
    processStructureFlag(
        flags.sourceLab2,
        STRUCTURE_LAB,
        (room, id) => (room.memory.roomLabConfig.sourceLab2 = id)
    )
}
