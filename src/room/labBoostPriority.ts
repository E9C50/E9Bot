import { getActiveRoomBoostRequests } from 'creep/boosting'
import { getRoomProcessors } from 'runtime/creepIndex'
import { getTerminalResourceAmount } from 'room/resourceNetwork'

const energyTransfers = new WeakMap<Room, { tick: number; shard: string; amounts: Map<string, number> }>()
const releasedRooms = new WeakMap<Room, { tick: number; shard: string }>()

export function labBoostWasReleased(room: Room): boolean {
    const released = releasedRooms.get(room)
    return released !== undefined && released.tick === Game.time && released.shard === (Game.shard?.name || '')
}

function pendingEnergy(room: Room): Map<string, number> {
    const previous = energyTransfers.get(room)
    const shard = Game.shard?.name || ''
    if (previous?.tick === Game.time && previous.shard === shard) return previous.amounts
    const amounts = new Map<string, number>()
    energyTransfers.set(room, { tick: Game.time, shard, amounts })
    return amounts
}

export function boostLabEnergyDeficit(room: Room, lab: StructureLab): number {
    const config = room.memory.roomLabConfig?.singleLabConfig[lab.id]
    const need = config?.boostMode ? room.memory.boostNeed?.[config.resourceType] || 0 : 0
    const target = Math.min(lab.store.getCapacity(RESOURCE_ENERGY) || 0, need / LAB_BOOST_MINERAL * LAB_BOOST_ENERGY)
    return Math.max(0, target - (lab.store[RESOURCE_ENERGY] || 0) - (pendingEnergy(room).get(lab.id) || 0))
}

export function recordBoostLabEnergyTransfer(room: Room, lab: StructureLab, amount: number): void {
    const transfers = pendingEnergy(room)
    transfers.set(lab.id, (transfers.get(lab.id) || 0) + amount)
}

export function boostLabWithdrawalAmount(room: Room, lab: StructureLab): number {
    if (!lab.mineralType) return 0
    const configs = room.memory.roomLabConfig?.singleLabConfig || {}, assigned = configs[lab.id]
    if (assigned?.boostMode && (room.memory.boostNeed?.[assigned.resourceType] || 0) > 0 && assigned.resourceType !== lab.mineralType)
        return lab.store[lab.mineralType] || 0
    const resource = lab.mineralType
    const liquid = (room.storage?.store[resource] || 0) + getTerminalResourceAmount(room, resource) +
        getRoomProcessors(room.name).reduce((total, creep) => total + (creep.store[resource] || 0), 0)
    const loaded = (room.labs || []).reduce((total, candidate) => total +
        (configs[candidate.id]?.boostMode && configs[candidate.id].resourceType === resource ? candidate.store[resource] || 0 : 0), 0)
    return Math.max(0, (room.memory.boostNeed?.[resource] || 0) - liquid - loaded)
}

/** Reconcile immediately: approved births and accepted intents can appear after room planning. */
export function prioritizeLabBoostJobs(room: Room, requests = getActiveRoomBoostRequests(room)): boolean {
    if (requests.length === 0) {
        if (room.memory.labBoostPaused) {
            // A cancellation can happen after room planning; obsolete deliveries stop now.
            delete room.memory.labBoostPaused
            room.memory.boostNeed = {}
            const jobs = room.memory.roomFillJob ||= {}
            jobs.labOut = []; jobs.labInMineral = []; jobs.labInEnergy = []
            releasedRooms.set(room, { tick: Game.time, shard: Game.shard?.name || '' })
        }
        return false
    }
    room.memory.labBoostPaused = true
    const needs: RoomMemory['boostNeed'] = {}
    for (const request of requests) needs[request.resource] = (needs[request.resource] || 0) + request.parts * LAB_BOOST_MINERAL
    room.memory.boostNeed = needs
    const jobs = room.memory.roomFillJob ||= {}
    const configs = room.memory.roomLabConfig?.singleLabConfig || {}
    const labs = room.labs || []
    const processors = getRoomProcessors(room.name)
    const liquid = (resource: ResourceConstant): number => (room.storage?.store[resource] || 0) +
        getTerminalResourceAmount(room, resource) + processors.reduce((total, creep) => total + (creep.store[resource] || 0), 0)
    const loaded = (resource: ResourceConstant): number => labs.reduce((total, lab) =>
        total + (configs[lab.id]?.boostMode && configs[lab.id].resourceType === resource ? lab.store[resource] || 0 : 0), 0)
    const out: string[] = [], minerals: NonNullable<IRoomFillJob['labInMineral']> = [], energy: string[] = []
    for (const lab of labs) {
        const config = configs[lab.id]
        const boosting = config?.boostMode === true && (needs[config.resourceType] || 0) > 0
        if (boosting) {
            if (lab.mineralType && lab.mineralType !== config.resourceType) out.push(lab.id)
            if ((lab.store[config.resourceType] || 0) < Math.min(3000, needs[config.resourceType]) && liquid(config.resourceType) > 0)
                minerals.push({ labId: lab.id, resourceType: config.resourceType })
            if (boostLabEnergyDeficit(room, lab) > 0) energy.push(lab.id)
        } else if (lab.mineralType && (needs[lab.mineralType] || 0) > loaded(lab.mineralType) + liquid(lab.mineralType)) {
            // A needed T1/T2 can be sitting in a reaction source; return it for the assigned boost lab.
            out.push(lab.id)
        }
    }
    // Only boost cleanup, drug deliveries and fuel survive; ordinary recipes stay intact in their plan.
    jobs.labOut = out
    jobs.labInMineral = minerals
    jobs.labInEnergy = energy
    return true
}
