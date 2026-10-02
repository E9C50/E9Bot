import { aidBuilderPolicy } from 'settings/aidBuilder'

export interface BuilderEnergyOptions {
    sources?: readonly Source[]
    stores?: readonly AnyStoreStructure[]
}

type EnergyCandidate = {
    target: Resource | AnyStoreStructure | Source
    action: 'pickup' | 'withdraw' | 'harvest'
    distance: number
}

function loadingState(creep: Creep): AidBuilderEnergyState {
    let state = creep.memory.aidBuilderEnergy
    if (state === undefined || state.shard !== Game.shard.name || state.roomName !== creep.room.name || state.tick > Game.time) {
        state = { shard: Game.shard.name, roomName: creep.room.name, tick: Game.time, blocked: [] }
        creep.memory.aidBuilderEnergy = state
    }
    state.tick = Game.time
    state.blocked = state.blocked.filter(target => target.until > Game.time)
    return state
}

/** Observe real Store amounts; issuing an intent never changes the loading phase this tick. */
export function updateBuilderEnergyPhase(creep: Creep): void {
    const state = loadingState(creep)
    const energy = creep.store[RESOURCE_ENERGY]
    if (energy === 0) {
        creep.memory.working = false
        delete state.loadStarted
        return
    }
    if (creep.memory.working) {
        delete state.loadStarted
        delete state.active
        return
    }
    if (state.loadStarted === undefined) state.loadStarted = Game.time
    const capacity = creep.store.getCapacity(RESOURCE_ENERGY) || 0
    if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0 || capacity > 0 &&
        energy >= capacity * aidBuilderPolicy.minimumLoadFraction || Game.time - state.loadStarted >= aidBuilderPolicy.partialLoadWait) {
        creep.memory.working = true
        delete state.loadStarted
        delete state.active
    }
}

function blocked(state: AidBuilderEnergyState, id: string): boolean {
    return state.blocked.some(target => target.targetId === id)
}

function coolTarget(state: AidBuilderEnergyState, id: string): void {
    state.blocked = state.blocked.filter(target => target.targetId !== id)
    state.blocked.push({ targetId: id, until: Game.time + aidBuilderPolicy.retryDelay })
    if (state.blocked.length > aidBuilderPolicy.maximumBlockedTargets) {
        state.blocked.splice(0, state.blocked.length - aidBuilderPolicy.maximumBlockedTargets)
    }
    if (state.active?.targetId === id) delete state.active
}

function targetProgress(creep: Creep, state: AidBuilderEnergyState, id: string): boolean {
    const previous = state.active
    if (previous?.targetId !== id) {
        state.active = { targetId: id, x: creep.pos.x, y: creep.pos.y, energy: creep.store[RESOURCE_ENERGY], progressTick: Game.time }
        return true
    }
    if (previous.x !== creep.pos.x || previous.y !== creep.pos.y || creep.store[RESOURCE_ENERGY] > previous.energy || creep.fatigue > 0) {
        previous.progressTick = Game.time
    }
    previous.x = creep.pos.x
    previous.y = creep.pos.y
    previous.energy = creep.store[RESOURCE_ENERGY]
    if (Game.time - previous.progressTick < aidBuilderPolicy.stuckTicks) return true
    coolTarget(state, id)
    return false
}

/** Keep only the nearest bounded candidates; ties retain the native list order. */
function addCandidate(creep: Creep, state: AidBuilderEnergyState, queue: EnergyCandidate[], target: EnergyCandidate['target'], action: EnergyCandidate['action']): void {
    if (target.pos.roomName !== creep.room.name || blocked(state, target.id)) return
    const distance = Math.max(Math.abs(creep.pos.x - target.pos.x), Math.abs(creep.pos.y - target.pos.y))
    let index = 0
    while (index < queue.length && queue[index].distance <= distance) index++
    if (index >= aidBuilderPolicy.maximumTargets) return
    queue.splice(index, 0, { target, action, distance })
    if (queue.length > aidBuilderPolicy.maximumTargets) queue.pop()
}

function mainStores(creep: Creep): AnyStoreStructure[] {
    const stores: AnyStoreStructure[] = []
    for (const target of [creep.room.storage, creep.room.terminal]) {
        if (target !== undefined && target.my !== false) stores.push(target)
    }
    return stores
}

function acquire(creep: Creep, options: BuilderEnergyOptions, storesEnabled: boolean): boolean {
    const free = creep.store.getFreeCapacity(RESOURCE_ENERGY)
    if (!(free > 0)) return false
    const state = loadingState(creep)
    const threshold = Math.min(free, aidBuilderPolicy.minimumDroppedEnergy)
    const drops: EnergyCandidate[] = [], containers: EnergyCandidate[] = [], stores: EnergyCandidate[] = [], tiny: EnergyCandidate[] = [], sources: EnergyCandidate[] = []
    for (const target of creep.room.droppedResource || creep.room.find(FIND_DROPPED_RESOURCES)) {
        if (target.resourceType === RESOURCE_ENERGY && target.amount > 0) {
            addCandidate(creep, state, target.amount >= threshold ? drops : tiny, target, 'pickup')
        }
    }
    for (const target of creep.room.containers) {
        if (target.store[RESOURCE_ENERGY] > 0 && (!('my' in target) || target.my !== false)) addCandidate(creep, state, containers, target, 'withdraw')
    }
    for (const target of options.stores || mainStores(creep)) {
        if (target !== undefined && target.store[RESOURCE_ENERGY] > 0) addCandidate(creep, state, stores, target, 'withdraw')
    }
    if (storesEnabled) {
        for (const target of options.sources || creep.room.sources) {
            if (target.energy > 0) addCandidate(creep, state, sources, target, 'harvest')
        }
    }

    let attempted = 0
    const tried = new Set<string>()
    // Small fragments are useful only after reliable stocks have been exhausted or rejected.
    const queues = storesEnabled ? [drops, containers, stores, tiny, sources] : [drops, containers, tiny]
    for (const queue of queues) {
        if (!storesEnabled && queue === tiny && stores.some(candidate => !blocked(state, candidate.target.id))) break
        for (const candidate of queue) {
            const id = candidate.target.id
            if (tried.has(id) || blocked(state, id) || !targetProgress(creep, state, id)) continue
            if (attempted >= aidBuilderPolicy.maximumTargets) return false
            tried.add(id)
            attempted++
            const result = candidate.action === 'pickup' ? creep.pickup(candidate.target as Resource) :
                candidate.action === 'withdraw' ? creep.withdraw(candidate.target as AnyStoreStructure, RESOURCE_ENERGY) :
                    creep.harvest(candidate.target as Source)
            if (result === OK) return true
            if (result === ERR_NOT_IN_RANGE) {
                // Fatigue is temporary and does not make an otherwise valid energy source unreachable.
                if (creep.fatigue > 0 || creep.moveTo(candidate.target, { range: 1 }) === OK) return true
            }
            coolTarget(state, id)
        }
    }
    return false
}

/** Preserve the shared pickup/container helper for callers that own their remaining fallbacks. */
export function collectBuilderEnergy(creep: Creep): boolean {
    return acquire(creep, {}, false)
}

/** A single retry budget covers loose energy, containers, stores, and direct harvesting. */
export function acquireBuilderEnergy(creep: Creep, options: BuilderEnergyOptions = {}): boolean {
    return acquire(creep, options, true)
}
