import { isDevelopingRoom } from './development'
import { developmentPolicy } from 'settings/development'
import { harvestWorkParts } from './bodyEffectiveness'
import { getSourceMiningWorkTarget } from './developmentEconomy'

/** Growth units yield to the normal population only after its essential production is working. */
export function retireDevelopmentCreep(creep: Creep): boolean {
    if (creep.memory.development === undefined) return false
    // Upgrading bodies have already been paid for. Oversupply and the RCL8
    // transition stop future births; they never recycle a living upgrader.
    if (creep.memory.role === 'upgrader') return false
    const home = Game.rooms[creep.memory.spawnRoom]
    if (home?.controller?.my !== true) return false
    const configs = home.memory.creepConfig || {}
    const developing = isDevelopingRoom(home)
    if (developing) {
        // No catalog yet means the population controller has not had a chance to refresh.
        if (home.memory.creepConfig === undefined || configs[creep.name] || creep.memory.role === 'filler') return false
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
    if (creep.store[RESOURCE_ENERGY] > 0) {
        const receiver = [home.storage, ...home.spawns, ...home.extensions, ...home.containers]
            .find((target): target is StructureStorage | StructureSpawn | StructureExtension | StructureContainer =>
                target !== undefined && target.store.getFreeCapacity(RESOURCE_ENERGY) > 0)
        if (receiver) {
            if (creep.transfer(receiver, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.moveTo(receiver, { range: 1 })
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
