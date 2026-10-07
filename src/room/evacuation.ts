import type { addCreepConfig } from 'creep/demand'
import { evacuationPolicy as policy } from 'settings/evacuation'
import { isRoomEvacuating, RoomEvacuationTask } from './evacuationState'

type ResourceAmounts = { [resource: string]: number }
type StockObject = AnyStoreStructure | Tombstone | Ruin | Resource
interface Stock { object: StockObject; resource: ResourceConstant; amount: number; drop: boolean }
interface Snapshot {
    stock: Stock[]
    remaining: ResourceAmounts
    nonWithdrawable: ResourceAmounts
    manualCargo: ResourceAmounts
    outsideTerminal: number
    workers: Creep[]
    carriers: Creep[]
    healthyCarrierCount: number
    reservedSpawnEnergy: number
    passiveSpawnEnergy: number
}
let snapshotTick = -1, snapshotShard = ''
const snapshots = new Map<string, Snapshot>()
const reservations = new Map<string, number>()
const receiving = new Map<string, number>()
const activeStructures = new Map<string, boolean>()
const economicRoles = new Set<string>(['filler', 'manager', 'processer', 'builder', 'repairer', 'harvester', 'miner', 'upgrader', 'rFiller', 'rHarvester', 'rBuilder', 'scout'])
const roomNamePattern = /^[WE]\d+[NS]\d+$/

function reset(): void {
    if (snapshotTick === Game.time && snapshotShard === Game.shard.name) return
    snapshotTick = Game.time; snapshotShard = Game.shard.name
    snapshots.clear(); reservations.clear(); receiving.clear(); activeStructures.clear()
}
function amount(store: StoreDefinition, resource: ResourceConstant): number {
    const value = store[resource]
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}
function add(result: ResourceAmounts, resource: string, value: number): void {
    if (value > 0) result[resource] = (result[resource] || 0) + value
}
function total(resources: ResourceAmounts): number {
    let value = 0
    for (const resource in resources) value += resources[resource]
    return value
}
function eligible(creep: Creep): boolean {
    return !creep.memory.isTeam && !creep.memory.combatTaskId && economicRoles.has(creep.memory.role)
}
function activeParts(creep: Creep, part: BodyPartConstant): number {
    return creep.getActiveBodyparts(part)
}
function belongs(creep: Creep, room: Room): boolean {
    return evacuationRoomFor(creep)?.name === room.name
}
function evacuationRoomFor(creep: Creep): Room | undefined {
    const home = Game.rooms[creep.memory.spawnRoom]
    if (home && isRoomEvacuating(home) && eligible(creep)) return home
    if (!isRoomEvacuating(creep.room)) return undefined
    if (['rFiller', 'rBuilder'].includes(creep.memory.role)) {
        const target = (creep.memory.data as RemoteFillerData | RemoteBuilderData).targetFlag
        const targetRoom = Game.flags?.[target]?.pos.roomName || Game.getObjectById<Structure>(target)?.pos.roomName
        return targetRoom === creep.room.name ? creep.room : undefined
    }
    if (creep.memory.role === 'rHarvester' || creep.memory.role === 'scout') return undefined
    return creep.room
}
function minimumNonEnergyFees(room: Room, remaining: ResourceAmounts): number {
    let fees = 0
    const maximum = policy.maximumSendAmount
    for (const resource in remaining) {
        if (resource === RESOURCE_ENERGY) continue
        const batches = Math.floor(remaining[resource] / maximum), rest = remaining[resource] % maximum
        if (batches > 0) fees += batches * fee(maximum, room.name, room.memory.evacuation!.targetRoom, 1)
        if (rest > 0) fees += fee(rest, room.name, room.memory.evacuation!.targetRoom, 1)
    }
    return fees
}
function replacementBudget(room: Room, remaining: ResourceAmounts): number {
    const energyOutsidePool = Math.max(0, (remaining[RESOURCE_ENERGY] || 0) - room.energyAvailable)
    const poolFeeReserve = Math.max(0, minimumNonEnergyFees(room, remaining) - energyOutsidePool)
    return Math.max(0, Math.min(policy.carrierMaximumCost, room.energyAvailable - poolFeeReserve))
}
function energyReserve(room: Room, workers: Creep[], outsideTerminal: number, remaining: ResourceAmounts): number {
    const mobileCargo = workers.reduce((value, creep) => value +
        (!creep.spawning && activeParts(creep, MOVE) > 0 ? creep.store.getUsedCapacity() : 0), 0)
    // The final load already carried by a live worker does not justify refilling a replacement spawn.
    if (outsideTerminal <= room.energyAvailable + mobileCargo || room.spawns.length === 0) return 0
    const healthy = workers.filter(creep => !creep.spawning && (creep.ticksToLive || 0) > policy.minimumCarrierTicksToLive &&
        activeParts(creep, MOVE) > 0 && creep.store.getCapacity()! > 0)
    const enoughEnergy = (remaining[RESOURCE_ENERGY] || 0) >= minimumNonEnergyFees(room, remaining) + policy.minimumCarrierSpawnEnergy
    return healthy.length > 0 || !enoughEnergy ? 0 : policy.minimumCarrierSpawnEnergy
}
function activeSpawnIds(room: Room): string[] {
    return room.spawns.filter(spawn => isPooledStructure(spawn)).map(spawn => spawn.id).sort()
}
function isPooledStructure(object: AnyStoreStructure): boolean {
    return (object.structureType === STRUCTURE_SPAWN || object.structureType === STRUCTURE_EXTENSION) &&
        object.my !== false && isActiveStructure(object)
}
function isActiveStructure(object: AnyStoreStructure): boolean {
    reset()
    const previous = activeStructures.get(object.id)
    if (previous !== undefined) return previous
    const active = typeof object.isActive !== 'function' || object.isActive()
    activeStructures.set(object.id, active)
    return active
}
function poolReservations(room: Room): number {
    let value = 0
    for (const object of [...room.spawns, ...room.extensions]) if (isPooledStructure(object))
        value += reservations.get(`${object.id}/${RESOURCE_ENERGY}`) || 0
    return value
}
function observePassiveSpawnEnergy(room: Room): number {
    const task = room.memory.evacuation!
    const spawnIds = activeSpawnIds(room), pool = room.energyAvailable
    if (pool === 0) {
        task.spawnPoolDrain = { tick: Game.time, spawnIds, observedAt: Game.time, energy: 0 }
        return 0
    }
    const proof = task.spawnPoolDrain
    if (!proof || Game.time <= proof.tick) return 0
    const lastObserved = proof.observedAt ?? proof.tick, previousEnergy = proof.energy ?? 0
    const elapsed = Game.time - lastObserved
    const maximum = Math.min(policy.passiveSpawnEnergyThreshold + Math.max(0, spawnIds.length - 1) * policy.passiveSpawnEnergyPerTick,
        previousEnergy + Math.max(0, elapsed) * spawnIds.length * policy.passiveSpawnEnergyPerTick)
    if (elapsed > policy.maximumPassiveProofGapTicks || spawnIds.join(',') !== proof.spawnIds.join(',') ||
        room.extensions.some(extension => amount(extension.store, RESOURCE_ENERGY) > 0) || pool > maximum) {
        delete task.spawnPoolDrain
        return 0
    }
    proof.observedAt = Game.time; proof.energy = pool
    return pool
}
function getSnapshot(room: Room): Snapshot {
    reset()
    const previous = snapshots.get(room.name)
    if (previous !== undefined) return previous
    const result: Snapshot = { stock: [], remaining: {}, nonWithdrawable: {}, manualCargo: {}, outsideTerminal: 0,
        workers: [], carriers: [], healthyCarrierCount: 0, reservedSpawnEnergy: 0, passiveSpawnEnergy: 0 }
    const hostile = (Memory.warMode?.[room.name] === true || (room.enemies?.length || 0) > 0)
    const objects: StockObject[] = [...room.structures.filter((object): object is AnyStoreStructure => 'store' in object &&
        (!("my" in object) || object.my !== false)), ...room.ruins, ...room.tombstones, ...room.droppedResource]
    const ids = new Set<string>()
    for (const object of objects) {
        if (ids.has(object.id)) continue
        ids.add(object.id)
        if ('amount' in object) {
            if (object.amount > 0) {
                result.stock.push({ object, resource: object.resourceType, amount: object.amount, drop: true })
                add(result.remaining, object.resourceType, object.amount); result.outsideTerminal += object.amount
            }
            continue
        }
        const locked = 'structureType' in object && object.structureType === STRUCTURE_NUKER
        const towerProtected = hostile && 'structureType' in object && object.structureType === STRUCTURE_TOWER
        for (const key in object.store) {
            const resource = key as ResourceConstant, value = amount(object.store, resource)
            if (!value) continue
            add(locked ? result.nonWithdrawable : result.remaining, resource, value)
            if (locked) continue
            if (object.id !== room.terminal?.id) {
                result.outsideTerminal += value
                if (!towerProtected) result.stock.push({ object, resource, amount: value, drop: false })
            }
        }
    }
    for (const name in Game.creeps) {
        const creep = Game.creeps[name]
        const worker = eligible(creep) && belongs(creep, room)
        if (!worker && creep.room.name !== room.name) continue
        if (worker) result.workers.push(creep)
        // Cargo from an outbound dedicated mission is not stolen; it is reported until it leaves.
        for (const key in creep.store) {
            const resource = key as ResourceConstant, value = amount(creep.store, resource)
            add(result.remaining, resource, value)
            if (!worker) add(result.manualCargo, resource, value)
            else result.outsideTerminal += value
        }
    }
    for (const name in Game.powerCreeps || {}) {
        const unit = Game.powerCreeps[name]
        if (unit.room?.name !== room.name) continue
        for (const key in unit.store) {
            const resource = key as ResourceConstant, value = amount(unit.store, resource)
            add(result.remaining, resource, value); add(result.manualCargo, resource, value)
        }
    }
    const mobile = result.workers.filter(creep => !creep.spawning && creep.room.name === room.name &&
        (creep.ticksToLive || 0) > 0 && activeParts(creep, MOVE) > 0 && creep.store.getCapacity()! > 0)
    const healthy = mobile.filter(creep => (creep.ticksToLive || 0) > policy.minimumCarrierTicksToLive)
    result.healthyCarrierCount = healthy.length
    // Dying workers still feed a replacement spawn; excluding all of them would strand the energy.
    const candidates = healthy.length > 0 ? healthy : mobile
    const throughput = (creep: Creep): number => {
        const moving = activeParts(creep, MOVE), weight = creep.body.filter(part => part.hits > 0 && part.type !== MOVE).length
        return (creep.store.getCapacity() || 0) * Math.min(1, moving * 2 / Math.max(1, weight))
    }
    const previousNames = room.memory.evacuation?.carriers || []
    candidates.sort((first, second) => throughput(second) - throughput(first) ||
        Number(previousNames.includes(second.name)) - Number(previousNames.includes(first.name)) || first.name.localeCompare(second.name))
    result.carriers = candidates.slice(0, policy.maximumCarriers)
    const passive = observePassiveSpawnEnergy(room)
    // During mineral evacuation this trickle can still pay the fees; only energy-tail work ignores it.
    if (snapshotNonEnergy(result) === 0 && total(result.manualCargo) === 0) {
        result.passiveSpawnEnergy = passive
        result.outsideTerminal = Math.max(0, result.outsideTerminal - passive)
        if (passive > 0) result.stock = result.stock.filter(stock =>
            !('structureType' in stock.object) || stock.object.structureType !== STRUCTURE_SPAWN || !isPooledStructure(stock.object))
    }
    result.reservedSpawnEnergy = energyReserve(room, result.workers, result.outsideTerminal, result.remaining)
    if (room.memory.evacuation) room.memory.evacuation.carriers = result.carriers.map(creep => creep.name)
    snapshots.set(room.name, result)
    return result
}
function update(task: RoomEvacuationTask, status: RoomEvacuationTask['status'], message: string): void {
    task.status = status; task.lastMessage = message; task.updatedAt = Game.time
}
function ownedTerminal(name: string): Room | undefined {
    const room = Game.rooms[name]
    return room?.controller?.my && room.terminal?.my !== false && room.terminal !== undefined &&
        isActiveStructure(room.terminal) ? room : undefined
}

/** This command only creates an evacuation; the player retains control of unclaim. */
export function createRoomEvacuation(from: string, to: string): string {
    if (typeof from !== 'string' || typeof to !== 'string' || !roomNamePattern.test(from) || !roomNamePattern.test(to))
        return '请填写当前 shard 的房间名，例如 evacuateRoom("E31N2", "E34N3")'
    if (from === to) return '起点和终点不能相同'
    const source = ownedTerminal(from), target = ownedTerminal(to)
    if (source === undefined || target === undefined) return '起点和终点必须是当前 shard 可见、自有且有终端的房间'
    const previous = source.memory.evacuation
    if (previous) return previous.targetRoom === to ? `撤离任务已存在：${from} → ${to}；使用 evacuationStatus("${from}") 查看` :
        '该房间已有其他目标的撤离任务，请先 evacuationCancel 取消后再修改目标'
    if (isRoomEvacuating(target)) return '目标房间正在撤离，不能接收撤离库存'
    for (const name in Memory.rooms || {}) if (Memory.rooms[name].evacuation?.targetRoom === from)
        return '该房间是其他撤离任务的接收目标，请先取消相关任务'
    source.memory.evacuation = { targetRoom: to, status: 'draining', createdAt: Game.time, updatedAt: Game.time,
        lastMessage: '已开始归集库存；不会自动 unclaim', sent: {}, energySpent: 0, carriers: [], blocked: [] }
    // Ordinary jobs are suspended by terminal integration and remain resumable after cancel.
    // A stale population queue must not reproduce economy workers before its next refresh.
    for (const name in source.memory.creepConfig) if (!['defender', 'rdefender'].includes(source.memory.creepConfig[name].role)) delete source.memory.creepConfig[name]
    source.memory.creepSpawnQueue = source.memory.creepSpawnQueue.filter(name => source.memory.creepConfig[name] !== undefined)
    reset(); snapshots.delete(from)
    return `已创建撤离任务：${from} → ${to}。停止本房生产并搬运可取库存；查看 evacuationStatus("${from}")，完成后自行 unclaim。`
}

function energyMultiplier(room: Room | undefined): number {
    const effect = room?.terminal?.effects?.find(item => item.effect === PWR_OPERATE_TERMINAL && item.ticksRemaining > 0)
    if (!effect || !('level' in effect) || effect.level === undefined) return 1
    const multiplier = POWER_INFO[PWR_OPERATE_TERMINAL].effect
    return Array.isArray(multiplier) ? multiplier[effect.level - 1] : multiplier
}
function fee(amountToSend: number, from: string, to: string, multiplier = energyMultiplier(Game.rooms[from])): number {
    return Math.ceil(Game.market.calcTransactionCost(amountToSend, from, to) * multiplier)
}
function maximumAffordable(resource: ResourceConstant, maximum: number, energy: number, from: string, to: string, reserve: number): number {
    let low = 0, high = Math.max(0, Math.floor(maximum)), iterations = 0
    while (low < high && iterations++ < policy.maximumTransactionSearchSteps) {
        const middle = Math.ceil((low + high) / 2)
        // Terminal.send validates the undiscounted fee, even under OPERATE_TERMINAL.
        const spent = fee(middle, from, to, 1) + (resource === RESOURCE_ENERGY ? middle : 0)
        if (spent + reserve <= energy) low = middle
        else high = middle - 1
    }
    return low
}
function snapshotNonEnergy(snapshot: Snapshot): number {
    return total(snapshot.remaining) - (snapshot.remaining[RESOURCE_ENERGY] || 0)
}
function terminalDust(room: Room, target: Room, snapshot: Snapshot): number {
    const remaining = total(snapshot.remaining) - snapshot.passiveSpawnEnergy
    return remaining > 0 && remaining === (snapshot.remaining[RESOURCE_ENERGY] || 0) - snapshot.passiveSpawnEnergy && snapshot.outsideTerminal === 0 &&
        total(snapshot.manualCargo) === 0 && maximumAffordable(RESOURCE_ENERGY, remaining, amount(room.terminal!.store, RESOURCE_ENERGY), room.name, target.name, 0) === 0
        ? remaining : 0
}
function targetCapacity(target: Room): number {
    reset()
    return Math.max(0, target.terminal!.store.getFreeCapacity()! - (receiving.get(target.name) || 0))
}
export function getEvacuationIncomingCapacity(target: Room): number {
    return target.terminal ? targetCapacity(target) : 0
}
export function reserveEvacuationIncoming(target: Room, value: number): void {
    reset()
    if (Number.isFinite(value) && value > 0) receiving.set(target.name, (receiving.get(target.name) || 0) + value)
}

export function processRoomEvacuation(room: Room): void {
    const task = room.memory.evacuation
    if (task === undefined) return
    const terminal = room.terminal, target = ownedTerminal(task.targetRoom)
    if (terminal === undefined || ownedTerminal(room.name) === undefined) { update(task, 'waiting', '源房失去控制、终端不存在或等级不足以启用终端，尚未完成'); return }
    if (target === undefined || isRoomEvacuating(target)) { update(task, 'waiting', '目标失去控制、终端不存在或正在撤离'); return }
    if (task.pending) {
        const pending = task.pending
        const transaction = (Game.market.outgoingTransactions || []).find(item => item.description === pending.description &&
            item.from === room.name && item.to === task.targetRoom && item.resourceType === pending.resource)
        if (transaction) {
            add(task.sent, transaction.resourceType, transaction.amount)
            task.energySpent += fee(transaction.amount, room.name, task.targetRoom, pending.energyMultiplier)
            delete task.pending
        } else if (Game.time - pending.tick <= policy.transactionConfirmationTicks) {
            update(task, 'waiting', '发送 intent 已提交，等待实际交易记录确认'); return
        } else {
            delete task.pending
            update(task, 'waiting', '未发现实际发送记录，按现存库存重试')
        }
    }
    const snapshot = getSnapshot(room), remaining = total(snapshot.remaining) - snapshot.passiveSpawnEnergy
    const dust = terminalDust(room, target, snapshot)
    if (remaining === 0 || dust > 0) {
        if (task.emptySince === undefined) task.emptySince = Game.time
        if (Game.time - task.emptySince >= policy.completeConfirmationTicks)
            update(task, 'complete', `可发送库存已清空${dust ? `；剩余 ${dust} 能量不足以支付最后一笔运费` : ''}${snapshot.passiveSpawnEnergy ? `；Spawn 新再生 ${snapshot.passiveSpawnEnergy} 能量单列保留` : ''}。房间保持停产，确认状态后可自行 unclaim`)
        else update(task, 'draining', '库存已清空，等待下一 tick 确认实际结果')
        return
    }
    delete task.emptySince
    if (task.lastSentTick === Game.time) return
    if (targetCapacity(target) < 1) { update(task, 'waiting', '目标终端容量不足，保留源房库存等待'); return }
    if (terminal.cooldown > 0) { update(task, 'draining', `终端冷却 ${terminal.cooldown} tick，继续归集库存`); return }
    const energy = amount(terminal.store, RESOURCE_ENERGY)
    const nonEnergy = snapshotNonEnergy(snapshot)
    let selected: ResourceConstant | undefined, sendAmount = 0
    for (const key in terminal.store) {
        const resource = key as ResourceConstant, available = amount(terminal.store, resource)
        if (!available || resource === RESOURCE_ENERGY) continue
        const candidate = maximumAffordable(resource, Math.min(available, targetCapacity(target), policy.maximumSendAmount), energy, room.name, target.name, 0)
        if (candidate > sendAmount) { selected = resource; sendAmount = candidate }
    }
    if (selected === undefined && nonEnergy === 0) {
        const maximum = Math.min(energy, targetCapacity(target), policy.maximumSendAmount)
        // Spawn reserve remains outside the terminal; it is not an artificial permanent terminal reserve.
        sendAmount = maximumAffordable(RESOURCE_ENERGY, maximum, energy, room.name, target.name,
            Math.max(0, snapshot.reservedSpawnEnergy - room.energyAvailable))
        if (sendAmount > 0) selected = RESOURCE_ENERGY
    }
    if (selected !== undefined && sendAmount > 0) {
        const description = `evac:${room.name}:${task.createdAt}:${Game.time}`
        const code = terminal.send(selected, sendAmount, target.name, description)
        if (code === OK) {
            task.lastSentTick = Game.time
            task.pending = { tick: Game.time, description, resource: selected, requestedAmount: sendAmount, energyMultiplier: energyMultiplier(room) }
            reserveEvacuationIncoming(target, sendAmount)
            update(task, 'draining', `已提交发送 ${selected} ${sendAmount}，等待下一 tick 反映库存`)
        } else update(task, 'waiting', `终端发送失败：${code}；库存保留等待重试`)
        return
    }
    if (total(snapshot.manualCargo) > 0) update(task, 'waiting', '专属任务或 PowerCreep 携带库存，需要自行卸货或离开源房')
    else if (snapshot.outsideTerminal > 0 && snapshot.carriers.length === 0) update(task, 'waiting', '等待移动搬运工或补充孵化能量')
    else if (nonEnergy > 0 && energy === 0) update(task, 'waiting', '终端缺少运费能量，正在归集；若本房已无能量需外部补充')
    else update(task, 'draining', '继续归集库存到终端，保留能量支付非能量库存运费')
}

function idle(creep: Creep, room: Room): void {
    creep.memory.dontPullMe = false
    if (room.memory.restrictedPos) delete room.memory.restrictedPos[creep.name]
    if (creep.room.name !== room.name || !room.terminal || distance(creep.pos, room.terminal.pos) >= policy.idleTerminalRange || activeParts(creep, MOVE) <= 0) return
    // Clear an idle delivery tile with one local step rather than another full path search.
    const terrain = room.getTerrain(), choices: [number, number, DirectionConstant][] = [[0,-1,TOP],[1,-1,TOP_RIGHT],[1,0,RIGHT],[1,1,BOTTOM_RIGHT],
        [0,1,BOTTOM],[-1,1,BOTTOM_LEFT],[-1,0,LEFT],[-1,-1,TOP_LEFT]]
    for (const [dx, dy, direction] of choices) {
        const x = creep.pos.x + dx, y = creep.pos.y + dy
        if (x < 1 || x > 48 || y < 1 || y > 48 || terrain.get(x, y) & TERRAIN_MASK_WALL ||
            Math.max(Math.abs(x-room.terminal.pos.x), Math.abs(y-room.terminal.pos.y)) < policy.idleTerminalRange) continue
        if (room.lookForAt(LOOK_CREEPS, x, y).length || room.lookForAt(LOOK_STRUCTURES, x, y).some(object =>
            (OBSTACLE_OBJECT_TYPES as readonly string[]).includes(object.structureType) || object.structureType === STRUCTURE_RAMPART &&
            !(object as StructureRampart).my && !(object as StructureRampart).isPublic)) continue
        creep.move(direction); return
    }
}
function distance(first: { x: number; y: number; roomName: string }, second: typeof first): number {
    return first.roomName === second.roomName ? Math.max(Math.abs(first.x-second.x), Math.abs(first.y-second.y)) : Infinity
}
function recordBlocked(task: RoomEvacuationTask, id: string): void {
    task.blocked = task.blocked.filter(item => item.until > Game.time && item.id !== id)
    task.blocked.push({ id, until: Game.time + policy.blockedTargetRetryTicks })
    if (task.blocked.length > policy.maximumBlockedTargets) task.blocked.shift()
    update(task, 'waiting', `搬运路径不可达：${id}，稍后重试`)
}
function move(creep: Creep, target: StockObject, task: RoomEvacuationTask): void {
    if (creep.moveTo(target, { range: policy.actionRange }) === ERR_NO_PATH) recordBlocked(task, target.id)
}
function reserved(stock: Stock): number { return reservations.get(`${stock.object.id}/${stock.resource}`) || 0 }
function reserve(stock: Stock, value: number): void { reservations.set(`${stock.object.id}/${stock.resource}`, reserved(stock) + value) }
function spawnRefill(room: Room, snapshot: Snapshot): StructureSpawn | StructureExtension | undefined {
    if (snapshot.reservedSpawnEnergy <= room.energyAvailable) return undefined
    return [...room.spawns, ...room.extensions].find(object => object.store.getFreeCapacity(RESOURCE_ENERGY)! > 0)
}
function stagingDeposit(room: Room): StructureStorage | StructureContainer | undefined {
    return [room.storage, ...room.containers].find(object => object !== undefined && object.store.getFreeCapacity()! > 0)
}
function feeStaging(room: Room, snapshot: Snapshot): number {
    const terminal = room.terminal!
    if (snapshotNonEnergy(snapshot) <= 0) return 0
    const pending = Math.min(snapshotNonEnergy(snapshot), policy.maximumSendAmount)
    return Math.min(policy.terminalFeeStagingEnergy, Math.max(1, fee(pending, room.name, room.memory.evacuation!.targetRoom, 1))) - amount(terminal.store, RESOURCE_ENERGY)
}
function recoverCancelledCargo(creep: Creep): boolean {
    const memory = creep.memory as CreepMemory & { evacuationCargoRoom?: string }
    if (!memory.evacuationCargoRoom) return false
    let resource: ResourceConstant | undefined
    for (const key in creep.store) if (amount(creep.store, key as ResourceConstant) > 0) { resource = key as ResourceConstant; break }
    if (!resource) {
        delete memory.evacuationCargoRoom
        creep.memory.working = false; creep.memory.ready = false; creep.memory.dontPullMe = false
        return false
    }
    const candidates = [creep.room, Game.rooms[memory.evacuationCargoRoom], Game.rooms[creep.memory.spawnRoom]]
    const local = candidates.find(room => room?.controller?.my && [room.storage, room.terminal].some(object =>
        object !== undefined && object.store.getFreeCapacity(resource)! > 0))
    const target = local ? [local.storage, local.terminal].find(object =>
        object !== undefined && object.store.getFreeCapacity(resource)! > 0) : undefined
    if (!target) return true
    const free = target.id === local!.terminal?.id ? getEvacuationIncomingCapacity(local!) : target.store.getFreeCapacity(resource)!
    if (free <= 0) return true
    if (distance(creep.pos, target.pos) > policy.actionRange) creep.moveTo(target, { range: policy.actionRange })
    else {
        const value = Math.min(amount(creep.store, resource), free)
        if (creep.transfer(target, resource, value) === OK && target.id === local!.terminal?.id) reserveEvacuationIncoming(local!, value)
    }
    return true
}

/** true means the normal economy role must not run this tick. */
export function runRoomEvacuationCreep(creep: Creep): boolean {
    if (!eligible(creep)) return false
    const room = evacuationRoomFor(creep)
    if (!room) return recoverCancelledCargo(creep)
    const task = room.memory.evacuation
    if (!task) return false
    ;(creep.memory as CreepMemory & { evacuationCargoRoom?: string }).evacuationCargoRoom = room.name
    creep.memory.dontPullMe = false
    if (room.memory.restrictedPos) delete room.memory.restrictedPos[creep.name]
    if (creep.spawning) return true
    if (creep.room.name !== room.name) {
        if (activeParts(creep, MOVE) > 0) creep.moveTo(new RoomPosition(policy.roomCenter, policy.roomCenter, room.name), { range: policy.roomTravelRange })
        return true
    }
    const terminal = room.terminal
    if (!room.controller?.my || !terminal) { update(task, 'waiting', '源房没有可用终端'); return true }
    const snapshot = getSnapshot(room), refill = spawnRefill(room, snapshot)
    for (const key in creep.store) {
        const resource = key as ResourceConstant, value = amount(creep.store, resource)
        if (!value) continue
        const target = task.staging?.[creep.name] ? stagingDeposit(room) : resource === RESOURCE_ENERGY && refill ? refill : terminal
        if (!target) { update(task, 'waiting', '暂存位置已满，保留搬运工货物等待'); return true }
        const free = target.id === terminal.id ? getEvacuationIncomingCapacity(room) : target.store.getFreeCapacity(resource)!
        if (free <= 0) { update(task, 'waiting', '源房终端已满，保留爬身库存等待发送'); return true }
        if (activeParts(creep, MOVE) <= 0 && distance(creep.pos, target.pos) > policy.actionRange) {
            update(task, 'waiting', `爬 ${creep.name} 携货但无移动能力，需要外部搬运或回收`); return true
        }
        if (distance(creep.pos, target.pos) > policy.actionRange) move(creep, target, task)
        else {
            const transferAmount = Math.min(value, free)
            if (creep.transfer(target, resource, transferAmount) === OK && target.id === terminal.id) reserveEvacuationIncoming(room, transferAmount)
        }
        return true
    }
    if (task.staging) delete task.staging[creep.name]
    if (!snapshot.carriers.some(unit => unit.name === creep.name)) { idle(creep, room); return true }
    if (terminal.store.getFreeCapacity()! <= 0 && feeStaging(room, snapshot) > 0 &&
        (snapshot.remaining[RESOURCE_ENERGY] || 0) > amount(terminal.store, RESOURCE_ENERGY) && stagingDeposit(room)) {
        for (const key in terminal.store) {
            const resource = key as ResourceConstant
            if (resource === RESOURCE_ENERGY || amount(terminal.store, resource) <= 0) continue
            if (distance(creep.pos, terminal.pos) > policy.actionRange) { move(creep, terminal, task); return true }
            const value = Math.min(amount(terminal.store, resource), creep.store.getFreeCapacity()!, stagingDeposit(room)!.store.getFreeCapacity()!, policy.maximumStagingBatch)
            if (value > 0 && creep.withdraw(terminal, resource, value) === OK) {
                if (!task.staging) task.staging = {}
                task.staging[creep.name] = true
            }
            return true
        }
    }
    if (terminal.store.getFreeCapacity()! <= 0 && feeStaging(room, snapshot) <= 0) return true
    const needEnergy = refill !== undefined || feeStaging(room, snapshot) > 0
    let selected: Stock | undefined, nearest = Infinity
    const currentPoolReserved = poolReservations(room)
    const stocks = refill && amount(terminal.store, RESOURCE_ENERGY) > 0 ?
        [...snapshot.stock, { object: terminal, resource: RESOURCE_ENERGY, amount: amount(terminal.store, RESOURCE_ENERGY), drop: false }] : snapshot.stock
    for (const candidate of stocks) {
        let available = candidate.amount - reserved(candidate)
        if (available <= 0 || needEnergy && candidate.resource !== RESOURCE_ENERGY ||
            task.blocked.some(item => item.id === candidate.object.id && item.until > Game.time)) continue
        if ('structureType' in candidate.object && isPooledStructure(candidate.object)) {
            available = Math.min(available, Math.max(0, room.energyAvailable - currentPoolReserved - snapshot.reservedSpawnEnergy))
            if (available <= 0) continue
        }
        const d = distance(creep.pos, candidate.object.pos)
        const spawnEnergy = candidate.resource === RESOURCE_ENERGY && 'structureType' in candidate.object && candidate.object.structureType === STRUCTURE_SPAWN
        // Spawn regeneration is endless; exhaust every finite energy stock before returning to Spawn.
        const priority = !needEnergy && candidate.resource !== RESOURCE_ENERGY ? 0 : spawnEnergy ? 2 : 1
        const score = priority * policy.stockPriorityDistancePenalty + d
        if (score < nearest) { selected = candidate; nearest = score }
    }
    if (!selected) { idle(creep, room); return true }
    if (distance(creep.pos, selected.object.pos) > policy.actionRange) { move(creep, selected.object, task); return true }
    let available = selected.amount - reserved(selected)
    const poolTarget = 'structureType' in selected.object && isPooledStructure(selected.object)
    if (poolTarget) {
        available = Math.min(available, Math.max(0, room.energyAvailable - currentPoolReserved - snapshot.reservedSpawnEnergy))
    }
    const value = Math.min(available, creep.store.getFreeCapacity()!)
    if (value <= 0) return true
    const code = selected.drop ? creep.pickup(selected.object as Resource) : creep.withdraw(selected.object as AnyStoreStructure, selected.resource, value)
    if (code === OK) {
        reserve(selected, value)
        if (poolTarget) {
            if (currentPoolReserved + value >= room.energyAvailable && room.energyAvailable > 0)
                task.spawnPoolDrain = { tick: Game.time, spawnIds: activeSpawnIds(room) }
        }
    }
    else if (code === ERR_INVALID_TARGET) recordBlocked(task, selected.object.id)
    return true
}

export function releaseRoomEvacuationConfigs(room: Room, publish: typeof addCreepConfig): void {
    if (!isRoomEvacuating(room) || !room.controller?.my || !room.terminal) return
    const snapshot = getSnapshot(room)
    if (snapshot.outsideTerminal <= 0 || room.spawns.length === 0) return
    if (snapshot.carriers.length > 0 && snapshot.reservedSpawnEnergy === 0) return
    const pending = Object.values(Game.creeps).filter(creep => creep.spawning && creep.memory.spawnRoom === room.name &&
        (creep.memory.data as { evacuationRoom?: string }).evacuationRoom === room.name).length
    const budget = replacementBudget(room, snapshot.remaining)
    if (budget < policy.minimumCarrierSpawnEnergy) return
    const missing = Math.max(0, Math.min(policy.maximumCarriers, policy.maximumConcurrentReplacementSpawns) - snapshot.healthyCarrierCount - pending)
    const task = room.memory.evacuation!
    const demands = (task.helperDemands || []).filter(demand => Game.creeps[demand.name] === undefined).slice(0, missing)
    while (demands.length < missing) {
        const sequence = task.nextHelper || 0
        task.nextHelper = sequence + 1
        demands.push({ logicalName: `${room.name}_EVACUATION_${task.createdAt}_${sequence}`, name: '' })
    }
    for (const demand of demands) {
        const name = publish(room, 'filler', demand.logicalName, { evacuationRoom: room.name } as FillerData)
        demand.name = name
        const config = room.memory.creepConfig[name]
        if (config) {
            config.bodyProfile = { boostTier: 0, stationary: false, terrain: 'road', carryParts: policy.carrierCarryParts,
                maximumCost: budget, boostFallback: 'unboosted' }
            config.spawnPriority = policy.carrierSpawnPriority
        }
    }
    task.helperDemands = demands
}

export function getRoomEvacuationStatus(from?: string): string {
    const names = from === undefined ? Object.keys(Memory.rooms || {}).filter(name => isRoomEvacuating(name)) : [from]
    const result = names.map(name => {
        const task = Memory.rooms?.[name]?.evacuation
        if (!task) return { room: name, status: 'none', message: '无撤离任务' }
        const room = Game.rooms[name]
        const snapshot = room ? getSnapshot(room) : undefined
        const target = ownedTerminal(task.targetRoom)
        const energyDust = snapshot && target && room?.terminal ? terminalDust(room, target, snapshot) : 0
        const readyToUnclaim = task.status === 'complete' && !task.pending && ownedTerminal(name) !== undefined &&
            target !== undefined && !isRoomEvacuating(target) && snapshot !== undefined && total(snapshot.remaining) - snapshot.passiveSpawnEnergy === energyDust && total(snapshot.manualCargo) === 0
        return { room: name, shard: Game.shard.name, targetRoom: task.targetRoom, status: task.status, message: task.lastMessage,
            remaining: snapshot?.remaining, nonWithdrawable: snapshot?.nonWithdrawable, manualCargo: snapshot?.manualCargo,
            passiveGeneration: { energy: snapshot?.passiveSpawnEnergy || 0 },
            energyDust, sent: task.sent, energySpent: task.energySpent, carriers: task.carriers, pending: task.pending, blocked: task.blocked,
            readyToUnclaim, automaticallyUnclaim: false }
    })
    return JSON.stringify(from === undefined ? result : result[0], null, 2)
}
export function cancelRoomEvacuation(from: string): string {
    const memory = Memory.rooms?.[from]
    if (!memory?.evacuation) return '该房间没有撤离任务'
    delete memory.evacuation
    for (const name in memory.creepConfig) if ((memory.creepConfig[name].data as { evacuationRoom?: string } | undefined)?.evacuationRoom === from)
        delete memory.creepConfig[name]
    memory.creepSpawnQueue = memory.creepSpawnQueue.filter(name => memory.creepConfig[name] !== undefined)
    reset(); snapshots.delete(from)
    return `已取消 ${from} 撤离，恢复正常运营；已经发送的资源不会退回。`
}
