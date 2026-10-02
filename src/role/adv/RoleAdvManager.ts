import { getDistance } from "utils"
import { rolePolicy } from "settings/rolePolicy"

export default (data: CreepData): ICreepConfig => ({
    isNeed: (room: Room, creepName: string) => {
        return room.storage != undefined && (room.centerLink != undefined || room.terminal != undefined)
    },
    prepare(creep) {
        // 如果不在目标位置则移动
        if (!creep.memory.ready || Game.time % rolePolicy.manager.positionCheckInterval == 0) {
            creep.memory.ready = false
            var managerPos: RoomPosition = creep.room.memory.roomPosition.managerPos as RoomPosition
            if (managerPos != undefined) {
                managerPos = new RoomPosition(managerPos.x, managerPos.y, managerPos.roomName)
                if (!creep.pos.isEqualTo(managerPos)) {
                    creep.moveTo(managerPos)
                    return false
                } else {
                    creep.memory.ready = true
                    return true
                }
            } else {
                if (creep.room.storage != undefined && getDistance(creep.pos, creep.room.storage.pos) > 1) {
                    creep.moveTo(creep.room.storage)
                    return false
                } else if (creep.room.centerLink != undefined && getDistance(creep.pos, creep.room.centerLink.pos) > 1) {
                    creep.moveTo(creep.room.centerLink)
                    return false
                } else if (creep.room.terminal != undefined && getDistance(creep.pos, creep.room.terminal.pos) > 1) {
                    creep.moveTo(creep.room.terminal)
                    return false
                } else {
                    creep.memory.ready = true
                    return true
                }
            }
        } else {
            return true
        }
    },
    source(creep) {
        creep.memory.working = true
        return true
    },
    target(creep) {
        creep.memory.dontPullMe = true;
        if (creep.room.memory.restrictedPos != undefined) {
            creep.room.memory.restrictedPos[creep.name] = creep.pos;
        }

        if (creep.room.storage == undefined) {
            return false
        }

        // if (creep.pickupDroppedResource(true, 1)) return true

        // 身上有东西就放到Storage
        if (creep.store.getUsedCapacity() > 0) {
            const resourceType = Object.keys(creep.store)[0] as ResourceConstant

            if (creep.room.memory.terminalAmount == undefined) creep.room.memory.terminalAmount = {}
            if (creep.room.terminal != undefined && creep.room.terminal.store[resourceType] < (creep.room.memory.terminalAmount[resourceType] || 0)) {
                creep.transfer(creep.room.terminal, resourceType);
            } else {
                creep.transfer(creep.room.storage, resourceType);
            }
            return true
        }

        // CenterLink有东西就拿起来
        if (creep.room.centerLink != undefined && creep.room.centerLink.store[RESOURCE_ENERGY] > 0) {
            creep.withdraw(creep.room.centerLink, RESOURCE_ENERGY);
            return true
        }

        // // factory有东西就拿起来
        // if (creep.room.factory && creep.room.factory.store[RESOURCE_ENERGY] > 0) {
        //     creep.withdraw(creep.room.factory, RESOURCE_ENERGY);
        //     return true
        // }

        // if (creep.room.factory && creep.room.factory.store.getFreeCapacity() > 20000
        //     && creep.room.storage && creep.room.storage.store[RESOURCE_BATTERY] > 0) {
        //     creep.withdraw(creep.room.storage, RESOURCE_BATTERY);
        //     return true
        // }

        // if (creep.room.factory != undefined && creep.room.factory.store.getUsedCapacity() > 0) {
        //     const resourceType = Object.keys(creep.room.factory.store)[0] as ResourceConstant
        //     creep.withdraw(creep.room.factory, resourceType);
        //     return true
        // }

        // 终端有东西就拿起来
        if (creep.room.terminal != undefined && creep.room.terminal.store.getUsedCapacity() > 0) {
            for (let resourceType in creep.room.terminal.store) {
                if (creep.room.terminal.store[resourceType] > (creep.room.memory.terminalAmount[resourceType] || 0)) {
                    var amount = Math.abs(creep.room.terminal.store[resourceType] - (creep.room.memory.terminalAmount[resourceType] || 0))
                    amount = Math.min(amount, creep.store.getFreeCapacity())
                    creep.withdraw(creep.room.terminal, resourceType as ResourceConstant, amount);
                    return true
                }
            }
        }

        // 终端东西不足就从storage拿
        if (creep.room.terminal != undefined) {
            for (let resourceType in creep.room.memory.terminalAmount) {
                if (creep.room.terminal.store[resourceType] < creep.room.memory.terminalAmount[resourceType] && creep.room.storage.store[resourceType] > 0) {
                    creep.withdraw(creep.room.storage, resourceType as ResourceConstant);
                    return true
                }
            }
        }

        return true
    },
})
