import { computeManor63 } from './vendor/manor63'
import { controllerLayoutPolicy } from 'settings/controllerLayout'
export { PlanningBudgetExceeded } from './vendor/PlanningBudgetExceeded'

export interface Planner63Position { x: number; y: number }

export interface Planner63Options {
    minimumPlaneCount?: number
    storagePosition?: Planner63Position
    maximumCpu?: number
}

export interface Planner63Result {
    roomName: string
    storagePos: Planner63Position
    labPos: Planner63Position
    controllerContainer?: [number, number]
    structMap: Partial<Record<BuildableStructureConstant, [number, number][]>>
}

const buildableTypes: BuildableStructureConstant[] = [
    'spawn', 'extension', 'road', 'constructedWall', 'rampart', 'link', 'storage',
    'tower', 'observer', 'powerSpawn', 'extractor', 'lab', 'terminal', 'container', 'nuker', 'factory'
]

function isRoomPosition(position: Planner63Position | undefined): position is Planner63Position {
    return position !== undefined && Number.isInteger(position.x) && Number.isInteger(position.y)
        && position.x >= 0 && position.y >= 0 && position.x < 50 && position.y < 50
}

/** CPU-heavy, explicit planning operation. Importing this module has no Screeps side effects. */
export function computeRoomBlueprint(room: Room, options: Planner63Options = {}): Planner63Result | undefined {
    const controller = room.controller
    const mineral = room.find(FIND_MINERALS)[0]
    const sources = room.find(FIND_SOURCES)
    // Index 1 is the mineral in the upstream algorithm; never shift a source into it.
    if (controller === undefined || mineral === undefined || sources.length === 0) return undefined
    const points = [controller, mineral, ...sources]
    if (points.some(point => !isRoomPosition(point.pos) || point.pos.roomName !== room.name)) return undefined
    if (options.storagePosition !== undefined && !isRoomPosition(options.storagePosition)) return undefined
    const minimumPlaneCount = options.minimumPlaneCount ?? 140
    if (!Number.isInteger(minimumPlaneCount) || minimumPlaneCount <= 0 || minimumPlaneCount > 2500) return undefined
    if (options.maximumCpu !== undefined && (!Number.isFinite(options.maximumCpu) || options.maximumCpu <= 0)) return undefined

    const raw = computeManor63(room.name, points, { ...options, minimumPlaneCount }) as Planner63Result | undefined
    if (raw === undefined || !isRoomPosition(raw.storagePos) || !isRoomPosition(raw.labPos)) return undefined
    const actualStorage = raw.structMap.storage?.[0]
    if (actualStorage === undefined) return undefined
    const storagePos = { x: actualStorage[0] + 1, y: actualStorage[1] }
    if (!isRoomPosition(storagePos)) return undefined
    const structMap: Planner63Result['structMap'] = {}
    for (const type of buildableTypes) {
        const coordinates = raw.structMap[type]
        if (coordinates === undefined) continue
        const seen = new Set<string>()
        structMap[type] = []
        for (const [x, y] of coordinates) {
            if (!isRoomPosition({ x, y })) return undefined
            const key = `${x},${y}`
            if (seen.has(key)) continue
            seen.add(key)
            structMap[type]!.push([x, y])
        }
    }
    const controllerContainer = raw.controllerContainer
    if (!Array.isArray(controllerContainer) || controllerContainer.length !== 2 ||
        !isRoomPosition({ x: controllerContainer[0], y: controllerContainer[1] }) ||
        Math.max(Math.abs(controllerContainer[0] - controller.pos.x), Math.abs(controllerContainer[1] - controller.pos.y)) !== controllerLayoutPolicy.containerRange ||
        !structMap.container?.some(([x, y]) => x === controllerContainer[0] && y === controllerContainer[1])) return undefined
    for (const type of ['spawn', 'extension', 'lab', 'tower'] as const) {
        if ((structMap[type]?.length ?? 0) < CONTROLLER_STRUCTURES[type][8]) return undefined
    }
    for (const type of ['storage', 'terminal', 'factory', 'observer', 'powerSpawn', 'nuker'] as const) {
        if ((structMap[type]?.length ?? 0) < 1) return undefined
    }
    const terrain = new Room.Terrain(room.name)
    const resourcePositions = new Set(points.map(point => `${point.pos.x},${point.pos.y}`))
    const mineralPosition = `${mineral.pos.x},${mineral.pos.y}`
    const occupants = new Map<string, BuildableStructureConstant[]>()
    for (const type of buildableTypes) {
        for (const [x, y] of structMap[type] ?? []) {
            const key = `${x},${y}`
            // Minerals may occupy natural wall tiles; their extractor is the native exception.
            const mineralExtractor = type === 'extractor' && key === mineralPosition
            if (type !== 'road' && (x === 0 || y === 0 || x === 49 || y === 49
                || (terrain.get(x, y) === TERRAIN_MASK_WALL && !mineralExtractor))) return undefined
            if (resourcePositions.has(key) && !mineralExtractor) return undefined
            const existing = occupants.get(key) ?? []
            if (existing.some(other => {
                if (type === 'rampart' || other === 'rampart') return false
                return !((type === 'road' && other === 'container') || (type === 'container' && other === 'road'))
            })) return undefined
            existing.push(type)
            occupants.set(key, existing)
        }
    }
    return { roomName: room.name, storagePos, labPos: raw.labPos, controllerContainer: [...controllerContainer], structMap }
}
