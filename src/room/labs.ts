import { boostConfig } from 'settings/boost'
import { getActiveRoomBoostRequests, usableBoostLabs } from 'creep/boosting'
import { prioritizeLabBoostJobs } from './labBoostPriority'
import { getRoomProcessors } from 'runtime/creepIndex'
import { reactionSource } from 'settings/labs'
import { roomPolicy } from 'settings/roomPolicy'
import { basicMinerals, ordinaryResourceTarget, resourcePolicy, t3Resources } from 'settings/resourcePolicy'
import { roomWorkDue } from 'runtime/roomSchedule'
import { cpuRecoveryInterval, hasPendingRoomBoost } from 'runtime/cpuRecovery'
import {
    getAvailableResource, getGlobalResourceAmount, getIncomingResourceAmount, getOutgoingResourceAmount,
    getResourceRooms, getRoomResourceAmount, isWarehouseRoom, requestRoomResource,
} from 'room/resourceNetwork'

const productionBatch = 3000
type ResourceAmounts = Partial<Record<ResourceConstant, number>>
interface ReactionPlan {
    reaction: ResourceConstant
    amount: number
    reserve: ResourceAmounts
    imports: ResourceAmounts
}

/** Allocate existing compounds before expanding recipes; repeated basic ingredients share one pool. */
function buildReactionPlan(
    target: ResourceConstant, amount: number, reactionUnit: number,
    local: (resource: ResourceConstant) => number,
    incoming: (resource: ResourceConstant) => number,
    remote: (resource: ResourceConstant) => number,
): ReactionPlan | undefined {
    const pool = new Map<ResourceConstant, { local: number; remote: number }>()
    const reserve: ResourceAmounts = {}, imports: ResourceAmounts = {}
    let firstReaction: ResourceConstant | undefined
    let firstAmount = 0
    const produce = (resource: ResourceConstant, quantity: number, path: Set<ResourceConstant>): boolean => {
        const sources = reactionSource[resource]
        if (!sources || path.has(resource)) return false
        quantity = Math.ceil(quantity / reactionUnit) * reactionUnit
        const nextPath = new Set(path); nextPath.add(resource)
        for (const source of sources) {
            reserve[source] = (reserve[source] || 0) + quantity
            let stock = pool.get(source)
            if (!stock) {
                stock = { local: local(source) + incoming(source), remote: remote(source) }
                pool.set(source, stock)
            }
            const useLocal = Math.min(quantity, stock.local)
            stock.local -= useLocal
            const useRemote = Math.min(quantity - useLocal, stock.remote)
            stock.remote -= useRemote
            imports[source] = (imports[source] || 0) + useRemote
            const missing = quantity - useLocal - useRemote
            if (missing > 0 && !produce(source, missing, nextPath)) return false
        }
        if (!firstReaction) { firstReaction = resource; firstAmount = quantity }
        return true
    }
    return amount > 0 && produce(target, amount, new Set()) && firstReaction ?
        { reaction: firstReaction, amount: firstAmount, reserve, imports } : undefined
}

function setLabReaction(room: Room, resource: ResourceConstant | undefined): void {
    const config = room.memory.roomLabConfig
    if (!resource) delete config.reactionAmount
    if (config.labReactionConfig === resource) return
    config.labReactionConfig = resource
    // Do not let a processor finish an obsolete precursor delivery after a recipe change.
    const jobs = room.memory.roomFillJob?.labInMineral
    if (jobs) room.memory.roomFillJob.labInMineral = jobs.filter(job => {
        if (config.singleLabConfig[job.labId]?.boostMode) return true
        const expected = resource && reactionSource[resource]
        return !!expected && (job.labId === config.sourceLab1 && job.resourceType === expected[0] ||
            job.labId === config.sourceLab2 && job.resourceType === expected[1])
    })
    if (resource) console.log(`${room.name} notify_Lab合成配置更新：${resource}`)
}

export function updateLabReactionConfig(room: Room): void {
    if (prioritizeLabBoostJobs(room)) return
    const interval = hasPendingRoomBoost(room) ? roomPolicy.labs.updateInterval :
        cpuRecoveryInterval('labPlanning', roomPolicy.labs.updateInterval)
    if (!roomWorkDue(room.name, interval, roomPolicy.labs.staggerUpdates === true)) return
    const config = room.memory.roomLabConfig
    if (room.labs.length === 0 || config.sourceLab1 == undefined || config.sourceLab2 == undefined ||
        config.singleLabConfig[config.sourceLab1]?.boostMode || config.singleLabConfig[config.sourceLab2]?.boostMode) {
        delete config.productionPlan
        setLabReaction(room, undefined)
        if (room.memory.productionReserve) delete room.memory.productionReserve.lab
        return
    }
    const rooms = getResourceRooms()
    const warehouse = isWarehouseRoom(room)
    let reactionUnit = typeof LAB_REACTION_AMOUNT === 'number' ? LAB_REACTION_AMOUNT : 5
    if (typeof PWR_OPERATE_LAB !== 'undefined' && typeof POWER_INFO !== 'undefined') {
        for (const lab of room.labs) {
            if (lab.id === config.sourceLab1 || lab.id === config.sourceLab2 || config.singleLabConfig[lab.id]?.boostMode) continue
            for (const effect of lab.effects || []) {
                if (effect.effect === PWR_OPERATE_LAB && effect.ticksRemaining > 0 && 'level' in effect) {
                    reactionUnit = Math.max(reactionUnit, LAB_REACTION_AMOUNT + POWER_INFO[PWR_OPERATE_LAB].effect[effect.level - 1])
                }
            }
        }
    }
    // Snapshot resource values once per planning pass, without retaining native objects across ticks.
    const amounts = new Map<ResourceConstant, number>(), rawAmounts = new Map<ResourceConstant, number>()
    const incomingAmounts = new Map<ResourceConstant, number>()
    const remoteAmounts = new Map<ResourceConstant, number>(), globalAmounts = new Map<ResourceConstant, number>()
    const local = (resource: ResourceConstant): number => {
        if (!amounts.has(resource)) {
            const baseKeep = !warehouse && (basicMinerals.includes(resource) || resource === 'G') ? ordinaryResourceTarget(resource) : 0
            const amount = getRoomResourceAmount(room, resource) - Math.max(baseKeep, room.memory.boostNeed?.[resource] || 0) -
                (room.memory.productionReserve?.factory?.[resource] || 0) - getOutgoingResourceAmount(room.name, resource)
            rawAmounts.set(resource, amount)
            amounts.set(resource, Math.max(0, amount))
        }
        return amounts.get(resource)!
    }
    const incoming = (resource: ResourceConstant): number => {
        if (!incomingAmounts.has(resource)) {
            const available = local(resource)
            incomingAmounts.set(resource, Math.max(0, rawAmounts.get(resource)! +
                getIncomingResourceAmount(room.name, resource)) - available)
        }
        return incomingAmounts.get(resource)!
    }
    const remote = (resource: ResourceConstant): number => {
        if (!remoteAmounts.has(resource)) remoteAmounts.set(resource, rooms.reduce((total, candidate) =>
            total + (candidate === room ? 0 : getAvailableResource(candidate, resource)), 0))
        return remoteAmounts.get(resource)!
    }
    const global = (resource: ResourceConstant): number => {
        if (!globalAmounts.has(resource)) {
            // Include batches already cooking elsewhere so all rooms do not choose the same low stock.
            let amount = getGlobalResourceAmount(resource)
            for (const candidate of rooms) {
                const plan = candidate.memory.roomLabConfig?.productionPlan
                if (candidate !== room && plan?.target === resource) amount += Math.max(0, plan.remaining ??
                    Math.min(productionBatch, plan.targetAmount - getRoomResourceAmount(candidate, resource) - getIncomingResourceAmount(candidate.name, resource)))
            }
            globalAmounts.set(resource, amount)
        }
        return globalAmounts.get(resource)!
    }
    const localTargets = warehouse ? [] : t3Resources.filter(resource =>
        local(resource) + incoming(resource) < resourcePolicy.t3Reserve)
    localTargets.sort((a, b) => local(a) + incoming(a) - local(b) - incoming(b) || global(a) - global(b))
    const targets = localTargets.length > 0 ? localTargets : [...t3Resources].sort((a, b) => global(a) - global(b))
    const previous = config.productionPlan
    const candidates: NonNullable<ILabConfig['productionPlan']>[] = []
    if (previous && (previous.remaining ?? previous.targetAmount - local(previous.target) - incoming(previous.target)) > 0 &&
        (!previous.local || local(previous.target) + incoming(previous.target) < previous.targetAmount) &&
        (previous.local || localTargets.length === 0)) candidates.push(previous)
    for (const target of targets) {
        if (candidates.some(plan => plan.target === target)) continue
        const current = local(target) + incoming(target)
        const isLocal = localTargets.includes(target as MineralBoostConstant)
        const quantity = isLocal ? Math.min(productionBatch, resourcePolicy.t3Reserve - current) : productionBatch
        const remaining = Math.ceil(quantity / reactionUnit) * reactionUnit
        candidates.push({ target, targetAmount: current + remaining, local: isLocal, remaining })
    }
    for (const candidate of candidates) {
        const current = local(candidate.target) + incoming(candidate.target)
        // Legacy global targets were inflated when exported output lowered local stock.
        let remaining = candidate.remaining ?? Math.min(productionBatch, Math.max(0, candidate.targetAmount - current))
        if (candidate.local) remaining = Math.min(remaining, Math.max(0, candidate.targetAmount - current))
        remaining = Math.ceil(remaining / reactionUnit) * reactionUnit
        const plan = buildReactionPlan(candidate.target, remaining, reactionUnit,
            local, incoming, remote)
        if (!plan) continue
        config.productionPlan = { ...candidate, remaining,
            targetAmount: !candidate.local && candidate.remaining === undefined ? current + remaining : candidate.targetAmount }
        config.reactionAmount = plan.amount
        room.memory.productionReserve ||= {}
        room.memory.productionReserve.lab = plan.reserve
        // Imports are absolute goals and include existing promises, so cooldown waiting is idempotent.
        for (const resource in plan.imports) {
            const type = resource as ResourceConstant
            if (plan.imports[type]! > 0) requestRoomResource(room, type,
                getRoomResourceAmount(room, type) + getIncomingResourceAmount(room.name, type) + plan.imports[type]!)
        }
        setLabReaction(room, plan.reaction)
        return
    }
    delete config.productionPlan
    if (room.memory.productionReserve) delete room.memory.productionReserve.lab
    setLabReaction(room, undefined)
}

function getBoostType(resourceType: string): BoostTypeConstant | undefined {
    return Object.keys(boostConfig).find((type) =>
        boostConfig[type].includes(resourceType)
    ) as BoostTypeConstant | undefined
}

export function updateLabBoostConfig(room: Room): void {
    const requests = getActiveRoomBoostRequests(room)
    const boostNeed: RoomMemory['boostNeed'] = {}
    const priorities = new Map<ResourceConstant, number>()
    for (const request of requests) {
        boostNeed[request.resource] = (boostNeed[request.resource] || 0) + request.parts * LAB_BOOST_MINERAL
        priorities.set(request.resource, Math.min(priorities.get(request.resource) ?? request.priority, request.priority))
    }
    // Initialization clears this each tick; standalone callers must also get a fresh aggregate.
    room.memory.boostNeed = boostNeed
    const needsAssignment = requests.some(request => request.priority !== 2 && !room.labs.some(lab =>
        room.memory.roomLabConfig.singleLabConfig[lab.id]?.boostMode &&
        room.memory.roomLabConfig.singleLabConfig[lab.id].resourceType === request.resource))
    if ((!needsAssignment && !roomWorkDue(room.name, roomPolicy.labs.updateInterval, roomPolicy.labs.staggerUpdates === true)) || room.labs.length == 0) {
        prioritizeLabBoostJobs(room, requests)
        return
    }
    const config = room.memory.roomLabConfig
    const previous = { ...config.singleLabConfig }
    const labs = usableBoostLabs(room)
    const resources = [...priorities.keys()].sort((a, b) => priorities.get(a)! - priorities.get(b)!)
    const selected = new Map<ResourceConstant, StructureLab>(), occupied = new Set<string>()
    // Keep a running plan's exact lab; equal boost types with different tiers are independent resources.
    for (const resource of resources) {
        if (priorities.get(resource) === 2) continue
        const existing = labs.find(lab => !occupied.has(lab.id) && previous[lab.id]?.boostMode && previous[lab.id]?.resourceType == resource)
        if (existing != undefined) { selected.set(resource, existing); occupied.add(existing.id) }
    }
    for (const id of Object.keys(config.singleLabConfig)) {
        if (config.singleLabConfig[id].boostMode && !occupied.has(id)) delete config.singleLabConfig[id]
    }
    const hasMineral = (resource: ResourceConstant): boolean => (room.storage?.store[resource] || 0) > 0 ||
        (room.terminal?.store[resource] || 0) > 0 || labs.some(lab => (lab.store[resource] || 0) > 0) ||
        getRoomProcessors(room.name).some(creep => (creep.store[resource] || 0) > 0)
    for (const resource of resources) {
        if (selected.has(resource)) continue
        if (priorities.get(resource) === 2 && !hasMineral(resource)) continue
        const lab = labs.find(candidate => !occupied.has(candidate.id) && previous[candidate.id]?.boostMode && previous[candidate.id]?.resourceType === resource) ||
            labs.find(candidate => !occupied.has(candidate.id) && candidate.mineralType === resource) ||
            labs.find(candidate => !occupied.has(candidate.id))
        const boostType = getBoostType(resource)
        if (lab == undefined || boostType == undefined) continue
        config.singleLabConfig[lab.id] = { boostMode: true, boostType, resourceType: resource }
        selected.set(resource, lab); occupied.add(lab.id)
    }
    // A retasked lab must not keep hauling the old compound while waiting for its next init.
    const jobs = room.memory.roomFillJob
    if (jobs?.labInMineral != undefined) jobs.labInMineral = jobs.labInMineral.filter(job => {
        if (!previous[job.labId]?.boostMode) return true
        const current = config.singleLabConfig[job.labId]
        return current?.boostMode === true && current.resourceType === job.resourceType
    })
    prioritizeLabBoostJobs(room, requests)
}
