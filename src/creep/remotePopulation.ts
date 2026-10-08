import { bodyConfigs, roleAdvEnum, roleBaseEnum } from 'settings/creep'
import { populationPolicy } from 'settings/population'
import { addCreepConfig, createCreepName } from './demand'
import { isRoomEvacuating } from 'room/evacuationState'
import { getRemoteCommissioningSources, remoteCommissioningDecision } from './remoteCommissioning'
import { hasRemoteHomeEconomy } from './remoteHomeEconomy'

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

        // Keep every commissioned mine maintained, but admit only one new mine at a time.
        const seen = new Set<string>(), remotes: Array<{ flag: Flag; target?: Room;
            sources: Array<{ id: string; x: number; y: number }>; decision: ReturnType<typeof remoteCommissioningDecision> }> = []
        const localReady = hasRemoteHomeEconomy(room)
        for (let i = 0; localReady && i < populationPolicy.maximumRemoteRooms; i++) {
            const flag = Game.flags[room.name + '_OUT' + i]
            if (!flag || seen.has(flag.pos.roomName) || room.spawns.length === 0) continue
            seen.add(flag.pos.roomName)
            const target = Game.rooms[flag.pos.roomName]
            const visible = target?.sources?.map(source => ({ id: source.id, x: source.pos.x, y: source.pos.y }))
            const known = visible || getRemoteCommissioningSources(room, flag.pos.roomName)
            const haulerCounts: Record<string, number> = {}
            for (const source of known) haulerCounts[source.id] = 1
            const decision = remoteCommissioningDecision(room, flag.pos.roomName, visible, {
                kind: 'manual', reserveRequired: room.level > populationPolicy.remote.reserveAfterLevel,
                haulerCounts, planningComplete: true,
            })
            if (!decision.admitted) continue
            remotes.push({ flag, target, sources: getRemoteCommissioningSources(room, flag.pos.roomName), decision })
        }

        // One dedicated scout follows the admitted OUT flag, independently of the user's SCOUT command.
        const unseen = remotes.filter(remote => remote.target?.sources === undefined)
        const scouting = unseen.find(remote => !remote.decision.maintenance) || unseen[0]
        if (scouting) {
            const data: ScoutData = { targetFlag: scouting.flag.name }
            const name = addCreepConfig(room, roleBaseEnum.SCOUT, `${room.name}_OUT_SCOUT`, data)
            if (room.memory.creepConfig[name]) room.memory.creepConfig[name].spawnPriority = populationPolicy.remote.startupPriorities.scout
            if (Game.creeps[name]) Game.creeps[name].memory.data = data
        }

        let builderPublished = false
        for (const { flag, target, sources, decision } of remotes) {
            const priority = populationPolicy.remote.startupPriorities
            // Reserving depends on a room name, never on Source visibility. The full native body waits for 650 energy.
            if (room.level > populationPolicy.remote.reserveAfterLevel &&
                room.energyCapacityAvailable >= populationPolicy.remote.minimumReserveCapacity) {
                const name = addCreepConfig(room, roleAdvEnum.RESERVER, `${room.name}_RESERVER_${flag.pos.roomName}`, {
                    targetRoom: flag.pos.roomName,
                } as ReserverData)
                const config = room.memory.creepConfig[name]
                if (config) {
                    config.spawnPriority = decision.maintenance ? priority.maintenance : priority.reserver
                    config.bodyProfile = { boostTier: 0, terrain: 'plain' }
                }
            }
            const mining = decision.maintenance || ['mining', 'hauling', 'ready'].includes(decision.phase)
            const hauling = decision.maintenance || ['hauling', 'ready'].includes(decision.phase)
            if (hauling && !builderPublished && target?.sources?.length &&
                (target.constructionSites.length > 0 || target.roads.some(road =>
                    road.hits < road.hitsMax * populationPolicy.remote.roadRepairRatio))) {
                const logicalName = `${room.name}_OSBUILDER_${room.name}`
                const data: RemoteBuilderData = { sourceFlag: target.sources[0].id, targetFlag: target.sources[0].id }
                const live = Game.creeps[createCreepName(roleAdvEnum.RBUILDER, logicalName)]
                if (live && room.storage && room.storage.store[RESOURCE_ENERGY] > populationPolicy.remote.builderStorageEnergy)
                    data.sourceFlag = room.storage.id
                const name = addCreepConfig(room, roleAdvEnum.RBUILDER, logicalName, data)
                if (Game.creeps[name]) Game.creeps[name].memory.data = data
                builderPublished = true
            }
            for (const source of sources) {
                if (mining) {
                    const name = addCreepConfig(room, roleAdvEnum.RHARVESTER, `${room.name}_RHARVESTER_${source.id}`, {
                        sourceId: source.id, targetRoom: flag.pos.roomName,
                    } as RemoteHarvesterData)
                    if (room.memory.creepConfig[name]) room.memory.creepConfig[name].spawnPriority = decision.maintenance ? priority.maintenance : priority.harvester
                }
                if (hauling) {
                    const name = addCreepConfig(room, roleAdvEnum.RFILLER, `${room.name}_RFILLER_${source.id}_${room.spawns[0].id}`, {
                        sourceFlag: source.id, targetFlag: room.spawns[0].id,
                    } as RemoteFillerData)
                    if (room.memory.creepConfig[name]) room.memory.creepConfig[name].spawnPriority = decision.maintenance ? priority.maintenance : priority.hauler
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
