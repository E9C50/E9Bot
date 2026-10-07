import { autoEnableSafeMode, findTowerEnemy, repairStructure } from 'room/defense'
import { processRoomFlags } from 'room/flags'
import { initializeRooms, initializeStructures, updateRoomSign } from 'room/initialization'
import { updateLabBoostConfig, updateLabReactionConfig } from 'room/labs'
import { autoComputeCenterPos, releaseConstructionSite } from 'room/layout'
import { processRoomMarket } from 'room/market'
import { processTerminalResource } from 'room/terminal'
import { roomPolicy } from 'settings/roomPolicy'
import { isCpuProfilingEnabled, profileCpuTask } from 'runtime/profiling'
import { isRoomEvacuating } from 'room/evacuationState'
import { processRoomEvacuation } from 'room/evacuation'

function profileRoomTask(label: string, task: () => unknown): void {
    const policy = roomPolicy.profiling
    if (!policy.enabled || Game.shard.name != policy.shard) {
        task()
        return
    }
    const start = Game.cpu.getUsed()
    task()
    const used = Game.cpu.getUsed() - start
    if (used > policy.minimumCpu) console.log(`${label} CPU 使用量：${used.toFixed(policy.decimalPlaces)}`)
}

function runRoomTask(name: string, label: string, task: (room: Room) => unknown, room: Room, profiling: boolean, legacyProfiling: boolean): void {
    if (profiling) {
        profileCpuTask(name, () => {
            if (legacyProfiling) profileRoomTask(label, () => task(room))
            else task(room)
        })
    } else if (legacyProfiling) profileRoomTask(label, () => task(room))
    else task(room)
}

/** 房间业务编排。职责实现位于 room/，执行顺序沿用原控制器。 */
export const roomController = function (): void {
    const profiling = isCpuProfilingEnabled()
    const legacyProfiling = roomPolicy.profiling.enabled && Game.shard.name == roomPolicy.profiling.shard
    if (profiling) profileCpuTask('room:initialize', initializeRooms)
    else initializeRooms()
    const ownedRooms = Object.values(Game.rooms).filter(room => room.my)
    // 旗帜是全局命令，房间 Memory 已统一初始化；每 tick 消费一次即可。
    if (ownedRooms.length > 0) {
        if (profiling) {
            if (legacyProfiling) profileCpuTask('room:flags', () => profileRoomTask('处理房间内建筑相关旗子', processRoomFlags))
            else profileCpuTask('room:flags', processRoomFlags)
        } else if (legacyProfiling) profileRoomTask('处理房间内建筑相关旗子', processRoomFlags)
        else processRoomFlags()
    }
    for (const room of ownedRooms) {
        runRoomTask('room:safeMode', '自动开启安全模式', autoEnableSafeMode, room, profiling, legacyProfiling)
        if (isRoomEvacuating(room)) {
            // Keep combat protection while all resource-consuming room automation is suspended.
            delete room.memory.roomStructure.towerAllowRepair
            runRoomTask('room:enemy', '更新房间内敌人信息', findTowerEnemy, room, profiling, legacyProfiling)
            runRoomTask('room:evacuation', '撤房资源转运', processRoomEvacuation, room, profiling, legacyProfiling)
            continue
        }
        runRoomTask('room:center', '自动计算RoomCenter', autoComputeCenterPos, room, profiling, legacyProfiling)
        runRoomTask('room:construction', '自动规划', releaseConstructionSite, room, profiling, legacyProfiling)
        runRoomTask('room:terminal', '处理资源平衡', processTerminalResource, room, profiling, legacyProfiling)
        runRoomTask('room:market', '出售资源', processRoomMarket, room, profiling, legacyProfiling)
        runRoomTask('room:labBoost', '更新LabBoost配置', updateLabBoostConfig, room, profiling, legacyProfiling)
        runRoomTask('room:labReaction', '更新Lab反应配置', updateLabReactionConfig, room, profiling, legacyProfiling)
        runRoomTask('room:structures', '初始化建筑相关', initializeStructures, room, profiling, legacyProfiling)
        runRoomTask('room:enemy', '更新房间内敌人信息', findTowerEnemy, room, profiling, legacyProfiling)
        runRoomTask('room:repair', '建筑修理相关', repairStructure, room, profiling, legacyProfiling)
        runRoomTask('room:sign', '更新房间签名', updateRoomSign, room, profiling, legacyProfiling)
        // Posted guards need no matrix while safe; consumers build it on demand when enemies appear.
    }
}
