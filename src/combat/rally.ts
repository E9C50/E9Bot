import type { CombatTask } from './types'

type Tile = { x: number; y: number; roomName: string }
type Occupant = { name: string; friendlyCreep: boolean }
type Geometry = { terrain: RoomTerrain; terrainValues: Map<number, number>; blocked: Set<number>; unavailable: Set<number>;
    roads: Set<number>; occupants: Map<number, Occupant[]>; costs: CostMatrix }
const seats = [[0, 0], [1, 0], [0, 1], [1, 1]]
let cachedTick: number | undefined
let cachedShard: string | undefined
let geometries = new Map<string, Geometry>()

function packed(x: number, y: number): number { return x * 50 + y }
function range(first: Tile, second: Tile): number {
    return first.roomName === second.roomName ? Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y)) : Infinity
}

function terrain(data: Geometry, x: number, y: number): number {
    const tile = packed(x, y), known = data.terrainValues.get(tile)
    if (known !== undefined) return known
    const value = data.terrain.get(x, y); data.terrainValues.set(tile, value)
    return value
}

function releaseTrafficLock(member: Creep): void {
    const memory = member.memory as CreepMemory & { lastPos?: { time: number } }
    memory.dontPullMe = false
    if (memory.lastPos) memory.lastPos.time = 0
}

function geometry(room: Room): Geometry {
    if (cachedTick !== Game.time || cachedShard !== Game.shard.name) {
        cachedTick = Game.time; cachedShard = Game.shard.name; geometries = new Map()
    }
    const known = geometries.get(room.name)
    if (known) return known
    const data: Geometry = { terrain: Game.map.getRoomTerrain(room.name), terrainValues: new Map(), blocked: new Set(), unavailable: new Set(), roads: new Set(),
        occupants: new Map(), costs: new PathFinder.CostMatrix() }
    const exclude = (pos: RoomPosition, radius: number): void => {
        for (let x = Math.max(0, pos.x - radius); x <= Math.min(49, pos.x + radius); x++)
            for (let y = Math.max(0, pos.y - radius); y <= Math.min(49, pos.y + radius); y++) data.unavailable.add(packed(x, y))
    }
    for (const structure of [...(room.structures || room.find(FIND_STRUCTURES)), ...room.find(FIND_CONSTRUCTION_SITES)]) {
        const { x, y } = structure.pos, type = structure.structureType
        if (type === STRUCTURE_ROAD) { data.roads.add(packed(x, y)); data.costs.set(x, y, 1) }
        if ((OBSTACLE_OBJECT_TYPES as readonly string[]).includes(type) || type === STRUCTURE_RAMPART &&
            'my' in structure && !structure.my && !('isPublic' in structure && structure.isPublic)) {
            data.costs.set(x, y, 255); data.blocked.add(packed(x, y))
        }
        // Keep the spawn exit ring, logistics/boost approach tiles and future building sites clear.
        if (![STRUCTURE_ROAD, STRUCTURE_RAMPART, STRUCTURE_WALL].includes(type as any))
            exclude(structure.pos, type === STRUCTURE_SPAWN ? 5 : 3)
        else if (type !== STRUCTURE_ROAD) exclude(structure.pos, 0)
    }
    for (const object of [...(room.sources || room.find(FIND_SOURCES)), ...(room.mineral ? [room.mineral] : room.find(FIND_MINERALS)),
        ...(room.controller ? [room.controller] : [])]) {
        exclude(object.pos, 3); data.costs.set(object.pos.x, object.pos.y, 255); data.blocked.add(packed(object.pos.x, object.pos.y))
    }
    for (const pos of [room.memory.roomPosition?.managerPos, room.memory.roomPosition?.centerPos]) if (pos) exclude(pos as RoomPosition, 3)
    for (const creep of [...room.find(FIND_CREEPS), ...room.find(FIND_POWER_CREEPS)]) {
        const tile = packed(creep.pos.x, creep.pos.y), names = data.occupants.get(tile) || []
        names.push({ name: creep.name, friendlyCreep: creep.my && 'body' in creep }); data.occupants.set(tile, names)
    }
    geometries.set(room.name, data)
    return data
}

function memberNames(task: CombatTask, members: readonly Creep[]): string[] {
    const names = task.memberNames?.length ? task.memberNames.slice() : Object.keys(task.rally?.slots || {})
    for (const member of members) if (!names.includes(member.name)) names.push(member.name)
    return names
}

function footprint(anchor: Tile, count: number): number[] {
    const width = count > 1 ? 2 : 1, height = count > 2 ? 2 : 1, result: number[] = []
    // A free approach ring rejects narrow corridors as well as roads under the parking seats.
    for (let dx = -1; dx <= width; dx++) for (let dy = -1; dy <= height; dy++)
        result.push(packed(anchor.x + dx, anchor.y + dy))
    return result
}

function reserved(task: CombatTask): Set<number> {
    const result = new Set<number>()
    for (const other of Object.values(Memory.combatTasks || {})) {
        if (other === task || other.id === task.id || other.shard !== task.shard ||
            ['completed', 'cancelled', 'returning'].includes(other.phase) || other.rally?.roomName !== task.homeRoom) continue
        for (const tile of footprint(other.rally, other.rally.count)) result.add(tile)
    }
    return result
}

function legal(anchor: Tile, count: number, data: Geometry, allowed: Set<string>, unavailable: Set<number>): boolean {
    if (anchor.x < 5 || anchor.y < 5 || anchor.x + (count > 1 ? 1 : 0) > 44 || anchor.y + (count > 2 ? 1 : 0) > 44) return false
    return footprint(anchor, count).every(tile => {
        const x = Math.floor(tile / 50), y = tile % 50
        return !(terrain(data, x, y) & TERRAIN_MASK_WALL) && !data.unavailable.has(tile) && !data.roads.has(tile) &&
            !unavailable.has(tile) && !(data.occupants.get(tile) || []).some(unit => !unit.friendlyCreep || !allowed.has(unit.name))
    })
}

function reachableTiles(start: RoomPosition, data: Geometry, allowed: Set<string>, occupied: Set<number>): Set<number> {
    const blocked = new Set([...data.blocked, ...occupied])
    for (const [tile, units] of data.occupants) if (units.some(unit => !unit.friendlyCreep || !allowed.has(unit.name))) blocked.add(tile)
    const queue = [packed(start.x, start.y)], reached = new Set(queue)
    for (let index = 0; index < queue.length; index++) {
        const x = Math.floor(queue[index] / 50), y = queue[index] % 50
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            const nextX = x + dx, nextY = y + dy, tile = packed(nextX, nextY)
            if (nextX < 0 || nextX > 49 || nextY < 0 || nextY > 49 || reached.has(tile) || blocked.has(tile) ||
                terrain(data, nextX, nextY) & TERRAIN_MASK_WALL) continue
            reached.add(tile); queue.push(tile)
        }
    }
    return reached
}

function reachable(anchor: Tile, start: RoomPosition, data: Geometry, allowed: Set<string>, occupied: Set<number>): boolean {
    const costs = data.costs.clone()
    for (const [tile, units] of data.occupants) if (units.some(unit => !unit.friendlyCreep || !allowed.has(unit.name)))
        costs.set(Math.floor(tile / 50), tile % 50, 255)
    for (const tile of occupied) costs.set(Math.floor(tile / 50), tile % 50, 255)
    return !PathFinder.search(start, { pos: new RoomPosition(anchor.x, anchor.y, anchor.roomName), range: 0 }, {
        maxRooms: 1, maxOps: 3000, plainCost: 2, swampCost: 5,
        roomCallback: roomName => roomName === anchor.roomName ? costs : false,
    }).incomplete
}

/** Each ready fighter owns a separate seat; incomplete boosts never receive a competing move. */
export function parkReadyCombatMembers(task: CombatTask, members: readonly Creep[]): void {
    if (members.length === 0) return
    members.forEach(releaseTrafficLock)
    const home = Game.rooms[task.homeRoom]
    if (!home) return
    const names = memberNames(task, members), count = Math.min(4, Math.max(names.length, task.plan?.members.length || 1))
    const allowed = new Set(names), data = geometry(home), occupied = reserved(task)
    let rally = task.rally
    if (!rally || rally.roomName !== task.homeRoom || rally.count !== count ||
        Object.values(rally.pathFailures || {}).some(failures => failures >= 3) || !legal(rally, count, data, allowed, occupied)) {
        delete task.rally
        if (task.rallyRetryAt !== undefined && Game.time < task.rallyRetryAt) return
        const start = members.find(member => member.pos.roomName === task.homeRoom)?.pos || home.spawns[0]?.pos
        if (!start) return
        const accessible = reachableTiles(start, data, allowed, occupied)
        const candidates: { anchor: Tile; score: number }[] = []
        for (let x = 5; x <= 44; x++) for (let y = 5; y <= 44; y++) {
            const anchor = { x, y, roomName: task.homeRoom }
            if (!accessible.has(packed(x, y)) || !legal(anchor, count, data, allowed, occupied)) continue
            const swamp = seats.slice(0, count).reduce((sum, [dx, dy]) => sum + Number(!!(terrain(data, x + dx, y + dy) & TERRAIN_MASK_SWAMP)), 0)
            candidates.push({ anchor, score: range(anchor, start) + swamp * 10 })
        }
        candidates.sort((first, second) => first.score - second.score || first.anchor.x - second.anchor.x || first.anchor.y - second.anchor.y)
        const choice = candidates.slice(0, 12).find(candidate => reachable(candidate.anchor, start, data, allowed, occupied))
        if (!choice) { task.rallyRetryAt = Game.time + 10; return }
        rally = task.rally = { ...choice.anchor, count, slots: {} }
        delete task.rallyRetryAt
    }
    // Rebuild by published member order, including members still spawning or boosting.
    rally.slots = {}
    names.slice(0, count).forEach((name, index) => { rally!.slots[name] = index })
    for (const member of members) {
        const index = rally.slots[member.name]
        if (index === undefined) continue
        const [dx, dy] = seats[index], goal = new RoomPosition(rally.x + dx, rally.y + dy, rally.roomName)
        releaseTrafficLock(member)
        if (range(member.pos, goal) > 0 && member.fatigue === 0) {
            const result = member.moveTo(goal, { range: 0, reusePath: 5, ignoreCreeps: false })
            if (result === ERR_NO_PATH) {
                rally.pathFailures ||= {}
                rally.pathFailures[member.name] = (rally.pathFailures[member.name] || 0) + 1
            } else if (rally.pathFailures) delete rally.pathFailures[member.name]
        }
        // BetterMove's blocked-step wrapper must not turn a waiting fighter into a traffic lock.
        member.memory.dontPullMe = false
    }
}
