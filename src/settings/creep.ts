
export enum roleBaseEnum {
    HARVESTER = 'harvester',
    FILLER = 'filler',
    UPGRADER = 'upgrader',
    BUILDER = 'builder',
    REPAIRER = 'repairer',
    MINER = 'miner',
    SCOUT = 'scout',
}

export enum roleAdvEnum {
    MANAGER = "manager",
    PROCESSER = "processer",
    CLAIMER = "claimer",
    RESERVER = "reserver",
    RHARVESTER = "rHarvester",
    RFILLER = "rFiller",
    RBUILDER = "rBuilder",
    SHARD_CLAIMER = 'sClaimer',
    SHARD_BUILDER = 'sBuilder',
    SHARD_HAULER = 'sHauler',
    SHARD_SCOUT = 'sScout',
}

export enum roleWarEnum {
    ATTACKER = 'attacker',
    HEALER = 'healer',
    RANGED_ATTACKER = 'rAttacker',
    CONTROLLER_ATTACKER = 'cAttacker',
    DISMANTLER = 'dismantler',
    INTEGRATE = 'integrate',
    DEFENDER = 'defender',
    RDEFENDER = 'rdefender'
}

export const roleTeam = 'team'

export const warModeRole: CreepRoleConstant[] = [
    roleBaseEnum.FILLER, roleBaseEnum.REPAIRER, roleAdvEnum.PROCESSER, roleAdvEnum.MANAGER,
    roleWarEnum.ATTACKER, roleWarEnum.DISMANTLER, roleWarEnum.HEALER, roleWarEnum.CONTROLLER_ATTACKER,
    roleWarEnum.INTEGRATE, roleWarEnum.RANGED_ATTACKER, roleWarEnum.DEFENDER, roleWarEnum.RDEFENDER
]

export const spawnPriority: { [role in CreepRoleConstant]: number } = {
    manager: 0,
    harvester: 1,
    filler: 2,
    processer: 3,
    scout: 3,
    builder: 4,
    upgrader: 5,
    repairer: 6,
    miner: 7,

    claimer: 9,
    rHarvester: 10,
    rFiller: 11,
    rBuilder: 12,
    reserver: 13,
    sClaimer: 9,
    sBuilder: 12,
    sHauler: 12,
    sScout: 8,

    integrate: 3,
    defender: 3,
    rdefender: 3,
    attacker: 14,
    healer: 15,
    rAttacker: 16,
    dismantler: 17,
    cAttacker: 17
}

/** Unboosted, affordable cost tiers retained for legacy callers of getBodyConfig. */
const workerBodyConfigs: BodySet[] = [
    { [WORK]: 1, [CARRY]: 1, [MOVE]: 1 },
    ...[1, 2, 3, 5, 8, 10, 12].map(parts => ({ [WORK]: parts, [CARRY]: parts, [MOVE]: parts * 2 })),
]
const carryBodyConfigs: BodySet[] = [1, 2, 4, 6, 10, 16, 20, 25]
    .map(parts => ({ [CARRY]: parts, [MOVE]: parts }))
const sourceBodyConfigs: BodySet[] = [1, 2, 3, 4, 5]
    .map(parts => ({ [WORK]: parts, [CARRY]: 1, [MOVE]: parts }))
const claimBodyConfigs: BodySet[] = [{ [CLAIM]: 1, [MOVE]: 1 }]
const scoutBodyConfigs: BodySet[] = [{ [MOVE]: 1 }]
const mineralBodyConfigs: BodySet[] = [
    { [WORK]: 1, [CARRY]: 1, [MOVE]: 1 },
    ...[1, 2, 4, 6, 8, 12, 16].map(work => ({ [WORK]: work, [CARRY]: Math.max(1, Math.ceil(work / 2)),
        [MOVE]: work + Math.max(1, Math.ceil(work / 2)) })),
]
const meleeBodyConfigs: BodySet[] = [1, 2, 4, 6, 10, 16, 20, 25]
    .map(parts => ({ [ATTACK]: parts, [MOVE]: parts }))
const rangedBodyConfigs: BodySet[] = [1, 2, 4, 6, 10, 16, 20, 25]
    .map(parts => ({ [RANGED_ATTACK]: parts, [MOVE]: parts }))

export const bodyConfigs: { [role in CreepRoleConstant]: BodySet[] } = {
    harvester: sourceBodyConfigs,
    upgrader: workerBodyConfigs,
    builder: workerBodyConfigs,
    repairer: workerBodyConfigs,
    miner: mineralBodyConfigs,
    filler: carryBodyConfigs,
    rBuilder: workerBodyConfigs,
    rFiller: carryBodyConfigs,
    rHarvester: sourceBodyConfigs,
    sClaimer: claimBodyConfigs,
    sScout: scoutBodyConfigs,
    sBuilder: workerBodyConfigs,
    sHauler: carryBodyConfigs,
    processer: carryBodyConfigs,
    scout: scoutBodyConfigs,
    claimer: claimBodyConfigs,
    cAttacker: [1, 2, 4, 6, 10, 13, 16, 19].map(parts => ({ [CLAIM]: parts, [MOVE]: parts })),
    attacker: meleeBodyConfigs,
    healer: [1, 2, 4, 6, 10, 16, 20, 25].map(parts => ({ [MOVE]: parts, [HEAL]: parts })),
    dismantler: [1, 2, 4, 6, 10, 16, 20, 25].map(parts => ({ [WORK]: parts, [MOVE]: parts })),
    manager: [1, 2, 4, 6, 8, 12, 24, 49].map(parts => ({ [CARRY]: parts, [MOVE]: 1 })),
    reserver: [claimBodyConfigs[0], { [CLAIM]: 2, [MOVE]: 2 }],
    integrate: [1, 2, 3, 4, 6, 8, 10, 12].map(parts =>
        ({ [RANGED_ATTACK]: parts, [MOVE]: parts * 2, [HEAL]: parts })),
    rAttacker: [],
    defender: meleeBodyConfigs,
    rdefender: rangedBodyConfigs,
}
