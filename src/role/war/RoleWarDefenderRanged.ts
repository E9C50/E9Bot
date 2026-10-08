import { runDefender } from 'combat/defense'
import { isRemoteInvaderGuardData, prepareRemoteInvaderGuard, runRemoteInvaderGuard } from 'creep/remoteInvaderDefense'

export default (data: CreepData): ICreepConfig => ({
    isNeed: () => true,
    prepare: creep => isRemoteInvaderGuardData(data) ? prepareRemoteInvaderGuard(creep, data) : creep.goBoost(),
    source: creep => {
        if (isRemoteInvaderGuardData(data)) return runRemoteInvaderGuard(creep, data)
        creep.memory.working = true; return true
    },
    target: creep => isRemoteInvaderGuardData(data) ? runRemoteInvaderGuard(creep, data) : runDefender(creep, data, true),
})
