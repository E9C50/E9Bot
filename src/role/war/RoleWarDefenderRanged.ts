import { runDefender } from 'combat/defense'

export default (data: CreepData): ICreepConfig => ({
    isNeed: () => true,
    prepare: creep => creep.goBoost(),
    source: creep => { creep.memory.working = true; return true },
    target: creep => runDefender(creep, data, true),
})
