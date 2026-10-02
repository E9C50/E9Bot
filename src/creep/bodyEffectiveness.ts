/** Energy income uses harvest boosts; consumer energy budgets still use actual WORK. */
export function harvestWorkParts(creep: Creep): number {
    let work = creep.getActiveBodyparts(WORK)
    if (!creep.body) return work
    for (const part of creep.body) if (part.boost && part.type === WORK && part.hits !== 0) {
        const effect = typeof BOOSTS !== 'undefined' ? BOOSTS[WORK]?.[part.boost] as { harvest?: number } | undefined : undefined
        work += (effect?.harvest || 1) - 1
    }
    return work
}

export function energyCarryCapacity(creep: Creep): number {
    const capacity = creep.store?.getCapacity?.(RESOURCE_ENERGY)
    if (typeof capacity === 'number' && Number.isFinite(capacity)) return Math.max(0, capacity)
    return creep.getActiveBodyparts(CARRY) * CARRY_CAPACITY
}
