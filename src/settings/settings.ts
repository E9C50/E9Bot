export const STRUCTURE_PRIVATEKEY_PERFIX = '_'
export const STRUCTURE_MEMORYKEY_PERFIX = 'IDOF_'

export const creepWhiteList = ['NoName_', 'MoSaSa', 'Kaoruko', 'keqing', 'RainbowCandy']

// 永不踏入这些房间；同名房间在不同 shard 独立配置。
export const findPathAvoidRooms: Record<string, string[]> = {
    shard0: [],
    shard1: [],
    shard2: [],
    shard3: ['E39N4', 'E38N1', 'E39N1', 'E32N2', 'E33N5'],
}

const emptyFindPathAvoidRooms: readonly string[] = []

/** Local navigation uses the current shard; portal nodes pass their own shard. */
export function getFindPathAvoidRooms(shardName: string | undefined = typeof Game !== 'undefined' ? Game.shard?.name : undefined): readonly string[] {
    return shardName === undefined ? emptyFindPathAvoidRooms : findPathAvoidRooms[shardName] || emptyFindPathAvoidRooms
}

/** Cross-shard cached routes depend on the policies at both ends and every intermediate shard. */
export function getFindPathAvoidRoomsSignature(): string {
    return JSON.stringify(Object.keys(findPathAvoidRooms).sort().map(shard =>
        [shard, [...new Set(findPathAvoidRooms[shard])].sort()]))
}

export const enableObserversFindPath = true
export const observersFindPathIdList = [
]

export enum colorEnum {
    RED = '#ef9a9a',
    GREEN = '#6b9955',
    YELLOW = '#c5c599',
    BLUE = '#8dc5e3'
}
