/** 原型适配层使用的建筑补给、生产和缓存策略。 */
export const structurePolicy = {
    tower: { refillFreeCapacity: 100 },
    powerSpawn: {
        refillEnergyFreeCapacity: 1000,
        refillPowerFreeCapacity: 90,
        minimumStorageEnergy: 50000,
    },
    link: { edgeMargin: 3, minimumTargetFreeCapacity: 10 },
    lab: {
        jobInterval: 10,
        outputMineralThreshold: 1000,
        sourceFreeCapacity: 1000,
    },
    creep: { minimumDroppedResource: 100, minimumBoostMineral: 100 },
    defense: {
        wallTargetHits: 300000000,
        costMatrixInterval: 10,
        minimumBucket: 100,
    },
    dashboard: {
        minerals: { low: 10000, high: 100000 },
        ops: { low: 1000, high: 2000 },
        compounds: { low: 5000, high: 20000 },
    },
}
