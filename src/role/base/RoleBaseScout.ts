import { defaultReserverSign } from "settings/room"
import { rolePolicy } from "settings/rolePolicy"
import { populationPolicy } from 'settings/population'

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
        const creepData: ScoutData = data as ScoutData

        // 优先去标点位置
        const targetFlag = Game.flags[creepData.targetFlag]

        // A dedicated OUT scout belongs to this one remote; other OUT flags must wait for admission.
        if (/^[WE]\d+[NS]\d+_OUT\d+$/.test(creepData.targetFlag)) {
            creep.memory.dontPullMe = false
            // OUT marks a room, including flags on impassable border walls.
            // Stay inside that room to retain vision without occupying an exit.
            if (targetFlag) {
                const interior = new RoomPosition(25, 25, targetFlag.pos.roomName)
                if (!creep.pos.inRangeTo(interior, 20)) creep.moveTo(interior, { range: 20, reusePath: 20 })
            }
            return true
        }

        if (targetFlag != undefined && !creep.pos.isEqualTo(targetFlag.pos)) {
            creep.moveTo(targetFlag)

            if (creep.room.controller && targetFlag.pos.isEqualTo(creep.room.controller)
                && creep.pos.isNearTo(creep.room.controller) && creep.room.controller.sign?.username != creep.owner.username) {
                creep.signController(creep.room.controller, defaultReserverSign)
            }
            return true
        }

        // 没有标点位置就检查没有视野的外矿，去探路
        for (let i = 0; i < populationPolicy.maximumRemoteRooms; i++) {
            const flag = Game.flags[creep.memory.spawnRoom + '_OUT' + i]
            if (flag == undefined) continue
            if (Game.rooms[flag.pos.roomName] == undefined) {
                creep.moveTo(new RoomPosition(25, 25, flag.pos.roomName))
                return true
            }

            const myCreeps = Game.rooms[flag.pos.roomName].find(FIND_MY_CREEPS)
            if (myCreeps.length == 0 || (myCreeps.length == 1 && myCreeps[0].id == creep.id)) {
                creep.moveTo(flag.pos.x, flag.pos.y, { range: rolePolicy.scout.flagApproachRange })
                return true
            }
        }

        return true
    },
})
