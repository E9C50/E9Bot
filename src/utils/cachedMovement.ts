export interface CachedMovementPath {
    dst: { x: number; y: number; roomName: string }
    idx: number
    path?: { posArray: Array<{ x: number; y: number; roomName: string }>; ignoreStructures?: boolean }
}
export interface CachedMovementStep { x: number; y: number; roomName: string; index: number }

/** Predict only a recently submitted route anchored at the creep's real current position. */
export function nextCachedMovementStep(position: { x: number; y: number; roomName: string }, cache: CachedMovementPath | undefined,
    movedAt: number | undefined, now: number): CachedMovementStep | undefined {
    if (movedAt !== now - 1 || !cache?.path || !Number.isInteger(cache.idx)) return undefined
    const path = cache.path.posArray, idx = cache.idx
    const equal = (other: typeof position | undefined): boolean => other !== undefined && other.roomName === position.roomName &&
        other.x === position.x && other.y === position.y
    let next: number
    if (equal(path[idx])) next = idx + 1
    else if (equal(path[idx - 1])) next = idx // The last intent was blocked; retry its actual adjacent step.
    else if (equal(path[idx + 1])) next = idx + 2 // Native room-edge movement advanced another cell.
    else return undefined
    const step = path[next]
    if (!step || step.roomName !== position.roomName || step.x < 0 || step.x > 49 || step.y < 0 || step.y > 49 ||
        Math.max(Math.abs(step.x - position.x), Math.abs(step.y - position.y)) !== 1) return undefined
    // Native RoomPosition coordinates are prototype accessors, not enumerable own fields.
    return { x: step.x, y: step.y, roomName: step.roomName, index: next }
}
