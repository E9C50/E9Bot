// Native-body integration fixtures isolate laboratory readiness; boost execution has its own world.
const globals = {
    WORK: 'work', CARRY: 'carry', MOVE: 'move', CLAIM: 'claim', TOUGH: 'tough',
    ATTACK: 'attack', RANGED_ATTACK: 'ranged_attack', HEAL: 'heal',
    MAX_CREEP_SIZE: 50, CARRY_CAPACITY: 50, HARVEST_POWER: 2, HARVEST_MINERAL_POWER: 1,
    SOURCE_ENERGY_CAPACITY: 3000, ENERGY_REGEN_TIME: 300, EXTRACTOR_COOLDOWN: 5,
    CONTROLLER_MAX_UPGRADE_PER_TICK: 15,
};
const modules = {
    'settings/boost': { boostConfig: {}, boostBodyPart: {}, boostTypeEnum: {}, roleBoostConfig: {} },
    'creep/boosting': { canPrepareBoosts: () => false, reserveBoostPlan() {}, getActiveRoomBoostRequests: () => [] },
};
module.exports = { globals, modules };
