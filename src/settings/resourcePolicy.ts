/** 跨房间库存目标；资源常备量指全房可用库存，终端仅准备当前发送批次。 */
export const t3Resources: MineralBoostConstant[] = [
    'XUH2O', 'XUHO2', 'XKH2O', 'XKHO2', 'XLH2O',
    'XLHO2', 'XZH2O', 'XZHO2', 'XGH2O', 'XGHO2',
]
export const basicMinerals: ResourceConstant[] = ['H', 'O', 'U', 'L', 'K', 'Z', 'X']
export const intermediateResources: ResourceConstant[] = [
    'OH', 'ZK', 'UL', 'UH', 'UO', 'KH', 'KO', 'LH', 'LO', 'ZH', 'ZO', 'GH', 'GO',
    'UH2O', 'UHO2', 'KH2O', 'KHO2', 'LH2O', 'LHO2', 'ZH2O', 'ZHO2', 'GH2O', 'GHO2',
]
export const compressedMinerals: Partial<Record<ResourceConstant, ResourceConstant>> = {
    H: 'reductant', O: 'oxidant', U: 'utrium_bar', L: 'lemergium_bar',
    K: 'keanium_bar', Z: 'zynthium_bar', X: 'purifier', G: 'ghodium_melt',
}
export const resourcePolicy = {
    terminalEnergyReserve: 50000,
    warehouseCapacity: 8000000,
    warehouseRawMineralReserve: 300000,
    minedMineralReserve: 300000,
    t3Reserve: 20000,
    basicMineralReserve: 10000,
    ghodiumReserve: 10000,
    opsReserve: 5000,
    intermediateReserve: 20000,
    powerReserve: 3000,
    maximumSendAmount: 100000,
    minimumSendAmount: 1000,
    warehouseBalanceTolerance: 1000,
    distributionInterval: 30,
    recoveryDistribution: { interval: 150, phase: 1, minimumBucket: 100, minimumHeadroom: 14 },
    terminalFreeReserve: 10000,
}

export function ordinaryResourceTarget(resource: ResourceConstant): number {
    if (t3Resources.includes(resource as MineralBoostConstant)) return resourcePolicy.t3Reserve
    if (basicMinerals.includes(resource)) return resourcePolicy.basicMineralReserve
    if (resource === 'G') return resourcePolicy.ghodiumReserve
    if (resource === 'ops') return resourcePolicy.opsReserve
    if (resource === 'power') return resourcePolicy.powerReserve
    return 0
}

export function ordinaryResourceKeep(resource: ResourceConstant): number {
    return intermediateResources.includes(resource) ? resourcePolicy.intermediateReserve : ordinaryResourceTarget(resource)
}

/** Ordinary rooms accumulate their own mineral before exporting or compressing it. */
export function ordinaryRoomResourceKeep(room: Room, resource: ResourceConstant): number {
    const keep = ordinaryResourceKeep(resource)
    return room.mineral?.mineralType === resource ? Math.max(keep, resourcePolicy.minedMineralReserve) : keep
}
