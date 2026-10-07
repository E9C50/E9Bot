import { structurePolicy } from 'settings/structures'
import { reactionSource } from "settings/labs"

const energyQueueRuns = new WeakMap<Room, { tick: number; shard: string }>()
interface ReactionSources {
    tick: number
    shard: string
    firstId: string
    secondId: string
    first: StructureLab | null
    second: StructureLab | null
}
const reactionSources = new WeakMap<Room, ReactionSources>()

/** Reuse object resolution only; each output still reads the current reagent values. */
function sourcePair(room: Room, firstId: string, secondId: string): ReactionSources {
    const previous = reactionSources.get(room)
    if (previous?.tick === Game.time && previous.shard === Game.shard.name &&
        previous.firstId === firstId && previous.secondId === secondId) return previous
    const pair = { tick: Game.time, shard: Game.shard.name, firstId, secondId,
        first: Game.getObjectById<StructureLab>(firstId), second: Game.getObjectById<StructureLab>(secondId) }
    reactionSources.set(room, pair)
    return pair
}

/** Compact legacy duplicates once per room/job tick while keeping pending job order. */
function deduplicateEnergyJobs(room: Room, jobs: string[]): void {
    const previous = energyQueueRuns.get(room)
    if (previous?.tick === Game.time && previous.shard === Game.shard.name) return
    energyQueueRuns.set(room, { tick: Game.time, shard: Game.shard.name })
    const seen = new Set<string>()
    let write = 0
    for (let read = 0; read < jobs.length; read++) {
        const id = jobs[read]
        if (seen.has(id)) continue
        seen.add(id); jobs[write++] = id
    }
    jobs.length = write
}

export default class LabExtension extends StructureLab {
    private labReactionWork(): void {
        // 如果Lab冷却中，就跳过
        if (this.cooldown != 0) return

        const config = this.room.memory.roomLabConfig
        const sourceLab1 = config.sourceLab1
        const sourceLab2 = config.sourceLab2
        // 如果房间没有配置好两个sourceLab，就跳过
        if (sourceLab1 == undefined || sourceLab2 == undefined || config.labReactionConfig == undefined ||
            config.singleLabConfig[sourceLab1]?.boostMode || config.singleLabConfig[sourceLab2]?.boostMode) return

        // 如果是sourceLab，就跳过
        if (this.id == sourceLab1 || this.id == sourceLab2) return

        // 获取两个lab
        const { first: lab1, second: lab2 } = sourcePair(this.room, sourceLab1, sourceLab2)
        if (lab1 == undefined || lab2 == undefined) return

        const firstType = lab1.mineralType, secondType = lab2.mineralType
        if (firstType == null || secondType == null) return
        const product = REACTIONS[firstType]?.[secondType]
        const outputType = this.mineralType
        if (product === undefined || product !== config.labReactionConfig || outputType != null && outputType !== product) return

        // Native runReaction checks room-wide RCL allocation even for empty/full labs.
        // Read live stores first; operated labs consume a larger batch of both reagents.
        let amount = LAB_REACTION_AMOUNT
        for (const effect of this.effects || []) {
            if (effect.effect === PWR_OPERATE_LAB && effect.ticksRemaining > 0 && 'level' in effect) {
                amount += POWER_INFO[PWR_OPERATE_LAB].effect[effect.level - 1]
                break
            }
        }
        const capacity = this.store.getFreeCapacity(product)
        if (lab1.store[firstType] < amount || lab2.store[secondType] < amount ||
            capacity === null || capacity < amount || config.reactionAmount !== undefined && config.reactionAmount < amount) return

        const result = this.runReaction(lab1, lab2)
        if (config.reactionAmount !== undefined && result === OK) config.reactionAmount -= amount
    }

    private labInJobExists(): boolean {
        let exists = false

        if (this.room.memory.roomFillJob.labInMineral != undefined) {
            this.room.memory.roomFillJob.labInMineral.forEach(labInJob => {
                if (labInJob.labId == this.id) {
                    exists = true
                    return
                }
            })
        }

        return exists
    }

    public init(): void {
        if (Game.time % structurePolicy.lab.jobInterval != 0) return
        if (this.room.memory.roomFillJob.labOut == undefined) this.room.memory.roomFillJob.labOut = []
        if (this.room.memory.roomFillJob.labInEnergy == undefined) this.room.memory.roomFillJob.labInEnergy = []
        if (this.room.memory.roomFillJob.labInMineral == undefined) this.room.memory.roomFillJob.labInMineral = []
        const energyJobs = this.room.memory.roomFillJob.labInEnergy
        deduplicateEnergyJobs(this.room, energyJobs)

        // 能量不够就请求能量
        if (this.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && !energyJobs.includes(this.id)) {
            energyJobs.push(this.id)
        }

        const labConfig = this.room.memory.roomLabConfig
        const thisLabConfig = labConfig.singleLabConfig[this.id]
        const boostMode = thisLabConfig != undefined && thisLabConfig.boostMode
        const labOutJob = this.room.memory.roomFillJob.labOut

        if (boostMode) {
            // 如果是boost模式，且boost配置的元素和当前元素不一致，就取出
            if (this.mineralType != undefined && thisLabConfig.resourceType != this.mineralType && !labOutJob.includes(this.id)) {
                this.room.memory.roomFillJob.labOut.push(this.id)
            }

            // 如果是boost模式，并且资源不足就补充
            if (this.store[thisLabConfig.resourceType] < this.room.memory.boostNeed[thisLabConfig.resourceType]) {
                const amount = this.room.getResource(thisLabConfig.resourceType, true, true, false, true)
                if (amount > 0 && !this.labInJobExists()) this.room.memory.roomFillJob.labInMineral.push({ labId: this.id, resourceType: thisLabConfig.resourceType })
            }
        } else {
            // 如果不是boost模式，并且不是sourceLab，那么超过1000，或者与当前配方不一致就取出
            if (this.id != labConfig.sourceLab1 && this.id != labConfig.sourceLab2 && this.mineralType != undefined && !labOutJob.includes(this.id)
                && (labConfig.labReactionConfig == undefined || this.mineralType != labConfig.labReactionConfig || this.store[this.mineralType] > structurePolicy.lab.outputMineralThreshold)) {
                this.room.memory.roomFillJob.labOut.push(this.id)
            }

            // 如果不是boost模式，并且是sourceLab，并且和配置类型不一致，那就取出
            if ((this.id == labConfig.sourceLab1 || this.id == labConfig.sourceLab2) && this.mineralType != undefined && !labOutJob.includes(this.id)) {
                const reactionConfig = labConfig.labReactionConfig && reactionSource[labConfig.labReactionConfig]
                if (reactionConfig == undefined ||
                    (this.id == labConfig.sourceLab1 && this.mineralType != reactionConfig[0]) ||
                    (this.id == labConfig.sourceLab2 && this.mineralType != reactionConfig[1])) {
                    this.room.memory.roomFillJob.labOut.push(this.id)
                }
            }

            // 如果有反应配置，则处理sourceLab
            if (labConfig.labReactionConfig != undefined) {
                const reactionConfig = reactionSource[labConfig.labReactionConfig]
                const desired = Math.min(3000, labConfig.reactionAmount ?? 3000)
                if (this.id == labConfig.sourceLab1) {
                    const amount1 = this.room.getResource(reactionConfig[0], true, true, true, true)
                    if (amount1 > 0 && (this.store[reactionConfig[0]] || 0) < desired &&
                        (this.mineralType == undefined || this.store.getFreeCapacity(this.mineralType) > structurePolicy.lab.sourceFreeCapacity) && !this.labInJobExists()) {
                        this.room.memory.roomFillJob.labInMineral.push({ labId: this.id, resourceType: reactionConfig[0] })
                    }
                }
                if (this.id == labConfig.sourceLab2) {
                    const amount2 = this.room.getResource(reactionConfig[1], true, true, true, true)
                    if (amount2 > 0 && (this.store[reactionConfig[1]] || 0) < desired &&
                        (this.mineralType == undefined || this.store.getFreeCapacity(this.mineralType) > structurePolicy.lab.sourceFreeCapacity) && !this.labInJobExists()) {
                        this.room.memory.roomFillJob.labInMineral.push({ labId: this.id, resourceType: reactionConfig[1] })
                    }
                }
            }
        }
    }

    public doWork(): void {
        const thisLabConfig = this.room.memory.roomLabConfig.singleLabConfig[this.id]
        if (thisLabConfig == undefined || !thisLabConfig.boostMode) {
            this.labReactionWork()
        }
    }
}
