export enum boostTypeEnum {
    BoostTypeMove = 'boostMove',
    BoostTypeCarry = 'boostCarry',

    BoostTypeBuild = 'boostBuild',
    BoostTypeUpgrade = 'boostUpgrade',
    BoostTypeHarvest = 'boostHarvest',
    BoostTypeDismantle = 'boostDismantle',

    BoostTypeHeal = 'boostHeal',
    BoostTypeTough = 'boostTough',
    BoostTypeAttack = 'boostAttack',
    BoostTypeRangedAttack = 'boostRAttack',
}

// boost类型对应BodyPart
export const boostBodyPart: BoostBodyPartConfig = {
    boostMove: MOVE,
    boostCarry: CARRY,
    boostBuild: WORK,
    boostUpgrade: WORK,
    boostHarvest: WORK,
    boostDismantle: WORK,
    boostHeal: HEAL,
    boostTough: TOUGH,
    boostAttack: ATTACK,
    boostRAttack: RANGED_ATTACK
}

// boost所需化合物配置
export const boostConfig: BoostResourceConfig = {
    boostMove: [RESOURCE_ZYNTHIUM_OXIDE, RESOURCE_ZYNTHIUM_ALKALIDE, RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE],
    boostCarry: [RESOURCE_KEANIUM_HYDRIDE, RESOURCE_KEANIUM_ACID, RESOURCE_CATALYZED_KEANIUM_ACID],
    boostBuild: [RESOURCE_LEMERGIUM_HYDRIDE, RESOURCE_LEMERGIUM_ACID, RESOURCE_CATALYZED_LEMERGIUM_ACID],
    boostUpgrade: [RESOURCE_GHODIUM_HYDRIDE, RESOURCE_GHODIUM_ACID, RESOURCE_CATALYZED_GHODIUM_ACID],
    boostHarvest: [RESOURCE_UTRIUM_OXIDE, RESOURCE_UTRIUM_ALKALIDE, RESOURCE_CATALYZED_UTRIUM_ALKALIDE],
    boostDismantle: [RESOURCE_ZYNTHIUM_HYDRIDE, RESOURCE_ZYNTHIUM_ACID, RESOURCE_CATALYZED_ZYNTHIUM_ACID],
    boostHeal: [RESOURCE_LEMERGIUM_OXIDE, RESOURCE_LEMERGIUM_ALKALIDE, RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE],
    boostTough: [RESOURCE_GHODIUM_OXIDE, RESOURCE_GHODIUM_ALKALIDE, RESOURCE_CATALYZED_GHODIUM_ALKALIDE],
    boostAttack: [RESOURCE_UTRIUM_HYDRIDE, RESOURCE_UTRIUM_ACID, RESOURCE_CATALYZED_UTRIUM_ACID],
    boostRAttack: [RESOURCE_KEANIUM_OXIDE, RESOURCE_KEANIUM_ALKALIDE, RESOURCE_CATALYZED_KEANIUM_ALKALIDE]
}


// 角色对应的需要boost的配置
export const roleBoostConfig: { [role in CreepRoleConstant]?: BoostTypeConstant[] } = {
    // upgrader: [boostTypeEnum.BoostTypeUpgrade],
    // builder: [boostTypeEnum.BoostTypeBuild],
    // repairer: [boostTypeEnum.BoostTypeBuild, boostTypeEnum.BoostTypeCarry],

    // rFiller: [boostTypeEnum.BoostTypeCarry, boostTypeEnum.BoostTypeMove],
    rBuilder: [boostTypeEnum.BoostTypeUpgrade, boostTypeEnum.BoostTypeMove],
    // rBuilder: [boostTypeEnum.BoostTypeUpgrade, boostTypeEnum.BoostTypeCarry, boostTypeEnum.BoostTypeMove],

    defender: [boostTypeEnum.BoostTypeAttack, boostTypeEnum.BoostTypeMove],
    rdefender: [boostTypeEnum.BoostTypeRangedAttack, boostTypeEnum.BoostTypeMove],

    dismantler: [boostTypeEnum.BoostTypeDismantle, boostTypeEnum.BoostTypeMove, boostTypeEnum.BoostTypeTough],

    healer: [
        boostTypeEnum.BoostTypeHeal, boostTypeEnum.BoostTypeMove, boostTypeEnum.BoostTypeTough
    ],
    attacker: [
        boostTypeEnum.BoostTypeAttack, boostTypeEnum.BoostTypeMove,
        boostTypeEnum.BoostTypeTough, boostTypeEnum.BoostTypeHeal
    ],
    integrate: [
        boostTypeEnum.BoostTypeRangedAttack, boostTypeEnum.BoostTypeMove,
        boostTypeEnum.BoostTypeTough, boostTypeEnum.BoostTypeHeal
    ],
}
