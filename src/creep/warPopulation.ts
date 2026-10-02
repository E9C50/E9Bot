import { roleWarEnum } from 'settings/creep'
import { populationPolicy } from 'settings/population'
import { defenseGroups } from 'combat/defense'
import { addCreepConfig } from './demand'

/** Old flag catalogs must not silently keep respawning after switching to explicit combat missions. */
function removeLegacyFlagDemand(room: Room): void {
    const removed = new Set<string>()
    for (const [name, config] of Object.entries(room.memory.creepConfig)) {
        if ([`${room.name}_DIS_`, `${room.name}_T2`].some(prefix => config.name?.startsWith(prefix))) {
            delete room.memory.creepConfig[name]; removed.add(name)
        }
    }
    if (removed.size > 0) room.memory.creepSpawnQueue = room.memory.creepSpawnQueue.filter(name => !removed.has(name))
    for (const name of Object.keys(room.memory.teamConfig || {})) if (name.startsWith(`${room.name}_T2`)) delete room.memory.teamConfig[name]
}

/** Only flag-free room guards are published here; offensive units belong to explicit missions. */
export function releaseWarCreepConfig(): void {
    for (const room of Object.values(Game.rooms)) {
        if (!room.my) continue
        removeLegacyFlagDemand(room)
        // Peaceful population refreshes need no combat structure/friendly snapshot.
        const groups = room.controller?.safeMode || room.enemies.length === 0 ? [] : defenseGroups(room)
        const total = groups.reduce((sum, group) => sum + group.damage, 0)
        const desired = new Set<string>()
        if (total > populationPolicy.defense.minimumDamage || groups.some(group => group.claim > 0)) for (const group of groups) {
            const role = group.ranged > group.damage - group.ranged ? roleWarEnum.RDEFENDER : roleWarEnum.DEFENDER
            const data: DefenderData = { targetEnemy: group.target.id, groupKey: group.key }
            const name = addCreepConfig(room, role, `${room.name}_DEFENDER_${group.key}`, data)
            if (!name) continue
            desired.add(name)
            const creep = Game.creeps[name]
            if (creep != undefined) {
                const live = creep.memory.data as DefenderData
                live.targetEnemy = group.target.id; live.groupKey = group.key
            }
        }
        for (const [name, config] of Object.entries(room.memory.creepConfig)) {
            if (!config.name?.startsWith(`${room.name}_DEFENDER_`) || desired.has(name)) continue
            delete room.memory.creepConfig[name]
        }
        room.memory.creepSpawnQueue = room.memory.creepSpawnQueue.filter(name => room.memory.creepConfig[name] != undefined)
    }
}
