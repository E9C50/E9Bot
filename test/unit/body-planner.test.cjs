const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

const COST = { work: 100, carry: 50, move: 50, claim: 600, tough: 10, attack: 80, ranged_attack: 150, heal: 250 };
const BOOST_CONFIG = {
    boostMove: ['ZO', 'ZHO2', 'XZHO2'], boostCarry: ['KH', 'KH2O', 'XKH2O'],
    boostHarvest: ['UO', 'UHO2', 'XUHO2'], boostBuild: ['LH', 'LH2O', 'XLH2O'],
    boostUpgrade: ['GH', 'GH2O', 'XGH2O'], boostDismantle: ['ZH', 'ZH2O', 'XZH2O'],
    boostHeal: ['LO', 'LHO2', 'XLHO2'], boostTough: ['GO', 'GHO2', 'XGHO2'],
    boostAttack: ['UH', 'UH2O', 'XUH2O'], boostRAttack: ['KO', 'KHO2', 'XKHO2'],
};
const BOOST_PARTS = {
    boostMove: 'move', boostCarry: 'carry', boostHarvest: 'work', boostBuild: 'work',
    boostUpgrade: 'work', boostDismantle: 'work', boostHeal: 'heal', boostTough: 'tough',
    boostAttack: 'attack', boostRAttack: 'ranged_attack',
};
const BOOST_ACTIONS = {
    boostMove: ['fatigue', [2, 3, 4]], boostCarry: ['capacity', [2, 3, 4]],
    boostHarvest: ['harvest', [3, 5, 7]], boostBuild: ['build', [1.5, 1.8, 2]],
    boostUpgrade: ['upgradeController', [1.5, 1.8, 2]], boostDismantle: ['dismantle', [2, 3, 4]],
    boostHeal: ['heal', [2, 3, 4]], boostTough: ['damage', [0.7, 0.5, 0.3]],
    boostAttack: ['attack', [2, 3, 4]], boostRAttack: ['rangedAttack', [2, 3, 4]],
};
const BOOSTS = Object.fromEntries(Object.keys(COST).map(part => [part, {}]));
for (const [type, resources] of Object.entries(BOOST_CONFIG)) {
    const [action, values] = BOOST_ACTIONS[type];
    resources.forEach((resource, index) => BOOSTS[BOOST_PARTS[type]][resource] = { [action]: values[index] });
}
const TYPES = Object.fromEntries(Object.keys(BOOST_CONFIG).map(type => [
    type === 'boostRAttack' ? 'BoostTypeRangedAttack' : `BoostType${type.slice(5)}`, type,
]));

function position(x, y, roomName = 'W1N1') { return { x, y, roomName }; }
function count(body, part) { return body.filter(item => item === part).length; }
function cost(body) { return body.reduce((total, part) => total + COST[part], 0); }
function config(role, bodyProfile, data = {}) {
    return { name: 'test', displayName: role, role, spawnRoom: 'W1N1', ready: false, working: false,
        spawnPriority: 1, data, ...(bodyProfile === undefined ? {} : { bodyProfile }) };
}

function world({ level = 8, capacity = 12900, available = capacity, prepare = () => false } = {}) {
    const objects = new Map(), calls = [];
    const room = { name: 'W1N1', memory: {}, energyCapacityAvailable: capacity, energyAvailable: available,
        controller: { level, my: true, owner: { username: 'me' }, pos: position(20, 20) },
        containers: [], links: [], getTerrain: () => ({ get: () => 0 }), lookForAt: () => [] };
    const game = { rooms: { [room.name]: room }, creeps: {}, flags: {}, time: 100,
        getObjectById: id => objects.get(id) || null };
    const loader = createSourceLoader({ globals: {
        Game: game, Memory: {}, BODYPART_COST: COST, BOOSTS, MAX_CREEP_SIZE: 50,
        CARRY_CAPACITY: 50, HARVEST_POWER: 2, HARVEST_MINERAL_POWER: 1, BUILD_POWER: 5,
        SOURCE_ENERGY_CAPACITY: 3000, ENERGY_REGEN_TIME: 300, EXTRACTOR_COOLDOWN: 5,
        CONTROLLER_MAX_UPGRADE_PER_TICK: 15,
        PWR_REGEN_SOURCE: 13, POWER_INFO: { 13: { effect: [50, 100, 150, 200, 250], period: 15 } },
        TERRAIN_MASK_WALL: 1, LOOK_STRUCTURES: 'structure', STRUCTURE_RAMPART: 'rampart',
        OBSTACLE_OBJECT_TYPES: ['spawn', 'extension', 'link', 'storage', 'tower', 'constructedWall'],
        WORK: 'work', CARRY: 'carry', MOVE: 'move', CLAIM: 'claim', TOUGH: 'tough',
        ATTACK: 'attack', RANGED_ATTACK: 'ranged_attack', HEAL: 'heal',
    }, modules: {
        'settings/boost': { boostConfig: BOOST_CONFIG, boostBodyPart: BOOST_PARTS, boostTypeEnum: TYPES },
        'creep/boosting': { canPrepareBoosts: (candidateRoom, plan) => {
            calls.push(plan); return prepare(plan, candidateRoom);
        } },
    } });
    return { ...loader.load('creep/bodyPlanner'), room, game, objects, calls, loader,
        policy: loader.load('settings/bodyPolicy').bodyPolicy };
}

test('melee duos spend their attacker slots on offence and armour instead of unused self-heal parts', () => {
    const w = world();
    const solo = w.previewCreepBody(w.room, config('attacker'), 3);
    const duoConfig = config('attacker'); duoConfig.isTeam = true;
    const duo = w.previewCreepBody(w.room, duoConfig, 3);
    assert.ok(count(solo.body, 'heal') > 0);
    assert.equal(count(duo.body, 'heal'), 0);
    assert.ok(count(duo.body, 'attack') > count(solo.body, 'attack'));
    assert.equal(duo.boostPlan.steps.some(step => step.type === 'boostHeal'), false);
});

test('native templates keep every supported role affordable and legal without assuming MOVE boosts', () => {
    const w = world();
    const settings = w.loader.load('settings/creep');
    for (const [role, tiers] of Object.entries(settings.bodyConfigs)) {
        if (role === 'rAttacker') { assert.equal(tiers.length, 0); continue; }
        assert.ok(tiers.length > 0, role);
        let previous = 0;
        for (const tier of tiers) {
            const parts = Object.entries(tier).flatMap(([part, amount]) => Array(amount).fill(part));
            assert.ok(parts.length > 0 && parts.length <= 50, `${role}: size`);
            assert.ok(count(parts, 'move') > 0, `${role}: MOVE`);
            assert.ok(cost(parts) >= previous, `${role}: monotonic cost`);
            previous = cost(parts);
        }
    }
    assert.deepEqual(JSON.parse(JSON.stringify(settings.spawnPriority)), {
        manager: 0, harvester: 1, filler: 2, processer: 3, scout: 3, builder: 4, upgrader: 5, repairer: 6, miner: 7,
        claimer: 9, rHarvester: 10, rFiller: 11, rBuilder: 12, reserver: 13, sClaimer: 9, sBuilder: 12, sHauler: 12, sScout: 8,
        integrate: 3, defender: 3, rdefender: 3, attacker: 14, healer: 15, rAttacker: 16, dismantler: 17, cAttacker: 17,
    });
});

test('every role and terrain obey budget, native part names and the 50-part maximum', () => {
    const w = world();
    for (const role of Object.keys(w.loader.load('settings/creep').bodyConfigs)) {
        for (const terrain of ['road', 'plain', 'swamp']) for (const budget of [0, 50, 100, 130, 200, 300, 650, 1300, 3000, 12900]) {
            w.room.energyCapacityAvailable = budget;
            const plan = w.planCreepBody(w.room, config(role, { boostTier: 0, terrain }));
            assert.ok(plan.body.length <= 50, `${role}/${terrain}/${budget}`);
            assert.ok(cost(plan.body) <= budget, `${role}/${terrain}/${budget}`);
            assert.ok(plan.body.every(part => COST[part] !== undefined));
            assert.equal(plan.boostPlan.tier, 0);
            assert.equal(plan.boostPlan.steps.length, 0);
            if (role === 'rAttacker') assert.equal(plan.body.length, 0);
        }
    }
    assert.equal(w.calls.length, 0, 'explicit native bodies never inspect laboratories');
});

test('boost previews remain legal and accurately count every proposed compound across roles and budgets', () => {
    const w = world();
    for (const role of Object.keys(w.loader.load('settings/creep').bodyConfigs)) {
        for (const tier of [1, 2, 3]) for (const terrain of ['road', 'plain', 'swamp']) {
            for (const budget of [200, 650, 1300, 3000, 12900]) {
                w.room.energyCapacityAvailable = budget;
                const plan = w.previewCreepBody(w.room, config(role, { terrain }), tier);
                assert.ok(plan.body.length <= 50 && cost(plan.body) <= budget, `${role}/${tier}/${terrain}/${budget}`);
                const boostedParts = new Set();
                for (const step of plan.boostPlan.steps) {
                    const part = BOOST_PARTS[step.type];
                    assert.ok(!boostedParts.has(part), 'one compound per body part type');
                    boostedParts.add(part);
                    assert.equal(step.parts, count(plan.body, part));
                    assert.equal(step.resource, BOOST_CONFIG[step.type][tier - 1]);
                }
            }
        }
    }
});

test('capacity planning waits at the spawn while forceSpawn uses only energy available', () => {
    const w = world({ capacity: 3000, available: 300 });
    const normal = w.planCreepBody(w.room, config('builder'));
    const emergency = w.planCreepBody(w.room, config('builder'), true);
    assert.ok(cost(normal.body) > 300);
    assert.ok(cost(emergency.body) <= 300);
    assert.ok(emergency.body.length > 0);
    assert.equal(cost(w.planCreepBody(w.room, config('builder', { maximumCost: 200 })).body), 200);
    assert.equal(w.planCreepBody(w.room, config('builder', { maximumCost: 0 })).body.length, 0);
});

test('per-demand profile overrides room and policy fields independently', () => {
    const w = world();
    w.policy.profiles.filler = { terrain: 'swamp', carryParts: 12, maximumCost: 2000 };
    w.room.memory.bodyProfiles = { filler: { terrain: 'road', carryParts: 8 } };
    const native = w.planCreepBody(w.room, config('filler', { carryParts: 6 }));
    assert.equal(count(native.body, 'carry'), 6);
    assert.equal(count(native.body, 'move'), 3);
    assert.equal(count(w.planCreepBody(w.room, config('manager', { carryParts: 0 })).body, 'carry'), 1);
});

test('economic and local defence defaults stay native and never wait for boost stock', () => {
    const w = world({ prepare: () => { throw new Error('unexpected preflight'); } });
    for (const role of ['builder', 'repairer', 'rBuilder', 'filler', 'harvester', 'defender', 'rdefender']) {
        assert.equal(w.planCreepBody(w.room, config(role)).boostPlan.tier, 0);
    }
    assert.equal(w.calls.length, 0);
});

test('automatic offensive tiers select the highest prepared exact plan and rebuild on native fallback', () => {
    const w = world({ prepare: plan => plan.tier === 2 });
    const plan = w.planCreepBody(w.room, config('attacker'));
    assert.equal(plan.boostPlan.tier, 2);
    assert.deepEqual(w.calls.map(item => item.tier), [3, 2]);
    for (const step of plan.boostPlan.steps) {
        assert.equal(step.parts, count(plan.body, BOOST_PARTS[step.type]));
        assert.equal(step.resource, BOOST_CONFIG[step.type][1]);
    }
    const unavailable = world();
    const native = unavailable.planCreepBody(unavailable.room, config('attacker'));
    assert.equal(native.boostPlan.tier, 0);
    assert.ok(count(native.body, 'move') >= native.body.length - count(native.body, 'move'));
    assert.deepEqual(unavailable.calls.map(item => item.tier), [3, 2, 1]);
});

test('explicit tier never silently substitutes a different compound and supports wait or native fallback', () => {
    const w = world({ prepare: plan => plan.tier === 1 });
    const waiting = w.planCreepBody(w.room, config('filler', { boostTier: 3, boostFallback: 'wait' }));
    assert.equal(waiting.body.length, 0);
    assert.equal(waiting.boostPlan.tier, 3);
    assert.deepEqual(w.calls.map(item => item.tier), [3]);
    w.calls.length = 0;
    const fallback = w.planCreepBody(w.room, config('filler', { boostTier: 3 }));
    assert.equal(fallback.boostPlan.tier, 0);
    assert.deepEqual(w.calls.map(item => item.tier), [3]);
    assert.equal(count(fallback.body, 'move'), Math.ceil(count(fallback.body, 'carry') / 2));
});

test('preview generates all tiers at capacity without checking available energy, labs or changing Memory', () => {
    const w = world({ capacity: 3000, available: 0, prepare: () => { throw new Error('preview preflight'); } });
    const cfg = config('filler', { carryParts: 12, terrain: 'plain' });
    const before = JSON.stringify([w.room.memory, cfg]);
    for (const tier of [0, 1, 2, 3]) {
        const plan = w.previewCreepBody(w.room, cfg, tier);
        assert.equal(plan.boostPlan.tier, tier);
        assert.ok(cost(plan.body) <= 3000 && plan.body.length > 0);
    }
    assert.equal(w.calls.length, 0);
    assert.equal(JSON.stringify([w.room.memory, cfg]), before);
});

test('terrain fatigue uses native MOVE recovery and fully loaded actual CARRY weight', () => {
    const w = world({ prepare: () => true });
    for (const [terrain, fatigue] of [['road', 1], ['plain', 2], ['swamp', 10]]) {
        for (const tier of [0, 1, 2, 3]) {
            const plan = w.previewCreepBody(w.room, config('sHauler', { carryParts: 8, terrain }), tier);
            const expectedCarry = Math.ceil(8 / [1, 2, 3, 4][tier]);
            assert.equal(count(plan.body, 'carry'), expectedCarry);
            assert.equal(count(plan.body, 'move'), Math.ceil(expectedCarry * fatigue / (2 * [1, 2, 3, 4][tier])));
        }
    }
});

test('mature local roads, young-room plains and remote unknown roads have distinct safe defaults', () => {
    const local = world({ level: 8 });
    const young = world({ level: 3 });
    const cfg = config('filler', { carryParts: 8 });
    assert.equal(count(local.planCreepBody(local.room, cfg).body, 'move'), 4);
    assert.equal(count(young.planCreepBody(young.room, cfg).body, 'move'), 8);
    for (const role of ['sHauler', 'rFiller']) {
        assert.equal(count(local.planCreepBody(local.room, config(role, { carryParts: 8 })).body, 'move'), 8);
    }
    const manager = young.planCreepBody(young.room, config('manager'));
    assert.equal(count(manager.body, 'carry'), 49);
    assert.equal(count(manager.body, 'move'), 1);
});

test('native hub manager plans all 50 parts even when its replacement must wait for refill', () => {
    const w = world({ capacity: 3000, available: 300 });
    const plan = w.planCreepBody(w.room, config('manager'));
    assert.equal(plan.body.length, 50);
    assert.equal(count(plan.body, 'carry'), 49);
    assert.equal(count(plan.body, 'move'), 1);
    assert.equal(cost(plan.body), 2500);
});

test('source work respects regeneration, neutral capacity and native harvest compounds', () => {
    const w = world();
    const source = { id: 'source', room: w.room, energyCapacity: 3000, pos: position(10, 10) };
    w.objects.set(source.id, source);
    w.room.containers.push({ pos: position(10, 11) });
    for (const [tier, work] of [[0, 5], [1, 2], [2, 1], [3, 1]]) {
        const plan = w.previewCreepBody(w.room, config('harvester', { terrain: 'plain' }, { sourceId: source.id }), tier);
        assert.equal(count(plan.body, 'work'), work);
        assert.equal(count(plan.body, 'carry'), 1);
        assert.equal(count(plan.body, 'move'), Math.ceil(work / [1, 2, 3, 4][tier]), 'travel excludes empty CARRY only');
    }
    source.energyCapacity = 1500;
    assert.equal(count(w.previewCreepBody(w.room, config('harvester', {}, { sourceId: source.id }), 0).body, 'work'), 3);
    source.energyCapacity = 3000;
    assert.equal(count(w.previewCreepBody(w.room, config('harvester', { workParts: 2 }, { sourceId: source.id }), 0).body, 'work'), 2);
});

test('source without a confirmed station keeps carrying capacity and loaded movement', () => {
    const w = world();
    const source = { id: 'source', room: w.room, energyCapacity: 3000, pos: position(10, 10) };
    w.objects.set(source.id, source);
    const plan = w.planCreepBody(w.room, config('harvester', { terrain: 'plain' }, { sourceId: source.id }));
    assert.equal(count(plan.body, 'work'), 5);
    assert.equal(count(plan.body, 'carry'), 10);
    assert.equal(count(plan.body, 'move'), 15);
});

test('active PowerCreep source regeneration adds its period output before harvest boosts and WORK bounds', () => {
    const w = world();
    const source = { id: 'powered-source', room: w.room, energyCapacity: 3000, pos: position(10, 10),
        effects: [{ effect: 13, level: 5, ticksRemaining: 200 }] };
    w.objects.set(source.id, source);
    w.room.containers.push({ pos: position(10, 11) });
    const cfg = config('harvester', { terrain: 'road' }, { sourceId: source.id });
    assert.equal(count(w.previewCreepBody(w.room, cfg, 0).body, 'work'), 14);
    assert.equal(count(w.previewCreepBody(w.room, cfg, 0).body, 'carry'), 2, 'old batch and new batch both fit');
    assert.equal(count(w.previewCreepBody(w.room, cfg, 1).body, 'work'), 5);
    assert.equal(count(w.previewCreepBody(w.room, cfg, 3).body, 'work'), 2);
    assert.equal(count(w.previewCreepBody(w.room, { ...cfg, bodyProfile: { workParts: 6 } }, 0).body, 'work'), 6);
    source.effects[0].ticksRemaining = 0;
    assert.equal(count(w.previewCreepBody(w.room, cfg, 0).body, 'work'), 5);
});

test('stationary source boost plans request only compounds required by selected physical WORK and capacity', () => {
    const w = world({ prepare: plan => plan.steps.every(step => step.type === 'boostHarvest') });
    const source = { id: 'source', room: w.room, energyCapacity: 3000, pos: position(10, 10) };
    w.objects.set(source.id, source);
    w.room.containers.push({ pos: position(10, 11) });
    const cfg = config('harvester', { terrain: 'road', boostTier: 3 }, { sourceId: source.id });
    const plain = w.planCreepBody(w.room, cfg);
    assert.equal(plain.boostPlan.tier, 3, 'XUHO2 alone prepares the 1WORK/1CARRY/1MOVE station miner');
    assert.deepEqual(Array.from(plain.boostPlan.steps, step => step.type), ['boostHarvest']);
    source.effects = [{ effect: 13, level: 5, ticksRemaining: 200 }];
    const powered = w.previewCreepBody(w.room, cfg, 3);
    assert.equal(count(powered.body, 'work'), 2);
    assert.equal(count(powered.body, 'carry'), 1);
    assert.equal(count(powered.body, 'move'), 1);
    assert.deepEqual(Array.from(powered.boostPlan.steps, step => step.type), ['boostHarvest', 'boostCarry']);
    const manager = w.previewCreepBody(w.room, config('manager'), 3);
    assert.deepEqual(Array.from(manager.boostPlan.steps, step => step.type), ['boostCarry']);
});

test('nearby source/controller buffers are stationary only when a permanent shared walkable seat exists', () => {
    const w = world();
    const source = { id: 'source', room: w.room, energyCapacity: 3000, pos: position(10, 10) };
    w.objects.set(source.id, source);
    w.room.links.push({ my: true, pos: position(12, 10) });
    // The only shared x=11 column is rock. A link within range 2 is insufficient by itself.
    w.room.getTerrain = () => ({ get: (x) => x === 11 ? 1 : 0 });
    assert.equal(count(w.previewCreepBody(w.room, config('harvester', {}, { sourceId: source.id }), 0).body, 'carry'), 10);
    w.room.getTerrain = () => ({ get: () => 0 });
    assert.equal(count(w.previewCreepBody(w.room, config('harvester', {}, { sourceId: source.id }), 0).body, 'carry'), 1);
    const supply = { id: 'supply', store: {}, pos: position(24, 20) };
    w.objects.set(supply.id, supply);
    w.room.lookForAt = (_type, x) => x === 23 ? [{ structureType: 'storage' }] : [];
    const upgrade = config('upgrader', { workParts: 4 }, { sourceId: supply.id });
    assert.equal(count(w.previewCreepBody(w.room, upgrade, 0).body, 'carry'), 4);
    w.room.lookForAt = () => [];
    assert.equal(count(w.previewCreepBody(w.room, upgrade, 0).body, 'carry'), 1);
});

test('one-MOVE scouts and plain claimers do not request useless MOVE compounds', () => {
    const w = world({ prepare: () => { throw new Error('no useful boost'); } });
    for (const role of ['scout', 'sScout', 'claimer', 'sClaimer']) {
        const plan = w.planCreepBody(w.room, config(role, { boostTier: 3 }));
        assert.equal(plan.boostPlan.steps.length, 0);
        assert.ok(plan.body.length > 0);
    }
    assert.equal(w.calls.length, 0);
});

test('mineral mining keeps large WORK, cooldown-sized batches and loaded movement', () => {
    const w = world();
    const plan = w.previewCreepBody(w.room, config('miner', { terrain: 'road' }), 0);
    assert.equal(count(plan.body, 'work'), 20);
    assert.equal(count(plan.body, 'carry'), 10);
    assert.equal(count(plan.body, 'move'), 15);
    const boosted = w.previewCreepBody(w.room, config('miner', { terrain: 'road' }), 3);
    assert.equal(count(boosted.body, 'work'), 20);
    assert.ok(count(boosted.body, 'carry') * 50 * 4 >= 20 * 7 / 5 * 40 * 3);
});

test('self-hauling mineral bodies budget travel and choose throughput over blind maximum WORK', () => {
    const w = world({ capacity: 3000 });
    const mineral = { id: 'mineral', mineralType: 'H', pos: position(10, 10) };
    w.objects.set(mineral.id, mineral);
    w.room.storage = { pos: position(30, 10) };
    const plan = w.previewCreepBody(w.room, config('miner', { terrain: 'road' }, { sourceId: mineral.id }), 0);
    const work = count(plan.body, 'work'), carry = count(plan.body, 'carry');
    const trip = 52;
    const rate = work / 5;
    const throughput = rate * carry * 50 / (carry * 50 + rate * trip);
    const blind20W2CThroughput = 4 * 100 / (100 + 4 * trip);
    assert.ok(throughput > blind20W2CThroughput * 1.5);
    assert.ok(work < 20, 'smaller WORK leaves room and energy for profitable carrying capacity');
    assert.ok(cost(plan.body) <= 3000);
});

test('RCL8 upgrading keeps up to fifteen actual WORK with every upgrade boost tier', () => {
    const w = world();
    const supply = { id: 'controller-container', pos: position(20, 22), store: {} };
    w.objects.set(supply.id, supply);
    for (const tier of [0, 1, 2, 3]) {
        const plan = w.previewCreepBody(w.room, config('upgrader', { workParts: 50 }, { sourceId: supply.id }), tier);
        assert.equal(count(plan.body, 'work'), 15);
        const step = plan.boostPlan.steps.find(item => item.type === 'boostUpgrade');
        if (tier > 0) assert.equal(step.parts, 15);
    }
    assert.equal(count(w.previewCreepBody(w.room, config('upgrader', { workParts: 3 }, { sourceId: supply.id }), 3).body, 'work'), 3);
    w.objects.delete(supply.id);
    const mobile = w.previewCreepBody(w.room, config('upgrader'), 0);
    assert.equal(count(mobile.body, 'work'), 15);
    assert.equal(count(mobile.body, 'carry'), 15);
    assert.equal(count(mobile.body, 'move'), 15);
});

test('mobile remote builders carry useful loads instead of relying on 39WORK/1CARRY templates', () => {
    const w = world();
    const plan = w.planCreepBody(w.room, config('rBuilder'));
    assert.ok(count(plan.body, 'carry') >= count(plan.body, 'work'));
    assert.equal(count(plan.body, 'move'), count(plan.body, 'carry') + count(plan.body, 'work'));
    for (const role of ['harvester', 'builder', 'upgrader', 'repairer', 'miner', 'rHarvester', 'rBuilder', 'sBuilder']) {
        w.room.energyCapacityAvailable = 200;
        assert.equal(cost(w.planCreepBody(w.room, config(role)).body), 200, role);
    }
});

test('scouts and claimers stay minimal; reservers add only the safe urgent second CLAIM', () => {
    const w = world();
    for (const role of ['scout', 'sScout']) assert.deepEqual(Array.from(w.planCreepBody(w.room, config(role)).body), ['move']);
    for (const role of ['claimer', 'sClaimer', 'reserver']) {
        assert.deepEqual(Array.from(w.planCreepBody(w.room, config(role, {}, { targetRoom: 'W2N1' })).body), ['claim', 'move']);
    }
    const target = { controller: { reservation: { username: 'me', ticksToEnd: 500 } } };
    w.game.rooms.W2N1 = target;
    assert.equal(count(w.planCreepBody(w.room, config('reserver', {}, { targetRoom: 'W2N1' })).body, 'claim'), 2);
    target.controller.reservation.username = 'other';
    assert.equal(count(w.planCreepBody(w.room, config('reserver', {}, { targetRoom: 'W2N1' })).body, 'claim'), 1);
    assert.ok(count(w.planCreepBody(w.room, config('cAttacker')).body, 'claim') <= 19);
});

test('combat bodies retain full-speed movement, front armour and tail healing', () => {
    const w = world();
    for (const role of ['attacker', 'healer', 'dismantler', 'integrate', 'defender', 'rdefender']) {
        for (const tier of [0, 1, 2, 3]) {
            const plan = w.previewCreepBody(w.room, config(role, { terrain: 'plain' }), tier);
            const moving = count(plan.body, 'move'), weight = plan.body.length - moving;
            assert.ok(moving * 2 * [1, 2, 3, 4][tier] >= weight * 2, `${role}/${tier}`);
            if (count(plan.body, 'tough') > 0) assert.equal(plan.body[0], 'tough');
            if (count(plan.body, 'heal') > 0) assert.equal(plan.body.at(-1), 'heal');
            if (role === 'defender' || role === 'rdefender') assert.equal(count(plan.body, 'tough'), 0);
        }
    }
});

test('invalid edited part counts cannot leak fractional or oversized body arrays', () => {
    const w = world();
    for (const carryParts of [NaN, Infinity, -10, 0, 0.5, 5000]) {
        const plan = w.planCreepBody(w.room, config('filler', { carryParts }));
        assert.ok(plan.body.length > 0 && plan.body.length <= 50);
        assert.ok(cost(plan.body) <= w.room.energyCapacityAvailable);
    }
    for (const workParts of [NaN, Infinity, -10, 0, 0.5, 5000]) {
        const plan = w.planCreepBody(w.room, config('builder', { workParts, carryParts: 1 }));
        assert.ok(plan.body.length > 0 && plan.body.length <= 50);
    }
});
