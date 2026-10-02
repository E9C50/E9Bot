import { roomPolicy } from 'settings/roomPolicy'
import { hasTowerIntent, issueTowerRepair, runRoomTowerDefense } from 'combat/towers'

// 与 structuresNeedRepair 原有优先序一致，但塔只需首个目标，无需构造完整数组。
const repairGroups: readonly (keyof Room)[] = ['extensions', 'spawns', 'towers', 'labs', 'containers', 'links']
const repairSingles: readonly (keyof Room)[] = ['nuker', 'storage', 'factory', 'terminal', 'observer', 'extractor', 'powerSpawn']

interface RoadInspection {
    pendingIds?: Id<StructureRoad>[]
    lastInspection?: number
    recentEnemyTick?: number
    phase: number
}
let inspectionTick: number | undefined, inspectionShard: string | undefined
const roadInspections = new Map<string, RoadInspection>()

function syncRoadInspections(): void {
    const shard = Game.shard?.name
    if (inspectionTick === Game.time && inspectionShard === shard) return
    if (inspectionShard !== shard || inspectionTick != undefined && Game.time < inspectionTick) roadInspections.clear()
    inspectionTick = Game.time
    inspectionShard = shard
    // Only scalar IDs survive a tick; abandoned/non-visible rooms must not accumulate cache entries.
    for (const name of roadInspections.keys()) if (Game.rooms[name] == undefined) roadInspections.delete(name)
}

function roadInspection(room: Room): RoadInspection {
    let state = roadInspections.get(room.name)
    if (state == undefined) {
        let phase = 0
        for (let index = 0; index < room.name.length; index++) phase = (phase * 31 + room.name.charCodeAt(index)) >>> 0
        state = { phase }
        roadInspections.set(room.name, state)
    }
    return state
}

function noteRoomEnemies(room: Room, hasEnemies = (room.enemies?.length ?? 0) > 0): void {
    syncRoadInspections()
    if (hasEnemies || Memory.warMode[room.name]) roadInspection(room).recentEnemyTick = Game.time
}

function roadIsRepairable(road: StructureRoad, tower: StructureTower, hits: number, hitsMax: number): boolean {
    if (hits >= hitsMax) return false
    if (hits <= hitsMax * roomPolicy.defense.criticalRoadHealthFraction) return true
    const damage = hitsMax - hits
    let threshold = Math.min(roomPolicy.defense.minimumRoadDamage, hitsMax * roomPolicy.defense.minimumRoadDamageFraction)
    if (damage < threshold) return false
    if (roomPolicy.defense.batchRoadRepair) {
        const range = Math.max(Math.abs(tower.pos.x - road.pos.x), Math.abs(tower.pos.y - road.pos.y))
        const falloff = Math.min(1, Math.max(0, (range - TOWER_OPTIMAL_RANGE) / (TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE)))
        const repairPower = Math.floor(TOWER_POWER_REPAIR * (1 - TOWER_FALLOFF * falloff))
        threshold = Math.min(hitsMax, Math.max(threshold, repairPower * roomPolicy.defense.roadRepairPowerRatio))
    }
    return damage >= threshold
}

function firstRoadRepairTarget(room: Room, tower: StructureTower): StructureRoad | undefined {
    const interval = roomPolicy.defense.lowBucketRoadInspectionInterval
    const state = roadInspections.get(room.name)
    const recentEnemy = state?.recentEnemyTick != undefined && Game.time - state.recentEnemyTick <= interval
    const limited = interval > 1 && room.controller?.my && room.controller.level === 8 &&
        Game.cpu?.bucket < roomPolicy.defense.roadInspectionBucket && !room.enemies?.length && !recentEnemy
    if (!limited) {
        // The next low-bucket pass must discover changes made while scans were unrestricted.
        if (state != undefined) state.pendingIds = undefined
        for (const road of room.roads) if (roadIsRepairable(road, tower, road.hits, road.hitsMax)) return road
        return undefined
    }
    const inspection = state || roadInspection(room)
    const fullScan = inspection.pendingIds == undefined || inspection.lastInspection == undefined ||
        Game.time - inspection.lastInspection >= interval ||
        Game.time !== inspection.lastInspection && Game.time % interval === inspection.phase % interval
    const pendingIds: Id<StructureRoad>[] = []
    let target: StructureRoad | undefined
    if (fullScan) {
        for (const road of room.roads) {
            const hits = road.hits, hitsMax = road.hitsMax
            // Minor damage stays on the ten-tick inspection schedule rather than becoming a per-tick ID lookup.
            if (!roadIsRepairable(road, tower, hits, hitsMax)) continue
            pendingIds.push(road.id)
            if (target == undefined) target = road
        }
        inspection.lastInspection = Game.time
    } else {
        for (const id of inspection.pendingIds!) {
            const road = Game.getObjectById(id)
            if (road == undefined || road.structureType !== STRUCTURE_ROAD || road.pos.roomName !== room.name) continue
            const hits = road.hits, hitsMax = road.hitsMax
            if (hits >= hitsMax) continue
            pendingIds.push(id)
            if (target == undefined && roadIsRepairable(road, tower, hits, hitsMax)) target = road
        }
    }
    inspection.pendingIds = pendingIds
    return target
}

function firstRepairTarget(room: Room, tower: StructureTower): Structure | undefined {
    const road = firstRoadRepairTarget(room, tower)
    if (road != undefined) return road
    for (const key of repairGroups) {
        for (const structure of room[key] as Structure[]) {
            const hits = structure.hits, hitsMax = structure.hitsMax
            if (hits >= hitsMax) continue
            return structure
        }
    }
    for (const key of repairSingles) {
        const structure = room[key] as Structure | undefined
        if (structure != undefined && structure.hits < structure.hitsMax) return structure
    }
    return undefined
}

export function findTowerEnemy(room: Room): void {
    runRoomTowerDefense(room)
    const enemies = room.enemies
    noteRoomEnemies(room, enemies.length > 0)
    if (enemies.length == 0) {
        Memory.warMode[room.name] = false
        room.memory.npcTarget = undefined
        return
    }
    if (
        Game.time % roomPolicy.defense.enemyScanInterval != 0 &&
        !Memory.warMode[room.name]
    )
        return
    const enemyList = enemies.filter((enemy) => {
        if (roomPolicy.defense.npcOwners.includes(enemy.owner.username))
            return false
        // Room getter 也可能返回 PowerCreep；这类对象没有 body。
        return (enemy.body || []).some(
            (part) =>
                part.hits !== 0 && (part.type == ATTACK ||
                part.type == RANGED_ATTACK ||
                part.type == WORK || part.type == CLAIM)
        )
    })
    if (enemyList.length > 0) {
        Memory.warMode[room.name] = true
        if (Game.time % roomPolicy.defense.notificationInterval == 0) {
            console.log(
                `notify_您的房间[${room.name}] 发现敌人 所有者[${enemyList[0].owner.username}]`
            )
        }
    }
    const npc = enemies.find(
        (enemy) =>
            enemy.owner.username == roomPolicy.defense.invaderOwner ||
            enemy.body?.length == 1
    )
    room.memory.npcTarget = npc?.id
}

export function repairStructure(room: Room): void {
    noteRoomEnemies(room)
    if (Memory.warMode[room.name]) return
    const tower = room.towers[0]
    if (tower == undefined || tower.store[RESOURCE_ENERGY] < TOWER_ENERGY_COST || hasTowerIntent(tower)) return
    const target = firstRepairTarget(room, tower)
    if (target != undefined) issueTowerRepair(tower, target)
}

export function autoEnableSafeMode(room: Room): void {
    const controller = room.controller
    if (
        controller == undefined ||
        controller.safeModeAvailable == 0 ||
        (controller.safeModeCooldown || 0) > 0 ||
        (controller.safeMode || 0) > 0 ||
        room.enemies.length == 0
    )
        return

    let damagedStructure: string | undefined
    if (room.storage != undefined && room.storage.hits < room.storage.hitsMax)
        damagedStructure = STRUCTURE_STORAGE
    else if (
        room.terminal != undefined &&
        room.terminal.hits < room.terminal.hitsMax
    )
        damagedStructure = STRUCTURE_TERMINAL
    else if (
        room.spawns.length == 1 &&
        room.spawns[0].hits < room.spawns[0].hitsMax
    )
        damagedStructure = 'spawns'

    if (damagedStructure != undefined && controller.activateSafeMode() == OK) {
        console.log(
            `notify_您的房间[${room.name}] [${damagedStructure}]受到攻击，安全模式已激活`
        )
    }
}
