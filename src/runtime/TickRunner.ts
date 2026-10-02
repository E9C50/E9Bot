import { finishCpuProfilingTick, isCpuProfilingEnabled, profileCpuTask } from './profiling'

export interface TickStage {
    readonly name: string
    readonly run: () => void
}

/** 顺序是依赖契约：房间初始化必须先于需求、角色和建筑执行。 */
export function createTickRunner(stages: readonly TickStage[]): () => void {
    return () => {
        const profiling = isCpuProfilingEnabled()
        try {
            for (const stage of stages) {
                try {
                    if (profiling) profileCpuTask('tick:' + stage.name, stage.run)
                    else stage.run()
                } catch (error) {
                    console.log(
                        `[tick:${stage.name}] ${
                            error instanceof Error ? error.message : String(error)
                        }`
                    )
                    // 前置阶段失败时停止本 tick，由 ErrorMapper 保留原始堆栈。
                    throw error
                }
            }
        } finally {
            // 失败阶段也已采样，按周期汇总；统计自身不会覆盖业务异常。
            if (profiling) finishCpuProfilingTick()
        }
    }
}
