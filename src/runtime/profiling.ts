import { runtimePolicy } from 'settings/runtime'

export interface CpuProfileEntry {
    name: string
    count: number
    total: number
    max: number
    ema: number
    average: number
    lastTick: number
    rollingAverage: number
    rollingTotal: number
    rollingMax: number
    windowTicks: number
    current: number
    sampledTicks: number
    sampledAverage: number
}

interface CpuProfileAggregate {
    name: string
    count: number
    total: number
    max: number
    ema: number
    lastTick: number
    rollingTotal: number
    samples: number[]
    observed: number[]
}
export type CpuProfileSort = 'rollingAverage' | 'rollingTotal' | 'rollingMax' | 'current' | 'ema' | 'average' | 'total' | 'max'
export interface CpuProfileWindow {
    windowSize: number
    windowTicks: number
    startTick: number | null
    endTick: number | null
    ready: boolean
}

// 只保存有界的每 tick 合计环形数组，不写 Memory，不保存逐次调用样本。
const aggregates = new Map<string, CpuProfileAggregate>()
let windowSize = 0
let windowStart: number | undefined
let windowEnd: number | undefined
let windowShard: string | undefined
let windowSlot = 0
let lastLogTick: number | undefined

function configuredWindowSize(): number {
    const size = runtimePolicy.profiling.windowSize
    return Number.isSafeInteger(size) && size > 0 ? size : 1
}

function coveredTicks(): number {
    return windowStart == undefined || windowEnd == undefined ? 0 : Math.min(windowSize, windowEnd - windowStart + 1)
}

/** 每个 tick 只推进一次；迟到的模块与尚未运行的模块共用同一个预热分母。 */
function advanceWindow(initialize = false): void {
    if (typeof Game == 'undefined' || !Number.isSafeInteger(Game.time) || Game.time < 0) return
    if (windowEnd == undefined && !initialize) return
    const size = configuredWindowSize(), shard = Game.shard.name
    if (windowEnd == undefined || size != windowSize || shard != windowShard || Game.time < windowEnd) {
        windowSize = size; windowStart = Game.time; windowEnd = Game.time; windowShard = shard; windowSlot = 0
        lastLogTick = undefined
        for (const aggregate of aggregates.values()) {
            aggregate.samples = new Array<number>(windowSize).fill(0); aggregate.rollingTotal = 0
            aggregate.observed = new Array<number>(windowSize).fill(0)
        }
        return
    }
    const elapsed = Game.time - windowEnd
    if (elapsed == 0) return
    if (elapsed >= windowSize) {
        for (const aggregate of aggregates.values()) { aggregate.samples.fill(0); aggregate.observed.fill(0); aggregate.rollingTotal = 0 }
    } else {
        for (const aggregate of aggregates.values()) {
            for (let offset = 1; offset <= elapsed; offset++) {
                const slot = (windowSlot + offset) % windowSize
                aggregate.rollingTotal -= aggregate.samples[slot]; aggregate.samples[slot] = 0
                aggregate.observed[slot] = 0
            }
            // 浮点相减可能留下极小负数，CPU 总量始终非负。
            aggregate.rollingTotal = Math.max(0, aggregate.rollingTotal)
        }
    }
    windowSlot = (windowSlot + elapsed % windowSize) % windowSize; windowEnd = Game.time
}

export function isCpuProfilingEnabled(): boolean {
    const policy = runtimePolicy.profiling
    return typeof Game != 'undefined' && policy.enabled && (policy.shards.length == 0 || policy.shards.includes(Game.shard.name))
}

/** 复用调用方已读取的 CPU 差值，不再查询 Game.cpu。 */
export function recordCpuSample(name: string, used: number): void {
    if (!isCpuProfilingEnabled()) return
    const policy = runtimePolicy.profiling
    const maximumEntries = Math.max(0, Math.floor(policy.maximumEntries))
    if (maximumEntries == 0 || !Number.isFinite(used) || used < 0) return
    advanceWindow(true)
    if (windowEnd == undefined) return
    const previous = aggregates.get(name)
    aggregates.delete(name)
    // Map 更新顺序作为最近使用顺序；新增/降低容量时淘汰最久未更新的项。
    while (aggregates.size >= maximumEntries) aggregates.delete(aggregates.keys().next().value!)
    const alpha = Math.max(0, Math.min(1, policy.emaAlpha))
    const aggregate: CpuProfileAggregate = previous || {
        name,
        count: 0, total: 0, max: 0, ema: used, lastTick: Game.time,
        rollingTotal: 0, samples: new Array<number>(windowSize).fill(0),
        observed: new Array<number>(windowSize).fill(0),
    }
    // 复用常见模块与角色的聚合对象，减少每 tick 数百次临时分配。
    aggregate.count++
    aggregate.total += used
    aggregate.max = Math.max(aggregate.max, used)
    if (previous != undefined) aggregate.ema += alpha * (used - aggregate.ema)
    aggregate.lastTick = Game.time
    aggregate.rollingTotal += used
    aggregate.samples[windowSlot] += used
    aggregate.observed[windowSlot] = 1
    aggregates.set(name, aggregate)
}

/** 关闭时直接执行任务，不读取 CPU；失败任务仍计入聚合并保留原异常。 */
export function profileCpuTask<T>(name: string, task: () => T): T {
    if (!isCpuProfilingEnabled()) return task()
    const started = Game.cpu.getUsed()
    try {
        return task()
    } finally {
        // 诊断自身失败不能盖过业务异常。
        try { recordCpuSample(name, Game.cpu.getUsed() - started) } catch (_) {}
    }
}

function entries(): CpuProfileEntry[] {
    const windowTicks = coveredTicks()
    return Array.from(aggregates.values(), aggregate => {
        let rollingMax = 0, sampledTicks = 0
        for (let index = 0; index < aggregate.samples.length; index++) {
            rollingMax = Math.max(rollingMax, aggregate.samples[index]); sampledTicks += aggregate.observed[index]
        }
        return {
            name: aggregate.name, count: aggregate.count, total: aggregate.total, max: aggregate.max,
            ema: aggregate.ema, lastTick: aggregate.lastTick, average: aggregate.total / aggregate.count,
            rollingTotal: aggregate.rollingTotal, rollingAverage: windowTicks == 0 ? 0 : aggregate.rollingTotal / windowTicks,
            rollingMax, windowTicks, current: aggregate.samples[windowSlot],
            sampledTicks, sampledAverage: sampledTicks == 0 ? 0 : aggregate.rollingTotal / sampledTicks,
        }
    })
}

/** 只在主动查询或定期日志时排序，返回副本；累计 average 仍为每次调用均值。 */
export function getCpuProfile(limit: number = runtimePolicy.profiling.topCount, sortBy: CpuProfileSort = 'rollingAverage'): CpuProfileEntry[] {
    advanceWindow()
    return entries().sort((first, second) => second[sortBy] - first[sortBy] || first.name.localeCompare(second.name))
        .slice(0, Math.max(0, Math.floor(limit)))
}

export function getCpuProfileWindow(): CpuProfileWindow {
    advanceWindow()
    const size = configuredWindowSize(), ticks = coveredTicks()
    return {
        windowSize: size, windowTicks: ticks,
        startTick: windowStart == undefined || windowEnd == undefined ? null : Math.max(windowStart, windowEnd - size + 1),
        endTick: windowEnd ?? null, ready: ticks == size,
    }
}

function logProfiles(): void {
    const window = getCpuProfileWindow()
    const sorted = entries().sort((first, second) => second.rollingAverage - first.rollingAverage || first.name.localeCompare(second.name))
    const topLevel = sorted.filter(entry => entry.name.startsWith('tick:'))
    const total = topLevel.reduce((sum, entry) => sum + entry.rollingTotal, 0)
    const sumAverage = window.windowTicks == 0 ? 0 : total / window.windowTicks
    const format = (values: CpuProfileEntry[], shares = false): string => values.length == 0 ? '无采样' : values.map(entry =>
        `${entry.name} avg=${entry.rollingAverage.toFixed(3)} max=${entry.rollingMax.toFixed(3)} current=${entry.current.toFixed(3)}` +
        (shares ? ` share=${(total == 0 ? 0 : entry.rollingTotal / total * 100).toFixed(1)}%` : '')).join(' | ')
    const lines = [`[CPU][${Game.shard.name}][${window.startTick}-${window.endTick}] 最近 ${window.windowTicks} tick（avg/tick、max/tick、current），sumAvg=${sumAverage.toFixed(3)}：`,
        `顶层阶段：${format(topLevel, true)}`]
    const finalStage = topLevel.find(entry => entry.name == 'tick:shardFlush')
    if (finalStage != undefined) lines.push(`末阶段采样 ${finalStage.sampledTicks}/${window.windowTicks} tick；未执行到末阶段的 tick 会使分项均值低估实际消耗。`)
    if (runtimePolicy.profiling.logDetails) lines.push(`模块详情（已包含在顶层，不能相加）：${format(sorted.filter(entry => !entry.name.startsWith('tick:')))}`)
    console.log(lines.join('\n'))
}

/** TickRunner 在 finally 调用；窗口预热完成后首次报告，同 tick 重入不会重复日志。 */
export function finishCpuProfilingTick(): void {
    try {
        if (!isCpuProfilingEnabled()) return
        advanceWindow(true)
        const policy = runtimePolicy.profiling
        const interval = Number.isSafeInteger(policy.logInterval) && policy.logInterval > 0 ? policy.logInterval : 1
        if (!policy.logEnabled || coveredTicks() < windowSize ||
            (lastLogTick != undefined && Game.time - lastLogTick < interval)) return
        lastLogTick = Game.time
        logProfiles()
    } catch (_) {}
}

export function resetCpuProfile(): void {
    aggregates.clear()
    windowSize = 0; windowStart = undefined; windowEnd = undefined; windowShard = undefined
    windowSlot = 0; lastLogTick = undefined
}
