import { isDevelopingRoom } from './development'
import { developmentPolicy } from 'settings/development'

export function developmentReplacementDeadline(config: CreepMemory): number | undefined {
    const deadline = config.development?.replacement?.deadline
    return Number.isFinite(deadline) ? deadline : undefined
}

/** Missing local production and published handovers keep their birth before optional hub work. */
export function prioritizeDevelopmentRecovery(room: Room, queue: string[],
    creeps: { [name: string]: Creep } = Game.creeps): string[] {
    if (!isDevelopingRoom(room)) return queue
    const configs = room.memory.creepConfig || {}
    const recovery = queue.filter(name => {
        const config = configs[name]
        if (!config?.development || config.spawnRoom !== room.name) return false
        return developmentReplacementDeadline(config) !== undefined ||
            config.role === 'harvester' && config.spawnPriority < developmentPolicy.mining.expansionPriority
    })
    if (recovery.length === 0) return queue
    // Once one mine is committed, preserve its expiring workers before spending
    // another full birth on the empty Source. A room with no mine still needs one first.
    const hasLocalMiner = recovery.some(name => developmentReplacementDeadline(configs[name]) !== undefined) &&
        Object.values(creeps).some(creep => {
            const memory = creep.memory
            if (memory.role !== 'harvester' || creep.room.name !== room.name ||
                memory.spawnRoom && memory.spawnRoom !== room.name || creep.ticksToLive === 0 ||
                memory.boostPlan?.steps.length && !memory.boostPlan.completed && !memory.boostPlan.failed ||
                !(room.sources || []).some(source => source.id === (memory.data as HarvesterData).sourceId)) return false
            return creep.spawning || creep.getActiveBodyparts('work') > 0 && creep.getActiveBodyparts('move') > 0
        })
    const deadline = (name: string): number => developmentReplacementDeadline(configs[name]) ??
        (hasLocalMiner ? Infinity : 0)
    recovery.sort((first, second) => deadline(first) - deadline(second))
    const names = new Set(recovery)
    return [...recovery, ...queue.filter(name => !names.has(name))]
}

