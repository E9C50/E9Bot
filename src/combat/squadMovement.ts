import { combatPower, combatRange, combatSnapshot, isCombatHostile, isInvulnerable, towerDamage } from './intelligence'
import { combatTacticsPolicy } from 'settings/combatTactics'

export type PositionPlan = Map<Creep, RoomPosition>
export type CombatFormation = 'solo' | 'duo' | 'quad'
const QUAD_OFFSETS = [[0, 0], [1, 0], [0, 1], [1, 1]]

type RoomGeometry = {
    terrain: RoomTerrain; blocked: Set<number>; permanent: Set<number>; roads: Set<number>
    occupants: Map<number, { name: string; power: boolean }[]>; barriers: Map<number, AnyStructure>
}
let cacheTick: number | undefined
let cacheShard: string | undefined
let geometries = new Map<string, RoomGeometry>()
let matrices = new Map<string, CostMatrix | true>()
let paths = new Map<string, PathFinderPath>()
let walkable = new Map<string, boolean>()
let allowedGroups = new Map<string, Set<string>>()
let groupKeys = new WeakMap<readonly Creep[], string>()
let roomRoutes = new Map<string, Set<string>>()
let unsafeTransit = new Map<string, boolean>()

function tickCache(): void {
    if (cacheTick === Game.time && cacheShard === Game.shard.name) return
    cacheTick = Game.time; cacheShard = Game.shard.name
    geometries = new Map(); matrices = new Map(); paths = new Map(); walkable = new Map(); allowedGroups = new Map()
    groupKeys = new WeakMap()
    roomRoutes = new Map(); unsafeTransit = new Map()
}

function groupKey(members: readonly Creep[]): string {
    const known = groupKeys.get(members)
    if (known) return known
    const key = members.map(member => member.name).sort().join(',')
    groupKeys.set(members, key)
    return key
}
function packed(pos: RoomPosition): number { return pos.x * 50 + pos.y }
function allowedMembers(members: readonly Creep[]): Set<string> {
    const key = groupKey(members)
    let allowed = allowedGroups.get(key)
    if (!allowed) { allowed = new Set(members.map(member => member.name)); allowedGroups.set(key, allowed) }
    return allowed
}

function geometry(roomName: string): RoomGeometry {
    tickCache()
    const known = geometries.get(roomName)
    if (known) return known
    const room = Game.rooms[roomName]
    const result: RoomGeometry = { terrain: Game.map.getRoomTerrain(roomName), blocked: new Set(), permanent: new Set(), roads: new Set(),
        occupants: new Map(), barriers: new Map() }
    if (room) {
        for (const structure of room.structures || room.find(FIND_STRUCTURES)) {
            const tile = packed(structure.pos)
            const barrier = (structure.structureType === STRUCTURE_WALL || structure.structureType === STRUCTURE_RAMPART) &&
                isCombatHostile(structure, room) && !isInvulnerable(structure)
            if ((OBSTACLE_OBJECT_TYPES as readonly string[]).includes(structure.structureType) ||
                structure.structureType === STRUCTURE_RAMPART && !(structure as StructureRampart).my && !(structure as StructureRampart).isPublic)
                { result.blocked.add(tile); if (!barrier) result.permanent.add(tile) }
            if (structure.structureType === STRUCTURE_ROAD) result.roads.add(tile)
            if (barrier) result.barriers.set(tile, structure as AnyStructure)
        }
        for (const source of room.sources || []) result.blocked.add(packed(source.pos))
        if (room.mineral) result.blocked.add(packed(room.mineral.pos))
        if (room.controller) result.blocked.add(packed(room.controller.pos))
        for (const source of room.sources || []) result.permanent.add(packed(source.pos))
        if (room.mineral) result.permanent.add(packed(room.mineral.pos))
        if (room.controller) result.permanent.add(packed(room.controller.pos))
        for (const unit of [...room.find(FIND_CREEPS), ...room.find(FIND_POWER_CREEPS)]) {
            const tile = packed(unit.pos), names = result.occupants.get(tile) || []
            names.push({ name: unit.name, power: !('body' in unit) }); result.occupants.set(tile, names)
        }
    }
    geometries.set(roomName, result)
    return result
}

export function combatWalkable(pos: RoomPosition, members: readonly Creep[]): boolean {
    tickCache()
    if (pos.x < 0 || pos.x > 49 || pos.y < 0 || pos.y > 49) return false
    const key = `${pos.roomName}:${packed(pos)}:${groupKey(members)}`, known = walkable.get(key)
    if (known !== undefined) return known
    const data = geometry(pos.roomName), tile = packed(pos), allowed = allowedMembers(members)
    const legal = (data.terrain.get(pos.x, pos.y) & TERRAIN_MASK_WALL) === 0 && !data.blocked.has(tile) &&
        !(data.occupants.get(tile) || []).some(unit => unit.power || !allowed.has(unit.name))
    walkable.set(key, legal)
    return legal
}

function matrix(roomName: string, members: readonly Creep[], quad: boolean, breach: boolean = false): CostMatrix | true {
    tickCache()
    const key = `${roomName}:${groupKey(members)}:${quad}:${breach}`, known = matrices.get(key)
    if (known) return known
    const room = Game.rooms[roomName]
    if (!room) return true
    const costs = new PathFinder.CostMatrix()
    const data = geometry(roomName), terrain = data.terrain, blocked = new Set(data.blocked), allowed = allowedMembers(members)
    if (breach) for (const tile of data.barriers.keys()) if (!data.permanent.has(tile)) blocked.delete(tile)
    for (const [tile, units] of data.occupants) if (units.some(unit => unit.power || !allowed.has(unit.name))) blocked.add(tile)
    if (!quad) {
        for (const tile of data.roads) costs.set(Math.floor(tile / 50), tile % 50, 1)
        if (breach) for (const tile of data.barriers.keys()) costs.set(Math.floor(tile / 50), tile % 50, combatTacticsPolicy.path.breachCost)
        for (const packed of blocked) costs.set(Math.floor(packed / 50), packed % 50, 255)
        matrices.set(key, costs)
        return costs
    }
    for (let x = 0; x < 50; x++) for (let y = 0; y < 50; y++) {
        if (x < 1 || y < 1 || x > 47 || y > 47 || QUAD_OFFSETS.some(([dx, dy]) =>
            (terrain.get(x + dx, y + dy) & TERRAIN_MASK_WALL) !== 0 || blocked.has((x + dx) * 50 + y + dy))) {
            costs.set(x, y, 255)
        } else if (breach && QUAD_OFFSETS.some(([dx, dy]) => data.barriers.has((x + dx) * 50 + y + dy)))
            costs.set(x, y, combatTacticsPolicy.path.breachCost)
        else if (QUAD_OFFSETS.some(([dx, dy]) => (terrain.get(x + dx, y + dy) & TERRAIN_MASK_SWAMP) !== 0)) costs.set(x, y, combatTacticsPolicy.path.swampCost)
    }
    matrices.set(key, costs)
    return costs
}

function dangerousTransit(roomName: string): boolean {
    const known = unsafeTransit.get(roomName)
    if (known !== undefined) return known
    const room = Game.rooms[roomName]
    if (!room) return false
    const snapshot = combatSnapshot(room)
    const unsafe = !!room.controller?.owner && isCombatHostile(room.controller, room) ||
        snapshot.towers.some(tower => towerDamage(tower, tower.pos) > 0) ||
        snapshot.enemies.some(enemy => { const power = combatPower(enemy); return power.attack + power.ranged > 0 })
    unsafeTransit.set(roomName, unsafe)
    return unsafe
}

function routeRooms(start: string, goal: string): Set<string> {
    const key = `${start}:${goal}`, known = roomRoutes.get(key)
    if (known) return known
    const allowed = new Set([start, goal])
    if (start !== goal) {
        const route = Game.map.findRoute(start, goal, { routeCallback: name =>
            name !== start && name !== goal && dangerousTransit(name) ? Infinity : 1 })
        if (Array.isArray(route)) for (const hop of route) allowed.add(hop.room)
    }
    roomRoutes.set(key, allowed)
    return allowed
}

function search(start: RoomPosition, goal: RoomPosition, range: number, members: readonly Creep[], quad: boolean = false,
    breach: boolean = false): PathFinderPath {
    tickCache()
    if (combatRange(start, goal) <= range) return { path: [], incomplete: false, cost: 0, ops: 0 }
    const key = `${start.roomName}:${packed(start)}:${goal.roomName}:${packed(goal)}:${range}:${groupKey(members)}:${quad}:${breach}`
    const known = paths.get(key)
    if (known) return known
    const allowed = routeRooms(start.roomName, goal.roomName)
    const result = PathFinder.search(start, { pos: goal, range }, {
        maxRooms: breach ? 1 : combatTacticsPolicy.path.maxRooms, maxOps: combatTacticsPolicy.path.maxOps,
        plainCost: combatTacticsPolicy.path.plainCost, swampCost: combatTacticsPolicy.path.swampCost,
        roomCallback: roomName => !allowed.has(roomName) || roomName !== start.roomName && roomName !== goal.roomName &&
            dangerousTransit(roomName) ? false : matrix(roomName, members, quad, breach),
    })
    paths.set(key, result)
    return result
}

function step(start: RoomPosition, goal: RoomPosition, range: number, members: readonly Creep[], quad: boolean = false): RoomPosition | undefined {
    const result = search(start, goal, range, members, quad)
    const first = result.path[0]
    return first && combatWalkable(first, members) ? first : undefined
}

/** If the normal route stops at a hostile barrier, find the first barrier on a breachable route. */
export function squadBreachTarget(members: readonly Creep[], goal: RoomPosition, range: number,
    formation: CombatFormation): AnyStructure | undefined {
    if (members.length === 0 || members.some(member => member.pos.roomName !== goal.roomName)) return undefined
    const data = geometry(goal.roomName)
    if (data.barriers.size === 0) return undefined
    const quad = formation === 'quad' && members.length === 4
    const anchor = quad ? quadAnchor(members) : members[0].pos
    if (!anchor || quad && members.some((member, index) => combatRange(member.pos, quadSeats(anchor)[index]) !== 0)) return undefined
    if (!search(anchor, goal, range, members, quad).incomplete) return undefined
    const route = search(anchor, goal, range, members, quad, true)
    for (const point of [anchor, ...route.path]) {
        for (const [dx, dy] of quad ? QUAD_OFFSETS : [[0, 0]]) {
            const barrier = data.barriers.get((point.x + dx) * 50 + point.y + dy)
            if (barrier) return barrier
        }
    }
    return undefined
}

function inward(pos: RoomPosition): RoomPosition {
    const margin = combatTacticsPolicy.formation.borderRegroupMargin
    return new RoomPosition(Math.max(margin, Math.min(49 - margin, pos.x)), Math.max(margin, Math.min(49 - margin, pos.y)), pos.roomName)
}

function snake(members: readonly Creep[], goal: RoomPosition, range: number): PositionPlan {
    const plan: PositionPlan = new Map(), leader = members[0]
    const split = members.some(member => member.pos.roomName !== leader.pos.roomName)
    if (split) {
        // The first member clears the border, then waits while every follower crosses and regroups.
        const interior = inward(leader.pos)
        if (combatRange(leader.pos, interior) > 0) {
            const next = step(leader.pos, interior, 0, members)
            if (next) plan.set(leader, next)
        }
        for (let index = 1; index < members.length; index++) {
            const member = members[index], previous = members[index - 1]
            const next = step(member.pos, previous.pos, member.pos.roomName === previous.pos.roomName ? 1 : 0, members)
            if (next) plan.set(member, next)
        }
        return plan
    }
    const assembled = members.every((member, index) => index === 0 || combatRange(member.pos, members[index - 1].pos) <= 1)
    if (!assembled) {
        for (let index = 1; index < members.length; index++) {
            const next = step(members[index].pos, members[index - 1].pos, 1, members)
            if (next) plan.set(members[index], next)
        }
        return plan
    }
    const next = step(leader.pos, goal, range, members)
    if (!next) return plan
    plan.set(leader, next)
    for (let index = 1; index < members.length; index++) {
        const previous = members[index - 1].pos
        if (combatWalkable(previous, members)) plan.set(members[index], previous)
    }
    return plan
}

function quadSeats(anchor: RoomPosition): RoomPosition[] {
    return QUAD_OFFSETS.map(([dx, dy]) => new RoomPosition(anchor.x + dx, anchor.y + dy, anchor.roomName))
}

function quadAnchor(members: readonly Creep[]): RoomPosition | undefined {
    const leader = members[0]
    let best: RoomPosition | undefined, bestDistance = Infinity
    const radius = combatTacticsPolicy.formation.anchorSearchRange
    for (let x = Math.max(1, leader.pos.x - radius); x <= Math.min(47, leader.pos.x + radius); x++) {
        for (let y = Math.max(1, leader.pos.y - radius); y <= Math.min(47, leader.pos.y + radius); y++) {
            const candidate = new RoomPosition(x, y, leader.pos.roomName), seats = quadSeats(candidate)
            if (seats.some(seat => !combatWalkable(seat, members))) continue
            const distance = seats.reduce((sum, seat, index) => sum + combatRange(seat, members[index].pos), 0)
            if (distance < bestDistance) { best = candidate; bestDistance = distance }
        }
    }
    return best
}

/** Keep 2x2 rigid inside a room; borders use a coordinated snake and then reform. */
export function planSquadMovement(members: readonly Creep[], goal: RoomPosition, range: number, formation: CombatFormation): PositionPlan {
    if (members.length === 0 || members.some(member => member.fatigue > 0 || !member.body.some(part => part.type === MOVE && part.hits > 0))) return new Map()
    if (formation !== 'quad' || members.length !== 4 || members.some(member => member.pos.roomName !== members[0].pos.roomName) ||
        members[0].pos.roomName !== goal.roomName) return snake(members, goal, range)
    const anchor = quadAnchor(members)
    if (!anchor) return new Map()
    const seats = quadSeats(anchor)
    if (members.some((member, index) => combatRange(member.pos, seats[index]) !== 0)) {
        const regroup: PositionPlan = new Map()
        for (let index = 0; index < members.length; index++) {
            const next = step(members[index].pos, seats[index], 0, members)
            if (next) regroup.set(members[index], next)
        }
        return regroup
    }
    const next = step(anchor, goal, range, members, true)
    if (!next || combatRange(anchor, next) > 1 || next.roomName !== anchor.roomName) return new Map()
    const destinations = quadSeats(next)
    if (destinations.some(destination => !combatWalkable(destination, members))) return new Map()
    return new Map(members.map((member, index) => [member, destinations[index]]))
}

/** A rigid retreat/kite candidate preserves formation offsets and checks all occupied tiles. */
export function translateSquad(members: readonly Creep[], dx: number, dy: number): PositionPlan | undefined {
    if (members.some(member => member.fatigue > 0 || member.pos.roomName !== members[0].pos.roomName ||
        !member.body.some(part => part.type === MOVE && part.hits > 0))) return undefined
    if (members.some(member => member.pos.x + dx < 0 || member.pos.y + dy < 0 || member.pos.x + dx > 49 || member.pos.y + dy > 49)) return undefined
    const positions = members.map(member => new RoomPosition(member.pos.x + dx, member.pos.y + dy, member.pos.roomName))
    if (positions.some(pos => pos.x < 0 || pos.y < 0 || pos.x > 49 || pos.y > 49 || !combatWalkable(pos, members))) return undefined
    return new Map(members.map((member, index) => [member, positions[index]]))
}
