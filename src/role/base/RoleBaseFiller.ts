import { getDistance } from "utils"
import { rolePolicy } from "settings/rolePolicy"
import { developmentPolicy } from 'settings/development'
import { isDevelopingRoom } from 'creep/development'
import { controllerEnergyBuffer } from 'creep/developmentLogistics'
import { loadDevelopmentHauler } from 'creep/developmentHauling'
import { deliverHaulerEnergy, withHaulerTraffic } from 'creep/haulerDelivery'
import { controllerLayoutPolicy } from 'settings/controllerLayout'
import { retireSupersededStorageFiller } from 'creep/storageFillerLifecycle'

/** Controller Links receive energy from other Links, never from a local hauler. */
function controllerDeliveryContainer(room: Room): StructureContainer | undefined {
    const buffer = controllerEnergyBuffer(room)
    if (buffer?.structureType === STRUCTURE_CONTAINER) return buffer as StructureContainer
    const controller = room.controller
    if (controller === undefined) return undefined
    let selected: StructureContainer | undefined
    for (const container of room.containers) {
        const distance = getDistance(container.pos, controller.pos)
        if (distance > controllerLayoutPolicy.containerRange) continue
        const preferred = distance === controllerLayoutPolicy.containerRange
        const selectedDistance = selected === undefined ? Infinity : getDistance(selected.pos, controller.pos)
        if (selected === undefined || preferred && selectedDistance !== controllerLayoutPolicy.containerRange ||
            preferred === (selectedDistance === controllerLayoutPolicy.containerRange) && distance < selectedDistance) selected = container
    }
    return selected
}

function usableEnergySource(target: AnyStoreStructure | Source | null | undefined, excludedId?: string): target is AnyStoreStructure {
    return target != undefined && 'store' in target && target.id !== excludedId && target.store[RESOURCE_ENERGY] > 0
}

function isControllerLink(target: AnyStoreStructure | Source | null | undefined, room: Room): boolean {
    return target != undefined && 'structureType' in target && target.structureType === STRUCTURE_LINK &&
        room.controller != undefined && getDistance(target.pos, room.controller.pos) <= controllerLayoutPolicy.containerRange
}

/** Resolve each job id once and remove stale/full entries without allocating filtered arrays. */
function closestFillJob(creep: Creep, jobs: string[]): AnyStoreStructure | undefined {
    let closest: AnyStoreStructure | undefined
    let minimumDistance = Infinity, write = 0
    for (let read = 0; read < jobs.length; read++) {
        const id = jobs[read]
        const target = Game.getObjectById<AnyStoreStructure>(id)
        if (target == undefined || target.structureType === STRUCTURE_LINK || 'my' in target && target.my === false ||
            target.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) continue
        jobs[write++] = id
        const distance = getDistance(creep.pos, target.pos)
        if (distance < minimumDistance) { closest = target; minimumDistance = distance }
    }
    jobs.length = write
    return closest
}

function closestEnergySource(creep: Creep, excludedId?: string): AnyStoreStructure | undefined {
    let closest: AnyStoreStructure | undefined, minimumDistance = Infinity
    const consider = (target: AnyStoreStructure | undefined): void => {
        if (!usableEnergySource(target, excludedId) || isControllerLink(target, creep.room)) return
        const distance = getDistance(creep.pos, target.pos)
        if (distance < minimumDistance) { closest = target; minimumDistance = distance }
    }
    for (const target of creep.room.containers) consider(target)
    for (const target of creep.room.links) consider(target)
    consider(creep.room.storage)
    consider(creep.room.terminal)
    return closest
}

function developingTransfer(creep: Creep, target: AnyStoreStructure | Creep): boolean {
    if ('structureType' in target && target.structureType === STRUCTURE_LINK) return false
    if (creep.transfer(target, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) creep.moveTo(target, { range: 1 })
    return true
}

function developingFillTarget(creep: Creep, buffer: StructureContainer | undefined): AnyStoreStructure | Creep | undefined {
    const production = closestExtension(creep)
    if (production != undefined) return production
    let tower: StructureTower | undefined
    for (const candidate of creep.room.towers) {
        if (candidate.my === false || candidate.store[RESOURCE_ENERGY] >= developmentPolicy.logistics.minimumTowerEnergy) continue
        if (tower == undefined || getDistance(creep.pos, candidate.pos) < getDistance(creep.pos, tower.pos)) tower = candidate
    }
    if (tower != undefined) return tower
    if (buffer != undefined && buffer.store[RESOURCE_ENERGY] < (buffer.store.getCapacity(RESOURCE_ENERGY) || 0) * developmentPolicy.logistics.controllerRefillRatio) return buffer
    if (buffer == undefined) {
        let upgrader: Creep | undefined
        for (const unit of creep.room.find(FIND_MY_CREEPS)) {
            if (unit.spawning || unit.memory.role != 'upgrader' || unit.store.getFreeCapacity(RESOURCE_ENERGY) <= 0 ||
                getDistance(unit.pos, creep.room.controller!.pos) > 3) continue
            if (upgrader == undefined || getDistance(creep.pos, unit.pos) < getDistance(creep.pos, upgrader.pos)) upgrader = unit
        }
        if (upgrader != undefined) return upgrader
    }
    const jobs = creep.room.memory.roomFillJob || {}
    if (jobs.labInEnergy?.length) {
        const lab = closestFillJob(creep, jobs.labInEnergy)
        if (lab != undefined) return lab
    }
    if (jobs.tower?.length) return closestFillJob(creep, jobs.tower)
    return undefined
}

/** Mine carriers bring energy home; stock carriers distribute it to local consumers. */
function runDevelopingFiller(creep: Creep, data: FillerData): boolean {
    const buffer = controllerDeliveryContainer(creep.room)
    const storage = creep.room.storage
    if (storage != undefined && creep.store.getUsedCapacity() > creep.store[RESOURCE_ENERGY]) {
        for (const resource in creep.store) if (resource != RESOURCE_ENERGY && creep.store[resource] > 0) {
            if (creep.transfer(storage, resource as ResourceConstant) == ERR_NOT_IN_RANGE) creep.moveTo(storage, { range: 1 })
            return true
        }
    }
    const collecting = loadDevelopmentHauler(creep, data, buffer?.id)
    if (creep.memory.working) {
        if (storage !== undefined && (creep.memory.developmentHauler?.mineId || data.mineId)) return deliverHaulerEnergy(creep)
        const target = developingFillTarget(creep, buffer)
        if (target != undefined) return developingTransfer(creep, target)
        if (storage != undefined && storage.id != data.sourceId && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return developingTransfer(creep, storage)
        return false
    }

    return collecting
}

function closestExtension(creep: Creep): StructureExtension | StructureSpawn | undefined {
    let closest: StructureExtension | StructureSpawn | undefined, minimumDistance = Infinity
    const consider = (target: StructureExtension | StructureSpawn): void => {
        if (target.my === false || target.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) return
        const distance = getDistance(creep.pos, target.pos)
        if (distance < minimumDistance) { closest = target; minimumDistance = distance }
    }
    for (const target of creep.room.extensions) consider(target)
    for (const target of creep.room.spawns) consider(target)
    return closest
}

export default (data: CreepData): ICreepConfig => withHaulerTraffic({
    isNeed: (room: Room, creepName: string) => {
        return true
    },
    prepare: function (creep: Creep): boolean {
        return !retireSupersededStorageFiller(creep)
    },
    source(creep) {
        if (isDevelopingRoom(creep.room)) return runDevelopingFiller(creep, data as FillerData)
        // 如果没有空余容量了，就开始工作
        if (creep.store.getFreeCapacity() == 0) {
            creep.memory.working = true
            return false
        }

        const creepData: FillerData = data as FillerData
        const storage = creep.room.storage
        // Mine-bound carriers retain their collection lane. Distribution carriers
        // prefer any usable home stock even when a closer drop/container is larger.
        if (!creepData.mineId && usableEnergySource(storage)) {
            creepData.sourceId = storage.id
            creep.takeFromTarget(storage, RESOURCE_ENERGY)
            return true
        }

        // 检查有没有掉落的资源需要捡
        if (creep.pickupDroppedResource(true, rolePolicy.filler.droppedResourceSearchRange)) return true

        const buffer = controllerDeliveryContainer(creep.room)
        let sourceTarget = creepData.sourceId ? Game.getObjectById<AnyStoreStructure | Source>(creepData.sourceId) : null
        if (!usableEnergySource(sourceTarget, buffer?.id) || isControllerLink(sourceTarget, creep.room)) sourceTarget = null

        // 如果没有指定目标容器，就随便找一个
        if (sourceTarget == undefined) {
            sourceTarget = closestEnergySource(creep, buffer?.id) || null
            if (sourceTarget == undefined) {
                creep.say('❓')
                return false
            }
            creepData.sourceId = sourceTarget.id
        }

        // 有可用目标就去拿
        if (usableEnergySource(sourceTarget, buffer?.id)) {
            creep.takeFromTarget(sourceTarget, RESOURCE_ENERGY)
            return true
        }

        creep.say('💤')
        return true
    },
    target(creep) {
        if (isDevelopingRoom(creep.room)) return runDevelopingFiller(creep, data as FillerData)
        const creepData: FillerData = data as FillerData
        const fillJobs = creep.room.memory.roomFillJob || (creep.room.memory.roomFillJob = {})
        const storage = creep.room.storage

        if (storage != undefined && creep.store.getUsedCapacity() > creep.store[RESOURCE_ENERGY]) {
            for (const resource in creep.store) {
                if (resource !== RESOURCE_ENERGY && creep.store[resource] > 0) {
                    creep.transferToTarget(storage, resource as ResourceConstant)
                    return true
                }
            }
        }

        // 如果没有能量了，就切换为采集状态
        if (creep.store[RESOURCE_ENERGY] == 0) {
            creep.memory.working = false
            return false
        }

        if (storage !== undefined && (creepData.mineId || creep.memory.developmentHauler?.mineId)) return deliverHaulerEnergy(creep)

        // 如果有lab需要填充，那就去
        if (fillJobs.labInEnergy != undefined && fillJobs.labInEnergy.length > 0) {
            const target = closestFillJob(creep, fillJobs.labInEnergy)
            if (target !== undefined) {
                if (creep.transferToTarget(target, RESOURCE_ENERGY)) fillJobs.labInEnergy = []
                return true
            }
        }

        // 如果有extension需要填充，那就去
        if (fillJobs.extension) {
            let target = creepData.targetId ? Game.getObjectById<StructureExtension | StructureSpawn>(creepData.targetId) : null
            if (target == undefined || (target as AnyStoreStructure).structureType === STRUCTURE_LINK ||
                target.my === false || target.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) {
                target = closestExtension(creep) || null
                creepData.targetId = target?.id
            }
            if (target != undefined) {
                if (creep.transferToTarget(target, RESOURCE_ENERGY)) {
                    fillJobs.extension = false
                    creepData.targetId = undefined
                }
                return true
            }
            fillJobs.extension = false
        }

        // 如果有tower需要填充，那就去
        if (fillJobs.tower != undefined && fillJobs.tower.length > 0) {
            const target = closestFillJob(creep, fillJobs.tower)
            if (target !== undefined) {
                if (creep.transferToTarget(target, RESOURCE_ENERGY)) fillJobs.tower = []
                return true
            }
        }

        // 如果有nuker需要填充，那就去
        if (creep.room.nuker != undefined && fillJobs.nukerEnergy) {
            if (creep.transferToTarget(creep.room.nuker, RESOURCE_ENERGY)) {
                fillJobs.nukerEnergy = false
            }
            return true
        }

        // 如果有powerSpawn需要填充，那就去
        if (creep.room.powerSpawn != undefined && fillJobs.powerSpawnEnergy) {
            if (creep.transferToTarget(creep.room.powerSpawn, RESOURCE_ENERGY)) {
                fillJobs.powerSpawnEnergy = false
            }
            return true
        }

        // 如果不是从storage搬运，那就放到storage
        if (storage != undefined && creepData.sourceId != storage.id) {
            creep.transferToTarget(storage, RESOURCE_ENERGY)
            return true
        }

        const spawn = creep.room.spawns[0]
        if (spawn != undefined && getDistance(creep.pos, spawn.pos) > 1) {
            creep.moveTo(spawn)
            return true
        }

        creep.say('💤')
        return true
    },
})
