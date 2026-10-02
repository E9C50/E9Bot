/** Stable phases spread periodic room work without changing each room's frequency. */
export function roomWorkDue(roomName: string, interval: number, stagger = true): boolean {
    if (!Number.isSafeInteger(interval) || interval <= 0) return false
    if (!stagger) return Game.time % interval == 0
    let hash = 2166136261
    for (let index = 0; index < roomName.length; index++) hash = Math.imul(hash ^ roomName.charCodeAt(index), 16777619)
    return Game.time % interval == (hash >>> 0) % interval
}
