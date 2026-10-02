import { interShardPolicy } from 'settings/interShard'
import { scheduleObservation } from 'runtime/observerScheduling'
import { getLocalShardState, markShardStateDirty, readRemoteShardState } from './transport'
import { isRecord, PortalHop } from './types'
import { LocalPortalRecord, PortalDiscoveryMemory, PortalIntelSnapshot, PortalIntelStatus, PortalRecord } from './portalTypes'

const ROOM_NAME = /^([WE])(\d+)([NS])(\d+)$/
let lastRunTick: number | undefined
let lastRunShard: string | undefined
let revision = 0
let knownCache: { key: string; portals: PortalRecord[] } | undefined
let currentStatus: PortalIntelStatus | undefined
const candidateCache = new Map<string, string[]>()
const visibleLastTick = new Map<string, number>()
const statusCache = new Map<string, { normal: boolean; untilTick: number; deadline?: number }>()
let statusTick: number | undefined
let statusShard: string | undefined
let observerIds: string[] = []
let observerIndexTick: number | undefined
let observerIndexShard: string | undefined
let lastMaintenanceTick: number | undefined

function policy() { return interShardPolicy.portalDiscovery }
function portalKey(hop: PortalHop): string { return `${hop.roomName}:${hop.x}:${hop.y}` }

function roomCoordinates(name: string): [number, number] | undefined {
    const match = ROOM_NAME.exec(name)
    if (match === null) return undefined
    const x = Number(match[2]), y = Number(match[4])
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return undefined
    return [match[1] === 'W' ? -x - 1 : x, match[3] === 'N' ? -y - 1 : y]
}

function roomName(x: number, y: number): string {
    return `${x < 0 ? 'W' + (-x - 1) : 'E' + x}${y < 0 ? 'N' + (-y - 1) : 'S' + y}`
}

function normalRoom(name: string): boolean {
    if (statusShard !== Game.shard.name || (statusTick !== undefined && Game.time < statusTick)) {
        statusCache.clear(); statusTick = Game.time; statusShard = Game.shard.name
    }
    statusTick = Game.time
    const now = Date.now()
    const cached = statusCache.get(name)
    if (cached !== undefined && Game.time < cached.untilTick && (cached.deadline === undefined || now < cached.deadline)) return cached.normal
    if (roomCoordinates(name) === undefined) return false
    let normal = false
    let deadline: number | undefined
    try {
        const status = Game.map.getRoomStatus(name)
        normal = status?.status === 'normal'
        if (typeof status?.timestamp === 'number' && Number.isFinite(status.timestamp) && status.timestamp > now) deadline = status.timestamp
    } catch { /* An unavailable status is retried on the next tick, never held for a normal-room TTL. */ }
    const configured = policy().roomStatusCacheTicks
    const interval = normal && Number.isSafeInteger(configured) && configured > 0 ? configured : 1
    statusCache.delete(name)
    if (statusCache.size >= policy().maximumScanRooms) statusCache.delete(statusCache.keys().next().value!)
    statusCache.set(name, { normal, untilTick: Game.time + interval, ...(deadline === undefined ? {} : { deadline }) })
    return normal
}

function validPortal(value: unknown, shard: string, now: number): value is PortalRecord {
    if (!isRecord(value) || typeof value.id !== 'string' || !value.id || value.shard !== shard ||
        typeof value.roomName !== 'string' || roomCoordinates(value.roomName) === undefined ||
        typeof value.destinationShard !== 'string' || !value.destinationShard || value.destinationShard === shard ||
        typeof value.destinationRoom !== 'string' || roomCoordinates(value.destinationRoom) === undefined ||
        !Number.isInteger(value.x) || !Number.isInteger(value.y) || (value.x as number) < 0 || (value.x as number) > 49 ||
        (value.y as number) < 0 || (value.y as number) > 49 || typeof value.observedAt !== 'number' ||
        !Number.isFinite(value.observedAt) || value.observedAt > now || now - value.observedAt > policy().intelMaxAge) return false
    return value.expiresAt === undefined || (typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) && value.expiresAt > now)
}

function snapshot(value: unknown, shard: string, now: number): PortalIntelSnapshot | undefined {
    if (!isRecord(value) || value.shard !== shard || !Number.isFinite(value.updatedAt) ||
        (value.updatedAt as number) > now || now - (value.updatedAt as number) > policy().intelMaxAge ||
        !Array.isArray(value.portals) || value.portals.length > policy().maximumPortals) return undefined
    return { shard, updatedAt: value.updatedAt as number, portals: value.portals.filter(portal => validPortal(portal, shard, now)) }
}

function state(): PortalDiscoveryMemory {
    const existing = Memory.shardPortalIntel
    if (existing?.version === 1 && existing.shard === Game.shard.name && isRecord(existing.portals) &&
        isRecord(existing.scannedRooms) && Number.isInteger(existing.observerCursor)) return existing
    const next: PortalDiscoveryMemory = { version: 1, shard: Game.shard.name, portals: {}, scannedRooms: {}, observerCursor: 0 }
    const saved = snapshot(getLocalShardState().portalIntel, Game.shard.name, Date.now())
    for (const portal of saved?.portals || []) next.portals[portalKey(portal)] = { ...portal }
    Memory.shardPortalIntel = next
    revision++
    return next
}

function localUsable(portal: LocalPortalRecord, now: number): boolean {
    return validPortal(portal, Game.shard.name, now) &&
        (portal.expiresAtTick === undefined || (Number.isInteger(portal.expiresAtTick) && portal.expiresAtTick - Game.time >= policy().minimumDecayTicks)) && normalRoom(portal.roomName)
}

function publicRecord(portal: PortalRecord): PortalRecord {
    return { id: portal.id, shard: portal.shard, roomName: portal.roomName, x: portal.x, y: portal.y,
        destinationShard: portal.destinationShard, destinationRoom: portal.destinationRoom,
        observedAt: portal.observedAt, ...(portal.expiresAt === undefined ? {} : { expiresAt: portal.expiresAt }) }
}

function publish(memory: PortalDiscoveryMemory, now: number): void {
    const portals = Object.values(memory.portals).filter(portal => localUsable(portal, now) && portal.expiresAtTick === undefined).map(publicRecord)
    getLocalShardState().portalIntel = { shard: Game.shard.name, updatedAt: now, portals } as PortalIntelSnapshot
    markShardStateDirty()
    memory.lastPublishTick = Game.time
}

function crossroad(name: string): boolean {
    const match = ROOM_NAME.exec(name)
    return match !== null && Number(match[2]) % 10 === 0 && Number(match[4]) % 10 === 0
}

function discoveryRooms(observer: StructureObserver): string[] {
    const radius = Math.min(OBSERVER_RANGE, Math.max(0, Math.floor(policy().observerRange)))
    const includeCenters = policy().includeSectorCenters === true
    const key = `${observer.pos.roomName}:${radius}:${includeCenters}`
    const cached = candidateCache.get(key)
    if (cached !== undefined) return cached
    const origin = roomCoordinates(observer.pos.roomName)
    const candidates: string[] = []
    if (origin !== undefined) {
        for (let x = origin[0] - radius; x <= origin[0] + radius; x++) {
            const horizontal = (x < 0 ? -x - 1 : x) % 10
            if (horizontal !== 0 && !(includeCenters && horizontal === 5)) continue
            for (let y = origin[1] - radius; y <= origin[1] + radius; y++) {
                const vertical = (y < 0 ? -y - 1 : y) % 10
                if (horizontal === vertical) candidates.push(roomName(x, y))
            }
        }
    }
    if (candidateCache.size >= policy().maximumScanRooms) candidateCache.delete(candidateCache.keys().next().value!)
    candidateCache.set(key, candidates)
    return candidates
}

function observers(): StructureObserver[] {
    const configured = policy().observerRefreshInterval
    const interval = Number.isSafeInteger(configured) && configured > 0 ? configured : 25
    if (observerIndexShard !== Game.shard.name || observerIndexTick === undefined || Game.time < observerIndexTick || Game.time - observerIndexTick >= interval) {
        observerIds = []
        for (const id in Game.structures) {
            const structure = Game.structures[id]
            if (structure.structureType === STRUCTURE_OBSERVER) observerIds.push(id)
        }
        observerIndexShard = Game.shard.name; observerIndexTick = Game.time
    }
    const result: StructureObserver[] = []
    for (const id of observerIds) {
        const structure = Game.structures[id]
        if (structure?.structureType !== STRUCTURE_OBSERVER) continue
        const observer = structure as StructureObserver
        if (observer.my && observer.isActive()) result.push(observer)
    }
    return result
}

function inObserverRange(observer: StructureObserver, name: string): boolean {
    const origin = roomCoordinates(observer.pos.roomName), target = roomCoordinates(name)
    return origin !== undefined && target !== undefined &&
        Math.max(Math.abs(origin[0] - target[0]), Math.abs(origin[1] - target[1])) <= Math.min(OBSERVER_RANGE, policy().observerRange)
}

function trim(memory: PortalDiscoveryMemory): boolean {
    let changed = false
    if (Object.keys(memory.portals).length > policy().maximumPortals) {
        const portals = Object.values(memory.portals)
        portals.sort((first, second) => second.observedAt - first.observedAt)
        for (const portal of portals.slice(policy().maximumPortals)) { delete memory.portals[portalKey(portal)]; changed = true }
    }
    const names = Object.keys(memory.scannedRooms)
    if (names.length > policy().maximumScanRooms) {
        names.sort((first, second) => memory.scannedRooms[second] - memory.scannedRooms[first])
        for (const name of names.slice(policy().maximumScanRooms)) delete memory.scannedRooms[name]
    }
    return changed
}

/** 不借 Observer 虚构视野；本 tick 只扫描真正的 Game.rooms，观察请求下一 tick 才消费。 */
export function runPortalDiscovery(): void {
    if (lastRunTick === Game.time && lastRunShard === Game.shard.name) return
    if (lastRunShard !== Game.shard.name || (lastRunTick !== undefined && Game.time < lastRunTick)) {
        visibleLastTick.clear(); candidateCache.clear(); lastMaintenanceTick = undefined
        if (statusShard !== Game.shard.name || (lastRunTick !== undefined && Game.time < lastRunTick)) {
            statusCache.clear(); statusTick = Game.time; statusShard = Game.shard.name
        }
    }
    lastRunTick = Game.time; lastRunShard = Game.shard.name
    const memory = state(), now = Date.now()
    currentStatus = { observers: 0, portals: 0, lastScanAt: memory.lastScanAt }
    if (!policy().enabled || !interShardPolicy.enabled) { currentStatus.message = 'Portal 自动发现已关闭'; return }
    const available = observers()
    currentStatus.observers = available.length
    let forcePublish = false
    let addedScanRoom = false
    const keysByRoom = new Map<string, string[]>()
    for (const key in memory.portals) {
        const portal = memory.portals[key]
        // Keep rooms with an invalidated old entrance in this tick's scan index:
        // a newly replaced stable portal must not wait behind the empty-room TTL.
        if (isRecord(portal) && typeof portal.roomName === 'string') {
            const keys = keysByRoom.get(portal.roomName) || []
            keys.push(key); keysByRoom.set(portal.roomName, keys)
        }
        if (!localUsable(portal, now)) { delete memory.portals[key]; forcePublish = true; revision++ }
    }
    for (const room of Object.values(Game.rooms)) {
        const previousVisible = visibleLastTick.get(room.name)
        visibleLastTick.set(room.name, Game.time)
        const coordinates = ROOM_NAME.exec(room.name)
        if (coordinates === null) continue
        const discoveryHotspot = crossroad(room.name) || (policy().includeSectorCenters === true && Number(coordinates[2]) % 10 === 5 && Number(coordinates[4]) % 10 === 5)
        const hotspotInterval = policy().emptyHotspotRescanInterval
        const rescanInterval = discoveryHotspot ? (Number.isSafeInteger(hotspotInterval) && hotspotInterval > 0 ? hotspotInterval : 25) : policy().rescanInterval
        if (previousVisible === Game.time - 1 && !keysByRoom.has(room.name) &&
            Game.time - (memory.scannedRooms[room.name] ?? -Infinity) < rescanInterval) continue
        if (!normalRoom(room.name)) continue
        const found = new Set<string>()
        for (const structure of room.find(FIND_STRUCTURES)) {
            if (structure.structureType !== STRUCTURE_PORTAL) continue
            const portal = structure as StructurePortal
            if (!isRecord(portal.destination) || typeof portal.destination.shard !== 'string' || typeof portal.destination.room !== 'string' ||
                (portal.ticksToDecay !== undefined && portal.ticksToDecay < policy().minimumDecayTicks)) continue
            const record: LocalPortalRecord = { id: portal.id, shard: Game.shard.name, roomName: room.name,
                x: portal.pos.x, y: portal.pos.y, destinationShard: portal.destination.shard,
                destinationRoom: portal.destination.room, observedAt: now,
                ...(portal.ticksToDecay === undefined ? {} : { expiresAtTick: Game.time + portal.ticksToDecay }) }
            if (!validPortal(record, Game.shard.name, now)) continue
            const key = portalKey(record), previous = memory.portals[key]
            found.add(key)
            if (previous === undefined || previous.id !== record.id || previous.destinationShard !== record.destinationShard ||
                previous.destinationRoom !== record.destinationRoom || (previous.expiresAtTick === undefined) !== (record.expiresAtTick === undefined)) forcePublish = true
            memory.portals[key] = record
            revision++
        }
        for (const key of keysByRoom.get(room.name) || []) {
            if (!found.has(key)) { delete memory.portals[key]; forcePublish = true; revision++ }
        }
        if (memory.scannedRooms[room.name] === undefined) addedScanRoom = true
        memory.scannedRooms[room.name] = Game.time
        memory.lastScanAt = now
    }
    for (const [name, tick] of visibleLastTick) if (tick < Game.time - 1) visibleLastTick.delete(name)
    while (visibleLastTick.size > policy().maximumScanRooms) visibleLastTick.delete(visibleLastTick.keys().next().value!)
    currentStatus.lastScanAt = memory.lastScanAt
    if (available.length === 0) currentStatus.message = '无可用 Observer，仅收集当前可见 Portal'
    else if (Game.cpu.bucket < policy().minimumBucket) currentStatus.message = 'CPU Bucket 不足，暂缓 Observer 扫描'
    else if (Game.time % Math.max(2, policy().scanInterval) === 0) {
        const requested = new Set<string>()
        let attempts = 0
        for (let offset = 0; offset < available.length && attempts < policy().maximumObserversPerTick; offset++) {
            const observer = available[(memory.observerCursor + offset) % available.length]
            const candidates = new Set(discoveryRooms(observer))
            for (const name of keysByRoom.keys()) candidates.add(name)
            let target: string | undefined
            let targetCrossroad = false
            let targetScanTick = Infinity
            for (const name of candidates) {
                const scanned = memory.scannedRooms[name]
                if (requested.has(name) || Game.rooms[name] !== undefined ||
                    (scanned !== undefined && Game.time - scanned < policy().rescanInterval) ||
                    !inObserverRange(observer, name) || !normalRoom(name)) continue
                const isCrossroad = crossroad(name), scanTick = scanned ?? -Infinity
                if (target === undefined || Number(isCrossroad) > Number(targetCrossroad) ||
                    (isCrossroad === targetCrossroad && (scanTick < targetScanTick || (scanTick === targetScanTick && name.localeCompare(target) < 0)))) {
                    target = name; targetCrossroad = isCrossroad; targetScanTick = scanTick
                }
            }
            if (target === undefined) continue
            attempts++
            const result = scheduleObservation(observer, target, 'portal')
            if (result === OK) {
                requested.add(target)
                if (memory.scannedRooms[target] === undefined) addedScanRoom = true
                memory.scannedRooms[target] = Game.time
            }
            else if (result !== undefined) currentStatus.message = `Observer 无法观测 ${target}: ${result}`
        }
        memory.observerCursor = (memory.observerCursor + 1) % available.length
        if (attempts === 0) currentStatus.message = 'Observer 范围内暂无待扫描的可用房间'
    }
    const configuredMaintenance = policy().maintenanceInterval
    const maintenanceInterval = Number.isSafeInteger(configuredMaintenance) && configuredMaintenance > 0 ? configuredMaintenance : 25
    if (forcePublish || addedScanRoom || lastMaintenanceTick === undefined || Game.time - lastMaintenanceTick >= maintenanceInterval) {
        if (trim(memory)) { forcePublish = true; revision++ }
        lastMaintenanceTick = Game.time
    }
    currentStatus.portals = Object.keys(memory.portals).length
    if (forcePublish || memory.lastPublishTick === undefined || Game.time - memory.lastPublishTick >= policy().publishInterval) publish(memory, now)
}

/** 远端记录只信任声明属于该 peer 的入口；过期和临时 tick 字段不跨 shard 复用。 */
export function getKnownPortals(extraPeers: readonly string[] = []): PortalRecord[] {
    const peers = Array.from(new Set([...interShardPolicy.peers, ...extraPeers])).filter(peer => peer !== Game.shard.name).sort()
    const key = `${Game.shard.name}:${Game.time}:${revision}:${peers.join(',')}`
    if (knownCache?.key === key) return knownCache.portals.map(publicRecord)
    const memory = state(), now = Date.now(), result = new Map<string, PortalRecord>()
    for (const portal of Object.values(memory.portals)) {
        if (localUsable(portal, now)) result.set(`${portal.shard}:${portalKey(portal)}`, publicRecord(portal))
    }
    for (const peer of peers) {
        const remote = snapshot(readRemoteShardState(peer)?.portalIntel, peer, now)
        for (const portal of remote?.portals || []) {
            if ('expiresAtTick' in portal) continue
            const id = `${peer}:${portalKey(portal)}`, previous = result.get(id)
            if (previous === undefined || portal.observedAt > previous.observedAt) result.set(id, publicRecord(portal))
        }
    }
    const portals = Array.from(result.values())
    knownCache = { key: `${Game.shard.name}:${Game.time}:${revision}:${peers.join(',')}`, portals }
    return portals.map(publicRecord)
}

export function getPortalIntelStatus(): PortalIntelStatus {
    if (currentStatus === undefined || lastRunTick !== Game.time || lastRunShard !== Game.shard.name) {
        const memory = state(), available = observers()
        return { observers: available.length, portals: Object.values(memory.portals).filter(portal => localUsable(portal, Date.now())).length,
            lastScanAt: memory.lastScanAt, ...(available.length === 0 ? { message: '无可用 Observer，仅收集当前可见 Portal' } : {}) }
    }
    return { ...currentStatus }
}

export function forgetPortal(hop: PortalHop): void {
    if (hop.shard !== Game.shard.name) return
    const memory = state(), key = portalKey(hop), portal = memory.portals[key]
    if (portal === undefined || portal.destinationShard !== hop.destinationShard ||
        (hop.destinationRoom !== undefined && portal.destinationRoom !== hop.destinationRoom)) return
    delete memory.portals[key]
    revision++
    publish(memory, Date.now())
    if (currentStatus !== undefined) currentStatus.portals = Object.keys(memory.portals).length
}
