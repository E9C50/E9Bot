/** 房间防御策略；距离为格、时间为 tick，伤害按实际身体减伤后计算。 */
export const combatDefensePolicy = {
    towers: {
        criticalHealthRatio: 0.4,
        guardedHealthRatio: 0.75,
        predictedHealMovement: true,
    },
    guards: {
        groupMemoryTicks: 100,
        positionSlack: 2,
        reusePath: 5,
    },
    threat: { healingWeight: 2, claimWeight: 100, guardDistanceWeight: 10 },
    pursuit: {
        enabled: true,
        maximumRange: 3,
        maximumTicks: 8,
        minimumHealthRatio: 0.9,
        retreatHealthRatio: 0.7,
        maximumDamageFraction: 0.2,
        reactionTicks: 2,
        criticalEntranceRange: 1,
        requireTowerSupport: true,
        maximumSearchNodes: 64,
    },
}
