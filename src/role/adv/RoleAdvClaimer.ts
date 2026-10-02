import { roomSignTextList } from "settings/room"
import { getDistance } from "utils"

export default (data: CreepData): ICreepConfig => ({
    isNeed: (room: Room, creepName: string) => {
        const targetFlag = Game.flags[(data as ClaimerData).targetFlag]
        if (targetFlag == undefined) return false
        return !(Game.rooms[targetFlag.pos.roomName] || targetFlag.room)?.my
    },
    prepare(creep) {
        return true
    },
    source(creep) {
        creep.memory.working = true
        return true
    },
    target(creep) {
        const creepData: ClaimerData = data as ClaimerData
        const targetFlag = Game.flags[creepData.targetFlag]
        if (targetFlag == undefined) return true

        // 不在目标房间就过去
        if (creep.room.name != targetFlag.pos.roomName) {
            creep.moveTo(targetFlag)
            return false
        }

        // 没找到控制器就摆烂
        if (creep.room.controller == undefined) {
            creep.say('❓')
            return false
        }

        // 不在控制器旁边就过去
        if (getDistance(creep.pos, creep.room.controller.pos) > 1) {
            creep.moveTo(creep.room.controller)
            return false
        }

        const owner = creep.room.controller.owner
        const reservation = creep.room.controller.reservation

        // 占领成功后保留人类旗帜，停止重复占领和孵化。
        if (!creep.room.controller.my) {
            // 已经有人控制或者预定，就干他
            if ((owner != undefined && owner.username != creep.owner.username) || (reservation != undefined && reservation.username != creep.owner.username)) {
                creep.attackController(creep.room.controller)
                return false
            }

            if (creep.claimController(creep.room.controller) != OK) return false
        }

        if (targetFlag.color != COLOR_PURPLE) return true

        // 设置新签名
        if (creep.room.memory.roomSignText == undefined) {
            const existsSigns = Object.values(Game.rooms).map(item => item.memory.roomSignText)
            const unusedSigns = roomSignTextList.filter(item => !existsSigns.includes(item));
            const randomIndex = Math.floor(Math.random() * unusedSigns.length);
            creep.room.memory.roomSignText = unusedSigns[randomIndex]
        }

        // 签名不一致就签名
        if (creep.room.memory.roomSignText != undefined && creep.room.controller.sign?.text != creep.room.memory.roomSignText) {
            creep.signController(creep.room.controller, creep.room.memory.roomSignText)
        }
        return true
    },
})
