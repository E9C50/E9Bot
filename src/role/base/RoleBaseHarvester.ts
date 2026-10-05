import { getDistance } from "utils"
import { rolePolicy } from "settings/rolePolicy"
import { developmentPolicy } from 'settings/development'
import { isDevelopingRoom } from 'creep/development'
import { sourceHarvestPosition } from 'creep/developmentLogistics'
import { prepareStationaryMining, runStationaryMining } from 'creep/stationaryMining'

function sourceBuffers(creep: Creep, source: Source): { link?: StructureLink; container?: StructureContainer } {
    return {
        link: creep.store.getCapacity(RESOURCE_ENERGY) === 0 ? undefined : creep.room.links.find(link => link.my !== false && source.pos.inRangeTo(link, 2) && sourceHarvestPosition(creep, source, link) != undefined),
        container: creep.room.containers.find(container => source.pos.isNearTo(container)),
    }
}

let carrierTick: number | undefined
let carrierShard: string | undefined
let carriers = new Map<string, boolean>()
function hasLocalCarrier(room: Room): boolean {
    if (carrierTick != Game.time || carrierShard != Game.shard.name) { carrierTick = Game.time; carrierShard = Game.shard.name; carriers = new Map() }
    if (!carriers.has(room.name)) carriers.set(room.name, room.find(FIND_MY_CREEPS).some(creep => !creep.spawning && creep.memory.role == 'filler'))
    return carriers.get(room.name)!
}

function emergencyProductionTarget(creep: Creep): StructureSpawn | StructureExtension | undefined {
    if (creep.room.energyAvailable >= developmentPolicy.logistics.emergencySpawnEnergy || hasLocalCarrier(creep.room)) return undefined
    let nearest: StructureSpawn | StructureExtension | undefined
    for (const target of [...creep.room.spawns, ...creep.room.extensions]) {
        if (target.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) continue
        if (nearest == undefined || getDistance(creep.pos, target.pos) < getDistance(creep.pos, nearest.pos)) nearest = target
    }
    return nearest
}

function emergencyLoadReady(creep: Creep, source: Source): boolean {
    return creep.store[RESOURCE_ENERGY] > 0 && (creep.store.getFreeCapacity(RESOURCE_ENERGY) == 0 || source.energy == 0)
}

/** Use the mine's own harvest to build its container without leaving the Source workstation. */
function buildSourceContainer(creep: Creep, source: Source): boolean {
    if (!creep.pos.isNearTo(source) || !(creep.store[RESOURCE_ENERGY] > 0)) return false
    const site = creep.room.constructionSites.find(site => site.my && site.structureType === STRUCTURE_CONTAINER && source.pos.isNearTo(site))
    if (site === undefined) return false
    // build and harvest share one native WORK intent; refill on the next empty tick.
    creep.memory.working = false
    creep.build(site)
    return true
}

function prepareDevelopingHarvester(creep: Creep, data: HarvesterData): boolean {
    const source = Game.getObjectById<Source>(data.sourceId)
    if (source == undefined) return false
    if (emergencyProductionTarget(creep) != undefined && emergencyLoadReady(creep, source)) return true
    const buffers = sourceBuffers(creep, source), target = buffers.link || buffers.container
    const seat = target == undefined ? undefined : sourceHarvestPosition(creep, source, target)
    if (seat != undefined && !creep.pos.isEqualTo(seat)) { creep.moveTo(seat, { range: 0 }); return false }
    // Native zero-CARRY overflow fills a container only on its exact tile.
    if (creep.store.getCapacity(RESOURCE_ENERGY) === 0 && target !== undefined && seat === undefined) return false
    if (!creep.pos.isNearTo(source)) { creep.moveTo(source, { range: 1 }); return false }
    creep.memory.ready = true
    return true
}

/** Unload the previous tick's harvest while producing the next batch. */
function runDevelopingHarvester(creep: Creep, data: HarvesterData): boolean {
    const source = Game.getObjectById<Source>(data.sourceId)
    if (source == undefined) { creep.memory.ready = false; return false }
    const emergency = emergencyProductionTarget(creep)
    if (emergency != undefined && emergencyLoadReady(creep, source)) {
        if (creep.transfer(emergency, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) creep.moveTo(emergency, { range: 1 })
        return true
    }
    if (emergency === undefined && buildSourceContainer(creep, source)) return true
    const buffers = sourceBuffers(creep, source)
    const energy = creep.store[RESOURCE_ENERGY], free = creep.store.getFreeCapacity(RESOURCE_ENERGY)
    // Without a carrier, save a full batch instead of walking to spawn for each harvest.
    const collectingEmergencyLoad = emergency != undefined && creep.store.getCapacity(RESOURCE_ENERGY) > 0
    const adjacentContainer = buffers.container != undefined && creep.pos.isNearTo(buffers.container) ? buffers.container : undefined
    // Container decay must not destroy a live mining station; maintenance uses a WORK tick.
    if (!collectingEmergencyLoad && adjacentContainer != undefined && adjacentContainer.hits <= CONTAINER_DECAY && energy > 0) {
        creep.repair(adjacentContainer)
        return true
    }
    if (energy > 0 && !collectingEmergencyLoad) {
        const deposit = buffers.link != undefined && creep.pos.isNearTo(buffers.link) && buffers.link.store.getFreeCapacity(RESOURCE_ENERGY) > 0 ? buffers.link :
            adjacentContainer != undefined && adjacentContainer.store.getFreeCapacity(RESOURCE_ENERGY) > 0 ? adjacentContainer : undefined
        if (deposit != undefined) creep.transfer(deposit, RESOURCE_ENERGY)
        else if (!developmentPolicy.mining.pauseWhenBufferFull || buffers.link == undefined && buffers.container == undefined) creep.drop(RESOURCE_ENERGY)
    }
    creep.memory.working = false
    const directMining = creep.store.getCapacity(RESOURCE_ENERGY) === 0
    const directBufferFull = directMining && adjacentContainer !== undefined &&
        adjacentContainer.store.getFreeCapacity(RESOURCE_ENERGY) <= 0 && developmentPolicy.mining.pauseWhenBufferFull
    if (directMining && buffers.container !== undefined && !creep.pos.isEqualTo(buffers.container)) { creep.memory.ready = false; return true }
    if (source.energy > 0 && !directBufferFull && (free > 0 || directMining)) {
        if (creep.harvest(source) == ERR_NOT_IN_RANGE) creep.memory.ready = false
    }
    return true
}

export default (data: CreepData): ICreepConfig => ({
    isNeed: (room: Room, creepName: string) => {
        return true
    },
    prepare(creep) {
        if (isDevelopingRoom(creep.room)) return prepareDevelopingHarvester(creep, data as HarvesterData)
        if (creep.memory.boostPlan !== undefined) {
            const source = Game.getObjectById<Source>((data as HarvesterData).sourceId)
            if (source == undefined) { creep.memory.ready = false; return false }
            const prepared = prepareStationaryMining(creep, source)
            if (prepared !== undefined) return prepared
        }
        if (creep.memory.ready) return true
        const creepData: HarvesterData = data as HarvesterData
        const sourceTarget: Source = Game.getObjectById<Source>(creepData.sourceId) as Source
        if (sourceTarget == undefined) return false

        // 如果不在目标位置则移动
        if (!creep.pos.isNearTo(sourceTarget)) {
            creep.moveTo(sourceTarget)
            return false
        }
        creep.memory.ready = true
        return true
    },
    source(creep) {
        if (isDevelopingRoom(creep.room)) return runDevelopingHarvester(creep, data as HarvesterData)
        if (creep.memory.boostPlan !== undefined) {
            const source = Game.getObjectById<Source>((data as HarvesterData).sourceId)
            if (source == undefined) { creep.memory.ready = false; return false }
            if (runStationaryMining(creep, source)) return true
        }
        // 如果没有空余容量了，就开始工作
        if (creep.store.getFreeCapacity() <= rolePolicy.harvester.workWhenFreeCapacityAtMost) {
            creep.memory.working = true
            return false
        }

        const creepData: HarvesterData = data as HarvesterData
        const sourceTarget: Source = Game.getObjectById<Source>(creepData.sourceId) as Source
        if (sourceTarget == undefined) { creep.memory.ready = false; return false }
        if (sourceTarget.energy == 0) {
            return false
        }
        if (creep.harvest(sourceTarget) == ERR_NOT_IN_RANGE) creep.memory.ready = false
        return true
    },
    target(creep) {
        if (isDevelopingRoom(creep.room)) return runDevelopingHarvester(creep, data as HarvesterData)
        if (creep.memory.boostPlan !== undefined) {
            const source = Game.getObjectById<Source>((data as HarvesterData).sourceId)
            if (source == undefined) { creep.memory.ready = false; return false }
            if (runStationaryMining(creep, source)) return true
        }
        // 如果没有能量了，就切换为采集状态
        if (creep.store[RESOURCE_ENERGY] == 0) {
            creep.memory.working = false
            return false
        }

        const creepData: HarvesterData = data as HarvesterData

        let constructionSite: ConstructionSite | undefined
        // A completed site invalidates the room cache. A site under this creep is
        // already the unique closest tile; other cached sites still need nearest selection.
        if (creepData.buildTarget != undefined) {
            const cached = Game.getObjectById<ConstructionSite>(creepData.buildTarget)
            if (cached == undefined) {
                creep.room.memory.needUpdateCache = true
                creepData.buildTarget = undefined
            } else if (cached.my && cached.pos.roomName === creep.room.name && getDistance(creep.pos, cached.pos) === 0) {
                constructionSite = cached
            }
        }

        // 如果有工地则建造
        if (constructionSite == undefined) {
            let minimumDistance = Infinity
            for (const site of creep.room.constructionSites) {
                const distance = getDistance(creep.pos, site.pos)
                if (distance <= 3 && distance < minimumDistance) { constructionSite = site; minimumDistance = distance }
            }
        }
        if (constructionSite != undefined) {
            creepData.buildTarget = constructionSite.id
            creep.build(constructionSite)
            return true
        }

        // 如果有link则存放
        let link: StructureLink | undefined
        for (const candidate of creep.room.links) {
            if (creep.pos.isNearTo(candidate)) { link = candidate; break }
        }
        if (link != undefined && link.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            creep.transfer(link, RESOURCE_ENERGY)
            return true
        }

        // 如果有container，如果生命值不够，则维修，要么就存放
        let container: StructureContainer | undefined
        let minimumEnergy = Infinity
        for (const candidate of creep.room.containers) {
            if (!creep.pos.isNearTo(candidate)) continue
            const energy = candidate.store[RESOURCE_ENERGY]
            if (energy < minimumEnergy) { container = candidate; minimumEnergy = energy }
        }
        if (container != undefined && container.hits < container.hitsMax) {
            creep.repair(container)
            return true
        }
        if (container != undefined && container.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            creep.transfer(container, RESOURCE_ENERGY)
            return true
        }

        // 没有Container也没有工地，那就创建
        if (constructionSite == undefined && container == undefined && link == undefined && creep.room.level < rolePolicy.harvester.stopCreatingContainersAtLevel) {
            creep.room.createConstructionSite(creep.pos.x, creep.pos.y, STRUCTURE_CONTAINER)
            creep.room.memory.needUpdateCache = true
        }
        return true
    },
})
