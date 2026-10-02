/** Shared squad decisions and path-search limits; native attack ranges and formation geometry stay fixed. */
export const combatTacticsPolicy = {
    retreatHealthRatio: 0.45,
    retreatBufferTicks: 3,
    retreatHysteresisTicks: 5,
    rangedKiteDistance: 3,
    massAttackAdvantage: 1.05,
    maximumEngagementTicks: 25,
    stateRetentionTicks: 10,
    path: { maxRooms: 16, maxOps: 2000, plainCost: 2, swampCost: 10, breachCost: 20 },
    formation: { anchorSearchRange: 2, borderRegroupMargin: 2, roomRallyRange: 10 },
    healing: { squadPriorityMultiplier: 2 },
    targeting: {
        tower: 0, healer: 1, fighter: 2, spawnOrCore: 3, civilian: 5, otherStructure: 6, barrier: 12,
        priorityWeight: 100, rangeWeight: 5, hitsScale: 1000, maximumHitsPenalty: 50,
    },
    movementDangerWeight: 100,
}
