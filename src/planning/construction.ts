import { constructionPolicy } from 'settings/construction'
import { controllerLayoutPolicy } from 'settings/controllerLayout'
import { BlueprintPosition, isRoomCoordinate, positionKey, RoomBlueprint } from 'planning/types'
import { redundantSourceContainer } from 'room/sourceLinks'

export interface ConstructionBudget {
    remaining: number
    /** createConstructionSite 是意图，成功后本 tick 的 find 仍可能返回旧工地列表。 */
    intents: Map<string, { type: BuildableStructureConstant; position: BlueprintPosition }[]>
}

export function canShareStructureTile(first: StructureConstant, second: StructureConstant): boolean {
    if (first == second || first == STRUCTURE_WALL || second == STRUCTURE_WALL) return false
    if (first == STRUCTURE_RAMPART || second == STRUCTURE_RAMPART) return true
    return (first == STRUCTURE_ROAD && second == STRUCTURE_CONTAINER) ||
        (first == STRUCTURE_CONTAINER && second == STRUCTURE_ROAD)
}

/** 按等级和全局/房间工地预算补建；不会拆建筑、取消工地或搬迁已有布局。 */
export function buildMissingStructures(room: Room, blueprint: RoomBlueprint, budget: ConstructionBudget): number {
    const policy = constructionPolicy.building
    const level = room.controller!.level
    const structures = room.find(FIND_STRUCTURES)
    const sites = room.find(FIND_CONSTRUCTION_SITES)
    const intents = budget.intents.get(room.name) || []
    budget.intents.set(room.name, intents)
    const terrain = room.getTerrain()
    const minerals = room.find(FIND_MINERALS)
    const resources = [...room.find(FIND_SOURCES).map((source) => source.pos), ...minerals.map((mineral) => mineral.pos)]
    const reserved = [...resources, room.controller!.pos]
    const occupancy = new Map<string, StructureConstant[]>()
    const siteTiles = new Set<string>()
    const counts: Partial<Record<BuildableStructureConstant, number>> = {}
    for (const item of [...structures, ...sites]) {
        const key = `${item.pos.x},${item.pos.y}`
        const types = occupancy.get(key) || []
        types.push(item.structureType)
        occupancy.set(key, types)
        if ('progressTotal' in item) siteTiles.add(key)
        if (!('my' in item) || item.my !== false) {
            const type = item.structureType as BuildableStructureConstant
            counts[type] = (counts[type] || 0) + 1
        }
    }
    for (const intent of intents) {
        siteTiles.add(positionKey(intent.position))
        counts[intent.type] = (counts[intent.type] || 0) + 1
    }
    let created = 0
    let active = sites.filter((site) => site.my).length + intents.length
    for (const type of constructionPolicy.structurePriority) {
        const limit = CONTROLLER_STRUCTURES[type]?.[level] || 0
        if (limit == 0) continue
        if (blueprint.origin == 'planner63' &&
            ((type == STRUCTURE_ROAD && level < policy.roadMinimumLevel) ||
             (type == STRUCTURE_RAMPART && level < policy.rampartMinimumLevel))) continue
        for (const position of blueprint.structures[type] || []) {
            if (budget.remaining <= 0 || intents.length >= policy.maximumNewSitesPerRoom || active >= policy.maximumActiveSitesPerRoom) return created
            if ((counts[type] || 0) >= limit) break
            if (!isRoomCoordinate(position)) continue
            const [x, y] = position
            if (type === STRUCTURE_CONTAINER && redundantSourceContainer(room, x, y)) continue
            // 等待旧蓝图迁移时，不重新创建贴近控制器的非采集容器。
            if (blueprint.origin == 'planner63' && level < 8 && type == STRUCTURE_CONTAINER &&
                Math.max(Math.abs(room.controller!.pos.x - x), Math.abs(room.controller!.pos.y - y)) < controllerLayoutPolicy.containerRange &&
                !resources.some((pos) => Math.max(Math.abs(pos.x - x), Math.abs(pos.y - y)) <= 1)) continue
            const key = positionKey(position)
            if (siteTiles.has(key)) continue
            const existing = occupancy.get(key) || []
            if (existing.includes(type) || existing.some((other) => !canShareStructureTile(type, other))) continue
            const mineralHere = minerals.some((mineral) => mineral.pos.x == x && mineral.pos.y == y)
            // 原生 API 允许天然墙上的道路，以及实际矿物格上的 Extractor。
            if (terrain.get(x, y) == TERRAIN_MASK_WALL && type != STRUCTURE_ROAD &&
                !(type == STRUCTURE_EXTRACTOR && mineralHere)) continue
            if (type == STRUCTURE_EXTRACTOR ? !mineralHere : reserved.some((pos) => pos.x == x && pos.y == y)) continue
            if (blueprint.origin == 'planner63' && type == STRUCTURE_CONTAINER && level < policy.mineralContainerMinimumLevel &&
                minerals.some((mineral) => Math.max(Math.abs(mineral.pos.x - x), Math.abs(mineral.pos.y - y)) <= 1)) continue
            const result = room.createConstructionSite(x, y, type)
            if (result == ERR_FULL) { budget.remaining = 0; return created }
            if (result != OK) continue
            budget.remaining--
            counts[type] = (counts[type] || 0) + 1
            siteTiles.add(key)
            intents.push({ type, position: [x, y] })
            created++
            active++
            room.memory.needUpdateCache = true
        }
    }
    return created
}
