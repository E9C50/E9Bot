export interface ResourceAccessPosition { x: number; y: number }

export interface ResourceAccessWeights {
    source: number
    controller: number
    mineral: number
}

export interface ResourceAccessPoint {
    pos: ResourceAccessPosition
    kind: keyof ResourceAccessWeights
}

export const defaultResourceAccessWeights: ResourceAccessWeights = { source: 3, controller: 2, mineral: 0.5 }

/**
 * Minimum eight-direction walking distance to each resource's adjacent working tiles.
 * Each resource is flooded once, so comparing base anchors does not invoke PathFinder.
 * Native resource/controller tiles are obstacles, and borders are excluded to keep routes in this room.
 */
export function resourceAccessScores(terrain: { get(x: number, y: number): number },
    points: ReadonlyArray<ResourceAccessPoint>, weights: Partial<ResourceAccessWeights> = {},
    checkBudget: () => void = () => undefined): Float64Array {
    const scores = new Float64Array(2500)
    const walkable = new Uint8Array(2500)
    const queue = new Int16Array(2500)
    const resolvedWeights = { ...defaultResourceAccessWeights, ...weights }
    checkBudget()
    for (let x = 1; x < 49; x++) {
        checkBudget()
        for (let y = 1; y < 49; y++) {
            if (!(terrain.get(x, y) & TERRAIN_MASK_WALL)) walkable[x * 50 + y] = 1
        }
    }
    for (const point of points) walkable[point.pos.x * 50 + point.pos.y] = 0
    for (const point of points) {
        checkBudget()
        const distances = new Int16Array(2500).fill(-1)
        let head = 0, tail = 0
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            const x = point.pos.x + dx, y = point.pos.y + dy
            if (!(dx || dy) || x < 1 || y < 1 || x > 48 || y > 48) continue
            const index = x * 50 + y
            if (walkable[index] && distances[index] < 0) {
                distances[index] = 0
                queue[tail++] = index
            }
        }
        while (head < tail) {
            if (head % 128 === 0) checkBudget()
            const index = queue[head++]
            const x = Math.floor(index / 50), y = index % 50
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
                const nx = x + dx, ny = y + dy
                if (!(dx || dy) || nx < 1 || ny < 1 || nx > 48 || ny > 48) continue
                const neighbor = nx * 50 + ny
                if (!walkable[neighbor] || distances[neighbor] >= 0) continue
                distances[neighbor] = distances[index] + 1
                queue[tail++] = neighbor
            }
        }
        const weight = resolvedWeights[point.kind]
        for (let index = 0; index < 2500; index++) {
            if (index % 256 === 0) checkBudget()
            // A zero weight removes the distance penalty, never the required resource connection.
            scores[index] = distances[index] < 0 ? Infinity : scores[index] + distances[index] * weight
        }
    }
    checkBudget()
    return scores
}
