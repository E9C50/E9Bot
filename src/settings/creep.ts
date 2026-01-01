
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

    integrate: 3,
    defender: 3,
    rdefender: 3,
    attacker: 14,
    healer: 15,
    rAttacker: 16,
    dismantler: 17,
    cAttacker: 17
}

// TODO 重新配置！！！
const workerBodyConfigs = [
    { [WORK]: 1, [CARRY]: 1, [MOVE]: 1 },
    { [WORK]: 2, [CARRY]: 2, [MOVE]: 2 },
    { [WORK]: 3, [CARRY]: 3, [MOVE]: 3 },
    { [WORK]: 4, [CARRY]: 4, [MOVE]: 4 },
    { [WORK]: 6, [CARRY]: 6, [MOVE]: 6 },
    { [WORK]: 7, [CARRY]: 7, [MOVE]: 7 },
    { [WORK]: 12, [CARRY]: 6, [MOVE]: 9 },
    { [WORK]: 20, [CARRY]: 10, [MOVE]: 20 }
]

const carryBodyConfigs = [
    { [CARRY]: 2, [MOVE]: 2 },
    { [CARRY]: 3, [MOVE]: 3 },
    { [CARRY]: 4, [MOVE]: 2 },
    { [CARRY]: 5, [MOVE]: 3 },
    { [CARRY]: 8, [MOVE]: 4 },
    { [CARRY]: 14, [MOVE]: 7 },
    { [CARRY]: 20, [MOVE]: 10 },
    { [CARRY]: 33, [MOVE]: 17 }
]

export const bodyConfigs: { [role in CreepRoleConstant]: BodySet[] } = {
    harvester: workerBodyConfigs,
    upgrader: workerBodyConfigs,
    builder: workerBodyConfigs,
    repairer: workerBodyConfigs,
    miner: workerBodyConfigs,
    filler: carryBodyConfigs,

    // rBuilder: workerBodyConfigs,
    rFiller: carryBodyConfigs,
    // rBuilder: Array.from({ length: 8 }, () => ({ [WORK]: 32, [CARRY]: 1, [MOVE]: 17 })),
    // rBuilder: Array.from({ length: 8 }, () => ({ [WORK]: 39, [CARRY]: 1, [MOVE]: 10 })),
    rBuilder: Array.from({ length: 8 }, () => ({ [WORK]: 20, [CARRY]: 20, [MOVE]: 10 })),
    // rFiller: Array.from({ length: 8 }, () => ({ [CARRY]: 44, [MOVE]: 6 })),

    processer: carryBodyConfigs,
    scout: Array.from({ length: 8 }, () => ({ [MOVE]: 1 })),
    claimer: Array.from({ length: 8 }, () => ({ [CLAIM]: 1, [MOVE]: 1 })),
    cAttacker: Array.from({ length: 8 }, () => ({ [CLAIM]: 19, [MOVE]: 19 })),

    attacker: Array.from({ length: 8 }, () => ({ [TOUGH]: 10, [ATTACK]: 30, [MOVE]: 10 })),
    healer: Array.from({ length: 8 }, () => ({ [TOUGH]: 12, [MOVE]: 10, [HEAL]: 28 })),

    dismantler: Array.from({ length: 8 }, () => ({ [TOUGH]: 12, [WORK]: 28, [MOVE]: 10 })),
    // dismantler: Array.from({ length: 8 }, () => ({ [WORK]: 40, [MOVE]: 10 })),

    manager: [
        { [CARRY]: 5, [MOVE]: 1 },
        { [CARRY]: 10, [MOVE]: 1 },
        { [CARRY]: 15, [MOVE]: 1 },
        { [CARRY]: 25, [MOVE]: 1 },
        { [CARRY]: 35, [MOVE]: 1 },
        { [CARRY]: 45, [MOVE]: 1 },
        { [CARRY]: 49, [MOVE]: 1 },
        { [CARRY]: 49, [MOVE]: 1 }
    ],
    reserver: [
        { [MOVE]: 1, [CLAIM]: 1 },
        { [MOVE]: 1, [CLAIM]: 1 },
        { [MOVE]: 1, [CLAIM]: 1 },
        { [MOVE]: 1, [CLAIM]: 1 },
        { [MOVE]: 2, [CLAIM]: 2 },
        { [MOVE]: 2, [CLAIM]: 2 },
        { [MOVE]: 3, [CLAIM]: 3 },
        { [MOVE]: 5, [CLAIM]: 5 }
    ],
    rHarvester: [
        { [WORK]: 2, [CARRY]: 1, [MOVE]: 1 },
        { [WORK]: 4, [CARRY]: 1, [MOVE]: 2 },
        { [WORK]: 6, [CARRY]: 1, [MOVE]: 3 },
        { [WORK]: 7, [CARRY]: 1, [MOVE]: 4 },
        { [WORK]: 8, [CARRY]: 1, [MOVE]: 5 },
        { [WORK]: 8, [CARRY]: 1, [MOVE]: 5 },
        { [WORK]: 8, [CARRY]: 1, [MOVE]: 5 },
        { [WORK]: 8, [CARRY]: 1, [MOVE]: 5 },
    ],
    integrate: [
        { [TOUGH]: 0, [MOVE]: 0, [RANGED_ATTACK]: 0, [HEAL]: 0 },
        { [TOUGH]: 0, [MOVE]: 0, [RANGED_ATTACK]: 0, [HEAL]: 0 },
        { [TOUGH]: 0, [MOVE]: 0, [RANGED_ATTACK]: 0, [HEAL]: 0 },
        { [TOUGH]: 0, [MOVE]: 0, [RANGED_ATTACK]: 0, [HEAL]: 0 },
        { [TOUGH]: 0, [MOVE]: 0, [RANGED_ATTACK]: 0, [HEAL]: 0 },
        { [TOUGH]: 0, [MOVE]: 0, [RANGED_ATTACK]: 0, [HEAL]: 0 },
        { [TOUGH]: 0, [MOVE]: 0, [RANGED_ATTACK]: 0, [HEAL]: 0 },
        // { [TOUGH]: 5, [RANGED_ATTACK]: 30, [MOVE]: 10, [HEAL]: 5 },
        { [TOUGH]: 2, [RANGED_ATTACK]: 36, [MOVE]: 10, [HEAL]: 2 }, // 防御
        // { [TOUGH]: 7, [RANGED_ATTACK]: 19, [MOVE]: 10, [HEAL]: 14 }, // 7级房进攻
        // { [TOUGH]: 8, [MOVE]: 10, [RANGED_ATTACK]: 15, [HEAL]: 17 }, // 四级要塞
        // { [TOUGH]: 2, [RANGED_ATTACK]: 25, [HEAL]: 13, [MOVE]: 10 }, // 一级要塞
    ],
    rAttacker: [],
    defender: [
        { [ATTACK]: 2, [MOVE]: 2 },
        { [ATTACK]: 3, [MOVE]: 3 },
        { [ATTACK]: 4, [MOVE]: 4 },
        { [ATTACK]: 5, [MOVE]: 5 },
        { [ATTACK]: 6, [MOVE]: 6 },
        { [ATTACK]: 7, [MOVE]: 7 },
        { [ATTACK]: 40, [MOVE]: 10 },
        { [ATTACK]: 40, [MOVE]: 10 }
    ],
    rdefender: [
        { [RANGED_ATTACK]: 2, [MOVE]: 2 },
        { [RANGED_ATTACK]: 3, [MOVE]: 3 },
        { [RANGED_ATTACK]: 4, [MOVE]: 4 },
        { [RANGED_ATTACK]: 5, [MOVE]: 5 },
        { [RANGED_ATTACK]: 6, [MOVE]: 6 },
        { [RANGED_ATTACK]: 7, [MOVE]: 7 },
        { [RANGED_ATTACK]: 40, [MOVE]: 10 },
        { [RANGED_ATTACK]: 40, [MOVE]: 10 }
    ],
}
