import { interShardPolicy } from 'settings/interShard'
import { isShardUnitData, ShardUnitData } from './missions'
import { scoutMovementOptions } from './scoutMovement'
import { moveScoutAwayFromThreat } from './scoutSafety'

function settled(data: CreepData): data is ShardUnitData {
    return isShardUnitData(data) && data.unitKind === 'scout' && data.done === true &&
        data.exploration?.reportPending !== true && data.scouting?.proofPending === undefined
}

function clearBorder(creep: Creep): void {
    if (creep.pos.x === 0 || creep.pos.x === 49 || creep.pos.y === 0 || creep.pos.y === 49)
        creep.moveTo(new RoomPosition(25, 25, creep.room.name), { ...scoutMovementOptions, range: 20 })
}

/** 已退休单位不再执行旧路线；当前失败租约保留给控制器冷却后原位复用。 */
function retire(creep: Creep, data: ShardUnitData): void {
    const mission = Game.shard.name === data.task.sourceShard ? Memory.shardMissions?.[data.missionId] : undefined
    if (data.exploration !== undefined && mission?.state === 'active' && mission.exploration?.status === 'failed' &&
        mission.leases['explorer:0']?.name === creep.name && creep.hits === creep.hitsMax &&
        (creep.ticksToLive ?? 0) > interShardPolicy.portalExploration.minimumRemainingTicks + interShardPolicy.portalExploration.roomTimeout) {
        if (!moveScoutAwayFromThreat(creep)) clearBorder(creep)
        return
    }
    const spawns = Object.values(Game.spawns || {}).filter(spawn => spawn.my)
    const spawn = spawns.find(value => value.room.name === creep.room.name) ||
        (Game.shard.name === data.task.sourceShard ? spawns.find(value => value.room.name === data.task.sourceRoom) : undefined) ||
        spawns.reduce<StructureSpawn | undefined>((nearest, value) => nearest === undefined ||
            Game.map.getRoomLinearDistance(creep.room.name, value.room.name) < Game.map.getRoomLinearDistance(creep.room.name, nearest.room.name) ? value : nearest, undefined)
    if (spawn === undefined) { if (!moveScoutAwayFromThreat(creep)) clearBorder(creep); return }
    if (creep.room.name !== spawn.room.name || creep.pos.getRangeTo(spawn) > 1)
        creep.moveTo(spawn, { ...scoutMovementOptions, range: 1 })
    else spawn.recycleCreep(creep)
}

/** prepare 里处理退役，保留旧角色的 prepare=false 契约及待发送报告的重试行为。 */
export function withScoutRetirement(data: CreepData, role: ICreepConfig): ICreepConfig {
    return {
        ...role,
        prepare(creep) {
            if (!creep.spawning && creep.memory.role === 'sScout' && settled(data)) { retire(creep, data); return false }
            return role.prepare(creep)
        },
        source(creep) {
            if (settled(data)) { retire(creep, data); return false }
            return role.source(creep)
        },
        target(creep) {
            if (settled(data)) { retire(creep, data); return false }
            return role.target(creep)
        },
    }
}
