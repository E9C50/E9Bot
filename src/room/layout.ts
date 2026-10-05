import { runAutomaticLayout } from 'planning/automaticLayout'
import { roomPolicy } from 'settings/roomPolicy'
import { sourceLinkPolicy } from 'settings/sourceLinks'
import { cleanupSourceLinkContainers } from 'planning/sourceLinkContainers'
import { roomWorkDue } from 'runtime/roomSchedule'

// Screeps 房间坐标规则；当前 API 未提供房间边长常量。
const ROOM_SIZE = 50

function getCenterSwampCount(
    terrain: RoomTerrain,
    x: number,
    y: number,
    baseSize: number
): number {
    const halfSize = Math.floor(baseSize / 2)
    const margin = roomPolicy.layout.borderMargin
    const maximumCoordinate = ROOM_SIZE - margin - 1
    if (
        x - halfSize <= margin ||
        y - halfSize <= margin ||
        x + halfSize > maximumCoordinate ||
        y + halfSize > maximumCoordinate
    )
        return Infinity

    let swampCount = 0
    for (let tileX = x - halfSize; tileX <= x + halfSize; tileX++) {
        for (let tileY = y - halfSize; tileY <= y + halfSize; tileY++) {
            const tile = terrain.get(tileX, tileY)
            if (tile == TERRAIN_MASK_WALL) return Infinity
            if (tile == TERRAIN_MASK_SWAMP) swampCount++
        }
    }
    return swampCount
}

/** 在原规划旗帜存在时可视化候选中心，返回最少沼泽的候选位置。 */
export function autoComputeCenterPos(
    room: Room,
    baseSize: number = roomPolicy.layout.baseSize
): RoomPosition | undefined {
    const flag = Game.flags[roomPolicy.flags.planCenter]
    if (flag == undefined || flag.pos.roomName != room.name) return undefined

    const cpu = Game.cpu.getUsed()
    const terrain = room.getTerrain()
    let minimumSwamps = Infinity
    let center: RoomPosition | undefined
    for (let x = 0; x < ROOM_SIZE; x++) {
        for (let y = 0; y < ROOM_SIZE; y++) {
            const swampCount = getCenterSwampCount(terrain, x, y, baseSize)
            if (swampCount == Infinity) continue
            if (swampCount < minimumSwamps) {
                minimumSwamps = swampCount
                center = new RoomPosition(x, y, room.name)
            }
            room.visual.text(swampCount.toString(), x, y, { align: 'center' })
        }
    }
    console.log(room.name, '自动计算RoomCenter', Game.cpu.getUsed() - cpu)
    return center
}

/** 保留控制器公开入口；布局和补建由持久蓝图服务管理。 */
export function releaseConstructionSite(room: Room): void {
    if (sourceLinkPolicy.enabled && roomWorkDue(room.name, sourceLinkPolicy.inspectionInterval)) cleanupSourceLinkContainers(room)
    runAutomaticLayout(room)
}
