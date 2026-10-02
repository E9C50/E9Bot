/** Aid workers should start useful work without waiting indefinitely for a full load. */
export const aidBuilderPolicy = {
    minimumDroppedEnergy: 50,
    minimumLoadFraction: 0.8,
    partialLoadWait: 25,
    stuckTicks: 5,
    retryDelay: 25,
    maximumTargets: 4,
    maximumBlockedTargets: 8,
}
