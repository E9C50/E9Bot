import { interShardPolicy } from 'settings/interShard'

/** Shared by live scouts and source retry logic; distant armed creeps are not a room-wide threat. */
export function getScoutDanger(creep: Creep): string | undefined {
    if (creep.hits < creep.hitsMax) return 'Scout 已受到伤害，停止验证危险路线'
    const meleeRange = interShardPolicy.scoutSafety?.meleeThreatRange ?? 2
    const rangedRange = interShardPolicy.scoutSafety?.rangedThreatRange ?? 4
    const maximumRange = Math.max(meleeRange, rangedRange)
    for (const enemy of creep.room.find(FIND_HOSTILE_CREEPS)) {
        // Real room objects always have positions. Missing coordinates remain
        // conservative, rather than authorizing a route through unknown danger.
        const range = enemy.pos === undefined ? 0 : Math.max(Math.abs(creep.pos.x - enemy.pos.x), Math.abs(creep.pos.y - enemy.pos.y))
        if (range > maximumRange) continue
        if ((range <= meleeRange && enemy.getActiveBodyparts(ATTACK) > 0) ||
            (range <= rangedRange && enemy.getActiveBodyparts(RANGED_ATTACK) > 0)) return 'Scout 近距离存在敌对攻击单位'
    }
    const tower = creep.room.find(FIND_HOSTILE_STRUCTURES).some(structure => {
        if (structure.structureType !== STRUCTURE_TOWER) return false
        const value = structure as StructureTower
        return value.my !== true && value.isActive() && value.store[RESOURCE_ENERGY] >= TOWER_ENERGY_COST
    })
    return tower ? 'Scout 所在房间存在可攻击的敌方 Tower' : undefined
}

/** Let a failed, reusable scout step away from nearby fighters while it waits. */
export function moveScoutAwayFromThreat(creep: Creep): boolean {
    if (creep.hits < creep.hitsMax || creep.fatigue > 0 || typeof creep.move !== 'function' ||
        typeof creep.room.lookForAt !== 'function' || Game.map?.getRoomTerrain === undefined) return false
    const meleeRange = interShardPolicy.scoutSafety?.meleeThreatRange ?? 2
    const rangedRange = interShardPolicy.scoutSafety?.rangedThreatRange ?? 4
    const maximumRange = Math.max(meleeRange, rangedRange)
    const threats: Array<{ x: number; y: number; range: number }> = []
    for (const enemy of creep.room.find(FIND_HOSTILE_CREEPS)) {
        if (enemy.pos === undefined) continue
        const distance = Math.max(Math.abs(creep.pos.x - enemy.pos.x), Math.abs(creep.pos.y - enemy.pos.y))
        if (distance > maximumRange + 1) continue
        let range = 0
        if (enemy.getActiveBodyparts(ATTACK) > 0) range = meleeRange
        if (enemy.getActiveBodyparts(RANGED_ATTACK) > 0) range = Math.max(range, rangedRange)
        if (range > 0) threats.push({ x: enemy.pos.x, y: enemy.pos.y, range })
    }
    if (!threats.length) return false
    const clearance = (x: number, y: number) => {
        let distance = Infinity
        for (const enemy of threats) distance = Math.min(distance, Math.max(Math.abs(x - enemy.x), Math.abs(y - enemy.y)) - enemy.range)
        return distance
    }
    const current = clearance(creep.pos.x, creep.pos.y)
    if (current > 0) return false
    const terrain = Game.map.getRoomTerrain(creep.room.name)
    let best = current, direction: DirectionConstant | undefined
    const steps: Array<[number, number, DirectionConstant]> = [
        [0, -1, TOP], [1, -1, TOP_RIGHT], [1, 0, RIGHT], [1, 1, BOTTOM_RIGHT],
        [0, 1, BOTTOM], [-1, 1, BOTTOM_LEFT], [-1, 0, LEFT], [-1, -1, TOP_LEFT],
    ]
    for (const [dx, dy, candidate] of steps) {
        const x = creep.pos.x + dx, y = creep.pos.y + dy
        if (x < 0 || x > 49 || y < 0 || y > 49 || (terrain.get(x, y) & TERRAIN_MASK_WALL)) continue
        const score = clearance(x, y)
        if (score <= best) continue
        if (creep.room.lookForAt(LOOK_STRUCTURES, x, y).some(structure => structure.structureType === STRUCTURE_PORTAL ||
            (structure.structureType === STRUCTURE_RAMPART ? !(structure as StructureRampart).my && !(structure as StructureRampart).isPublic :
                (OBSTACLE_OBJECT_TYPES as readonly string[]).includes(structure.structureType)))) continue
        if (creep.room.lookForAt(LOOK_CREEPS, x, y).length || creep.room.lookForAt(LOOK_POWER_CREEPS, x, y).length) continue
        best = score; direction = candidate
    }
    return direction !== undefined && creep.move(direction) === OK
}
