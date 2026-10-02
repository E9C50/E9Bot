import RoleBaseBuilder from "role/base/RoleBaseBuilder"
import RoleBaseUpgrader from "role/base/RoleBaseUpgrader";
import { getDistance } from "utils"
import { rolePolicy } from "settings/rolePolicy"
import { acquireBuilderEnergy, updateBuilderEnergyPhase } from 'role/support/builderEnergy'
import { upgradeBuilderAtStablePosition } from 'role/support/builderWorkPosition'

export default (data: CreepData): ICreepConfig => ({
    isNeed: (room: Room, creepName: string) => {
        return true
    },
    prepare(creep) {
        if ((data as RemoteBuilderData).bootstrap) return !creep.spawning
        // if (Game.shard.name == 'shard3') {
        //     const shardMemory = JSON.parse(InterShardMemory.getLocal())
        //     shardMemory[creep.name] = creep.memory
        //     InterShardMemory.setLocal(JSON.stringify(shardMemory))
        // }
        // if (Game.shard.name == 'shard2') {
        //     const shardMemory = JSON.parse(InterShardMemory.getRemote('shard3') || '{}')
        //     creep.memory = shardMemory[creep.name]
        // }
        return creep.goBoost()
    },
    source(creep) {
        // 满批或部分载荷等待超时后开始工作，避免一直攒零碎能量。
        creep.memory.dontPullMe = false
        updateBuilderEnergyPhase(creep)

        const creepData: RemoteBuilderData = data as RemoteBuilderData
        if (creep.room.my && creep.room.level < rolePolicy.remoteBuilder.stopUpgradingAtLevel &&
            creep.room.constructionSites.length === 0 && creep.room.controller !== undefined &&
            getDistance(creep.pos, creep.room.controller.pos) <= 3) {
            const workGoal = Game.flags[creepData.targetFlag] || Game.getObjectById<Source>(creepData.targetFlag)
            if (workGoal?.pos.roomName === creep.room.name && upgradeBuilderAtStablePosition(creep, creep.room.controller)) return true
        }
        if (creep.memory.working) return false
        const sourceFlag = Game.flags[creepData.sourceFlag]
        const sourceStructure = Game.getObjectById(creepData.sourceFlag) as Source
        const targetPos = sourceFlag || sourceStructure

        if (targetPos == undefined) return true

        if (creep.room.name != targetPos.room?.name) {
            creep.moveTo(targetPos, { visualizePathStyle: {} })
            return false
        }

        if (creep.room.portals.length > 0) {
            creep.moveTo(targetPos)
            return false
        }

        // 如果房间有可搬运的能量，直接去搬
        var resourceTargets: AnyStoreStructure[] = [creep.room.storage, creep.room.terminal].filter(item => item != undefined) as AnyStoreStructure[]
        if (!creep.room.my) {
            resourceTargets = [...creep.room.spawns, ...creep.room.extensions, ...creep.room.towers, ...resourceTargets]
        }
        resourceTargets = resourceTargets.filter(item => item != undefined && item.store[RESOURCE_ENERGY] > 0)

        const sourceList = creep.room.sources.filter(source => getDistance(source.pos, targetPos.pos) < rolePolicy.remoteBuilder.sourceSearchRange)
        const acquiring = acquireBuilderEnergy(creep, { stores: resourceTargets, sources: sourceList })
        if (!acquiring && creep.store[RESOURCE_ENERGY] > 0) creep.memory.working = true
        return acquiring
    },
    target(creep) {
        creep.memory.dontPullMe = false
        const creepData: RemoteBuilderData = data as RemoteBuilderData
        const targetFlag = Game.flags[creepData.targetFlag]
        const targetStructure = Game.getObjectById(creepData.targetFlag) as Source
        const targetPos = targetFlag || targetStructure

        if (targetPos == undefined) return false

        if (creep.room.name != targetPos.room?.name) {
            creep.moveTo(targetPos)
            return false
        }

        if (creep.room.portals.length > 0) {
            creep.moveTo(targetPos)
            return false
        }

        if (creep.room.my && creep.room.level < rolePolicy.remoteBuilder.stopUpgradingAtLevel && creep.room.constructionSites.length == 0) {
            if (creep.room.controller != undefined) return upgradeBuilderAtStablePosition(creep, creep.room.controller)
            return RoleBaseUpgrader(creep.memory.data).target(creep)
        }
        return RoleBaseBuilder(creep.memory.data).target(creep)
    },
})
