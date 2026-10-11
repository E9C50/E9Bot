import { developmentRemotePolicy as policy } from 'settings/developmentRemotes'
import { populationPolicy } from 'settings/population'
import { harvestWorkParts, energyCarryCapacity } from './bodyEffectiveness'
import { previewBodySelection } from './bodySelection'
import { bodyPolicy } from 'settings/bodyPolicy'
import type { DevelopmentRemoteData } from './developmentRemotes'

export interface DevelopmentRemoteEconomy { income: number; upkeep: number }
type RemoteData = Partial<RemoteHarvesterData & RemoteFillerData & ReserverData & DevelopmentRemoteData>

function ready(creep: Creep, part: BodyPartConstant): boolean {
    const plan = creep.memory.boostPlan
    return !creep.spawning && creep.ticksToLive !== 0 && creep.getActiveBodyparts(part) > 0 &&
        !(creep.memory.data as RemoteData)?.developmentRemote?.retiring &&
        !(plan && !plan.completed && !plan.failed && plan.steps.length > 0)
}

function distance(first: RoomPosition, second: RoomPosition): number {
    return first.roomName === second.roomName ? Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y)) : Infinity
}

function roomCoordinate(name: string): { x: number; y: number } | undefined {
    const match = /^([WE])(\d+)([NS])(\d+)$/.exec(name)
    return match ? { x: match[1] === 'E' ? Number(match[2]) : -Number(match[2]) - 1,
        y: match[3] === 'N' ? Number(match[4]) : -Number(match[4]) - 1 } : undefined
}

/** Reuse already planned geometry; population publication never launches another path search. */
function roundTrip(home: Room, source: Source, metadata: DevelopmentRemoteData['developmentRemote'] | undefined): number {
    if (Number.isFinite(metadata?.source?.travelTicks) && metadata!.source!.travelTicks! > 0) return metadata!.source!.travelTicks!
    const lane = home.memory.remoteRoads?.routes[`${source.pos.roomName}/${source.id}`]
    if (lane?.plannedAt !== undefined && lane.targetRoom === source.pos.roomName) {
        const length = Object.values(lane.rooms).reduce((total, positions) => total + positions.length, 0)
        if (length > 0) return length * 2 + Math.max(0, Object.keys(lane.rooms).length - 1) * 4 + 2
    }
    const known = home.memory.developmentRemotes?.intel[source.pos.roomName]?.sources.find(value => value.id === source.id)?.travelTicks
    if (Number.isFinite(known) && known! > 0) return known!
    const start = roomCoordinate(home.name), target = roomCoordinate(source.pos.roomName)
    const rooms = start && target ? Math.max(Math.abs(start.x - target.x), Math.abs(start.y - target.y)) : 1
    return Math.max(1, rooms) * policy.travelTicksPerRoom * 2
}

/** A slow or damaged carrier cannot promise the delivery rate of a full-speed CARRY/MOVE body. */
function travelMultiplier(creep: Creep): number {
    let move = creep.getActiveBodyparts(MOVE), weight = creep.getActiveBodyparts(CARRY), emptyWeight = 0
    for (const part of creep.body || []) {
        if (part.hits === 0) continue
        if (part.type === MOVE && part.boost && typeof BOOSTS !== 'undefined') {
            const multiplier = (BOOSTS[MOVE]?.[part.boost] as { fatigue?: number } | undefined)?.fatigue || 1
            move += multiplier - 1
        } else if (part.type !== CARRY && part.type !== MOVE) emptyWeight++
    }
    weight += emptyWeight
    return (Math.max(1, emptyWeight / Math.max(1, move)) + Math.max(1, weight / Math.max(1, move))) / 2
}

/** A predecessor and its overlapping successor occupy one permanent production/transport slot. */
function permanentSlots(creeps: Creep[]): Creep[][] {
    const parent = new Map(creeps.map(creep => [creep.name, creep.name]))
    const root = (name: string): string => {
        let current = name
        while (parent.get(current) !== current) current = parent.get(current)!
        return current
    }
    for (const creep of creeps) {
        const replacement = creep.memory.development?.replacement
        const predecessor = replacement && replacement.deadline >= Game.time ? replacement.predecessor : undefined
        if (predecessor && parent.has(predecessor)) {
            const first = root(creep.name), second = root(predecessor)
            if (first !== second) parent.set(first, second)
        }
    }
    const slots = new Map<string, Creep[]>()
    for (const creep of creeps) {
        const key = root(creep.name), slot = slots.get(key)
        if (slot) slot.push(creep); else slots.set(key, [creep])
    }
    return [...slots.values()]
}

/** Both OUT flags and automatic mines fund consumers only after their real fleet has arrived. */
export function getDevelopmentRemoteEconomy(home: Room, creeps: Creep[]): DevelopmentRemoteEconomy {
    const manual = new Set<string>()
    for (let index = 0; index < populationPolicy.maximumRemoteRooms; index++) {
        const target = Game.flags?.[`${home.name}_OUT${index}`]?.pos.roomName
        if (target && target !== home.name) manual.add(target)
    }
    const members = creeps.filter(creep => creep.memory.spawnRoom === home.name)
    const sources = new Map<string, { source: Source; miners: Creep[]; metadata?: DevelopmentRemoteData['developmentRemote'] }>()
    for (const creep of members) {
        if (creep.memory.role !== 'rHarvester' || !ready(creep, WORK)) continue
        const data = (creep.memory.data || {}) as RemoteData, metadata = data.developmentRemote
        const target = metadata?.targetRoom || data.targetRoom, id = metadata?.source?.id || data.sourceId
        if (!target || !id) continue
        if (metadata) {
            const state = home.memory.developmentRemotes, intel = state?.intel[target]
            if (!policy.enabled || state?.enabled === false || metadata.homeRoom !== home.name || metadata.kind !== 'harvester' ||
                !state?.selectedRooms.includes(target) || intel?.status !== 'safe' || Game.time < intel.seenAt ||
                Game.time - intel.seenAt >= policy.intelMaxAge || !intel.sources.some(value => value.id === id)) continue
        } else if (!manual.has(target)) continue
        const source = Game.getObjectById<Source>(id), targetRoom = Game.rooms?.[target]
        if (!source || !Number.isFinite(source.energyCapacity) || source.energyCapacity <= 0 || source.pos.roomName !== target ||
            distance(creep.pos, source.pos) > 1 || targetRoom?.controller?.owner || (targetRoom?.enemies || []).length > 0) continue
        const existing = sources.get(id)
        if (existing) existing.miners.push(creep)
        else sources.set(id, { source, miners: [creep], metadata })
    }
    const prices = new Map<string, number>()
    const price = (role: CreepRoleConstant, data: CreepData, memory?: CreepMemory): number => {
        const profile = memory?.development
        const physical = profile && { fullBody: profile.fullBody, stationary: profile.stationary,
            ...(!profile.fullBody ? { workParts: profile.workParts, carryParts: profile.carryParts, maximumCost: profile.maximumCost } : {}) }
        const preference = { ...bodyPolicy.profiles[role], ...home.memory.bodyProfiles?.[role], ...memory?.bodyProfile }
        const source = role === 'rHarvester' ? sources.get((data as RemoteHarvesterData).sourceId)?.source : undefined
        const seated = source && [...(source.room.containers || []), ...(source.room.links || [])]
            .some(buffer => distance(source.pos, buffer.pos) <= 2)
        const key = JSON.stringify([role, preference, physical, preference.stationary ?? profile?.stationary ?? seated])
        let value = prices.get(key)
        if (value === undefined) {
            const config = { ...memory, role, data, spawnRoom: home.name } as CreepMemory
            value = previewBodySelection(home, config, 0).body.reduce((total, part) => total + BODYPART_COST[part], 0)
            prices.set(key, value)
        }
        return value
    }
    const result: DevelopmentRemoteEconomy = { income: 0, upkeep: 0 }, productiveRooms = new Set<string>()
    const lifetime = typeof CREEP_LIFE_TIME === 'number' ? CREEP_LIFE_TIME : 1500
    for (const { source, miners, metadata } of sources.values()) {
        const target = source.pos.roomName, record = home.memory.remoteCommissioning?.rooms[target]?.sources[source.id]
        const haulers = members.filter(creep => {
            if (creep.memory.role !== 'rFiller' || !ready(creep, CARRY) || !ready(creep, MOVE)) return false
            const data = (creep.memory.data || {}) as RemoteData, remote = data.developmentRemote
            if ((remote?.source?.id || data.sourceFlag) !== source.id ||
                remote && (remote.homeRoom !== home.name || remote.kind !== 'hauler' || remote.targetRoom !== target)) return false
            const destination = data.targetFlag && (Game.flags?.[data.targetFlag] || Game.getObjectById<Structure>(data.targetFlag))
            if (destination ? destination.pos.roomName !== home.name : !remote || data.targetFlag) return false
            return record?.haulersSeen?.[creep.id] === true || distance(creep.pos, source.pos) <= 3 ||
                creep.memory.working === true && (creep.store?.[RESOURCE_ENERGY] || 0) > 0
        })
        const slots = permanentSlots(haulers), trip = roundTrip(home, source, metadata)
        const transport = slots.reduce((total, slot) => total + Math.max(...slot.map(creep =>
            energyCarryCapacity(creep) / (trip * travelMultiplier(creep)))), 0)
        const maximum = source.energyCapacity / ENERGY_REGEN_TIME
        const mining = permanentSlots(miners).map(slot => ({ slot, rate: Math.max(...slot.map(creep => harvestWorkParts(creep) * HARVEST_POWER)) }))
            .sort((first, second) => second.rate - first.rate)
        const production = Math.min(maximum, mining.reduce((total, slot) => total + slot.rate, 0))
        const income = Math.min(production, transport)
        if (income <= 0) continue
        result.income += income; productiveRooms.add(target)
        let required = Math.min(maximum, production)
        for (const { slot, rate } of mining) {
            result.upkeep += Math.max(...slot.map(creep => price('rHarvester', creep.memory.data, creep.memory))) / lifetime
            required -= rate
            if (required <= 0) break
        }
        for (const slot of slots) result.upkeep += Math.max(...slot.map(creep => price('rFiller', creep.memory.data, creep.memory))) / lifetime
    }
    for (const targetRoom of productiveRooms) {
        const record = home.memory.remoteCommissioning?.rooms[targetRoom]
        if (!(record?.reserveRequired ?? (home.controller?.level || 0) > populationPolicy.remote.reserveAfterLevel)) continue
        const reservers = members.filter(creep => creep.memory.role === 'reserver' &&
            ((creep.memory.data as RemoteData)?.developmentRemote?.targetRoom || (creep.memory.data as ReserverData)?.targetRoom) === targetRoom)
        const fallback = { role: 'reserver', bodyProfile: { boostTier: 0, terrain: 'plain' },
            ...(record?.kind === 'automatic' ? { development: { fullBody: true } } : {}) } as CreepMemory
        const reserveCost = reservers.length ? Math.max(...reservers.map(creep => price('reserver', creep.memory.data, creep.memory))) :
            price('reserver', { targetRoom }, fallback)
        const claimLifetime = typeof CREEP_CLAIM_LIFE_TIME === 'number' ? CREEP_CLAIM_LIFE_TIME : 600
        result.upkeep += reserveCost / claimLifetime
    }
    return result
}
