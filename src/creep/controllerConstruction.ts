import { isDevelopingRoom } from './development'
import { controllerLayoutPolicy } from 'settings/controllerLayout'
import { developmentPolicy } from 'settings/development'

let tick: number | undefined, shard: string | undefined
const rooms = new Map<string, { room: Room; sites: ConstructionSite[] }>()

function range(a: { x: number; y: number }, b: { x: number; y: number }): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
}

export function controllerNeedsUrgentUpgrade(room: Room): boolean {
    return isDevelopingRoom(room) && room.controller!.ticksToDowngrade <= developmentPolicy.controller.constructionDowngradeWarningTicks
}

/** Share one controller-site scan between the workers, seat planner and energy relay. */
export function controllerContainerSite(creep: Creep): ConstructionSite | undefined {
    const room = creep.room
    if (!isDevelopingRoom(room) || controllerNeedsUrgentUpgrade(room)) return undefined
    if (tick !== Game.time || shard !== Game.shard.name) {
        tick = Game.time; shard = Game.shard.name; rooms.clear()
    }
    let cached = rooms.get(room.name)
    if (cached?.room !== room) {
        cached = { room, sites: room.constructionSites.filter(site => site.my && site.structureType === STRUCTURE_CONTAINER &&
            range(site.pos, room.controller!.pos) <= controllerLayoutPolicy.containerRange) }
        rooms.set(room.name, cached)
    }
    let selected: ConstructionSite | undefined, nearest = Infinity
    for (const site of cached.sites) {
        const distance = range(creep.pos, site.pos)
        if (distance < nearest || distance === nearest && selected !== undefined && site.id < selected.id) {
            selected = site; nearest = distance
        }
    }
    return selected
}
