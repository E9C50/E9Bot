import { getDistance } from "utils"
import { rolePolicy } from "settings/rolePolicy"
import { repairCycleTarget, resetRepairCycle } from 'role/support/repairTarget'
import { hasOwnedRamparts } from 'room/repairTargets'
import { developmentWorkAllowed } from 'creep/development'

function maintenanceTurn(creep: Creep): boolean {
    const interval = Math.max(1, Math.floor(rolePolicy.repairer.cpuMaintenance.interval))
    let offset = 0
    for (let index = 0; index < creep.name.length; index++) offset = (offset + creep.name.charCodeAt(index)) % interval
    return Game.time % interval === offset
}

export default (data: CreepData): ICreepConfig => ({
    isNeed: (room: Room, creepName: string) => {
        return hasOwnedRamparts(room) ||
            room.storage != undefined && room.storage.store[RESOURCE_ENERGY] > rolePolicy.repairer.minimumStorageEnergy && room.wallsNeedRepair.length > 0
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
        creep.memory.dontPullMe = false
        // 如果没有空余容量了，就开始工作
        if (creep.store.getFreeCapacity() == 0) {
            creep.memory.working = true
            return false
        }

        const configured = Game.getObjectById<StructureContainer | StructureStorage | Source>(creepData.sourceId)
        let stock: StructureStorage | StructureContainer | undefined
        if (creep.room.storage && creep.room.storage.store[RESOURCE_ENERGY] > 0) stock = creep.room.storage
        else if (configured && 'store' in configured && configured.pos.roomName === creep.room.name &&
            (configured.structureType === STRUCTURE_STORAGE || configured.structureType === STRUCTURE_CONTAINER) &&
            (!('my' in configured) || configured.my !== false) && configured.store[RESOURCE_ENERGY] > 0) stock = configured
        else {
            let closest = Infinity
            for (const container of creep.room.containers || []) {
                if (container.store[RESOURCE_ENERGY] <= 0) continue
                const distance = getDistance(creep.pos, container.pos)
                if (distance < closest) { stock = container; closest = distance }
            }
        }
        if (stock) {
            creepData.sourceId = stock.id
            if (getDistance(creep.pos, stock.pos) <= 1) creep.withdraw(stock, RESOURCE_ENERGY)
            else creep.moveTo(stock)
            return true
        }

        let drop: Resource | undefined, distance = Infinity
        for (const candidate of creep.room.droppedResource || []) {
            if (candidate.resourceType !== RESOURCE_ENERGY || candidate.amount <= 0) continue
            const candidateDistance = getDistance(creep.pos, candidate.pos)
            if (candidateDistance < distance) { drop = candidate; distance = candidateDistance }
        }
        if (drop) {
            if (distance <= 1) creep.pickup(drop)
            else creep.moveTo(drop)
            return true
        }
        let source = configured && 'energy' in configured && configured.energy > 0 &&
            configured.pos.roomName === creep.room.name ? configured : undefined
        if (!source) {
            distance = Infinity
            for (const candidate of creep.room.sources || []) {
                if (candidate.energy <= 0) continue
                const candidateDistance = getDistance(creep.pos, candidate.pos)
                if (candidateDistance < distance) { source = candidate; distance = candidateDistance }
            }
        }
        if (source) {
            creepData.sourceId = source.id
            if (getDistance(creep.pos, source.pos) <= 1) creep.harvest(source)
            else creep.moveTo(source)
            return true
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
            const select = (targets: Structure[], selected?: Structure): Structure | undefined => {
                let minimumHits = selected?.hits ?? Infinity
                // Keep equal-hit list order without sorting or allocating filtered candidates.
                for (const target of targets) {
                    if (target.hits >= target.hitsMax || target.pos.roomName !== creep.room.name ||
                        ('my' in target && (target as OwnedStructure).my === false) ||
                        (defenderCostMatrix !== undefined && defenderCostMatrix.get(target.pos.x, target.pos.y) === 255)) continue
                    if (target.hits < minimumHits) { selected = target; minimumHits = target.hits }
                }
                return selected
            }
            repairTarget = select(creep.room.wallsNeedRepair)
            // The minimum resident keeps strengthening barriers beyond the room's soft maintenance goal.
            if (!repairTarget) repairTarget = select(creep.room.walls || [], select(creep.room.ramparts || []))
            creepData.repairTarget = repairTarget?.id || ''
        }

        // 所有墙已满或暂不可达时等待，不转去升级；掉血后继续维修。
        if (repairTarget == undefined) {
            creep.memory.dontPullMe = false
            return true
        }

        const policy = rolePolicy.repairer.cpuMaintenance
        if (Game.cpu?.bucket < policy.minimumBucket && !Memory.warMode?.[creep.room.name] && creep.room.enemies.length === 0 &&
            (repairTarget.structureType === STRUCTURE_WALL || repairTarget.structureType === STRUCTURE_RAMPART) &&
            repairTarget.hits > policy.criticalHits && !maintenanceTurn(creep)) return true

        // 过去维修
        if (getDistance(creep.pos, repairTarget.pos) <= 3) {
            if (Memory.warMode?.[creep.room.name] || creep.room.enemies.length > 0 || developmentWorkAllowed(creep)) creep.repair(repairTarget)
        } else {
            creep.moveTo(repairTarget)
        }

        return true
    },
})
