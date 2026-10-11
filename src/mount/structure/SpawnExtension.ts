import { roleAdvEnum } from "settings/creep"
import { createRoleBehavior, isRoleSupported } from 'role'
import { selectCreepBody } from 'creep/bodySelection'
import type { BodyPlan } from 'creep/bodyPlanner'
import { reserveBoostPlan } from 'creep/boosting'
import { isDevelopmentRemoteData, DevelopmentRemoteData } from 'creep/developmentRemotes'
import { isDevelopingRoom } from 'creep/development'
import { combatSpawnAllowed, recordCombatSpawn } from 'combat/spawning'
import { isRoomEvacuating } from 'room/evacuationState'
import { isMatureStorageFiller } from 'creep/storageFillerLifecycle'
import { needsEmergencyBody } from 'creep/spawnEnergyPolicy'
import { isTargetDismantleSpawnReserved } from 'shard/targetDismantleControl'
import { remoteSpawnAllowed } from 'creep/remoteCommissioning'
import { isSpawnEnergyCarrier } from 'creep/spawnEnergyCarrier'
import { developmentReplacementDeadline, prioritizeDevelopmentRecovery } from 'creep/developmentRecoveryPriority'

export default class SpawnExtension extends StructureSpawn {
    private availableConfig(name: string): CreepMemory | undefined {
        const config = this.room.memory.creepConfig?.[name]
        if (!config || Game.creeps[name] || !isRoleSupported(config.role)) return undefined
        if (isRoomEvacuating(this.room) && config.role !== 'defender' && config.role !== 'rdefender' &&
            !(config.role === 'filler' && (config.data as FillerData).evacuationRoom === this.room.name)) return undefined
        if (!combatSpawnAllowed(config) || !remoteSpawnAllowed(this.room, config)) return undefined
        const developmentRemote = (config.data as Partial<DevelopmentRemoteData> | undefined)?.developmentRemote
        if (!isDevelopingRoom(this.room) && (config.development !== undefined || developmentRemote !== undefined)) return undefined
        if (developmentRemote !== undefined && (!isDevelopmentRemoteData(config.data) ||
            createRoleBehavior(config.role, config.data)?.isNeed(this.room, name) !== true)) return undefined
        return config
    }

    /** A stale expensive head cannot prevent an affordable complete miner/carrier from restoring production. */
    private affordableRecovery(queue: string[]): { index: number; memory: CreepMemory; plan: BodyPlan } | undefined {
        let harvester = false, filler = false
        for (const name in Game.creeps) {
            const creep = Game.creeps[name], memory = creep.memory
            if (memory.role !== 'harvester' && memory.role !== 'filler') continue
            if (memory.spawnRoom !== this.room.name) continue
            if (memory.role === 'filler' && !creep.spawning) {
                const data = memory.data as FillerData
                const dedicated = !isDevelopingRoom(this.room) || !this.room.storage ||
                    data.sourceId === this.room.storage.id && !data.mineId && !memory.developmentHauler?.mineId
                if (dedicated && isSpawnEnergyCarrier(this.room, creep)) filler = true
            } else {
                const room = creep.room
                if (!room || room.name !== this.room.name) continue
                if (!creep.spawning && (creep.ticksToLive === 0 ||
                    memory.boostPlan?.steps.length && !memory.boostPlan.completed && !memory.boostPlan.failed)) continue
                if (memory.role === 'harvester' && (creep.spawning || creep.getActiveBodyparts(WORK) > 0)) harvester = true
                if (memory.role === 'filler' && !(isDevelopingRoom(this.room) && this.room.storage &&
                    ((memory.data as FillerData).mineId || memory.developmentHauler?.mineId))) filler = true
            }
            if (harvester && filler) break
        }
        for (let index = 1; index < queue.length; index++) {
            const requested = this.room.memory.creepConfig?.[queue[index]]
            if (!requested || requested.role !== 'harvester' && requested.role !== 'filler' ||
                requested.role === 'harvester' && harvester && developmentReplacementDeadline(requested) === undefined ||
                requested.role === 'filler' && filler && developmentReplacementDeadline(requested) === undefined ||
                requested.role === 'filler' && isDevelopingRoom(this.room) && this.room.storage &&
                    ((requested.data as FillerData).mineId || requested.developmentHauler?.mineId) &&
                    developmentReplacementDeadline(requested) === undefined) continue
            const memory = this.availableConfig(queue[index])
            if (!memory) continue
            const plan = selectCreepBody(this.room, memory, false)
            if (plan.body.length > 0 && plan.body.reduce((cost, part) => cost + BODYPART_COST[part], 0) <= this.room.energyAvailable &&
                combatSpawnAllowed(memory, plan)) return { index, memory, plan }
        }
        return undefined
    }

    public init(): void {
        if (!this.room.memory.roomFillJob.extension && this.room.energyAvailable < this.room.energyCapacityAvailable) {
            this.room.memory.roomFillJob.extension = true
        }
    }
    public doWork(): void {
        if (this.spawning || isTargetDismantleSpawnReserved(this)) return

        let creepSpawnQueue = this.room.memory.creepSpawnQueue || []
        if (this.room.memory.creepConfig?.[creepSpawnQueue[0]]?.role === 'manager') {
            creepSpawnQueue = prioritizeDevelopmentRecovery(this.room, creepSpawnQueue)
            this.room.memory.creepSpawnQueue = creepSpawnQueue
        }

        // 需求刷新间隔内可能出现旧队列，跳过过期/已存在/未实现的配置。
        while (creepSpawnQueue.length > 0) {
            if (this.availableConfig(creepSpawnQueue[0])) break
            creepSpawnQueue.shift()
        }

        // 如果队列中有creep，则进行孵化
        if (creepSpawnQueue != undefined && creepSpawnQueue.length > 0) {
            let queueIndex = 0
            let creepMemory = this.room.memory.creepConfig[creepSpawnQueue[queueIndex]]
            const bootstrapBuilder = creepMemory.role == roleAdvEnum.RBUILDER &&
                (creepMemory.data as RemoteBuilderData).bootstrap === true
            const forceSpawn = needsEmergencyBody(this.room)
            const emergencyStorageFiller = forceSpawn && isMatureStorageFiller(this.room, creepMemory)
            // Bootstrap assistance must remain mobile and affordable before the target has a spawn.
            const config = bootstrapBuilder || emergencyStorageFiller ? { ...creepMemory, bodyProfile: {
                ...creepMemory.bodyProfile, boostTier: 0 as CreepBoostTier,
            } } : creepMemory
            let plan = selectCreepBody(this.room, config, forceSpawn)
            if (!combatSpawnAllowed(config, plan)) { creepSpawnQueue.shift(); return }
            if (!forceSpawn && (plan.body.length === 0 ||
                plan.body.reduce((energy, part) => energy + BODYPART_COST[part], 0) > this.room.energyAvailable)) {
                const recovery = this.affordableRecovery(creepSpawnQueue)
                if (recovery) {
                    queueIndex = recovery.index
                    creepMemory = recovery.memory
                    plan = recovery.plan
                }
            }
            const bodyPart = plan.body
            if (bodyPart.length === 0) return
            if (bodyPart.reduce((energy, part) => energy + BODYPART_COST[part], 0) > this.room.energyAvailable) return
            creepMemory.boostPlan = plan.boostPlan
            const creepName = creepSpawnQueue[queueIndex]
            const spawnResult = this.spawnCreep(bodyPart, creepName, { memory: creepMemory })
            if (spawnResult == OK) {
                recordCombatSpawn(creepMemory, plan)
                reserveBoostPlan(this.room, creepName, plan.boostPlan)
                creepSpawnQueue.splice(queueIndex, 1)
                const waitingSince = this.room.memory.creepSpawnWaitingSince
                if (waitingSince) {
                    delete waitingSince[creepName]
                    if (Object.keys(waitingSince).length === 0) delete this.room.memory.creepSpawnWaitingSince
                }
            }
        }
    }
}
