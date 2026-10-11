import { isDevelopingRoom } from './development'
import { developmentPolicy } from 'settings/development'
import { harvestWorkParts, energyCarryCapacity } from './bodyEffectiveness'
import { getSourceMiningWorkTarget } from './developmentEconomy'
import { hasSourceLinkTransport } from 'room/sourceLinks'
import { hasOwnedRamparts } from 'room/repairTargets'

/** An obsolete dedicated mine carrier can finish its delivery before yielding to Link transport. */
function obsoleteLinkHauler(creep: Creep, home: Room): boolean {
    if (!home.links?.length || creep.store[RESOURCE_ENERGY] > 0) return false
    const data = creep.memory.data as FillerData
    let mineId = data.mineId || creep.memory.developmentHauler?.mineId
    const prefix = `${home.name}_DEVELOP_FILLER_`, name = creep.memory.name || creep.name
    if (!mineId && name.startsWith(prefix)) mineId = name.slice(prefix.length, name.lastIndexOf('_')) as Id<Source>
    const source = home.sources.find(source => source.id === (mineId || data.sourceId))
    if (!source || !hasSourceLinkTransport(home, source)) return false
    if (home.containers.some(container => source.pos.inRangeTo(container, 1) && container.store[RESOURCE_ENERGY] > 0)) return false
    return !(home.droppedResource || []).some(drop => drop.resourceType === RESOURCE_ENERGY && drop.amount > 0 &&
        source.pos.inRangeTo(drop, developmentPolicy.hauling.mineResourceRange))
}

/** Shrinking the distribution fleet cannot discard the last or still-needed live capacity. */
function surplusStorageHauler(creep: Creep, home: Room): boolean {
    const prefix = `${home.name}_DEVELOP_FILLER_STORAGE_`
    if (!home.storage || !creep.memory.name?.startsWith(prefix) || creep.memory.role !== 'filler') return false
    const configs = home.memory.creepConfig || {}
    let required = 0, arrived = 0
    for (const [name, config] of Object.entries(configs)) {
        if (config.role !== 'filler' || !config.name?.startsWith(prefix) ||
            (config.data as FillerData).sourceId !== home.storage.id || (config.data as FillerData).mineId) continue
        required += Math.max(0, config.development?.carryParts || 0) * CARRY_CAPACITY
        const successor = Game.creeps[name]
        if (!successor || successor.name === creep.name || successor.spawning || successor.room.name !== home.name ||
            successor.memory.spawnRoom !== home.name || successor.getActiveBodyparts(MOVE) <= 0 ||
            (successor.memory.data as FillerData).mineId || successor.memory.developmentHauler?.mineId ||
            successor.memory.boostPlan?.steps.length && !successor.memory.boostPlan.completed && !successor.memory.boostPlan.failed) continue
        arrived += energyCarryCapacity(successor)
    }
    return required > 0 && arrived >= required
}

/** Growth units yield to the normal population only after its essential production is working. */
export function retireDevelopmentCreep(creep: Creep): boolean {
    if (creep.memory.development === undefined) return false
    // Paid-for upgrading and building bodies work until natural death. Catalogs
    // and the RCL8 transition can stop births but cannot recycle these residents.
    if (creep.memory.role === 'upgrader' || creep.memory.role === 'builder') return false
    const home = Game.rooms[creep.memory.spawnRoom]
    if (home?.controller?.my !== true) return false
    // A surviving permanent Rampart worker bridges catalog refreshes and the RCL8 transition.
    if (creep.memory.role === 'repairer' && hasOwnedRamparts(home) &&
        creep.getActiveBodyparts(WORK) > 0 && creep.getActiveBodyparts(CARRY) > 0) return false
    const configs = home.memory.creepConfig || {}
    const developing = isDevelopingRoom(home)
    const surplusDistributor = developing && !configs[creep.name] && surplusStorageHauler(creep, home)
    if (developing) {
        // No catalog yet means the population controller has not had a chance to refresh.
        if (home.memory.creepConfig === undefined || configs[creep.name] ||
            creep.memory.role === 'filler' && !obsoleteLinkHauler(creep, home) && !surplusDistributor) return false
        if (creep.memory.role === 'harvester') {
            const sourceId = (creep.memory.data as HarvesterData).sourceId
            const source = Game.getObjectById<Source>(sourceId)
            if (source === null) return false
            const publishedWork = Object.values(configs).reduce((total, config) =>
                config.role === 'harvester' && (config.data as HarvesterData).sourceId === sourceId
                    ? total + (config.development?.workParts || 0) : total, 0)
            const handoverWork = Math.min(getSourceMiningWorkTarget(source), publishedWork)
            if (handoverWork <= 0) return false
            let replacementWork = 0
            for (const candidate of Object.values(Game.creeps)) {
                if (candidate.name === creep.name || candidate.spawning || candidate.room.name !== home.name ||
                    candidate.memory.spawnRoom !== home.name || candidate.memory.role !== 'harvester' || !configs[candidate.name] ||
                    (candidate.memory.boostPlan?.steps.length && !candidate.memory.boostPlan.completed && !candidate.memory.boostPlan.failed) ||
                    (candidate.memory.data as HarvesterData).sourceId !== sourceId ||
                    !candidate.pos.inRangeTo(source, developmentPolicy.mining.handoverRange)) continue
                replacementWork += harvestWorkParts(candidate)
            }
            // Selected successors have physically arrived. Yielding within range two
            // permits handover even when this old miner occupies the only station.
            if (replacementWork < handoverWork) return false
        }
    }
    if (configs[creep.name] && configs[creep.name].development === undefined) return false
    const role = creep.memory.role
    if (!developing && (role === 'harvester' || role === 'filler')) {
        const sourceId = (creep.memory.data as HarvesterData).sourceId
        const successor = Object.values(Game.creeps).some(candidate => {
            if (candidate.name === creep.name || candidate.spawning || candidate.room.name !== home.name ||
                candidate.memory.spawnRoom !== home.name || candidate.memory.role !== role ||
                !configs[candidate.name] || configs[candidate.name].development !== undefined) return false
            if (role === 'filler') return candidate.getActiveBodyparts(CARRY) > 0
            if ((candidate.memory.data as HarvesterData).sourceId !== sourceId || harvestWorkParts(candidate) < developmentPolicy.mining.workPartsPerSource) return false
            const source = Game.getObjectById<Source>(sourceId)
            return source !== null && candidate.pos.inRangeTo(source, 1)
        })
        if (!successor) return false
    }
    creep.memory.dontPullMe = false
    if (surplusDistributor) {
        const mineral = Object.keys(creep.store).find(resource => resource !== RESOURCE_ENERGY && creep.store[resource] > 0) as ResourceConstant | undefined
        if (mineral) {
            const receiver = [home.storage, home.terminal].find(target => target && target.store.getFreeCapacity(mineral) > 0)
            if (receiver) {
                if (creep.transfer(receiver, mineral) === ERR_NOT_IN_RANGE) creep.moveTo(receiver, { range: 1 })
            }
            return true
        }
    }
    if (creep.store[RESOURCE_ENERGY] > 0) {
        const receiver = [home.storage, ...home.spawns, ...home.extensions, ...home.containers]
            .find((target): target is StructureStorage | StructureSpawn | StructureExtension | StructureContainer =>
                target !== undefined && target.store.getFreeCapacity(RESOURCE_ENERGY) > 0)
        if (receiver) {
            if (creep.transfer(receiver, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.moveTo(receiver, { range: 1 })
            return true
        }
        if (surplusDistributor) {
            if (home.terminal && home.terminal.store.getFreeCapacity(RESOURCE_ENERGY) > 0 &&
                creep.transfer(home.terminal, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.moveTo(home.terminal, { range: 1 })
            return true
        }
    }
    const spawn = home.spawns[0]
    if (spawn) {
        if (creep.pos.inRangeTo(spawn, 1)) spawn.recycleCreep(creep)
        else creep.moveTo(spawn, { range: 1 })
    }
    return true
}
