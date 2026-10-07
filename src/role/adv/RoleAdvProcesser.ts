import { rolePolicy } from "settings/rolePolicy"
import { runFactoryLogistics } from 'room/factory'
import { basicMinerals, ordinaryResourceTarget } from 'settings/resourcePolicy'
import { getTerminalResourceAmount, isWarehouseRoom, recordTerminalWithdrawal } from 'room/resourceNetwork'
import { boostLabWithdrawalAmount, labBoostWasReleased, prioritizeLabBoostJobs } from 'room/labBoostPriority'
import { getEvacuationIncomingCapacity, reserveEvacuationIncoming } from 'room/evacuation'

/** During boost preemption, return obsolete cargo only on successful native transfers. */
function returnPausedCargo(creep: Creep): boolean {
    const resource = Object.keys(creep.store).find(resource => creep.store[resource] > 0) as ResourceConstant | undefined
    if (!resource) { creep.memory.working = false; delete creep.memory.labBoostCargoReturn; return true }
    creep.memory.labBoostCargoReturn = true
    const room = creep.room
    const stock = [room.storage, room.terminal].find(stock => stock &&
        (stock === room.terminal ? getEvacuationIncomingCapacity(room) : stock.store.getFreeCapacity(resource) || 0) > 0)
    if (!stock) return true
    const free = stock === room.terminal ? getEvacuationIncomingCapacity(room) : stock.store.getFreeCapacity(resource) || 0
    const amount = Math.min(creep.store[resource], free)
    const result = creep.transfer(stock, resource, amount)
    if (result === OK) {
        if (stock === room.terminal) reserveEvacuationIncoming(room, amount)
        if (amount === creep.store.getUsedCapacity()) {
            creep.memory.working = false
            delete creep.memory.labBoostCargoReturn
        }
    } else if (result === ERR_NOT_IN_RANGE) creep.moveTo(stock)
    return true
}

export default (data: CreepData): ICreepConfig => ({
    isNeed: (room: Room, creepName: string) => {
        return room.level >= rolePolicy.processer.minimumRoomLevel && (room.labs.length > 0 || room.factory != undefined)
    },
    prepare(creep) {
        return true
    },
    source(creep) {
        const fillJobs = creep.room.memory.roomFillJob
        const paused = prioritizeLabBoostJobs(creep.room)
        if (creep.memory.labBoostCargoReturn || (labBoostWasReleased(creep.room) || paused && creep.memory.factoryLogistics &&
            !(creep.store[creep.memory.factoryLogistics.resourceType] > 0)) && creep.store.getUsedCapacity() > 0)
            return returnPausedCargo(creep)
        const boostWork = paused && !!(fillJobs.labOut?.length || fillJobs.labInMineral?.length)
        if (!boostWork && creep.memory.factoryLogistics && runFactoryLogistics(creep)) return true

        // 检查有没有掉落的资源需要捡
        // if (creep.pickupDroppedResource(true, 40)) return true

        // 身上有东西就先放下
        const deposit = creep.room.storage || creep.room.terminal
        if (deposit != undefined && creep.store.getUsedCapacity() > 0) {
            if (paused) return returnPausedCargo(creep)
            creep.transferToTarget(deposit, Object.keys(creep.store).find(resource => creep.store[resource] > 0) as ResourceConstant)
            return true
        }

        // 优先搬出来lab不需要的东西
        if (deposit != undefined && fillJobs.labOut != undefined && fillJobs.labOut.length > 0) {
            const labId = fillJobs.labOut.filter(labId => Game.getObjectById<StructureLab>(labId)?.mineralType != undefined)[0]
            const lab = Game.getObjectById(labId) as StructureLab
            if (!lab?.mineralType) { fillJobs.labOut = []; return true }
            if (paused) {
                const amount = Math.min(creep.store.getFreeCapacity(), lab.store[lab.mineralType] || 0,
                    boostLabWithdrawalAmount(creep.room, lab))
                if (amount <= 0) { fillJobs.labOut = fillJobs.labOut.filter(id => id !== labId); return true }
                const result = creep.withdraw(lab, lab.mineralType, amount)
                if (result === OK) creep.memory.working = true
                else if (result === ERR_NOT_IN_RANGE) creep.moveTo(lab)
                return true
            }
            if (creep.takeFromTarget(lab, lab.mineralType as ResourceConstant)) {
                creep.memory.working = true
                fillJobs.labOut = fillJobs.labOut.filter(id => id !== labId)
            }
            return true
        }

        // 去拿Lab需要的元素
        if (fillJobs.labInMineral != undefined && fillJobs.labInMineral.length > 0) {
            const resourceType = fillJobs.labInMineral[0].resourceType
            const targetLab = Game.getObjectById<StructureLab>(fillJobs.labInMineral[0].labId)
            const stock = [creep.room.storage, creep.room.terminal].find(item => item != undefined &&
                (item === creep.room.terminal ? getTerminalResourceAmount(creep.room, resourceType) : item.store[resourceType]) > 0)
            if (stock != undefined && targetLab != undefined) {
                let takeAmount: number | undefined
                const singleLabConfig = creep.room.memory.roomLabConfig.singleLabConfig[fillJobs.labInMineral[0].labId]
                if (singleLabConfig != undefined && singleLabConfig.boostMode) {
                    takeAmount = Math.max(0, (creep.room.memory.boostNeed[resourceType] || 0) - (targetLab.store[resourceType] || 0))
                    if (takeAmount === 0) {
                        fillJobs.labInMineral.shift()
                        return true
                    }
                } else {
                    const labConfig = creep.room.memory.roomLabConfig
                    if (targetLab.id === labConfig.sourceLab1 || targetLab.id === labConfig.sourceLab2) {
                        takeAmount = Math.max(0, Math.min(3000, labConfig.reactionAmount ?? 3000) - (targetLab.store[resourceType] || 0))
                        let boostStock = 0
                        for (const lab of creep.room.labs) if (labConfig.singleLabConfig[lab.id]?.boostMode)
                            boostStock += lab.store[resourceType] || 0
                        const baseKeep = !isWarehouseRoom(creep.room) && (basicMinerals.includes(resourceType) || resourceType === 'G') ?
                            ordinaryResourceTarget(resourceType) : 0
                        const protectedStock = Math.max(baseKeep, Math.max(0, (creep.room.memory.boostNeed?.[resourceType] || 0) - boostStock)) +
                            Math.max(0, (creep.room.memory.productionReserve?.factory?.[resourceType] || 0) -
                                (creep.room.factory?.store[resourceType] || 0))
                        const liquid = (creep.room.storage?.store[resourceType] || 0) + getTerminalResourceAmount(creep.room, resourceType)
                        takeAmount = Math.min(takeAmount, Math.max(0, liquid - protectedStock))
                        if (takeAmount === 0) { fillJobs.labInMineral.shift(); return true }
                    }
                }
                // A reaction batch can exceed this worker's capacity; only successful native
                // withdrawals may switch it to delivery, for storage as well as terminal stock.
                const available = stock === creep.room.terminal ? getTerminalResourceAmount(creep.room, resourceType) : stock.store[resourceType] || 0
                const amount = Math.min(takeAmount ?? Infinity, creep.store.getFreeCapacity(), available)
                if (amount <= 0) return true
                const result = creep.withdraw(stock, resourceType, amount)
                if (result === OK) {
                    if (stock === creep.room.terminal) recordTerminalWithdrawal(creep.room, resourceType, amount)
                    creep.memory.working = true
                } else if (result === ERR_NOT_IN_RANGE) creep.moveTo(stock)
                return true
            } else {
                const labId = fillJobs.labInMineral[0].labId
                fillJobs.labInMineral = fillJobs.labInMineral.filter(job => job.labId != labId)
            }
        }

        if (runFactoryLogistics(creep)) return true

        // 去拿核弹需要的G
        if (fillJobs.nukerMineral && creep.room.storage && creep.room.storage.store[RESOURCE_GHODIUM] > 0) {
            if (creep.takeFromTarget(creep.room.storage, RESOURCE_GHODIUM)) {
                creep.memory.working = true
                // fillJobs.nukerMineral = false
            }
            return true
        }

        // 去拿Power
        if (fillJobs.powerSpawnPower && creep.room.storage != undefined && creep.room.storage.store[RESOURCE_POWER] > 0) {
            const takeAmount = Math.min(rolePolicy.processer.powerWithdrawBatch, creep.room.storage.store[RESOURCE_POWER])
            if (creep.takeFromTarget(creep.room.storage, RESOURCE_POWER, takeAmount)) {
                creep.memory.working = true
                // fillJobs.powerSpawnPower = false
            }
            return true
        }

        return true
    },
    target(creep) {
        const fillJobs = creep.room.memory.roomFillJob
        const paused = prioritizeLabBoostJobs(creep.room)
        if (creep.memory.labBoostCargoReturn || (labBoostWasReleased(creep.room) || paused && creep.memory.factoryLogistics &&
            !(creep.store[creep.memory.factoryLogistics.resourceType] > 0)) && creep.store.getUsedCapacity() > 0)
            return returnPausedCargo(creep)
        const boostWork = paused && !!(fillJobs.labOut?.length || fillJobs.labInMineral?.length)
        if (!boostWork && creep.memory.factoryLogistics && runFactoryLogistics(creep)) return true
        if (creep.store.getUsedCapacity() === 0) {
            creep.memory.working = false
            return true
        }

        // 如果lab需要物资，判断是否已经携带，如果携带就送过去
        if (fillJobs.labInMineral) {
            const labInMineral = creep.room.memory.roomFillJob.labInMineral
            for (let index in labInMineral) {
                const targetLab = Game.getObjectById(labInMineral[index].labId) as StructureLab
                if (targetLab == undefined || !(creep.store[labInMineral[index].resourceType] > 0)) continue
                if ((targetLab.mineralType == undefined || targetLab.mineralType === labInMineral[index].resourceType) &&
                    (targetLab.store.getFreeCapacity(labInMineral[index].resourceType) || 0) > 0) {
                    if (paused) {
                        const resource = labInMineral[index].resourceType
                        const deficit = Math.max(0, (creep.room.memory.boostNeed[resource] || 0) - (targetLab.store[resource] || 0))
                        const amount = Math.min(creep.store[resource], deficit, targetLab.store.getFreeCapacity(resource) || 0)
                        if (amount <= 0) continue
                        const result = creep.transfer(targetLab, resource, amount)
                        if (result === OK) {
                            if (amount === deficit) fillJobs.labInMineral = fillJobs.labInMineral.filter(job => job.labId !== targetLab.id)
                            if (amount === creep.store.getUsedCapacity()) creep.memory.working = false
                        } else if (result === ERR_NOT_IN_RANGE) creep.moveTo(targetLab)
                        return true
                    }
                    if (creep.transferToTarget(targetLab, labInMineral[index].resourceType)) {
                        fillJobs.labInMineral = fillJobs.labInMineral.filter(job => job.labId != targetLab.id)
                        creep.memory.working = false
                    }
                    return true
                }
            }
        }

        if (paused) return returnPausedCargo(creep)

        // 如果nuker需要G，并且已经携带，就送过去
        if (creep.room.nuker != undefined && fillJobs.nukerMineral && creep.store[RESOURCE_GHODIUM] > 0) {
            if (creep.transferToTarget(creep.room.nuker, RESOURCE_GHODIUM)) {
                fillJobs.nukerMineral = false
                creep.memory.working = false
            }
            return true
        }

        // 如果需要Power，并且已经携带，就送过去
        if (creep.room.powerSpawn != undefined && fillJobs.powerSpawnPower && creep.store[RESOURCE_POWER] > 0) {
            if (creep.transferToTarget(creep.room.powerSpawn, RESOURCE_POWER)) {
                fillJobs.powerSpawnPower = false
                creep.memory.working = false
            }
            return true
        }

        // 如果携带了其他东西，就放回容器
        const deposit = creep.room.storage || creep.room.terminal
        if (deposit != undefined) {
            const resource = Object.keys(creep.store).find(type => creep.store[type] > 0) as ResourceConstant | undefined
            if (resource === undefined || creep.transferToTarget(deposit, resource)) {
                creep.memory.working = false
            }
            return true
        }

        return true
    },
})
