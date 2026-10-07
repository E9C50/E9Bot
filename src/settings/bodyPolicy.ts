/** 身体策略只描述需求和比例；成本、强化效果与部件上限由原生规则计算。 */
export const bodyPolicy = {
    matureRoadLevel: 8,
    terrainFatigue: { road: 1, plain: 2, swamp: 10 },
    boost: { timeoutTicks: 300, logFailures: true },
    economy: {
        maximumWorkerWorkParts: 20,
        mobileCarryPerWork: 2,
        mobileUpgraderCarryPerWork: 1,
        stationaryEnergyTicks: 4,
        sourceCarryBatches: 2,
        minimumCarryParts: 1,
        // A stationary mature hub uses the full native body: 49 CARRY + 1 MOVE.
        managerCarryParts: 49,
        maximumMineralWorkParts: 20,
        mineralCarryPerWork: 0.5,
        mineralTravelMargin: 1.3,
        mineralFallbackRoundTripTicks: 40,
        mineralTravelToHarvestRatio: 3,
        maximumReserverClaimParts: 2,
        reservationUrgencyTicks: 1000,
    },
    combat: {
        maximumPrimaryParts: 40,
        maximumControllerAttackParts: 19,
        toughPerPrimary: 0.25,
        attackerHealPerPrimary: 1 / 6,
        integrateHealPerPrimary: 0.5,
    },
    /** 本地防守默认立即使用原生身体；进攻自动选择可准备的最高强化等级。 */
    automaticBoostRoles: ['attacker', 'healer', 'dismantler', 'integrate'] as CreepRoleConstant[],
    remoteRoles: ['rHarvester', 'rFiller', 'rBuilder', 'reserver', 'claimer',
        'sClaimer', 'sBuilder', 'sHauler', 'sScout', 'attacker', 'healer',
        'dismantler', 'integrate', 'cAttacker', 'defender', 'rdefender'] as CreepRoleConstant[],
    profiles: {} as Partial<Record<CreepRoleConstant, CreepBodyProfile>>,
}
