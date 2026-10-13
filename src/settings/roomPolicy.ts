/** 房间调度与资源策略。旗帜名称默认沿用现有控制协议。 */
export const roomPolicy = {
    flags: {
        updateCache: 'updateCache',
        planCenter: 'planRoomCenter',
        planStructures: 'planRoomStructure',
        layoutPreview: 'layout',
        managerPosition: 'managerPos',
        centerPosition: 'centerPos',
        repairTower: 'repairTower',
        sourceLab1: 'lab1',
        sourceLab2: 'lab2',
    },
    layout: {
        baseSize: 13,
        borderMargin: 2,
    },
    labs: {
        updateInterval: 10,
        staggerUpdates: true,
        minimumReactionReagent: 1000,
    },
    terminal: {
        energyReserve: 50000,
        centerGhodiumReserve: 6000,
        maximumSendAmount: 100000,
        energyExportThreshold: 400000,
        energyImportThreshold: 300000,
        energyTransferAmount: 50000,
        distributionMinimumLevel: 8,
        distributionInterval: 30,
        // 保持每房的分发周期，按稳定房名分散到不同 tick。
        staggerDistribution: true,
        logTransfers: false,
        mineralReserve: 10000,
        refillRatio: 0.8,
        surplusRatio: 1.2,
        centerResourceReserve: 5000,
    },
    market: {
        scanInterval: 25,
        staggerScans: true,
        ordinaryEnergyStorageReserve: 400000,
        warehouseEnergyStorageReserve: 1000000,
        energyMaximumSaleAmount: 100000,
        maximumDealsPerTick: 10,
        defaultMinimumPrice: 20,
        defaultSaleAmount: 10000,
        energyValue: 20,
        minimumOrderAmount: 100,
    },
    defense: {
        // 保持原有效行为：默认每 tick 扫描。调大仅影响非战争房间。
        enemyScanInterval: 1,
        notificationInterval: 10,
        costMatrixRefreshInterval: 1000,
        minimumRoadDamage: 200,
        minimumRoadDamageFraction: 0.05,
        criticalRoadHealthFraction: 0.5,
        // 道路微伤攒至一次原生塔维修量；危急道路仍立即维修。
        batchRoadRepair: true,
        roadRepairPowerRatio: 1,
        // 和平自有 RCL8 低 bucket：已知损伤每 tick 检查，新损伤最多 10 tick 才发现。
        lowBucketRoadInspectionInterval: 10,
        roadInspectionBucket: 1000,
        npcOwners: ['Invader', 'Source Keeper'],
        invaderOwner: 'Invader',
    },
    profiling: {
        enabled: false,
        shard: 'shard3',
        minimumCpu: 1,
        decimalPlaces: 2,
    },
}

export interface ResourceSalePolicy {
    resourceType: ResourceConstant
    threshold: number
    minPrice: number
    sellAmount: number
}

/** 非能量自动出售规则；能量统一按普通房 400k / 仓库房 1M 留存备货出售。 */
export const roomResourceSales: ResourceSalePolicy[] = []

export const centerResourceSales: ResourceSalePolicy[] = [
    {
        resourceType: RESOURCE_KEANIUM,
        threshold: 300000,
        minPrice: 10,
        sellAmount: 5000,
    },
    {
        resourceType: RESOURCE_LEMERGIUM,
        threshold: 300000,
        minPrice: 10,
        sellAmount: 5000,
    },
    {
        resourceType: RESOURCE_OXYGEN,
        threshold: 300000,
        minPrice: 1,
        sellAmount: 5000,
    },
    {
        resourceType: RESOURCE_HYDROGEN,
        threshold: 300000,
        minPrice: 1,
        sellAmount: 5000,
    },
    {
        resourceType: RESOURCE_ZYNTHIUM,
        threshold: 300000,
        minPrice: 0.001,
        sellAmount: 5000,
    },
    {
        resourceType: RESOURCE_UTRIUM,
        threshold: 300000,
        minPrice: 10,
        sellAmount: 5000,
    },
    {
        resourceType: RESOURCE_CATALYST,
        threshold: 300000,
        minPrice: 10,
        sellAmount: 5000,
    },
    {
        resourceType: RESOURCE_OPS,
        threshold: 300000,
        minPrice: 0.001,
        sellAmount: 5000,
    },
    {
        resourceType: RESOURCE_ZYNTHIUM_KEANITE,
        threshold: 300000,
        minPrice: 0.001,
        sellAmount: 5000,
    },
    {
        resourceType: RESOURCE_GHODIUM_OXIDE,
        threshold: 300000,
        minPrice: 0.001,
        sellAmount: 5000,
    },
    {
        resourceType: RESOURCE_KEANIUM_OXIDE,
        threshold: 300000,
        minPrice: 0.001,
        sellAmount: 5000,
    },
]

/** 中央仓库终端留存的资源种类，与出售规则独立配置。 */
export const centerTerminalResources: ResourceConstant[] = [
    RESOURCE_KEANIUM,
    RESOURCE_LEMERGIUM,
    RESOURCE_OXYGEN,
    RESOURCE_HYDROGEN,
    RESOURCE_ZYNTHIUM,
    RESOURCE_UTRIUM,
    RESOURCE_CATALYST,
    RESOURCE_OPS,
    RESOURCE_ZYNTHIUM_KEANITE,
    RESOURCE_GHODIUM_OXIDE,
    RESOURCE_KEANIUM_OXIDE,
]
