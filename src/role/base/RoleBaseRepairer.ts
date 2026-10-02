import { getDistance } from "utils"
import BaseRoleUpgrader from "./RoleBaseUpgrader"
import { rolePolicy } from "settings/rolePolicy"

let criticalTick: number | undefined, criticalShard: string | undefined
interface CriticalRepairIndex { target?: Structure; hasTargets: boolean }
let criticalByRoom = new WeakMap<Room, CriticalRepairIndex>()

/** Tick-local only: another newly built or damaged barrier can supersede a healthy cached target. */
function criticalRepairIndex(room: Room): CriticalRepairIndex {
    if (criticalTick !== Game.time || criticalShard !== Game.shard?.name) {
        criticalTick = Game.time; criticalShard = Game.shard?.name; criticalByRoom = new WeakMap()
    }
    const cached = criticalByRoom.get(room)
    if (cached != undefined) return cached
    let selected: Structure | undefined, minimumHits = Infinity, hasTargets = false
    for (const target of room.wallsNeedRepair) {
        const hits = target.hits
        if (hits >= target.hitsMax) continue
        hasTargets = true
        if (hits > rolePolicy.repairer.cpuMaintenance.criticalHits) continue
        if (hits < minimumHits) { selected = target; minimumHits = hits }
    }
    const index = { target: selected, hasTargets }
    criticalByRoom.set(room, index)
    return index
}

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
        // 如果没有空余容量了，就开始工作
        if (creep.store.getFreeCapacity() == 0) {
            creep.memory.working = true
            return false
        }

        const creepData: RepairerData = data as RepairerData
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
            creepData.repairTarget = ''
            return false
        }

        // 找到要修复的建筑
        let repairTarget = creepData.repairTarget ? Game.getObjectById<Structure>(creepData.repairTarget) : null
        if (Game.cpu?.bucket < rolePolicy.repairer.cpuMaintenance.minimumBucket &&
            !Memory.warMode?.[creep.room.name] && creep.room.enemies.length === 0) {
            const { target: critical, hasTargets } = criticalRepairIndex(creep.room)
            if (critical != undefined) {
                repairTarget = critical
                creepData.repairTarget = critical.id
            } else {
                const highBarrier = repairTarget != undefined && repairTarget.hits < repairTarget.hitsMax ?
                    (repairTarget.structureType === STRUCTURE_WALL || repairTarget.structureType === STRUCTURE_RAMPART) &&
                        repairTarget.hits > rolePolicy.repairer.cpuMaintenance.criticalHits : hasTargets
                if (highBarrier && !maintenanceTurn(creep)) return true
            }
        }
        if (repairTarget == undefined || repairTarget.hits >= repairTarget.hitsMax) {
            repairTarget = null
            const defenderCostMatrix = Memory.warMode?.[creep.room.name] ? creep.room.getDefenderCostMatrix() : undefined
            let minimumHits = Infinity
            // Keep the original list order for equal hits, without sorting the shared room cache.
            for (const target of creep.room.wallsNeedRepair) {
                if (target.hits >= target.hitsMax || (defenderCostMatrix !== undefined && defenderCostMatrix.get(target.pos.x, target.pos.y) === 255)) continue
                if (target.hits < minimumHits) { repairTarget = target; minimumHits = target.hits }
            }
            creepData.repairTarget = repairTarget?.id || ''
        }

        // 如果没有就去升级
        if (repairTarget == undefined) {
            return BaseRoleUpgrader(creep.memory.data).target(creep)
        }

        // 过去维修
        if (getDistance(creep.pos, repairTarget.pos) <= 3) {
            creep.repair(repairTarget)
        } else {
            creep.moveTo(repairTarget)
        }

        return true
    },
})
