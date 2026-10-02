import { previewCreepBody } from 'creep/bodyPlanner'
import { canPrepareBoostGroup } from 'creep/boosting'
import { boostBodyPart } from 'settings/boost'
import { combatPolicy } from 'settings/combat'
import type { CombatTask, CombatForcePlan, CombatMemberPlan, CombatIntel } from './types'

function nativePower(part: BodyPartConstant): number {
    return part === ATTACK ? ATTACK_POWER : part === RANGED_ATTACK ? RANGED_ATTACK_POWER :
        part === HEAL ? HEAL_POWER : part === WORK ? DISMANTLE_POWER : 0
}

function boostMap(member: CombatMemberPlan): Partial<Record<BodyPartConstant, MineralBoostConstant>> {
    const result: Partial<Record<BodyPartConstant, MineralBoostConstant>> = {}
    for (const step of member.boostPlan.steps) result[boostBodyPart[step.type]] = step.resource as MineralBoostConstant
    return result
}

export function plannedPower(member: CombatMemberPlan, part: BodyPartConstant): number {
    const resource = boostMap(member)[part]
    const action = part === ATTACK ? 'attack' : part === RANGED_ATTACK ? 'rangedAttack' : part === HEAL ? 'heal' : 'dismantle'
    const multiplier = resource ? (BOOSTS[part][resource] as Record<string, number>)?.[action] || 1 : 1
    return member.body.filter(value => value === part).length * nativePower(part) * multiplier
}

export function plannedDamage(member: CombatMemberPlan, raw: number): number {
    const original = raw
    const boost = boostMap(member)[TOUGH]
    const ratio = boost ? BOOSTS[TOUGH][boost]?.damage || 1 : 1
    let result = 0
    for (const part of member.body) {
        const multiplier = part === TOUGH ? ratio : 1
        const used = Math.min(raw, 100 / multiplier)
        result += used * multiplier
        raw -= used
        if (raw <= 0) break
    }
    return Math.min(member.body.length * 100, original - Math.round(original - result - raw))
}

function towerAt(power: number, distance: number): number {
    const fraction = Math.max(0, Math.min(TOWER_FALLOFF_RANGE, distance) - TOWER_OPTIMAL_RANGE) /
        (TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE)
    return power * (1 - TOWER_FALLOFF * fraction)
}

function enemyEffectiveDamage(raw: number, body: NonNullable<CombatIntel['enemyBodies']>[number]): number {
    let remaining = raw, damage = 0
    for (const segment of body) {
        const absorbed = Math.min(remaining, segment.hits / segment.damageRatio)
        remaining -= absorbed; damage += absorbed * segment.damageRatio
        if (remaining <= 0) break
    }
    return raw - Math.round(raw - damage - remaining)
}

/** Any first kill must survive all currently observed support healing, after the victim's front TOUGH. */
function canOvercomeHealing(task: CombatTask, raw: number): boolean {
    const intel = task.intel!
    if (intel.hostileCount === 0) return true
    const damage = intel.enemyBodies?.length ? Math.max(...intel.enemyBodies.map(body => enemyEffectiveDamage(raw, body))) : raw
    return damage > intel.healing * combatPolicy.safetyMargin
}

/** Estimate the exposure needed to engage the first tower, rather than summing distant towers at optimum range. */
function exposure(task: CombatTask): number {
    const intel = task.intel!
    let towerBurst = 0
    if (intel.towers.length > 0) {
        towerBurst = Infinity
        const terrain = Game.map.getRoomTerrain(task.targetRoom)
        for (const objective of intel.towers) {
            for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== 3) continue
                const x = objective.x + dx, y = objective.y + dy
                if (x < 1 || x > 48 || y < 1 || y > 48 || (terrain.get(x, y) & TERRAIN_MASK_WALL)) continue
                towerBurst = Math.min(towerBurst, intel.towers.reduce((sum, tower) => sum +
                    towerAt(tower.power, Math.max(Math.abs(tower.x - x), Math.abs(tower.y - y))), 0))
            }
        }
        if (!Number.isFinite(towerBurst)) return Infinity
    }
    // All observed fighters are assumed able to concentrate fire: their positions may change during travel.
    return towerBurst + intel.attack + intel.ranged
}

function candidate(room: Room, roles: CreepRoleConstant[], tier: CreepBoostTier,
    primary: number, heal: number, tough: number, cache: Map<string, CombatMemberPlan>): CombatMemberPlan[] {
    return roles.map(role => {
        const profile: CreepBodyProfile = { boostTier: tier, boostFallback: 'wait', terrain: 'plain',
            combatPrimaryParts: role === 'healer' ? Math.max(heal, primary) : primary,
            combatHealParts: role === 'healer' ? undefined : role === 'integrate' ? heal : 0,
            combatToughParts: tough }
        const key = `${role}:${tier}:${profile.combatPrimaryParts}:${profile.combatHealParts || 0}:${tough}:${roles.length > 1}`
        const cached = cache.get(key)
        if (cached) return cached
        const config: CreepMemory = { name: 'combat-preview', displayName: 'combat-preview', spawnRoom: room.name,
            role, ready: false, working: false, spawnPriority: 14, data: {}, isTeam: roles.length > 1, bodyProfile: profile }
        const plan = previewCreepBody(room, config, tier)
        const member = { role, profile, ...plan, energy: plan.body.reduce((sum, part) => sum + BODYPART_COST[part], 0) }
        cache.set(key, member)
        return member
    })
}

/** Lowest energy feasible formation first; exact tiers never silently degrade after reconnaissance. */
export function planCombatForce(room: Room, task: CombatTask): CombatForcePlan | undefined {
    if (!task.intel || Game.time - task.intel.seenAt > combatPolicy.intelMaxAge) return undefined
    const requested = task.options.formation || 'auto'
    const sizes = requested === 'solo' ? [1] : requested === 'duo' ? [2] : requested === 'quad' ? [4] : [1, 2, 4]
    const requestedTier = task.options.boostTier
    const tiers: CreepBoostTier[] = requestedTier === undefined || requestedTier === 'auto' ? [0, 1, 2, 3] : [requestedTier]
    const raw = exposure(task)
    const pendingPlans = Object.values(Memory.combatTasks || {}).filter(other => other.id !== task.id && other.homeRoom === room.name &&
        ['spawning', 'combat'].includes(other.phase)).reduce<CreepBoostPlan[]>((all, other) => all.concat(
            (other.plan?.members || []).filter((_member, index) => !Game.creeps[other.memberNames?.[index] || '']).map(member => member.boostPlan)), [])
    let best: CombatForcePlan | undefined
    let bestCost = Infinity
    const cache = new Map<string, CombatMemberPlan>()
    const started = Game.cpu?.getUsed()
    let checked = 0
    for (const size of sizes) {
        const roleSets: CreepRoleConstant[][] = [Array<CreepRoleConstant>(size).fill('integrate')]
        if (size === 2 && task.intel.towers.length === 0) {
            roleSets.push(['attacker', 'healer'])
            if (task.intel.hostileCount === 0 && task.intel.objectives > 0 && !task.intel.core) roleSets.push(['dismantler', 'healer'])
        }
        for (const tier of tiers) for (const roles of roleSets) {
            for (const primary of combatPolicy.planning.primaryParts) for (const heal of combatPolicy.planning.healParts) {
                if (started !== undefined && ++checked % combatPolicy.planning.cpuCheckInterval === 0) {
                    const used = Game.cpu.getUsed()
                    if (used - started >= combatPolicy.planning.maximumCpu || Number.isFinite(Game.cpu.tickLimit) &&
                        Game.cpu.tickLimit - used < combatPolicy.planning.remainingCpuReserve) return best
                }
                const tough = tier === 0 ? 0 : raw > TOWER_POWER_ATTACK ? combatPolicy.planning.heavyToughParts : combatPolicy.planning.lightToughParts
                const members = candidate(room, roles, tier, primary, heal, tough, cache)
                if (members.some(member => member.body.length === 0 || member.energy > room.energyCapacityAvailable)) continue
                const healing = members.reduce((sum, member) => sum + plannedPower(member, HEAL), 0)
                const damage = members.reduce((sum, member) => sum + plannedPower(member, RANGED_ATTACK) +
                    plannedPower(member, ATTACK), 0)
                const breach = members.reduce((sum, member) => sum + plannedPower(member, WORK), 0)
                const incoming = Math.max(...members.map(member => plannedDamage(member, raw)))
                const hits = Math.min(...members.map(member => member.body.length * 100))
                if (incoming * combatPolicy.safetyMargin > healing || incoming * combatPolicy.safetyMargin >= hits ||
                    !canOvercomeHealing(task, damage) ||
                    (damage + breach <= 0)) continue
                const energy = members.reduce((sum, member) => sum + member.energy, 0)
                // Lab fuel and a configurable mineral shadow cost prevent weak targets consuming T3 merely to save MOVE energy.
                const boostParts = members.reduce((sum, member) => sum + member.boostPlan.steps.reduce((total, step) => total + step.parts, 0), 0)
                const resourceCost = energy + boostParts * (LAB_BOOST_ENERGY + LAB_BOOST_MINERAL * combatPolicy.planning.boostMineralEnergyWeight)
                if (task.spent + energy > (task.options.maxEnergy || combatPolicy.maximumTaskEnergy) || resourceCost >= bestCost) continue
                const plans = members.map(member => member.boostPlan)
                if (!canPrepareBoostGroup(room, plans.every(plan => plan.steps.length === 0) ? plans : [...pendingPlans, ...plans])) continue
                best = { formation: size === 1 ? 'solo' : size === 2 ? 'duo' : 'quad', members, energy,
                    incoming, healing, damage: damage + breach, plannedAt: Game.time, estimatedResourceCost: resourceCost }
                bestCost = resourceCost
            }
        }
    }
    return best
}
