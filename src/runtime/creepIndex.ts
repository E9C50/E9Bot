import { roleAdvEnum } from 'settings/creep'

let cachedTick: number | undefined
let cachedShard: string | undefined
let processorsByRoom = new Map<string, Creep[]>()
const emptyProcessors: readonly Creep[] = []

/**
 * Tick-local membership only, captured after arrival recovery and role assignment.
 * Callers still read current Store values; processer roles stay fixed during this tick.
 */
export function getRoomProcessors(roomName: string): readonly Creep[] {
    const tick = Game.time
    const shard = Game.shard.name
    if (tick !== cachedTick || shard !== cachedShard) {
        const current = new Map<string, Creep[]>()
        for (const name in Game.creeps) {
            const creep = Game.creeps[name]
            if (creep.memory.role !== roleAdvEnum.PROCESSER) continue
            const creepRoom = creep.room.name
            const processors = current.get(creepRoom)
            if (processors === undefined) current.set(creepRoom, [creep])
            else processors.push(creep)
        }
        processorsByRoom = current
        cachedTick = tick
        cachedShard = shard
    }
    return processorsByRoom.get(roomName) ?? emptyProcessors
}
