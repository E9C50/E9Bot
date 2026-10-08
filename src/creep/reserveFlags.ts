import { hasRemoteHomeEconomy } from './remoteHomeEconomy'
import { isRoomEvacuating } from 'room/evacuationState'
import { populationPolicy } from 'settings/population'
import { runtimePolicy } from 'settings/runtime'

function ordinaryRoom(name: string): boolean {
    const match = /^[WE](\d+)[NS](\d+)$/.exec(name)
    if (!match) return false
    const x = Number(match[1]) % 10, y = Number(match[2]) % 10
    return x !== 0 && y !== 0 && !(x >= 4 && x <= 6 && y >= 4 && y <= 6)
}
/** Resolve from the current flag position, including rooms without vision. */
export function resolveReserveFlag(home: Room, flagName: string): Flag | undefined {
    if (!home || home.controller?.my !== true) return undefined
    const prefix = `${home.name}_RESERVE`
    if (typeof flagName !== 'string' || !flagName.startsWith(prefix)) return undefined
    const index = flagName.slice(prefix.length)
    if (!/^(0|[1-9]\d*)$/.test(index) || Number(index) >= populationPolicy.maximumJobFlags) return undefined
    const flag = Game.flags?.[flagName], target = flag?.pos.roomName
    if (!flag || !target || target === home.name || !ordinaryRoom(target)) return undefined
    const visible = Game.rooms[target]
    if (visible && (!visible.controller || visible.controller.owner)) return undefined
    for (let i = 0; i < Number(index); i++)
        if (Game.flags?.[`${home.name}_RESERVE${i}`]?.pos.roomName === target) return undefined
    return flag
}
export function getReserveFlagForRoom(home: Room, targetRoom: string): Flag | undefined {
    for (let i = 0; i < populationPolicy.maximumJobFlags; i++) {
        const flag = resolveReserveFlag(home, `${home.name}_RESERVE${i}`)
        if (flag?.pos.roomName === targetRoom) return flag
    }
    return undefined
}
function homeReady(home: Room): boolean {
    const atWar = runtimePolicy.warModeScope === 'empire' ? Object.values(Memory.warMode || {}).some(Boolean) : Memory.warMode?.[home.name]
    return home.controller?.my === true && home.spawns?.length > 0 && !atWar && !isRoomEvacuating(home) &&
        !home.enemies?.length && home.energyCapacityAvailable >= populationPolicy.remote.minimumReserveCapacity && hasRemoteHomeEconomy(home)
}
export function isReserveFlagRoomSafe(room: Room): boolean {
    return !Memory.warMode?.[room.name] && !isRoomEvacuating(room) &&
        !(room.enemies || room.find(FIND_HOSTILE_CREEPS)).length &&
        !room.find(FIND_HOSTILE_STRUCTURES).some(structure => structure.structureType === STRUCTURE_INVADER_CORE ||
            structure.structureType === STRUCTURE_KEEPER_LAIR || structure.structureType === STRUCTURE_TOWER)
}
export function reserveFlagSpawnAllowed(home: Room, data: ReserverData): boolean {
    const flag = data.reserveFlag && resolveReserveFlag(home, data.reserveFlag)
    if (!flag || flag.pos.roomName !== data.targetRoom || !homeReady(home)) return false
    const target = Game.rooms[flag.pos.roomName]
    return !target || isReserveFlagRoomSafe(target)
}
