
interface Room {
    my: boolean
    level: number

    enemies: Creep[]

    // 建筑缓存一键访问
    mineral: Mineral
    sources: Source[]

    ruins: Ruin[]
    tombstones: Tombstone[]
    droppedResource: Resource[]

    wallsNeedRepair: Structure[]
    structuresNeedRepair: Structure[]

    structures: Structure[]
    constructionSites: ConstructionSite[]

    roads: StructureRoad[]
    spawns: StructureSpawn[]
    ramparts: StructureRampart[]
    extensions: StructureExtension[]
    walls: StructureWall[]

    labs: StructureLab[]
    links: StructureLink[]
    towers: StructureTower[]
    containers: StructureContainer[]

    keeperLairs: StructureKeeperLair[]
    powerBanks: StructurePowerBank[]
    portals: StructurePortal[]

    nuker?: StructureNuker
    factory?: StructureFactory
    observer?: StructureObserver
    extractor?: StructureExtractor
    powerSpawn?: StructurePowerSpawn
    invaderCore?: StructureInvaderCore
    // storage: StructureStorage
    // terminal: StructureTerminal
    // controller: StructureController

    centerLink?: StructureLink
    controllerLink?: StructureLink

    lunchNuker(): boolean
    getDefenderCostMatrix(): CostMatrix
    getResource(resType: ResourceConstant, storage?: boolean, terminal?: boolean, lab?: boolean, processer?: boolean)
    sendResource(targetRoom: string, resourceType: ResourceConstant, amount: number): boolean
}

interface RoomPosition {
    getFreeSpace(): RoomPosition[]
    directionToPos(direction: DirectionConstant): RoomPosition | undefined
}

interface RoomMemory {
    /** Persisted console settings, independent of regularly refreshed population demands. */
    bodyProfiles?: Partial<Record<CreepRoleConstant, CreepBodyProfile>>
    creepConfig: { [creepName: string]: CreepMemory }
    teamConfig: { [teamId: string]: TeamConfig }

    boostNeed: { [resourceType: string]: number }

    resourceAmount: { [resourceType: string]: number }
    terminalAmount: { [resourceType: string]: number }
    terminalSendJob: {
        [jobId: string]: {
            amount: number
            targetRoom: string
            resourceType: ResourceConstant
        }
    }

    restrictedPos?: { [creepName: string]: RoomPosition }

    roomSignText?: string
    npcTarget?: string
    creepSpawnQueue: string[]

    // roomCustom: RoomCustomMemory
    roomPosition: IRoomPositionList
    roomStructure: IRoomStructure

    roomFillJob: IRoomFillJob
    roomLabConfig: ILabConfig

    autoLaylout?: boolean
    roomBlueprint?: import('../planning/types').RoomBlueprint
    roomBlueprintState?: import('../planning/types').RoomBlueprintState
    needUpdateCache?: boolean
    centerLinkSentMode?: boolean
    enableTowerRepairWall?: boolean
    /** false 时恢复该房原有运营策略；RCL8 自动退出发展策略。 */
    fastUpgrade?: boolean
    developmentRemotes?: import('../creep/developmentRemotes').DevelopmentRemoteState
}

interface IRoomPositionList {
    managerPos?: RoomPosition
    centerPos?: RoomPosition
}

interface IRoomStructure {
    towerAllowRepair?: string
}

interface IRoomFillJob {
    extension?: boolean
    tower?: string[]

    powerSpawnEnergy?: boolean
    powerSpawnPower?: boolean

    nukerEnergy?: boolean
    nukerMineral?: boolean

    labOut?: string[]
    labInEnergy?: string[]
    labInMineral?: {
        labId: string
        resourceType: ResourceConstant
    }[]
}
