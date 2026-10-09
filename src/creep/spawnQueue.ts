import { roleBaseEnum } from 'settings/creep'
import { isRoleSupported } from 'role'
import { isDevelopingRoom } from './development'
import { hasUsableStorageFiller } from './storageFillerLifecycle'
import { hasRemoteHomeEconomy } from './remoteHomeEconomy'
import { previewBodySelection, selectCreepBody } from './bodySelection'
import { developmentPolicy } from 'settings/development'

export function buildSpawnQueue(
    room: Room,
    creeps: { [name: string]: Creep } = Game.creeps
): string[] {
    // 循环creepConfig，筛选出未孵化的creep，并按照优先级排序
    const creepConfigCache = room.memory.creepConfig || {}
    var creepSpawnQueue = Object.keys(creepConfigCache)
        .filter(
            (creepName) =>
                creeps[creepName] == undefined &&
                isRoleSupported(creepConfigCache[creepName].role)
        )
        .sort(
            (a, b) =>
                creepConfigCache[a].spawnPriority -
                creepConfigCache[b].spawnPriority
        )

    if (creepSpawnQueue == undefined || creepSpawnQueue.length == 0) {
        return []
    }

    const fillers: Creep[] = [], harvesters: Creep[] = []
    for (const name in creeps) {
        const creep = creeps[name], role = creep.memory.role
        if (role !== roleBaseEnum.FILLER && role !== roleBaseEnum.HARVESTER) continue
        if (creep.room.name !== room.name) continue
        if (role === roleBaseEnum.FILLER) fillers.push(creep)
        else harvesters.push(creep)
    }

    // A full-size manager must not block the carrier needed to refill its spawn energy.
    const noStorageLogistics = fillers.length === 0 || room.controller?.level === 8 &&
        room.controller.my === true && !hasUsableStorageFiller(room, creeps)
    if (!isDevelopingRoom(room) && noStorageLogistics && room.storage &&
        room.storage.store[RESOURCE_ENERGY] > 0) {
        const storageCarrier = creepSpawnQueue.find(name => {
            const config = creepConfigCache[name]
            return config.role === roleBaseEnum.FILLER &&
                (config.data as FillerData).sourceId === room.storage!.id
        })
        if (storageCarrier) return [storageCarrier, ...creepSpawnQueue.filter(name => name !== storageCarrier)]
    }

    // With production already working, an affordable controller rescue cannot wait
    // behind a second Source's large miner while the controller is about to downgrade.
    if (isDevelopingRoom(room) && room.controller!.ticksToDowngrade <= developmentPolicy.controller.constructionDowngradeWarningTicks &&
        hasRemoteHomeEconomy(room, creeps)) {
        const recoveryUpgrader = creepSpawnQueue.find(name => {
            const config = creepConfigCache[name]
            if (config.role !== roleBaseEnum.UPGRADER || config.spawnPriority !== developmentPolicy.upgrading.downgradeRecoveryPriority) return false
            const { body } = selectCreepBody(room, config, false)
            return body.length > 0 && body.reduce((total, part) => total + BODYPART_COST[part], 0) <= room.energyAvailable
        })
        if (recoveryUpgrader) return [recoveryUpgrader, ...creepSpawnQueue.filter(name => name !== recoveryUpgrader)]
    }

    // The last miner can move stored energy while a complete distributor is funded.
    // Choose that birth before a mine carrier which would only return energy to Storage.
    // Capacity preview must remain useful before the current Spawn pool can pay for it.
    if (isDevelopingRoom(room) && fillers.length === 0 && harvesters.length > 0 && room.storage) {
        const storage = room.storage
        // Moving one batch from Storage through a miner into an Extension does not
        // change the funded birth. Count its native cargo while that batch is in transit.
        const funding = Math.max(0, storage.store[RESOURCE_ENERGY]) + Math.max(0, room.energyAvailable) +
            harvesters.reduce((total, creep) => total + (!creep.memory.spawnRoom || creep.memory.spawnRoom === room.name
                ? Math.max(0, creep.store?.[RESOURCE_ENERGY] || 0) : 0), 0)
        if (funding > 0) {
            const storageCarrier = creepSpawnQueue.find(name => {
                const config = creepConfigCache[name], data = config.data as FillerData
                if (config.role !== roleBaseEnum.FILLER || !config.development || data.sourceId !== storage.id || data.mineId) return false
                const { body } = previewBodySelection(room, config, 0)
                const cost = body.reduce((total, part) => total + BODYPART_COST[part], 0)
                return body.length > 0 && cost <= funding
            })
            if (storageCarrier) return [storageCarrier, ...creepSpawnQueue.filter(name => name !== storageCarrier)]
        }
    }

    // Recover stored spawn energy before an unaffordable miner blocks the whole queue.
    // One working Source/carrier pair is enough; extra Storage carriers retain normal priorities.
    if (isDevelopingRoom(room) && room.storage && room.energyAvailable < room.energyCapacityAvailable &&
        room.storage.store[RESOURCE_ENERGY] > 0 && hasRemoteHomeEconomy(room, creeps)) {
        const storageId = room.storage.id
        const hasStorageCarrier = fillers.some(creep => {
            const data = creep.memory.data as FillerData
            return creep.memory.spawnRoom === room.name && data.sourceId === storageId && !data.mineId &&
                !creep.memory.developmentHauler?.mineId && (creep.spawning ||
                    creep.getActiveBodyparts(CARRY) > 0 && creep.getActiveBodyparts(MOVE) > 0 &&
                    !(creep.memory.boostPlan?.steps.length && !creep.memory.boostPlan.completed && !creep.memory.boostPlan.failed))
        })
        if (!hasStorageCarrier) {
            const storageCarrier = creepSpawnQueue.find(name => {
                const config = creepConfigCache[name], data = config.data as FillerData
                if (config.role !== roleBaseEnum.FILLER || data.sourceId !== storageId || data.mineId || !config.development) return false
                const { body } = selectCreepBody(room, config, true)
                const cost = body.reduce((total, part) => total + BODYPART_COST[part], 0)
                return body.length > 0 && cost <= room.energyAvailable && cost <= room.storage!.store[RESOURCE_ENERGY]
            })
            if (storageCarrier) return [storageCarrier, ...creepSpawnQueue.filter(name => name !== storageCarrier)]
        }
    }

    // Source.id logistics works before containers exist: commission one carrier before adding more miners.
    if (isDevelopingRoom(room) && fillers.length === 0 && harvesters.length > 0) {
        const sourceIds = new Set(harvesters.map(creep => (creep.memory.data as HarvesterData).sourceId))
        const firstCarrier = creepSpawnQueue.find(name => {
            const config = creepConfigCache[name]
            if (config.role !== roleBaseEnum.FILLER) return false
            const sourceId = (config.data as FillerData).sourceId
            return sourceIds.has(sourceId) || room.containers.some(container => container.id === sourceId &&
                room.sources.some(source => sourceIds.has(source.id) && source.pos.inRangeTo(container, 1)))
        })
        if (firstCarrier) return [firstCarrier, ...creepSpawnQueue.filter(name => name !== firstCarrier)]
    }

    // 如果有harvester，但是没有filler，则优先孵化一个对应的filler
    if (
        room.containers.length > 0 &&
        fillers.length == 0 &&
        harvesters.length > 0
    ) {
        const container = room.containers.filter(
            (container) => container.store[RESOURCE_ENERGY] > 0
        )
        const highPriority = creepSpawnQueue.filter(
            (creepName) =>
                creepConfigCache[creepName].role == roleBaseEnum.FILLER &&
                container.length > 0 &&
                container[0].id ==
                    (creepConfigCache[creepName].data as FillerData).sourceId
        )[0]

        if (highPriority) {
            creepSpawnQueue = [
                highPriority,
                ...creepSpawnQueue.filter(
                    (creepName) => creepName != highPriority
                ),
            ]
        }
    }

    // 如果没有harvester，则优先孵化一个对应的harvester
    if (harvesters.length == 0) {
        const highPriority = creepSpawnQueue.filter(
            (creepName) =>
                creepConfigCache[creepName].role == roleBaseEnum.HARVESTER
        )[0]
        if (highPriority) {
            creepSpawnQueue = [
                highPriority,
                ...creepSpawnQueue.filter(
                    (creepName) => creepName != highPriority
                ),
            ]
        }
    }

    return creepSpawnQueue
}

export function orderCreepSpawnQueue(): void {
    for (const room of Object.values(Game.rooms)) {
        if (room.my) room.memory.creepSpawnQueue = buildSpawnQueue(room)
    }
}
