import { defaultReserverSign } from "settings/room"
import { getDistance } from "utils"
import { rolePolicy } from "settings/rolePolicy"

export default (data: CreepData): ICreepConfig => ({
    isNeed: (room: Room, creepName: string) => {
        return true
    },
    prepare(creep) {
        return true
    },
    source(creep) {
        creep.memory.working = true
        return true
    },
    target(creep) {
        const creepData: ReserverData = data as ReserverData

        // 不在目标房间就过去
        if (creep.room.name != creepData.targetRoom) {
            creep.moveTo(new RoomPosition(25, 25, creepData.targetRoom))
            return true
        }

        // 没找到控制器就摆烂
        if (creep.room.controller == undefined) {
            creep.say('❓')
            return false
        }

        // 不在旁边就过去
        if (getDistance(creep.pos, creep.room.controller.pos) > 1) {
            creep.moveTo(creep.room.controller)
            return true
        }

        const owner = creep.room.controller.owner
        const reservation = creep.room.controller.reservation

        // 已经有人控制或者预定，就干他
        if ((owner != undefined && owner.username != creep.owner.username) || (reservation != undefined && reservation.username != creep.owner.username)) {
            creep.attackController(creep.room.controller)
        }

        // 预定时间低于续订阈值就干活
        if (reservation == undefined || reservation.ticksToEnd < rolePolicy.reserver.renewBelowTicks) {
            creep.reserveController(creep.room.controller)
        }

        // 签名不一致就签名
        if (creep.room.controller.sign?.text != defaultReserverSign) {
            creep.signController(creep.room.controller, defaultReserverSign)
        }

        return true
    },
})
