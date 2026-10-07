import { addCreepConfig, createCreepName } from './demand'
import { previewCreepBody } from './bodyPlanner'
import { energyCarryCapacity } from './bodyEffectiveness'
import { hasUsableStorageFiller, isMatureStorageFiller, recyclableDisabledStorageFiller,
    storageFillerNames, usableStorageFiller } from './storageFillerLifecycle'

/** Publish at most one resident and one full-body successor; reuse the vacated slot next time. */
export function releaseStorageFillerConfig(room: Room): void {
    const names = storageFillerNames(room), data: FillerData = { sourceId: room.storage!.id }
    const config = { role: 'filler', name: names[0], spawnRoom: room.name, data } as CreepMemory
    if (!isMatureStorageFiller(room, config)) {
        addCreepConfig(room, 'filler', names[0], data)
        return
    }
    const residents = names.map(name => Game.creeps[createCreepName('filler', name)])
        .filter((creep): creep is Creep => creep !== undefined)
    let state = room.memory.storageFillerHandover
    if (residents.length === 0) {
        const active = state?.replacement && names.includes(state.replacement) ? state.replacement :
            state && names.includes(state.active) ? state.active : names[0]
        if (state) room.memory.storageFillerHandover = { active }
        addCreepConfig(room, 'filler', active, data)
        return
    }
    if (!state || !names.includes(state.active) || state.replacement && !names.includes(state.replacement)) {
        const resident = residents.find(creep => usableStorageFiller(room, creep)) || residents[0]
        state = room.memory.storageFillerHandover = { active: resident.memory.name }
    }
    let current = residents.find(creep => creep.memory.name === state!.active)
    const successor = residents.find(creep => creep.memory.name === state!.replacement)
    // The explicit successor takes over even when a changed body profile made it smaller than its predecessor.
    if (state.replacement && (!current || successor && usableStorageFiller(room, successor))) {
        state.active = state.replacement
        delete state.replacement
        current = successor
    }
    if (!current && !state.replacement) {
        const survivor = residents.find(creep => usableStorageFiller(room, creep)) || residents[0]
        if (survivor) { state.active = survivor.memory.name; current = survivor }
    }
    const vacancy = residents.length === 2 && !hasUsableStorageFiller(room) ?
        successor && recyclableDisabledStorageFiller(room, successor) ? successor :
        residents.find(creep => recyclableDisabledStorageFiller(room, creep)) : undefined
    if (vacancy) {
        state.active = residents.find(creep => creep !== vacancy)!.memory.name
        state.replacement = vacancy.memory.name
    }
    addCreepConfig(room, 'filler', state.active, data)
    if (state.replacement) {
        // With both slots disabled, let one empty mobile wreck vacate before reusing its fixed birth name.
        if (vacancy) return
        // Preserve the same paid-for birth/boost and its old worker across every demand refresh.
        addCreepConfig(room, 'filler', state.replacement, data)
        return
    }
    // A previous worker can still be unloading/recycling; never create a third overlapping carrier.
    if (!current || residents.some(creep => creep !== current) || current.spawning) return
    const boost = current.memory.boostPlan
    if (boost?.steps.length && !boost.completed && !boost.failed && hasUsableStorageFiller(room)) return
    const plan = previewCreepBody(room, config, 0)
    const carryCapacity = plan.body.filter(part => part === CARRY).length * CARRY_CAPACITY
    const severelyUndersized = carryCapacity > 0 && energyCarryCapacity(current) * 3 <= carryCapacity
    const nearingDeath = current.ticksToLive !== undefined &&
        current.ticksToLive <= plan.body.length * CREEP_SPAWN_TIME + 25
    if (plan.body.length > 0 && (!usableStorageFiller(room, current) || severelyUndersized || nearingDeath)) {
        state.replacement = names.find(name => name !== current!.memory.name)!
        addCreepConfig(room, 'filler', state.replacement, data)
    }
}
