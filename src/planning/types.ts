// 房间坐标和蓝图版本是数据格式约定，不属于运行策略。
export const ROOM_SIZE = 50
export const BLUEPRINT_SCHEMA_VERSION = 1
// Screeps 反应 Lab 的固定交互距离；API 没有对应全局常量。
export const REACTION_LAB_RANGE = 2
export type BlueprintPosition = [number, number]
export type BlueprintStructures = Partial<Record<BuildableStructureConstant, BlueprintPosition[]>>

export interface RoomBlueprint {
    schemaVersion: typeof BLUEPRINT_SCHEMA_VERSION
    origin: 'planner63' | 'snapshot'
    createdAt: number
    structures: BlueprintStructures
    /** Storage 旁的经理站位，不是 Storage 本体坐标。 */
    center?: BlueprintPosition
    sourceLabs?: [BlueprintPosition, BlueprintPosition]
    /** Explicit identity: resource containers are reordered by the upstream planner. */
    controllerContainer?: BlueprintPosition
}

export interface RoomBlueprintState {
    ownedSince?: number
    lastPlanAttempt?: number
    lastBuildTick?: number
    lastLevel?: number
    lastError?: string
    lastControllerContainerAttempt?: number
}

export function isRoomCoordinate(position: BlueprintPosition): boolean {
    return position.length == 2 && position.every((value) =>
        Number.isInteger(value) && value >= 0 && value < ROOM_SIZE)
}

export function positionKey(position: BlueprintPosition): string {
    return `${position[0]},${position[1]}`
}
