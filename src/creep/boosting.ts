import { boostBodyPart, boostConfig, roleBoostConfig } from 'settings/boost'
import { bodyPolicy } from 'settings/bodyPolicy'
import { combatSpawnAllowed } from 'combat/spawning'

type BoostStep = CreepBoostPlan['steps'][number]
export interface BoostRequest extends BoostStep { priority: number }

interface BodyBoostCounts {
    unboosted: Partial<Record<BodyPartConstant, number>>
    boosted: Partial<Record<ResourceConstant, number>>
}

function countBody(creep: Creep): BodyBoostCounts {
    const result: BodyBoostCounts = { unboosted: {}, boosted: {} }
    for (const part of creep.body) {
        if (part.hits === 0) continue
        if (part.boost) result.boosted[part.boost] = (result.boosted[part.boost] || 0) + 1
        else {
            const type = part.type
            result.unboosted[type] = (result.unboosted[type] || 0) + 1
        }
    }
    return result
}

function validPlan(plan: CreepBoostPlan): boolean {
    if (plan == undefined || ![0, 1, 2, 3].includes(plan.tier) || !Array.isArray(plan.steps)) return false
    if (plan.tier === 0) return plan.steps.length === 0
    const types = new Set<BodyPartConstant>()
    for (const step of plan.steps) {
        const part = boostBodyPart[step.type]
        if (part == undefined || types.has(part) || boostConfig[step.type]?.[plan.tier - 1] !== step.resource ||
            !Number.isInteger(step.parts) || step.parts <= 0 || step.parts > MAX_CREEP_SIZE) return false
        types.add(part)
    }
    return true
}

function legacyPlan(creep: Creep, counts: BodyBoostCounts): CreepBoostPlan {
    const steps: BoostStep[] = [], selected = new Set<BodyPartConstant>()
    for (const type of roleBoostConfig[creep.memory.role] || []) {
        const part = boostBodyPart[type]
        const resource = boostConfig[type]?.[2]
        if (part == undefined || resource == undefined || selected.has(part)) continue
        selected.add(part)
        const unboosted = counts.unboosted[part] || 0
        // remainingSteps subtracts matching boosts, so retain their total in the target.
        if (unboosted > 0) steps.push({ type, resource, parts: unboosted + (counts.boosted[resource] || 0) })
    }
    return { tier: steps.length > 0 ? 3 : 0, steps }
}

function remainingSteps(plan: CreepBoostPlan, counts: BodyBoostCounts): BoostStep[] {
    return plan.steps.map(step => ({ ...step, parts: Math.max(0, step.parts - (counts.boosted[step.resource] || 0)) }))
        .filter(step => step.parts > 0)
}

let currentTick: number | undefined
let currentShard: string | undefined
type RoomMember = { name: string; creep: Creep }
let rawMembers: RoomMember[] | undefined
let creepsByRoom = new Map<string, Array<{ name: string; creep: Creep }>>()
let indexed = false
let boostCreepsByRoom = new Map<string, RoomMember[]>()
let boostIndexed = false
let reservations = new Map<string, { roomName: string; plan: CreepBoostPlan;
    combat?: Pick<CreepMemory, 'combatTaskId' | 'combatGeneration' | 'combatJob'> }>()
let claimedLabs = new Set<string>()
let attemptedCreeps = new Set<string>()

function syncTick(): void {
    if (currentTick === Game.time && currentShard === Game.shard.name) return
    currentTick = Game.time; currentShard = Game.shard.name
    rawMembers = undefined; creepsByRoom = new Map(); indexed = false; boostCreepsByRoom = new Map(); boostIndexed = false
    reservations = new Map(); claimedLabs = new Set(); attemptedCreeps = new Set()
}

function dismantleBoostAllowed(memory: CreepMemory): boolean {
    const state = memory.targetDismantle?.controlState
    return state === undefined || state === 'active'
}

/** Task control runs after room planning. Rebuild only the boost index from this tick's cached members. */
export function invalidateBoostRequestIndex(): void {
    syncTick()
    boostCreepsByRoom = new Map(); boostIndexed = false
}

function roomCreeps(roomName: string, boostOnly = false): RoomMember[] {
    syncTick()
    if (rawMembers === undefined) {
        rawMembers = []
        for (const name in Game.creeps) {
            rawMembers.push({ name, creep: Game.creeps[name] })
        }
    }
    const index = boostOnly ? boostCreepsByRoom : creepsByRoom
    if (!(boostOnly ? boostIndexed : indexed)) {
        for (const member of rawMembers) {
            const { creep } = member
            // Ordinary native bodies never need room getters or body scans for Lab demand.
            // The separate full index still retains them for real logistics preflight.
            if (boostOnly && (!dismantleBoostAllowed(creep.memory) ||
                (creep.memory.boostPlan ? !pendingLabPlan(creep.memory.boostPlan) : !roleBoostConfig[creep.memory.role]?.length))) continue
            const home = creep.memory.spawnRoom || creep.room.name
            const group = index.get(home)
            if (group == undefined) index.set(home, [member])
            else group.push(member)
        }
        if (boostOnly) boostIndexed = true
        else indexed = true
    }
    return index.get(roomName) || []
}

/** Current live bodies and accepted spawn intents only; old catalogs never reserve forever. */
export function getRoomBoostRequests(room: Room, excludePlan?: CreepBoostPlan): BoostRequest[] {
    const members = roomCreeps(room.name, true)
    const result: BoostRequest[] = []
    const liveNames = reservations.size > 0 ? new Set<string>() : undefined
    for (const { name, creep } of members) {
        liveNames?.add(name)
        if (!dismantleBoostAllowed(creep.memory)) continue
        const stored = creep.memory.boostPlan
        if ((excludePlan != undefined && stored === excludePlan) || stored?.completed || stored?.failed) continue
        if (stored?.tier === 0 && stored.steps?.length === 0) continue
        if (stored == undefined && !(roleBoostConfig[creep.memory.role]?.length)) continue
        const counts = countBody(creep)
        const plan = stored || legacyPlan(creep, counts)
        if (!validPlan(plan)) continue
        for (const step of remainingSteps(plan, counts)) result.push({ ...step, priority: stored == undefined ? 2 : 0 })
    }
    for (const [name, reservation] of reservations) {
        if (reservation.roomName != room.name || liveNames?.has(name) || Game.creeps[name] || reservation.plan === excludePlan ||
            room.memory.creepConfig?.[name] && !dismantleBoostAllowed(room.memory.creepConfig[name])) continue
        for (const step of reservation.plan.steps) result.push({ ...step, priority: 1 })
    }
    return result
}

function pendingLabPlan(plan: CreepBoostPlan): boolean {
    return validPlan(plan) && !plan.completed && !plan.failed && plan.steps.length > 0 &&
        !(plan.startedAt !== undefined && Game.time - plan.startedAt >= bodyPolicy.boost.timeoutTicks)
}

/** Lab ownership includes approved future fighters, but spawn preflight keeps its original live-only accounting. */
export function getActiveRoomBoostRequests(room: Room): BoostRequest[] {
    const approved = typeof Memory === 'undefined' ? [] : Object.values(Memory.combatTasks || {}).filter(task =>
        task.homeRoom === room.name && task.plan !== undefined && combatSpawnAllowed({
            combatTaskId: task.id, combatGeneration: task.generation, combatJob: 'fighter',
        } as CreepMemory))
    const result: BoostRequest[] = []
    const seen = reservations.size > 0 || approved.length > 0 ? new Set<string>() : undefined
    for (const { name, creep } of roomCreeps(room.name, true)) {
        seen?.add(name)
        if (!dismantleBoostAllowed(creep.memory)) continue
        const stored = creep.memory.boostPlan
        if (stored && !pendingLabPlan(stored)) continue
        if (!stored && !roleBoostConfig[creep.memory.role]?.length) continue
        // Old flag war roles now retire instead of calling their former prepare boost hook.
        if (!stored && !creep.memory.combatTaskId && ['attacker', 'healer', 'dismantler', 'integrate', 'rAttacker', 'cAttacker'].includes(creep.memory.role)) continue
        if (!combatSpawnAllowed(creep.memory) || creep.room.name !== room.name) continue
        const counts = countBody(creep), plan = stored || legacyPlan(creep, counts)
        if (!pendingLabPlan(plan)) continue
        for (const step of remainingSteps(plan, counts)) result.push({ ...step, priority: stored ? 0 : 2 })
    }
    for (const [name, reservation] of reservations) {
        if (reservation.roomName !== room.name || seen?.has(name) || Game.creeps[name] || !pendingLabPlan(reservation.plan) ||
            reservation.combat && !combatSpawnAllowed(reservation.combat as CreepMemory) ||
            room.memory.creepConfig?.[name] && !dismantleBoostAllowed(room.memory.creepConfig[name]) ||
            room.memory.creepConfig?.[name] && !combatSpawnAllowed(room.memory.creepConfig[name])) continue
        seen?.add(name)
        for (const step of reservation.plan.steps) result.push({ ...step, priority: 1 })
    }
    for (const task of approved) {
        for (let index = 0; index < task.plan!.members.length; index++) {
            const member = task.plan!.members[index]
            if (!pendingLabPlan(member.boostPlan)) continue
            const logicalName = `combat_${task.id}_${task.generation}_fighter_${index}`
            const name = task.memberNames?.[index] || Object.keys(room.memory.creepConfig || {}).find(name =>
                room.memory.creepConfig[name].name === logicalName &&
                room.memory.creepConfig[name].combatGeneration === task.generation)
            if (name && (seen?.has(name) || Game.creeps[name])) continue
            if (name) seen?.add(name)
            for (const step of member.boostPlan.steps) result.push({ ...step, priority: 1 })
        }
    }
    return result
}

/** Re-evaluate accepted spawns, plan cancellation and live completion within this tick. */
export function hasActiveRoomBoost(room: Room): boolean {
    return getActiveRoomBoostRequests(room).length > 0
}

/** Call only after spawnCreep returns OK; next tick Game.creeps owns the reservation. */
export function reserveBoostPlan(room: Room, name: string, plan: CreepBoostPlan): void {
    syncTick()
    if (validPlan(plan) && !plan.failed && !plan.completed && plan.steps.length > 0) {
        const config = room.memory.creepConfig?.[name]
        const combat = config?.combatTaskId ? { combatTaskId: config.combatTaskId,
            combatGeneration: config.combatGeneration, combatJob: config.combatJob } : undefined
        reservations.set(name, { roomName: room.name, plan, combat })
    }
}

export function usableBoostLabs(room: Room): StructureLab[] {
    const config = room.memory.roomLabConfig
    return room.labs.filter(lab => lab.id != config?.sourceLab1 && lab.id != config?.sourceLab2 &&
        lab.my !== false && (typeof lab.isActive != 'function' || lab.isActive()) &&
        (typeof Game.getObjectById != 'function' || Game.getObjectById(lab.id) != undefined))
}

function quantity(store: StoreDefinition | undefined, resource: ResourceConstant): number {
    return store?.[resource] || 0
}

function canRunLogistics(creep: Creep): boolean {
    const plan = creep.memory.boostPlan
    if (plan == undefined) return !roleBoostConfig[creep.memory.role]?.length
    return validPlan(plan) && !plan.failed && (plan.completed === true || plan.steps.length === 0)
}

/** Read-only preflight: exact compounds, room-wide availability, free output labs and real logistics. */
export function canPrepareBoosts(room: Room, plan: CreepBoostPlan): boolean {
    return canPrepareBoostGroup(room, [plan])
}

/** A squad shares the same mineral stock: each valid body is checked before totals are combined. */
export function canPrepareBoostGroup(room: Room, plans: CreepBoostPlan[]): boolean {
    if (plans.some(plan => !validPlan(plan) || plan.failed)) return false
    const steps = plans.reduce<CreepBoostPlan['steps']>((all, plan) => all.concat(plan.steps), [])
    if (steps.length === 0) return true
    const outputLabs = usableBoostLabs(room)
    const labs = outputLabs.filter(lab => (lab.cooldown || 0) === 0)
    const requests = [...getRoomBoostRequests(room).filter(request => request.priority !== 2), ...steps.map(step => ({ ...step, priority: 1 }))]
    const required = new Map<ResourceConstant, number>()
    for (const step of requests) {
        required.set(step.resource, (required.get(step.resource) || 0) + step.parts * LAB_BOOST_MINERAL)
    }
    if (required.size > labs.length) return false
    const local = roomCreeps(room.name).map(entry => entry.creep).filter(creep => creep.room.name === room.name && !creep.spawning)
    const carriers = local.filter(creep => canRunLogistics(creep) && typeof creep.getActiveBodyparts === 'function' && creep.getActiveBodyparts(CARRY) > 0 && creep.getActiveBodyparts(MOVE) > 0)
    const processors = carriers.filter(creep => creep.memory.role === 'processer')
    const fillers = carriers.filter(creep => creep.memory.role === 'filler')
    const available = (resource: ResourceConstant): number => quantity(room.storage?.store, resource) + quantity(room.terminal?.store, resource) +
        outputLabs.reduce((sum, lab) => sum + quantity(lab.store, resource), 0) +
        processors.reduce((sum, creep) => sum + quantity(creep.store, resource), 0)
    for (const [resource, amount] of required) if (available(resource) < amount) return false

    // Loaded labs work without mineral movers; stock elsewhere must have a real delivery path.
    const assignments = room.memory.roomLabConfig?.singleLabConfig || {}
    const used = new Set<string>()
    let missingEnergy = 0
    for (const [resource, amount] of required) {
        const target = labs.find(lab => !used.has(lab.id) && assignments[lab.id]?.boostMode && assignments[lab.id]?.resourceType === resource) ||
            labs.find(lab => !used.has(lab.id) && lab.mineralType === resource) || labs.find(lab => !used.has(lab.id))
        if (target == undefined) return false
        used.add(target.id)
        const loaded = target.mineralType === resource && quantity(target.store, resource) >= amount
        if (!loaded && processors.length === 0) return false
        if (!loaded && room.storage == undefined && room.terminal == undefined &&
            processors.reduce((sum, creep) => sum + quantity(creep.store, resource), 0) < amount) return false
        if (target.mineralType != undefined && target.mineralType !== resource &&
            ![room.storage, room.terminal].some(store => store != undefined && store.store.getFreeCapacity() >= quantity(target.store, target.mineralType!))) return false
        missingEnergy += Math.max(0, amount / LAB_BOOST_MINERAL * LAB_BOOST_ENERGY - quantity(target.store, RESOURCE_ENERGY))
    }
    const fuel = quantity(room.storage?.store, RESOURCE_ENERGY) + quantity(room.terminal?.store, RESOURCE_ENERGY) +
        fillers.reduce((sum, creep) => sum + quantity(creep.store, RESOURCE_ENERGY), 0)
    if (missingEnergy > 0 && (fillers.length === 0 || fuel < missingEnergy)) return false
    return true
}

function returnForRecycling(creep: Creep): void {
    const home = Game.rooms?.[creep.memory.spawnRoom] || creep.room
    const spawn = home.spawns?.find(candidate => candidate.my !== false)
    if (spawn == undefined) return
    if (creep.room.name === home.name && creep.pos.isNearTo(spawn)) spawn.recycleCreep(creep)
    else creep.moveTo(spawn, { range: 1 })
}

function fail(creep: Creep, plan: CreepBoostPlan, message: string): false {
    if (!plan.failed) {
        plan.failed = true; plan.failureReason = message
        if (bodyPolicy.boost.logFailures) console.log(`[boost:${creep.name}] ${message}; returning for recycling`)
    }
    returnForRecycling(creep)
    return false
}

/** OK only schedules a boost: completion is confirmed from the next tick's actual body. */
export function runCreepBoosts(creep: Creep): boolean {
    if (creep.spawning || !dismantleBoostAllowed(creep.memory)) return false
    const explicit = creep.memory.boostPlan
    if (explicit?.failed) { returnForRecycling(creep); return false }
    if (explicit != undefined && !validPlan(explicit)) return fail(creep, explicit, 'invalid boost plan')
    // Completion is durable: combat damage must never send an already deployed team back to labs.
    if (explicit?.completed) return true
    if (explicit?.tier === 0 && explicit.steps.length === 0 && !explicit.failed) { explicit.completed = true; return true }
    if (explicit == undefined && !roleBoostConfig[creep.memory.role]?.length) {
        creep.memory.boostPlan = { tier: 0, steps: [], completed: true }
        return true
    }
    const counts = countBody(creep)
    const plan = creep.memory.boostPlan || (creep.memory.boostPlan = legacyPlan(creep, counts))
    if (plan.failed) { returnForRecycling(creep); return false }
    if (!validPlan(plan)) return fail(creep, plan, 'invalid boost plan')
    const steps = remainingSteps(plan, counts)
    if (steps.length === 0) { plan.completed = true; return true }
    plan.completed = false
    if (plan.startedAt === undefined || plan.startedAt > Game.time) plan.startedAt = Game.time
    if (Game.time - plan.startedAt >= bodyPolicy.boost.timeoutTicks) return fail(creep, plan, 'boost preparation timed out')
    const step = steps[0]
    if ((counts.unboosted[boostBodyPart[step.type]] || 0) < step.parts) return fail(creep, plan, 'required parts are destroyed or already have a different boost')
    syncTick()
    if (attemptedCreeps.has(creep.name)) return false
    const config = creep.room.memory.roomLabConfig?.singleLabConfig || {}
    let selected: StructureLab | undefined
    for (const lab of usableBoostLabs(creep.room)) {
        if (config[lab.id]?.boostMode !== true || config[lab.id]?.resourceType !== step.resource ||
            lab.mineralType !== step.resource || (lab.cooldown || 0) > 0 || claimedLabs.has(lab.id) ||
            quantity(lab.store, step.resource) < step.parts * LAB_BOOST_MINERAL ||
            quantity(lab.store, RESOURCE_ENERGY) < step.parts * LAB_BOOST_ENERGY) continue
        if (selected == undefined || creep.pos.getRangeTo(lab) < creep.pos.getRangeTo(selected)) selected = lab
    }
    if (selected == undefined) return false
    if (!creep.pos.isNearTo(selected)) { creep.moveTo(selected, { range: 1 }); return false }
    const result = selected.boostCreep(creep, step.parts)
    if (result === OK) { claimedLabs.add(selected.id); attemptedCreeps.add(creep.name) }
    else if (result === ERR_NOT_OWNER || result === ERR_INVALID_TARGET || result === ERR_RCL_NOT_ENOUGH || result === ERR_NOT_FOUND)
        return fail(creep, plan, `boost lab rejected the plan (${result})`)
    return false
}
