import { interShardPolicy } from 'settings/interShard'
import { recordShardDelivery } from './state'
import { isShardUnitData, ShardUnitData, ShardUnitKind } from './missions'
import { travelPortalRoute } from './travel'
import { readRemoteShardState } from './transport'
import { clearTravelPreparation, ensureUnitRoute } from './routing'
import { forgetPortal } from './portalIntel'
import { acquireBuilderEnergy, updateBuilderEnergyPhase } from 'role/support/builderEnergy'
import { upgradeBuilderAtStablePosition } from 'role/support/builderWorkPosition'

let reservationTick = -1
let reservationShard = ''
const roomWithdrawals = new Map<string, number>()
const storeWithdrawals = new Map<string, number>()

function range(first: RoomPosition, second: RoomPosition): number {
    return Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y))
}

function closest<T extends { pos: RoomPosition }>(creep: Creep, items: T[]): T | undefined {
    let result: T | undefined
    let distance = Infinity
    for (const item of items) {
        const next = range(creep.pos, item.pos)
        if (next < distance) { distance = next; result = item }
    }
    return result
}

function enterRoom(creep: Creep, roomName: string): boolean {
    if (creep.room.name == roomName) return true
    creep.moveTo(new RoomPosition(25, 25, roomName), { range: 20 })
    return false
}

function stores(room: Room): AnyStoreStructure[] {
    return [room.storage, room.terminal, ...room.containers].filter((item): item is StructureStorage | StructureTerminal | StructureContainer =>
        item != undefined && (!('my' in item) || item.my !== false))
}

function switchRoute(data: ShardUnitData, returning: boolean): void {
    data.route = returning ? data.task.returnRoute! : data.task.route
    data.originShard = returning ? data.task.targetShard : data.task.sourceShard
    data.hopIndex = 0
    clearTravelPreparation(data)
}

function travel(creep: Creep, data: ShardUnitData): boolean {
    if (!ensureUnitRoute(creep, data)) return false
    const result = travelPortalRoute(creep, data)
    if ((data.phase == 'return' ? data.task.autoReturn : data.task.autoRoute) &&
        (result.reason == 'portal-missing' || result.reason == 'portal-destination' || result.reason == 'no-path')) {
        const hop = data.route[data.hopIndex]
        if (hop != undefined && result.reason != 'no-path') forgetPortal(hop)
        // 下一次 travel 才执行新的路线，避免同 tick 重复发布/移动。
        ensureUnitRoute(creep, data, true, hop)
        return false
    }
    if (result.status == 'error' || result.status == 'waiting') data.lastError = result.message
    if (result.status != 'arrived') return false
    delete data.lastError
    return true
}

function acquireLocalEnergy(creep: Creep): boolean {
    return acquireBuilderEnergy(creep)
}

function runClaimer(creep: Creep, data: ShardUnitData): boolean {
    if (data.done) return false
    const command = data.task.sourceShard == Game.shard.name ? Memory.shardMissions?.[data.missionId] :
        readRemoteShardState(data.task.sourceShard)?.reports?.[data.missionId] as { type?: string; state?: string } | undefined
    if (command?.state == 'cancelled' || command?.state == 'paused') {
        data.lastError = '任务已暂停或取消，停止占领'
        return false
    }
    if (!travel(creep, data) || Game.shard.name != data.task.targetShard || !enterRoom(creep, data.task.targetRoom)) return false
    const controller = creep.room.controller
    if (controller == undefined) { data.lastError = '目标房间没有 Controller'; return false }
    if (controller.my) { data.done = true; data.phase = 'done'; delete data.lastError; return true }
    if (controller.owner != undefined || (controller.reservation != undefined && controller.reservation.username != creep.owner.username)) {
        data.lastError = '目标被其他玩家占领或预定'; return false
    }
    if (range(creep.pos, controller.pos) > 1) { creep.moveTo(controller, { range: 1 }); return false }
    if (data.lastClaimTick != undefined && Game.time - data.lastClaimTick < interShardPolicy.claimRetryInterval) return false
    data.lastClaimTick = Game.time
    const result = creep.claimController(controller)
    if (result == ERR_GCL_NOT_ENOUGH) data.lastError = 'GCL 不足，无法占领目标房间'
    else if (result != OK) data.lastError = `claimController: ${result}`
    else delete data.lastError
    return result == OK
}

function runBuilder(creep: Creep, data: ShardUnitData): boolean {
    if (data.phase != 'work') {
        creep.memory.dontPullMe = false
        if (!travel(creep, data) || Game.shard.name != data.task.targetShard || !enterRoom(creep, data.task.targetRoom)) return false
        data.phase = 'work'
    }
    const controller = creep.room.controller
    if (!controller?.my) { creep.memory.dontPullMe = false; data.lastError = '等待目标占领'; return false }
    delete data.lastError
    updateBuilderEnergyPhase(creep)
    if (!creep.memory.working) {
        if (creep.room.constructionSites.length === 0 && controller.level < data.task.targetLevel &&
            range(creep.pos, controller.pos) <= 3 && upgradeBuilderAtStablePosition(creep, controller)) return true
        creep.memory.dontPullMe = false
        const acquiring = acquireLocalEnergy(creep)
        if (!acquiring && creep.store[RESOURCE_ENERGY] > 0) creep.memory.working = true
        return acquiring
    }
    // 新控制器在施工期间也要避免降级，先保障自建设能持续运行。
    if (controller.ticksToDowngrade < interShardPolicy.downgradeWarningTicks) {
        return upgradeBuilderAtStablePosition(creep, controller)
    }
    const sites = creep.room.constructionSites
    const firstSpawn = creep.room.spawns.length == 0 ? sites.filter((site) => site.structureType == STRUCTURE_SPAWN) : []
    const site = closest(creep, firstSpawn.length > 0 ? firstSpawn : sites)
    if (site != undefined) {
        const result = creep.build(site)
        creep.memory.dontPullMe = result === OK
        if (result == ERR_NOT_IN_RANGE) creep.moveTo(site, { range: 3, ignoreCreeps: false })
        return true
    }
    if (controller.level < data.task.targetLevel) {
        return upgradeBuilderAtStablePosition(creep, controller)
    }
    creep.memory.dontPullMe = false
    const fill = closest(creep, [...creep.room.spawns, ...creep.room.extensions].filter((item) => item.my !== false && item.store.getFreeCapacity(RESOURCE_ENERGY) > 0))
    if (fill != undefined) {
        if (creep.transfer(fill, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) creep.moveTo(fill, { range: 1 })
        return true
    }
    const damaged = closest(creep, creep.room.structuresNeedRepair.filter((item) => item.structureType != STRUCTURE_RAMPART && item.structureType != STRUCTURE_WALL))
    if (damaged != undefined) {
        if (creep.repair(damaged) == ERR_NOT_IN_RANGE) creep.moveTo(damaged, { range: 3 })
        return true
    }
    return false
}

function loadHauler(creep: Creep, data: ShardUnitData): boolean {
    if (Game.shard.name != data.task.sourceShard || !enterRoom(creep, data.task.sourceRoom)) return false
    const mission = Memory.shardMissions?.[data.missionId]
    if (mission?.state == 'paused') return false
    if (mission?.state == 'complete' || mission?.state == 'cancelled') {
        data.done = true
        data.phase = 'done'
        return false
    }
    const capacity = creep.store.getCapacity(RESOURCE_ENERGY) || 0
    const cargo = creep.store[RESOURCE_ENERGY]
    if (data.loadStarted == undefined) data.loadStarted = Game.time
    if (cargo > 0 && (cargo >= capacity * interShardPolicy.minimumLoadFraction ||
        Game.time - data.loadStarted >= interShardPolicy.partialLoadWait)) {
        switchRoute(data, false)
        data.phase = 'outbound'
        delete data.loadStarted
        return true
    }
    const candidates = stores(creep.room)
    if (reservationTick != Game.time || reservationShard != Game.shard.name) {
        reservationTick = Game.time; reservationShard = Game.shard.name
        roomWithdrawals.clear(); storeWithdrawals.clear()
    }
    const available = Math.max(0, candidates.reduce((total, item) => total + item.store[RESOURCE_ENERGY], 0) - data.task.homeEnergyReserve - (roomWithdrawals.get(creep.room.name) || 0))
    const configured = data.task.sourceEnergyId ? Game.getObjectById<AnyStoreStructure>(data.task.sourceEnergyId) : undefined
    const target = configured != undefined && candidates.some((item) => item.id == configured.id) ? configured : closest(creep,
        candidates.filter((item) => item.store[RESOURCE_ENERGY] > (storeWithdrawals.get(item.id) || 0)))
    if (available <= 0 || target == undefined) { data.lastError = '等待起点物流库存超过保留量'; return false }
    const amount = Math.min(available, target.store[RESOURCE_ENERGY] - (storeWithdrawals.get(target.id) || 0), creep.store.getFreeCapacity(RESOURCE_ENERGY))
    if (amount <= 0) return false
    const result = creep.withdraw(target, RESOURCE_ENERGY, amount)
    if (result == ERR_NOT_IN_RANGE) creep.moveTo(target, { range: 1 })
    if (result == OK) {
        roomWithdrawals.set(creep.room.name, (roomWithdrawals.get(creep.room.name) || 0) + amount)
        storeWithdrawals.set(target.id, (storeWithdrawals.get(target.id) || 0) + amount)
    }
    delete data.lastError
    return true
}

function receiver(creep: Creep, data: ShardUnitData): AnyStoreStructure | Creep | undefined {
    const configured = data.task.targetEnergyId ? Game.getObjectById<AnyStoreStructure>(data.task.targetEnergyId) : undefined
    if (configured != undefined && configured.structureType !== STRUCTURE_LINK && configured.pos.roomName == creep.room.name &&
        (!('my' in configured) || configured.my) && configured.store?.getFreeCapacity(RESOURCE_ENERGY) > 0) return configured
    const essential = [...creep.room.spawns, ...creep.room.extensions].filter((item) => item.my !== false && item.store.getFreeCapacity(RESOURCE_ENERGY) > 0)
    if (essential.length > 0) return closest(creep, essential)
    const storage = closest(creep, stores(creep.room).filter((item) => item.store.getFreeCapacity(RESOURCE_ENERGY) > 0))
    if (storage != undefined) return storage
    // 还没有建筑时交给采建工，留在 cargo 中等待，避免掉落能量腐烂。
    const workers: Creep[] = []
    for (const name in Game.creeps) {
        const unit = Game.creeps[name]
        if (unit.name != creep.name && unit.room.name == creep.room.name && unit.getActiveBodyparts(WORK) > 0 && unit.store.getFreeCapacity(RESOURCE_ENERGY) > 0) workers.push(unit)
    }
    return closest(creep, workers)
}

function runHauler(creep: Creep, data: ShardUnitData): boolean {
    const pending = data.pendingDelivery
    if (pending != undefined) {
        if (pending.tick == Game.time) return false
        recordShardDelivery(data, Math.max(0, Math.min(pending.amount, pending.energyBefore - creep.store[RESOURCE_ENERGY])))
        delete data.pendingDelivery
    }
    if (data.phase == undefined) data.phase = 'load'
    if (data.phase == 'load') return loadHauler(creep, data)
    if (data.phase == 'return') {
        if (!travel(creep, data) || Game.shard.name != data.task.sourceShard || !enterRoom(creep, data.task.sourceRoom)) return false
        data.phase = 'load'
        delete data.loadStarted
        return true
    }
    if (data.phase == 'done') {
        const spawn = closest(creep, creep.room.spawns)
        if (spawn != undefined && spawn.recycleCreep(creep) == ERR_NOT_IN_RANGE) creep.moveTo(spawn, { range: 1 })
        return false
    }
    if (data.phase == 'outbound') {
        if (!travel(creep, data) || Game.shard.name != data.task.targetShard || !enterRoom(creep, data.task.targetRoom)) return false
        data.phase = 'work'
    }
    if (creep.store[RESOURCE_ENERGY] == 0) {
        if (data.task.autoReturn || data.task.returnRoute != undefined) {
            if (data.task.returnRoute == undefined) data.task.returnRoute = []
            switchRoute(data, true); data.phase = 'return'
        }
        else { data.phase = 'done'; data.done = true }
        return true
    }
    if (!creep.room.controller?.my) { data.lastError = '等待目标占领后交付能量'; return false }
    const target = receiver(creep, data)
    if (target == undefined) { data.lastError = '等待目标可接收能量的建筑或建造工'; return false }
    const amount = Math.min(creep.store[RESOURCE_ENERGY], target.store.getFreeCapacity(RESOURCE_ENERGY))
    const result = creep.transfer(target, RESOURCE_ENERGY, amount)
    if (result == ERR_NOT_IN_RANGE) creep.moveTo(target, { range: 1 })
    if (result == OK) {
        data.pendingDelivery = { amount, energyBefore: creep.store[RESOURCE_ENERGY], tick: Game.time }
        delete data.lastError
    }
    return result == OK
}

/** 跨 shard 单位只消费显式任务；不依赖跨 shard Source/Structure ID 或 boost。 */
export function createShardRole(kind: Exclude<ShardUnitKind, 'scout'>): (data: CreepData) => ICreepConfig {
    return (data) => {
        const run = (creep: Creep): boolean => {
            if (!isShardUnitData(data) || data.unitKind != kind || !interShardPolicy.enabled) return false
            if (kind == 'claimer') return runClaimer(creep, data)
            if (kind == 'builder') return runBuilder(creep, data)
            return runHauler(creep, data)
        }
        return { isNeed: () => true, prepare: (creep) => !creep.spawning && isShardUnitData(data) && data.unitKind == kind, source: run, target: run }
    }
}
