import { roleAdvEnum, roleBaseEnum } from "settings/creep"
import { createRoleBehavior, isRoleSupported } from 'role'
import { selectCreepBody } from 'creep/bodySelection'
import { reserveBoostPlan } from 'creep/boosting'
import { isDevelopmentRemoteData, DevelopmentRemoteData } from 'creep/developmentRemotes'
import { isDevelopingRoom } from 'creep/development'
import { combatSpawnAllowed, recordCombatSpawn } from 'combat/spawning'
import { isRoomEvacuating } from 'room/evacuationState'

export default class SpawnExtension extends StructureSpawn {
    public init(): void {
        if (!this.room.memory.roomFillJob.extension && this.room.energyAvailable < this.room.energyCapacityAvailable) {
            this.room.memory.roomFillJob.extension = true
        }
    }
    public doWork(): void {
        if (this.spawning) return

        const creepSpawnQueue = this.room.memory.creepSpawnQueue || []

        // 需求刷新间隔内可能出现旧队列，跳过过期/已存在/未实现的配置。
        while (creepSpawnQueue.length > 0) {
            const name = creepSpawnQueue[0]
            const config = this.room.memory.creepConfig?.[name]
            if (config && isRoomEvacuating(this.room) && config.role !== 'defender' && config.role !== 'rdefender' &&
                !(config.role === 'filler' && (config.data as FillerData).evacuationRoom === this.room.name)) {
                creepSpawnQueue.shift()
                continue
            }
            if (config && !combatSpawnAllowed(config)) { creepSpawnQueue.shift(); continue }
            const developmentRemote = (config?.data as Partial<DevelopmentRemoteData> | undefined)?.developmentRemote
            // A demand refresh will publish legacy profiles after reaching RCL8; stale growth must wait for that refresh.
            const retiredDevelopment = !isDevelopingRoom(this.room) &&
                (config?.development !== undefined || developmentRemote !== undefined)
            if (retiredDevelopment) {
                creepSpawnQueue.shift()
                continue
            }
            if (config && developmentRemote !== undefined && (!isDevelopmentRemoteData(config.data) ||
                createRoleBehavior(config.role, config.data)?.isNeed(this.room, name) !== true)) {
                creepSpawnQueue.shift()
                continue
            }
            if (config && !Game.creeps[name] && isRoleSupported(config.role)) break
            creepSpawnQueue.shift()
        }

        // 如果队列中有creep，则进行孵化
        if (creepSpawnQueue != undefined && creepSpawnQueue.length > 0) {
            const creepName = creepSpawnQueue[0]
            const creepMemory = this.room.memory.creepConfig[creepName]
            const bootstrapBuilder = creepMemory.role == roleAdvEnum.RBUILDER &&
                (creepMemory.data as RemoteBuilderData).bootstrap === true
            // The hub waits for its planned body; emergency carriers restart extension filling.
            const forceSpawn = bootstrapBuilder || creepMemory.role == roleBaseEnum.FILLER || creepMemory.role == roleBaseEnum.HARVESTER
            // Bootstrap assistance must remain mobile and affordable before the target has a spawn.
            const config = bootstrapBuilder ? { ...creepMemory, bodyProfile: {
                ...creepMemory.bodyProfile, boostTier: 0 as CreepBoostTier,
            } } : creepMemory
            const plan = selectCreepBody(this.room, config, forceSpawn)
            if (!combatSpawnAllowed(config, plan)) { creepSpawnQueue.shift(); return }
            const bodyPart = plan.body
            if (bodyPart.length === 0) return
            if (bodyPart.reduce((energy, part) => energy + BODYPART_COST[part], 0) > this.room.energyAvailable) return
            creepMemory.boostPlan = plan.boostPlan
            const spawnResult = this.spawnCreep(bodyPart, creepName, { memory: creepMemory })
            if (spawnResult == OK) {
                recordCombatSpawn(creepMemory, plan)
                reserveBoostPlan(this.room, creepName, plan.boostPlan)
                creepSpawnQueue.shift()
            }
        }
    }
}
