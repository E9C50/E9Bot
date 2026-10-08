import { defaultReserverSign } from "settings/room"
import { getDistance } from "utils"
import { rolePolicy } from "settings/rolePolicy"
import { isReserveFlagRoomSafe, resolveReserveFlag } from "creep/reserveFlags"
import { isRoomEvacuating } from "room/evacuationState"
import { runtimePolicy } from "settings/runtime"

function returnHome(creep: Creep, home: Room | undefined): void {
    creep.memory.dontPullMe = false
    const homeName = home?.name || creep.memory.spawnRoom
    if (!homeName || creep.room.name === homeName) return
    const destination = home?.storage || home?.spawns[0]
    creep.moveTo(destination || new RoomPosition(25, 25, homeName), { range: destination ? 3 : 20, reusePath: 20 })
}

/** Resolve every hook so moving or deleting a flag immediately changes the live worker. */
function reserveFlagTarget(creep: Creep, data: ReserverData): Flag | undefined {
    creep.memory.dontPullMe = false
    const home = Game.rooms[creep.memory.spawnRoom]
    const flag = home?.my && data.reserveFlag ? resolveReserveFlag(home, data.reserveFlag) : undefined
    if (!flag) { returnHome(creep, home); return }
    data.targetRoom = flag.pos.roomName
    const atWar = runtimePolicy.warModeScope === 'empire' ? Object.values(Memory.warMode || {}).some(Boolean) :
        Memory.warMode?.[home.name] || Memory.warMode?.[creep.room.name] || Memory.warMode?.[flag.pos.roomName]
    const target = Game.rooms[flag.pos.roomName]
    if (atWar || isRoomEvacuating(home) || !isReserveFlagRoomSafe(creep.room) || (target && !isReserveFlagRoomSafe(target))) {
        returnHome(creep, home); return
    }
    return flag
}

function workReserveFlag(creep: Creep, data: ReserverData): boolean {
    const flag = reserveFlagTarget(creep, data)
    if (!flag) return true
    if (creep.room.name !== flag.pos.roomName) {
        creep.moveTo(new RoomPosition(25, 25, flag.pos.roomName), { range: 20, reusePath: 20 })
        return true
    }
    const controller = creep.room.controller
    if (!controller || controller.owner || controller.my) {
        returnHome(creep, Game.rooms[creep.memory.spawnRoom])
        return true
    }
    if (getDistance(creep.pos, controller.pos) > 1) {
        creep.moveTo(controller, { range: 1, reusePath: 20 })
        return true
    }
    const reservation = controller.reservation
    if (reservation && reservation.username !== creep.owner.username) {
        // reserveController would overwrite the attackController intent in the same tick.
        creep.attackController(controller)
        return true
    }
    if (!reservation || reservation.ticksToEnd < CONTROLLER_RESERVE_MAX) creep.reserveController(controller)
    if (controller.sign?.text !== defaultReserverSign) creep.signController(controller, defaultReserverSign)
    return true
}

export default (data: CreepData): ICreepConfig => ({
    isNeed: (room: Room, creepName: string) => {
        return true
    },
    prepare(creep) {
        if ((data as ReserverData).reserveFlag) return !creep.spawning && reserveFlagTarget(creep, data as ReserverData) !== undefined
        return true
    },
    source(creep) {
        if ((data as ReserverData).reserveFlag) {
            reserveFlagTarget(creep, data as ReserverData)
            creep.memory.working = true
            return true
        }
        creep.memory.working = true
        return true
    },
    target(creep) {
        if ((data as ReserverData).reserveFlag) return workReserveFlag(creep, data as ReserverData)
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
