import './utils/BetterMove'
import './utils/RoomResource'

import { mountWork } from "mount"
import { ErrorMapper } from "./utils/ErrorMapper"
import { exportStats } from "./utils/ExportStats"
import { roomController } from './module/RoomController'
import { powerSpawnController } from 'role/pc/PowerCreep'
import { visualController } from "./module/VisualController"
import { obScannerController } from './module/ObserverController'
import { structureWorkController } from "./module/StructureController"
import { creepNumberController, creepWorkController, teamWorkController } from './module/CreepController'

// 挂载原型
mountWork()

const getAverage = (array) => array.reduce((sum, currentValue) => sum + currentValue, 0) / array.length;

export const loop = ErrorMapper.wrapLoop(() => {
    // 房间自动化配置
    roomController()

    // Creep 数量控制
    creepNumberController()

    // Creep 工作控制
    creepWorkController()

    // PowerCreep工作控制
    powerSpawnController()

    // 小队工作控制
    teamWorkController()

    // 建筑工作控制
    structureWorkController()

    // 扫描指定房间
    obScannerController()

    // 可视化信息
    visualController()

    // 导出统计数据
    exportStats()

    // 利用空闲CPU生成Pixel
    if (Game.shard.name != 'shard3' && Game.cpu.bucket >= 10000 && typeof Game.cpu.generatePixel === 'function') Game.cpu.generatePixel()

    // 私服买能量
    privateServerWork()

    if (Game.shard.name == 'shard3') {
        if (global['cpuList'] == undefined) global['cpuList'] = []
        global['cpuList'].push(Game.cpu.getUsed())
        if (global['cpuList'].length > 100) global['cpuList'].shift()
        // console.log(global['cpuList'].length, getAverage(global['cpuList']), Game.cpu.bucket)
    }
})


function privateServerWork() {
    if (Game.shard.name == 'b7b7cfd29cac' && Game.time % 10 == 0) {
        Object.values(Game.rooms).forEach(room => {
            if (!room.my) return
            if (!room.storage || !room.terminal) return
            let needEnergy = 500000 - room.storage.store[RESOURCE_ENERGY] + room.terminal.store[RESOURCE_ENERGY]

            if (needEnergy > 0) {
                const allOrder = Game.market.getAllOrders({ type: ORDER_SELL, resourceType: RESOURCE_ENERGY });
                allOrder.sort((a, b) => a.price - b.price).forEach(order => {
                    if (needEnergy <= 0) return
                    const buyAmount = Math.min(order.amount, 100000)
                    Game.market.deal(order.id, buyAmount, room.name)
                    needEnergy -= buyAmount
                })
            }
        })
    }
}

console.log(`脚本初始化... Tick[${Game.time}] CPU[${Game.cpu.getUsed().toFixed(4)}] Bucket[${Game.cpu.bucket}]`)
