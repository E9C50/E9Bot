import { bodyPolicy } from 'settings/bodyPolicy'
import { boostBodyPart, boostConfig, boostTypeEnum } from 'settings/boost'
import { canPrepareBoosts } from 'creep/boosting'

export interface BodyPlan {
    body: BodyPartConstant[]
    boostPlan: CreepBoostPlan
}

type Counts = Partial<Record<BodyPartConstant, number>>
const NATIVE_MOVE_FATIGUE_RECOVERY = 2

function positiveCount(value: number | undefined, fallback: number): number {
    if (value === undefined || !Number.isFinite(value)) return fallback
    return Math.min(MAX_CREEP_SIZE, Math.max(1, Math.floor(value)))
}

function getProfile(room: Room, config: CreepMemory): CreepBodyProfile {
    return { ...bodyPolicy.profiles[config.role], ...room.memory.bodyProfiles?.[config.role], ...config.bodyProfile }
}

function budgetFor(room: Room, profile: CreepBodyProfile, forceSpawn: boolean): number {
    const capacity = Math.max(0, Math.floor(room.energyCapacityAvailable))
    const energy = forceSpawn ? Math.min(capacity, Math.max(0, Math.floor(room.energyAvailable))) : capacity
    const ceiling = Number.isFinite(profile.maximumCost) ? Math.max(0, Math.floor(profile.maximumCost!)) : capacity
    return Math.min(energy, ceiling)
}

function terrainFor(room: Room, config: CreepMemory, profile: CreepBodyProfile): CreepBodyTerrain {
    if (profile.terrain === 'road' || profile.terrain === 'swamp' || profile.terrain === 'plain') return profile.terrain
    if (bodyPolicy.remoteRoles.includes(config.role)) return 'plain'
    return (room.controller?.level || 0) >= bodyPolicy.matureRoadLevel ? 'road' : 'plain'
}

function effect(type: BoostTypeConstant, tier: CreepBoostTier, action: string): number {
    if (tier === 0) return 1
    const resource = boostConfig[type][tier - 1]
    const boosts = BOOSTS[boostBodyPart[type]][resource as MineralBoostConstant] as { [action: string]: number } | undefined
    return boosts?.[action] || 1
}

function range(first: RoomPosition | undefined, second: RoomPosition | undefined): number {
    if (!first || !second || first.roomName !== second.roomName) return Infinity
    return Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y))
}

function sourceFor(config: CreepMemory): Source | undefined {
    const id = (config.data as Partial<HarvesterData>).sourceId
    if (!id) return undefined
    const object = Game.getObjectById<Source>(id)
    return object && 'energyCapacity' in object ? object : undefined
}

function sourceStation(source: Source | undefined): boolean {
    if (!source) return false
    return (source.room.containers || []).some(container => sharedSeat(source.room, source.pos, 1, container.pos)) ||
        (source.room.links || []).some(link => link.my !== false && sharedSeat(source.room, source.pos, 1, link.pos))
}

/** A station needs one permanent walkable tile within action range of both endpoints. */
function sharedSeat(room: Room, target: RoomPosition, targetRange: number, supply: RoomPosition): boolean {
    if (range(target, supply) > targetRange + 1) return false
    const terrain = room.getTerrain()
    const mineral = room.mineral
    const naturalObstacles = [...(room.sources || []), ...(mineral ? [mineral] : []),
        ...(room.controller ? [room.controller] : [])]
    for (let x = Math.max(1, supply.x - 1); x <= Math.min(48, supply.x + 1); x++) {
        for (let y = Math.max(1, supply.y - 1); y <= Math.min(48, supply.y + 1); y++) {
            if ((x === target.x && y === target.y) || Math.max(Math.abs(target.x - x), Math.abs(target.y - y)) > targetRange ||
                (terrain.get(x, y) & TERRAIN_MASK_WALL) !== 0 ||
                naturalObstacles.some(object => object.pos.x === x && object.pos.y === y)) continue
            const blocked = room.lookForAt(LOOK_STRUCTURES, x, y).some(structure =>
                (OBSTACLE_OBJECT_TYPES as readonly string[]).includes(structure.structureType) ||
                (structure.structureType === STRUCTURE_RAMPART &&
                    !(structure as StructureRampart).my && !(structure as StructureRampart).isPublic))
            if (!blocked) return true
        }
    }
    return false
}

function controllerStation(room: Room, config: CreepMemory): boolean {
    const id = (config.data as Partial<UpgraderData>).sourceId
    const supply = id ? Game.getObjectById<AnyStoreStructure>(id) : undefined
    return supply != undefined && 'store' in supply && room.controller != undefined &&
        sharedSeat(room, room.controller.pos, 3, supply.pos)
}

function sourceIncome(source: Source | undefined): number {
    let income = (source?.energyCapacity || SOURCE_ENERGY_CAPACITY) / ENERGY_REGEN_TIME
    for (const active of source?.effects || []) {
        if (active.effect !== PWR_REGEN_SOURCE || active.ticksRemaining <= 0 || active.level === undefined) continue
        const power = POWER_INFO[PWR_REGEN_SOURCE]
        income += power.effect[active.level - 1] / power.period!
    }
    return income
}

function orderedBody(counts: Counts): BodyPartConstant[] {
    // Front armour absorbs damage first; MOVE and tail HEAL stay behind productive parts.
    const order: BodyPartConstant[] = [TOUGH, WORK, CLAIM, ATTACK, RANGED_ATTACK, CARRY, MOVE, HEAL]
    let body: BodyPartConstant[] = []
    for (const part of order) body = body.concat(Array<BodyPartConstant>(counts[part] || 0).fill(part))
    return body
}

function addMovement(counts: Counts, terrain: CreepBodyTerrain, tier: CreepBoostTier,
    stationary: boolean, emptyCarry: boolean): BodyPartConstant[] {
    let weight = 0
    for (const part in counts) if (part !== MOVE && !(part === CARRY && emptyCarry)) weight += counts[part as BodyPartConstant] || 0
    counts[MOVE] = stationary ? 1 : Math.max(1, Math.ceil(weight * bodyPolicy.terrainFatigue[terrain] /
        (NATIVE_MOVE_FATIGUE_RECOVERY * effect(boostTypeEnum.BoostTypeMove, tier, 'fatigue'))))
    return orderedBody(counts)
}

function bodyCost(body: BodyPartConstant[]): number {
    return body.reduce((total, part) => total + BODYPART_COST[part], 0)
}

function fits(body: BodyPartConstant[], budget: number): boolean {
    return body.length > 0 && body.length <= MAX_CREEP_SIZE && bodyCost(body) <= budget
}

function carryCount(baseCarry: number, tier: CreepBoostTier): number {
    return Math.max(bodyPolicy.economy.minimumCarryParts, Math.ceil(baseCarry /
        effect(boostTypeEnum.BoostTypeCarry, tier, 'capacity')))
}

function minimumWorker(budget: number, terrain: CreepBodyTerrain, tier: CreepBoostTier): BodyPartConstant[] {
    const fullSpeed = addMovement({ [WORK]: 1, [CARRY]: 1 }, terrain, tier, false, false)
    for (let move = fullSpeed.filter(part => part === MOVE).length; move > 0; move--) {
        const candidate = orderedBody({ [WORK]: 1, [CARRY]: 1, [MOVE]: move })
        if (fits(candidate, budget)) return candidate
    }
    return []
}

function mineralTrip(room: Room, config: CreepMemory): number {
    const id = (config.data as Partial<MineralData>).sourceId
    const mineral = id ? Game.getObjectById<Mineral>(id) : undefined
    // RoleBaseMiner carries its own harvest to storage; a nearby container is not a mineral haul fleet.
    const distance = range(mineral?.pos, room.storage?.pos)
    return Number.isFinite(distance) ? Math.max(1, Math.ceil(distance * 2 * bodyPolicy.economy.mineralTravelMargin)) :
        bodyPolicy.economy.mineralFallbackRoundTripTicks
}

function mineralCarryTarget(work: number, harvest: number, trip: number): number {
    return Math.max(1, Math.ceil(work * bodyPolicy.economy.mineralCarryPerWork),
        Math.ceil(work * harvest / EXTRACTOR_COOLDOWN * trip * bodyPolicy.economy.mineralTravelToHarvestRatio / CARRY_CAPACITY))
}

function mineralBody(room: Room, config: CreepMemory, profile: CreepBodyProfile,
    terrain: CreepBodyTerrain, tier: CreepBoostTier, budget: number): BodyPartConstant[] {
    const desiredWork = Math.min(bodyPolicy.economy.maximumMineralWorkParts,
        positiveCount(profile.workParts, bodyPolicy.economy.maximumMineralWorkParts))
    const trip = mineralTrip(room, config), harvest = HARVEST_MINERAL_POWER * effect(boostTypeEnum.BoostTypeHarvest, tier, 'harvest')
    const capacityPerCarry = CARRY_CAPACITY * effect(boostTypeEnum.BoostTypeCarry, tier, 'capacity')
    let selected: BodyPartConstant[] = [], bestOutput = 0
    for (let work = desiredWork; work > 0; work--) {
        const output = work * harvest / EXTRACTOR_COOLDOWN
        const baseCarry = mineralCarryTarget(work, harvest, trip)
        const desiredCarry = Math.min(MAX_CREEP_SIZE, carryCount(positiveCount(profile.carryParts, baseCarry), tier))
        for (let carry = desiredCarry; carry > 0; carry--) {
            const candidate = addMovement({ [WORK]: work, [CARRY]: carry }, terrain, tier, false, false)
            if (!fits(candidate, budget)) continue
            const capacity = carry * capacityPerCarry
            const delivered = output * capacity / (capacity + output * trip)
            if (delivered > bestOutput || delivered === bestOutput && bodyCost(candidate) < bodyCost(selected)) {
                selected = candidate
                bestOutput = delivered
            }
            // With WORK fixed, the largest legal carrying capacity has the best trip amortisation.
            break
        }
    }
    return selected.length > 0 ? selected : minimumWorker(budget, terrain, tier)
}

function workerBody(room: Room, config: CreepMemory, profile: CreepBodyProfile,
    terrain: CreepBodyTerrain, tier: CreepBoostTier, budget: number): BodyPartConstant[] {
    const role = config.role
    const mining = role === 'harvester' || role === 'rHarvester'
    const source = mining ? sourceFor(config) : undefined
    const seated = profile.stationary !== undefined ? profile.stationary :
        mining ? sourceStation(source) : role === 'upgrader' && controllerStation(room, config)
    let maximumWork = bodyPolicy.economy.maximumWorkerWorkParts
    if (mining) {
        maximumWork = Math.ceil(sourceIncome(source) /
            (HARVEST_POWER * effect(boostTypeEnum.BoostTypeHarvest, tier, 'harvest')))
    }
    // RCL8 limits unboosted energy consumption, then applies upgrade compounds to progress.
    if (role === 'upgrader' && room.controller?.level === 8) maximumWork = Math.min(maximumWork, CONTROLLER_MAX_UPGRADE_PER_TICK)
    const desiredWork = Math.min(maximumWork, positiveCount(profile.workParts, maximumWork))
    for (let work = desiredWork; work > 0; work--) {
        let baseCarry = seated ? Math.ceil(work * bodyPolicy.economy.stationaryEnergyTicks / CARRY_CAPACITY) :
            Math.ceil(work * (role === 'upgrader' ? bodyPolicy.economy.mobileUpgraderCarryPerWork : bodyPolicy.economy.mobileCarryPerWork))
        if (mining && seated) baseCarry = Math.max(1, Math.ceil(work * HARVEST_POWER *
            effect(boostTypeEnum.BoostTypeHarvest, tier, 'harvest') * bodyPolicy.economy.sourceCarryBatches / CARRY_CAPACITY))
        const carry = carryCount(positiveCount(profile.carryParts, Math.max(1, baseCarry)), tier)
        if (mining && seated && carry * CARRY_CAPACITY * effect(boostTypeEnum.BoostTypeCarry, tier, 'capacity') <
            work * HARVEST_POWER * effect(boostTypeEnum.BoostTypeHarvest, tier, 'harvest') * bodyPolicy.economy.sourceCarryBatches) continue
        // Source miners travel empty to a confirmed seat. Mineral miners carry loads to storage.
        const candidate = addMovement({ [WORK]: work, [CARRY]: carry }, terrain, tier, false, mining && seated)
        if (fits(candidate, budget)) return candidate
    }
    // At 200 capacity the first worker can walk more slowly until extensions fund full-speed bodies.
    return minimumWorker(budget, terrain, tier)
}

function carryBody(role: CreepRoleConstant, profile: CreepBodyProfile, terrain: CreepBodyTerrain,
    tier: CreepBoostTier, budget: number): BodyPartConstant[] {
    const manager = role === 'manager'
    const desiredCarry = positiveCount(profile.carryParts, manager ? bodyPolicy.economy.managerCarryParts : MAX_CREEP_SIZE)
    for (let baseCarry = desiredCarry; baseCarry > 0; baseCarry--) {
        const candidate = addMovement({ [CARRY]: carryCount(baseCarry, tier) }, terrain, tier, manager || profile.stationary === true, false)
        if (fits(candidate, budget)) return candidate
    }
    return []
}

function claimBody(room: Room, config: CreepMemory, terrain: CreepBodyTerrain,
    tier: CreepBoostTier, budget: number): BodyPartConstant[] {
    let desired = config.role === 'cAttacker' ? bodyPolicy.combat.maximumControllerAttackParts : 1
    if (config.role === 'reserver') {
        const target = Game.rooms[(config.data as ReserverData).targetRoom]
        const reservation = target?.controller?.reservation
        // A visible friendly reservation close to expiry benefits from two CLAIM; unknown rooms use one.
        if (reservation && reservation.username === room.controller?.owner?.username &&
            reservation.ticksToEnd < bodyPolicy.economy.reservationUrgencyTicks) desired = bodyPolicy.economy.maximumReserverClaimParts
    }
    for (let claim = desired; claim > 0; claim--) {
        const candidate = addMovement({ [CLAIM]: claim }, terrain, tier, false, false)
        if (fits(candidate, budget)) return candidate
    }
    return []
}

function combatBody(config: CreepMemory, profile: CreepBodyProfile, terrain: CreepBodyTerrain,
    tier: CreepBoostTier, budget: number): BodyPartConstant[] {
    const role = config.role
    const primary: BodyPartConstant = role === 'healer' ? HEAL : role === 'dismantler' ? WORK :
        role === 'rdefender' || role === 'integrate' ? RANGED_ATTACK : ATTACK
    const exact = profile.combatPrimaryParts !== undefined
    const desired = positiveCount(profile.combatPrimaryParts, bodyPolicy.combat.maximumPrimaryParts)
    for (let count = desired; count > 0; count--) {
        const counts: Counts = { [primary]: count }
        if (role !== 'defender' && role !== 'rdefender') counts[TOUGH] = Math.floor(count * bodyPolicy.combat.toughPerPrimary)
        // Melee duos already have a dedicated healer, and TeamDuo does not self-heal its ATTACK member.
        if (role === 'attacker' && !config.isTeam) counts[HEAL] = Math.floor(count * bodyPolicy.combat.attackerHealPerPrimary)
        if (role === 'integrate') counts[HEAL] = Math.max(1, Math.ceil(count * bodyPolicy.combat.integrateHealPerPrimary))
        if (profile.combatToughParts !== undefined) counts[TOUGH] = Math.max(0, Math.floor(profile.combatToughParts))
        if (profile.combatHealParts !== undefined && primary !== HEAL) counts[HEAL] = Math.max(0, Math.floor(profile.combatHealParts))
        const candidate = addMovement(counts, terrain, tier, false, false)
        if (fits(candidate, budget)) return candidate
        if (exact) return []
    }
    return []
}

function boostTypes(config: CreepMemory): BoostTypeConstant[] {
    const role = config.role
    if (role === 'scout' || role === 'sScout') return []
    const types: BoostTypeConstant[] = [boostTypeEnum.BoostTypeMove]
    if (['filler', 'rFiller', 'sHauler', 'manager', 'processer'].includes(role)) types.push(boostTypeEnum.BoostTypeCarry)
    if (['harvester', 'rHarvester', 'miner'].includes(role)) types.push(boostTypeEnum.BoostTypeHarvest, boostTypeEnum.BoostTypeCarry)
    if (role === 'upgrader') types.push(boostTypeEnum.BoostTypeUpgrade, boostTypeEnum.BoostTypeCarry)
    if (['builder', 'repairer', 'rBuilder', 'sBuilder'].includes(role)) types.push(boostTypeEnum.BoostTypeBuild, boostTypeEnum.BoostTypeCarry)
    if (role === 'dismantler') types.push(boostTypeEnum.BoostTypeDismantle, boostTypeEnum.BoostTypeTough, boostTypeEnum.BoostTypeHeal)
    if (role === 'attacker') types.push(boostTypeEnum.BoostTypeAttack, boostTypeEnum.BoostTypeTough, boostTypeEnum.BoostTypeHeal)
    if (role === 'healer') types.push(boostTypeEnum.BoostTypeHeal, boostTypeEnum.BoostTypeTough)
    if (role === 'defender') types.push(boostTypeEnum.BoostTypeAttack)
    if (role === 'rdefender') types.push(boostTypeEnum.BoostTypeRangedAttack)
    if (role === 'integrate') types.push(boostTypeEnum.BoostTypeRangedAttack, boostTypeEnum.BoostTypeTough, boostTypeEnum.BoostTypeHeal)
    return types
}

function usefulMoveBoost(room: Room, config: CreepMemory, profile: CreepBodyProfile, body: BodyPartConstant[]): boolean {
    if (config.role === 'manager' || profile.stationary === true &&
        ['filler', 'rFiller', 'sHauler', 'processer'].includes(config.role)) return false
    const source = ['harvester', 'rHarvester'].includes(config.role) ? sourceFor(config) : undefined
    const emptyCarry = ['harvester', 'rHarvester'].includes(config.role) && (profile.stationary ?? sourceStation(source))
    const weight = body.filter(part => part !== MOVE && !(part === CARRY && emptyCarry)).length
    const nativeMove = Math.max(1, Math.ceil(weight * bodyPolicy.terrainFatigue[terrainFor(room, config, profile)] /
        NATIVE_MOVE_FATIGUE_RECOVERY))
    return body.filter(part => part === MOVE).length < nativeMove
}

/** Judge capacity against the selected physical WORK, not a different tier's WORK count. */
function usefulCarryBoost(room: Room, config: CreepMemory, profile: CreepBodyProfile,
    body: BodyPartConstant[], tier: CreepBoostTier): boolean {
    const role = config.role, work = body.filter(part => part === WORK).length
    const carry = body.filter(part => part === CARRY).length
    let baseCarry: number, minimumActionCarry = 1
    if (['filler', 'rFiller', 'sHauler', 'manager', 'processer'].includes(role)) {
        baseCarry = positiveCount(profile.carryParts, role === 'manager' ? bodyPolicy.economy.managerCarryParts : MAX_CREEP_SIZE)
    } else if (role === 'miner') {
        const harvest = HARVEST_MINERAL_POWER * effect(boostTypeEnum.BoostTypeHarvest, tier, 'harvest')
        baseCarry = positiveCount(profile.carryParts, mineralCarryTarget(work, harvest, mineralTrip(room, config)))
        minimumActionCarry = Math.ceil(work * harvest / CARRY_CAPACITY)
    } else {
        const mining = role === 'harvester' || role === 'rHarvester'
        const seated = profile.stationary ?? (mining ? sourceStation(sourceFor(config)) : role === 'upgrader' && controllerStation(room, config))
        const minimumSourceCarry = Math.ceil(work * HARVEST_POWER * effect(boostTypeEnum.BoostTypeHarvest, tier, 'harvest') *
            bodyPolicy.economy.sourceCarryBatches / CARRY_CAPACITY)
        const fallback = mining && seated ? minimumSourceCarry : seated ?
            Math.ceil(work * bodyPolicy.economy.stationaryEnergyTicks / CARRY_CAPACITY) :
            Math.ceil(work * (role === 'upgrader' ? bodyPolicy.economy.mobileUpgraderCarryPerWork : bodyPolicy.economy.mobileCarryPerWork))
        baseCarry = positiveCount(profile.carryParts, Math.max(1, fallback))
        if (mining && seated) minimumActionCarry = minimumSourceCarry
        else if (['builder', 'rBuilder', 'sBuilder'].includes(role)) minimumActionCarry = Math.ceil(work * BUILD_POWER / CARRY_CAPACITY)
    }
    return carry < Math.max(baseCarry, minimumActionCarry)
}

function generate(room: Room, config: CreepMemory, profile: CreepBodyProfile, tier: CreepBoostTier, budget: number): BodyPlan {
    const terrain = terrainFor(room, config, profile), role = config.role
    let body: BodyPartConstant[] = []
    if (role === 'scout' || role === 'sScout') body = budget >= BODYPART_COST[MOVE] ? [MOVE] : []
    else if (role === 'miner') body = mineralBody(room, config, profile, terrain, tier, budget)
    else if (['harvester', 'rHarvester', 'builder', 'upgrader', 'repairer', 'rBuilder', 'sBuilder'].includes(role))
        body = workerBody(room, config, profile, terrain, tier, budget)
    else if (['filler', 'rFiller', 'sHauler', 'manager', 'processer'].includes(role)) body = carryBody(role, profile, terrain, tier, budget)
    else if (['claimer', 'sClaimer', 'reserver', 'cAttacker'].includes(role)) body = claimBody(room, config, terrain, tier, budget)
    else if (['attacker', 'healer', 'dismantler', 'integrate', 'defender', 'rdefender'].includes(role)) body = combatBody(config, profile, terrain, tier, budget)
    const boostPlan: CreepBoostPlan = { tier, steps: [] }
    if (tier > 0 && body.length > 0) {
        for (const type of boostTypes(config)) {
            if (type === boostTypeEnum.BoostTypeMove && !usefulMoveBoost(room, config, profile, body)) continue
            if (type === boostTypeEnum.BoostTypeCarry && !usefulCarryBoost(room, config, profile, body, tier)) continue
            const parts = body.filter(part => part === boostBodyPart[type]).length
            if (parts > 0) boostPlan.steps.push({ type, resource: boostConfig[type][tier - 1], parts })
        }
    }
    return { body, boostPlan }
}

/**
 * WORK preferences bound actual parts; CARRY preferences bound equivalent unboosted 50-unit capacity.
 * Capacity preview has no mineral reservations, current-energy checks or Memory writes.
 */
export function previewCreepBody(room: Room, config: CreepMemory, tier: CreepBoostTier): BodyPlan {
    const profile = getProfile(room, config)
    return generate(room, config, profile, tier, budgetFor(room, profile, false))
}

/** Select a legal body and reserve-free exact boost proposal before the spawn intent. */
export function planCreepBody(room: Room, config: CreepMemory, forceSpawn: boolean = false): BodyPlan {
    const profile = getProfile(room, config), budget = budgetFor(room, profile, forceSpawn)
    const explicit = profile.boostTier !== undefined
    const requested = profile.boostTier === undefined ? (bodyPolicy.automaticBoostRoles.includes(config.role) ? 3 : 0) :
        [0, 1, 2, 3].includes(profile.boostTier) ? profile.boostTier : 0
    const tiers: CreepBoostTier[] = explicit ? [requested as CreepBoostTier] : requested === 0 ? [0] : [3, 2, 1, 0]
    for (const tier of tiers) {
        const candidate = generate(room, config, profile, tier, budget)
        if (tier === 0 || (candidate.body.length > 0 && (candidate.boostPlan.steps.length === 0 ||
            canPrepareBoosts(room, candidate.boostPlan)))) return candidate
    }
    if (profile.boostFallback === 'wait') return { body: [], boostPlan: { tier: requested as CreepBoostTier, steps: [] } }
    return generate(room, config, profile, 0, budget)
}
