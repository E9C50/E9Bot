import { interShardPolicy } from 'settings/interShard'
import { flushInterShardMemory, getShardTransportError, publishCreepTransfer } from './transport'
import { isPortalTravelData, PortalTravelData, PortalTravelResult } from './types'
import { scoutMovementOptions } from './scoutMovement'

/** 显式多跳行程。跨入之前持久化迁移信封，并留出至少一个出发 shard tick。 */
export function travelPortalRoute(creep: Creep, data: PortalTravelData): PortalTravelResult {
    if (!isPortalTravelData(data)) return { status: 'error', message: 'Invalid portal route' }
    if (data.hopIndex === data.route.length) {
        const destination = data.route.length ? data.route[data.route.length - 1].destinationShard : data.originShard
        return Game.shard.name === destination ? { status: 'arrived' } : { status: 'error', message: 'Route ended on an unexpected shard' }
    }
    const hop = data.route[data.hopIndex]
    if (hop.shard !== Game.shard.name) return { status: 'waiting', message: 'Waiting for the expected shard or arrival memory' }
    if (hop.destinationShard === hop.shard) return { status: 'error', message: 'Same-shard portals are not part of this transport route' }
    if (!interShardPolicy.enabled || !interShardPolicy.allowedRoles.includes(creep.memory.role))
        return { status: 'waiting', message: 'Inter-shard mission transport is disabled for this role' }
    const position = new RoomPosition(hop.x, hop.y, hop.roomName)
    const room = Game.rooms[hop.roomName]
    if (room !== undefined) {
        const portal = room.lookForAt(LOOK_STRUCTURES, hop.x, hop.y).find(structure => structure.structureType === STRUCTURE_PORTAL) as StructurePortal | undefined
        if (portal === undefined) return { status: 'waiting', reason: 'portal-missing', message: 'The configured portal is not present' }
        const destination = portal.destination
        if (!('shard' in destination) || destination.shard !== hop.destinationShard ||
            (hop.destinationRoom !== undefined && destination.room !== hop.destinationRoom))
            return { status: 'error', reason: 'portal-destination', message: 'The configured portal has a different destination' }
    }
    // 无视野时可以前往入口房间，但尚未校验/发布前不允许踏进入口。
    const adjacent = creep.pos.roomName === hop.roomName && creep.pos.getRangeTo(position) <= 1
    if (adjacent) {
        if (room === undefined) return { status: 'waiting', message: 'Portal room vision is required before crossing' }
        if (!publishCreepTransfer(creep, hop.destinationShard, data.hopIndex + 1) || !flushInterShardMemory())
            return { status: 'waiting', message: getShardTransportError() || 'Could not persist transfer memory' }
        if (data.transferPreparedShard !== Game.shard.name || data.transferPreparedHop !== data.hopIndex || data.transferPreparedAt === undefined) {
            data.transferPreparedShard = Game.shard.name
            data.transferPreparedHop = data.hopIndex
            data.transferPreparedAt = Game.time
            return { status: 'waiting', message: 'Transfer published; waiting one source tick before crossing' }
        }
        if (Game.time <= data.transferPreparedAt) return { status: 'waiting', message: 'Transfer publication is pending propagation' }
    }
    // 入口格必须 range:0，否则默认 range:1 会永远停在 Portal 旁边。
    const code = creep.moveTo(position, creep.memory.role === 'sScout' ? { ...scoutMovementOptions, range: 0 } : { range: 0 })
    if (code === ERR_NO_PATH) return { status: 'waiting', reason: 'no-path', message: 'No path to the configured portal' }
    if (code !== OK && code !== ERR_TIRED) return { status: 'error', message: `Portal movement failed: ${code}` }
    return { status: 'moving' }
}
