import { getClosestTarget, getDistance } from "utils"
import { developmentWorkAllowed, isDevelopingRoom } from 'creep/development'
import { controllerEnergyBuffer, controllerUpgradePosition } from 'creep/developmentLogistics'
import { runStationaryUpgrading } from 'creep/stationaryUpgrading'

function usableStore(target: AnyStoreStructure | null | undefined): target is AnyStoreStructure {
    return target != undefined && 'store' in target && (!('my' in target) || target.my !== false) && target.store[RESOURCE_ENERGY] > 0
}

function energyStores(room: Room): AnyStoreStructure[] {
    const stores: AnyStoreStructure[] = [...room.containers]
    if (room.storage != undefined) stores.push(room.storage)
    if (room.terminal != undefined) stores.push(room.terminal)
    return stores
}

function runDevelopingUpgrader(creep: Creep, data: UpgraderData): boolean {
    const controller = creep.room.controller!
    const energy = creep.store[RESOURCE_ENERGY]
    const buffer = controllerEnergyBuffer(creep.room)
    creep.memory.working = energy > 0
    if (buffer != undefined) {
        const seat = controllerUpgradePosition(creep, buffer)
        if (seat != undefined && !creep.pos.isEqualTo(seat)) creep.moveTo(seat, { range: 0 })
        if (getDistance(creep.pos, controller.pos) <= 3 && energy > 0 && developmentWorkAllowed(creep)) creep.upgradeController(controller)
        if (creep.pos.isNearTo(buffer) && creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && buffer.store[RESOURCE_ENERGY] > 0) {
            creep.withdraw(buffer, RESOURCE_ENERGY)
        }
        return true
    }

    // A mobile bootstrap worker consumes partial loads instead of waiting to fill.
    if (energy > 0) {
        if (getDistance(creep.pos, controller.pos) > 3) creep.moveTo(controller, { range: 3 })
        else if (developmentWorkAllowed(creep)) creep.upgradeController(controller)
        if (creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            const nearby = energyStores(creep.room).find(target => usableStore(target) && creep.pos.isNearTo(target))
            if (nearby != undefined) creep.withdraw(nearby, RESOURCE_ENERGY)
        }
        return true
    }

    let stock = Game.getObjectById<AnyStoreStructure>(data.sourceId)
    if (!usableStore(stock)) {
        stock = getClosestTarget(creep.pos, energyStores(creep.room).filter(usableStore)) || null
        if (stock != undefined) data.sourceId = stock.id
    }
    if (stock != undefined) {
        if (creep.pos.isNearTo(stock)) creep.withdraw(stock, RESOURCE_ENERGY)
        else creep.moveTo(stock, { range: 1 })
        return true
    }
    let source: Source | undefined
    for (const candidate of creep.room.sources) {
        if (candidate.energy <= 0) continue
        if (source == undefined || getDistance(candidate.pos, controller.pos) < getDistance(source.pos, controller.pos)) source = candidate
    }
    if (source == undefined) return false
    if (creep.harvest(source) == ERR_NOT_IN_RANGE) creep.moveTo(source, { range: 1 })
    return true
}

export default (data: CreepData): ICreepConfig => ({
    isNeed: (room: Room, creepName: string) => {
        return true
    },
    prepare(creep) {
        return true
    },
    source(creep) {
        if (isDevelopingRoom(creep.room)) return runDevelopingUpgrader(creep, data as UpgraderData)
        if (runStationaryUpgrading(creep, data as UpgraderData) !== undefined) return true
        // 如果没有空余容量了，就开始工作
        if (creep.store.getFreeCapacity() == 0) {
            creep.memory.working = true
            return false
        }

        const creepData: UpgraderData = data as UpgraderData
        var sourceTarget: AnyStoreStructure = Game.getObjectById(creepData.sourceId) as AnyStoreStructure

        if (sourceTarget == undefined || sourceTarget.store[RESOURCE_ENERGY] == 0) {
            var anyStoreStructure: AnyStoreStructure[] = [...creep.room.containers]
            if (creep.room.storage != undefined) anyStoreStructure.push(creep.room.storage)
            if (creep.room.terminal != undefined) anyStoreStructure.push(creep.room.terminal)
            anyStoreStructure = anyStoreStructure.filter(item => item != undefined && item.store[RESOURCE_ENERGY] > 0)
            sourceTarget = getClosestTarget(creep.pos, anyStoreStructure)
            if (sourceTarget == undefined) {
                creep.say('❓')
                return false
            }
            creepData.sourceId = sourceTarget.id
        }

        if (sourceTarget.store[RESOURCE_ENERGY] == 0) {
            creep.say("💤")
            return true
        }

        if (getDistance(creep.pos, sourceTarget.pos) <= 1) {
            creep.withdraw(sourceTarget, RESOURCE_ENERGY)
        } else {
            creep.moveTo(sourceTarget)
        }

        return true
    },
    target(creep) {
        if (isDevelopingRoom(creep.room)) return runDevelopingUpgrader(creep, data as UpgraderData)
        if (runStationaryUpgrading(creep, data as UpgraderData) !== undefined) return true
        const fixPos = Game.flags[creep.name]
        if (fixPos && !creep.pos.isEqualTo(fixPos)) {
            creep.moveTo(fixPos)
            return false
        }
        // 如果没有能量了，就切换为采集状态
        if (creep.store[RESOURCE_ENERGY] == 0) {
            creep.memory.working = false
            return false
        }

        if (!creep.room.controller) return false

        // 升级
        const distanceController = getDistance(creep.pos, creep.room.controller.pos)
        if (distanceController > 3) {
            if (creep.room.terminal != undefined && getDistance(creep.room.terminal.pos, creep.room.controller.pos) < 3) {
                creep.moveTo(creep.room.terminal)
            } else {
                creep.moveTo(creep.room.controller)
            }
        } else {
            creep.upgradeController(creep.room.controller)
            if (creep.room.terminal != undefined && creep.pos.isNearTo(creep.room.terminal)) {
                creep.withdraw(creep.room.terminal, RESOURCE_ENERGY)
            } else if (creep.room.storage != undefined && creep.pos.isNearTo(creep.room.storage)) {
                creep.withdraw(creep.room.storage, RESOURCE_ENERGY)
            }
        }

        // 签名
        if (creep.room.memory.roomSignText != undefined && creep.room.controller.sign?.text != creep.room.memory.roomSignText) {
            if (distanceController > 1) {
                creep.moveTo(creep.room.controller)
            } else {
                creep.signController(creep.room.controller, creep.room.memory.roomSignText)
            }
        }
        return true
    },
})
