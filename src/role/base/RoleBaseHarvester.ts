import { getDistance } from "utils"
import { rolePolicy } from "settings/rolePolicy"
import { developmentPolicy } from 'settings/development'
import { isDevelopingRoom } from 'creep/development'
import { sourceHarvestPosition } from 'creep/developmentLogistics'
import { prepareStationaryMining, runStationaryMining } from 'creep/stationaryMining'
import { retireSourceLinkMiner } from 'creep/sourceLinkMining'
import { sourceLinkWithCenter } from 'room/sourceLinks'

function sourceBuffers(creep: Creep, source: Source): { link?: StructureLink; container?: StructureContainer } {
    return {
        link: creep.store.getCapacity(RESOURCE_ENERGY) === 0 ? undefined : sourceLinkWithCenter(creep.room, source),
        container: creep.room.containers.find(container => source.pos.isNearTo(container)),
    }
}

let carrierTick: number | undefined
let carrierShard: string | undefined
let carriers = new Map<string, boolean>()
function hasLocalCarrier(room: Room): boolean {
    if (carrierTick != Game.time || carrierShard != Game.shard.name) {
        carrierTick = Game.time; carrierShard = Game.shard.name; carriers = new Map()
        for (const name in Game.creeps) {
            const creep = Game.creeps[name]
            if (creep.memory.role !== 'filler' || creep.spawning || creep.ticksToLive === 0 ||
                creep.memory.spawnRoom && creep.memory.spawnRoom !== creep.room.name ||
                creep.getActiveBodyparts(CARRY) <= 0 || creep.getActiveBodyparts(MOVE) <= 0 ||
                creep.memory.boostPlan?.steps.length && !creep.memory.boostPlan.completed && !creep.memory.boostPlan.failed) continue
            carriers.set(creep.room.name, true)
        }
    }
    return carriers.get(room.name) || false
}

interface PendingCarrier {
    tick: number
    shard: string
    configs: RoomMemory['creepConfig']
    name: string
}
const pendingCarriers = new WeakMap<Room, PendingCarrier>()

function isPendingCarrier(room: Room, name: string, config: CreepMemory | undefined): boolean {
    return config?.role === 'filler' && !Game.creeps[name] && (!config.spawnRoom || config.spawnRoom === room.name)
}

/** Reuse one positive catalog witness; additions after a miss and changes to its entry remain live. */
function hasPendingLocalCarrier(room: Room): boolean {
    const configs = room.memory.creepConfig
    if (configs === undefined) return false
    const previous = pendingCarriers.get(room)
    if (previous?.tick === Game.time && previous.shard === Game.shard.name && previous.configs === configs &&
        isPendingCarrier(room, previous.name, configs[previous.name])) return true
    for (const name in configs) {
        if (!isPendingCarrier(room, name, configs[name])) continue
        pendingCarriers.set(room, { tick: Game.time, shard: Game.shard.name, configs, name })
        return true
    }
    // A same-tick publication may add a missing carrier. Negative results are not cached.
    pendingCarriers.delete(room)
    return false
}

function emergencyProductionTarget(creep: Creep): StructureSpawn | StructureExtension | undefined {
    // Complete bodies can cost more than the old 300-energy restart threshold.
    // Without a working carrier, keep supplying native spawn capacity before returning to the mine.
    const capacity = creep.room.energyCapacityAvailable
    const targetEnergy = Number.isFinite(capacity) && capacity > 0 ? capacity : developmentPolicy.logistics.emergencySpawnEnergy
    if (creep.room.energyAvailable >= targetEnergy || hasLocalCarrier(creep.room)) return undefined
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

/** A complete missing carrier must be funded before this mine can resume its fixed workstation. */
function recoveringLocalCarrier(creep: Creep): boolean {
    const room = creep.room
    if (room.controller?.my !== true || creep.memory.spawnRoom && creep.memory.spawnRoom !== room.name) return false
    if (creep.store.getCapacity(RESOURCE_ENERGY) <= 0 || Number.isFinite(room.energyCapacityAvailable) &&
        room.energyCapacityAvailable > 0 && room.energyAvailable >= room.energyCapacityAvailable) return false
    if (room.memory.creepConfig === undefined || hasLocalCarrier(room)) return false
    return hasPendingLocalCarrier(room) && emergencyProductionTarget(creep) !== undefined
}

/** Use the mine's own harvest to build its container without leaving the Source workstation. */
function buildSourceContainer(creep: Creep, source: Source): boolean {
    if (!creep.pos.isNearTo(source) || !(creep.store[RESOURCE_ENERGY] > 0) || sourceLinkWithCenter(creep.room, source) !== undefined) return false
    const site = creep.room.constructionSites.find(site => site.my && site.structureType === STRUCTURE_CONTAINER && source.pos.isNearTo(site))
    if (site === undefined) return false
    // build and harvest share one native WORK intent; refill on the next empty tick.
    creep.memory.working = false
    creep.build(site)
    return true
}

function fullBodyContainerStation(creep: Creep, source: Source, container?: StructureContainer): boolean {
    return creep.memory.development?.fullBody === true && container !== undefined &&
        !creep.room.constructionSites.some(site => site.my && site.structureType === STRUCTURE_CONTAINER && source.pos.isNearTo(site))
}

function prepareDevelopingHarvester(creep: Creep, source: Source): boolean {
    const emergency = emergencyProductionTarget(creep)
    if (emergency != undefined && emergencyLoadReady(creep, source)) return true
    const buffers = sourceBuffers(creep, source), target = buffers.link || buffers.container
    if (emergency === undefined && fullBodyContainerStation(creep, source, buffers.container)) {
        const prepared = prepareStationaryMining(creep, source)
        if (prepared !== undefined) return prepared
    }
    const seat = target == undefined ? undefined : sourceHarvestPosition(creep, source, target)
    if (seat != undefined && !creep.pos.isEqualTo(seat)) { creep.moveTo(seat, { range: 0 }); return false }
    // Native zero-CARRY overflow fills a container only on its exact tile.
    if (creep.store.getCapacity(RESOURCE_ENERGY) === 0 && target !== undefined && seat === undefined) return false
    if (!creep.pos.isNearTo(source)) { creep.moveTo(source, { range: 1 }); return false }
    creep.memory.ready = true
    return true
}

/** Unload the previous tick's harvest while producing the next batch. */
function runDevelopingHarvester(creep: Creep, source: Source): boolean {
    const emergency = emergencyProductionTarget(creep)
    if (emergency != undefined && emergencyLoadReady(creep, source)) {
        if (creep.transfer(emergency, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) creep.moveTo(emergency, { range: 1 })
        return true
    }
    if (emergency === undefined && buildSourceContainer(creep, source)) return true
    const buffers = sourceBuffers(creep, source)
    if (emergency === undefined && fullBodyContainerStation(creep, source, buffers.container) && runStationaryMining(creep, source)) return true
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
        const source = Game.getObjectById<Source>((data as HarvesterData).sourceId)
        if (retireSourceLinkMiner(creep, source || undefined)) return false
        if (source == undefined) { creep.memory.ready = false; return false }
        if (recoveringLocalCarrier(creep)) return prepareDevelopingHarvester(creep, source)
        if (sourceLinkWithCenter(creep.room, source) !== undefined) return prepareStationaryMining(creep, source)!
        if (isDevelopingRoom(creep.room)) return prepareDevelopingHarvester(creep, source)
        if (creep.memory.boostPlan !== undefined) {
            const prepared = prepareStationaryMining(creep, source)
            if (prepared !== undefined) return prepared
        }
        if (creep.memory.ready) return true
        const sourceTarget = source

        // 如果不在目标位置则移动
        if (!creep.pos.isNearTo(sourceTarget)) {
            creep.moveTo(sourceTarget)
            return false
        }
        creep.memory.ready = true
        return true
    },
    source(creep) {
        const source = Game.getObjectById<Source>((data as HarvesterData).sourceId)
        if (retireSourceLinkMiner(creep, source || undefined)) return true
        if (source == undefined) { creep.memory.ready = false; return false }
        if (recoveringLocalCarrier(creep)) return runDevelopingHarvester(creep, source)
        if (sourceLinkWithCenter(creep.room, source) !== undefined) return runStationaryMining(creep, source)
        if (isDevelopingRoom(creep.room)) return runDevelopingHarvester(creep, source)
        if (creep.memory.boostPlan !== undefined) {
            if (runStationaryMining(creep, source)) return true
        }
        // 如果没有空余容量了，就开始工作
        if (creep.store.getFreeCapacity() <= rolePolicy.harvester.workWhenFreeCapacityAtMost) {
            creep.memory.working = true
            return false
        }

        const sourceTarget = source
        if (sourceTarget.energy == 0) {
            return false
        }
        if (creep.harvest(sourceTarget) == ERR_NOT_IN_RANGE) creep.memory.ready = false
        return true
    },
    target(creep) {
        const source = Game.getObjectById<Source>((data as HarvesterData).sourceId)
        if (retireSourceLinkMiner(creep, source || undefined)) return true
        if (source == undefined) { creep.memory.ready = false; return false }
        if (recoveringLocalCarrier(creep)) return runDevelopingHarvester(creep, source)
        if (sourceLinkWithCenter(creep.room, source) !== undefined) return runStationaryMining(creep, source)
        if (isDevelopingRoom(creep.room)) return runDevelopingHarvester(creep, source)
        if (creep.memory.boostPlan !== undefined) {
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
        if (constructionSite == undefined && container == undefined && creep.room.level < rolePolicy.harvester.stopCreatingContainersAtLevel) {
            creep.room.createConstructionSite(creep.pos.x, creep.pos.y, STRUCTURE_CONTAINER)
            creep.room.memory.needUpdateCache = true
        }
        return true
    },
})
