/** Opposing energy carriers hand off a whole load without swapping their spawn identities. */
export const haulerRelayPolicy = {
    enabled: true,
    minimumBucket: 1000,
    minimumCpuHeadroom: 3,
    maximumCpu: 1.5,
    maximumPairsPerTick: 4,
    minimumTicksToLive: 50,
    endpointRange: 2,
    sourceGoalRange: 3,
    statisticsWindow: 100,
}
