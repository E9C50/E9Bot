import roles from 'role'
import { roleAdvEnum, roleBaseEnum } from 'settings/creep'
import { populationPolicy } from 'settings/population'
import { addCreepConfig } from './demand'
import { isDevelopingRoom } from './development'
import { releaseDevelopmentBaseConfig } from './developmentPopulation'
/**
 * 检查房间信息，发布对应Creep需求
 */
export function releaseBaseCreepConfig(): void {
    for (const roomName in Game.rooms) {
        const room: Room = Game.rooms[roomName]
        if (!room.my) continue
        if (isDevelopingRoom(room)) {
            releaseDevelopmentBaseConfig(room)
            continue
        }

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
            let canHarvesterPos: number = source.pos.getFreeSpace().length
            canHarvesterPos = Math.min(
                canHarvesterPos,
                populationPolicy.base.maximumHarvestersPerSource
            )
            // 三级之后每个矿一个矿工
            if (room.level > populationPolicy.base.singleHarvesterAfterLevel)
                canHarvesterPos = 1
            for (let i = 0; i < canHarvesterPos; i++) {
                const creepMemory: HarvesterData = { sourceId: source.id }
                const creepName: string =
                    room.name + '_HARVESTER_' + source.id + '_' + i
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
                addCreepConfig(
                    room,
                    roleBaseEnum.BUILDER,
                    creepBuilderName0,
                    creepBuilderMemory
                )
            }

            // 按能量与房间等级计算修理工需求，再应用配置上限
            const creepRepairerMemory: RepairerData = {
                sourceId: room.storage.id,
                repairTarget: '',
            }
            if (
                roles[roleBaseEnum.REPAIRER](creepRepairerMemory).isNeed(
                    room,
                    ''
                )
            ) {
                var repairerCount =
                    Math.floor(
                        room.storage.store[RESOURCE_ENERGY] /
                            populationPolicy.base.energyPerRepairer
                    ) + 1
                if (
                    room.controller &&
                    room.controller.level <
                        populationPolicy.base.singleRepairerBelowLevel
                )
                    repairerCount = 1

                repairerCount = Math.min(
                    repairerCount,
                    populationPolicy.base.maximumRepairers
                )

                for (let i = 0; i < repairerCount; i++) {
                    const creepRepairerName =
                        room.name + '_REPAIRER_STORAGE' + i
                    addCreepConfig(
                        room,
                        roleBaseEnum.REPAIRER,
                        creepRepairerName,
                        creepRepairerMemory
                    )
                }
            }
        }

        // Source旁边的Container，发布对应Creep
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

            const creepFillerMemory: FillerData = { sourceId: container.id }
            const creepFillerName0 =
                room.name + '_FILLER_CONTAINER_' + container.id + '_0'
            addCreepConfig(
                room,
                roleBaseEnum.FILLER,
                creepFillerName0,
                creepFillerMemory
            )
            if (
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
                addCreepConfig(
                    room,
                    roleBaseEnum.BUILDER,
                    creepBuilderName,
                    creepBuilderMemory
                )

                if (
                    container.store[RESOURCE_ENERGY] >
                    populationPolicy.base.extraBuilderEnergy
                ) {
                    const creepBuilderName =
                        room.name + '_BUILDER_CONTAINER_' + container.id + '_1'
                    addCreepConfig(
                        room,
                        roleBaseEnum.BUILDER,
                        creepBuilderName,
                        creepBuilderMemory
                    )
                }
            }

            const creepRepairerMemory: RepairerData = {
                sourceId: container.id,
                repairTarget: '',
            }
            if (
                roles[roleBaseEnum.REPAIRER](creepRepairerMemory).isNeed(
                    room,
                    ''
                )
            ) {
                const creepRepairerName =
                    room.name + '_REPAIRER_CONTAINER_' + container.id
                addCreepConfig(
                    room,
                    roleBaseEnum.REPAIRER,
                    creepRepairerName,
                    creepRepairerMemory
                )
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
