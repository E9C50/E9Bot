const ROOM_SIZE = 50
const ROOM_AREA = ROOM_SIZE * ROOM_SIZE
const TERRAIN_WALL_BIT = 1

export interface ExitPerimeterTerrain {
    get(x: number, y: number): number
}

export interface ExitPerimeterPolicy {
    enabled: boolean
    maximumExitTiles: number
    maximumRamparts: number
}

export interface ExitPerimeter {
    ramparts: [number, number][]
    /** Terrain reachable from an exit before crossing the first legal Rampart tile; y * 50 + x. */
    outside: Uint8Array
    exitCount: number
    exitSides: number
}

function isWall(terrain: ExitPerimeterTerrain, x: number, y: number): boolean {
    return (terrain.get(x, y) & TERRAIN_WALL_BIT) !== 0
}

/** Native Rampart terrain restrictions, including the three border tiles beside an exit. */
export function isRampartTerrainLegal(terrain: ExitPerimeterTerrain, x: number, y: number): boolean {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 1 || y < 1 || x > 48 || y > 48 || isWall(terrain, x, y)) return false
    for (let offset = -1; offset <= 1; offset++) {
        if ((x === 1 && !isWall(terrain, 0, y + offset)) ||
            (x === 48 && !isWall(terrain, 49, y + offset)) ||
            (y === 1 && !isWall(terrain, x + offset, 0)) ||
            (y === 48 && !isWall(terrain, x + offset, 49))) return false
    }
    return true
}

/**
 * Seal a single exit side, or a small number of exits, as close to the room edge as
 * Rampart construction permits. Eight-direction movement makes the frontier turn
 * back towards the border at open ends instead of extending across unused terrain.
 */
export function computeExitPerimeter(
    terrain: ExitPerimeterTerrain,
    policy: ExitPerimeterPolicy,
    checkBudget: () => void = () => {}
): ExitPerimeter | undefined {
    if (!policy.enabled || !Number.isInteger(policy.maximumExitTiles) || policy.maximumExitTiles < 0 ||
        !Number.isInteger(policy.maximumRamparts) || policy.maximumRamparts <= 0) return undefined
    checkBudget()
    // Cache terrain once: later geometric checks do not call the game API again.
    const walkable = new Uint8Array(ROOM_AREA)
    const masks = new Uint8Array(ROOM_AREA)
    let exitCount = 0
    const sides = [false, false, false, false]
    const queue: number[] = []
    const outside = new Uint8Array(ROOM_AREA)
    for (let y = 0; y < ROOM_SIZE; y++) {
        checkBudget()
        for (let x = 0; x < ROOM_SIZE; x++) {
            const index = y * ROOM_SIZE + x
            masks[index] = terrain.get(x, y)
            if ((masks[index] & TERRAIN_WALL_BIT) !== 0) continue
            walkable[index] = 1
            if (x !== 0 && y !== 0 && x !== 49 && y !== 49) continue
            if (y === 0) sides[0] = true
            if (x === 49) sides[1] = true
            if (y === 49) sides[2] = true
            if (x === 0) sides[3] = true
            exitCount++
            outside[index] = 1
            queue.push(index)
        }
    }
    const exitSides = sides.filter(Boolean).length
    if (exitCount === 0 || (exitSides > 1 && exitCount > policy.maximumExitTiles)) return undefined

    const cachedTerrain = { get: (x: number, y: number) => masks[y * ROOM_SIZE + x] }
    const legal = new Uint8Array(ROOM_AREA)
    for (let y = 1; y < 49; y++) {
        checkBudget()
        for (let x = 1; x < 49; x++) {
            if (isRampartTerrainLegal(cachedTerrain, x, y)) legal[y * ROOM_SIZE + x] = 1
        }
    }
    const frontier = new Uint8Array(ROOM_AREA)
    for (let cursor = 0; cursor < queue.length; cursor++) {
        if (cursor % 32 === 0) checkBudget()
        const index = queue[cursor], x = index % ROOM_SIZE, y = Math.floor(index / ROOM_SIZE)
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nextX = x + dx, nextY = y + dy
            if ((!dx && !dy) || nextX < 0 || nextX >= ROOM_SIZE || nextY < 0 || nextY >= ROOM_SIZE) continue
            const next = nextY * ROOM_SIZE + nextX
            if (!walkable[next]) continue
            if (legal[next]) {
                frontier[next] = 1
            } else if (!outside[next]) {
                outside[next] = 1
                queue.push(next)
            }
        }
    }
    const ramparts: [number, number][] = []
    for (let y = 1; y < 49; y++) {
        checkBudget()
        for (let x = 1; x < 49; x++) {
            if (frontier[y * ROOM_SIZE + x]) ramparts.push([x, y])
        }
        if (ramparts.length > policy.maximumRamparts) return undefined
    }
    if (ramparts.length === 0) return undefined

    // Verify the resulting barrier using the same diagonal movement available to
    // creeps. Any reachable legal tile means an unsealed end and rejects this cut.
    const reached = new Uint8Array(ROOM_AREA)
    const verificationQueue: number[] = []
    for (const index of queue) {
        if (index < ROOM_SIZE || index >= ROOM_AREA - ROOM_SIZE || index % ROOM_SIZE === 0 || index % ROOM_SIZE === 49) {
            reached[index] = 1
            verificationQueue.push(index)
        }
    }
    for (let cursor = 0; cursor < verificationQueue.length; cursor++) {
        if (cursor % 32 === 0) checkBudget()
        const index = verificationQueue[cursor], x = index % ROOM_SIZE, y = Math.floor(index / ROOM_SIZE)
        if (legal[index] || !outside[index]) return undefined
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nextX = x + dx, nextY = y + dy
            if ((!dx && !dy) || nextX < 0 || nextX >= ROOM_SIZE || nextY < 0 || nextY >= ROOM_SIZE) continue
            const next = nextY * ROOM_SIZE + nextX
            if (walkable[next] && !frontier[next] && !reached[next]) {
                reached[next] = 1
                verificationQueue.push(next)
            }
        }
    }
    checkBudget()
    return { ramparts, outside, exitCount, exitSides }
}
