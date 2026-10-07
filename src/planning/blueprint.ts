import { BLUEPRINT_SCHEMA_VERSION, BlueprintPosition, BlueprintStructures, isRoomCoordinate, REACTION_LAB_RANGE, RoomBlueprint } from 'planning/types'
import type { Planner63Result } from 'planning/planner63'

/** 直接读取本 tick 的世界，不能使用可能尚未刷新的跨 tick 建筑 ID 缓存。 */
export function currentRoomBuildings(room: Room): (Structure | ConstructionSite)[] {
    return [...room.find(FIND_STRUCTURES), ...room.find(FIND_MY_CONSTRUCTION_SITES)]
}

function append(structures: BlueprintStructures, type: BuildableStructureConstant, position: BlueprintPosition): void {
    if (!isRoomCoordinate(position) || CONTROLLER_STRUCTURES[type] == undefined) return
    const positions = structures[type] || (structures[type] = [])
    if (!positions.some(([x, y]) => x == position[0] && y == position[1]))
        positions.push([position[0], position[1]])
}

/** 初次见到已满级房间时冻结现有布局；已保存的蓝图永不在巡检中重新快照。 */
export function snapshotRoomBlueprint(room: Room, excludedConstructionSites?: ReadonlySet<string>): RoomBlueprint {
    const structures: BlueprintStructures = {}
    const buildings = currentRoomBuildings(room)
    for (const item of buildings) {
        if ('my' in item && item.my === false) continue
        if ('progress' in item && excludedConstructionSites?.has(item.id)) continue
        append(structures, item.structureType as BuildableStructureConstant, [item.pos.x, item.pos.y])
    }
    const blueprint: RoomBlueprint = { schemaVersion: BLUEPRINT_SCHEMA_VERSION, origin: 'snapshot', createdAt: Game.time, structures }
    const config = room.memory.roomLabConfig
    const pair = [config?.sourceLab1, config?.sourceLab2].map((id) =>
        id == undefined ? undefined : buildings.find((item) => item.id == id && item.structureType == STRUCTURE_LAB))
    if (pair[0] != undefined && pair[1] != undefined)
        blueprint.sourceLabs = [[pair[0].pos.x, pair[0].pos.y], [pair[1].pos.x, pair[1].pos.y]]
    return blueprint
}

/** 已有建筑优先保留，不拆除已有 Spawn 或因自动规划替换人工建筑。 */
export function plannedRoomBlueprint(room: Room, result: Planner63Result,
    options: { excludedConstructionSites?: ReadonlySet<string> } = {}): RoomBlueprint | undefined {
    const blueprint = snapshotRoomBlueprint(room, options.excludedConstructionSites)
    blueprint.origin = 'planner63'
    blueprint.planningStrategyVersion = result.planningStrategyVersion
    if (result.exitDefense) blueprint.exitDefense = { ...result.exitDefense }
    if (result.controllerContainer) blueprint.controllerContainer = [...result.controllerContainer]
    for (const type of Object.keys(result.structMap) as BuildableStructureConstant[]) {
        for (const position of result.structMap[type] || []) append(blueprint.structures, type, position)
    }
    if ((blueprint.structures.spawn || []).length == 0) return undefined
    const center: BlueprintPosition = [result.storagePos.x, result.storagePos.y]
    if (isRoomCoordinate(center)) blueprint.center = center
    const labs = result.structMap.lab
    if (labs != undefined && labs.length >= 2)
        blueprint.sourceLabs = [[...labs[0]], [...labs[1]]]
    return blueprint
}

/** 把规划元数据适配为 ecbot 的经理站位和反应底物 Lab 配置。 */
export function synchronizeBlueprintMetadata(room: Room, blueprint: RoomBlueprint): void {
    const positions = room.memory.roomPosition || (room.memory.roomPosition = {})
    if (blueprint.center != undefined) {
        const [x, y] = blueprint.center
        if (positions.centerPos == undefined) positions.centerPos = new RoomPosition(x, y, room.name)
        if (positions.managerPos == undefined) positions.managerPos = new RoomPosition(x, y, room.name)
    }
    if (blueprint.sourceLabs == undefined) return
    if ((CONTROLLER_STRUCTURES[STRUCTURE_LAB][room.controller?.level || 0] || 0) == 0) return
    const config = room.memory.roomLabConfig
    if (config == undefined) return
    if (config.sourceLab1 != undefined && config.sourceLab2 != undefined && typeof Game.getObjectById == 'function') {
        const first = Game.getObjectById<StructureLab>(config.sourceLab1)
        const second = Game.getObjectById<StructureLab>(config.sourceLab2)
        if (first?.my && second?.my && first.structureType == STRUCTURE_LAB && second.structureType == STRUCTURE_LAB &&
            first.pos.roomName == room.name && second.pos.roomName == room.name) return
    }
    const labs = room.find(FIND_MY_STRUCTURES).filter((item) => item.structureType == STRUCTURE_LAB)
    const plannedPair = blueprint.sourceLabs.map(([x, y]) => labs.find((lab) => lab.pos.x == x && lab.pos.y == y))
    // 人工设置且仍有效的底物配置优先；只填补缺失或已被摧毁的 Lab。
    const currentFirst = labs.find((lab) => lab.id == config.sourceLab1)
    const currentSecond = labs.find((lab) => lab.id == config.sourceLab2)
    if (currentFirst != undefined && currentSecond != undefined) return
    const first = currentFirst || plannedPair.find((lab) => lab != undefined && lab.id != currentSecond?.id)
    const second = currentSecond || plannedPair.find((lab) => lab != undefined && lab.id != first?.id)
    if (first == undefined || second == undefined || first.id == second.id) return
    const pair = [first, second]
    if (!labs.every((lab) => pair.every((source) => Math.max(
        Math.abs(lab.pos.x - source!.pos.x), Math.abs(lab.pos.y - source!.pos.y)) <= REACTION_LAB_RANGE))) return
    if (currentFirst == undefined) {
        config.sourceLab1 = first.id
        delete config.singleLabConfig[first.id]
    }
    if (currentSecond == undefined) {
        config.sourceLab2 = second.id
        delete config.singleLabConfig[second.id]
    }
}
