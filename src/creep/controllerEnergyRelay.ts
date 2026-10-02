import { isDevelopingRoom } from './development'
import { controllerEnergyBuffer } from './developmentLogistics'
import { developmentPolicy } from 'settings/development'
import { rolePolicy } from 'settings/rolePolicy'
import { interShardPolicy } from 'settings/interShard'
import type { ShardUnitData } from 'shard/missions'

type Buffer = StructureLink | StructureContainer
type CarryIntent = 'withdraw' | 'transfer'
interface Node { creep: Creep; energy: number; free: number; work: number; depth: number; root?: string; parent?: Node; downstreamWork: number; buffer?: Buffer; neighbors: Node[] }
interface Relay { room: Room; nodes: Map<string, Node>; transfers: Map<string, { target: Creep; amount: number }>; withdrawals: Map<string, { target: Buffer; amount: number }>; suppliedRoots: Set<string>; executed: boolean }
let tick: number | undefined, shard: string | undefined
let rooms = new Map<string, Relay>()
let carryIntents = new Map<string, Set<CarryIntent>>()

function sync(): void {
    if (tick === Game.time && shard === Game.shard.name) return
    tick = Game.time; shard = Game.shard.name; rooms = new Map(); carryIntents = new Map()
}

function range(a: { x: number; y: number }, b: { x: number; y: number }): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
}

export function controllerCarryIntentReserved(creep: Creep, kind?: CarryIntent): boolean {
    sync()
    const intents = carryIntents.get(creep.name)
    return kind === undefined ? (intents?.size || 0) > 0 : intents?.has(kind) === true
}

/** Native transfer and withdraw are separate intents; callers may reserve each once. */
export function reserveControllerCarryIntent(creep: Creep, kind: CarryIntent): boolean {
    sync()
    let intents = carryIntents.get(creep.name)
    if (intents?.has(kind)) return false
    if (intents === undefined) { intents = new Set(); carryIntents.set(creep.name, intents) }
    intents.add(kind)
    return true
}

function upgrading(creep: Creep, room: Room): boolean {
    if (creep.my === false || creep.spawning || range(creep.pos, room.controller!.pos) > 3) return false
    const plan = creep.memory.boostPlan
    if (plan !== undefined && plan.tier > 0 && !plan.completed && !plan.failed) return false
    if (creep.memory.role === 'upgrader') return true
    if (creep.memory.role === 'sBuilder') {
        const data = creep.memory.data as Partial<ShardUnitData>
        return data.unitKind === 'builder' && data.done !== true && data.task?.targetShard === Game.shard.name &&
            data.task.targetRoom === room.name && data.phase === 'work' &&
            (room.constructionSites.length === 0 && room.controller!.level < data.task.targetLevel ||
                room.controller!.ticksToDowngrade < interShardPolicy.downgradeWarningTicks)
    }
    if (creep.memory.role === 'rBuilder' && room.constructionSites.length === 0 &&
        room.controller!.level < rolePolicy.remoteBuilder.stopUpgradingAtLevel && (room.portals || []).length === 0) {
        const data = creep.memory.data as RemoteBuilderData
        const target = data.targetFlag ? Game.flags[data.targetFlag] || Game.getObjectById<Source | Structure>(data.targetFlag) : undefined
        return target?.pos.roomName === room.name
    }
    return false
}

/** One native creep index and adjacent-only graph per room/tick. No future incoming energy becomes outgoing credit. */
export function prepareControllerEnergyRelay(room: Room, preferred?: Buffer): Relay | undefined {
    if (!isDevelopingRoom(room)) return undefined
    sync()
    const cached = rooms.get(room.name)
    if (cached?.room === room) return cached
    const buffers: Buffer[] = [], seen = new Set<string>()
    for (const buffer of [preferred || controllerEnergyBuffer(room), ...room.links, ...room.containers]) {
        if (buffer === undefined || seen.has(buffer.id) || range(buffer.pos, room.controller!.pos) > 3 ||
            ('my' in buffer && buffer.my === false) || ('isActive' in buffer && !buffer.isActive())) continue
        seen.add(buffer.id); buffers.push(buffer)
    }
    const nodes = new Map<string, Node>(), tiles = new Map<string, Node>()
    for (const creep of room.find(FIND_MY_CREEPS)) {
        if (!upgrading(creep, room)) continue
        const work = creep.getActiveBodyparts(WORK)
        if (work === 0) continue
        const node: Node = { creep, energy: creep.store[RESOURCE_ENERGY], free: creep.store.getFreeCapacity(RESOURCE_ENERGY),
            work, downstreamWork: work, depth: Infinity, neighbors: [] }
        node.buffer = buffers.find(buffer => range(creep.pos, buffer.pos) <= 1)
        if (node.buffer !== undefined) { node.depth = 0; node.root = creep.name }
        nodes.set(creep.name, node); tiles.set(`${creep.pos.x}/${creep.pos.y}`, node)
    }
    const queue = [...nodes.values()].filter(node => node.depth === 0)
    for (const node of nodes.values()) {
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue
            const next = tiles.get(`${node.creep.pos.x + dx}/${node.creep.pos.y + dy}`)
            if (next !== undefined) node.neighbors.push(next)
        }
    }
    for (let index = 0; index < queue.length; index++) for (const neighbor of queue[index].neighbors) {
        if (neighbor.depth !== Infinity) continue
        neighbor.depth = queue[index].depth + 1; neighbor.root = queue[index].root; neighbor.parent = queue[index]; queue.push(neighbor)
    }
    for (let index = queue.length - 1; index >= 0; index--) if (queue[index].parent !== undefined) queue[index].parent!.downstreamWork += queue[index].downstreamWork
    const relay: Relay = { room, nodes, transfers: new Map(), withdrawals: new Map(), suppliedRoots: new Set(), executed: false }
    for (const node of nodes.values()) if (node.root !== undefined && (node.energy > 0 || (node.buffer?.store[RESOURCE_ENERGY] || 0) > 0)) relay.suppliedRoots.add(node.root)
    const received = new Map<string, number>()
    const receivers = [...nodes.values()].filter(node => node.depth > 0 && node.depth < Infinity && node.free > 0)
        .sort((a, b) => a.energy / a.work - b.energy / b.work || b.depth - a.depth || a.creep.name.localeCompare(b.creep.name))
    for (const node of receivers) {
        // Replenish a bridge's existing outgoing batch as well as its own consumption, but never exceed native initial free.
        const outgoing = relay.transfers.get(node.creep.name)?.amount || 0
        let wanted = Math.min(node.free, Math.max(0, node.downstreamWork * developmentPolicy.controller.relayTargetTicks + outgoing - node.energy))
        const donors = node.neighbors.filter(donor => donor.depth < node.depth)
            .sort((a, b) => b.energy - b.work - (a.energy - a.work) || a.creep.name.localeCompare(b.creep.name))
        for (const donor of donors) {
            if (wanted <= 0) break
            if (relay.transfers.has(donor.creep.name) || controllerCarryIntentReserved(donor.creep, 'transfer')) continue
            const available = donor.energy - donor.work * developmentPolicy.controller.relayReserveTicks
            const amount = Math.min(wanted, available)
            if (amount <= 0) continue
            relay.transfers.set(donor.creep.name, { target: node.creep, amount })
            received.set(node.creep.name, (received.get(node.creep.name) || 0) + amount)
            wanted -= amount
        }
    }
    const bufferWithdrawals = new Map<string, number>()
    for (const node of queue.filter(node => node.depth === 0).sort((a, b) => a.energy / a.work - b.energy / b.work || a.creep.name.localeCompare(b.creep.name))) {
        const buffer = node.buffer!
        const amount = Math.min(Math.max(0, node.free - (received.get(node.creep.name) || 0)),
            Math.max(0, buffer.store[RESOURCE_ENERGY] - (bufferWithdrawals.get(buffer.id) || 0)))
        if (amount <= 0 || controllerCarryIntentReserved(node.creep, 'withdraw')) continue
        relay.withdrawals.set(node.creep.name, { target: buffer, amount })
        bufferWithdrawals.set(buffer.id, (bufferWithdrawals.get(buffer.id) || 0) + amount)
    }
    rooms.set(room.name, relay)
    return relay
}

/** Supply all registered workers once; passive receipt can coexist with a worker's own transfer and WORK action. */
export function controllerEnergyRelayCanSupply(creep: Creep, buffer?: Buffer): boolean {
    const relay = prepareControllerEnergyRelay(creep.room, buffer), node = relay?.nodes.get(creep.name)
    return node?.root !== undefined && relay!.suppliedRoots.has(node.root)
}

export function runControllerEnergyRelay(creep: Creep, buffer?: Buffer): boolean {
    const relay = prepareControllerEnergyRelay(creep.room, buffer)
    if (relay === undefined) return false
    if (!relay.executed) {
        relay.executed = true
        for (const [name, transfer] of relay.transfers) {
            const donor = relay.nodes.get(name)!.creep
            if (reserveControllerCarryIntent(donor, 'transfer')) donor.transfer(transfer.target, RESOURCE_ENERGY, transfer.amount)
        }
        for (const [name, withdrawal] of relay.withdrawals) {
            const receiver = relay.nodes.get(name)!.creep
            if (reserveControllerCarryIntent(receiver, 'withdraw')) receiver.withdraw(withdrawal.target, RESOURCE_ENERGY, withdrawal.amount)
        }
    }
    return controllerEnergyRelayCanSupply(creep, buffer)
}
