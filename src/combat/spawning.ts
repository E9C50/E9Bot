import { combatPolicy } from 'settings/combat'
import type { BodyPlan } from 'creep/bodyPlanner'

/** Recheck a queued command at the irreversible native spawn boundary. */
export function combatSpawnAllowed(config: CreepMemory, plan?: BodyPlan): boolean {
    if (!config.combatTaskId) return true
    const task = Memory.combatTasks?.[config.combatTaskId]
    if (!task || task.shard !== Game.shard.name || config.combatGeneration !== task.generation ||
        task.deadline !== undefined && Game.time >= task.deadline) return false
    if (task.mode === 'attack' && Memory.warMode?.[task.homeRoom]) return false
    const phase = config.combatJob === 'fighter' ? ['spawning', 'combat'] :
        config.combatJob === 'scout' ? ['recon'] : config.combatJob === 'controller' ? ['controller'] : ['loot']
    if (!phase.includes(task.phase) || Math.max(task.intel?.safeModeUntil || 0, task.intel?.protectedUntil || 0) > Game.time) return false
    if (plan) {
        const energy = plan.body.reduce((total, part) => total + BODYPART_COST[part], 0)
        if (task.spent + energy > (task.options.maxEnergy || combatPolicy.maximumTaskEnergy)) {
            task.phase = 'returning'; task.reason = '达到任务实际孵化能量上限'; task.endedAt = Game.time
            return false
        }
    }
    return true
}

export function recordCombatSpawn(config: CreepMemory, plan: BodyPlan): void {
    const task = config.combatTaskId ? Memory.combatTasks?.[config.combatTaskId] : undefined
    if (task) task.spent += plan.body.reduce((total, part) => total + BODYPART_COST[part], 0)
}
