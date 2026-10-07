import { bodyConfigs, roleAdvEnum, roleBaseEnum, roleWarEnum } from 'settings/creep'
import { populationPolicy } from 'settings/population'
import { addCreepConfig } from './demand'
import { sha1String } from 'utils'
import { isRoomEvacuating } from 'room/evacuationState'

/** 新占领房还没有 Spawn 时，由最近的可支援房孵化自采能的 rBuilder。 */
export function releaseBootstrapBuilderConfig(): void {
    const policy = populationPolicy.bootstrap
    if (!policy.enabled || policy.remoteBuilderCount <= 0) return
    const minimumBodyCost = Math.min(...bodyConfigs[roleBaseEnum.BUILDER].map(body =>
        Object.keys(body).reduce((cost, part) =>
            cost + BODYPART_COST[part as BodyPartConstant] * (body[part] || 0), 0)
    ).filter(cost => cost > 0))
    const rooms = Object.values(Game.rooms)
    const homes = rooms.filter(room => room.my && !isRoomEvacuating(room) && room.spawns.length > 0 &&
        room.energyCapacityAvailable >= minimumBodyCost && !Memory.warMode?.[room.name])
    for (const target of rooms) {
        if (!target.my || isRoomEvacuating(target) || target.spawns.length > 0 || target.constructionSites.length == 0 ||
            target.sources.length == 0 || Memory.warMode?.[target.name]) continue
        const candidates = homes.map(home => ({
            home,
            distance: Game.map.getRoomLinearDistance(home.name, target.name),
        })).filter(candidate => candidate.distance <= policy.maxHomeDistance)
        candidates.sort((first, second) => first.distance - second.distance || first.home.name.localeCompare(second.home.name))
        const home = candidates[0]?.home
        if (home == undefined) continue
        for (let index = 0; index < policy.remoteBuilderCount; index++) {
            const source = target.sources[index % target.sources.length]
            const data: RemoteBuilderData = { sourceFlag: source.id, targetFlag: source.id, bootstrap: true }
            addCreepConfig(home, roleAdvEnum.RBUILDER, home.name + '_BOOTSTRAP_RBUILDER_' + target.name + '_' + index, data)
        }
    }
}

export function releaseJobsCreepConfig(): void {
    releaseBootstrapBuilderConfig()
    for (const roomName in Game.rooms) {
        const room: Room = Game.rooms[roomName]
        if (!room.my || isRoomEvacuating(room)) continue

        // 发布侦察兵
        if (Game.flags[room.name + '_SCOUT'] != undefined) {
            const creepMemory: ScoutData = { targetFlag: room.name + '_SCOUT' }
            const creepNameHarvester: string = room.name + '_SCOUT'
            addCreepConfig(
                room,
                roleBaseEnum.SCOUT,
                creepNameHarvester,
                creepMemory
            )
        }

        // 处理外矿房
        for (let i = 0; i < populationPolicy.maximumRemoteRooms; i++) {
            const flag = Game.flags[room.name + '_OUT' + i]
            // 如果房间不可见，先发布侦察兵
            if (flag != undefined && flag.room?.sources == undefined) {
                const creepMemory: ScoutData = {
                    targetFlag: room.name + '_SCOUT',
                }
                const creepNameHarvester: string = room.name + '_SCOUT'
                addCreepConfig(
                    room,
                    roleBaseEnum.SCOUT,
                    creepNameHarvester,
                    creepMemory
                )
            }

            if (
                flag != undefined &&
                flag.room?.sources != undefined &&
                flag.room.sources.length > 0
            ) {
                // 等级大于2级发布矿房预定者
                if (room.level > populationPolicy.remote.reserveAfterLevel) {
                    const reserverMemory: ReserverData = {
                        targetRoom: flag.pos.roomName,
                    }
                    const creepName =
                        room.name + '_RESERVER_' + flag.pos.roomName
                    addCreepConfig(
                        room,
                        roleAdvEnum.RESERVER,
                        creepName,
                        reserverMemory
                    )
                }

                // 如果外矿房有工地，或者需要修路，就发布远程修理工
                const targetOutRoom = Game.rooms[flag.pos.roomName]
                if (
                    targetOutRoom != undefined &&
                    (targetOutRoom.constructionSites.length > 0 ||
                        targetOutRoom.roads.filter(
                            (road) =>
                                road.hits <
                                road.hitsMax *
                                    populationPolicy.remote.roadRepairRatio
                        ).length > 0)
                ) {
                    const remoteBuilderMemory: RemoteBuilderData = {
                        sourceFlag: targetOutRoom.sources[0].id,
                        targetFlag: targetOutRoom.sources[0].id,
                    }
                    const creepName = room.name + '_OSBUILDER_' + room.name
                    const creep =
                        Game.creeps['OSBUILDER_' + sha1String(creepName)]
                    if (creep == undefined) {
                        addCreepConfig(
                            room,
                            roleAdvEnum.RBUILDER,
                            creepName,
                            remoteBuilderMemory
                        )
                    } else {
                        // 如果修理工已经发布，就更新他的工作目标
                        const creepData = creep.memory.data as RemoteBuilderData
                        if (
                            room.storage != undefined &&
                            room.storage.store[RESOURCE_ENERGY] >
                                populationPolicy.remote.builderStorageEnergy
                        ) {
                            creepData.sourceFlag = room.storage.id
                        } else {
                            creepData.sourceFlag = targetOutRoom.sources[0].id
                        }
                        creepData.targetFlag = targetOutRoom.sources[0].id
                    }
                }

                for (let index in flag.room.sources) {
                    const sourceId = flag.room.sources[index].id

                    if (room.spawns.length == 0) continue

                    // 发布外矿能量矿工
                    const creepMemory: RemoteHarvesterData = {
                        sourceId: sourceId,
                        targetRoom: flag.room.name,
                    }
                    const creepNameHarvester: string =
                        room.name + '_RHARVESTER_' + sourceId
                    addCreepConfig(
                        room,
                        roleAdvEnum.RHARVESTER,
                        creepNameHarvester,
                        creepMemory
                    )

                    // 发布外矿能量搬运工
                    const remoteFillerMemory: RemoteFillerData = {
                        sourceFlag: sourceId,
                        targetFlag: room.spawns[0].id,
                    }
                    const creepName =
                        room.name +
                        '_RFILLER_' +
                        sourceId +
                        '_' +
                        room.spawns[0].id
                    addCreepConfig(
                        room,
                        roleAdvEnum.RFILLER,
                        creepName,
                        remoteFillerMemory
                    )
                }
            }
        }

        // 发布外房搬运工
        for (let i = 0; i < populationPolicy.maximumJobFlags; i++) {
            const sourceFlag = Game.flags[room.name + '_RF_S' + i]
            const targetFlag = Game.flags[room.name + '_RF_T' + i]
            if (sourceFlag != undefined && targetFlag != undefined) {
                const remoteFillerMemory: RemoteFillerData = {
                    sourceFlag: room.name + '_RF_S' + i,
                    targetFlag: room.name + '_RF_T' + i,
                }
                const creepName =
                    room.name +
                    '_RFILLER_' +
                    room.name +
                    '_RF_S' +
                    i +
                    '_' +
                    room.name +
                    '_RF_T' +
                    i
                addCreepConfig(
                    room,
                    roleAdvEnum.RFILLER,
                    creepName,
                    remoteFillerMemory
                )
            }
        }

        // 发布外房Worker
        for (let i = 0; i < populationPolicy.maximumJobFlags; i++) {
            const sourceFlag = Game.flags[room.name + '_RB_S' + i]
            const targetFlag = Game.flags[room.name + '_RB_T' + i]
            if (sourceFlag != undefined && targetFlag != undefined) {
                const remoteBuilderMemory: RemoteBuilderData = {
                    sourceFlag: room.name + '_RB_S' + i,
                    targetFlag: room.name + '_RB_T' + i,
                }
                const creepName =
                    room.name +
                    '_RBUILDER_' +
                    room.name +
                    '_RB_S' +
                    i +
                    '_' +
                    room.name +
                    '_RB_T' +
                    i
                addCreepConfig(
                    room,
                    roleAdvEnum.RBUILDER,
                    creepName,
                    remoteBuilderMemory
                )
            }
        }

        // 发布新房占领
        const claimFlag = Game.flags[room.name + '_CLAIM']
        if (claimFlag != undefined && !(Game.rooms[claimFlag.pos.roomName] || claimFlag.room)?.my) {
            const claimerMemory: ClaimerData = { targetFlag: claimFlag.name }
            const creepName = room.name + '_CLAIMER_' + claimFlag.name
            addCreepConfig(room, roleAdvEnum.CLAIMER, creepName, claimerMemory)
        }

    }
}
