import { plannedRoomBlueprint } from './blueprint'
import { computeExitPerimeter } from './exitPerimeter'
import { planExitTowers } from './exitTowers'
import { computeRoomBlueprint } from './planner63'
import { BlueprintPosition, PLANNING_STRATEGY_VERSION, positionKey, RoomBlueprint } from './types'
import { PlanningBudgetExceeded } from './vendor/PlanningBudgetExceeded'
import { constructionPolicy } from 'settings/construction'

export interface LayoutStrategyMigrationOptions {
    maximumCpu: number
    minimumPlaneCount: number
}

export interface LayoutStrategyMigrationResult {
    blueprint: RoomBlueprint
    deferConstruction: boolean
}

function ownedOrNeutral(structure: Structure): boolean {
    return structure.structureType !== 'controller' && (!('my' in structure) || structure.my !== false)
}

/** Only replace positions that were inherited from the old automatic blueprint. */
function updateAutomaticPositions(room: Room, before: RoomBlueprint, after: RoomBlueprint): void {
    if (!before.center || !after.center || !room.memory.roomPosition) return
    for (const field of ['centerPos', 'managerPos'] as const) {
        const existing = room.memory.roomPosition[field]
        if (existing && existing.x === before.center[0] && existing.y === before.center[1] &&
            (existing.roomName === undefined || existing.roomName === room.name)) {
            room.memory.roomPosition[field] = new RoomPosition(after.center[0], after.center[1], room.name)
        }
    }
}

/** Called only after CPU/cooldown admission; never dismantles a built structure. */
export function migrateLayoutStrategy(
    room: Room,
    blueprint: RoomBlueprint,
    options: LayoutStrategyMigrationOptions
): LayoutStrategyMigrationResult | undefined {
    const started = Game.cpu.getUsed()
    const checkBudget = (): void => {
        if (Game.cpu.getUsed() - started >= options.maximumCpu) throw new PlanningBudgetExceeded(options.maximumCpu)
    }
    if (!Number.isFinite(options.maximumCpu) || options.maximumCpu <= 0) return undefined
    const perimeter = computeExitPerimeter(room.getTerrain(), constructionPolicy.exitDefense, checkBudget)
    const retain = (): LayoutStrategyMigrationResult => ({
        blueprint: { ...blueprint, planningStrategyVersion: PLANNING_STRATEGY_VERSION },
        deferConstruction: false,
    })
    if (!perimeter) return retain()
    checkBudget()
    const resources = [...room.find(FIND_SOURCES), ...room.find(FIND_MINERALS)].map(resource => resource.pos)
    if (room.controller) resources.push(room.controller.pos)
    const frontierKeys = new Set(perimeter.ramparts.map(positionKey))
    if (resources.some(resource => perimeter.outside[resource.y * 50 + resource.x] ||
        frontierKeys.has(`${resource.x},${resource.y}`))) return retain()
    for (const type of Object.keys(blueprint.structures) as BuildableStructureConstant[]) {
        if (type === 'road' || type === 'rampart' || type === 'constructedWall') continue
        if ((blueprint.structures[type] || []).some(([x, y]) => perimeter.outside[y * 50 + x])) return retain()
    }
    const structures = room.find(FIND_STRUCTURES)
    const sites = room.find(FIND_MY_CONSTRUCTION_SITES)
    const oldSiteKeys = new Set<string>()
    for (const type of Object.keys(blueprint.structures) as BuildableStructureConstant[]) {
        for (const position of blueprint.structures[type] || []) oldSiteKeys.add(`${type}:${positionKey(position)}`)
    }
    const oldRampartKeys = new Set((blueprint.structures.rampart || []).map(positionKey))
    checkBudget()
    // Exit-defense plans already chose their base using resource distances. A
    // later defense policy upgrade must keep that choice even before building.
    const fullMigration = blueprint.planningStrategyVersion === undefined &&
        (room.controller?.level || 0) < 4 && !structures.some(ownedOrNeutral) &&
        sites.every(site => site.progress === 0 && oldSiteKeys.has(`${site.structureType}:${site.pos.x},${site.pos.y}`))
    let replacement: RoomBlueprint
    let obsoleteSites: ConstructionSite[]
    if (fullMigration) {
        const remainingCpu = options.maximumCpu - (Game.cpu.getUsed() - started)
        checkBudget()
        let result
        try {
            result = computeRoomBlueprint(room, { minimumPlaneCount: options.minimumPlaneCount, maximumCpu: remainingCpu })
        } catch (error) {
            // The vendor receives a remaining budget, but callers track this whole operation.
            if (error instanceof PlanningBudgetExceeded) throw new PlanningBudgetExceeded(options.maximumCpu)
            throw error
        }
        checkBudget()
        if (!result) return undefined
        const planned = plannedRoomBlueprint(room, result, { excludedConstructionSites: new Set(sites.map(site => site.id)) })
        checkBudget()
        if (!planned) return undefined
        replacement = planned
        const desiredSites = new Set<string>()
        for (const type of Object.keys(replacement.structures) as BuildableStructureConstant[]) {
            for (const position of replacement.structures[type] || []) desiredSites.add(`${type}:${positionKey(position)}`)
        }
        obsoleteSites = sites.filter(site => !desiredSites.has(`${site.structureType}:${site.pos.x},${site.pos.y}`))
    } else {
        const ramparts: BlueprintPosition[] = perimeter.ramparts.map(([x, y]) => [x, y])
        const rampartKeys = new Set(ramparts.map(positionKey))
        // Existing, invested and manually added Ramparts retain their protection.
        // Only an unstarted site recorded by the old plan belongs to this migration.
        for (const item of [...structures.filter(ownedOrNeutral), ...sites.filter(site => site.progress > 0 ||
            (site.structureType === 'rampart' && !oldRampartKeys.has(`${site.pos.x},${site.pos.y}`)))]) {
            if (item.structureType !== 'rampart') continue
            const position: BlueprintPosition = [item.pos.x, item.pos.y], key = positionKey(position)
            if (!rampartKeys.has(key)) { ramparts.push(position); rampartKeys.add(key) }
        }
        replacement = { ...blueprint, structures: { ...blueprint.structures, rampart: ramparts } }
        obsoleteSites = sites.filter(site => site.structureType === 'rampart' && site.progress === 0 &&
            oldRampartKeys.has(`${site.pos.x},${site.pos.y}`) &&
            !rampartKeys.has(`${site.pos.x},${site.pos.y}`))
        if (constructionPolicy.exitDefense.towers?.enabled) {
            const oldTowerKeys = new Set((blueprint.structures.tower || []).map(positionKey))
            const fixedTowers: BlueprintPosition[] = []
            const fixedTowerKeys = new Set<string>()
            for (const item of [...structures.filter(ownedOrNeutral), ...sites.filter(site =>
                site.progress !== 0 || !oldTowerKeys.has(`${site.pos.x},${site.pos.y}`))]) {
                if (item.structureType !== 'tower') continue
                const position: BlueprintPosition = [item.pos.x, item.pos.y], key = positionKey(position)
                if (!fixedTowerKeys.has(key)) { fixedTowers.push(position); fixedTowerKeys.add(key) }
            }
            // The stored plan can predate a manual building or construction site.
            // Include those occupants when finding Tower positions without moving
            // them or changing the recorded non-Tower layout.
            const occupied = { ...replacement.structures }
            for (const type of Object.keys(occupied) as BuildableStructureConstant[])
                occupied[type] = (occupied[type] || []).map(([x, y]) => [x, y])
            for (const item of [...structures, ...sites]) {
                if (item.structureType === 'controller') continue
                const type = item.structureType as BuildableStructureConstant
                if (type === 'tower') {
                    // A hostile remnant is an obstacle rather than a retained Tower.
                    if ('my' in item && item.my === false) {
                        occupied.constructedWall ||= []
                        occupied.constructedWall.push([item.pos.x, item.pos.y])
                    }
                    continue
                }
                occupied[type] ||= []
                if (!occupied[type]!.some(([x, y]) => x === item.pos.x && y === item.pos.y))
                    occupied[type]!.push([item.pos.x, item.pos.y])
            }
            const towers = planExitTowers(room.getTerrain(), perimeter, occupied,
                resources.map(resource => [resource.x, resource.y] as BlueprintPosition), {
                    minimumEnemyRange: constructionPolicy.exitDefense.towers.minimumEnemyRange,
                    towerCount: CONTROLLER_STRUCTURES.tower[8], fixedTowers,
                }, checkBudget)
            checkBudget()
            if (towers) {
                replacement.structures.tower = towers.towers
                replacement.structures.road = towers.roads
                const towerKeys = new Set(towers.towers.map(positionKey))
                obsoleteSites.push(...sites.filter(site => site.structureType === 'tower' && site.progress === 0 &&
                    oldTowerKeys.has(`${site.pos.x},${site.pos.y}`) &&
                    !towerKeys.has(`${site.pos.x},${site.pos.y}`)))
            }
        }
    }
    replacement.planningStrategyVersion = PLANNING_STRATEGY_VERSION
    if (!fullMigration) replacement.exitDefense = { exitCount: perimeter.exitCount, exitSides: perimeter.exitSides }
    // Finish all budget checks before committing removal intents, so a CPU exception
    // cannot leave half a migration applied. Native failures retain the old plan.
    checkBudget()
    let removed = 0
    for (const site of obsoleteSites) {
        if (site.remove() !== OK) {
            if (removed > 0) room.memory.needUpdateCache = true
            return { blueprint, deferConstruction: true }
        }
        removed++
    }
    if (removed > 0) room.memory.needUpdateCache = true
    if (fullMigration) updateAutomaticPositions(room, blueprint, replacement)
    return { blueprint: replacement, deferConstruction: fullMigration || removed > 0 }
}
