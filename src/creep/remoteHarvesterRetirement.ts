type RetiringRemoteHarvesterData = RemoteHarvesterData & {
    disabledMinerRetiring?: boolean
    developmentRemote?: unknown
}

/** A manual miner with no live WORK must yield its fixed birth slot and mining seat. */
export function retireDisabledRemoteHarvester(creep: Creep, data: RemoteHarvesterData): boolean {
    const task = data as RetiringRemoteHarvesterData
    if (creep.spawning || task.developmentRemote || typeof creep.getActiveBodyparts !== 'function') return false
    if (!task.disabledMinerRetiring && creep.getActiveBodyparts(WORK) > 0) return false
    task.disabledMinerRetiring = true
    creep.memory.ready = false; creep.memory.working = false; creep.memory.dontPullMe = false

    const homeRoom = creep.memory.spawnRoom || creep.room.name, home = Game.rooms?.[homeRoom]
    let spawn: StructureSpawn | undefined, nearest = Infinity
    for (const candidate of home?.spawns || []) {
        if (candidate.my === false) continue
        const distance = creep.pos.roomName === candidate.pos.roomName ?
            Math.max(Math.abs(creep.pos.x - candidate.pos.x), Math.abs(creep.pos.y - candidate.pos.y)) : Infinity
        if (spawn === undefined || distance < nearest) { spawn = candidate; nearest = distance }
    }
    if (spawn && creep.pos.isNearTo(spawn)) {
        // Recycling is permitted while this Spawn is already producing a successor.
        spawn.recycleCreep(creep)
    } else if (creep.getActiveBodyparts(MOVE) > 0) {
        if (spawn) creep.moveTo(spawn, { range: 1 })
        else if (creep.room.name !== homeRoom) creep.moveTo(new RoomPosition(25, 25, homeRoom), { range: 20 })
    }
    // Immobile remnants remain swappable/pullable instead of locking the Source tile.
    creep.memory.dontPullMe = false
    return true
}
