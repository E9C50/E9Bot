import RoleAdvClaimer from "./adv/RoleAdvClaimer"
import RoleAdvManager from "./adv/RoleAdvManager"
import RoleAdvProcesser from "./adv/RoleAdvProcesser"
import RoleAdvRemoteBuilder from "./adv/RoleAdvRemoteBuilder"
import RoleAdvRemoteFiller from "./adv/RoleAdvRemoteFiller"
import RoleAdvRemoteHarvester from "./adv/RoleAdvRemoteHarvester"
import RoleAdvReserver from "./adv/RoleAdvReserver"
import RoleBaseBuilder from "./base/RoleBaseBuilder"
import RoleBaseFiller from "./base/RoleBaseFiller"
import RoleBaseHarvester from "./base/RoleBaseHarvester"
import RoleBaseMiner from "./base/RoleBaseMiner"
import RoleBaseRepairer from "./base/RoleBaseRepairer"
import RoleBaseScout from "./base/RoleBaseScout"
import RoleBaseUpgrader from "./base/RoleBaseUpgrader"
import RoleWarAttacker from "./war/RoleWarAttacker"
import RoleWarControllerAttacker from "./war/RoleWarControllerAttacker"
import RoleWarDefender from "./war/RoleWarDefender"
import RoleWarDefenderRanged from "./war/RoleWarDefenderRanged"
import RoleWarDismantle from "./war/RoleWarDismantle"
import RoleWarHealer from "./war/RoleWarHealer"
import RoleWarIntegrate from "./war/RoleWarIntegrate"
import { createShardRole } from 'shard/workers'
import { createShardScoutRole } from 'shard/scouting'
import { withDevelopmentRemoteRole } from 'creep/developmentRemotes'

const notImplemented = function (data: CreepData): ICreepConfig {
    throw new Error("Role rAttacker is not implemented.")
}

const creepWork: CreepWork = {
    harvester: RoleBaseHarvester,
    filler: RoleBaseFiller,
    upgrader: RoleBaseUpgrader,
    builder: RoleBaseBuilder,
    repairer: RoleBaseRepairer,
    miner: RoleBaseMiner,
    scout: RoleBaseScout,

    manager: RoleAdvManager,
    processer: RoleAdvProcesser,
    claimer: RoleAdvClaimer,
    reserver: RoleAdvReserver,
    rHarvester: RoleAdvRemoteHarvester,
    rFiller: RoleAdvRemoteFiller,
    rBuilder: RoleAdvRemoteBuilder,
    sClaimer: createShardRole('claimer'),
    sBuilder: createShardRole('builder'),
    sHauler: createShardRole('hauler'),
    sScout: createShardScoutRole,

    attacker: RoleWarAttacker,
    healer: RoleWarHealer,
    rAttacker: notImplemented,
    dismantler: RoleWarDismantle,
    integrate: RoleWarIntegrate,
    defender: RoleWarDefender,
    rdefender: RoleWarDefenderRanged,
    cAttacker: RoleWarControllerAttacker
}

export default creepWork

/** 显式排除未实现角色，同时防止继承属性被误当作角色。 */
export function isRoleSupported(role: string | undefined): role is CreepRoleConstant {
    return role !== undefined && Object.prototype.hasOwnProperty.call(creepWork, role)
        && creepWork[role as CreepRoleConstant] !== notImplemented
}

export function createRoleBehavior(role: string | undefined, data: CreepData): ICreepConfig | undefined {
    return isRoleSupported(role) ? withDevelopmentRemoteRole(data, creepWork[role](data)) : undefined
}
