/** 每个 Observer 每 tick 只提交一次成功意图，避免后调用者覆盖 next-tick 视野。 */
let reservationTick: number | undefined
let reservationShard: string | undefined
const reservations = new Map<string, { roomName: string; owner: 'portal' | 'path' | 'combat' }>()

export function scheduleObservation(observer: StructureObserver, roomName: string, owner: 'portal' | 'path' | 'combat'): ScreepsReturnCode | undefined {
    if (reservationTick !== Game.time || reservationShard !== Game.shard.name) {
        reservations.clear()
        reservationTick = Game.time
        reservationShard = Game.shard.name
    }
    if (reservations.has(observer.id)) return undefined
    const result = observer.observeRoom(roomName)
    if (result === OK) reservations.set(observer.id, { roomName, owner })
    return result
}
