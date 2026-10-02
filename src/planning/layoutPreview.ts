import { drawStructureIcon } from 'planning/structureIcons'
import { BlueprintPosition, isRoomCoordinate, positionKey, RoomBlueprint } from 'planning/types'
import { layoutPreviewPolicy } from 'settings/layoutPreview'
import { roomPolicy } from 'settings/roomPolicy'

// 原生 RoomVisual 每房每 tick 的固定容量，单位为 byte。
const ROOM_VISUAL_LIMIT_BYTES = 512000
// 道路在底层，透明 Rampart 在顶层；允许同格建筑保持可见。
const drawOrder: BuildableStructureConstant[] = [
    'road', 'constructedWall', 'container', 'spawn', 'extension', 'link', 'storage',
    'tower', 'observer', 'powerSpawn', 'extractor', 'lab', 'terminal', 'nuker', 'factory', 'rampart',
]
const roadNeighbors = [[1, -1], [1, 0], [1, 1], [0, 1]] as const
interface PreviewCache { roomName: string; fingerprint: string; data: string; bytes: number }
// 只有一个 layout 旗帜：单项 heap 缓存，不写入 Memory。
let cache: PreviewCache | undefined

class PreviewLimitExceeded extends Error {}

function label(visual: RoomVisual, message: string): void {
    const title = layoutPreviewPolicy.title
    const previous = visual.export()
    visual.text(message, title.x, title.y, {
        align: 'left', font: title.font, color: title.color, backgroundColor: title.backgroundColor,
        backgroundPadding: 0.2, opacity: 0.95,
    })
    // 接近原生上限时，提示本身也可能超限；保留已有绘图并撤回这条提示。
    if (visual.getSize() > ROOM_VISUAL_LIMIT_BYTES) {
        visual.clear()
        if (previous) visual.import(previous)
    }
}

function positions(blueprint: RoomBlueprint, type: BuildableStructureConstant): BlueprintPosition[] {
    const values = blueprint.structures?.[type]
    if (!Array.isArray(values)) return []
    const seen = new Set<string>()
    return values.filter((position) => {
        if (!Array.isArray(position) || !isRoomCoordinate(position)) return false
        const key = positionKey(position)
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
}

function drawBlueprint(visual: RoomVisual, blueprint: RoomBlueprint): void {
    const policy = layoutPreviewPolicy
    let operations = 0
    const checkBudget = () => {
        if (++operations % Math.max(1, policy.budgetCheckInterval) == 0 && visual.getSize() > policy.maximumCacheBytes)
            throw new PreviewLimitExceeded()
    }
    const roads = positions(blueprint, 'road')
    const roadTiles = new Set(roads.map(positionKey))
    for (const [x, y] of roads) {
        for (const [dx, dy] of roadNeighbors) {
            if (!roadTiles.has(`${x + dx},${y + dy}`)) continue
            visual.line(x, y, x + dx, y + dy, { color: policy.roadColor, width: policy.roadLineWidth, opacity: policy.roadOpacity })
            checkBudget()
        }
    }
    for (const type of drawOrder) {
        for (const [x, y] of type == 'road' ? roads : positions(blueprint, type)) {
            drawStructureIcon(visual, type, x, y, type == 'road' ? policy.roadOpacity : policy.opacity)
            checkBudget()
        }
    }
    label(visual, `布局预览 · ${visual.roomName} · ${blueprint.origin == 'snapshot' ? '现有布局' : '完整规划'}`)
}

function capturePreview(visual: RoomVisual, blueprint: RoomBlueprint): { data: string; bytes: number } {
    // 所有同房 RoomVisual 共享通道，先保存、最后恢复，避免缓存其他模块的绘图。
    const previous = visual.export()
    visual.clear()
    try {
        drawBlueprint(visual, blueprint)
        const bytes = visual.getSize()
        if (bytes > layoutPreviewPolicy.maximumCacheBytes) throw new PreviewLimitExceeded()
        return { data: visual.export(), bytes }
    } finally {
        visual.clear()
        if (previous) visual.import(previous)
    }
}

/** 在所有普通房间视觉之后执行；无 layout 旗帜时无需访问 Memory 或构造 RoomVisual。 */
export function renderLayoutPreview(): void {
    const flag = Game.flags[roomPolicy.flags.layoutPreview]
    if (!layoutPreviewPolicy.enabled || flag == undefined) { cache = undefined; return }
    const roomName = flag.pos.roomName
    if (cache?.roomName != roomName) cache = undefined
    const visual = new RoomVisual(roomName)
    const blueprint = Memory.rooms?.[roomName]?.roomBlueprint
    if (blueprint == undefined) {
        cache = undefined
        label(visual, '布局预览 · 暂无已保存的布局')
        return
    }
    // 不依赖 Memory 对象引用：重新解析或直接修改蓝图后仍能正确命中/刷新缓存。
    const fingerprint = JSON.stringify([blueprint.structures, blueprint.origin, layoutPreviewPolicy])
    if (cache?.fingerprint != fingerprint) {
        cache = undefined
        try {
            cache = { roomName, fingerprint, ...capturePreview(visual, blueprint) }
        } catch (error) {
            if (!(error instanceof PreviewLimitExceeded)) throw error
            label(visual, '布局预览 · 布局超出绘图容量')
            return
        }
    }
    if (visual.getSize() + cache.bytes > ROOM_VISUAL_LIMIT_BYTES) {
        label(visual, '布局预览 · 当前房间绘图容量不足')
        return
    }
    visual.import(cache.data)
}
