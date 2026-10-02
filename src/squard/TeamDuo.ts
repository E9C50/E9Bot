import { returnCombatUnit } from 'combat/support'

export default (data: TeamConfig): ITeamConfig => ({
    prepare() {
        const limit = data.teamType === 'quad' ? 4 : 2
        const members = data.creepNameList.slice(0, limit).map(name => Game.creeps[name]).filter(Boolean)
        let ready = members.length > 0
        for (const creep of members) if (!creep.goBoost()) ready = false
        return ready
    },
    doWork() {
        const limit = data.teamType === 'quad' ? 4 : 2
        const members = data.creepNameList.slice(0, limit).map(name => Game.creeps[name]).filter(creep => creep && !creep.spawning)
        if (data.targetRoom && data.taskId && Memory.combatTasks?.[data.taskId]) return true
        // The central mission controller owns tactics; obsolete flag teams withdraw.
        for (const creep of members) returnCombatUnit(creep, creep.memory.spawnRoom)
        return members.length > 0
    },
})
