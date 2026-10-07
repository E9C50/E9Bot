import { boostConfig } from 'settings/boost'
import { getRoomBoostRequests, usableBoostLabs } from 'creep/boosting'
import { getRoomProcessors } from 'runtime/creepIndex'
import { reactionConfig, reactionSource } from 'settings/labs'
import { roomPolicy } from 'settings/roomPolicy'
import { roomWorkDue } from 'runtime/roomSchedule'
import { cpuRecoveryInterval, hasPendingRoomBoost } from 'runtime/cpuRecovery'

/** Only this update's immutable game snapshot is reused; no data survives the call. */
function createReactionResourceReader(room: Room): (resource: ResourceConstant) => number {
    const amounts = new Map<ResourceConstant, number>()
    return (resource) => {
        const cached = amounts.get(resource)
        if (cached !== undefined) return cached
        let amount = room.storage?.store[resource] ?? 0
        for (const lab of room.labs) amount += lab.store[resource]
        for (const creep of getRoomProcessors(room.name)) amount += creep.store[resource]
        amounts.set(resource, amount)
        return amount
    }
}

function hasReactionReagents(
    getResource: (resource: ResourceConstant) => number,
    resourceType: ResourceConstant
): boolean {
    const sources = reactionSource[resourceType]
    if (sources == undefined) return false
    const minimum = roomPolicy.labs.minimumReactionReagent
    return (
        getResource(sources[0]) > minimum &&
        getResource(sources[1]) > minimum
    )
}

export function updateLabReactionConfig(room: Room): void {
    const interval = hasPendingRoomBoost(room) ? roomPolicy.labs.updateInterval :
        cpuRecoveryInterval('labPlanning', roomPolicy.labs.updateInterval)
    if (
        !roomWorkDue(room.name, interval, roomPolicy.labs.staggerUpdates === true) ||
        room.labs.length == 0
    )
        return
    const config = room.memory.roomLabConfig
    if (config.sourceLab1 == undefined || config.sourceLab2 == undefined) return
    const getReactionResource = createReactionResourceReader(room)
    const currentReaction = config.labReactionConfig
    if (
        currentReaction != undefined &&
        room.getResource(currentReaction) < reactionConfig[currentReaction] &&
        hasReactionReagents(getReactionResource, currentReaction)
    )
        return

    for (const resource in reactionConfig) {
        const resourceType = resource as ResourceConstant
        if (
            getReactionResource(resourceType) >=
            reactionConfig[resource]
        )
            continue
        if (!hasReactionReagents(getReactionResource, resourceType)) continue
        config.labReactionConfig = resourceType
        console.log(`${room.name} notify_Lab合成配置更新：${resourceType}`)
        return
    }
    config.labReactionConfig = undefined
}

function getBoostType(resourceType: string): BoostTypeConstant | undefined {
    return Object.keys(boostConfig).find((type) =>
        boostConfig[type].includes(resourceType)
    ) as BoostTypeConstant | undefined
}

export function updateLabBoostConfig(room: Room): void {
    const requests = getRoomBoostRequests(room)
    const boostNeed: RoomMemory['boostNeed'] = {}
    const priorities = new Map<ResourceConstant, number>()
    for (const request of requests) {
        boostNeed[request.resource] = (boostNeed[request.resource] || 0) + request.parts * LAB_BOOST_MINERAL
        priorities.set(request.resource, Math.min(priorities.get(request.resource) ?? request.priority, request.priority))
    }
    // Initialization clears this each tick; standalone callers must also get a fresh aggregate.
    room.memory.boostNeed = boostNeed
    if (!roomWorkDue(room.name, roomPolicy.labs.updateInterval, roomPolicy.labs.staggerUpdates === true) || room.labs.length == 0) return
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
}
