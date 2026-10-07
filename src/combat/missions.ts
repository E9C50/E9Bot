import { addCreepConfig } from 'creep/demand'
import { isRoleSupported } from 'role'
import { combatPower, towerDamage, isCombatHostile } from './intelligence'
import { isCombatStructureObjective } from './targets'
import { executeCombatSquad } from './tactics'
import { runCombatScout, runControllerAttack, runCombatLoot, returnCombatUnit, countCombatLoot } from './support'
import { planCombatForce } from './planning'
import { combatPolicy } from 'settings/combat'
import { creepWhiteList } from 'settings/settings'
import { scheduleObservation } from 'runtime/observerScheduling'
import { isCpuProfilingEnabled, profileCpuTask } from 'runtime/profiling'
import { parkReadyCombatMembers } from './rally'
import { combatSpawnAllowed } from './spawning'
import type { CombatTask, CombatTaskOptions, CombatIntel } from './types'

const ROOM_NAME = /^[WE]\d+[NS]\d+$/
const SPAWN_WAIT_PREFIX = '编队准备：'
const PROTECTION_WAIT_PREFIX = '等待安全模式/无敌效果结束，tick '
function tasks(): Record<string, CombatTask> { return Memory.combatTasks || (Memory.combatTasks = {}) }
function active(task: CombatTask): boolean { return !['returning', 'completed', 'cancelled'].includes(task.phase) }
function quantity(store: StoreDefinition | undefined): number { return store?.getUsedCapacity() || 0 }
function supportNames(task: CombatTask, job: CreepMemory['combatJob']): string[] {
    return task.names.filter(name => Game.creeps[name]?.memory.combatJob === job &&
        Game.creeps[name].memory.combatGeneration === task.generation ||
        Game.rooms[task.homeRoom]?.memory.creepConfig?.[name]?.combatJob === job)
}

export function createCombatTask(homeRoom: string, targetRoom: string, options: CombatTaskOptions = {}): string {
    if (typeof homeRoom !== 'string' || typeof targetRoom !== 'string' || !ROOM_NAME.test(homeRoom) || !ROOM_NAME.test(targetRoom))
        return '使用 combatTask("起点房间", "目标房间", {mode:"attack"或"hold"})，目前仅支持当前 shard'
    const home = Game.rooms[homeRoom]
    if (!home?.controller?.my || !(home.spawns || home.find(FIND_MY_SPAWNS)).length) return '起点须是有 Spawn 的自有房间'
    if (!options || typeof options !== 'object' || Array.isArray(options)) return '任务配置须为对象'
    if (options.mode !== undefined && !['attack', 'hold'].includes(options.mode)) return 'mode 须为 attack 或 hold'
    if (options.formation !== undefined && !['auto', 'solo', 'duo', 'quad'].includes(options.formation)) return 'formation 须为 auto、solo、duo、quad'
    if (options.boostTier !== undefined && !['auto', 0, 1, 2, 3].includes(options.boostTier)) return 'boostTier 须为 auto、0、1、2、3'
    for (const key of ['timeoutTicks', 'holdTicks', 'maxWaves', 'maxEnergy'] as const)
        if (options[key] !== undefined && (!Number.isInteger(options[key]) || options[key]! <= 0)) return `${key} 须为正整数`
    for (const key of ['controllerAttack', 'loot'] as const)
        if (options[key] !== undefined && typeof options[key] !== 'boolean') return `${key} 须为布尔值`
    const mode = options.mode || 'attack', owner = Game.rooms[targetRoom]?.controller?.owner?.username
    if (mode === 'attack' && (Game.rooms[targetRoom]?.controller?.my || owner && creepWhiteList.includes(owner))) return '不能发布针对自己或白名单玩家的进攻任务'
    const id = options.id || `${homeRoom}_${targetRoom}_${mode}`
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return 'id 须为 1..64 位字母、数字、下划线或短横线'
    const all = tasks()
    if (all[id] && (active(all[id]) || all[id].names.some(name => Game.creeps[name]))) return `任务 ${id} 已存在；使用 combatTasks() 查看或 combatTaskCancel(id) 撤收`
    if (Object.values(all).filter(active).length >= combatPolicy.maximumActiveTasks) return '活动战斗任务已达上限'
    const timeout = options.timeoutTicks || (mode === 'attack' ? combatPolicy.defaultTimeoutTicks : undefined)
    all[id] = { id, shard: Game.shard.name, homeRoom, targetRoom, mode, options: { ...options }, phase: 'recon',
        createdAt: Game.time, updatedAt: Game.time, deadline: timeout ? Game.time + timeout : undefined,
        names: [], generation: (all[id]?.generation || 0) + 1, wave: 0, spent: 0 }
    return JSON.stringify({ id, mode, phase: 'recon', targetRoom, message: '先侦察并核算配置，再孵化；不需要旗子' })
}

function withdraw(task: CombatTask): void {
    const room = Game.rooms[task.homeRoom]
    if (!room) return
    for (const [name, config] of Object.entries(room.memory.creepConfig || {}))
        if (config.combatTaskId === task.id) delete room.memory.creepConfig[name]
    room.memory.creepSpawnQueue = (room.memory.creepSpawnQueue || []).filter(name => room.memory.creepConfig?.[name] !== undefined)
}

function finish(task: CombatTask, reason: string, cancelled = false): void {
    task.phase = cancelled ? 'cancelled' : 'returning'
    task.reason = reason; task.endedAt = Game.time; task.updatedAt = Game.time
    withdraw(task)
    console.log(`[combat:${task.id}] ${reason}; returning units`)
}

export function cancelCombatTask(id: string): string {
    const task = tasks()[id]
    if (!task) return '任务不存在'
    finish(task, '用户取消', true)
    return `任务 ${id} 已撤销孵化需求，现有单位携货返程并回收`
}

interface CombatSpawnStatus {
    planned: number
    born: number
    spawning: number
    pending: number
    boosting: number
    boostFailed: number
    ready: number
    energyAvailable: number
    energyCapacity: number
    nextFighter?: { name?: string; energy: number }
    queueHead?: { name: string; role: CreepRoleConstant; taskId?: string }
}

/** Current-generation bodies only; native spawning and boost completion are separate states. */
function spawningStatus(task: CombatTask): CombatSpawnStatus | undefined {
    if (!['spawning', 'combat'].includes(task.phase) || !task.plan?.members.length) return undefined
    const home = Game.rooms[task.homeRoom]
    if (!home) return undefined
    const current = (name: string): Creep | undefined => {
        const creep = Game.creeps[name]
        return creep?.memory.combatTaskId === task.id && creep.memory.combatJob === 'fighter' &&
            creep.memory.combatGeneration === task.generation ? creep : undefined
    }
    const names = task.memberNames?.length ? task.memberNames : task.names.filter(name => current(name) ||
        home.memory.creepConfig?.[name]?.combatTaskId === task.id &&
        home.memory.creepConfig[name].combatJob === 'fighter' && home.memory.creepConfig[name].combatGeneration === task.generation)
    const members = names.map(current).filter((creep): creep is Creep => creep !== undefined)
    const born = members.filter(creep => !creep.spawning)
    const ready = born.filter(creep => !creep.memory.boostPlan?.failed &&
        (creep.memory.boostPlan?.completed === true || creep.memory.boostPlan?.steps.length === 0)).length
    const spawning = members.length - born.length
    const status: CombatSpawnStatus = { planned: task.plan.members.length, born: born.length, spawning,
        pending: Math.max(0, task.plan.members.length - members.length), boosting: born.length - ready,
        boostFailed: born.filter(creep => creep.memory.boostPlan?.failed).length, ready,
        energyAvailable: home.energyAvailable || 0, energyCapacity: home.energyCapacityAvailable || 0 }
    const next = task.plan.members.findIndex((_member, index) => !current(names[index]))
    if (next >= 0) status.nextFighter = { name: names[next], energy: task.plan.members[next].energy }
    const head = (home.memory.creepSpawnQueue || []).find(name => {
        const config = home.memory.creepConfig?.[name]
        return !Game.creeps[name] && config && isRoleSupported(config.role) && combatSpawnAllowed(config)
    })
    if (head) {
        const config = home.memory.creepConfig[head]
        status.queueHead = { name: head, role: config.role, taskId: config.combatTaskId }
    }
    return status
}

function waitingForSpawn(status: CombatSpawnStatus): boolean {
    return status.pending > 0 || status.spawning > 0 || status.boosting > 0
}

function clearSpawnWaitReason(task: CombatTask): void {
    if (task.reason?.startsWith(SPAWN_WAIT_PREFIX)) delete task.reason
}

function spawnWaitReason(status: CombatSpawnStatus): string {
    let reason = `${SPAWN_WAIT_PREFIX}已出生 ${status.born}/${status.planned}，孵化中 ${status.spawning}，待出生 ${status.pending}，待强化 ${status.boosting}`
    if (status.boostFailed > 0) reason += `；强化失败 ${status.boostFailed}，等待撤回/回收`
    if (status.pending > 0) {
        reason += `；出生能量 ${status.energyAvailable}/${status.energyCapacity}`
        if (status.nextFighter) reason += `，下一名需 ${status.nextFighter.energy}`
        if (status.queueHead) reason += `；队首 ${status.queueHead.role}（${status.queueHead.name}）`
        else reason += '；等待孵化队列刷新'
    }
    return reason
}

function updateSpawnWaitReason(task: CombatTask): void {
    const status = spawningStatus(task)
    if (status && waitingForSpawn(status)) task.reason = spawnWaitReason(status)
}

export function listCombatTasks(id?: string): string {
    const all = tasks()
    const visible = (task: CombatTask): { reason?: string; spawnStatus?: CombatSpawnStatus } => {
        const spawnStatus = spawningStatus(task)
        const reason = task.reason?.startsWith(SPAWN_WAIT_PREFIX) ?
            spawnStatus && waitingForSpawn(spawnStatus) ? spawnWaitReason(spawnStatus) : undefined : task.reason
        return { reason, spawnStatus }
    }
    return JSON.stringify(id ? all[id] ? { ...all[id], ...visible(all[id]) } : { error: '任务不存在' } : Object.values(all).map(task => ({
        id: task.id, homeRoom: task.homeRoom, targetRoom: task.targetRoom, mode: task.mode, phase: task.phase,
        ...visible(task), wave: task.wave, spent: task.spent, category: task.category,
        intelAge: task.intel ? Game.time - task.intel.seenAt : undefined,
        formation: task.plan?.formation, boostTier: task.plan?.members[0]?.boostPlan.tier,
        live: task.names.filter(name => Game.creeps[name]).length,
    })), null, 2)
}

export function readCombatIntel(room: Room, homeRoom = room.name): CombatIntel {
    const structures = room.structures || room.find(FIND_STRUCTURES)
    // Temporary invulnerability stops attacks, but never makes a surviving enemy count as cleared.
    const enemies = room.enemies.filter(enemy => isCombatHostile(enemy, room))
    const objectives = structures.filter(structure => isCombatStructureObjective(structure, room))
    const core = structures.find(structure => structure.structureType === STRUCTURE_INVADER_CORE) as StructureInvaderCore | undefined
    const owner = room.controller?.owner?.username || room.controller?.reservation?.username
    const player = owner && !['Invader', 'Source Keeper'].includes(owner)
    let attack = 0, ranged = 0, healing = 0, armedCount = 0
    for (const enemy of enemies) {
        const power = combatPower(enemy)
        attack += power.attack; ranged += power.ranged; healing += power.heal
        if (power.attack + power.ranged + power.dismantle > 0) armedCount++
    }
    let protectedUntil = 0
    for (const target of [...objectives, ...enemies]) for (const effect of target.effects || [])
        if (effect.effect === EFFECT_INVULNERABILITY && effect.ticksRemaining > 0)
            protectedUntil = Math.max(protectedUntil, Game.time + effect.ticksRemaining)
    const towers = structures.filter(structure => structure.structureType === STRUCTURE_TOWER && isCombatHostile(structure, room)) as StructureTower[]
    const loot = countCombatLoot(room, homeRoom)
    const enemyBodies = enemies.map(enemy => {
        const segments: { hits: number; damageRatio: number }[] = []
        for (const part of 'body' in enemy ? enemy.body : []) {
            if (part.hits <= 0) continue
            const ratio = part.type === TOUGH && part.boost ? BOOSTS[TOUGH][part.boost]?.damage || 1 : 1
            const previous = segments[segments.length - 1]
            if (previous?.damageRatio === ratio) previous.hits += part.hits
            else segments.push({ hits: part.hits, damageRatio: ratio })
        }
        return segments
    })
    return { seenAt: Game.time, owner, category: player ? 'player' : core || enemies.some(enemy => enemy.owner.username === 'Invader') ? 'npc' : 'neutral',
        safeModeUntil: Game.time + (room.controller?.safeMode || 0), protectedUntil, hostileCount: enemies.length,
        armedCount, attack, ranged, healing, enemyBodies, towers: towers.map(tower => ({ x: tower.pos.x, y: tower.pos.y,
            power: Math.max(TOWER_POWER_ATTACK, towerDamage(tower, tower.pos)) })), objectives: objectives.length, core: core?.id,
        loot, downgrade: room.controller?.ticksToDowngrade, level: room.controller?.level,
        upgradeBlocked: room.controller?.upgradeBlocked || 0 }
}

function observe(task: CombatTask): boolean {
    for (const structure of Object.values(Game.structures)) {
        if (structure.structureType !== STRUCTURE_OBSERVER || !(structure as StructureObserver).my ||
            Game.map.getRoomLinearDistance(structure.pos.roomName, task.targetRoom) > OBSERVER_RANGE) continue
        const observer = structure as StructureObserver
        if (typeof observer.isActive === 'function' && !observer.isActive()) continue
        const result = scheduleObservation(observer, task.targetRoom, 'combat')
        if (result === OK) { task.observedAt = Game.time; return true }
        if (result === undefined) return true // Another task owns this tick; do not multiply scouts.
    }
    return false
}

function routeLength(task: CombatTask): number | undefined {
    if (task.homeRoom === task.targetRoom) return 0
    const route = Game.map.findRoute(task.homeRoom, task.targetRoom, { routeCallback: roomName => {
        const room = Game.rooms[roomName]
        if (roomName !== task.targetRoom && room?.controller?.owner && !room.controller.my &&
            !creepWhiteList.includes(room.controller.owner.username)) return Infinity
        return 1
    } })
    return typeof route === 'number' ? undefined : route.length
}

function armourCapacity(intel: CombatIntel): number {
    return Math.max(0, ...(intel.enemyBodies || []).map(body => body.reduce((sum, part) =>
        sum + part.hits * (1 / part.damageRatio - 1), 0)))
}

let planTick: number | undefined
export function runCombatTasks(): void {
    const all = tasks()
    for (const task of Object.values(all)) {
        try {
            clearSpawnWaitReason(task)
            if (task.shard !== Game.shard.name || !active(task)) continue
            const home = Game.rooms[task.homeRoom]
            if (!home?.controller?.my) { finish(task, '起点房间已失去'); continue }
            if (task.deadline && Game.time >= task.deadline) { finish(task, '任务超时'); continue }
            if (task.mode === 'attack' && Memory.warMode?.[task.homeRoom]) {
                withdraw(task)
                if (['spawning', 'combat'].includes(task.phase)) task.phase = 'planning'
                task.reason = '起点房间防御优先，暂停远征'; continue
            }
            if (task.mode === 'hold' && task.options.holdTicks && task.holdStartedAt !== undefined && Game.time >= task.holdStartedAt + task.options.holdTicks) {
                finish(task, '驻守时间结束'); continue
            }
            const target = Game.rooms[task.targetRoom]
            const implicitSupport = task.phase === 'controller' && task.options.controllerAttack !== true ||
                task.phase === 'loot' && task.options.loot !== true
            const confirmingClear = task.mode === 'attack' && ['planning', 'spawning', 'combat'].includes(task.phase) &&
                task.clearSince !== undefined && Game.time - task.clearSince >= combatPolicy.completionConfirmTicks
            if (target && (!task.intel || Game.time - task.intel.seenAt >= combatPolicy.intelRefreshTicks ||
                task.phase === 'controller' || implicitSupport || confirmingClear)) {
                task.intel = isCpuProfilingEnabled() ? profileCpuTask('combat:intel', () => readCombatIntel(target, task.homeRoom)) : readCombatIntel(target, task.homeRoom)
                if (task.category === undefined || task.category === 'neutral') task.category = task.intel.category
                task.updatedAt = Game.time
            }
            const observing = observe(task)
            const scoutAlive = supportNames(task, 'scout').some(name => Game.creeps[name])
            if (scoutAlive) { task.scoutSeenAlive = true; task.scoutPending = false }
            else if (task.scoutSeenAlive) { task.scoutSeenAlive = false; task.lastScoutAt = Game.time; task.scoutPending = false }
            const intel = task.intel
            if (!intel || Game.time - intel.seenAt > combatPolicy.intelMaxAge) {
                task.reason = observing ? '等待 Observer 下一 tick 视野' : '等待 scout 实地侦察'
                if (task.phase !== 'recon') { withdraw(task); task.phase = 'recon' }
                continue
            }
            if (task.mode === 'attack' && (target?.controller?.my || intel.owner && creepWhiteList.includes(intel.owner))) {
                finish(task, '目标已属于自己或白名单玩家'); continue
            }
            if (Math.max(intel.safeModeUntil, intel.protectedUntil) > Game.time) {
                task.reason = `${PROTECTION_WAIT_PREFIX}${Math.max(intel.safeModeUntil, intel.protectedUntil)}`
                withdraw(task); continue
            }
            if (task.reason?.startsWith(PROTECTION_WAIT_PREFIX)) delete task.reason
            if (task.phase === 'recon') task.phase = 'planning'
            const clear = intel.armedCount === 0 && intel.hostileCount === 0 && intel.objectives === 0
            // Tasks saved under the previous default may already be in an implicit support stage.
            if (implicitSupport) {
                if (target && clear) { finish(task, '目标已清场'); continue }
                withdraw(task); task.phase = 'planning'
                task.reason = '按清场目标重新检查剩余单位及建筑'
            }
            if (task.mode === 'attack' && clear && ['planning', 'spawning', 'combat'].includes(task.phase)) {
                task.clearSince = task.clearSince === undefined ? Game.time : task.clearSince
                if (target && Game.time - task.clearSince >= combatPolicy.completionConfirmTicks) {
                    withdraw(task)
                    if (task.category === 'player' && task.options.controllerAttack === true && target.controller?.owner) {
                        task.phase = 'controller'; task.controllerBaseline = target.controller.ticksToDowngrade
                    } else if (task.category === 'npc' && task.options.loot === true) task.phase = 'loot'
                    else finish(task, '目标已清场')
                }
                continue
            } else if (!clear) task.clearSince = undefined
            if (task.phase === 'planning') {
                if (planTick === Game.time || task.lastPlanAt !== undefined && Game.time - task.lastPlanAt < combatPolicy.planRetryTicks) continue
                if (Game.cpu && (Game.cpu.bucket < combatPolicy.planning.minimumBucket ||
                    Number.isFinite(Game.cpu.tickLimit) && Game.cpu.tickLimit - Game.cpu.getUsed() < combatPolicy.planning.minimumCpuHeadroom)) {
                    task.reason = 'CPU 预算不足，战斗规划排队等待'; continue
                }
                task.lastPlanAt = Game.time; planTick = Game.time
                if (Memory.warMode?.[task.homeRoom] || (home.storage?.store[RESOURCE_ENERGY] || 0) < combatPolicy.minimumHomeEnergy && home.controller.level >= 4) {
                    task.reason = '起点防御或资源储备优先，暂缓派兵'; continue
                }
                const length = routeLength(task)
                if (length === undefined || length * combatPolicy.travelTicksPerRoom + combatPolicy.minimumTravelLife >= CREEP_LIFE_TIME) {
                    task.reason = '路线不可达或战斗单位剩余寿命不足'; continue
                }
                if (task.wave >= (task.options.maxWaves || combatPolicy.maximumWaves)) { finish(task, '达到派兵批次上限'); continue }
                const plan = isCpuProfilingEnabled() ? profileCpuTask('combat:planning', () => planCombatForce(home, task)) : planCombatForce(home, task)
                if (!plan) { task.reason = '暂无可承伤、有效输出且能完整补药的配置，等待补给/敌情变化'; continue }
                task.plan = plan; task.wave++; task.generation++
                task.plannedThreat = { output: intel.attack + intel.ranged + intel.towers.reduce((sum, tower) => sum + tower.power, 0),
                    healing: intel.healing, towerCount: intel.towers.length, armour: armourCapacity(intel) }
                task.seenFighters = []
                task.memberNames = []
                task.phase = 'spawning'; task.reason = undefined
                console.log(`[combat:${task.id}] wave ${task.wave}: ${plan.formation}, T${plan.members[0].boostPlan.tier}, energy ${plan.energy}`)
            }
            if (task.phase === 'spawning' || task.phase === 'combat') {
                const threat = task.plannedThreat
                if (threat && (intel.towers.length > threat.towerCount ||
                    intel.attack + intel.ranged + intel.towers.reduce((sum, tower) => sum + tower.power, 0) > Math.max(1, threat.output) * combatPolicy.threatUpgradeRatio ||
                    armourCapacity(intel) > Math.max(1, threat.armour || 0) * combatPolicy.threatUpgradeRatio ||
                    intel.healing > Math.max(1, threat.healing) * combatPolicy.threatUpgradeRatio)) {
                    withdraw(task); task.phase = 'planning'; task.reason = '敌情升级，撤回当前编队并重新核算'; continue
                }
                const fighters = supportNames(task, 'fighter').filter(name => Game.creeps[name])
                const previous = task.seenFighters || []
                const lost = previous.some(name => !Game.creeps[name])
                task.seenFighters = Array.from(new Set([...previous, ...fighters]))
                if (fighters.length === task.plan?.members.length && fighters.every(name => !Game.creeps[name].spawning)) task.phase = 'combat'
                if (task.phase === 'combat' && task.mode === 'hold' && fighters.every(name => Game.creeps[name].room.name === task.targetRoom &&
                    (!Game.creeps[name].memory.boostPlan?.steps.length || Game.creeps[name].memory.boostPlan?.completed)))
                    task.holdStartedAt ??= Game.time
                if (lost || task.phase === 'combat' && fighters.length < (task.plan?.members.length || 1)) {
                    withdraw(task); task.phase = 'planning'; task.reason = '编队损失，存活成员撤回；重新核算配置'
                }
                updateSpawnWaitReason(task)
            }
            if (task.phase === 'controller' && target?.controller) {
                const controller = target.controller
                if (!controller.owner || controller.my || creepWhiteList.includes(controller.owner.username)) { finish(task, '控制器归属已改变'); continue }
                // An OK intent alone is insufficient; validate its effect in a later room snapshot.
                if (task.controllerSentAt !== undefined && Game.time > task.controllerSentAt &&
                    (controller.upgradeBlocked > 0 || controller.ticksToDowngrade < (task.controllerBaseline || 0) -
                        (Game.time - task.controllerSentAt) - combatPolicy.controllerConfirmTicks)) {
                    task.controllerConfirmed = true; finish(task, '清场及紫球控制器攻击已确认'); continue
                }
                if (controller.upgradeBlocked > 0) { task.reason = '控制器已被压制，等待解除后再派紫球'; withdraw(task) }
                else task.reason = undefined
                const length = routeLength(task)
                if (length === undefined || length * combatPolicy.travelTicksPerRoom + combatPolicy.minimumTravelLife >= CREEP_CLAIM_LIFE_TIME)
                    finish(task, '清场已完成，紫球路线超过 CLAIM 寿命，无法安全送达')
            }
            if (task.phase === 'loot') {
                if (!clear) {
                    withdraw(task); task.phase = 'planning'; task.reason = '战利品区域再次出现威胁，重新侦察核算'; continue
                }
                task.reason = undefined
                const cargo = task.names.some(name => quantity(Game.creeps[name]?.store) > 0)
                if (task.lootRemaining === undefined || intel.loot < task.lootRemaining) task.lootProgressAt = Game.time
                task.lootRemaining = intel.loot
                if (task.lootProgressAt !== undefined && Game.time - task.lootProgressAt >= combatPolicy.lootMaximumIdleTicks && !cargo) {
                    finish(task, '战利品连续无进展，撤收并保留未搬完状态'); continue
                }
                if (target && intel.loot === 0 && !cargo) {
                    task.lootEmptySince = task.lootEmptySince === undefined ? Game.time : task.lootEmptySince
                    if (Game.time - task.lootEmptySince >= combatPolicy.lootConfirmTicks) finish(task, 'NPC 要塞战利品已搬运完毕')
                } else task.lootEmptySince = undefined
            }
        } catch (error) { console.log(`[combat:${task.id}] ${error instanceof Error ? error.stack || error.message : String(error)}`) }
    }
    const ended = Object.values(all).filter(task => !active(task) && !task.names.some(name => Game.creeps[name]))
        .sort((first, second) => (second.endedAt || 0) - (first.endedAt || 0))
    for (const task of ended.slice(combatPolicy.historyLimit)) delete all[task.id]
}

function publish(task: CombatTask, job: NonNullable<CreepMemory['combatJob']>, role: CreepRoleConstant,
    slot: number, profile: CreepBodyProfile): string {
    const room = Game.rooms[task.homeRoom]
    const name = addCreepConfig(room, role, `combat_${task.id}_${task.generation}_${job}_${slot}`, {}, job === 'fighter')
    const config = room.memory.creepConfig[name]
    if (config) {
        config.combatTaskId = task.id; config.combatJob = job; config.bodyProfile = profile
        config.combatGeneration = task.generation
        config.spawnPriority = combatPolicy.spawnPriority[job]
        if (!task.names.includes(name)) task.names.push(name)
    }
    return name
}

export function releaseCombatCreepConfigs(): void {
    for (const task of Object.values(tasks())) {
        if (!active(task) || task.shard !== Game.shard.name || !Game.rooms[task.homeRoom]?.controller?.my) continue
        if (task.mode === 'attack' && Memory.warMode?.[task.homeRoom]) continue
        const intel = task.intel
        if (Math.max(intel?.safeModeUntil || 0, intel?.protectedUntil || 0) > Game.time) continue
        if (task.phase === 'recon') {
            const existing = supportNames(task, 'scout').some(name => Game.creeps[name])
            const observerPending = task.observedAt !== undefined && Game.time - task.observedAt <= combatPolicy.observerGraceTicks
            if (existing || task.scoutPending || !observerPending && (task.lastScoutAt === undefined || Game.time - task.lastScoutAt >= combatPolicy.scoutRetryTicks)) {
                if (!existing && !task.scoutPending) { task.lastScoutAt = Game.time; task.scoutPending = true }
                publish(task, 'scout', 'scout', 0, { boostTier: 0 })
            }
        } else if (task.phase === 'spawning' || task.phase === 'combat') {
            if (!task.plan) continue
            task.memberNames = task.plan.members.map((member, index) => publish(task, 'fighter', member.role, index, member.profile))
        } else if (task.phase === 'controller' && !task.reason) {
            publish(task, 'controller', 'cAttacker', 0, { boostTier: 0, terrain: 'plain' })
        } else if (task.phase === 'loot' && !task.reason && intel?.loot) {
            const length = routeLength(task) || 1
            const count = Math.max(1, Math.min(combatPolicy.maximumLootCreeps, Math.ceil(intel.loot / 1250),
                Math.ceil(intel.loot / 1250 * length * 2 * combatPolicy.travelTicksPerRoom / CREEP_LIFE_TIME)))
            for (let index = 0; index < count; index++) publish(task, 'loot', 'rFiller', index,
                { boostTier: 0, terrain: 'plain', carryParts: 25 })
        }
    }
}

/** Combat units have one owner: ordinary flag/role execution never issues competing intents. */
export function runCombatUnits(): void {
    const all = tasks(), groups = new Map<string, Creep[]>()
    const prepared = new Set<string>()
    for (const name in Game.creeps) {
        const creep = Game.creeps[name]
        const id = creep.memory.combatTaskId
        if (!id || creep.spawning) continue
        try {
            const task = all[id]
            if (!task || !active(task)) { returnCombatUnit(creep, task?.homeRoom || creep.memory.spawnRoom); continue }
            if (creep.memory.combatGeneration !== task.generation) { returnCombatUnit(creep, task.homeRoom); continue }
            if (Game.rooms[task.homeRoom]?.memory.creepConfig?.[creep.name]?.combatTaskId !== task.id) {
                returnCombatUnit(creep, task.homeRoom); continue
            }
            if (creep.memory.boostPlan?.failed) {
                returnCombatUnit(creep, task.homeRoom)
                if (creep.memory.combatJob === 'fighter' && ['spawning', 'combat'].includes(task.phase)) {
                    withdraw(task); task.phase = 'planning'; task.reason = '强化失败，撤回本批次并重新核算'
                }
                continue
            }
            if (creep.memory.combatJob === 'fighter') {
                const group = groups.get(id) || []; group.push(creep); groups.set(id, group)
                if (creep.goBoost()) prepared.add(creep.name)
                continue
            }
            if (creep.memory.boostPlan?.failed || !creep.goBoost()) continue
            const options = { homeRoom: task.homeRoom, targetRoom: task.targetRoom }
            const current = Game.rooms[task.homeRoom]?.memory.creepConfig?.[creep.name]
            if (current?.combatTaskId !== task.id) {
                returnCombatUnit(creep, task.homeRoom); continue
            }
            if (creep.memory.combatJob === 'scout') {
                if (task.phase === 'recon') runCombatScout(creep, options)
                else returnCombatUnit(creep, task.homeRoom)
            } else if (creep.memory.combatJob === 'controller') {
                if (task.phase === 'controller' && !task.reason) {
                    if (runControllerAttack(creep, options)) {
                        task.controllerSentAt = Game.time; task.controllerBaseline = creep.room.controller?.ticksToDowngrade
                    }
                } else returnCombatUnit(creep, task.homeRoom)
            } else if (creep.memory.combatJob === 'loot') {
                if (task.phase === 'loot' && !task.reason) runCombatLoot(creep, options)
                else returnCombatUnit(creep, task.homeRoom)
            }
        } catch (error) { console.log(`[combat-unit:${creep.name}] ${error instanceof Error ? error.message : String(error)}`) }
    }
    for (const [id, members] of groups) {
        const task = all[id]
        if (members.some(creep => !prepared.has(creep.name))) {
            parkReadyCombatMembers(task, members.filter(creep => prepared.has(creep.name) && creep.room.name === task.homeRoom))
            continue
        }
        if (task.phase === 'spawning' && members.some(creep => creep.fatigue > 0)) {
            parkReadyCombatMembers(task, members.filter(creep => creep.room.name === task.homeRoom))
            continue
        }
        if (task.phase !== 'combat' || members.length !== task.plan?.members.length ||
            members.some(creep => !Game.rooms[task.homeRoom]?.memory.creepConfig?.[creep.name])) {
            const waiting = members.filter(member => task.phase === 'spawning' &&
                Game.rooms[task.homeRoom]?.memory.creepConfig?.[member.name])
            parkReadyCombatMembers(task, waiting)
            for (const member of members) if (!waiting.includes(member)) returnCombatUnit(member, task.homeRoom)
            continue
        }
        const protectedRoom = Math.max(task.intel?.safeModeUntil || 0, task.intel?.protectedUntil || 0) > Game.time
        const execute = () => executeCombatSquad(members, { targetRoom: protectedRoom ? task.homeRoom : task.targetRoom,
            mode: protectedRoom ? 'hold' : task.mode, retreatRoom: task.homeRoom, formation: task.plan!.formation })
        if (isCpuProfilingEnabled()) profileCpuTask('combat:squad:' + task.plan.formation, execute)
        else execute()
    }
    for (const task of Object.values(all)) if (task.phase === 'returning' && !task.names.some(name => Game.creeps[name])) task.phase = 'completed'
}
