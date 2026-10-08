/** Tick、CPU 与环境配置。默认值沿用现有运行策略。 */
export const runtimePolicy = {
    // 沿用原有全帝国暂停规则；设为 room 时仅暂停受攻击房间。
    warModeScope: 'empire' as 'empire' | 'room',
    pixel: { enabled: true, minimumBucket: 10000, excludedShards: ['shard3'] },
    cpuHistory: { shards: ['shard3'], sampleCount: 100 },
    // 默认保留原任务周期；降频仅作为手动开启的临时应急选项。
    cpuRecovery: {
        enabled: false,
        minimumBucket: 1000,
        shards: [] as string[],
        intervals: {
            mineral: 5,
            powerSpawn: 10,
            factory: 25,
            labReaction: 5,
            labPlanning: 100,
            market: 250,
        },
    },
    profiling: {
        enabled: true,
        // 空列表表示所有 shard；可指定 shard 名限制测量范围。
        shards: [] as string[],
        // 所有模块共用最近 N tick 的窗口；未运行的 tick 计零。
        windowSize: 100,
        logEnabled: true,
        logInterval: 100,
        // 详情是顶层阶段内部的耗时，日志中独立分组，不能重复相加。
        logDetails: true,
        roleDetails: true,
        // 单个 creep 的实时警告单独开启，日常仅聚合同角色耗时。
        creepDetails: false,
        creepWarningCpu: 0.8,
        emaAlpha: 0.1,
        maximumEntries: 100,
        topCount: 10,
    },
    privateServer: {
        shard: 'b7b7cfd29cac',
        enabled: true,
        interval: 10,
        targetEnergy: 500000,
        maximumPurchase: 100000,
    },
}
