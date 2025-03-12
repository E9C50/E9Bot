import { boostBodyPart, boostConfig, roleBoostConfig } from "settings/boost"
import { reactionConfig, reactionSource } from "settings/labs"
import { baseLayout } from "settings/layout"
import { defaultAutoResource, roomSignTextList } from "settings/room"

/**
 * 自动更新反应配置
 * @param room
 * @returns
 */
function updateLabReactionConfig(room: Room): void {
    if (Game.time % 10 != 0) return
    if (room.labs.length == 0) return
    // 如果房间没有配置好两个sourceLab，就跳过
    if (room.memory.roomLabConfig.sourceLab1 == undefined || room.memory.roomLabConfig.sourceLab2 == undefined) return

    const lab1 = Game.getObjectById<StructureLab>(room.memory.roomLabConfig.sourceLab1)
    const lab2 = Game.getObjectById<StructureLab>(room.memory.roomLabConfig.sourceLab2)

    const labReactionConfig = room.memory.roomLabConfig.labReactionConfig

    // source lab 还有资源就不更新
    // if (lab1 && lab1.mineralType && lab1.store[lab1.mineralType] > 20 &&
    //     lab2 && lab2.mineralType && lab2.store[lab1.mineralType] > 20 &&
    //     labReactionConfig && room.getResource(labReactionConfig) < reactionConfig[labReactionConfig]
    // ) return

    // 检查当前合成配置的原料是否足够，目标数量是否已完成
    if (labReactionConfig != undefined) {
        const labReactionSource = reactionSource[labReactionConfig]
        const source1Amount = room.getResource(labReactionSource[0], true, false, true, true)
        const source2Amount = room.getResource(labReactionSource[1], true, false, true, true)
        const targetNotEnough = room.getResource(labReactionConfig) < reactionConfig[labReactionConfig]
        if (targetNotEnough && source1Amount > 1000 && source2Amount > 1000) return
    }

    // 不够就更新合成配方
    for (let config in reactionConfig) {
        const resourceType = config as ResourceConstant
        if (room.getResource(resourceType, true, false, true, true) >= reactionConfig[config]) continue
        const labReactionSource = reactionSource[resourceType]
        const source1Amount = room.getResource(labReactionSource[0], true, false, true, true)
        const source2Amount = room.getResource(labReactionSource[1], true, false, true, true)
        if (source1Amount > 1000 && source2Amount > 1000) {
            room.memory.roomLabConfig.labReactionConfig = resourceType
            console.log(`${room.name} notify_Lab合成配置更新：${room.memory.roomLabConfig.labReactionConfig}`)
            return
        }
    }
    room.memory.roomLabConfig.labReactionConfig = 'XLH2O'
}

function updateLabBoostConfig(room: Room): void {
    if (Game.time % 10 != 0) return
    if (room.labs.length == 0) return
    const labConfig = room.memory.roomLabConfig

    // 根据当前creep需求配置，获取需要boost的资源
    Object.values(Game.creeps).forEach(creep => {
        if (creep.room.name != room.name) return
        let boostList = roleBoostConfig[creep.memory.role]
        if (boostList == undefined) return
        boostList = boostList.filter(boostType =>
            creep.body.filter(body => body.type == boostBodyPart[boostType] && !body.boost).length > 0
        )

        boostList.forEach(boostType => {
            const boostRes = boostConfig[boostType][2]
            if (!room.memory.boostNeed[boostRes]) {
                room.memory.boostNeed[boostRes] = 0
            }
            const needBoostPartCount = creep.body.filter(body => !body.boost && body.type == boostBodyPart[boostType]).length
            room.memory.boostNeed[boostRes] += needBoostPartCount * 30
        })
    });

    // 分配给lab
    Object.keys(room.memory.boostNeed).forEach(boostResourceType => {
        const resourceType = boostResourceType as ResourceConstant
        const boostType = Object.keys(boostConfig).filter(config => boostConfig[config].includes(resourceType))[0] as BoostTypeConstant
        if (Object.values(labConfig.singleLabConfig).filter(config => config.boostType == boostType).length > 0) return

        if (room.getResource(resourceType) > 0) {
            const emptyLabId = room.labs.filter(lab =>
                lab.id != labConfig.sourceLab1 && lab.id != labConfig.sourceLab2 &&
                (labConfig.singleLabConfig[lab.id] == undefined || !labConfig.singleLabConfig[lab.id].boostMode)
            )[0]?.id
            if (emptyLabId == undefined) return

            labConfig.singleLabConfig[emptyLabId] = { resourceType: resourceType, boostMode: true, boostType: boostType }
        }
    });

    Object.keys(labConfig.singleLabConfig).forEach(keys => {
        const config = labConfig.singleLabConfig[keys]
        const boostType = Object.keys(room.memory.boostNeed).map(resType => Object.keys(boostConfig).filter(config => boostConfig[config].includes(resType))[0])
        if (!boostType.includes(config.boostType)) {
            delete labConfig.singleLabConfig[keys]
        }
    })
}

/**
 * 判断是否可作为基地中央，并返回沼泽位置数量
 * @param {*} terrain
 * @param {*} posx
 * @param {*} posy
 * @param {*} baseSize
 * @returns
 */
function canBeRoomCenter(terrain, posx, posy, baseSize) {
    const harfBaseSize = Math.floor(baseSize / 2);
    var swampCount = 0;
    for (let x = posx - harfBaseSize; x <= posx + harfBaseSize; x++) {
        for (let y = posy - harfBaseSize; y <= posy + harfBaseSize; y++) {
            if (x == 2 || y == 2 || x == 48 || y == 48 || terrain.get(x, y) === TERRAIN_MASK_WALL) {
                return [false, Infinity];
            }
            if (terrain.get(x, y) === TERRAIN_MASK_SWAMP) {
                swampCount += 1;
            }
        }
    }
    return [true, swampCount];
}

/**
 * 自动查找可作为基地中央的位置
 * @param room
 * @param baseSize
 * @returns
 */
function autoComputeCenterPos(room: Room, baseSize: number = 13) {
    const planFlag = Game.flags['planRoomCenter']
    if (planFlag == undefined || planFlag.pos.roomName != room.name) return

    const cpu = Game.cpu.getUsed()
    const terrain = room.getTerrain();
    var minSwamp = Infinity;
    var autoSelectCenter: RoomPosition | undefined = undefined;
    const ROOM_MAX_SIZE = 49;

    // 遍历所有地块
    for (let i = 0; i < ROOM_MAX_SIZE; i++) {
        for (let j = 0; j < ROOM_MAX_SIZE; j++) {
            const result = canBeRoomCenter(terrain, i, j, baseSize);
            const canBeCenter = result[0];
            const swampCount: number = result[1] as number
            if (canBeCenter) {
                if (swampCount < minSwamp) {
                    minSwamp = swampCount;
                    autoSelectCenter = new RoomPosition(i, j, room.name);
                }
                room.visual.text(swampCount.toString(), i, j, { align: 'center' });
            }
        }
    }

    console.log(room.name, '自动计算RoomCenter', Game.cpu.getUsed() - cpu)
    return autoSelectCenter;
}

/**
 * 检查控制器等级，自动规划
 * @param {*} room
 */
function releaseConstructionSite(room: Room): void {
    const planFlag = Game.flags['planRoomStructure']
    if (planFlag == undefined || planFlag.pos.roomName != room.name) return

    const roomCenter = room.memory.roomPosition.centerPos;
    if (!roomCenter) return

    // if (Game.time % 10 != 0) return
    // if (room.controller == undefined) return
    // if (room.level == 8 && (room.nuker != undefined || room.constructionSites.length > 0)) return
    // if (room.level < 8 && (room.controller.progress == 0 || room.controller.progress > 100)) return

    const cpu = Game.cpu.getUsed()

    for (let level in baseLayout) {
        if (room.level < parseInt(level)) {
            continue;
        }
        for (let index in baseLayout[level]) {
            const constructionPosList = baseLayout[level][index];
            for (let posIndex in constructionPosList) {
                const posOffset = constructionPosList[posIndex];
                const constructionPosX = roomCenter.x + posOffset[0];
                const constructionPosY = roomCenter.y + posOffset[1];
                const constructionPos = new RoomPosition(constructionPosX, constructionPosY, room.name);

                const constructionAtPos = constructionPos.lookFor(LOOK_CONSTRUCTION_SITES);
                const structureAtPos = constructionPos.lookFor(LOOK_STRUCTURES);
                const rampartAtPos = structureAtPos.filter(structure => structure.structureType == STRUCTURE_RAMPART);

                if (constructionAtPos.length == 0 && (structureAtPos.length == 0
                    || (index == STRUCTURE_RAMPART && rampartAtPos.length == 0))) {
                    constructionPos.createConstructionSite(index as BuildableStructureConstant);
                }
            }
        }
    }

    // Mineral上面发布Extractor
    if (room.level >= 6 && !room.extractor) {
        const mineralPos = room.mineral.pos;
        mineralPos.createConstructionSite(STRUCTURE_EXTRACTOR);
    }

    console.log(room.name, '自动放置建筑', Game.cpu.getUsed() - cpu)
}

/**
 * 初始化建筑相关信息
 * @param room
 */
function initialStructures(room: Room): void {
    [...room.towers, ...room.labs, ...room.spawns, ...room.links, room.powerSpawn, room.nuker].forEach(
        structure => {
            if (structure != undefined && typeof structure.init === 'function') {
                structure.init()
            }
        }
    )

    // 自动设置允许修理的塔
    if (room.memory.roomStructure.towerAllowRepair == undefined && room.towers.length > 0) {
        room.createFlag(room.towers[0].pos.x, room.towers[0].pos.y, 'repairTower')
    }
}

/**
 * 更新房间内敌人信息
 * @param room
 * @returns
 */
function findTowerEnemy(room: Room): void {
    if (Game.time % 5 != 0 && !Memory.warMode) return
    if (room.enemies.length == 0) {
        if (Memory.warMode[room.name]) {
            Memory.warMode[room.name] = false
        }
        return
    }

    // 筛选值得开启战争模式的Creeps
    const enemyList = room.enemies.filter(enemy => {
        const isNotNpc = enemy.owner.username != 'Invader' && enemy.owner.username != 'Source Keeper'
        const isAttacker = enemy.body.filter(body => body.type == 'attack' || body.type == 'ranged_attack' || body.type == 'work').length > 0
        return isNotNpc && isAttacker
    })

    if (enemyList.length > 0) {
        Memory.warMode[room.name] = true
        if (Game.time % 10 == 0) console.log(`notify_您的房间[${room.name}] 发现敌人 所有者[${room.enemies[0].owner.username}]`)
    }

    // 获取入侵者
    const npcList = room.enemies.filter(enemy => enemy.owner.username == 'Invader' || enemy.body.length == 1)
    if (npcList.length > 0) room.memory.npcTarget = npcList[0].id
}

// 终端资源自动平衡
function processTerminalResource(room: Room) {
    if (room.terminal == undefined) return
    const centerStorage = Memory.centerStorage

    // 终端默认留存资源
    room.memory.terminalAmount = {}
    room.memory.terminalAmount['energy'] = 50000

    // 终端发送任务
    for (let jobId in room.memory.terminalSendJob) {

        const sendTargetRoom = room.memory.terminalSendJob[jobId].targetRoom
        const resourceType = room.memory.terminalSendJob[jobId].resourceType
        let sendAmount = room.memory.terminalSendJob[jobId].amount
        if (room.memory.terminalAmount[resourceType] == undefined) room.memory.terminalAmount[resourceType] = 0
        room.memory.terminalAmount[resourceType] += sendAmount

        if (room.name == centerStorage && resourceType == RESOURCE_GHODIUM && room.getResource(RESOURCE_GHODIUM, true, true) <= 6000) continue

        if (room.terminal.store.getFreeCapacity() == 0 && room.terminal.store[resourceType] > 0) {
            sendAmount = room.terminal.store[resourceType]
        }

        sendAmount = Math.min(sendAmount, 100000)

        if (room.terminal.store[resourceType] >= sendAmount && room.terminal.cooldown == 0) {
            const result = room.terminal.send(resourceType, sendAmount, sendTargetRoom)
            if (result == OK) {
                // room.memory.terminalAmount[resourceType] -= sendAmount
                room.memory.terminalSendJob[jobId].amount -= sendAmount
                if (room.memory.terminalSendJob[jobId].amount <= 0) {
                    delete room.memory.terminalSendJob[jobId]
                }
                break;
            }
        }
    }

    // 以下操作都是非中央仓库房间，每100t处理一次
    if (room.level < 8) return
    if (Game.time % 100 != 0) return
    if (room.name == centerStorage) return

    // 把房间产的矿发到中央仓库
    const mineralAmount = room.getResource(room.mineral.mineralType, true, true)
    const mineralJobExists = Object.values(room.memory.terminalSendJob)
        .filter(job => job.resourceType == room.mineral.mineralType && job.targetRoom == centerStorage).length > 0
    if (mineralAmount > 10000 && !mineralJobExists) {
        room.sendResource(centerStorage, room.mineral.mineralType, mineralAmount - 10000)
        console.log(`[${room.name}] -> [${centerStorage}] ${room.mineral.mineralType} ${mineralAmount - 10000}`)
    }

    // 检查缺的资源，小于阈值80%，向中央仓库下单；多的矿，大于阈值20%发到中央仓库
    Object.keys(defaultAutoResource).forEach(resType => {
        const resourceType = resType as ResourceConstant
        if (room.getResource(resourceType, true, true) < (defaultAutoResource[resType] * 0.8)) {
            const jobExists = Object.values(Game.rooms[centerStorage].memory.terminalSendJob)
                .filter(job => job.resourceType == resType && job.targetRoom == room.name).length > 0
            const needAmount = defaultAutoResource[resType] - room.getResource(resourceType, true, true)
            const centerHaveRes = Game.rooms[centerStorage].getResource(resourceType, true, true) > (needAmount + defaultAutoResource[resType])

            if (centerHaveRes && !jobExists) {
                Game.rooms[centerStorage].sendResource(room.name, resourceType, needAmount)
                console.log(`[${centerStorage}] -> [${room.name}] ${resType} ${needAmount}`)
            }
        }

        if (room.getResource(resourceType, true, true) > (defaultAutoResource[resType] * 1.2)) {
            const jobExists = Object.values(room.memory.terminalSendJob)
                .filter(job => job.resourceType == resType && job.targetRoom == centerStorage).length > 0
            const sendAmount = room.getResource(resourceType, true, true) - defaultAutoResource[resType]

            if (!jobExists) {
                room.sendResource(centerStorage, resourceType, sendAmount)
                console.log(`[${room.name}] -> [${centerStorage}] ${resType} ${sendAmount}`)
            }
        }
    });
}

function updateRoomSign(room: Room) {
    if (room.memory.roomSignText == undefined) {
        const existsSigns = Object.values(Game.rooms).map(item => item.memory.roomSignText)
        const unusedSigns = roomSignTextList.filter(item => !existsSigns.includes(item));
        const randomIndex = Math.floor(Math.random() * unusedSigns.length);
        room.memory.roomSignText = unusedSigns[randomIndex]
    }
}

function repairStructure(room: Room) {
    if (room.towers.length == 0) return
    if (Memory.warMode[room.name]) return
    if (room.structuresNeedRepair.length == 0) return

    room.towers[0].repair(room.structuresNeedRepair[0])
}

function autoEnableSafeMode(room: Room) {
    const controller = room.controller
    if (controller == undefined) return
    if (controller.safeModeAvailable == 0) return
    if (controller.safeModeCooldown == undefined) return
    if (controller.safeModeCooldown > 0) return
    if (room.enemies.length == 0) return

    if (room.storage != undefined && room.storage.hits < room.storage.hitsMax) {
        controller.activateSafeMode()
        console.log(`notify_您的房间[${room.name}] [storage]受到攻击，安全模式已激活`)
        return
    }
    if (room.terminal != undefined && room.terminal.hits < room.terminal.hitsMax) {
        controller.activateSafeMode()
        console.log(`notify_您的房间[${room.name}] [terminal]受到攻击，安全模式已激活`)
        return
    }
    if (room.spawns.length == 1 && room.spawns[0].hits < room.spawns[0].hitsMax) {
        controller.activateSafeMode()
        console.log(`notify_您的房间[${room.name}] [spawns]受到攻击，安全模式已激活`)
        return
    }
}

function processFlagPos(flagName: string, memoryKey: string): void {
    if (Game.flags[flagName] != undefined) {
        const roomName = Game.flags[flagName].pos.roomName;
        Game.rooms[roomName].memory.roomPosition[memoryKey] = Game.flags[flagName].pos;
        Game.flags[flagName].remove();
    }

    // if (Game.time % 100 == 0) {
    //     for (let roomName in Game.rooms) {
    //         if (!Game.rooms[roomName].my) return
    //         if (Game.flags[flagName] == undefined && Game.rooms[roomName].memory.roomPosition[memoryKey] == undefined) {
    //             console.log(`房间 [${roomName}] 请放置旗帜 ${flagName} 用于设置 ${memoryKey} 位置`)
    //         }
    //     }
    // }
}

function processFlagStructure(): void {
    processFlagPos('managerPos', 'managerPos')
    processFlagPos('centerPos', 'centerPos')

    if (Game.flags['repairTower'] != undefined) {
        const roomName = Game.flags['repairTower'].pos.roomName;
        Game.rooms[roomName].memory.roomStructure['towerAllowRepair'] = Game.flags['repairTower'].pos.lookFor(LOOK_STRUCTURES)[0].id;
        Game.flags['repairTower'].remove();
    }

    if (Game.flags['lab1'] != undefined) {
        const roomName = Game.flags['lab1'].pos.roomName;
        Game.rooms[roomName].memory.roomLabConfig.sourceLab1 = Game.flags['lab1'].pos.lookFor(LOOK_STRUCTURES)[0].id;
        Game.flags['lab1'].remove();
    }

    if (Game.flags['lab2'] != undefined) {
        const roomName = Game.flags['lab2'].pos.roomName;
        Game.rooms[roomName].memory.roomLabConfig.sourceLab2 = Game.flags['lab2'].pos.lookFor(LOOK_STRUCTURES)[0].id;
        Game.flags['lab2'].remove();
    }
}

export const roomController = function (): void {
    // for (const roomName in Memory.rooms) {
    //     const room: Room = Game.rooms[roomName];
    //     if (room == undefined || !room.my) {
    //         delete Memory.rooms[roomName];
    //     }
    // }

    for (const roomName in Game.rooms) {
        const room: Room = Game.rooms[roomName];

        const updateFlag = Game.flags['updateCache']
        if (updateFlag != undefined && updateFlag.pos.roomName == roomName) {
            room.memory.needUpdateCache = true
            updateFlag.remove()
        }

        if (global[room.name] == undefined) global[room.name] = {}
        if (global[room.name].structureIdList == undefined) global[room.name].structureIdList = {}

        if (Memory.warMode == undefined) Memory.warMode = {}
        if (room.memory.roomLabConfig == undefined) room.memory.roomLabConfig = { singleLabConfig: {} }

        if (room.memory.terminalSendJob == undefined) room.memory.terminalSendJob = {}
        if (room.memory.terminalAmount == undefined) room.memory.terminalAmount = {}
        if (room.memory.roomStructure == undefined) room.memory.roomStructure = {}
        if (room.memory.restrictedPos == undefined) room.memory.restrictedPos = {}
        if (room.memory.roomPosition == undefined) room.memory.roomPosition = {}
        if (room.memory.roomFillJob == undefined) room.memory.roomFillJob = {}
        if (room.memory.teamConfig == undefined) room.memory.teamConfig = {}

        if (room.memory.roomFillJob.labInMineral == undefined) room.memory.roomFillJob.labInMineral = []

        room.memory.boostNeed = {}

        // 更新缓存
        if (room.memory.needUpdateCache) {
            global.BetterMove.deletePathInRoom(room.name)
            global[room.name].structureIdList = {}
            room.memory.needUpdateCache = false
            console.log('更新建筑缓存', roomName)
        }

        if (!room.my) continue

        const debug = false && Game.shard.name == 'shard3'
        var cpu = Game.cpu.getUsed()

        // 自动开启安全模式
        autoEnableSafeMode(room)

        if (debug && (Game.cpu.getUsed() - cpu) > 1) console.log(`自动开启安全模式 CPU 使用量：${(Game.cpu.getUsed() - cpu).toFixed(2)}`)
        cpu = Game.cpu.getUsed()

        // 处理房间内建筑相关旗子
        processFlagStructure()

        if (debug && (Game.cpu.getUsed() - cpu) > 1) console.log(`处理房间内建筑相关旗子 CPU 使用量：${(Game.cpu.getUsed() - cpu).toFixed(2)}`)
        cpu = Game.cpu.getUsed()

        // 自动计算RoomCenter
        autoComputeCenterPos(room)

        if (debug && (Game.cpu.getUsed() - cpu) > 1) console.log(`自动计算RoomCenter CPU 使用量：${(Game.cpu.getUsed() - cpu).toFixed(2)}`)
        cpu = Game.cpu.getUsed()

        // 自动规划
        releaseConstructionSite(room)

        if (debug && (Game.cpu.getUsed() - cpu) > 1) console.log(`自动规划 CPU 使用量：${(Game.cpu.getUsed() - cpu).toFixed(2)}`)
        cpu = Game.cpu.getUsed()

        // 处理资源平衡
        processTerminalResource(room)

        if (debug && (Game.cpu.getUsed() - cpu) > 1) console.log(`处理资源平衡 CPU 使用量：${(Game.cpu.getUsed() - cpu).toFixed(2)}`)
        cpu = Game.cpu.getUsed()

        // 更新LabBoost配置
        updateLabBoostConfig(room)

        if (debug && (Game.cpu.getUsed() - cpu) > 1) console.log(`更新LabBoost配置 CPU 使用量：${(Game.cpu.getUsed() - cpu).toFixed(2)}`)
        cpu = Game.cpu.getUsed()

        // 更新Lab反应配置
        updateLabReactionConfig(room)

        if (debug && (Game.cpu.getUsed() - cpu) > 1) console.log(`更新Lab反应配置 CPU 使用量：${(Game.cpu.getUsed() - cpu).toFixed(2)}`)
        cpu = Game.cpu.getUsed()

        // 初始化建筑相关
        initialStructures(room)

        if (debug && (Game.cpu.getUsed() - cpu) > 1) console.log(`初始化建筑相关 CPU 使用量：${(Game.cpu.getUsed() - cpu).toFixed(2)}`)
        cpu = Game.cpu.getUsed()

        // 建筑修理相关
        repairStructure(room)

        if (debug && (Game.cpu.getUsed() - cpu) > 1) console.log(`建筑修理相关 CPU 使用量：${(Game.cpu.getUsed() - cpu).toFixed(2)}`)
        cpu = Game.cpu.getUsed()

        // 更新房间内敌人信息
        findTowerEnemy(room)

        if (debug && (Game.cpu.getUsed() - cpu) > 1) console.log(`更新房间内敌人信息 CPU 使用量：${(Game.cpu.getUsed() - cpu).toFixed(2)}`)
        cpu = Game.cpu.getUsed()

        // 更新房间签名
        updateRoomSign(room)

        if (debug && (Game.cpu.getUsed() - cpu) > 1) console.log(`更新房间签名 CPU 使用量：${(Game.cpu.getUsed() - cpu).toFixed(2)}`)

        if (Game.time % 1000 == 0) room.getDefenderCostMatrix()
    }
}
