import { combatPolicy } from 'settings/combat'
import { roomPolicy } from 'settings/roomPolicy'
import { creepWhiteList, findPathAvoidRooms } from 'settings/settings'
import { scoutMovementOptions } from 'shard/scoutMovement'
import { combatPower, combatRange, combatSnapshot, incomingDamage, isCombatHostile, isInvulnerable } from './intelligence'
import type { CombatSnapshot } from './intelligence'

export interface CombatSupportOptions { homeRoom: string; targetRoom: string }

type Receiver = StructureStorage | StructureTerminal | StructureSpawn | StructureExtension | StructureContainer
type LootStore = Ruin | Tombstone | StructureStorage | StructureTerminal | StructureContainer
interface LootCandidate {
    target: LootStore | Resource
    resource: ResourceConstant
    dropped: boolean
    value: number
    life: number
    range: number
}
interface Route { rooms: string[]; tick: number }

let cacheTick = -1, cacheShard = ''
let structures = new Map<string, AnyStructure[]>()
const routes = new Map<string, Route>()
const blockedLoot = new Map<string, { id: string; until: number }>()

function tickCache(): void {
    if (cacheTick === Game.time && cacheShard === Game.shard.name) return
    if (cacheShard !== Game.shard.name) { routes.clear(); blockedLoot.clear() }
    cacheTick = Game.time; cacheShard = Game.shard.name; structures = new Map()
    for (const [name, value] of blockedLoot) if (value.until <= Game.time || !Game.creeps[name]) blockedLoot.delete(name)
}

function roomStructures(room: Room): AnyStructure[] {
    tickCache()
    let result = structures.get(room.name)
    if (!result) { result = room.find(FIND_STRUCTURES); structures.set(room.name, result) }
    return result
}

function npc(username: string): boolean { return roomPolicy.defense.npcOwners.includes(username) }
function username(creep: Creep, homeRoom: string): string | undefined {
    return creep.owner?.username || Game.rooms[homeRoom]?.controller?.owner?.username
}
function friendly(usernameValue: string | undefined, creep: Creep, homeRoom: string): boolean {
    return usernameValue !== undefined && (usernameValue === username(creep, homeRoom) || creepWhiteList.includes(usernameValue))
}

function route(from: string, to: string): string[] | undefined {
    tickCache()
    if (from === to) return []
    const key = `${from}/${to}`, previous = routes.get(key)
    if (previous && previous.tick + (combatPolicy.lootRouteCacheTicks ?? 100) > Game.time) return previous.rooms
    const result = Game.map.findRoute(from, to, { routeCallback(roomName) {
        if (roomName !== from && roomName !== to && findPathAvoidRooms.includes(roomName)) return Infinity
        const visible = Game.rooms[roomName]
        if (roomName !== from && roomName !== to && visible && unsafe(visible, combatSnapshot(visible), true)) return Infinity
        return 1
    } })
    if (result === ERR_NO_PATH) return undefined
    const rooms = result.map(value => value.room)
    // Runtime caches are bounded and never turn into persistent route/task state.
    if (routes.size >= Math.max(1, combatPolicy.maximumActiveTasks) * 10) routes.clear()
    routes.set(key, { rooms, tick: Game.time })
    return rooms
}

function travel(creep: Creep, destination: string, scout: boolean = false): void {
    if (creep.room.name === destination) return
    let rooms = route(creep.room.name, destination)
    if (!rooms?.length) return
    let nextRoom = rooms[0]
    let visible = Game.rooms[nextRoom]
    if (visible && unsafe(visible, combatSnapshot(visible), true)) {
        // A route was safe when cached; its next room may now have a live tower.
        routes.delete(`${creep.room.name}/${destination}`)
        rooms = route(creep.room.name, destination)
        if (!rooms?.length) return
        nextRoom = rooms[0]; visible = Game.rooms[nextRoom]
        if (visible && unsafe(visible, combatSnapshot(visible), true)) return
    }
    // Keep the actual room transition explicit. A nearby centre coordinate in
    // another room must not satisfy a wide range at the current room's border.
    creep.moveTo(new RoomPosition(25, 25, nextRoom), { ...(scout ? scoutMovementOptions : {}), range: 1, maxRooms: 2 })
}

function armed(snapshot: CombatSnapshot): boolean {
    return snapshot.enemies.some(enemy => {
        const power = combatPower(enemy)
        return power.attack > 0 || power.ranged > 0
    })
}

function unsafe(room: Room, snapshot: CombatSnapshot, includeCore: boolean): boolean {
    if (room.controller?.my && room.controller.safeMode) return false
    if (armed(snapshot) || snapshot.towers.some(tower => tower.store[RESOURCE_ENERGY] >= TOWER_ENERGY_COST && tower.isActive())) return true
    return includeCore && roomStructures(room).some(structure =>
        structure.structureType === STRUCTURE_INVADER_CORE && structure.hits > 0 ||
        (structure.structureType === STRUCTURE_INVADER_CORE || structure.structureType === STRUCTURE_RAMPART) && isInvulnerable(structure))
}

function flee(creep: Creep, snapshot: CombatSnapshot): boolean {
    if (creep.fatigue > 0 || incomingDamage(creep, creep.pos, snapshot) <= 0) return false
    const goals: { pos: RoomPosition; range: number }[] = []
    for (const enemy of snapshot.enemies) {
        const power = combatPower(enemy)
        if (power.attack <= 0 && power.ranged <= 0) continue
        goals.push({ pos: enemy.pos, range: power.ranged > 0 ? 4 : 2 })
    }
    if (!goals.length) return false
    const result = PathFinder.search(creep.pos, goals, { flee: true, maxRooms: 1,
        maxOps: combatPolicy.supportFleeMaxOps ?? 2000, plainCost: 1, swampCost: 1,
        roomCallback(roomName) {
            const room = Game.rooms[roomName]
            if (!room) return false
            const costs = new PathFinder.CostMatrix()
            for (const structure of roomStructures(room)) {
                if (structure.structureType === STRUCTURE_PORTAL ||
                    (OBSTACLE_OBJECT_TYPES as readonly string[]).includes(structure.structureType) ||
                    structure.structureType === STRUCTURE_RAMPART && !(structure as StructureRampart).my && !(structure as StructureRampart).isPublic)
                    costs.set(structure.pos.x, structure.pos.y, 255)
            }
            for (const unit of room.find(FIND_CREEPS)) if (unit.id !== creep.id) costs.set(unit.pos.x, unit.pos.y, 255)
            for (const unit of room.find(FIND_POWER_CREEPS)) costs.set(unit.pos.x, unit.pos.y, 255)
            return costs
        } })
    const step = result.path[0]
    return step !== undefined && step.roomName === creep.pos.roomName && creep.move(creep.pos.getDirectionTo(step)) === OK
}

function retreat(creep: Creep, homeRoom: string, snapshot: CombatSnapshot): void {
    if (!flee(creep, snapshot)) travel(creep, homeRoom, true)
}

function returnTicks(creep: Creep, homeRoom: string): number {
    const rooms = route(creep.room.name, homeRoom)
    return rooms === undefined ? Infinity : rooms.length * combatPolicy.travelTicksPerRoom + (combatPolicy.lootSafetyTicks ?? 25)
}

function resourceValue(resource: ResourceConstant): number {
    if (resource === RESOURCE_ENERGY) return 0
    if (resource === RESOURCE_POWER) return 5
    const commodity = COMMODITIES[resource as CommodityConstant]
    if (commodity?.level !== undefined) return 4 + commodity.level
    // Compound priority is structural, not a market-price assumption. Even raw
    // minerals are carried ahead of energy, while T3 boosts are more valuable.
    if (resource[0] === 'X' && resource.length > 1) return 3
    return resource.length > 1 ? 2 : 1
}

function cargo(creep: Creep): ResourceConstant | undefined {
    let result: ResourceConstant | undefined, value = -1
    for (const key in creep.store) {
        const resource = key as ResourceConstant
        if (typeof creep.store[resource] !== 'number' || creep.store[resource] <= 0) continue
        const priority = resourceValue(resource)
        if (priority > value) { result = resource; value = priority }
    }
    return result
}

function receive(creep: Creep, resource: ResourceConstant): Receiver | undefined {
    const room = creep.room
    if (room.storage?.my && room.storage.isActive() && room.storage.store.getFreeCapacity(resource) > 0) return room.storage
    if (room.terminal?.my && room.terminal.isActive() && room.terminal.store.getFreeCapacity(resource) > 0) return room.terminal
    let best: Receiver | undefined, nearest = Infinity
    for (const structure of roomStructures(room)) {
        if (resource === RESOURCE_ENERGY && (structure.structureType === STRUCTURE_SPAWN || structure.structureType === STRUCTURE_EXTENSION)) {
            const receiver = structure as StructureSpawn | StructureExtension
            if (!receiver.my || !receiver.isActive() || receiver.store.getFreeCapacity(resource) <= 0) continue
            const range = combatRange(creep.pos, receiver.pos)
            if (range < nearest) { best = receiver; nearest = range }
        }
    }
    if (best) return best
    // A missing/full terminal must not cause minerals to be recycled with their
    // carrier. Home containers provide a safe final storage fallback.
    for (const structure of roomStructures(room)) {
        if (structure.structureType !== STRUCTURE_CONTAINER) continue
        const receiver = structure as StructureContainer
        if (receiver.store.getFreeCapacity(resource) <= 0) continue
        const range = combatRange(creep.pos, receiver.pos)
        if (range < nearest) { best = receiver; nearest = range }
    }
    return best
}

function deposit(creep: Creep, homeRoom: string): boolean {
    if (creep.room.name !== homeRoom) { travel(creep, homeRoom); return false }
    const resource = cargo(creep)
    if (resource === undefined) return true
    const receiver = receive(creep, resource)
    if (receiver && creep.transfer(receiver, resource) === ERR_NOT_IN_RANGE) creep.moveTo(receiver, { range: 1 })
    // Store is unchanged until intents resolve; never recycle or set an empty
    // phase merely because transfer() returned OK in this tick.
    return false
}

/** Released tasks conserve their cargo and recycle through any available home spawn. */
export function returnCombatUnit(creep: Creep, homeRoom: string): void {
    const snapshot = combatSnapshot(creep.room)
    if (unsafe(creep.room, snapshot, false) && creep.room.name !== homeRoom) { retreat(creep, homeRoom, snapshot); return }
    if (!deposit(creep, homeRoom)) return
    let spawn: StructureSpawn | undefined, nearest = Infinity
    for (const name in Game.spawns) {
        const candidate = Game.spawns[name]
        if (candidate.room.name !== homeRoom || !candidate.my || candidate.spawning || !candidate.isActive()) continue
        const range = combatRange(creep.pos, candidate.pos)
        if (range < nearest) { spawn = candidate; nearest = range }
    }
    if (spawn && spawn.recycleCreep(creep) === ERR_NOT_IN_RANGE) creep.moveTo(spawn, { range: 1 })
}

/** Vision only: scouts never issue a hostile intent or enter an observed live tower room. */
export function runCombatScout(creep: Creep, options: CombatSupportOptions): void {
    const current = combatSnapshot(creep.room)
    if (unsafe(creep.room, current, false) || creep.hits < creep.hitsMax) { retreat(creep, options.homeRoom, current); return }
    const target = Game.rooms[options.targetRoom]
    if (target && unsafe(target, combatSnapshot(target), false)) { travel(creep, options.homeRoom, true); return }
    if (creep.room.name !== options.targetRoom) travel(creep, options.targetRoom, true)
}

/** true means a native intent was submitted; the mission confirms its effect next tick. */
export function runControllerAttack(creep: Creep, options: CombatSupportOptions): boolean {
    if (creep.hits < creep.hitsMax && creep.room.name === options.homeRoom) { returnCombatUnit(creep, options.homeRoom); return false }
    const snapshot = combatSnapshot(creep.room)
    if (unsafe(creep.room, snapshot, true) || creep.hits < creep.hitsMax) { retreat(creep, options.homeRoom, snapshot); return false }
    const target = Game.rooms[options.targetRoom]
    const controller = target?.controller
    if (target && (unsafe(target, combatSnapshot(target), true) || !controller || controller.my ||
        friendly(controller.owner?.username || controller.reservation?.username, creep, options.homeRoom) ||
        !controller.owner && !controller.reservation || controller.safeMode || isInvulnerable(controller))) {
        returnCombatUnit(creep, options.homeRoom); return false
    }
    if (creep.getActiveBodyparts(CLAIM) <= 0 || (creep.ticksToLive ?? CREEP_CLAIM_LIFE_TIME) <= 0) {
        returnCombatUnit(creep, options.homeRoom); return false
    }
    if (controller?.upgradeBlocked) {
        // CLAIM units live only 600 ticks; an owned controller's normal 1000-tick
        // lock cannot be waited out by the same newly arrived attacker.
        if (controller.upgradeBlocked >= (creep.ticksToLive ?? CREEP_CLAIM_LIFE_TIME)) returnCombatUnit(creep, options.homeRoom)
        return false
    }
    if (creep.room.name !== options.targetRoom) {
        const outward = route(creep.room.name, options.targetRoom)
        if (!outward || (creep.ticksToLive ?? CREEP_CLAIM_LIFE_TIME) <= outward.length * combatPolicy.travelTicksPerRoom + (combatPolicy.lootSafetyTicks ?? 25)) {
            returnCombatUnit(creep, options.homeRoom); return false
        }
        travel(creep, options.targetRoom); return false
    }
    if (!controller) return false
    const result = creep.attackController(controller)
    if (result === ERR_NOT_IN_RANGE) creep.moveTo(controller, { range: 1 })
    return result === OK
}

function lootRoomAllowed(room: Room, ownName: string | undefined): boolean {
    const owner = room.controller?.owner?.username || room.controller?.reservation?.username
    return owner === undefined || owner === ownName || npc(owner) && !creepWhiteList.includes(owner)
}

function covered(room: Room, pos: RoomPosition): boolean {
    return room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y).some(structure => structure.structureType === STRUCTURE_RAMPART &&
        !(structure as StructureRampart).my && !(structure as StructureRampart).isPublic)
}

function visitLoot(room: Room, ownName: string | undefined, includeCovered: boolean,
    consider: (target: LootStore | Resource, resource: ResourceConstant, amount: number, life: number, dropped: boolean) => void): void {
    if (!lootRoomAllowed(room, ownName)) return
    const allowed = (target: LootStore | Resource) => !isInvulnerable(target) && (includeCovered || !covered(room, target.pos))
    const scan = (target: LootStore, owner: string | undefined, life: number) => {
        if (owner !== undefined && owner !== ownName && (!npc(owner) || creepWhiteList.includes(owner)) || life <= 0 || !allowed(target)) return
        for (const key in target.store) {
            const resource = key as ResourceConstant, amount = target.store[resource]
            if (typeof amount === 'number' && amount > 0) consider(target, resource, amount, life, false)
        }
    }
    for (const ruin of room.find(FIND_RUINS)) scan(ruin, (ruin.structure as OwnedStructure).owner?.username, ruin.ticksToDecay)
    for (const tombstone of room.find(FIND_TOMBSTONES)) scan(tombstone, tombstone.creep.owner.username, tombstone.ticksToDecay)
    for (const resource of room.find(FIND_DROPPED_RESOURCES)) {
        if (resource.amount <= 0 || !allowed(resource)) continue
        const life = resource.amount <= (combatPolicy.lootUrgencyTicks ?? 100) ? resource.amount : Infinity
        consider(resource, resource.resourceType, resource.amount, life, true)
    }
    for (const structure of roomStructures(room)) {
        if (structure.structureType !== STRUCTURE_CONTAINER && structure.structureType !== STRUCTURE_STORAGE && structure.structureType !== STRUCTURE_TERMINAL) continue
        const target = structure as StructureContainer | StructureStorage | StructureTerminal
        const owned = target as StructureStorage | StructureTerminal
        if (owned.my || owned.owner && (!npc(owned.owner.username) || !isCombatHostile(owned, room))) continue
        scan(target, owned.owner?.username, Infinity)
    }
}

/** Count permitted cargo, including cargo behind barriers still awaiting cleanup. */
export function countCombatLoot(room: Room, homeRoom: string): number {
    let total = 0
    visitLoot(room, Game.rooms[homeRoom]?.controller?.owner?.username, true, (_target, _resource, amount) => { total += amount })
    return total
}

function chooseLoot(creep: Creep, options: CombatSupportOptions): LootCandidate | undefined {
    tickCache()
    let best: LootCandidate | undefined
    const blocked = blockedLoot.get(creep.name)
    visitLoot(creep.room, username(creep, options.homeRoom), false, (target, resource, _amount, life, dropped) => {
        if (blocked?.id === target.id) return
        const range = combatRange(creep.pos, target.pos)
        if (life <= Math.max(0, range - 1)) return
        const candidate = { target, resource, dropped, value: resourceValue(resource), life, range }
        const urgent = life <= (combatPolicy.lootUrgencyTicks ?? 100)
        const bestUrgent = best !== undefined && best.life <= (combatPolicy.lootUrgencyTicks ?? 100)
        if (!best || candidate.value > best.value || candidate.value === best.value &&
            (urgent && !bestUrgent || urgent === bestUrgent && (urgent && life < best.life ||
                (!urgent || life === best.life) && range < best.range))) best = candidate
    })
    return best
}

/** NPC cleanup only: player/ally stores and remains are never default raid loot. */
export function runCombatLoot(creep: Creep, options: CombatSupportOptions): void {
    if (creep.hits < creep.hitsMax && creep.room.name === options.homeRoom) { returnCombatUnit(creep, options.homeRoom); return }
    const snapshot = combatSnapshot(creep.room)
    if (unsafe(creep.room, snapshot, true) || creep.hits < creep.hitsMax) {
        if (cargo(creep) !== undefined) creep.memory.working = true
        retreat(creep, options.homeRoom, snapshot); return
    }
    const targetRoom = Game.rooms[options.targetRoom]
    if (targetRoom && (!lootRoomAllowed(targetRoom, username(creep, options.homeRoom)) || unsafe(targetRoom, combatSnapshot(targetRoom), true))) {
        returnCombatUnit(creep, options.homeRoom); return
    }
    const life = creep.ticksToLive ?? CREEP_LIFE_TIME
    if (life <= returnTicks(creep, options.homeRoom) + combatPolicy.minimumTravelLife) {
        returnCombatUnit(creep, options.homeRoom); return
    }
    if (creep.store.getFreeCapacity() <= 0) creep.memory.working = true
    if (creep.memory.working) {
        if (deposit(creep, options.homeRoom)) creep.memory.working = false
        return
    }
    if (creep.room.name !== options.targetRoom) {
        const outward = route(creep.room.name, options.targetRoom), backward = route(options.targetRoom, options.homeRoom)
        if (!outward || !backward || life <= (outward.length + backward.length) * combatPolicy.travelTicksPerRoom + combatPolicy.minimumTravelLife) {
            returnCombatUnit(creep, options.homeRoom); return
        }
        travel(creep, options.targetRoom); return
    }
    const loot = chooseLoot(creep, options)
    if (!loot) {
        if (cargo(creep) !== undefined) { creep.memory.working = true; deposit(creep, options.homeRoom) }
        return
    }
    const result = loot.dropped ? creep.pickup(loot.target as Resource) : creep.withdraw(loot.target as LootStore, loot.resource)
    if (result === ERR_NOT_IN_RANGE) {
        if (creep.moveTo(loot.target, { range: 1 }) === ERR_NO_PATH) blockedLoot.set(creep.name, { id: loot.target.id, until: Game.time + (combatPolicy.lootRouteCacheTicks ?? 100) })
    }
}
