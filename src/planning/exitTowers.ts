import { ExitPerimeter, ExitPerimeterTerrain, isRampartTerrainLegal } from './exitPerimeter'
import { BlueprintPosition, BlueprintStructures } from './types'

const SIZE = 50
const AREA = SIZE * SIZE
const MAX_TOWERS = 6
const RANGED_ATTACK_RANGE = 3
const TOWER_SPACING = 3

export interface ExitTowerOptions {
    /** Enemy ranged attacks ignore terrain walls, so this is a geometric range. */
    minimumEnemyRange?: number
    towerCount?: number
    /** Built towers or construction sites with invested progress are kept in place. */
    fixedTowers?: BlueprintPosition[]
}

export interface ExitTowerPlan {
    towers: BlueprintPosition[]
    /** Existing roads followed by supply roads for the relocated towers. */
    roads: BlueprintPosition[]
}

/** Unmodified Screeps tower attack, before energy use or power effects. */
export function towerAttackPowerAtRange(range: number): number {
    return 600 - 30 * Math.max(0, Math.min(15, range - 5))
}

function indexOf(position: BlueprintPosition): number {
    return position[1] * SIZE + position[0]
}

function positionOf(index: number): BlueprintPosition {
    return [index % SIZE, Math.floor(index / SIZE)]
}

function validPosition(position: BlueprintPosition): boolean {
    return Array.isArray(position) && position.length === 2 && position.every(value =>
        Number.isInteger(value) && value >= 0 && value < SIZE)
}

function range(a: number, b: number): number {
    return Math.max(Math.abs(a % SIZE - b % SIZE),
        Math.abs(Math.floor(a / SIZE) - Math.floor(b / SIZE)))
}

function forNeighbors(index: number, visit: (next: number) => void): void {
    const x = index % SIZE, y = Math.floor(index / SIZE)
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy
        if ((dx || dy) && nx > 0 && nx < 49 && ny > 0 && ny < 49) visit(ny * SIZE + nx)
    }
}

/**
 * Move towers towards a sealed exit while leaving four tiles of range between
 * every new tower and every hostile standing tile. Coverage is balanced over
 * the complete entrance, including diagonal corners, rather than over its
 * bounding box. Supply paths stay behind the barrier and join existing roads.
 * A rejected plan never changes the supplied blueprint.
 */
export function planExitTowers(
    terrain: ExitPerimeterTerrain,
    perimeter: Pick<ExitPerimeter, 'ramparts' | 'outside'>,
    structures: BlueprintStructures,
    nativePoints: BlueprintPosition[],
    options: ExitTowerOptions = {},
    checkBudget: () => void = () => {}
): ExitTowerPlan | undefined {
    checkBudget()
    const minimumEnemyRange = options.minimumEnemyRange === undefined ? 4 : options.minimumEnemyRange
    const towerCount = options.towerCount === undefined ? MAX_TOWERS : options.towerCount
    if (!Number.isInteger(minimumEnemyRange) || minimumEnemyRange <= RANGED_ATTACK_RANGE || minimumEnemyRange >= SIZE ||
        !Number.isInteger(towerCount) || towerCount < 1 || towerCount > MAX_TOWERS ||
        !perimeter || perimeter.outside.length !== AREA || !perimeter.ramparts.length) return undefined

    const terrainMask = new Uint8Array(AREA)
    const blocked = new Uint8Array(AREA)
    const occupied = new Uint8Array(AREA)
    const nonRampartOccupied = new Uint8Array(AREA)
    const roadMask = new Uint8Array(AREA)
    const roads: BlueprintPosition[] = []
    const targets: number[] = []
    const enemyRange = new Uint8Array(AREA).fill(255)
    const dangerQueue: number[] = []
    for (let y = 0; y < SIZE; y++) {
        checkBudget()
        for (let x = 0; x < SIZE; x++) {
            const index = y * SIZE + x
            terrainMask[index] = terrain.get(x, y)
            if ((terrainMask[index] & 1) || x === 0 || y === 0 || x === 49 || y === 49 || perimeter.outside[index]) blocked[index] = 1
            if (perimeter.outside[index]) {
                // This distance flood deliberately crosses natural walls: ranged
                // creeps can shoot through them, as can towers.
                enemyRange[index] = 0
                dangerQueue.push(index)
                targets.push(index)
            }
        }
    }
    if (!targets.length) return undefined
    for (let cursor = 0; cursor < dangerQueue.length; cursor++) {
        if (cursor % 64 === 0) checkBudget()
        const index = dangerQueue[cursor], x = index % SIZE, y = Math.floor(index / SIZE)
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy
            if ((!dx && !dy) || nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) continue
            const next = ny * SIZE + nx
            if (enemyRange[next] > enemyRange[index] + 1) {
                enemyRange[next] = enemyRange[index] + 1
                dangerQueue.push(next)
            }
        }
    }
    for (const position of nativePoints) {
        if (!validPosition(position)) return undefined
        blocked[indexOf(position)] = occupied[indexOf(position)] = nonRampartOccupied[indexOf(position)] = 1
    }
    for (const [type, positions] of Object.entries(structures)) {
        for (const position of positions || []) {
            if (!validPosition(position)) return undefined
            const index = indexOf(position)
            if (type === 'tower') continue // Release only the old tower slots.
            occupied[index] = 1
            if (type === 'rampart') continue // Friendly covering Ramparts remain walkable.
            nonRampartOccupied[index] = 1
            if (type === 'road') {
                if (!roadMask[index]) roads.push([position[0], position[1]])
                roadMask[index] = 1
            } else if (type !== 'container') blocked[index] = 1
        }
    }
    for (const position of perimeter.ramparts) {
        if (!validPosition(position)) return undefined
        blocked[indexOf(position)] = occupied[indexOf(position)] = 1
    }
    const cachedTerrain = { get: (x: number, y: number) => terrainMask[y * SIZE + x] }
    const towers: BlueprintPosition[] = []
    const selected: number[] = []
    for (const position of options.fixedTowers || []) {
        if (!validPosition(position) || !isRampartTerrainLegal(cachedTerrain, ...position)) return undefined
        const index = indexOf(position)
        if (selected.indexOf(index) >= 0) continue
        if (nonRampartOccupied[index] || blocked[index]) return undefined
        towers.push([position[0], position[1]])
        selected.push(index)
        occupied[index] = blocked[index] = 1
    }
    if (towers.length > towerCount) return undefined

    // Terrain-legal safe cells are considered even when terrain pushes one part
    // of an entrance further inward than another. Depth is rewarded by the
    // actual attack range, rather than a room-side-specific coordinate rule.
    const candidates: number[] = []
    for (let y = 1; y < 49; y++) {
        checkBudget()
        for (let x = 1; x < 49; x++) {
            const index = y * SIZE + x
            if (!blocked[index] && !occupied[index] && enemyRange[index] >= minimumEnemyRange &&
                isRampartTerrainLegal(cachedTerrain, x, y)) candidates.push(index)
        }
    }
    if (candidates.length < towerCount - towers.length) return undefined

    const candidateNumberAt = new Int16Array(AREA).fill(-1)
    const firingRanges = new Uint8Array(candidates.length * targets.length)
    const attackPowers = new Uint16Array(candidates.length * targets.length)
    for (let number = 0; number < candidates.length; number++) {
        if (number % 32 === 0) checkBudget()
        candidateNumberAt[candidates[number]] = number
        for (let i = 0; i < targets.length; i++) {
            const distance = range(candidates[number], targets[i]), entry = number * targets.length + i
            firingRanges[entry] = distance
            attackPowers[entry] = towerAttackPowerAtRange(distance)
        }
    }

    function targetRange(index: number, targetNumber: number): number {
        const number = candidateNumberAt[index]
        return number >= 0 ? firingRanges[number * targets.length + targetNumber] : range(index, targets[targetNumber])
    }

    function targetPower(index: number, targetNumber: number): number {
        const number = candidateNumberAt[index]
        return number >= 0 ? attackPowers[number * targets.length + targetNumber] : towerAttackPowerAtRange(range(index, targets[targetNumber]))
    }

    const closest = new Uint8Array(targets.length).fill(SIZE)
    const firepower = new Float64Array(targets.length)
    function addCoverage(index: number): void {
        for (let i = 0; i < targets.length; i++) {
            const distance = targetRange(index, i)
            closest[i] = Math.min(closest[i], distance)
            firepower[i] += targetPower(index, i)
        }
    }
    for (const index of selected) addCoverage(index)

    function scorePlacement(index: number, maximizeWeakest = true): number {
        let nearestSquares = 0, worstRange = 0, totalPower = 0, lowestPower = Infinity
        for (let i = 0; i < targets.length; i++) {
            const distance = targetRange(index, i)
            const nearest = Math.min(closest[i], distance)
            nearestSquares += nearest * nearest
            worstRange = Math.max(worstRange, nearest)
            const power = firepower[i] + targetPower(index, i)
            totalPower += power
            lowestPower = Math.min(lowestPower, power)
        }
        // Firepower changes in 30-point steps. The leading term makes a stronger
        // weakest enemy tile dominate all coverage tie breakers. Spacing prevents
        // six adjacent towers from exploiting the same firing position.
        return (maximizeWeakest ? -lowestPower * 1000 : -lowestPower / 600 * 0.25) +
            nearestSquares / targets.length + worstRange * worstRange * 0.5 - totalPower / (targets.length * 600) * 0.25
    }

    function hasSpacing(index: number, ignored = -1): boolean {
        return selected.every((tower, number) => number === ignored || range(index, tower) >= TOWER_SPACING)
    }

    function supplyDistances(): { distance: Int16Array; previous: Int16Array } | undefined {
        const distance = new Int16Array(AREA).fill(-1)
        const previous = new Int16Array(AREA).fill(-1)
        const queue: number[] = []
        for (const position of roads) {
            const index = indexOf(position)
            if (blocked[index]) continue
            distance[index] = 0
            queue.push(index)
        }
        if (!queue.length) return undefined
        for (let cursor = 0; cursor < queue.length; cursor++) {
            if (cursor % 64 === 0) checkBudget()
            const index = queue[cursor]
            forNeighbors(index, next => {
                if (blocked[next] || distance[next] >= 0) return
                distance[next] = distance[index] + 1
                previous[next] = index
                queue.push(next)
            })
        }
        return { distance, previous }
    }

    while (towers.length < towerCount) {
        checkBudget()
        const supply = supplyDistances()
        if (!supply) return undefined
        let best = -1, bestScore = Infinity, bestSupply = -1
        for (let candidateNumber = 0; candidateNumber < candidates.length; candidateNumber++) {
            if (candidateNumber % 32 === 0) checkBudget()
            const index = candidates[candidateNumber]
            if (occupied[index] || blocked[index] || roadMask[index] || !hasSpacing(index)) continue
            let supplyEnd = -1
            forNeighbors(index, next => {
                if (supply.distance[next] >= 0 &&
                    (supplyEnd < 0 || supply.distance[next] < supply.distance[supplyEnd])) supplyEnd = next
            })
            if (supplyEnd < 0) continue
            // Begin with a broad firing line, then optimize its weakest combined
            // attack below. This avoids a greedy center cluster that would need
            // several simultaneous moves to escape.
            const score = scorePlacement(index, false) + supply.distance[supplyEnd] * 0.001
            if (score < bestScore) {
                best = index
                bestScore = score
                bestSupply = supplyEnd
            }
        }
        if (best < 0) return undefined
        towers.push(positionOf(best))
        selected.push(best)
        occupied[best] = blocked[best] = 1
        addCoverage(best)
        for (let next = bestSupply; next >= 0 && !roadMask[next]; next = supply.previous[next]) {
            // A supply road may share a Container, but never a building, native
            // resource, frontline Rampart or an exposed tile.
            if (blocked[next]) return undefined
            roadMask[next] = occupied[next] = 1
            roads.push(positionOf(next))
        }
    }

    // A bounded single-tower replacement improves the weakest firing arc after
    // greedy selection. Already-built towers and all existing roads stay fixed.
    // Supply roads left by a replacement remain useful connected access tiles.
    const fixedCount = options.fixedTowers ? new Set(options.fixedTowers.map(indexOf)).size : 0
    for (let round = 0; round < 2; round++) {
        let improved = false
        for (let towerNumber = fixedCount; towerNumber < selected.length; towerNumber++) {
            checkBudget()
            const previousTower = selected[towerNumber]
            closest.fill(SIZE)
            firepower.fill(0)
            selected.forEach((index, number) => { if (number !== towerNumber) addCoverage(index) })
            let best = previousTower, bestScore = scorePlacement(previousTower), bestSupply = -1
            blocked[previousTower] = occupied[previousTower] = 0
            const supply = supplyDistances()
            if (!supply) return undefined
            for (let candidateNumber = 0; candidateNumber < candidates.length; candidateNumber++) {
                if (candidateNumber % 32 === 0) checkBudget()
                const index = candidates[candidateNumber]
                if (occupied[index] || blocked[index] || roadMask[index] || !hasSpacing(index, towerNumber)) continue
                let supplyEnd = -1
                forNeighbors(index, next => {
                    if (supply.distance[next] >= 0 &&
                        (supplyEnd < 0 || supply.distance[next] < supply.distance[supplyEnd])) supplyEnd = next
                })
                if (supplyEnd < 0) continue
                const score = scorePlacement(index)
                if (score < bestScore - 0.01) {
                    best = index
                    bestScore = score
                    bestSupply = supplyEnd
                }
            }
            selected[towerNumber] = best
            towers[towerNumber] = positionOf(best)
            blocked[best] = occupied[best] = 1
            if (best !== previousTower) {
                improved = true
                for (let next = bestSupply; next >= 0 && !roadMask[next]; next = supply.previous[next]) {
                    if (blocked[next]) return undefined
                    roadMask[next] = occupied[next] = 1
                    roads.push(positionOf(next))
                }
            }
        }
        if (!improved) break
    }

    // Construction order maximizes the weakest combined firing arc at every
    // earlier RCL quota. Keep invested towers first, then choose final positions.
    const ordered = towers.slice(0, fixedCount)
    const remaining = towers.slice(fixedCount)
    const prefixPower = new Float64Array(targets.length)
    const prefixClosest = new Uint8Array(targets.length).fill(SIZE)
    for (const tower of ordered) for (let i = 0; i < targets.length; i++) {
        prefixPower[i] += targetPower(indexOf(tower), i)
        prefixClosest[i] = Math.min(prefixClosest[i], targetRange(indexOf(tower), i))
    }
    while (remaining.length) {
        checkBudget()
        let bestNumber = 0, bestScore = Infinity
        for (let number = 0; number < remaining.length; number++) {
            const index = indexOf(remaining[number])
            let squared = 0, worst = 0, lowestPower = Infinity, totalPower = 0
            for (let i = 0; i < targets.length; i++) {
                const nearest = Math.min(prefixClosest[i], targetRange(index, i))
                squared += nearest * nearest
                worst = Math.max(worst, nearest)
                const power = prefixPower[i] + targetPower(index, i)
                lowestPower = Math.min(lowestPower, power)
                totalPower += power
            }
            const score = -lowestPower * 1000 + squared / targets.length + worst * worst * 0.5 - totalPower / (targets.length * 600) * 0.25
            if (score < bestScore) { bestScore = score; bestNumber = number }
        }
        const tower = remaining.splice(bestNumber, 1)[0]
        ordered.push(tower)
        for (let i = 0; i < targets.length; i++) {
            prefixPower[i] += targetPower(indexOf(tower), i)
            prefixClosest[i] = Math.min(prefixClosest[i], targetRange(indexOf(tower), i))
        }
    }
    checkBudget()
    return { towers: ordered, roads }
}
