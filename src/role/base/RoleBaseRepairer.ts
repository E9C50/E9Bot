import { getDistance } from "utils"
import BaseRoleUpgrader from "./RoleBaseUpgrader"
import { rolePolicy } from "settings/rolePolicy"
import { repairCycleTarget, resetRepairCycle } from 'role/support/repairTarget'

function maintenanceTurn(creep: Creep): boolean {
    const interval = Math.max(1, Math.floor(rolePolicy.repairer.cpuMaintenance.interval))
    let offset = 0
    for (let index = 0; index < creep.name.length; index++) offset = (offset + creep.name.charCodeAt(index)) % interval
    return Game.time % interval === offset
}

export default (data: CreepData): ICreepConfig => ({
    isNeed: (room: Room, creepName: string) => {
        return room.storage != undefined && room.storage.store[RESOURCE_ENERGY] > rolePolicy.repairer.minimumStorageEnergy && room.wallsNeedRepair.length > 0
    },
    prepare(creep) {
        if (creep.room.level == rolePolicy.repairer.boostAtLevel) {
            return creep.goBoost()
        }
        return true
    },
    source(creep) {
        const creepData = data as RepairerData
        resetRepairCycle(creepData)
        // 如果没有空余容量了，就开始工作
        if (creep.store.getFreeCapacity() == 0) {
            creep.memory.working = true
            return false
        }

        const sourceTarget: StructureContainer | StructureStorage = Game.getObjectById(creepData.sourceId) as StructureContainer | StructureStorage

        if (sourceTarget == undefined || sourceTarget.store[RESOURCE_ENERGY] == 0) {
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
        const creepData: RepairerData = data as RepairerData

        // 如果没有能量了，就切换为采集状态
        if (creep.store[RESOURCE_ENERGY] == 0) {
            creep.memory.working = false
            resetRepairCycle(creepData)
            return false
        }

        // 一轮能量只修当前目标；补能完成或原目标失效后才重新选择。
        let repairTarget = repairCycleTarget(creep, creepData)
        if (repairTarget == undefined) {
            const defenderCostMatrix = Memory.warMode?.[creep.room.name] ? creep.room.getDefenderCostMatrix() : undefined
            let minimumHits = Infinity
            // Keep the original list order for equal hits, without sorting the shared room cache.
            for (const target of creep.room.wallsNeedRepair) {
                if (target.hits >= target.hitsMax || target.pos.roomName !== creep.room.name ||
                    ('my' in target && (target as OwnedStructure).my === false) ||
                    (defenderCostMatrix !== undefined && defenderCostMatrix.get(target.pos.x, target.pos.y) === 255)) continue
                if (target.hits < minimumHits) { repairTarget = target; minimumHits = target.hits }
            }
            creepData.repairTarget = repairTarget?.id || ''
        }

        // 如果没有就去升级
        if (repairTarget == undefined) {
            return BaseRoleUpgrader(creep.memory.data).target(creep)
        }

        const policy = rolePolicy.repairer.cpuMaintenance
        if (Game.cpu?.bucket < policy.minimumBucket && !Memory.warMode?.[creep.room.name] && creep.room.enemies.length === 0 &&
            (repairTarget.structureType === STRUCTURE_WALL || repairTarget.structureType === STRUCTURE_RAMPART) &&
            repairTarget.hits > policy.criticalHits && !maintenanceTurn(creep)) return true

        // 过去维修
        if (getDistance(creep.pos, repairTarget.pos) <= 3) {
            creep.repair(repairTarget)
        } else {
            creep.moveTo(repairTarget)
        }

        return true
    },
})
