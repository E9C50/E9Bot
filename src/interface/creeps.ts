// 房间基础运营
type BaseRoleHarvester = 'harvester'
type BaseRoleFiller = 'filler'
type BaseRoleUpgrader = 'upgrader'
type BaseRoleBuilder = 'builder'
type BaseRoleRepairer = 'repairer'
type BaseRoleMiner = 'miner'
type BaseRoleScout = 'scout'

// 房间高级运营
type AdvancedRoleManager = 'manager'
type AdvancedRoleProcesser = 'processer'
type AdvancedRoleClaimer = 'claimer'
type AdvancedRoleReserver = 'reserver'
type AdvancedRoleRemoteHarvester = 'rHarvester'
type AdvancedRoleRemoteFiller = 'rFiller'
type AdvancedRoleRemoteBuilder = 'rBuilder'
type ShardRoleConstant = 'sClaimer' | 'sBuilder' | 'sHauler' | 'sScout'

// 战争角色
type WarRoleAttacker = 'attacker'
type WarRoleHealer = 'healer'
type WarRoleRangedAttacker = 'rAttacker'
type WarRoleDismantler = 'dismantler'
type WarRoleIntegrate = 'integrate'
type WarRoleDefender = 'defender'
type WarRoleRangedDefender = 'rdefender'
type WarRoleControllerAttacker = 'cAttacker'

// 所有的 creep 角色
type CreepRoleBaseConstant = BaseRoleHarvester | BaseRoleFiller | BaseRoleUpgrader | BaseRoleBuilder | BaseRoleRepairer | BaseRoleMiner | BaseRoleScout
type CreepRoleAdvConstant = AdvancedRoleManager | AdvancedRoleProcesser | AdvancedRoleClaimer | AdvancedRoleReserver | AdvancedRoleRemoteHarvester | AdvancedRoleRemoteFiller | AdvancedRoleRemoteBuilder
type CreepRoleWarConstant = WarRoleAttacker | WarRoleHealer | WarRoleRangedAttacker | WarRoleDismantler | WarRoleIntegrate | WarRoleDefender | WarRoleRangedDefender | WarRoleControllerAttacker
type CreepRoleConstant = CreepRoleBaseConstant | CreepRoleAdvConstant | CreepRoleWarConstant | ShardRoleConstant

// Creep 工作逻辑集合 包含了每个角色应该做的工作
type CreepWork = { [role in CreepRoleConstant]: (data: CreepData) => ICreepConfig }

// 所有 Creep 角色的 Data 数据
type CreepData = EmptyData | HarvesterData | MineralData | FillerData | BuilderData | RepairerData | import('../shard/missions').ShardUnitData


// Creep 基本工作接口定义
interface ICreepConfig {
    // 每次死后都会进行判断，只有返回 true 时才会重新发布孵化任务
    isNeed: (room: Room, creepName: string) => boolean
    // 准备阶段执行的方法, 返回 true 时代表准备完成
    // doWork: (creep: Creep) => void
    // 准备阶段执行的方法, 返回 true 时代表准备完成
    prepare: (creep: Creep) => boolean
    // creep 获取工作所需资源时执行的方法
    // 返回 true 则执行 target 阶段，返回其他将继续执行该方法
    source: (creep: Creep) => boolean
    // creep 工作时执行的方法,
    // 返回 true 则执行 source 阶段，返回其他将继续执行该方法
    target: (creep: Creep) => boolean
}

// Creep通用函数定义
interface Creep {
    transferToTarget(transferTarget: Structure, resourceType: ResourceConstant): boolean
    takeFromTarget(takeTarget: Structure, resourceType: ResourceConstant, amount?: number): boolean
    pickupDroppedResource(allSource: boolean, range: number): boolean

    goBoost(): boolean

    requireCross(direction: DirectionConstant): Boolean
    mutualCross(direction: DirectionConstant): OK | ERR_BUSY | ERR_NOT_FOUND
    batterMove(target: DirectionConstant | Creep): CreepMoveReturnCode | ERR_INVALID_TARGET | ERR_NOT_IN_RANGE
    farMoveToRoom(targetRoom: string, fleeEnemy?: boolean): CreepMoveReturnCode | ERR_NO_PATH | ERR_NOT_IN_RANGE | ERR_INVALID_TARGET
}

interface CreepMemory {
    displayName: string
    name: string
    role: CreepRoleConstant
    ready: boolean
    working: boolean
    spawnRoom: string
    spawnPriority: number
    data: CreepData
    dontPullMe?: boolean
    isTeam?: boolean
    combatTaskId?: string
    combatJob?: 'fighter' | 'scout' | 'controller' | 'loot'
    combatGeneration?: number
    needBoost?: boolean
    needRenew?: boolean
    pathCache?: string
    prePos?: string
    /** Finish unloading mixed evacuation cargo before restoring the original economy role after cancellation. */
    evacuationCargoRoom?: string
    /** Local-shard aid loading progress and bounded target cooldowns. */
    aidBuilderEnergy?: AidBuilderEnergyState
    /** Stable local mine assignment and loading progress for development haulers. */
    developmentHauler?: import('../creep/developmentHauling').DevelopmentHaulerState
    /** Per-demand preferences override persistent room role preferences. */
    bodyProfile?: CreepBodyProfile
    /** Spawn-selected compounds; tier 0 explicitly opts out of legacy role boosts. */
    boostPlan?: CreepBoostPlan
    development?: {
        workParts?: number
        carryParts?: number
        travelTicks?: number
        stationary?: boolean
        maximumCost?: number
    }
}

interface AidBuilderEnergyState {
    shard: string
    roomName: string
    tick: number
    loadStarted?: number
    active?: {
        targetId: string
        x: number
        y: number
        energy: number
        progressTick: number
    }
    blocked: { targetId: string; until: number }[]
}

type CreepBoostTier = 0 | 1 | 2 | 3
type CreepBodyTerrain = 'road' | 'plain' | 'swamp'

interface CreepBodyProfile {
    /** Exact combat composition selected by a mission; productive economy quotas stay separate. */
    combatPrimaryParts?: number
    combatHealParts?: number
    combatToughParts?: number
    boostTier?: CreepBoostTier
    terrain?: CreepBodyTerrain
    /** A confirmed standing workstation; never infer this from the role alone. */
    stationary?: boolean
    workParts?: number
    carryParts?: number
    maximumCost?: number
    boostFallback?: 'unboosted' | 'wait'
}

interface CreepBoostPlan {
    tier: CreepBoostTier
    steps: { type: BoostTypeConstant; resource: ResourceConstant; parts: number }[]
    startedAt?: number
    completed?: boolean
    failed?: boolean
    failureReason?: string
}

interface EmptyData { }

interface HarvesterData { sourceId: string, buildTarget?: string }
interface MineralData { sourceId: string }
interface FillerData { sourceId: string, targetId?: string, mineId?: string, evacuationRoom?: string }

interface ManagerData { }
interface ProcesserData { waiting: number }

interface UpgraderData { sourceId: string; harvestingSourceId?: string }
interface BuilderData { sourceId: string, buildTarget?: string, repairTarget?: string }
interface RepairerData { sourceId: string, repairTarget?: string }

interface ScoutData { targetFlag: string }
interface ReserverData { targetRoom: string }
interface ClaimerData { targetFlag: string }

interface RemoteFillerData { sourceFlag: string, targetFlag: string, withdrawTarget?: string }
interface RemoteBuilderData { sourceFlag: string, targetFlag: string, buildTarget?: string, bootstrap?: boolean }
interface RemoteHarvesterData { sourceId: string, targetRoom: string, buildTarget?: string }

interface AttackerData { targetFlag: string }
interface HealerData { targetFlag: string, targetCreep?: string }
interface IntegrateData { targetFlag: string, attackEnemy?: string }

interface DefenderData { targetEnemy: string, lastEnemy?: string, groupKey?: string,
    guardPosition?: { x: number, y: number, roomName: string }, pursuitStartedAt?: number }


interface BodySet {
    [MOVE]?: number
    [CARRY]?: number
    [ATTACK]?: number
    [RANGED_ATTACK]?: number
    [WORK]?: number
    [CLAIM]?: number
    [TOUGH]?: number
    [HEAL]?: number
}
