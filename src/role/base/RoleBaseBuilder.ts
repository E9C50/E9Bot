import { getClosestTarget, getDistance } from 'utils'
import RoleBaseRepairer from './RoleBaseRepairer'
import { rolePolicy } from 'settings/rolePolicy'
import { populationPolicy } from 'settings/population'
import { developmentPolicy } from 'settings/development'
import { developmentWorkAllowed, isDevelopingRoom } from 'creep/development'
import { controllerEnergyBuffer } from 'creep/developmentLogistics'

function sourceDuringDevelopment(creep: Creep, data: BuilderData): boolean {
    creep.memory.dontPullMe = false
    if (creep.store.getFreeCapacity() == 0) { creep.memory.working = true; return false }
    const buffer = controllerEnergyBuffer(creep.room)
    const configured = Game.getObjectById<Source | AnyStoreStructure>(data.sourceId)
    const usable = (target: AnyStoreStructure | undefined): target is AnyStoreStructure => target != undefined &&
        target.id != buffer?.id && (!('my' in target) || target.my !== false) && target.store[RESOURCE_ENERGY] > 0
    let stock = configured != undefined && 'store' in configured && usable(configured) ? configured : undefined
    if (stock == undefined) {
        const stores: AnyStoreStructure[] = [...creep.room.containers, ...creep.room.links]
        if (creep.room.storage != undefined) stores.push(creep.room.storage)
        if (creep.room.terminal != undefined) stores.push(creep.room.terminal)
        stock = getClosestTarget(creep.pos, stores.filter(usable))
        if (stock != undefined) data.sourceId = stock.id
    }
    if (stock != undefined) {
        if (creep.withdraw(stock, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) creep.moveTo(stock, { range: 1 })
        return true
    }
    // No source logistics yet: construction still needs a worker able to collect its own energy.
    let source: Source | undefined
    for (const candidate of creep.room.sources) {
        if (candidate.energy <= 0) continue
        if (source == undefined || getDistance(creep.pos, candidate.pos) < getDistance(creep.pos, source.pos)) source = candidate
    }
    if (source != undefined) {
        data.sourceId = source.id
        if (creep.harvest(source) == ERR_NOT_IN_RANGE) creep.moveTo(source, { range: 1 })
        return true
    }
    if (creep.store[RESOURCE_ENERGY] > 0) creep.memory.working = true
    return false
}

function targetsDuringDevelopment(room: Room): ConstructionSite[] {
    const sites = room.constructionSites
    if (room.spawns.length == 0) {
        const firstSpawn = sites.filter(site => site.structureType == STRUCTURE_SPAWN)
        if (firstSpawn.length > 0) return firstSpawn
    }
    const infrastructure = room.energyCapacityAvailable < developmentPolicy.building.infrastructureMinimumCapacity
        ? sites.filter(site => site.structureType == STRUCTURE_EXTENSION)
        : sites.filter(site => site.structureType == STRUCTURE_CONTAINER && (
            getDistance(site.pos, room.controller!.pos) <= 3 || room.sources.some(source => source.pos.isNearTo(site))
        ))
    if (infrastructure.length > 0) return infrastructure
    const essential = sites.filter(site => site.structureType != STRUCTURE_ROAD && site.structureType != STRUCTURE_RAMPART)
    return essential.length > 0 ? essential : sites
}

function targetDuringDevelopment(creep: Creep, data: BuilderData): boolean {
    creep.memory.dontPullMe = false
    if (creep.store[RESOURCE_ENERGY] == 0) { creep.memory.working = false; return false }
    if (data.buildTarget != undefined && Game.getObjectById(data.buildTarget) == undefined) {
        creep.room.memory.needUpdateCache = true; data.buildTarget = undefined
    }
    const target = getClosestTarget(creep.pos, targetsDuringDevelopment(creep.room))
    if (target == undefined) return RoleBaseRepairer(creep.memory.data).target(creep)
    data.buildTarget = target.id
    if (getDistance(creep.pos, target.pos) > 3) creep.moveTo(target, { range: 3, ignoreCreeps: false })
    else {
        creep.memory.dontPullMe = true
        if (developmentWorkAllowed(creep)) creep.build(target)
    }
    return true
}

export default (data: CreepData): ICreepConfig => ({
    isNeed: (room: Room, creepName: string) => {
        return room.constructionSites.length > 0
    },
    prepare(creep) {
        if (isDevelopingRoom(creep.room)) return true
        return creep.goBoost()
        // return true
    },
    source(creep) {
        if (isDevelopingRoom(creep.room)) return sourceDuringDevelopment(creep, data as BuilderData)
        // 如果没有空余容量了，就开始工作
        if (creep.store.getFreeCapacity() == 0) {
            creep.memory.working = true
            return false
        }

        const creepData: BuilderData = data as BuilderData
        const configuredTarget = Game.getObjectById<Source | AnyStoreStructure>(creepData.sourceId)
        let sourceTarget = configuredTarget && 'store' in configuredTarget ? configuredTarget : undefined

        // 如果没有指定目标容器，就随便找一个
        if (sourceTarget == undefined || sourceTarget.store[RESOURCE_ENERGY] == 0) {
            var energySources: AnyStoreStructure[] = [...creep.room.containers, ...creep.room.links]

            // energySources = [...energySources, ...creep.room.spawns, ...creep.room.extensions]
            if (creep.room.storage != undefined) energySources.push(creep.room.storage)
            if (creep.room.terminal != undefined) energySources.push(creep.room.terminal)

            energySources = energySources.filter(item => item != undefined && item.store[RESOURCE_ENERGY] > 0)

            sourceTarget = getClosestTarget(creep.pos, energySources)
            if (sourceTarget != undefined) creepData.sourceId = sourceTarget.id
        }

        if (sourceTarget != undefined) {
            if (getDistance(creep.pos, sourceTarget.pos) <= populationPolicy.bootstrap.sourceHarvestRange) {
                creep.withdraw(sourceTarget, RESOURCE_ENERGY)
            } else {
                creep.moveTo(sourceTarget)
            }
            return true
        }

        // 起建房还没有物流容器；成熟房继续等待原 Storage/Container 物流。
        if (populationPolicy.bootstrap.enabled && creep.room.storage == undefined) {
            const source = creep.room.sources.filter(item => item.energy > 0)
                .sort((first, second) => getDistance(creep.pos, first.pos) - getDistance(creep.pos, second.pos))[0]
            if (source != undefined) {
                creepData.sourceId = source.id
                if (getDistance(creep.pos, source.pos) <= populationPolicy.bootstrap.sourceHarvestRange) {
                    creep.harvest(source)
                } else {
                    creep.moveTo(source)
                }
                return true
            }
            if (creep.store[RESOURCE_ENERGY] > 0) creep.memory.working = true
        }
        creep.say('❓')
        return false
    },
    target(creep) {
        if (isDevelopingRoom(creep.room)) return targetDuringDevelopment(creep, data as BuilderData)
        // 如果没有能量了，就切换为采集状态
        if (creep.store[RESOURCE_ENERGY] == 0) {
            creep.memory.working = false
            return false
        }

        const creepData: BuilderData = data as BuilderData

        // 如果有正在修建的建筑，但是现在找不到了，说明修好了，然后更新缓存
        if (creepData.buildTarget != undefined) {
            if (Game.getObjectById(creepData.buildTarget) == undefined) {
                creep.room.memory.needUpdateCache = true
                creepData.buildTarget = undefined
            }
        }

        // 优先修理附近生命值低于应急阈值的 Rampart
        const repairTargets: Structure[] = creep.room.ramparts.filter(
            rampart => rampart.hits < rolePolicy.builder.emergencyRampartHits
                && getDistance(rampart.pos, creep.pos) < rolePolicy.builder.emergencyRampartRange
        )
        if (repairTargets.length > 0) {
            creep.repair(repairTargets[0])
            return true
        }

        let buildTargets: ConstructionSite[] = creep.room.constructionSites
        if (populationPolicy.bootstrap.prioritizeFirstSpawn && creep.room.spawns.length == 0) {
            const spawnSites = buildTargets.filter(site => site.structureType == STRUCTURE_SPAWN)
            if (spawnSites.length > 0) buildTargets = spawnSites
        }

        // 如果没有建筑工地并且需要升级，就去升级
        // if (buildTargets.length == 0 && creep.room.my && creep.room.level < 8) {
        //     return RoleBaseUpgrader(creep.memory.data).target(creep)
        // }

        // 如果没有建筑工地也不需要升级，就去干修理的活
        if (buildTargets.length == 0) {
            return RoleBaseRepairer(creep.memory.data).target(creep)
        }

        // 寻找最近的工地去修理，并且缓存
        const buildTarget = getClosestTarget(creep.pos, buildTargets)
        creepData.buildTarget = buildTarget.id
        if (creep.memory.working && creep.build(buildTarget) == ERR_NOT_IN_RANGE) {
            creep.moveTo(buildTarget);
        }
        return true
    },
})
