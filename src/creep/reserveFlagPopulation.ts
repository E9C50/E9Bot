import type { addCreepConfig } from './demand'
import { bodyPolicy } from 'settings/bodyPolicy'
import { populationPolicy } from 'settings/population'
import { canBorrowDevelopmentReserver, isDevelopmentRemoteData } from './developmentRemotes'
import { reserveFlagSpawnAllowed, resolveReserveFlag } from './reserveFlags'

/** Stable flag slots permit early handoff without breeding a new unit when the flag moves. */
export function releaseReserveFlagConfigs(home: Room, publish: typeof addCreepConfig): void {
    const flags: Flag[] = []
    for (let i = 0; i < populationPolicy.maximumJobFlags; i++) {
        const flag = resolveReserveFlag(home, `${home.name}_RESERVE${i}`)
        if (flag) flags.push(flag)
    }
    if (!flags.length) return
    const workers = Object.values(Game.creeps).filter(creep => creep.memory.role === 'reserver' && creep.memory.spawnRoom === home.name)
    for (const flag of flags) {
        const targetRoom = flag.pos.roomName
        if (!reserveFlagSpawnAllowed(home, { targetRoom, reserveFlag: flag.name })) continue
        const maximumCost = bodyPolicy.economy.maximumReserverClaimParts * populationPolicy.remote.minimumReserveCapacity
        const parts = home.energyCapacityAvailable >= maximumCost ? 4 : 2
        const distance = Game.map.getRoomLinearDistance(home.name, targetRoom)
        const handoverTicks = Math.min(500, distance * 75 + 50 + parts * CREEP_SPAWN_TIME + 25)
        const assigned = workers.filter(creep => (creep.memory.data as ReserverData)?.reserveFlag === flag.name)
        const healthy = (creep: Creep): boolean => {
            const data = creep.memory.data as ReserverData & { developmentRemote?: unknown }
            if (data?.developmentRemote !== undefined &&
                (!isDevelopmentRemoteData(data) || !canBorrowDevelopmentReserver(creep, data))) return false
            return creep.spawning || (creep.ticksToLive || 0) > handoverTicks &&
                creep.getActiveBodyparts(CLAIM) > 0 && creep.getActiveBodyparts(MOVE) > 0
        }
        // A paid OUT/automatic reserver can finish its normal term before the flag's first successor.
        if (!assigned.length && workers.some(creep => !(creep.memory.data as ReserverData)?.reserveFlag &&
            (creep.memory.data as ReserverData)?.targetRoom === targetRoom && healthy(creep))) continue
        const occupied = new Set(assigned.map(creep => (creep.memory.data as ReserverData).reserveSlot || 0))
        const slots = new Set(occupied)
        if (!assigned.some(healthy)) {
            const free = ([0, 1] as const).find(slot => !occupied.has(slot))
            if (free !== undefined) slots.add(free)
        }
        for (const slot of slots) {
            const data: ReserverData = { targetRoom, reserveFlag: flag.name, reserveSlot: slot as 0 | 1 }
            const name = publish(home, 'reserver', `${home.name}_FLAG_RESERVER_${flag.name}_${slot}`, data)
            const config = home.memory.creepConfig[name]
            if (config) {
                config.spawnPriority = populationPolicy.remote.startupPriorities.reserver
                config.bodyProfile = { boostTier: 0, terrain: 'plain', maximumCost }
            }
            if (Game.creeps[name]) Game.creeps[name].memory.data = data
        }
    }
}
