import './utils/BetterMove'
import './utils/RoomResource'

import { mountWork } from 'mount'
import { ErrorMapper } from './utils/ErrorMapper'
import { exportStats } from './utils/ExportStats'
import { roomController } from './module/RoomController'
import { powerSpawnController } from 'role/pc/PowerCreep'
import { visualController } from './module/VisualController'
import { obScannerController } from './module/ObserverController'
import { structureWorkController } from './module/StructureController'
import { creepNumberController, creepWorkController, teamWorkController } from './module/CreepController'
import { createTickRunner } from './runtime/TickRunner'
import { loadMemory } from './runtime/memory'
import { generatePixel, purchasePrivateServerEnergy, recordCpuHistory } from './runtime/maintenance'
import { runShardController } from './shard/controller'
import { flushInterShardMemory } from './shard/transport'
import { runCombatTasks } from './combat/missions'
import { runTargetDismantleControl } from './shard/targetDismantleControl'

mountWork()

export const loop = ErrorMapper.wrapLoop(createTickRunner([
    { name: 'memory', run: loadMemory },
    { name: 'shards', run: runShardController },
    { name: 'rooms', run: roomController },
    { name: 'combat', run: runCombatTasks },
    { name: 'population', run: creepNumberController },
    { name: 'targetDismantle', run: runTargetDismantleControl },
    { name: 'creeps', run: creepWorkController },
    { name: 'powerCreeps', run: powerSpawnController },
    { name: 'teams', run: teamWorkController },
    { name: 'structures', run: structureWorkController },
    { name: 'observers', run: obScannerController },
    { name: 'visuals', run: visualController },
    { name: 'stats', run: exportStats },
    { name: 'pixels', run: generatePixel },
    { name: 'privateMarket', run: purchasePrivateServerEnergy },
    { name: 'cpuHistory', run: recordCpuHistory },
    { name: 'shardFlush', run: flushInterShardMemory }
]))

console.log(`脚本初始化... Tick[${Game.time}] CPU[${Game.cpu.getUsed().toFixed(4)}] Bucket[${Game.cpu.bucket}]`)
