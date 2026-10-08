import { isDevelopingRoom } from './development'
import { developmentRemotePolicy } from 'settings/developmentRemotes'
import { hasSourceLinkTransport, sourceLinkWithCenter } from 'room/sourceLinks'

function range(first: RoomPosition, second: RoomPosition): number {
    return first.roomName === second.roomName ? Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y)) : Infinity
}

/** Remote births follow a working local Source and its transport, not a full population template. */
export function hasRemoteHomeEconomy(home: Room, creeps: { [name: string]: Creep } = Game.creeps): boolean {
    // Mature rooms and rooms opting out of development retain their manual OUT behavior.
    if (!isDevelopingRoom(home)) return true
    if (home.energyCapacityAvailable < developmentRemotePolicy.minimumMiningCapacity) return false
    const local = Object.values(creeps).filter(creep => !creep.spawning &&
        creep.memory.spawnRoom === home.name && creep.room.name === home.name)
    const carriers = local.filter(creep => creep.memory.role === 'filler' &&
        creep.getActiveBodyparts(CARRY) > 0 && creep.getActiveBodyparts(MOVE) > 0 &&
        !(creep.memory.boostPlan?.steps.length && !creep.memory.boostPlan.completed && !creep.memory.boostPlan.failed))
    if (carriers.length === 0) return false
    for (const miner of local) {
        if (miner.memory.role !== 'harvester' || miner.getActiveBodyparts(WORK) <= 0 ||
            miner.memory.boostPlan?.steps.length && !miner.memory.boostPlan.completed && !miner.memory.boostPlan.failed) continue
        const source = home.sources.find(source => source.id === (miner.memory.data as HarvesterData).sourceId)
        if (!source || range(miner.pos, source.pos) > 1) continue
        const containers = home.containers.filter(container => range(source.pos, container.pos) <= 1)
        for (const carrier of carriers) {
            const data = carrier.memory.data as FillerData
            const mineId = data.mineId || carrier.memory.developmentHauler?.mineId
            if (mineId ? mineId === source.id : data.sourceId === source.id ||
                containers.some(container => container.id === data.sourceId)) return true
            if (mineId || !home.storage || data.sourceId !== home.storage.id || !home.links.length ||
                miner.getActiveBodyparts(CARRY) <= 0 || !hasSourceLinkTransport(home, source)) continue
            const origin = sourceLinkWithCenter(home, source)
            if (origin && range(miner.pos, origin.pos) <= 1) return true
        }
    }
    return false
}
