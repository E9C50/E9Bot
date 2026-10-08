import type { addCreepConfig } from './demand'
import type { buildSpawnQueue } from './spawnQueue'
import { populationPolicy } from 'settings/population'
import { remoteDefensePolicy as policy } from 'settings/remoteDefense'
import { developmentRemotePolicy } from 'settings/developmentRemotes'
import { creepWhiteList } from 'settings/settings'
import { isDevelopingRoom } from './development'
import { isRoomEvacuating } from 'room/evacuationState'

export interface RemoteInvaderGuardData {
    remoteInvaderGuard: { homeRoom: string; targetRoom: string; seenAt: number; sourceRoom?: string }
}
export interface RemoteInvaderThreat {
    seenAt: number
    healPower: number
    rangedPower: number
    damageMultiplier: number
    requiredEnergy: number
    availableCapacity?: number
    rescueRoom?: string
    status?: 'waiting-energy' | 'assigned' | 'insufficient-capacity'
}
declare global {
    interface RoomMemory { remoteInvaderThreats?: Record<string, RemoteInvaderThreat> }
}
const roomName = /^[WE]\d+[NS]\d+$/

export function isRemoteInvaderGuardData(data: CreepData): data is RemoteInvaderGuardData {
    const task = (data as Partial<RemoteInvaderGuardData> | undefined)?.remoteInvaderGuard
    return !!task && roomName.test(task.homeRoom) && roomName.test(task.targetRoom) && Number.isFinite(task.seenAt) &&
        (task.sourceRoom === undefined || roomName.test(task.sourceRoom))
}

function homeReady(home: Room): boolean {
    return home.controller?.my === true && home.spawns.length > 0 && !isRoomEvacuating(home) &&
        !Memory.warMode?.[home.name] && !(home.enemies?.length > 0)
}

function remoteRooms(home: Room): Set<string> {
    const result = new Set<string>()
    for (let index = 0; index < populationPolicy.maximumRemoteRooms; index++) {
        const flag = Game.flags[`${home.name}_OUT${index}`]
        if (flag && flag.pos.roomName !== home.name) result.add(flag.pos.roomName)
    }
    const state = home.memory.developmentRemotes
    if (developmentRemotePolicy.enabled && isDevelopingRoom(home) && state?.enabled !== false) {
        for (const name of [...(state?.candidates || []), ...(state?.selectedRooms || []), ...Object.keys(state?.intel || {})])
            if (name !== home.name && roomName.test(name)) result.add(name)
    }
    return result
}

/** Never turn an automatic mining response into an attack on a player or a Keeper room. */
function enemies(room: Room, home: Room): Creep[] | undefined {
    const ownName = home.controller?.owner?.username
    if (room.controller?.owner || room.controller?.reservation &&
        ![ownName, 'Invader'].includes(room.controller.reservation.username)) return undefined
    const hostile = room.enemies || room.find(FIND_HOSTILE_CREEPS)
    if (hostile.some(enemy => enemy.owner?.username !== 'Invader' && !creepWhiteList.includes(enemy.owner?.username))) return undefined
    return hostile.filter((enemy): enemy is Creep => enemy.owner?.username === 'Invader' && 'body' in enemy && enemy.hits > 0)
}

function combatPower(enemy: Creep, type: typeof HEAL | typeof RANGED_ATTACK, power: number, action: string): number {
    const parts = enemy.body.filter(part => part.type === type && part.hits !== 0)
    // Real creeps always expose their body; the count fallback also supports older compact intel fixtures.
    if (parts.length === 0) return enemy.getActiveBodyparts(type) * power
    return parts.reduce((total, part) => {
        const boosts = part.boost ? BOOSTS[type][part.boost] as unknown as Record<string, number> : undefined
        return total + power * (boosts?.[action] || 1)
    }, 0)
}

function threatFor(invaders: readonly Creep[]): RemoteInvaderThreat {
    const healPower = invaders.reduce((sum, enemy) => sum + combatPower(enemy, HEAL, HEAL_POWER, 'heal'), 0)
    const rangedPower = invaders.reduce((sum, enemy) => sum + combatPower(enemy, RANGED_ATTACK, RANGED_ATTACK_POWER, 'rangedAttack'), 0)
    // Every active TOUGH part can become the front absorber as preceding parts are destroyed.
    let damageMultiplier = 1
    for (const enemy of invaders) for (const part of enemy.body) if (part.type === TOUGH && part.hits !== 0 && part.boost) {
        const boosts = BOOSTS[TOUGH][part.boost] as unknown as Record<string, number>
        damageMultiplier = Math.min(damageMultiplier, boosts?.damage || 1)
    }
    const primary = Math.floor(healPower / (RANGED_ATTACK_POWER * damageMultiplier)) + 1
    const heals = Math.max(1, Math.ceil(rangedPower / HEAL_POWER))
    return { seenAt: Game.time, healPower, rangedPower, damageMultiplier,
        requiredEnergy: primary * (BODYPART_COST[RANGED_ATTACK] + BODYPART_COST[MOVE]) +
            heals * (BODYPART_COST[HEAL] + BODYPART_COST[MOVE]) }
}

function guardProfile(home: Room, threat: RemoteInvaderThreat): CreepBodyProfile | undefined {
    const minimumPrimary = Math.floor(threat.healPower / (RANGED_ATTACK_POWER * (threat.damageMultiplier || 1))) + 1
    const minimumHeals = Math.max(1, Math.ceil(threat.rangedPower / HEAL_POWER))
    const capacity = Math.floor(Math.min(home.energyCapacityAvailable, policy.maximumEnergy))
    if (capacity < Math.max(policy.minimumEnergy, threat.requiredEnergy) || minimumPrimary + minimumHeals > MAX_CREEP_SIZE / 2) return undefined
    // Publish immediately but wait for enough spawn energy to beat healing and survive ranged fire.
    const budget = Math.min(capacity, Math.max(policy.minimumEnergy, home.energyAvailable || 0, threat.requiredEnergy))
    const affordableHeals = Math.floor((budget - minimumPrimary * (BODYPART_COST[RANGED_ATTACK] + BODYPART_COST[MOVE])) /
        (BODYPART_COST[HEAL] + BODYPART_COST[MOVE]))
    const heals = Math.max(minimumHeals, Math.min(policy.maximumHealParts, Math.max(1, Math.floor(budget / 1000)),
        affordableHeals, MAX_CREEP_SIZE / 2 - minimumPrimary))
    const primary = Math.min(25 - heals, Math.floor((budget - heals * (BODYPART_COST[HEAL] + BODYPART_COST[MOVE])) /
        (BODYPART_COST[RANGED_ATTACK] + BODYPART_COST[MOVE])))
    return primary >= minimumPrimary ? { boostTier: 0, terrain: 'plain', maximumCost: budget,
        combatPrimaryParts: primary, combatHealParts: heals, combatToughParts: 0 } : undefined
}

function sufficientGuardBody(creep: Creep, threat: RemoteInvaderThreat): boolean {
    const primary = creep.body.filter(part => part.type === RANGED_ATTACK).length
    const heals = creep.body.filter(part => part.type === HEAL).length
    return primary * RANGED_ATTACK_POWER * (threat.damageMultiplier || 1) > threat.healPower &&
        heals >= Math.max(1, Math.ceil(threat.rangedPower / HEAL_POWER))
}

function spawnLogisticsHomes(): Set<string> {
    return new Set(Object.values(Game.creeps).filter(creep => !creep.spawning && creep.memory.role === 'filler' &&
        creep.memory.spawnRoom === creep.room.name && creep.getActiveBodyparts(CARRY) > 0 && creep.getActiveBodyparts(MOVE) > 0 &&
        !creep.memory.boostPlan?.failed && (!creep.memory.boostPlan?.steps.length || creep.memory.boostPlan.completed === true))
        .map(creep => creep.room.name))
}

/** Run every tick, including the four ticks between ordinary population refreshes. */
export function releaseRemoteInvaderDefenseConfigs(publish: typeof addCreepConfig, rebuildQueue: typeof buildSpawnQueue): void {
    const homes = Object.values(Game.rooms).filter(home => home.controller?.my === true)
    const previous = new Map(homes.map(home => [home, Object.entries(home.memory.creepConfig || {}).filter(([, config]) => isRemoteInvaderGuardData(config.data))]))
    const guards: [string, CreepMemory][] = []
    for (const entries of previous.values()) guards.push(...entries)
    const associations = new Map(homes.map(home => [home, remoteRooms(home)]))
    const wanted = new Map(homes.map(home => [home, new Set<string>()]))
    const changed = new Set<Room>(), assigned = new Set<string>()
    let logistics: Set<string> | undefined
    for (const source of homes) {
        const threats = source.memory.remoteInvaderThreats || {}
        for (const name of Object.keys(threats)) {
            const seenAt = typeof threats[name] === 'number' ? threats[name] as unknown as number : threats[name].seenAt
            if (!associations.get(source)!.has(name) || Game.time - seenAt >= policy.intelLifetime) delete threats[name]
        }
        if (policy.enabled && homeReady(source)) for (const targetName of associations.get(source)!) {
            if (assigned.has(targetName)) continue
            const target = Game.rooms[targetName]
            const oldGuard = guards.find(([, config]) => {
                const data = (config.data as RemoteInvaderGuardData).remoteInvaderGuard
                return data.targetRoom === targetName && (data.sourceRoom || data.homeRoom) === source.name
            })
            const stored = threats[targetName]
            const oldSeen = typeof stored === 'number' ? stored as unknown as number : stored?.seenAt ??
                (oldGuard && (oldGuard[1].data as RemoteInvaderGuardData).remoteInvaderGuard.seenAt)
            const invaders = target && enemies(target, source)
            if (target && !invaders?.length) { delete threats[targetName]; continue }
            if (!target && (oldSeen === undefined || Game.time - oldSeen >= policy.intelLifetime)) continue
            const threat = target ? threatFor(invaders!) : typeof stored === 'object' ? stored : {
                seenAt: oldSeen!, healPower: Math.max(0, (oldGuard?.[1].bodyProfile?.combatPrimaryParts || 1) - 1) * RANGED_ATTACK_POWER,
                rangedPower: Math.max(1, oldGuard?.[1].bodyProfile?.combatHealParts || 1) * HEAL_POWER,
                requiredEnergy: 0, damageMultiplier: 1,
            }
            if (!threat.requiredEnergy) threat.requiredEnergy = (Math.floor(threat.healPower / (RANGED_ATTACK_POWER * (threat.damageMultiplier || 1))) + 1) *
                (BODYPART_COST[RANGED_ATTACK] + BODYPART_COST[MOVE]) + Math.max(1, Math.ceil(threat.rangedPower / HEAL_POWER)) *
                (BODYPART_COST[HEAL] + BODYPART_COST[MOVE])
            threats[targetName] = threat
            let home = source, profile = guardProfile(source, threat)
            if (!profile && !logistics) logistics = spawnLogisticsHomes()
            const rescuers = profile ? [] : homes.filter(candidate => candidate !== source && homeReady(candidate) &&
                (logistics!.has(candidate.name) || previous.get(candidate)!.some(([name, config]) => Game.creeps[name] &&
                    (config.data as RemoteInvaderGuardData).remoteInvaderGuard.targetRoom === targetName)))
                .sort((a, b) => Game.map.getRoomLinearDistance(a.name, targetName) - Game.map.getRoomLinearDistance(b.name, targetName) || a.name.localeCompare(b.name))
            if (!profile) for (const candidate of rescuers) {
                const candidateProfile = guardProfile(candidate, threat)
                if (candidateProfile) { home = candidate; profile = candidateProfile; break }
            }
            threat.availableCapacity = Math.max(...[source, ...rescuers].map(candidate => Math.min(candidate.energyCapacityAvailable, policy.maximumEnergy)))
            if (!profile) { threat.status = 'insufficient-capacity'; delete threat.rescueRoom; continue }
            const selectedProfile = profile
            assigned.add(targetName)
            threat.status = threat.requiredEnergy > home.energyAvailable ? 'waiting-energy' : 'assigned'
            if (home !== source) threat.rescueRoom = home.name
            else delete threat.rescueRoom
            const old = previous.get(home)!.find(([, config]) => (config.data as RemoteInvaderGuardData).remoteInvaderGuard.targetRoom === targetName)
            const sameProfile = old && Object.keys(selectedProfile).every(key => old[1].bodyProfile?.[key] === selectedProfile[key])
            const replacingWeakGuard = old && Game.creeps[old[0]] && !sufficientGuardBody(Game.creeps[old[0]], threat)
            let name: string
            const data: RemoteInvaderGuardData = { remoteInvaderGuard: { homeRoom: home.name, targetRoom: targetName,
                seenAt: threat.seenAt, ...(home !== source ? { sourceRoom: source.name } : {}) } }
            if (old && sameProfile && !replacingWeakGuard) {
                name = old[0]
                old[1].data = data
                if (old[1].spawnPriority !== policy.spawnPriority) {
                    old[1].spawnPriority = policy.spawnPriority; changed.add(home)
                }
            } else {
                const baseName = `${home.name}_REMOTE_INVADER_${targetName}`
                const logicalName = replacingWeakGuard ? `${baseName}_RA${Math.floor(threat.healPower /
                    (RANGED_ATTACK_POWER * (threat.damageMultiplier || 1))) + 1}H${Math.max(1, Math.ceil(threat.rangedPower / HEAL_POWER))}` : old?.[1].name || baseName
                name = publish(home, 'rdefender', logicalName, data)
                const config = home.memory.creepConfig[name]
                if (!config) continue
                config.bodyProfile = selectedProfile; config.spawnPriority = policy.spawnPriority
                changed.add(home)
            }
            wanted.get(home)!.add(name)
            const live = Game.creeps[name]
            if (live && isRemoteInvaderGuardData(live.memory.data)) live.memory.data = data
            // A killed guard may leave an empty queue between ordinary demand refreshes.
            if (!Game.creeps[name] && !home.memory.creepSpawnQueue?.includes(name)) changed.add(home)
        }
        if (Object.keys(threats).length > 0) source.memory.remoteInvaderThreats = threats
        else delete source.memory.remoteInvaderThreats
    }
    for (const home of homes) {
        for (const [name] of previous.get(home)!) if (!wanted.get(home)!.has(name)) {
            delete home.memory.creepConfig[name]; changed.add(home)
        }
        if (changed.has(home)) home.memory.creepSpawnQueue = rebuildQueue(home)
    }
}

function returnHome(creep: Creep, home: Room | undefined, homeName: string): void {
    creep.memory.dontPullMe = false
    const spawn = home?.spawns[0]
    if (spawn && creep.pos.isNearTo(spawn)) spawn.recycleCreep(creep)
    else creep.moveTo(spawn || new RoomPosition(25, 25, homeName), { range: 1 })
}

export function prepareRemoteInvaderGuard(creep: Creep, data: RemoteInvaderGuardData): boolean {
    const task = data.remoteInvaderGuard, home = Game.rooms[task.homeRoom]
    const source = Game.rooms[task.sourceRoom || task.homeRoom]
    const config = home?.memory.creepConfig?.[creep.name]
    if (!policy.enabled || !home || !homeReady(home) || !config || !isRemoteInvaderGuardData(config.data) ||
        source?.controller?.my !== true || !remoteRooms(source).has(task.targetRoom)) { returnHome(creep, home, task.homeRoom); return false }
    const target = Game.rooms[task.targetRoom]
    if (target && !enemies(target, home)?.length) { returnHome(creep, home, task.homeRoom); return false }
    if (!creep.goBoost()) return false
    creep.memory.dontPullMe = false
    return true
}

function range(a: RoomPosition, b: RoomPosition): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
}

function retreatStep(creep: Creep, invaders: readonly Creep[]): RoomPosition | undefined {
    const terrain = creep.room.getTerrain()
    let selected: RoomPosition | undefined, best = Math.min(...invaders.map(enemy => range(creep.pos, enemy.pos)))
    for (let x = Math.max(1, creep.pos.x - 1); x <= Math.min(48, creep.pos.x + 1); x++)
        for (let y = Math.max(1, creep.pos.y - 1); y <= Math.min(48, creep.pos.y + 1); y++) {
            if ((terrain.get(x, y) & TERRAIN_MASK_WALL) !== 0 || creep.room.sources.some(source => source.pos.x === x && source.pos.y === y) ||
                creep.room.controller?.pos.x === x && creep.room.controller.pos.y === y ||
                creep.room.mineral?.pos.x === x && creep.room.mineral.pos.y === y) continue
            if (creep.room.lookForAt(LOOK_CREEPS, x, y).some(unit => unit.name !== creep.name) ||
                creep.room.lookForAt(LOOK_STRUCTURES, x, y).some(structure =>
                    (OBSTACLE_OBJECT_TYPES as readonly string[]).includes(structure.structureType) ||
                    structure.structureType === STRUCTURE_RAMPART && !(structure as StructureRampart).my && !(structure as StructureRampart).isPublic)) continue
            const position = new RoomPosition(x, y, creep.room.name)
            const distance = Math.min(...invaders.map(enemy => range(position, enemy.pos)))
            if (distance > best) { selected = position; best = distance }
        }
    return selected
}

/** Single-target ranged fire avoids collateral hits on players, workers and remote structures. */
export function runRemoteInvaderGuard(creep: Creep, data: RemoteInvaderGuardData): boolean {
    const task = data.remoteInvaderGuard, home = Game.rooms[task.homeRoom]
    if (creep.hits < creep.hitsMax && creep.getActiveBodyparts(HEAL) > 0) creep.heal(creep)
    if (creep.hits < creep.hitsMax * policy.retreatHealthRatio) {
        creep.memory.dontPullMe = false
        creep.moveTo(home?.spawns[0] || new RoomPosition(25, 25, task.homeRoom), { range: 1 })
        return true
    }
    if (creep.room.name !== task.targetRoom) {
        creep.moveTo(new RoomPosition(25, 25, task.targetRoom), { range: 20 })
        return true
    }
    const invaders = home && enemies(creep.room, home)
    if (!invaders?.length) { returnHome(creep, home, task.homeRoom); return true }
    // Issue heal before the first ranged volley can disable front offensive parts.
    if (creep.hits === creep.hitsMax && creep.getActiveBodyparts(HEAL) > 0 && invaders.some(enemy =>
        range(creep.pos, enemy.pos) <= 3 && enemy.getActiveBodyparts(RANGED_ATTACK) > 0 ||
        range(creep.pos, enemy.pos) <= 1 && enemy.getActiveBodyparts(ATTACK) > 0)) creep.heal(creep)
    const target = [...invaders].sort((a, b) => b.getActiveBodyparts(HEAL) - a.getActiveBodyparts(HEAL) ||
        range(creep.pos, a.pos) - range(creep.pos, b.pos))[0]
    const distance = range(creep.pos, target.pos)
    if (distance <= 3) creep.rangedAttack(target)
    if (invaders.some(enemy => range(creep.pos, enemy.pos) < 3)) {
        const step = retreatStep(creep, invaders)
        if (step) creep.moveTo(step, { range: 0, maxRooms: 1, reusePath: 0 })
    } else if (distance > 3) creep.moveTo(target, { range: 3, maxRooms: 1 })
    return true
}
