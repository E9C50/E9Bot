// 反应底物表接口
interface IReactionSource {
    [targetResourceName: string]: (MineralConstant | MineralCompoundConstant)[]
}

// Boost类型配置
type BoostTypeMove = 'boostMove'
type BoostTypeCarry = 'boostCarry'

type BoostTypeBuild = 'boostBuild'
type BoostTypeUpgrade = 'boostUpgrade'
type BoostTypeHarvest = 'boostHarvest'
type BoostTypeDismantle = 'boostDismantle'

type BoostTypeHeal = 'boostHeal'
type BoostTypeTough = 'boostTough'
type BoostTypeAttack = 'boostAttack'
type BoostTypeRangedAttack = 'boostRAttack'

type BoostTypeConstant = BoostTypeMove | BoostTypeCarry
    | BoostTypeBuild | BoostTypeUpgrade | BoostTypeHarvest | BoostTypeDismantle
    | BoostTypeHeal | BoostTypeTough | BoostTypeAttack | BoostTypeRangedAttack

type BoostBodyPartConfig = {
    [type in BoostTypeConstant]: BodyPartConstant
}

type BoostResourceConfig = {
    [type in BoostTypeConstant]: ResourceConstant[]
}

type BoostLabConfig = {
    resourceType: MineralBoostConstant
    bodyPart: BodyPartConstant
}

interface ILabConfig {
    sourceLab1?: string
    sourceLab2?: string
    labReactionConfig?: ResourceConstant
    /** Current recipe's input batch; processors must leave boost reservations available. */
    reactionAmount?: number
    /** A bounded final-product batch survives precursor reactions and terminal cooldowns. */
    productionPlan?: {
        target: ResourceConstant
        targetAmount: number
        local: boolean
    }

    singleLabConfig: {
        [labId: string]: {
            boostMode: boolean
            boostType: BoostTypeConstant
            resourceType: ResourceConstant
        }
    }
}

