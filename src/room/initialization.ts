import { roomSignTextList } from 'settings/room'
import { roomPolicy } from 'settings/roomPolicy'

function initializeGlobalMemory(): void {
    if (Memory.warMode == undefined) Memory.warMode = {}
    if (Memory.creeps == undefined) Memory.creeps = {}
}

/** 只补齐缺失字段，兼容已有的持久 Memory 与房间缓存。 */
export function initializeRoom(room: Room): void {
    initializeGlobalMemory()
    if (global[room.name] == undefined) global[room.name] = {}
    if (global[room.name].structureIdList == undefined)
        global[room.name].structureIdList = {}

    const memory = room.memory
    if (memory.creepConfig == undefined) memory.creepConfig = {}
    if (memory.creepSpawnQueue == undefined) memory.creepSpawnQueue = []
    if (memory.roomLabConfig == undefined)
        memory.roomLabConfig = { singleLabConfig: {} }
    if (memory.roomLabConfig.singleLabConfig == undefined)
        memory.roomLabConfig.singleLabConfig = {}
    if (memory.terminalSendJob == undefined) memory.terminalSendJob = {}
    if (memory.terminalAmount == undefined) memory.terminalAmount = {}
    if (memory.roomStructure == undefined) memory.roomStructure = {}
    if (memory.restrictedPos == undefined) memory.restrictedPos = {}
    if (memory.roomPosition == undefined) memory.roomPosition = {}
    if (memory.roomFillJob == undefined) memory.roomFillJob = {}
    if (memory.teamConfig == undefined) memory.teamConfig = {}
    if (memory.roomFillJob.labInMineral == undefined)
        memory.roomFillJob.labInMineral = []

    // boost 需求是当前 tick 的派生数据，不应沿用上一 tick。
    memory.boostNeed = {}

    const updateFlag = Game.flags[roomPolicy.flags.updateCache]
    if (updateFlag != undefined && updateFlag.pos.roomName == room.name) {
        memory.needUpdateCache = true
        updateFlag.remove()
    }
    if (memory.needUpdateCache) {
        global.BetterMove.deletePathInRoom(room.name)
        global[room.name].structureIdList = {}
        memory.needUpdateCache = false
        console.log('更新建筑缓存', room.name)
    }
}

/** 在跨房间业务与各类原型 getter 调用之前准备所有可见房间。 */
export function initializeRooms(): void {
    initializeGlobalMemory()
    Object.values(Game.rooms).forEach(initializeRoom)
}

export function initializeStructures(room: Room): void {
    const towers = room.towers
    for (const tower of towers) if (typeof tower.init === 'function') tower.init()
    for (const lab of room.labs) if (typeof lab.init === 'function') lab.init()
    for (const spawn of room.spawns) if (typeof spawn.init === 'function') spawn.init()
    for (const link of room.links) if (typeof link.init === 'function') link.init()
    const powerSpawn = room.powerSpawn, nuker = room.nuker
    if (powerSpawn != undefined && typeof powerSpawn.init === 'function') powerSpawn.init()
    if (nuker != undefined && typeof nuker.init === 'function') nuker.init()

    if (
        room.memory.roomStructure.towerAllowRepair == undefined &&
        towers.length > 0
    ) {
        // 自动默认值直接保存；人工 repairTower 旗帜仍由 flags 模块覆盖。
        // 避免所有房间争用同一个全局旗帜名，并重复执行失败的 createFlag。
        room.memory.roomStructure.towerAllowRepair = towers[0].id
    }
}

export function updateRoomSign(room: Room): void {
    if (room.memory.roomSignText != undefined) return
    const existingSigns = Object.values(Game.rooms).map(
        (item) => item.memory.roomSignText
    )
    const unusedSigns = roomSignTextList.filter(
        (item) => !existingSigns.includes(item)
    )
    const randomIndex = Math.floor(Math.random() * unusedSigns.length)
    room.memory.roomSignText = unusedSigns[randomIndex]
}
