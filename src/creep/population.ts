import { populationPolicy } from 'settings/population'
import { releaseBaseCreepConfig } from './basePopulation'
import { releaseJobsCreepConfig } from './remotePopulation'
import { releaseWarCreepConfig } from './warPopulation'
import { orderCreepSpawnQueue } from './spawnQueue'
import { releaseShardCreepConfig } from 'shard/controller'
import { releaseDevelopmentRemoteConfigs } from './developmentRemotes'
import { addCreepConfig } from './demand'
import { releaseCombatCreepConfigs } from 'combat/missions'

export function creepNumberController(): void {
    if (!Memory.creeps) Memory.creeps = {}
    for (const name in Memory.creeps) {
        if (!Game.creeps[name]) delete Memory.creeps[name]
    }
    if (Game.time % populationPolicy.refreshInterval !== 0) return
    for (const room of Object.values(Game.rooms)) {
        if (room.my) room.memory.creepConfig = {}
    }
    releaseBaseCreepConfig()
    releaseJobsCreepConfig()
    releaseDevelopmentRemoteConfigs(addCreepConfig)
    releaseShardCreepConfig()
    releaseWarCreepConfig()
    releaseCombatCreepConfigs()
    orderCreepSpawnQueue()
}
