interface HarvestRate {
    id: Id<Creep>
    hits: number
    hitsMax: number
    expiry: number | undefined
    tier: CreepBoostTier | undefined
    completed: boolean | undefined
    power: number
    lastSeen: number
}

let tick: number | undefined
let shard: string | undefined
let lastCleanup: number | undefined
let rates = new Map<string, HarvestRate>()

function sync(): void {
    if (tick === Game.time && shard === Game.shard?.name) return
    if (shard !== Game.shard?.name || (tick !== undefined && Game.time < tick)) {
        rates = new Map(); lastCleanup = undefined
    }
    tick = Game.time; shard = Game.shard?.name
    if (lastCleanup === undefined || Game.time - lastCleanup >= CREEP_LIFE_TIME) {
        for (const [name, rate] of rates) if (Game.time - rate.lastSeen >= CREEP_LIFE_TIME) rates.delete(name)
        lastCleanup = Game.time
    }
}

/** Scalar RAM cache only: healthy fixed bodies need no per-tick body or getActiveBodyparts scan. */
export function getHarvestPower(creep: Creep): number {
    sync()
    const expiry = creep.ticksToLive === undefined ? undefined : Game.time + creep.ticksToLive
    const plan = creep.memory.boostPlan
    const previous = rates.get(creep.name)
    const healthy = creep.hits === creep.hitsMax
    if (previous !== undefined && previous.id === creep.id && previous.hits === creep.hits && previous.hitsMax === creep.hitsMax &&
        previous.expiry === expiry && previous.tier === plan?.tier && previous.completed === plan?.completed &&
        (healthy || previous.lastSeen === Game.time)) {
        previous.lastSeen = Game.time
        return previous.power
    }
    let power = 0
    for (const part of creep.body) {
        if (part.type !== WORK || part.hits <= 0) continue
        const boost = part.boost ? BOOSTS[WORK][part.boost] as { harvest?: number } | undefined : undefined
        power += HARVEST_POWER * (boost?.harvest || 1)
    }
    rates.set(creep.name, { id: creep.id, hits: creep.hits, hitsMax: creep.hitsMax, expiry,
        tier: plan?.tier, completed: plan?.completed, power, lastSeen: Game.time })
    return power
}
