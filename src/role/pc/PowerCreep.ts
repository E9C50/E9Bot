import { getDistance } from "utils";

export const powerSpawnController = function (): void {
    Object.values(Game.powerCreeps).forEach(pc => {
        const pcFlagName = 'PC_' + pc.name
        const pcFlag = Game.flags[pcFlagName]
        if (pcFlag == undefined) return

        const pcFlagTargetRoom = Game.rooms[pcFlag.pos.roomName]

        // 如果不存在，且插旗房间有powerSpawn，就生成
        if (pcFlag != undefined && pc.room == undefined) {
            if (pcFlagTargetRoom.powerSpawn == undefined) return
            pc.spawn(pcFlagTargetRoom.powerSpawn)
        }

        // 搓Ops
        if (pc.isPowerAvailable(PWR_GENERATE_OPS)) {
            pc.usePower(PWR_GENERATE_OPS)
        }

        if (pc.room == undefined) return

        // 不在指定房间，就过去
        if (pc.room.name != pcFlag.pos.roomName) {
            pc.moveTo(pcFlag, { swampCost: 1, plainCost: 1, visualizePathStyle: {} })
            return
        }

        // 快死了就续命
        pc.memory.needRenew = pc.memory.needRenew || (pc.ticksToLive != undefined && pc.ticksToLive <= 500)
        if (pc.memory.needRenew) {
            const powerTarget = pc.room.powerSpawn || pc.room.powerBanks[0]
            if (getDistance(pc.pos, powerTarget.pos) > 1) {
                pc.moveTo(powerTarget)
            } else {
                pc.renew(powerTarget)
            }
            if (pc.ticksToLive != undefined && pc.ticksToLive >= 4900) {
                pc.memory.needRenew = false
            }
            return
        }

        // Storage扩容技能
        if (pc.isPowerAvailable(PWR_OPERATE_STORAGE)) {
            if (pc.room.storage != undefined) {
                if (pc.room.storage.effects == undefined || pc.room.storage.effects.length == 0 || pc.room.storage.effects[0].ticksRemaining < 10) {
                    if (getDistance(pc.pos, pc.room.storage.pos) >= 3) {
                        pc.moveTo(pc.room.storage)
                        return
                    }
                    pc.usePower(PWR_OPERATE_STORAGE, pc.room.storage)
                    return
                }
            }
        }

        // OPS没了就去拿
        if (pc.store[RESOURCE_OPS] <= 200 && pc.isRoomHaveOps()) {
            pc.takeOps()
            return
        }

        // OPS满了就放下一部分
        if (pc.store.getFreeCapacity() < 10 && pc.room.my) {
            pc.saveOps()
            return
        }

        // 有敌人不出去点矿和source
        const warMode = pc.room.memory.npcTarget != undefined && Game.getObjectById(pc.room.memory.npcTarget) != undefined && Memory.warMode[pc.room.name]

        // 元素矿重生技能
        if (pc.isPowerAvailable(PWR_REGEN_MINERAL) && !warMode) {
            if (pc.room.mineral != undefined && pc.room.mineral.mineralAmount > 0) {
                if (getDistance(pc.pos, pc.room.mineral.pos) >= 3) {
                    pc.moveTo(pc.room.mineral)
                    return
                }
                pc.usePower(PWR_REGEN_MINERAL, pc.room.mineral)
                return
            }
        }

        // Source重生技能
        if (pc.isPowerAvailable(PWR_REGEN_SOURCE) && !warMode) {
            for (let index in pc.room.sources) {
                if ((pc.room.sources[index].effects == undefined || pc.room.sources[index].effects.length == 0) && pc.room.sources[index].energy > 0) {
                    if (getDistance(pc.pos, pc.room.sources[index].pos) >= 3) {
                        pc.moveTo(pc.room.sources[index])
                        return
                    }
                    pc.usePower(PWR_REGEN_SOURCE, pc.room.sources[index])
                    return
                }
            }
        }

        if (pcFlag.color == COLOR_RED) {
            if (!pc.pos.isEqualTo(pcFlag.pos)) pc.moveTo(pcFlag)
            return
        }

        // Terminal技能
        if (pc.isPowerAvailable(PWR_OPERATE_TERMINAL) && Object.keys(pc.room.memory.terminalSendJob).length > 0) {
            if (pc.room.terminal != undefined) {
                if (pc.room.terminal.effects == undefined || pc.room.terminal.effects.length == 0 || pc.room.terminal.effects[0].ticksRemaining < 10) {
                    if (getDistance(pc.pos, pc.room.terminal.pos) >= 3) {
                        pc.moveTo(pc.room.terminal)
                        return
                    }
                    pc.usePower(PWR_OPERATE_TERMINAL, pc.room.terminal)
                    return
                }
            }
        }

        // Spawn加速技能
        const opSpawnFlag = Game.flags[pc.room.name + '_OPSPAWN']
        if (opSpawnFlag && opSpawnFlag.color == COLOR_GREEN && pc.isPowerAvailable(PWR_OPERATE_SPAWN)) {
            for (let index in pc.room.spawns) {
                if (pc.room.spawns[index].effects == undefined || pc.room.spawns[index].effects.length == 0) {
                    if (getDistance(pc.pos, pc.room.spawns[index].pos) >= 3) {
                        pc.moveTo(pc.room.spawns[index])
                        return
                    }
                    pc.usePower(PWR_OPERATE_SPAWN, pc.room.spawns[index])
                    return
                }
            }
        }

        // Extension填充技能
        if (opSpawnFlag && opSpawnFlag.color == COLOR_GREEN && pc.isPowerAvailable(PWR_OPERATE_EXTENSION)) {
            if (pc.room.energyAvailable < (pc.room.energyCapacityAvailable * 0.6)) {
                if (pc.room.storage != undefined && pc.room.storage.store[RESOURCE_ENERGY] > 0) {
                    if (getDistance(pc.pos, pc.room.storage.pos) >= 3) {
                        pc.moveTo(pc.room.storage)
                        return
                    }
                    pc.usePower(PWR_OPERATE_EXTENSION, pc.room.storage)
                    return
                }
                if (pc.room.terminal != undefined && pc.room.terminal.store[RESOURCE_ENERGY] > 0) {
                    if (getDistance(pc.pos, pc.room.terminal.pos) >= 3) {
                        pc.moveTo(pc.room.terminal)
                        return
                    }
                    pc.usePower(PWR_OPERATE_EXTENSION, pc.room.terminal)
                    return
                }
            }
        }

        // // PowerSpawn加速技能
        // if (pc.isPowerAvailable(PWR_OPERATE_POWER)) {
        //     if (pc.room.powerSpawn != undefined) {
        //         if (getDistance(pc.pos, pc.room.powerSpawn.pos) >= 3) {
        //             pc.moveTo(pc.room.powerSpawn)
        //             return
        //         }
        //         pc.usePower(PWR_OPERATE_POWER, pc.room.powerSpawn)
        //         return
        //     }
        // }

        // // Lab加速技能
        // if (pc.isPowerAvailable(PWR_OPERATE_LAB)) {
        //     for (let index in pc.room.labs) {
        //         if (pc.room.labs[index].effects == undefined || pc.room.labs[index].effects.length == 0) {
        //             if (getDistance(pc.pos, pc.room.labs[index].pos) >= 3) {
        //                 pc.moveTo(pc.room.labs[index])
        //                 return
        //             }
        //             pc.usePower(PWR_OPERATE_LAB, pc.room.labs[index])
        //             return
        //         }
        //     }
        // }

        // Tower加成技能
        // if (pc.isPowerAvailable(PWR_OPERATE_TOWER)) {
        //     for (let index in pc.room.towers) {
        //         if (Memory.warMode[pc.room.name] && (pc.room.towers[index].effects == undefined || pc.room.towers[index].effects.length == 0)) {
        //             if (getDistance(pc.pos, pc.room.towers[index].pos) >= 3) {
        //                 pc.moveTo(pc.room.towers[index])
        //                 return
        //             }
        //             pc.usePower(PWR_OPERATE_TOWER, pc.room.towers[index])
        //             return
        //         }
        //     }
        // }

        // 如果旗子位置是controller，就开启power
        if (pc.room.controller != undefined && getDistance(pc.pos, pc.room.controller.pos) == 1) {
            if (pcFlag.pos.lookFor(LOOK_STRUCTURES).filter(stru => stru.structureType == STRUCTURE_CONTROLLER).length > 0) {
                pc.enableRoom(pc.room.controller)
                return
            }
        }

        // 如果旗子位置是factory，就设置工厂等级
        if (pc.room.factory != undefined && getDistance(pc.pos, pc.room.factory.pos) == 1) {
            if (pcFlag.pos.lookFor(LOOK_STRUCTURES).filter(stru => stru.structureType == STRUCTURE_FACTORY).length > 0) {
                pc.usePower(PWR_OPERATE_FACTORY, pc.room.factory)
                return
            }
        }

        // 没有可用技能就去旗子等
        if (!pc.pos.isEqualTo(pcFlag.pos)) {
            pc.moveTo(pcFlag)
            return
        }
    });
}
