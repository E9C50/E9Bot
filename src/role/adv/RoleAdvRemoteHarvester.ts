import { getClosestTarget, getDistance } from "utils"
import { prepareStationaryMining, runStationaryMining } from 'creep/stationaryMining'
import { retireSourceLinkMiner } from 'creep/sourceLinkMining'
import { sourceLinkWithCenter } from 'room/sourceLinks'
import { retireDisabledRemoteHarvester } from 'creep/remoteHarvesterRetirement'

export default (data: CreepData): ICreepConfig => ({
    isNeed: (room: Room, creepName: string) => {
        return true
    },
    prepare(creep) {
        if (retireDisabledRemoteHarvester(creep, data as RemoteHarvesterData)) return false
        const source = Game.getObjectById<Source>((data as RemoteHarvesterData).sourceId)
        if (retireSourceLinkMiner(creep, source || undefined)) return false
        const creepData: RemoteHarvesterData = data as RemoteHarvesterData

        // 不在目标房间就过去
        if (creep.room.name != creepData.targetRoom) {
            creep.moveTo(new RoomPosition(25, 25, creepData.targetRoom))
            return false
        }

        // 如果不在目标位置则移动
        const sourceTarget = source
        if (sourceTarget == undefined) { creep.memory.ready = false; return false }
        if (creep.memory.boostPlan !== undefined || sourceLinkWithCenter(creep.room, sourceTarget) !== undefined) {
            const prepared = prepareStationaryMining(creep, sourceTarget)
            if (prepared !== undefined) return prepared
        }
        if (!creep.memory.ready) {
            if (!creep.pos.isNearTo(sourceTarget)) {
                creep.moveTo(sourceTarget)
                return false
            } else {
                creep.memory.ready = true
                return true
            }
        } else {
            return true
        }

    },
    source(creep) {
        const sourceTarget = Game.getObjectById<Source>((data as RemoteHarvesterData).sourceId)
        if (retireSourceLinkMiner(creep, sourceTarget || undefined)) return true
        if (sourceTarget == undefined) { creep.memory.ready = false; return false }
        if ((creep.memory.boostPlan !== undefined || sourceLinkWithCenter(creep.room, sourceTarget) !== undefined) && runStationaryMining(creep, sourceTarget)) return true
        // 如果没有空余容量了，就开始工作
        if (creep.store.getFreeCapacity() <= 0) {
            creep.memory.working = true
            return false
        }

        if (creep.harvest(sourceTarget) == ERR_NOT_IN_RANGE) creep.memory.ready = false
        return true
    },
    target(creep) {
        const sourceTarget = Game.getObjectById<Source>((data as RemoteHarvesterData).sourceId)
        if (retireSourceLinkMiner(creep, sourceTarget || undefined)) return true
        if (sourceTarget != undefined && sourceLinkWithCenter(creep.room, sourceTarget) !== undefined) return runStationaryMining(creep, sourceTarget)
        if (creep.memory.boostPlan !== undefined) {
            if (sourceTarget == undefined) { creep.memory.ready = false; return false }
            if (runStationaryMining(creep, sourceTarget)) return true
        }
        // 如果没有能量了，就切换为采集状态
        if (creep.store[RESOURCE_ENERGY] == 0) {
            creep.memory.working = false
            return false
        }

        const creepData: RemoteHarvesterData = data as RemoteHarvesterData

        // 如果有正在修建的建筑，但是现在找不到了，说明修好了，然后更新缓存
        if (creepData.buildTarget != undefined) {
            if (Game.getObjectById(creepData.buildTarget) == undefined) {
                creep.room.memory.needUpdateCache = true
                creepData.buildTarget = undefined
            }
        }

        // 如果有container，如果生命值不够，则维修，要么就存放
        const container = creep.room.containers.filter(item => creep.pos.isNearTo(item))[0]
        if (container != undefined && container.hits < container.hitsMax) {
            creep.repair(container)
            return true
        }
        if (container != undefined && container.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            creep.transfer(container, RESOURCE_ENERGY)
            return true
        }

        // 如果有工地则建造
        const constructionSites = creep.room.constructionSites.filter(item => getDistance(creep.pos, item.pos) <= 3)
        const constructionSite = getClosestTarget(creep.pos, constructionSites)
        if (constructionSite != undefined) {
            creepData.buildTarget = constructionSite.id
            creep.build(constructionSite)
            return true
        }

        // 没有Container也没有工地，那就创建
        if (constructionSite == undefined && container == undefined) {
            creep.room.createConstructionSite(creep.pos.x, creep.pos.y, STRUCTURE_CONTAINER)
            creep.room.memory.needUpdateCache = true
        }
        return true
    },
})
