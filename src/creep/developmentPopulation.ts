import { addCreepConfig, createCreepName } from './demand'
import { developmentPolicy as policy } from 'settings/development'
import { controllerEnergyBuffer, controllerUpgradeSeatCount } from './developmentLogistics'
import { getDevelopmentSpawnReserve, getSourceMiningWorkTarget } from './developmentEconomy'
import { developmentRemotePolicy } from 'settings/developmentRemotes'
import { harvestWorkParts, energyCarryCapacity } from './bodyEffectiveness'
import { bodyPolicy } from 'settings/bodyPolicy'
import { rolePolicy } from 'settings/rolePolicy'
import { interShardPolicy } from 'settings/interShard'
import type { ShardUnitData } from 'shard/missions'
import { sourceLinkWithCenter, hasSourceLinkTransport } from 'room/sourceLinks'
import { releaseRepairerCreepConfigs } from './repairerPopulation'

function workParts(creep: Creep): number { return creep.getActiveBodyparts(WORK) }
function range(first: RoomPosition, second: RoomPosition): number {
    return Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y))
}

function replacementLead(room: Room, creep: Creep, destination: RoomPosition): number {
    return creep.body.length * CREEP_SPAWN_TIME + range(room.spawns[0].pos, destination) * policy.replacement.travelTicksPerTile +
        (room.spawns[0].spawning?.remainingTime || 0) + policy.replacement.leadMargin
}

function publish(room: Room, role: CreepRoleConstant, name: string, data: CreepData,
    body: NonNullable<CreepMemory['development']>, priority?: number): void {
    const key = addCreepConfig(room, role, name, data)
    const config = room.memory.creepConfig[key]
    if (config == undefined) return
    config.development = body
    if (priority !== undefined) config.spawnPriority = priority
}

function affordableWork(capacity: number, maximum: number, stationary: boolean, mining = false): number {
    for (let work = maximum; work > 0; work--) {
        const carry = mining ? 1 : stationary ? Math.max(1, Math.ceil(work * policy.bodies.stationaryCarryTicks / CARRY_CAPACITY))
            : Math.max(1, work * policy.bodies.workerCarryPerWork)
        const move = Math.max(1, Math.ceil((stationary ? work : work + carry) / 2))
        if (work * BODYPART_COST[WORK] + carry * BODYPART_COST[CARRY] + move * BODYPART_COST[MOVE] <= capacity) return work
    }
    return capacity >= BODYPART_COST[WORK] + BODYPART_COST[CARRY] + BODYPART_COST[MOVE] ? 1 : 0
}

/** A committed boost plan also covers future mining demand while its worker is spawning/preparing. */
function futureMiningWork(creep: Creep): number {
    let work = harvestWorkParts(creep)
    const plan = creep.memory.boostPlan
    if (!plan || plan.completed || plan.failed) return work
    let unboosted = creep.body.filter(part => part.type === WORK && part.hits > 0 && !part.boost).length
    for (const step of plan.steps) {
        const multiplier = typeof BOOSTS === 'undefined' ? 1 :
            (BOOSTS[WORK]?.[step.resource as MineralBoostConstant] as { harvest?: number } | undefined)?.harvest || 1
        const parts = Math.min(unboosted, step.parts)
        if (multiplier > 1) { work += parts * (multiplier - 1); unboosted -= parts }
    }
    return work
}

interface MiningSupply { source: Source; production: number }

/** Only active aid tasks consume the controller budget; completed workers beside it are idle. */
function hasAidUpgradeTask(creep: Creep, room: Room): boolean {
    if (creep.memory.role === 'sBuilder') {
        const data = creep.memory.data as Partial<ShardUnitData>
        return data.unitKind === 'builder' && data.phase === 'work' && data.done !== true &&
            data.task?.targetRoom === room.name && data.task.targetShard === Game.shard.name &&
            (room.controller!.ticksToDowngrade < interShardPolicy.downgradeWarningTicks ||
                room.constructionSites.length === 0 && room.controller!.level < data.task.targetLevel)
    }
    if (creep.memory.role !== 'rBuilder' || room.constructionSites.length > 0 ||
        room.controller!.level >= rolePolicy.remoteBuilder.stopUpgradingAtLevel || (room.portals || []).length > 0) return false
    const data = creep.memory.data as RemoteBuilderData
    const target = data.targetFlag ? Game.flags?.[data.targetFlag] || Game.getObjectById<Source | Structure>(data.targetFlag) : undefined
    return target?.pos.roomName === room.name
}

function sourceHaulingTrip(room: Room, source: Source, buffer: StructureLink | StructureContainer | undefined): number {
    const destination = room.storage?.pos || buffer?.pos || room.spawns[0].pos
    return Math.ceil((Math.max(range(source.pos, room.spawns[0].pos), range(source.pos, destination)) * 2 + 2) * policy.hauling.travelMargin)
}

function storageHaulingTrip(room: Room, buffer: StructureLink | StructureContainer | undefined): number {
    // Carriers supply a controller Container or its workers, never fill a Link.
    const destination = buffer?.structureType === STRUCTURE_CONTAINER ? buffer.pos : room.controller!.pos
    return Math.ceil((range(room.storage!.pos, destination) * 2 + 2) * policy.hauling.travelMargin)
}

function storageDistribution(room: Room, creeps: Creep[], trip: number): number {
    let capacity = 0
    const prefix = `${room.name}_DEVELOP_FILLER_`
    for (const creep of creeps) {
        if (creep.spawning || creep.room.name !== room.name || creep.memory.role !== 'filler') continue
        const data = creep.memory.data as FillerData, name = creep.memory.name
        const dedicated = name?.startsWith(`${prefix}STORAGE_`)
        if (!dedicated && (name?.startsWith(prefix) || data.mineId || creep.memory.developmentHauler?.mineId ||
            data.sourceId !== room.storage!.id)) continue
        capacity += energyCarryCapacity(creep)
    }
    return capacity / trip
}

function servesSource(creep: Creep, source: Source, containers: StructureContainer[]): boolean {
    const data = creep.memory.data as FillerData
    const mineId = data.mineId || creep.memory.developmentHauler?.mineId
    if (mineId) return mineId === source.id
    const prefix = `${creep.room.name}_DEVELOP_FILLER_`
    if (creep.memory.name?.startsWith(prefix) && !creep.memory.name.startsWith(`${prefix}STORAGE_`)) {
        return creep.memory.name.slice(prefix.length, creep.memory.name.lastIndexOf('_')) === source.id
    }
    return data.sourceId === source.id || containers.some(container => container.id === data.sourceId)
}

function sourceStock(room: Room, source: Source): number {
    let stock = 0
    for (const container of room.containers) if (range(source.pos, container.pos) <= 1) stock += container.store[RESOURCE_ENERGY]
    for (const drop of room.droppedResource || []) if (drop.resourceType === RESOURCE_ENERGY &&
        range(source.pos, drop.pos) <= policy.hauling.mineResourceRange) stock += drop.amount
    return stock
}

/** Fund consumers from arrived production and real carrying capacity, never from unspawned fleet templates. */
function localSupply(room: Room, creeps: Creep[], supplies: MiningSupply[], buffer: StructureLink | StructureContainer | undefined): {
    income: number; directIncome: number; backlogWork: number; controllerBacklogWork: number
} {
    const controllerBacklog = Math.max(0, (buffer?.store[RESOURCE_ENERGY] || 0) - policy.upgrading.controllerBufferReserve) /
        policy.upgrading.backlogEnergyPerWork
    let income = 0, directIncome = 0, backlog = controllerBacklog
    const counted = new Set<string>()
    if (buffer) counted.add(buffer.id)
    for (const { source, production } of supplies) {
        const linked = room.links.length > 0 && hasSourceLinkTransport(room, source, buffer)
        const containers = room.containers.filter(container => range(source.pos, container.pos) <= 1)
        const capacity = creeps.filter(creep => !creep.spawning && creep.room.name === room.name && creep.memory.role === 'filler' &&
            servesSource(creep, source, containers))
            .reduce((total, creep) => total + energyCarryCapacity(creep), 0)
        const hauling = capacity / sourceHaulingTrip(room, source, buffer)
        const direct = containers.some(container => container.id === buffer?.id) ||
            buffer?.structureType === STRUCTURE_LINK && linked
        const transport = direct || linked ? Math.max(hauling, production) : hauling
        income += Math.min(production, transport)
        if (direct) directIncome += production
        let stock = 0
        if (hauling > 0) {
            for (const container of containers) if (!counted.has(container.id)) {
                stock += container.store[RESOURCE_ENERGY]; counted.add(container.id)
            }
            for (const drop of room.droppedResource || []) if (drop.resourceType === RESOURCE_ENERGY &&
                range(source.pos, drop.pos) <= policy.hauling.mineResourceRange && !counted.has(drop.id)) {
                stock += drop.amount; counted.add(drop.id)
            }
            backlog += Math.min(stock / policy.upgrading.backlogEnergyPerWork, Math.max(0, hauling - (linked ? 0 : production)))
        }
    }
    return { income, directIncome, backlogWork: Math.min(policy.upgrading.maximumBacklogWorkParts, Math.floor(backlog)),
        controllerBacklogWork: Math.min(policy.upgrading.maximumBacklogWorkParts, Math.floor(controllerBacklog)) }
}

/** Compact affordable mining slots replace old small bodies without removing their live production early. */
function releaseMining(room: Room, creeps: Creep[]): MiningSupply[] {
    const supplies: MiningSupply[] = []
    const affordable = affordableWork(room.energyCapacityAvailable, policy.mining.workPartsPerSource, true, true)
    if (affordable == 0) return supplies
    for (const source of room.sources) {
        const linked = room.links.length > 0 && sourceLinkWithCenter(room, source) !== undefined
        const miners = creeps.filter(creep => creep.memory.role == 'harvester' &&
            (creep.memory.data as HarvesterData).sourceId == source.id && workParts(creep) > 0)
        const productive = linked ? miners.filter(creep => creep.getActiveBodyparts(CARRY) > 0) : miners
        // A larger replacement improves an operating mine; it must not delay restoring
        // an empty Source or commissioning remote income. Dying/travelling miners do not qualify.
        const operatingMine = productive.some(miner => !miner.spawning && miner.room.name === room.name &&
            (miner.ticksToLive ?? 0) > replacementLead(room, miner, source.pos) &&
            !(miner.memory.boostPlan?.steps.length && !miner.memory.boostPlan.completed && !miner.memory.boostPlan.failed) &&
            range(miner.pos, source.pos) <= 1)
        const nearbyWork = productive.filter(creep => !creep.spawning && creep.room.name == room.name &&
            !(creep.memory.boostPlan?.steps.length && !creep.memory.boostPlan.completed && !creep.memory.boostPlan.failed) &&
            range(creep.pos, source.pos) <= 1).reduce((total, creep) => total + harvestWorkParts(creep), 0)
        supplies.push({ source, production: Math.min(source.energyCapacity / ENERGY_REGEN_TIME, nearbyWork * HARVEST_POWER) })
        let remaining = getSourceMiningWorkTarget(source)
        let count = 0
        const maximum = Math.min(policy.mining.maximumCreepsPerSource, Math.max(1, source.pos.getFreeSpace().length))
        const candidates = productive.filter(miner => miner.memory.name && (miner.spawning ||
            (miner.ticksToLive ?? 0) > replacementLead(room, miner, source.pos)))
            .map(miner => ({ miner, work: futureMiningWork(miner) }))
        let nextIndex = 0
        while (remaining > 0 && count < maximum) {
            const work = Math.min(affordable, remaining)
            // A single already sufficient boosted/full miner wins. Otherwise preserve
            // workers that match a full affordable slot or the exact remainder (4+1 at 550).
            const suitable = candidates.filter(candidate => candidate.work >= work)
                .sort((first, second) => Number(second.work >= remaining) - Number(first.work >= remaining) ||
                    first.work - second.work || Number(first.miner.spawning) - Number(second.miner.spawning))
            const incumbent = suitable[0]
            if (incumbent) {
                publish(room, 'harvester', incumbent.miner.memory.name, { sourceId: source.id }, { workParts: work, stationary: true })
                candidates.splice(candidates.indexOf(incumbent), 1)
                remaining -= Math.min(remaining, incumbent.work)
            } else {
                let name: string | undefined
                const limit = miners.length + maximum + policy.replacement.maximumReplacementsPerRoom
                while (nextIndex < limit) {
                    const candidate = `${room.name}_DEVELOP_HARVESTER_${source.id}_${nextIndex++}`
                    if (!Game.creeps[createCreepName('harvester', candidate)]) { name = candidate; break }
                }
                if (!name) break
                publish(room, 'harvester', name, { sourceId: source.id }, { workParts: work, stationary: true },
                    operatingMine ? policy.mining.expansionPriority : undefined)
                remaining -= work
            }
            count++
        }
    }
    return supplies
}

/** 只计已到岗且有运工服务的自动外矿，避免用纸面收入孵化过量升级工。 */
function remoteIncome(room: Room, creeps: Creep[]): number {
    let income = 0
    const sources = new Set<string>()
    for (const creep of creeps) {
        const data = (creep.memory.data as { developmentRemote?: {
            homeRoom: string; targetRoom: string; kind: string; source?: { id: string; x: number; y: number; travelTicks?: number }
        } }).developmentRemote
        if (data?.homeRoom != room.name || data.kind != 'harvester' || !data.source || creep.spawning ||
            creep.room.name != data.targetRoom || Math.max(Math.abs(creep.pos.x - data.source.x), Math.abs(creep.pos.y - data.source.y)) > 1 || sources.has(data.source.id)) continue
        const state = room.memory.developmentRemotes
        const intel = state?.intel?.[data.targetRoom]
        if (!state?.selectedRooms?.includes(data.targetRoom) || intel?.status !== 'safe' || Game.time < intel.seenAt ||
            Game.time - intel.seenAt >= developmentRemotePolicy.intelMaxAge || !intel.sources.some(source => source.id === data.source!.id)) continue
        const haulers = creeps.filter(candidate => !candidate.spawning &&
            (candidate.memory.data as { developmentRemote?: typeof data }).developmentRemote?.kind == 'hauler' &&
            (candidate.memory.data as { developmentRemote?: typeof data }).developmentRemote?.source?.id == data.source!.id)
        const transport = haulers.reduce((total, hauler) => total + energyCarryCapacity(hauler), 0) /
            Math.max(1, data.source.travelTicks || developmentRemotePolicy.travelTicksPerRoom * 2)
        if (transport <= 0) continue
        sources.add(data.source.id)
        const source = Game.getObjectById<Source>(data.source.id)
        if (source) income += Math.min(source.energyCapacity / ENERGY_REGEN_TIME, harvestWorkParts(creep) * HARVEST_POWER, transport)
    }
    return income
}

/** 沿用已建成的 63bot 资源容器与控制器容器，不移动任何建筑。 */
export function releaseDevelopmentBaseConfig(room: Room): void {
    releaseRepairerCreepConfigs(room, true)
    if (room.spawns.length == 0) return
    const creeps = Object.values(Game.creeps).filter(creep => creep.memory.spawnRoom == room.name)
    // Adopt old local consumers into the budget; full-level rooms never enter this publisher.
    for (const creep of creeps) if (creep.room.name === room.name &&
        (creep.memory.role === 'builder' || creep.memory.role === 'upgrader' ||
            creep.memory.role === 'harvester' && room.sources.some(source => source.id === (creep.memory.data as HarvesterData).sourceId)) &&
        creep.memory.development === undefined) {
        creep.memory.development = {}
    }
    const buffer = controllerEnergyBuffer(room)
    const local = localSupply(room, creeps, releaseMining(room, creeps), buffer)
    const remote = remoteIncome(room, creeps)
    const income = local.income + remote
    const stored = room.storage?.store[RESOURCE_ENERGY] || 0
    // RCL6 boosts and RCL7 factories need a mobile native mover independent of the manager's seat.
    const customBoosts = Object.values({ ...bodyPolicy.profiles, ...room.memory.bodyProfiles })
        .some(profile => profile != undefined && (profile.boostTier || 0) > 0)
    if ((customBoosts && room.labs.length > 0 || room.factory != undefined) && (room.storage || room.terminal)) {
        const key = addCreepConfig(room, 'processer', `${room.name}_PROCESSER`, { waiting: 0 })
        if (room.memory.creepConfig[key]) {
            room.memory.creepConfig[key].development = {}
            room.memory.creepConfig[key].bodyProfile = { boostTier: 0 }
        }
    }
    const burst = Math.min(policy.upgrading.maximumBonusWorkParts,
        Math.floor(Math.max(0, stored - policy.upgrading.storageReserve) / policy.upgrading.energyPerBonusWork))
    const imports = Math.max(0, local.income - local.directIncome) + remote
    const distributionTrip = room.storage ? storageHaulingTrip(room, buffer) : 0
    const distribution = room.storage ? storageDistribution(room, creeps, distributionTrip) : Infinity
    const upgradeIncome = local.directIncome + Math.min(imports, distribution)
    const headroom = Math.max(0, distribution - imports)
    const upgradeBurst = Math.min(burst, Math.floor(headroom))
    const importedBacklog = Math.max(0, local.backlogWork - local.controllerBacklogWork)
    const upgradeBacklog = local.controllerBacklogWork + Math.min(importedBacklog, Math.floor(Math.max(0, headroom - upgradeBurst)))
    for (const source of room.sources) {
        const linked = room.links.length > 0 && hasSourceLinkTransport(room, source, buffer)
        const stock = linked ? sourceStock(room, source) : 0
        // Link production reaches its receiver directly. Only stranded native stock needs a salvage trip.
        if (linked && stock <= 0) continue
        const container = room.containers.find(candidate => range(candidate.pos, source.pos) <= 1)
        const sourceId = container?.id || source.id
        const trip = sourceHaulingTrip(room, source, buffer)
        const nearbyWork = creeps.filter(creep => !creep.spawning && creep.memory.role === 'harvester' &&
            (creep.memory.data as HarvesterData).sourceId === source.id && creep.room.name === room.name &&
            range(creep.pos, source.pos) <= 1).reduce((total, creep) => total + harvestWorkParts(creep), 0)
        const startingWork = affordableWork(room.energyCapacityAvailable, policy.mining.workPartsPerSource, true, true)
        const rate = Math.min(source.energyCapacity / ENERGY_REGEN_TIME, Math.max(startingWork, nearbyWork) * HARVEST_POWER)
        const totalCarry = Math.max(policy.bodies.minimumCarryParts, Math.ceil((linked ? stock : trip * rate) / CARRY_CAPACITY))
        const capacityCarry = Math.max(1, Math.min(policy.hauling.maximumCarryPartsPerCreep,
            Math.floor(room.energyCapacityAvailable / (BODYPART_COST[CARRY] + BODYPART_COST[MOVE]))))
        const count = linked ? 1 : Math.min(policy.hauling.maximumCreepsPerSource, Math.ceil(totalCarry / capacityCarry))
        const sourceHaulers = creeps.some(creep => !creep.spawning && creep.room.name === room.name &&
            creep.memory.role === 'filler' && energyCarryCapacity(creep) > 0 && creep.getActiveBodyparts(MOVE) > 0 &&
            !(creep.memory.boostPlan?.steps.length && !creep.memory.boostPlan.completed && !creep.memory.boostPlan.failed) &&
            servesSource(creep, source, container ? [container] : []))
        for (let index = 0; index < count; index++) publish(room, 'filler',
            `${room.name}_DEVELOP_FILLER_${source.id}_${index}`, { sourceId, mineId: source.id },
            { carryParts: Math.min(capacityCarry, Math.max(1, totalCarry - index * capacityCarry)), travelTicks: trip },
            sourceHaulers ? policy.hauling.expansionPriority : undefined)
    }
    if (room.storage) {
        const trip = distributionTrip
        const carry = Math.max(policy.bodies.defaultHaulerCarryParts, Math.ceil(trip * (imports + burst + importedBacklog) / CARRY_CAPACITY))
        const capacityCarry = Math.max(1, Math.min(policy.hauling.maximumCarryPartsPerCreep,
            Math.floor(room.energyCapacityAvailable / (BODYPART_COST[CARRY] + BODYPART_COST[MOVE]))))
        const count = Math.min(policy.hauling.maximumCreepsPerSource, Math.ceil(carry / capacityCarry))
        for (let index = 0; index < count; index++) publish(room, 'filler', `${room.name}_DEVELOP_FILLER_STORAGE_${index}`,
            { sourceId: room.storage.id }, { carryParts: Math.min(capacityCarry, Math.max(1, carry - index * capacityCarry)), travelTicks: trip })
        if (room.centerLink || room.terminal) publish(room, 'manager', `${room.name}_MANAGER`, {},
            { carryParts: policy.bodies.defaultHaulerCarryParts, stationary: true })
    }

    const essentialSites = room.constructionSites.filter(site => site.structureType != STRUCTURE_ROAD && site.structureType != STRUCTURE_RAMPART)
    const building = room.constructionSites.length > 0
    const sourceContainer = room.containers.find(container => room.sources.some(source => range(source.pos, container.pos) <= 1))
    const energySource = room.storage || sourceContainer || room.sources[0]
    if (energySource) {
        const constructionWork = Math.max(1, Math.min(policy.building.maximumCreeps * policy.building.workPartsPerCreep,
            Math.floor(income * (1 - policy.upgrading.incomeShareWhileBuilding) / BUILD_POWER) +
            (stored > policy.upgrading.storageReserve ? policy.building.maximumCreeps * policy.building.workPartsPerCreep : 0)))
        const builderWork = essentialSites.length > 0 ? policy.building.workPartsPerCreep : policy.building.roadOnlyWorkParts
        const builderCount = building ? Math.min(policy.building.maximumCreeps, Math.ceil(constructionWork / builderWork)) : 0
        const livingBuilders = creeps.filter(creep => creep.memory.role === 'builder' && creep.room.name === room.name)
        const builders = livingBuilders.filter(creep => workParts(creep) > 0 && creep.getActiveBodyparts(CARRY) > 0)
        // Idle constructors are reusable, including bodies near natural expiry.
        // Do not pre-spawn another worker while a paid-for builder occupies its slot.
        const incumbents = builders.filter(creep => creep.memory.name)
        const firstBootstrap = !room.storage && !sourceContainer && essentialSites.length > 0 && builders.length === 0
        let nextIndex = 0, births = 0
        for (let index = 0; index < builderCount; index++) {
            let name = incumbents.shift()?.memory.name
            if (!name) {
                if (builders.length + births >= builderCount) break
                const limit = livingBuilders.length + builderCount + policy.replacement.maximumReplacementsPerRoom
                while (nextIndex < limit) {
                    const candidate = `${room.name}_DEVELOP_BUILDER_${nextIndex++}`
                    if (!Game.creeps[createCreepName('builder', candidate)]) { name = candidate; break }
                }
                if (name) births++
            }
            if (!name) break
            const bootstrap = firstBootstrap && index === 0
            // Establish one self-supplied constructor after mining/hauling recovery,
            // before filling the complete production fleet. Do not wait for 300 energy.
            const body: NonNullable<CreepMemory['development']> = bootstrap ? {
                workParts: 1, carryParts: 1,
                maximumCost: BODYPART_COST[WORK] + BODYPART_COST[CARRY] + BODYPART_COST[MOVE],
            } : { workParts: Math.min(builderWork, constructionWork - index * builderWork) }
            publish(room, 'builder', name, { sourceId: energySource.id, buildTarget: '' }, body,
                bootstrap ? policy.building.firstCreepPriority : undefined)
            if (bootstrap) {
                const config = room.memory.creepConfig[createCreepName('builder', name)]
                if (config) config.bodyProfile = { boostTier: 0 }
            }
        }
    }
    const totalWork = Math.max(policy.upgrading.minimumWorkParts, Math.min(policy.upgrading.maximumTotalWorkParts,
        Math.floor(upgradeIncome *
            (building ? policy.upgrading.incomeShareWhileBuilding : policy.upgrading.incomeShare)) + upgradeBurst + upgradeBacklog))
    const aid = Object.values(Game.creeps).filter(creep => !creep.spawning && creep.room.name === room.name && hasAidUpgradeTask(creep, room) &&
        range(creep.pos, room.controller!.pos) <= 3 && workParts(creep) > 0)
    const externalWork = aid.filter(creep => (creep.store?.[RESOURCE_ENERGY] || 0) > 0 ||
        buffer !== undefined && range(creep.pos, buffer.pos) <= 1).reduce((total, creep) => total + workParts(creep), 0)
    const occupiedSeats = aid.length
    const maximum = Math.max(0, Math.min(policy.upgrading.maximumCreeps,
        controllerUpgradeSeatCount(room, buffer) - occupiedSeats))
    const upgrades = creeps.filter(creep => creep.memory.role === 'upgrader')
    let remaining = Math.max(0, totalWork - externalWork), count = upgrades.length
    // Paid-for bodies work until natural death. Budget and geometry constrain only
    // additional births, never the live unit's WORK quota or continued operation.
    for (const creep of upgrades) {
        const work = workParts(creep)
        remaining -= work
        if (!creep.memory.name) continue
        const sourceId = buffer?.id || energySource?.id || (creep.memory.data as UpgraderData).sourceId
        publish(room, 'upgrader', creep.memory.name, { sourceId }, { workParts: work, stationary: buffer != undefined })
    }
    if (!energySource || remaining <= 0 || count >= maximum) return
    const reserve = getDevelopmentSpawnReserve(room, 'upgrader')
    const workPerCreep = Math.max(1, affordableWork(room.energyCapacityAvailable - reserve,
        policy.upgrading.maximumWorkPartsPerCreep, buffer != undefined))
    const downgradeRecovery = room.controller!.ticksToDowngrade <= policy.controller.constructionDowngradeWarningTicks
    for (let index = 0; remaining > 0 && count < maximum &&
        index < upgrades.length + maximum + policy.replacement.maximumReplacementsPerRoom; index++) {
        const name = `${room.name}_DEVELOP_UPGRADER_${index}`
        if (Game.creeps[createCreepName('upgrader', name)]) continue
        const work = Math.min(workPerCreep, remaining)
        const emergency = downgradeRecovery && upgrades.length === 0 && count === 0
        publish(room, 'upgrader', name, { sourceId: buffer?.id || energySource.id },
            emergency ? { workParts: 1, carryParts: 1, stationary: buffer != undefined,
                maximumCost: BODYPART_COST[WORK] + BODYPART_COST[CARRY] + BODYPART_COST[MOVE] }
                : { workParts: work, stationary: buffer != undefined },
            emergency ? policy.upgrading.downgradeRecoveryPriority :
                upgrades.length === 0 && count === 0 ? policy.upgrading.firstCreepPriority : undefined)
        if (emergency) {
            const config = room.memory.creepConfig[createCreepName('upgrader', name)]
            if (config) config.bodyProfile = { boostTier: 0 }
        }
        remaining -= emergency ? 1 : work; count++
    }
}
