import { addCreepConfig, createCreepName } from './demand'
import { rolePolicy } from 'settings/rolePolicy'
import { populationPolicy } from 'settings/population'
import { developmentPolicy } from 'settings/development'
import { hasOwnedRamparts } from 'room/repairTargets'

/** The permanent Rampart floor is independent of the legacy surplus-energy fleet ceiling. */
export function releaseRepairerCreepConfigs(room: Room, developing: boolean): void {
    const policy = rolePolicy.repairer
    const minimum = hasOwnedRamparts(room) ? Math.max(0, Math.floor(policy.minimumRampartWorkers)) : 0
    const energy = room.storage?.store[RESOURCE_ENERGY] || 0
    let extra = 0
    if (!developing && room.storage && energy > policy.minimumStorageEnergy && room.wallsNeedRepair.length > 0) {
        extra = Math.floor(energy / populationPolicy.base.energyPerRepairer) + 1
        if (room.controller && room.controller.level < populationPolicy.base.singleRepairerBelowLevel) extra = 1
        extra = Math.min(extra, populationPolicy.base.maximumRepairers)
    }
    const count = Math.max(minimum, extra)
    if (count <= 0) return
    const source = room.storage || room.containers[0] || room.sources[0]
    const all = Object.values(Game.creeps).filter(creep => creep.memory.role === 'repairer' &&
        creep.room.name === room.name && (creep.memory.spawnRoom || creep.room.name) === room.name)
    const available = all.filter(creep => creep.getActiveBodyparts(WORK) > 0 && creep.getActiveBodyparts(CARRY) > 0)
    const assigned = new Set<string>()
    for (let index = 0; index < count; index++) {
        const wanted = room.storage ? `${room.name}_REPAIRER_STORAGE${index}` : `${room.name}_REPAIRER_RAMPART_${index}`
        const preferred = available.findIndex(creep => creep.memory.name === wanted)
        const resident = available.splice(preferred < 0 ? 0 : preferred, 1)[0]
        let name = resident?.memory.name || resident?.name || wanted
        if (!resident && (Game.creeps[createCreepName('repairer', name)] || assigned.has(name))) {
            let suffix = 0
            while (Game.creeps[createCreepName('repairer', `${wanted}_REUSE_${suffix}`)] || assigned.has(`${wanted}_REUSE_${suffix}`)) suffix++
            name = `${wanted}_REUSE_${suffix}`
        }
        assigned.add(name)
        const key = addCreepConfig(room, 'repairer', name, { sourceId: source?.id || '', repairTarget: '' })
        const config = room.memory.creepConfig[key]
        if (!config) continue
        if (!resident && index < minimum) config.spawnPriority = policy.firstRampartWorkerPriority
        if (resident?.memory.bodyProfile) config.bodyProfile = { ...resident.memory.bodyProfile }
        const minimumCost = BODYPART_COST[WORK] + BODYPART_COST[CARRY] + BODYPART_COST[MOVE]
        if (developing) {
            const work = Math.max(1, Math.floor(policy.rampartWorkerWorkParts))
            config.development = { workParts: work,
                carryParts: Math.max(developmentPolicy.bodies.minimumWorkerCarryParts, work * developmentPolicy.bodies.workerCarryPerWork),
                maximumCost: Math.min(room.energyCapacityAvailable, Math.max(minimumCost, room.energyAvailable)) }
            config.bodyProfile = { ...config.bodyProfile, boostTier: 0 }
        } else if (index < minimum && room.energyAvailable < room.energyCapacityAvailable) {
            // The permanent worker must be affordable before a mature room's pool is full.
            config.bodyProfile = { ...config.bodyProfile, maximumCost: Math.min(
                config.bodyProfile?.maximumCost ?? Infinity, room.energyCapacityAvailable,
                Math.max(minimumCost, room.energyAvailable)) }
        }
        // Manual native names can differ from the bot's hash; keep their actual birth slot occupied.
        if (resident && resident.name !== key) {
            delete room.memory.creepConfig[key]
            config.displayName = resident.name
            room.memory.creepConfig[resident.name] = config
        }
    }
}
