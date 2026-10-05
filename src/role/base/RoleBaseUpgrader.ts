import { getClosestTarget, getDistance } from "utils"
import { developmentWorkAllowed, isDevelopingRoom } from 'creep/development'
import { controllerUpgradePosition } from 'creep/developmentLogistics'
import { controllerSupplyPosition } from 'creep/controllerSupplyPositions'
import { runStationaryUpgrading } from 'creep/stationaryUpgrading'
import { controllerEnergyRelayCanSupply, runControllerEnergyRelay } from 'creep/controllerEnergyRelay'
import { developmentPolicy } from 'settings/development'
import { controllerContainerSite, controllerNeedsUrgentUpgrade } from 'creep/controllerConstruction'

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
    const construction = controllerContainerSite(creep)
    const supply = controllerSupplyPosition(creep), buffer = supply.buffer
    creep.memory.working = energy > 0
    if (buffer != undefined) {
        delete data.harvestingSourceId
        const supplied = controllerEnergyRelayCanSupply(creep, buffer)
        const collecting = construction !== undefined && energy === 0 && !supplied
        const requireAdjacent = supply.requireAdjacent || collecting
        const retainCurrent = (!requireAdjacent || creep.pos.isNearTo(buffer)) && (energy > 0 || creep.pos.isNearTo(buffer) || supplied)
        const building = collecting ? undefined : construction
        let seat = controllerUpgradePosition(creep, buffer, undefined, retainCurrent, requireAdjacent, building)
        // The supply root stays beside its buffer if no legal construction seat can also feed the group.
        if (seat === undefined && building !== undefined)
            seat = controllerUpgradePosition(creep, buffer, undefined, retainCurrent, requireAdjacent)
        if (seat != undefined && !creep.pos.isEqualTo(seat)) creep.moveTo(seat, { range: 0, ignoreCreeps: false })
        if (energy > 0 && developmentWorkAllowed(creep)) {
            if (construction !== undefined && getDistance(creep.pos, construction.pos) <= 3) creep.build(construction)
            else if (getDistance(creep.pos, controller.pos) <= 3 &&
                (construction === undefined || seat === undefined || getDistance(seat, construction.pos) > 3)) creep.upgradeController(controller)
        }
        runControllerEnergyRelay(creep, buffer)
        return true
    }

    // Self-harvesting needs a full travel batch; received energy may be used immediately.
    if (data.harvestingSourceId != undefined) {
        const source = Game.getObjectById<Source>(data.harvestingSourceId)
        const load = Math.ceil(creep.store.getCapacity(RESOURCE_ENERGY) *
            Math.max(0, Math.min(1, developmentPolicy.upgrading.selfHarvestLoadRatio)))
        if (source?.pos.roomName === creep.room.name && source.energy > 0 && energy < load &&
            creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && (energy === 0 || !controllerNeedsUrgentUpgrade(creep.room))) {
            creep.memory.working = false
            if (creep.harvest(source) == ERR_NOT_IN_RANGE) creep.moveTo(source, { range: 1 })
            return true
        }
        delete data.harvestingSourceId
    }

    if (energy > 0) {
        if (construction !== undefined) {
            const seat = controllerUpgradePosition(creep, undefined, undefined, true, false, construction)
            if (seat !== undefined && !creep.pos.isEqualTo(seat)) creep.moveTo(seat, { range: 0, ignoreCreeps: false })
            else if (seat === undefined && getDistance(creep.pos, construction.pos) > 3) {
                creep.memory.dontPullMe = false
                creep.moveTo(construction, { range: 3, ignoreCreeps: false })
            }
            if (getDistance(creep.pos, construction.pos) <= 3 && developmentWorkAllowed(creep)) creep.build(construction)
        } else if (getDistance(creep.pos, controller.pos) > 3) {
            creep.memory.dontPullMe = false
            creep.moveTo(controller, { range: 3, ignoreCreeps: false })
        } else {
            controllerUpgradePosition(creep)
            if (developmentWorkAllowed(creep)) creep.upgradeController(controller)
        }
        if (creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            const nearby = energyStores(creep.room).find(target => usableStore(target) && creep.pos.isNearTo(target))
            if (nearby != undefined) creep.withdraw(nearby, RESOURCE_ENERGY)
        }
        return true
    }

    creep.memory.dontPullMe = false
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
    data.harvestingSourceId = source.id
    creep.memory.working = false
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
