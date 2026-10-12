/** Build the transport lanes of admitted mines without competing with their first income. */
export const remoteRoadPolicy = {
    enabled: true,
    minimumHomeLevel: 3,
    minimumBucket: 1000,
    minimumCpuHeadroom: 10,
    maximumPlanningCpu: 2,
    maximumPathSearchesPerTick: 1,
    maximumRouteRooms: 4,
    maximumPathOps: 4000,
    replanInterval: 2500,
    retryInterval: 100,
    constructionInterval: 25,
    maximumNewSitesPerTick: 3,
    freeSitesForLocalConstruction: 20,
    repairRatio: 0.5,
    builderPriority: 4.5,
    repairPriority: 2.58,
}
