import { defaultAutoResource } from 'settings/room'
import { roomPolicy } from 'settings/roomPolicy'
import { roomWorkDue } from 'runtime/roomSchedule'
import { isRoomEvacuating } from './evacuationState'
import { getEvacuationIncomingCapacity, reserveEvacuationIncoming } from './evacuation'

interface SendJobIndex {
    jobs: RoomMemory['terminalSendJob']
    pairs: Map<string, number>
}
let indexTick: number | undefined
let indexShard: string | undefined
let jobIndexes = new Map<Room, SendJobIndex>()
let energyCandidates: Room[] | undefined

function prepareIndexes(): void {
    if (indexTick == Game.time && indexShard == Game.shard?.name) return
    indexTick = Game.time; indexShard = Game.shard?.name
    jobIndexes = new Map(); energyCandidates = undefined
}

/** 仅缓存成员关系，Store 数量始终在使用时读取；下一 tick 丢弃全部对象引用。 */
function getEnergyCandidates(): readonly Room[] {
    prepareIndexes()
    if (energyCandidates !== undefined) return energyCandidates
    energyCandidates = []
    for (const name in Game.rooms) {
        const room = Game.rooms[name]
        if (room.my && !isRoomEvacuating(room) && room.storage !== undefined && room.terminal !== undefined) energyCandidates.push(room)
    }
    return energyCandidates
}

function createSendJobIndex(room: Room): Map<string, number> {
    prepareIndexes()
    const jobs = room.memory.terminalSendJob, existing = jobIndexes.get(room)
    if (existing?.jobs === jobs) return existing.pairs
    const pairs = new Map<string, number>()
    for (const id in jobs) {
        const job = jobs[id], key = `${job.targetRoom}:${job.resourceType}`
        pairs.set(key, (pairs.get(key) || 0) + 1)
    }
    jobIndexes.set(room, { jobs, pairs })
    return pairs
}

function removeIndexedJob(room: Room, job: RoomMemory['terminalSendJob'][string]): void {
    prepareIndexes()
    const index = jobIndexes.get(room)
    if (index === undefined || index.jobs !== room.memory.terminalSendJob) return
    const key = `${job.targetRoom}:${job.resourceType}`, remaining = (index.pairs.get(key) || 0) - 1
    if (remaining <= 0) index.pairs.delete(key)
    else index.pairs.set(key, remaining)
}

function queueTransfer(
    room: Room,
    targetRoom: string,
    resourceType: ResourceConstant,
    amount: number
): boolean {
    if (isRoomEvacuating(room) || isRoomEvacuating(targetRoom)) return false
    const pairs = createSendJobIndex(room), key = `${targetRoom}:${resourceType}`
    if (!room.sendResource(targetRoom, resourceType, amount)) return false
    // sendResource 对既有 pair 是覆盖，对新 pair 是新增；同 tick 的其他房间立即可见。
    if (!pairs.has(key)) pairs.set(key, 1)
    if (roomPolicy.terminal.logTransfers) console.log(`[${room.name}] -> [${targetRoom}] ${resourceType} ${amount}`)
    return true
}

function processSendJobs(room: Room, terminal: StructureTerminal): void {
    const policy = roomPolicy.terminal
    room.memory.terminalAmount = { [RESOURCE_ENERGY]: policy.energyReserve }
    const canSend = terminal.cooldown == 0
    let full: boolean | undefined
    for (const id in room.memory.terminalSendJob) {
        const job = room.memory.terminalSendJob[id]
        // Retain explicit jobs for cancellation/resumption, but reserve and send no cargo to closing rooms.
        if (isRoomEvacuating(job.targetRoom)) continue
        const resourceType = job.resourceType
        room.memory.terminalAmount[resourceType] =
            (room.memory.terminalAmount[resourceType] || 0) + job.amount
        // 冷却中只维护需求量，不做无效的 Store 容量查询与发送准备。
        if (!canSend) continue
        if (
            room.name == Memory.centerStorage &&
            resourceType == RESOURCE_GHODIUM &&
            room.getResource(RESOURCE_GHODIUM, true, true) <=
                policy.centerGhodiumReserve
        )
            continue

        let amount = job.amount
        if (full === undefined) full = terminal.store.getFreeCapacity() == 0
        if (
            full &&
            terminal.store[resourceType] > 0
        )
            amount = terminal.store[resourceType]
        amount = Math.min(amount, policy.maximumSendAmount)
        const target = Game.rooms[job.targetRoom]
        const reservableTarget = target?.controller?.my && target.terminal?.my !== false && target.terminal !== undefined ? target : undefined
        if (reservableTarget) amount = Math.min(amount, getEvacuationIncomingCapacity(reservableTarget))
        if (amount <= 0) continue
        if (
            terminal.store[resourceType] >= amount &&
            terminal.send(resourceType, amount, job.targetRoom) == OK
        ) {
            if (reservableTarget) reserveEvacuationIncoming(reservableTarget, amount)
            job.amount -= amount
            if (job.amount <= 0) { delete room.memory.terminalSendJob[id]; removeIndexedJob(room, job) }
            break
        }
    }
}

function balanceEnergy(room: Room): void {
    const policy = roomPolicy.terminal
    if (
        room.storage == undefined ||
        room.storage.store[RESOURCE_ENERGY] <= policy.energyExportThreshold
    )
        return
    let target: Room | undefined
    let lowestEnergy = Infinity
    for (const candidate of getEnergyCandidates()) {
        const energy = candidate.storage!.store[RESOURCE_ENERGY]
        if (energy < policy.energyImportThreshold && energy < lowestEnergy) {
            target = candidate
            lowestEnergy = energy
        }
    }
    if (target != undefined)
        queueTransfer(
            room,
            target.name,
            RESOURCE_ENERGY,
            policy.energyTransferAmount
        )
}

function balanceCenterResources(room: Room, center: Room): void {
    const policy = roomPolicy.terminal
    // Memory jobs change when queued below; update both local indexes with those writes.
    const outgoing = createSendJobIndex(room)
    const incoming = createSendJobIndex(center)
    const storage = room.storage?.store, terminal = room.terminal?.store
    const centerStorage = center.storage?.store, centerTerminal = center.terminal?.store
    const roomAmount = (resource: ResourceConstant): number => (storage?.[resource] || 0) + (terminal?.[resource] || 0)
    const centerAmount = (resource: ResourceConstant): number => (centerStorage?.[resource] || 0) + (centerTerminal?.[resource] || 0)
    const mineral = room.mineral
    if (mineral != undefined) {
        const amount = roomAmount(mineral.mineralType)
        if (
            amount > policy.mineralReserve &&
            !outgoing.has(`${center.name}:${mineral.mineralType}`)
        ) {
            queueTransfer(
                room,
                center.name,
                mineral.mineralType,
                amount - policy.mineralReserve
            )
        }
    }

    for (const resource in defaultAutoResource) {
        const resourceType = resource as ResourceConstant
        const targetAmount = defaultAutoResource[resource]
        const currentAmount = roomAmount(resourceType)
        if (currentAmount < targetAmount * policy.refillRatio) {
            const neededAmount = targetAmount - currentAmount
            if (
                centerAmount(resourceType) >
                    neededAmount + targetAmount &&
                !incoming.has(`${room.name}:${resourceType}`)
            ) {
                queueTransfer(center, room.name, resourceType, neededAmount)
            }
        }
        if (
            currentAmount > targetAmount * policy.surplusRatio &&
            !outgoing.has(`${center.name}:${resourceType}`)
        ) {
            queueTransfer(
                room,
                center.name,
                resourceType,
                currentAmount - targetAmount
            )
        }
    }
}

function distributionDue(roomName: string): boolean {
    const policy = roomPolicy.terminal
    return roomWorkDue(roomName, policy.distributionInterval, policy.staggerDistribution === true)
}

/** 终端发货、跨房间能量平衡、中央仓库资源平衡各自独立。 */
export function processTerminalResource(room: Room): void {
    const terminal = room.terminal
    if (terminal == undefined || isRoomEvacuating(room)) return
    processSendJobs(room, terminal)
    balanceEnergy(room)

    const policy = roomPolicy.terminal
    if (
        room.level < policy.distributionMinimumLevel ||
        !distributionDue(room.name) ||
        room.name == Memory.centerStorage
    )
        return
    const center = Game.rooms[Memory.centerStorage]
    // 中央仓库尚未配置/不可见时不阻断其他房间任务。
    if (center == undefined || center.terminal == undefined || isRoomEvacuating(center)) return
    balanceCenterResources(room, center)
}
