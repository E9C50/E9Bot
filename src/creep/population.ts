import { populationPolicy } from 'settings/population'
import { releaseBaseCreepConfig } from './basePopulation'
import { releaseJobsCreepConfig } from './remotePopulation'
import { releaseWarCreepConfig } from './warPopulation'
import { buildSpawnQueue, orderCreepSpawnQueue } from './spawnQueue'
import { releaseShardCreepConfig } from 'shard/controller'
import { releaseDevelopmentRemoteConfigs } from './developmentRemotes'
import { addCreepConfig } from './demand'
import { releaseCombatCreepConfigs } from 'combat/missions'
import { isRoomEvacuating } from 'room/evacuationState'
import { releaseRoomEvacuationConfigs } from 'room/evacuation'
import { releaseRemoteInvaderDefenseConfigs } from './remoteInvaderDefense'
import { releaseRemoteRoadConfigs } from './remoteRoads'

export function creepNumberController(): void {
    if (!Memory.creeps) Memory.creeps = {}
    for (const name in Memory.creeps) {
        if (!Game.creeps[name]) delete Memory.creeps[name]
    }
    if (Game.time % populationPolicy.refreshInterval !== 0) {
        releaseRemoteInvaderDefenseConfigs(addCreepConfig, buildSpawnQueue)
        return
    }
    for (const room of Object.values(Game.rooms)) {
        if (room.my) room.memory.creepConfig = {}
    }
    releaseBaseCreepConfig()
    releaseJobsCreepConfig()
    releaseDevelopmentRemoteConfigs(addCreepConfig)
    releaseRemoteRoadConfigs(addCreepConfig)
    releaseShardCreepConfig()
    releaseWarCreepConfig()
    releaseCombatCreepConfigs()
    releaseRemoteInvaderDefenseConfigs(addCreepConfig, buildSpawnQueue)
    for (const room of Object.values(Game.rooms)) {
        if (!room.my || !isRoomEvacuating(room)) continue
        // Tasks retain their own state; only new births from the closing room are suspended.
        for (const name in room.memory.creepConfig) {
            const config = room.memory.creepConfig[name]
            if (config.role !== 'defender' && config.role !== 'rdefender' &&
                !(config.role === 'filler' && (config.data as FillerData).evacuationRoom === room.name)) {
                delete room.memory.creepConfig[name]
            }
        }
        releaseRoomEvacuationConfigs(room, addCreepConfig)
    }
    orderCreepSpawnQueue()
}
