export type CombatMode = 'attack' | 'hold'
export type CombatFormation = 'auto' | 'solo' | 'duo' | 'quad'
export type CombatPhase = 'recon' | 'planning' | 'spawning' | 'combat' | 'controller' | 'loot' | 'returning' | 'completed' | 'cancelled'
export interface CombatTaskOptions {
    id?: string
    mode?: CombatMode
    formation?: CombatFormation
    boostTier?: 'auto' | CreepBoostTier
    timeoutTicks?: number
    holdTicks?: number
    maxWaves?: number
    maxEnergy?: number
    controllerAttack?: boolean
    loot?: boolean
}
export interface CombatIntel {
    seenAt: number
    owner?: string
    category: 'player' | 'npc' | 'neutral'
    safeModeUntil: number
    protectedUntil: number
    hostileCount: number
    armedCount: number
    healing: number
    /** Ordered, merged live body segments preserve front TOUGH absorption without storing full bodies. */
    enemyBodies?: { hits: number; damageRatio: number }[][]
    attack: number
    ranged: number
    towers: { x: number; y: number; power: number }[]
    objectives: number
    core?: string
    loot: number
    downgrade?: number
    level?: number
    upgradeBlocked?: number
}
export interface CombatMemberPlan {
    role: CreepRoleConstant
    profile: CreepBodyProfile
    body: BodyPartConstant[]
    boostPlan: CreepBoostPlan
    energy: number
}
export interface CombatForcePlan {
    formation: Exclude<CombatFormation, 'auto'>
    members: CombatMemberPlan[]
    energy: number
    incoming: number
    healing: number
    damage: number
    plannedAt: number
    estimatedResourceCost?: number
}
export interface CombatTask {
    id: string
    shard: string
    homeRoom: string
    targetRoom: string
    mode: CombatMode
    options: CombatTaskOptions
    phase: CombatPhase
    createdAt: number
    holdStartedAt?: number
    updatedAt: number
    deadline?: number
    category?: CombatIntel['category']
    intel?: CombatIntel
    plan?: CombatForcePlan
    /** An open home-room assembly area, with distinct slots in formation order. */
    rally?: { x: number; y: number; roomName: string; count: number; slots: Record<string, number>; pathFailures?: Record<string, number> }
    rallyRetryAt?: number
    plannedThreat?: { output: number; healing: number; towerCount: number; armour?: number }
    names: string[]
    wave: number
    seenFighters?: string[]
    memberNames?: string[]
    generation: number
    spent: number
    lastPlanAt?: number
    lastScoutAt?: number
    scoutPending?: boolean
    scoutSeenAlive?: boolean
    observedAt?: number
    clearSince?: number
    controllerSentAt?: number
    controllerBaseline?: number
    controllerConfirmed?: boolean
    lootEmptySince?: number
    lootProgressAt?: number
    lootRemaining?: number
    reason?: string
    endedAt?: number
}
declare global {
    interface Memory { combatTasks?: Record<string, CombatTask> }
}
