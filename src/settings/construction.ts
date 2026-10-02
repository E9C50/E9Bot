/** 自动规划和补建策略。游戏规定的 RCL 配额、全局工地上限仍使用原生常量。 */
export const constructionPolicy = {
    enabled: true,
    planning: {
        minimumBucket: 2000,
        minimumCpuHeadroom: 150,
        cpuReserve: 50,
        maximumCpu: 300,
        maximumRoomsPerTick: 1,
        retryInterval: 100,
        minimumPlaneCount: 140,
    },
    building: {
        interval: 10,
        staggerMatureInspections: true,
        lowBucketInspection: { minimumBucket: 1000, interval: 100 },
        maximumNewSitesPerRoom: 5,
        maximumActiveSitesPerRoom: 10,
        roadMinimumLevel: 3,
        rampartMinimumLevel: 4,
        mineralContainerMinimumLevel: 6,
    },
    structurePriority: [
        'spawn', 'container', 'extension', 'tower', 'storage', 'link',
        'terminal', 'lab', 'extractor', 'factory', 'powerSpawn', 'observer',
        'nuker', 'road', 'rampart', 'constructedWall',
    ] as BuildableStructureConstant[],
}
