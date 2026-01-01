import roles from 'role'
import squard from 'squard'
import { sha1String } from "utils";
import { roleAdvEnum, roleBaseEnum, roleWarEnum, spawnPriority, warModeRole } from "settings/creep";
import BattleCalc from 'utils/BattleCalc';

/**
 *  添加需求配置
 * @param room
 * @param creepRole
 * @param creepName
 * @param creepMemory
 * @returns
 */
function addCreepConfig(room: Room, creepRole: CreepRoleConstant, creepName: string, creepData: CreepData = {}, isTeam: boolean = false): string {
    if (Memory.warMode[room.name] && !warModeRole.includes(creepRole)) return ''
    const creepNameHash = creepRole.toUpperCase() + '_' + sha1String(creepName)
    const priority = spawnPriority[creepRole]
    room.memory.creepConfig[creepNameHash] = {
        displayName: creepNameHash,
        name: creepName,
        role: creepRole,
        isTeam: isTeam,
        working: false,
        ready: false,
        spawnRoom: room.name,
        spawnPriority: priority,
        data: creepData
    }
    return creepNameHash
}

/**
 * 检查房间信息，发布对应Creep需求
 */
function releaseBaseCreepConfig(): void {
    for (const roomName in Game.rooms) {
        const room: Room = Game.rooms[roomName];
        if (!room.my) continue;

        if (roles[roleAdvEnum.MANAGER]({}).isNeed(room, '')) {
            addCreepConfig(room, roleAdvEnum.MANAGER, room.name + '_MANAGER', {})
        }

        if (roles[roleAdvEnum.PROCESSER]({}).isNeed(room, '')) {
            addCreepConfig(room, roleAdvEnum.PROCESSER, room.name + '_PROCESSER', {})
        }

        const creepMemory: MineralData = { sourceId: room.mineral.id }
        if (roles[roleBaseEnum.MINER](creepMemory).isNeed(room, '')) {
            addCreepConfig(room, roleBaseEnum.MINER, room.name + '_MINER', creepMemory)
        }

        // 根据矿产情况发布矿工
        room.sources.forEach(source => {
            if (source.energy == 0) return
            let canHarvesterPos: number = source.pos.getFreeSpace().length;
            canHarvesterPos = Math.min(canHarvesterPos, 2);
            // 三级之后每个矿一个矿工
            if (room.level > 3) canHarvesterPos = 1;
            for (let i = 0; i < canHarvesterPos; i++) {
                const creepMemory: HarvesterData = { sourceId: source.id }
                const creepName: string = room.name + '_HARVESTER_' + source.id + '_' + i
                addCreepConfig(room, roleBaseEnum.HARVESTER, creepName, creepMemory)
            }
        });

        // 如果有Storage，则发布Storage相关Creep
        if (room.storage) {
            // 每10000能量发布一个升级者
            if (room.level < 8 || (room.controller && room.controller.ticksToDowngrade < 150000)) {
                var upgradeCount = Math.floor(room.storage.store[RESOURCE_ENERGY] / 10000) + 1;
                if (room.controller && room.controller.level == 8) upgradeCount = 1;
                upgradeCount = Math.min(upgradeCount, 8);

                upgradeCount = Math.min(upgradeCount, 4);

                for (let i = 0; i < upgradeCount; i++) {
                    const creepMemory: UpgraderData = { sourceId: room.storage.id }
                    const creepName: string = room.name + '_UPGRADER_STORAGE_' + i
                    addCreepConfig(room, roleBaseEnum.UPGRADER, creepName, creepMemory)
                }
            }

            // 发布一个填充者
            const creepFillerMemory: FillerData = { sourceId: room.storage.id }
            const creepFillerName0 = room.name + '_FILLER_STORAGE_0'
            addCreepConfig(room, roleBaseEnum.FILLER, creepFillerName0, creepFillerMemory)

            // // 如果Storage能量足够，Ext不到一半，但是生成排队超过3个，则再发布一个填充者
            // if (room.storage.store[RESOURCE_ENERGY] > 10000 && room.energyAvailable < (room.energyCapacityAvailable * 0.5)) {
            //     const creepFillerName1 = room.name + '_FILLER_STORAGE_1'
            //     addCreepConfig(room, roleBaseEnum.FILLER, creepFillerName1, creepFillerMemory, spawnPriority.filler)
            // }

            // 发布两个建造者
            const creepBuilderMemory: BuilderData = { sourceId: room.storage.id, buildTarget: '' }
            if (roles[roleBaseEnum.BUILDER](creepBuilderMemory).isNeed(room, '')) {
                const creepBuilderName0 = room.name + '_BUILDER_STORAGE_0'
                // const creepBuilderName1 = room.name + '_BUILDER_STORAGE_1'
                addCreepConfig(room, roleBaseEnum.BUILDER, creepBuilderName0, creepBuilderMemory)
                // addCreepConfig(room, roleBaseEnum.BUILDER, creepBuilderName1, creepBuilderMemory)
            }

            // 每50000能量发布一个修理工，8级以下只发布一个
            const creepRepairerMemory: RepairerData = { sourceId: room.storage.id, repairTarget: '' }
            if (roles[roleBaseEnum.REPAIRER](creepRepairerMemory).isNeed(room, '')) {
                var repairerCount = Math.floor(room.storage.store[RESOURCE_ENERGY] / 100000) + 1;
                if (room.controller && room.controller.level < 6) repairerCount = 1;

                repairerCount = Math.min(repairerCount, 1)

                for (let i = 0; i < repairerCount; i++) {
                    const creepRepairerName = room.name + '_REPAIRER_STORAGE' + i
                    addCreepConfig(room, roleBaseEnum.REPAIRER, creepRepairerName, creepRepairerMemory)
                }
            }
        }

        // Source旁边的Container，发布对应Creep
        room.containers.forEach(container => {
            if (room.sources.filter(source => source.pos.inRangeTo(container, 3)).length == 0) return

            const creepFillerMemory: FillerData = { sourceId: container.id }
            const creepFillerName0 = room.name + '_FILLER_CONTAINER_' + container.id + '_0'
            addCreepConfig(room, roleBaseEnum.FILLER, creepFillerName0, creepFillerMemory);
            if (container.store[RESOURCE_ENERGY] > 1000 && room.storage != undefined) {
                const creepFillerName1 = room.name + '_FILLER_CONTAINER_' + container.id + '_1'
                addCreepConfig(room, roleBaseEnum.FILLER, creepFillerName1, creepFillerMemory);
            }

            if (room.storage) return


            const creepBuilderMemory: BuilderData = { sourceId: container.id, buildTarget: '' }
            if (roles[roleBaseEnum.BUILDER](creepBuilderMemory).isNeed(room, '')) {
                const creepBuilderName = room.name + '_BUILDER_CONTAINER_' + container.id
                addCreepConfig(room, roleBaseEnum.BUILDER, creepBuilderName, creepBuilderMemory);

                if (container.store[RESOURCE_ENERGY] > 1500) {
                    const creepBuilderName = room.name + '_BUILDER_CONTAINER_' + container.id + '_1'
                    addCreepConfig(room, roleBaseEnum.BUILDER, creepBuilderName, creepBuilderMemory);
                }
            }

            const creepRepairerMemory: RepairerData = { sourceId: container.id, repairTarget: '' }
            if (roles[roleBaseEnum.REPAIRER](creepRepairerMemory).isNeed(room, '')) {
                const creepRepairerName = room.name + '_REPAIRER_CONTAINER_' + container.id
                addCreepConfig(room, roleBaseEnum.REPAIRER, creepRepairerName, creepRepairerMemory);
            }

            if (room.level < 8) {
                for (let i = 0; i < container.store[RESOURCE_ENERGY] / 1000; i++) {
                    const creepUpgraderMemory: UpgraderData = { sourceId: container.id }
                    const creepUpgraderName = room.name + '_UPGRADER_CONTAINER_' + container.id + '_' + i
                    addCreepConfig(room, roleBaseEnum.UPGRADER, creepUpgraderName, creepUpgraderMemory);
                }
            }
        })
    }
}


function releaseJobsCreepConfig(): void {
    for (const roomName in Game.rooms) {
        const room: Room = Game.rooms[roomName];
        if (!room.my) continue;

        // 发布侦察兵
        if (Game.flags[room.name + '_SCOUT'] != undefined) {
            const creepMemory: ScoutData = { targetFlag: room.name + '_SCOUT' }
            const creepNameHarvester: string = room.name + '_SCOUT'
            addCreepConfig(room, roleBaseEnum.SCOUT, creepNameHarvester, creepMemory)
        }

        // 处理外矿房
        for (let i = 0; i < 10; i++) {
            const flag = Game.flags[room.name + '_OUT' + i]
            // 如果房间不可见，先发布侦察兵
            if (flag != undefined && flag.room?.sources == undefined) {
                const creepMemory: ScoutData = { targetFlag: room.name + '_SCOUT' }
                const creepNameHarvester: string = room.name + '_SCOUT'
                addCreepConfig(room, roleBaseEnum.SCOUT, creepNameHarvester, creepMemory)
            }

            if (flag != undefined && flag.room?.sources != undefined && flag.room.sources.length > 0) {
                // 等级大于2级发布矿房预定者
                if (room.level > 2) {
                    const reserverMemory: ReserverData = { targetRoom: flag.pos.roomName }
                    const creepName = room.name + '_RESERVER_' + flag.pos.roomName
                    addCreepConfig(room, roleAdvEnum.RESERVER, creepName, reserverMemory);
                }

                // 如果外矿房有工地，或者需要修路，就发布远程修理工
                const targetOutRoom = Game.rooms[flag.pos.roomName]
                if (targetOutRoom != undefined && (targetOutRoom.constructionSites.length > 0 || targetOutRoom.roads.filter(road => road.hits < (road.hitsMax / 2)).length > 0)) {
                    const remoteBuilderMemory: RemoteBuilderData = { sourceFlag: targetOutRoom.sources[0].id, targetFlag: targetOutRoom.sources[0].id }
                    const creepName = room.name + '_OSBUILDER_' + room.name
                    const creep = Game.creeps['OSBUILDER_' + sha1String(creepName)]
                    if (creep == undefined) {
                        addCreepConfig(room, roleAdvEnum.RBUILDER, creepName, remoteBuilderMemory);
                    } else {
                        // 如果修理工已经发布，就更新他的工作目标
                        const creepData = creep.memory.data as RemoteBuilderData
                        if (room.storage != undefined && room.storage[RESOURCE_ENERGY] > 100000) {
                            creepData.sourceFlag = room.storage.id
                        } else {
                            creepData.sourceFlag = targetOutRoom.sources[0].id
                        }
                        creepData.targetFlag = targetOutRoom.sources[0].id
                    }
                }

                // 如果外矿有入侵者，发布一体机去干他
                // const invader = targetOutRoom.enemies.filter(enemy => enemy.owner.username == 'Invader')
                // if (targetOutRoom != undefined && (invader.length > 0 || targetOutRoom.invaderCore != undefined)) {
                //     const integrateMemory: IntegrateData = { targetFlag: targetOutRoom.sources[0].id }
                //     const creepName = room.name + '_INTEGRATE_' + targetOutRoom.sources[0].id
                //     const creep = Game.creeps['INTEGRATE_' + sha1String(creepName)]
                //     if (creep == undefined) {
                //         addCreepConfig(room, roleWarEnum.INTEGRATE, creepName, integrateMemory);
                //     } else {
                //         const creepData = creep.memory.data as IntegrateData
                //         creepData.targetFlag = targetOutRoom.sources[0].id
                //     }
                // }

                for (let index in flag.room.sources) {
                    const sourceId = flag.room.sources[index].id

                    if (room.spawns.length == 0) continue

                    // 发布外矿能量矿工
                    const creepMemory: RemoteHarvesterData = { sourceId: sourceId, targetRoom: flag.room.name }
                    const creepNameHarvester: string = room.name + '_RHARVESTER_' + sourceId
                    addCreepConfig(room, roleAdvEnum.RHARVESTER, creepNameHarvester, creepMemory)

                    // 发布外矿能量搬运工
                    const remoteFillerMemory: RemoteFillerData = { sourceFlag: sourceId, targetFlag: room.spawns[0].id }
                    const creepName = room.name + '_RFILLER_' + sourceId + '_' + room.spawns[0].id
                    addCreepConfig(room, roleAdvEnum.RFILLER, creepName, remoteFillerMemory);
                }
            }
        }

        // 发布 attacker
        for (let i = 0; i < 20; i++) {
            const flag = Game.flags[room.name + '_ATT' + i]
            if (flag != undefined) {
                const attackerMemory: AttackerData = { targetFlag: room.name + '_ATT' + i }
                const creepName = room.name + '_ATTACKER_' + room.name + '_ATT' + i
                addCreepConfig(room, roleWarEnum.ATTACKER, creepName, attackerMemory);
            }
        }

        // 发布 integrate
        for (let i = 0; i < 20; i++) {
            const flag = Game.flags[room.name + '_INTE' + i]
            if (flag != undefined) {
                const integrateMemory: IntegrateData = { targetFlag: room.name + '_INTE' + i }
                const creepName = room.name + '_INTEGRATE_' + room.name + '_INTE' + i
                addCreepConfig(room, roleWarEnum.INTEGRATE, creepName, integrateMemory);
            }
        }

        // 发布外房搬运工
        for (let i = 0; i < 20; i++) {
            const sourceFlag = Game.flags[room.name + '_RF_S' + i]
            const targetFlag = Game.flags[room.name + '_RF_T' + i]
            if (sourceFlag != undefined && targetFlag != undefined) {
                const remoteFillerMemory: RemoteFillerData = { sourceFlag: room.name + '_RF_S' + i, targetFlag: room.name + '_RF_T' + i }
                const creepName = room.name + '_RFILLER_' + room.name + '_RF_S' + i + '_' + room.name + '_RF_T' + i
                addCreepConfig(room, roleAdvEnum.RFILLER, creepName, remoteFillerMemory);
            }
        }

        // 发布外房Worker
        for (let i = 0; i < 20; i++) {
            const sourceFlag = Game.flags[room.name + '_RB_S' + i]
            const targetFlag = Game.flags[room.name + '_RB_T' + i]
            if (sourceFlag != undefined && targetFlag != undefined) {
                const remoteBuilderMemory: RemoteBuilderData = { sourceFlag: room.name + '_RB_S' + i, targetFlag: room.name + '_RB_T' + i }
                const creepName = room.name + '_RBUILDER_' + room.name + '_RB_S' + i + '_' + room.name + '_RB_T' + i
                addCreepConfig(room, roleAdvEnum.RBUILDER, creepName, remoteBuilderMemory);
            }
        }

        // 发布新房占领
        const claimFlag = Game.flags[room.name + '_CLAIM']
        if (claimFlag != undefined) {
            const claimerMemory: ClaimerData = { targetFlag: claimFlag.name }
            const creepName = room.name + '_CLAIMER_' + claimFlag.name
            addCreepConfig(room, roleAdvEnum.CLAIMER, creepName, claimerMemory);
        }

        // 戳控制器的爬
        for (let i = 0; i < 20; i++) {
            const caFlag = Game.flags[room.name + '_CA' + i]
            if (caFlag != undefined && !caFlag.room?.my) {
                const caMemory: AttackerData = { targetFlag: caFlag.name }
                const creepName = room.name + '_CA_' + caFlag.name
                addCreepConfig(room, roleWarEnum.CONTROLLER_ATTACKER, creepName, caMemory);
            }
        }

        // // 发布 healer
        // if (roomCustom.healer != undefined) {
        //     roomCustom.healer.forEach(flagName => {
        //         if (Game.flags[flagName] != undefined) {
        //             const healerMemory: HealerData = { targetFlag: flagName, team: undefined }
        //             const creepName = room.name + '_HEALER_' + flagName
        //             addCreepConfig(room, roleWarEnum.HEALER, creepName, healerMemory, spawnPriority.healer);
        //         }
        //     });
        // }

        // // 发布矿房预定工
        // if (roomCustom.reserver != undefined) {
        //     roomCustom.reserver.forEach(targetRoomName => {
        //         const reserverMemory: ReserverData = { targetRoom: targetRoomName }
        //         const creepName = room.name + '_RESERVER_' + targetRoomName
        //         addCreepConfig(room, roleAdvEnum.RESERVER, creepName, reserverMemory, spawnPriority.reserver);
        //     })
        // }
    }
}

function analyzeEnemyGroups(enemies) {
    const groups: Creep[][] = [];
    for (const enemy of enemies) {
        let addedToGroup = false;
        for (const group of groups) {
            const closestInGroup = enemy.pos.findClosestByRange(group);
            if (closestInGroup && enemy.pos.getRangeTo(closestInGroup) <= 2) {
                group.push(enemy);
                addedToGroup = true
            }
        }

        if (!addedToGroup) {
            groups.push([enemy]);
        }
    }

    return groups;
}

function releaseWarCreepConfig(): void {
    for (const roomName in Game.rooms) {
        const room: Room = Game.rooms[roomName];
        if (!room.my) continue;

        // 守卫者，根据敌人情况发布不同的守卫
        const enemyList = room.enemies.filter(enemy => enemy.owner.username != 'Invader' && enemy.owner.username != 'Source Keeper')
        const damage = enemyList.map(enemy => BattleCalc.calcCreepDamage(enemy)).reduce((a, b) => a + b, 0)
        if (room.controller != undefined && !room.controller.safeMode && enemyList.length > 0 && damage > 1000) {
            const enemyGroup = analyzeEnemyGroups(enemyList)

            const flagName = roomName + '_T2ATT_0'
            const pcList = enemyList.filter(enemy => enemy['powers'] != undefined)
            if (pcList.length > 0 && Game.time % 5 == 0) {
                pcList[0].pos.createFlag(flagName)
            }
            if (damage > 7000 && Game.time % 5 == 0) {
                enemyList[0].pos.createFlag(flagName)
            }

            if (Game.flags[flagName]) {
                if (pcList.length > 0) Game.flags[flagName].setPosition(pcList[0].pos)
                else if (enemyList.length > 0) Game.flags[flagName].setPosition(enemyList[0].pos)
            }

            for (let i = 0; i < enemyGroup.length; i++) {
                let enemyAttackCount: number = 0
                let enemyRangeCount: number = 0
                let enemyHealCount: number = 0
                let enemyWorkCount: number = 0

                enemyGroup[i].forEach(enemy => {
                    enemy.body.map(b => b.type).forEach(body => {
                        if (body == WORK) enemyWorkCount += 1
                        if (body == HEAL) enemyHealCount += 1
                        if (body == ATTACK) enemyAttackCount += 1
                        if (body == RANGED_ATTACK) enemyRangeCount += 1
                    })
                })

                // 有红球或者黄球，则每个分组出一个红球
                if (enemyWorkCount > 0 || enemyAttackCount > 0 || enemyRangeCount > 0) {
                    const memory: DefenderData = { targetEnemy: enemyGroup[i][0].id }
                    const dCreepName = room.name + '_DEFENDER_' + i
                    const creepNameHash = addCreepConfig(room, roleWarEnum.DEFENDER, dCreepName, memory);
                    if (Game.creeps[creepNameHash] != undefined && Game.creeps[Game.creeps[creepNameHash].memory.data['targetEnemy']] == undefined) {
                        Game.creeps[creepNameHash].memory.data['targetEnemy'] = enemyGroup[i][0].id
                    }
                }

                // 有蓝球就出一个蓝球
                // if (enemyRangeCount > 0) {
                //     const memory: DefenderData = { targetEnemy: enemyGroup[i][0].id }
                //     const rCreepName = room.name + '_RDEFENDER_' + i
                //     const creepNameHash = addCreepConfig(room, roleWarEnum.RDEFENDER, rCreepName, memory);
                //     if (Game.creeps[creepNameHash] != undefined && Game.creeps[Game.creeps[creepNameHash].memory.data['targetEnemy']] == undefined) {
                //         Game.creeps[creepNameHash].memory.data['targetEnemy'] = enemyGroup[i][0].id
                //     }
                // }
            }
        }

        // 发布拆墙大黄
        for (let i = 0; i < 20; i++) {
            const dismFlag = Game.flags[room.name + '_DIS' + i]
            if (dismFlag != undefined) {
                const dismFlagMemory: AttackerData = { targetFlag: dismFlag.name }
                const creepName = room.name + '_DIS_' + dismFlag.name
                addCreepConfig(room, roleWarEnum.DISMANTLER, creepName, dismFlagMemory);
            }
        }

        // 发布一体机小队
        for (let i = 0; i < 20; i++) {
            const flagName = room.name + '_T2INTE_' + i
            const targetFlag = Game.flags[flagName]
            if (targetFlag != undefined) {
                const creepName1 = room.name + '_T2INTEGRATE_' + flagName + '_1'
                const creepNameHash1 = addCreepConfig(room, roleWarEnum.INTEGRATE, creepName1, {}, true);

                const creepName2 = room.name + '_T2INTEGRATE_' + flagName + '_2'
                const creepNameHash2 = addCreepConfig(room, roleWarEnum.INTEGRATE, creepName2, {}, true);

                room.memory.teamConfig[flagName] = {
                    teamFlag: flagName, teamType: 'duo',
                    creepNameList: [creepNameHash1, creepNameHash2]
                }
            }
        }

        // 红球二人小队
        for (let i = 0; i < 20; i++) {
            const flagName = room.name + '_T2ATT_' + i
            const targetFlag = Game.flags[flagName]
            if (targetFlag != undefined) {
                const creepName1 = room.name + '_T2ATTACK_' + flagName
                const creepNameHash1 = addCreepConfig(room, roleWarEnum.ATTACKER, creepName1, {}, true);

                const creepName2 = room.name + '_T2HEAL_' + flagName
                const creepNameHash2 = addCreepConfig(room, roleWarEnum.HEALER, creepName2, {}, true);

                room.memory.teamConfig[flagName] = {
                    teamFlag: flagName, teamType: 'duo',
                    creepNameList: [creepNameHash1, creepNameHash2]
                }
            }
        }

        // 黄球二人小队
        for (let i = 0; i < 20; i++) {
            const flagName = room.name + '_T2DIS_' + i
            const targetFlag = Game.flags[flagName]
            if (targetFlag != undefined) {
                const creepName1 = room.name + '_T2DIS_' + flagName
                const creepNameHash1 = addCreepConfig(room, roleWarEnum.DISMANTLER, creepName1, {}, true);

                const creepName2 = room.name + '_T2HEAL_' + flagName
                const creepNameHash2 = addCreepConfig(room, roleWarEnum.HEALER, creepName2, {}, true);

                room.memory.teamConfig[flagName] = {
                    teamFlag: flagName, teamType: 'duo',
                    creepNameList: [creepNameHash1, creepNameHash2]
                }
            }
        }
    }
}

function orderCreepSpawnQueue(): void {
    for (let roomName in Game.rooms) {
        const room: Room = Game.rooms[roomName];
        if (!room.my) continue

        // 循环creepConfig，筛选出未孵化的creep，并按照优先级排序
        const creepConfigCache = room.memory.creepConfig
        var creepSpawnQueue = Object.keys(creepConfigCache)
            .filter(creepName => Game.creeps[creepName] == undefined)
            .sort((a, b) => creepConfigCache[a].spawnPriority - creepConfigCache[b].spawnPriority)

        if (creepSpawnQueue == undefined || creepSpawnQueue.length == 0) {
            room.memory.creepSpawnQueue = []
            continue
        }

        const fillers = Object.values(Game.creeps).filter(creep => creep.room.name == room.name && creep.memory.role == roleBaseEnum.FILLER)
        const harvesters = Object.values(Game.creeps).filter(creep => creep.room.name == room.name && creep.memory.role == roleBaseEnum.HARVESTER)

        // 如果有harvester，但是没有filler，则优先孵化一个对应的filler
        if (room.containers.length > 0 && fillers.length == 0 && harvesters.length > 0) {
            const container = room.containers.filter(container => container.store[RESOURCE_ENERGY] > 0)
            const highPriority = creepSpawnQueue.filter(creepName => creepConfigCache[creepName].role == roleBaseEnum.FILLER &&
                container.length > 0 && container[0].id == (creepConfigCache[creepName].data as FillerData).sourceId)[0]

            if (highPriority) {
                creepSpawnQueue = [highPriority, ...creepSpawnQueue.filter(creepName => creepName != highPriority)]
            }
        }

        // 如果没有harvester，则优先孵化一个对应的harvester
        if (harvesters.length == 0) {
            const highPriority = creepSpawnQueue.filter(creepName => creepConfigCache[creepName].role == roleBaseEnum.HARVESTER)[0]
            if (highPriority) {
                creepSpawnQueue = [highPriority, ...creepSpawnQueue.filter(creepName => creepName != highPriority)]
            }
        }
        room.memory.creepSpawnQueue = creepSpawnQueue
    }
}

/**
 * Creep 的数量控制器
 */
export const creepNumberController = function (): void {
    // 清除死亡的Creeps
    for (var name in Memory.creeps) {
        if (!Game.creeps[name]) {
            delete Memory.creeps[name];
        }
    }

    if (Game.time % 5 != 0) return

    // 重置发布配置
    Object.values(Game.rooms).forEach(room => {
        if (room.my) room.memory.creepConfig = {}
    });

    // 发布基础需求配置
    releaseBaseCreepConfig()

    // 发布远程工作配置
    releaseJobsCreepConfig()

    // 发布战争相关配置
    releaseWarCreepConfig()

    // 优先级排序
    orderCreepSpawnQueue()
}

function callTower(target: Creep) {
    if (target.room.my && target.my && target.hits < target.hitsMax) {
        target.room.towers[0].heal(target)
        return
    }
}

/**
 * Creep 的工作控制器
 */
export const creepWorkController = function (): void {
    // Creeps执行工作
    var workCpu: [string, number][] = []
    Object.values(Game.creeps).forEach(creep => {
        if (creep.spawning) return
        if (creep.memory.isTeam) return
        if (Object.values(Memory.warMode).filter(warMode => warMode).length > 0 && !warModeRole.includes(creep.memory.role)) return

        const cpu = Game.cpu.getUsed()
        if (creep.memory.role == undefined) return
        const prepared = roles[creep.memory.role](creep.memory.data).prepare(creep)
        workCpu.push([creep.name + ' prepare', (Game.cpu.getUsed() - cpu)])
        if (!prepared) return

        if (creep.room.my && creep.hits < creep.hitsMax) {
            callTower(creep)
        }

        if (creep.memory.working) {
            const cpu = Game.cpu.getUsed()
            roles[creep.memory.role](creep.memory.data).target(creep)
            workCpu.push([creep.name + ' target', (Game.cpu.getUsed() - cpu)])
        } else {
            const cpu = Game.cpu.getUsed()
            roles[creep.memory.role](creep.memory.data).source(creep)
            workCpu.push([creep.name + ' source', (Game.cpu.getUsed() - cpu)])
        }
    });

    // Debug信息
    const debug = false && Game.shard.name == 'shard3'
    if (debug) {
        workCpu = workCpu.sort((a, b) => b[1] - a[1])
        for (let role in Object.keys(workCpu)) {
            if (workCpu[role][1] > 0.8) {
                console.log(workCpu[role][1], workCpu[role][0])
            }
        }
    }
}

/**
 * 小队执行工作
 */
export const teamWorkController = function (): void {
    for (const roomName in Game.rooms) {
        const room: Room = Game.rooms[roomName];
        if (!room.my) continue;

        Object.values(room.memory.teamConfig).forEach(teamConfig => {
            if (squard[teamConfig.teamType](teamConfig).prepare()) {
                squard[teamConfig.teamType](teamConfig).doWork()
            }
        });
    }
}
