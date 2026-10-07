import roles from 'role'
import { roleAdvEnum, roleBaseEnum } from 'settings/creep'
import { populationPolicy } from 'settings/population'
import { addCreepConfig, createCreepName } from './demand'
import { isDevelopingRoom } from './development'
import { releaseDevelopmentBaseConfig } from './developmentPopulation'
import { sourceLink, hasSourceLinkTransport } from 'room/sourceLinks'
import { sourceLinkPolicy } from 'settings/sourceLinks'
import { releaseRepairerCreepConfigs } from './repairerPopulation'
import { isRoomEvacuating } from 'room/evacuationState'

/** A zero-CARRY resident cannot hold the only Link-miner birth slot until natural death. */
function linkedMinerName(room: Room, source: Source, name: string): string {
    const current = Game.creeps[createCreepName(roleBaseEnum.HARVESTER, name)]
    if (current && current.getActiveBodyparts(CARRY) > 0) return name
    const prefix = `${name}_LINK_CARRY_`
    // Keep a healthy replacement's demand after its predecessor retires.
    const replacement = Object.values(Game.creeps).find(creep => creep.memory.spawnRoom === room.name &&
        creep.memory.role === roleBaseEnum.HARVESTER && (creep.memory.data as HarvesterData).sourceId === source.id &&
        creep.memory.name?.startsWith(prefix) && creep.getActiveBodyparts(CARRY) > 0 && creep.getActiveBodyparts(WORK) > 0)
    if (replacement) return replacement.memory.name
    if (current === undefined) return name
    let index = 0
    while (Game.creeps[createCreepName(roleBaseEnum.HARVESTER, `${prefix}${index}`)]) index++
    return `${prefix}${index}`
}

/** Reuse paid-for local constructors without converting a normal body into a growth job. */
function localBuilderPublisher(room: Room): (name: string, data: BuilderData) => void {
    let available: Creep[] | undefined
    const assigned = new Set<string>()
    return (requestedName, data) => {
        if (available === undefined) available = Object.values(Game.creeps).filter(creep =>
            creep.room.name === room.name && creep.memory.spawnRoom === room.name && creep.memory.role === 'builder' &&
            !!creep.memory.name && creep.getActiveBodyparts(WORK) > 0 && creep.getActiveBodyparts(CARRY) > 0)
        const preferred = available.findIndex(creep => creep.memory.name === requestedName)
        const resident = available.splice(preferred < 0 ? 0 : preferred, 1)[0]
        let name = resident?.memory.name || requestedName
        if (!resident && (Game.creeps[createCreepName('builder', name)] || assigned.has(name))) {
            let index = 0
            while (Game.creeps[createCreepName('builder', `${requestedName}_REUSE_${index}`)] ||
                assigned.has(`${requestedName}_REUSE_${index}`)) index++
            name = `${requestedName}_REUSE_${index}`
        }
        assigned.add(name)
        addCreepConfig(room, 'builder', name, data)
    }
}
/**
 * 检查房间信息，发布对应Creep需求
 */
export function releaseBaseCreepConfig(): void {
    for (const roomName in Game.rooms) {
        const room: Room = Game.rooms[roomName]
        if (!room.my || isRoomEvacuating(room)) continue
        if (isDevelopingRoom(room)) {
            releaseDevelopmentBaseConfig(room)
            continue
        }
        const publishBuilder = localBuilderPublisher(room)
        releaseRepairerCreepConfigs(room, false)

        if (roles[roleAdvEnum.MANAGER]({}).isNeed(room, '')) {
            addCreepConfig(
                room,
                roleAdvEnum.MANAGER,
                room.name + '_MANAGER',
                {}
            )
        }

        if (roles[roleAdvEnum.PROCESSER]({}).isNeed(room, '')) {
            addCreepConfig(
                room,
                roleAdvEnum.PROCESSER,
                room.name + '_PROCESSER',
                {}
            )
        }

        const creepMemory: MineralData = { sourceId: room.mineral.id }
        if (roles[roleBaseEnum.MINER](creepMemory).isNeed(room, '')) {
            addCreepConfig(
                room,
                roleBaseEnum.MINER,
                room.name + '_MINER',
                creepMemory
            )
        }

        // 根据矿产情况发布矿工
        room.sources.forEach((source) => {
            if (source.energy == 0) return
            // 三级之后每个矿一个矿工
            const canHarvesterPos = room.level > populationPolicy.base.singleHarvesterAfterLevel ? 1 : Math.min(
                source.pos.getFreeSpace().length,
                populationPolicy.base.maximumHarvestersPerSource
            )
            const linked = room.links.length > 0 && sourceLink(room, source) !== undefined
            for (let i = 0; i < canHarvesterPos; i++) {
                const creepMemory: HarvesterData = { sourceId: source.id }
                const baseName = room.name + '_HARVESTER_' + source.id + '_' + i
                const creepName = linked ? linkedMinerName(room, source, baseName) : baseName
                addCreepConfig(
                    room,
                    roleBaseEnum.HARVESTER,
                    creepName,
                    creepMemory
                )
            }
        })

        // 未形成 Storage/Source Container 物流时，工地也需要能直接采能的建造者。
        const hasSourceContainer = room.containers.some(container =>
            room.sources.some(source => source.pos.inRangeTo(container, populationPolicy.base.sourceContainerRange))
        )
        if (populationPolicy.bootstrap.enabled && room.spawns.length > 0 && !room.storage &&
            !hasSourceContainer && room.constructionSites.length > 0 && room.sources.length > 0) {
            for (let index = 0; index < populationPolicy.bootstrap.localBuilderCount; index++) {
                const source = room.sources[index % room.sources.length]
                addCreepConfig(room, roleBaseEnum.BUILDER, room.name + '_BUILDER_BOOTSTRAP_' + index,
                    { sourceId: source.id, buildTarget: '' })
            }
        }

        // 如果有Storage，则发布Storage相关Creep
        if (room.storage) {
            // 每10000能量发布一个升级者
            if (
                room.level < 8 ||
                (room.controller &&
                    room.controller.ticksToDowngrade <
                        populationPolicy.base.downgradeWarningTicks)
            ) {
                var upgradeCount =
                    Math.floor(
                        room.storage.store[RESOURCE_ENERGY] /
                            populationPolicy.base.energyPerUpgrader
                    ) + 1
                if (room.controller && room.controller.level == 8)
                    upgradeCount = 1
                upgradeCount = Math.min(
                    upgradeCount,
                    populationPolicy.base.maximumUpgraders
                )

                for (let i = 0; i < upgradeCount; i++) {
                    const creepMemory: UpgraderData = {
                        sourceId: room.storage.id,
                    }
                    const creepName: string =
                        room.name + '_UPGRADER_STORAGE_' + i
                    addCreepConfig(
                        room,
                        roleBaseEnum.UPGRADER,
                        creepName,
                        creepMemory
                    )
                }
            }

            // 发布一个填充者
            const creepFillerMemory: FillerData = { sourceId: room.storage.id }
            const creepFillerName0 = room.name + '_FILLER_STORAGE_0'
            addCreepConfig(
                room,
                roleBaseEnum.FILLER,
                creepFillerName0,
                creepFillerMemory
            )

            // 存储旁发布一个建造者
            const creepBuilderMemory: BuilderData = {
                sourceId: room.storage.id,
                buildTarget: '',
            }
            if (
                roles[roleBaseEnum.BUILDER](creepBuilderMemory).isNeed(room, '')
            ) {
                const creepBuilderName0 = room.name + '_BUILDER_STORAGE_0'
                publishBuilder(creepBuilderName0, creepBuilderMemory)
            }

        }

        // Source旁边的Container，发布对应Creep
        const linkSalvage = new Set<string>()
        room.containers.forEach((container) => {
            if (
                room.sources.filter((source) =>
                    source.pos.inRangeTo(
                        container,
                        populationPolicy.base.sourceContainerRange
                    )
                ).length == 0
            )
                return

            const adjacentSources = room.links.length > 0 ? room.sources.filter(source =>
                source.pos.inRangeTo(container, sourceLinkPolicy.containerRange)) : []
            // A shared Container must still transport production from any unlinked Source.
            const linkedSource = adjacentSources.length > 0 && adjacentSources.every(source => hasSourceLinkTransport(room, source)) && adjacentSources[0]
            const salvage = linkedSource && container.store[RESOURCE_ENERGY] > 0 && !linkSalvage.has(linkedSource.id)
            const creepFillerMemory: FillerData = { sourceId: container.id }
            const creepFillerName0 =
                room.name + '_FILLER_CONTAINER_' + container.id + '_0'
            if (!linkedSource || salvage) {
                addCreepConfig(room, roleBaseEnum.FILLER, creepFillerName0, creepFillerMemory)
                if (linkedSource) linkSalvage.add(linkedSource.id)
            }
            if (
                !linkedSource &&
                container.store[RESOURCE_ENERGY] >
                    populationPolicy.base.extraFillerEnergy &&
                room.storage != undefined
            ) {
                const creepFillerName1 =
                    room.name + '_FILLER_CONTAINER_' + container.id + '_1'
                addCreepConfig(
                    room,
                    roleBaseEnum.FILLER,
                    creepFillerName1,
                    creepFillerMemory
                )
            }

            if (room.storage) return

            const creepBuilderMemory: BuilderData = {
                sourceId: container.id,
                buildTarget: '',
            }
            if (
                roles[roleBaseEnum.BUILDER](creepBuilderMemory).isNeed(room, '')
            ) {
                const creepBuilderName =
                    room.name + '_BUILDER_CONTAINER_' + container.id
                publishBuilder(creepBuilderName, creepBuilderMemory)

                if (
                    container.store[RESOURCE_ENERGY] >
                    populationPolicy.base.extraBuilderEnergy
                ) {
                    const creepBuilderName =
                        room.name + '_BUILDER_CONTAINER_' + container.id + '_1'
                    publishBuilder(creepBuilderName, creepBuilderMemory)
                }
            }


            if (room.level < 8) {
                for (
                    let i = 0;
                    i <
                    container.store[RESOURCE_ENERGY] /
                        populationPolicy.base.containerEnergyPerUpgrader;
                    i++
                ) {
                    const creepUpgraderMemory: UpgraderData = {
                        sourceId: container.id,
                    }
                    const creepUpgraderName =
                        room.name +
                        '_UPGRADER_CONTAINER_' +
                        container.id +
                        '_' +
                        i
                    addCreepConfig(
                        room,
                        roleBaseEnum.UPGRADER,
                        creepUpgraderName,
                        creepUpgraderMemory
                    )
                }
            }
        })
    }
}
