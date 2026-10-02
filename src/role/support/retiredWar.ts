import { returnCombatUnit } from 'combat/support'

/** Offensive work is exclusively owned by combat missions; obsolete flag units retire safely. */
export function retiredWarRole(_data: CreepData): ICreepConfig {
    return {
        isNeed: () => false,
        prepare: () => true,
        source(creep) { creep.memory.working = true; returnCombatUnit(creep, creep.memory.spawnRoom); return true },
        target(creep) { returnCombatUnit(creep, creep.memory.spawnRoom); return true },
    }
}
