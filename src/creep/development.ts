import { developmentPolicy } from 'settings/development'

/** 显式的房间阶段边界，满级房间在访问任何发展状态之前退出。 */
export function isDevelopingRoom(room: Room | undefined): boolean {
    const level = room?.controller?.level
    return room !== undefined && room.controller?.my === true && level !== undefined &&
        level >= developmentPolicy.minimumLevel && level <= developmentPolicy.maximumLevel &&
        developmentPolicy.enabled && room.memory.fastUpgrade !== false
}

/** A living body cannot shrink: spread its WORK intents over ticks to honor a reduced budget. */
export function developmentWorkAllowed(creep: Creep): boolean {
    if (!isDevelopingRoom(creep.room)) return true
    const profile = creep.room.memory.creepConfig?.[creep.name]?.development
    // Legacy upgraders keep their paid-for behaviour; automatically spawned large bodies honor their income budget.
    if (creep.memory.role === 'upgrader' && !creep.memory.development?.fullBody) return true
    const quota = profile?.workParts
    if (!Number.isFinite(quota)) return true
    if ((quota as number) <= 0) return !creep.memory.development?.fullBody
    const work = creep.getActiveBodyparts(WORK)
    const allowed = Math.floor(quota as number)
    if (work <= allowed || work === 0) return true
    // A fixed name offset distributes large consumers without writing credits to Memory.
    let offset = 0
    for (let index = 0; index < creep.name.length; index++) offset = (offset + creep.name.charCodeAt(index)) % work
    return (((Game.time + offset) % work) * allowed) % work < allowed
}
