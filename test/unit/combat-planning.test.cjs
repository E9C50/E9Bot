const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const native = require('../helpers/native-bodies.cjs');

const COST = { work: 100, carry: 50, move: 50, claim: 600, tough: 10, attack: 80, ranged_attack: 150, heal: 250 };
// Real Screeps compound names/effects; settings/boost and both body engines load unchanged.
const COMPOUNDS = [
    ['move', 'fatigue', [2, 3, 4], [['ZYNTHIUM_OXIDE', 'ZO'], ['ZYNTHIUM_ALKALIDE', 'ZHO2'], ['CATALYZED_ZYNTHIUM_ALKALIDE', 'XZHO2']]],
    ['carry', 'capacity', [2, 3, 4], [['KEANIUM_HYDRIDE', 'KH'], ['KEANIUM_ACID', 'KH2O'], ['CATALYZED_KEANIUM_ACID', 'XKH2O']]],
    ['work', 'build', [1.5, 1.8, 2], [['LEMERGIUM_HYDRIDE', 'LH'], ['LEMERGIUM_ACID', 'LH2O'], ['CATALYZED_LEMERGIUM_ACID', 'XLH2O']]],
    ['work', 'upgradeController', [1.5, 1.8, 2], [['GHODIUM_HYDRIDE', 'GH'], ['GHODIUM_ACID', 'GH2O'], ['CATALYZED_GHODIUM_ACID', 'XGH2O']]],
    ['work', 'harvest', [3, 5, 7], [['UTRIUM_OXIDE', 'UO'], ['UTRIUM_ALKALIDE', 'UHO2'], ['CATALYZED_UTRIUM_ALKALIDE', 'XUHO2']]],
    ['work', 'dismantle', [2, 3, 4], [['ZYNTHIUM_HYDRIDE', 'ZH'], ['ZYNTHIUM_ACID', 'ZH2O'], ['CATALYZED_ZYNTHIUM_ACID', 'XZH2O']]],
    ['heal', 'heal', [2, 3, 4], [['LEMERGIUM_OXIDE', 'LO'], ['LEMERGIUM_ALKALIDE', 'LHO2'], ['CATALYZED_LEMERGIUM_ALKALIDE', 'XLHO2']]],
    ['tough', 'damage', [0.7, 0.5, 0.3], [['GHODIUM_OXIDE', 'GO'], ['GHODIUM_ALKALIDE', 'GHO2'], ['CATALYZED_GHODIUM_ALKALIDE', 'XGHO2']]],
    ['attack', 'attack', [2, 3, 4], [['UTRIUM_HYDRIDE', 'UH'], ['UTRIUM_ACID', 'UH2O'], ['CATALYZED_UTRIUM_ACID', 'XUH2O']]],
    ['ranged_attack', 'rangedAttack', [2, 3, 4], [['KEANIUM_OXIDE', 'KO'], ['KEANIUM_ALKALIDE', 'KHO2'], ['CATALYZED_KEANIUM_ALKALIDE', 'XKHO2']]],
];
const RESOURCES = {}, BOOSTS = Object.fromEntries(Object.keys(COST).map(part => [part, {}]));
for (const [part, action, effects, compounds] of COMPOUNDS) compounds.forEach(([name, resource], index) => {
    RESOURCES[`RESOURCE_${name}`] = resource;
    BOOSTS[part][resource] = { [action]: effects[index] };
});
const count = (body, part) => body.filter(value => value === part).length;
const cost = body => body.reduce((sum, part) => sum + COST[part], 0);
function requirement(plans) {
    const result = {};
    for (const plan of plans) for (const step of plan.steps) result[step.resource] = (result[step.resource] || 0) + step.parts * 30;
    return result;
}

function world({ capacity = 12900, stock = Infinity, reserved = {} } = {}) {
    const stockChecks = [], previews = [], memory = { combatTasks: {} };
    const room = { name: 'W1N1', memory: {}, energyCapacityAvailable: capacity, energyAvailable: capacity,
        controller: { level: 8, my: true, owner: { username: 'me' } } };
    const game = { time: 100, shard: { name: 'shard3' }, rooms: { [room.name]: room }, creeps: {}, flags: {},
        map: { getRoomTerrain: () => ({ get: () => 0 }) } };
    let resources = stock;
    const loader = createSourceLoader({ globals: { ...native.globals, ...RESOURCES, Game: game, Memory: memory,
        BODYPART_COST: COST, BOOSTS, ATTACK_POWER: 30, RANGED_ATTACK_POWER: 10, HEAL_POWER: 12, DISMANTLE_POWER: 50,
        TOWER_POWER_ATTACK: 600, TOWER_OPTIMAL_RANGE: 5, TOWER_FALLOFF_RANGE: 20, TOWER_FALLOFF: 0.75,
        TERRAIN_MASK_WALL: 1, LAB_BOOST_MINERAL: 30, LAB_BOOST_ENERGY: 20,
    }, modules: { 'creep/boosting': {
        canPrepareBoosts() { throw new Error('Capacity preview must not select/rebuild bodies through live boost availability'); },
        canPrepareBoostGroup(candidateRoom, plans) {
            assert.equal(candidateRoom, room);
            const required = requirement(plans);
            stockChecks.push({ plans, required });
            return Object.entries(required).every(([resource, amount]) => amount + (reserved[resource] || 0) <=
                (typeof resources === 'number' ? resources : resources[resource] || 0));
        },
    } } });
    const body = loader.load('creep/bodyPlanner'), preview = body.previewCreepBody;
    body.previewCreepBody = (candidateRoom, config, tier) => {
        previews.push({ role: config.role, team: config.isTeam, profile: { ...config.bodyProfile }, tier });
        return preview(candidateRoom, config, tier);
    };
    const api = loader.load('combat/planning');
    const policy = loader.load('settings/combat').combatPolicy;
    function task({ options = {}, intel = {}, ...fields } = {}) {
        return { id: 'current', homeRoom: room.name, targetRoom: 'W2N1', shard: game.shard.name, mode: 'attack', phase: 'planning',
            createdAt: 1, updatedAt: 1, generation: 1, wave: 0, spent: 0, names: [], options,
            intel: { seenAt: game.time, category: 'npc', towers: [], attack: 0, ranged: 0, healing: 0,
                safeModeUntil: 0, protectedUntil: 0, hostileCount: 0, armedCount: 0, objectives: 1, core: 'core', loot: 0, ...intel }, ...fields };
    }
    return { ...api, room, game, memory, previews, stockChecks, policy, task, body,
        setStock(value) { resources = value; }, plan(fields) { return api.planCombatForce(room, task(fields)); } };
}

function legal(plan) {
    assert.ok(plan && plan.members.length > 0);
    for (const member of plan.members) {
        assert.ok(member.body.length > 0 && member.body.length <= 50);
        assert.ok(member.body.every(part => COST[part] !== undefined)); assert.equal(member.energy, cost(member.body));
        const boosts = Object.fromEntries(member.boostPlan.steps.map(step => [step.type, step]));
        for (const step of member.boostPlan.steps) {
            const part = COMPOUNDS.find(([_part, _action, _effects, compounds]) => compounds.some(([_name, resource]) => resource === step.resource))[0];
            assert.equal(step.parts, count(member.body, part), 'stock proposal covers every actual boosted part');
        }
        const movement = boosts.boostMove ? BOOSTS.move[boosts.boostMove.resource].fatigue : 1;
        assert.ok(count(member.body, 'move') * 2 * movement >= (member.body.length - count(member.body, 'move')) * 2,
            'the proposed physical MOVE parts recover one plain tile of fatigue each tick only with their exact prepared boost');
    }
    assert.equal(plan.energy, plan.members.reduce((sum, member) => sum + member.energy, 0));
}

test('a weak NPC objective needs only an affordable native solo when no compounds are available', () => {
    const w = world({ stock: 0 }), plan = w.plan(); legal(plan);
    assert.equal(plan.formation, 'solo'); assert.equal(plan.members[0].boostPlan.tier, 0);
    assert.ok(plan.energy <= cost([...Array(4).fill('ranged_attack'), ...Array(2).fill('heal'), ...Array(6).fill('move')]));
    assert.ok(plan.damage > 0); assert.equal(plan.incoming, 0);
});

test('available compounds do not turn a weak native-feasible objective into an unnecessarily boosted raid', () => {
    const w = world(); const economical = w.plan(); legal(economical);
    assert.equal(economical.formation, 'solo'); assert.equal(economical.members[0].boostPlan.tier, 0);
    assert.ok(economical.members.every(member => member.boostPlan.steps.length === 0));
    const explicitlyBoosted = w.plan({ options: { boostTier: 3 } }); legal(explicitlyBoosted);
    assert.ok(explicitlyBoosted.energy < economical.energy,
        'the native choice accounts for consumables despite the boosted candidate having a cheaper physical body');
});

test('six clustered full-power towers cannot be approved as a cheap unboosted force', () => {
    const w = world(); const towers = Array.from({ length: 6 }, (_, index) => ({ x: 23 + index % 3, y: 23 + Math.floor(index / 3), power: 600 }));
    assert.equal(w.plan({ options: { boostTier: 0 }, intel: { towers, category: 'player', core: undefined } }), undefined);
    const plan = w.plan({ intel: { towers, category: 'player', core: undefined } });
    if (plan) { legal(plan); assert.ok(plan.members.every(member => member.boostPlan.tier > 0)); assert.ok(plan.healing >= plan.incoming * w.policy.safetyMargin); }
});

test('missing the exact MOVE compound rejects a reinforced proposal rather than deploying its reduced MOVE count unboosted', () => {
    const stock = Object.fromEntries(Object.values(RESOURCES).map(resource => [resource, resource === 'XZHO2' ? 0 : 100000]));
    const w = world({ stock }); assert.equal(w.plan({ options: { boostTier: 3, formation: 'duo' } }), undefined);
    assert.ok(w.previews.some(preview => preview.tier === 3));
    assert.ok(w.stockChecks.length > 0 && w.stockChecks.every(check => check.required.XZHO2 > 0));
    const fallback = world({ stock }).plan({ options: { boostTier: 0, formation: 'duo' } }); legal(fallback);
    assert.ok(fallback.members.every(member => count(member.body, 'move') >= member.body.length - count(member.body, 'move')));
});

test('a player healing wall stronger than every feasible offensive formation prevents dispatch', () => {
    const w = world(); assert.equal(w.plan({ intel: { category: 'player', core: undefined, hostileCount: 4, armedCount: 4,
        attack: 600, ranged: 1200, healing: 10000 } }), undefined);
});

test('an invader Core is never delegated to a pure dismantler/healer formation', () => {
    const w = world({ stock: 0 }); const plan = w.plan({ options: { formation: 'duo', boostTier: 0 } }); legal(plan);
    assert.ok(plan.members.some(member => count(member.body, 'attack') + count(member.body, 'ranged_attack') > 0));
    assert.equal(plan.members.some(member => member.role === 'dismantler'), false);
});

test('explicit formation and boost tier remain exact, including native tier zero with existing unrelated boost demand', () => {
    for (const [formation, size, tier] of [['solo', 1, 2], ['duo', 2, 3], ['quad', 4, 0]]) {
        const w = world(); w.memory.combatTasks.other = w.task({ id: 'other', phase: 'spawning',
            plan: { members: [{ boostPlan: { tier: 3, steps: [{ type: 'boostMove', resource: 'XZHO2', parts: 50 }] } }] } });
        const plan = w.plan({ options: { formation, boostTier: tier } }); legal(plan);
        assert.equal(plan.formation, formation); assert.equal(plan.members.length, size);
        assert.ok(plan.members.every(member => member.boostPlan.tier === tier));
        if (tier === 0) assert.ok(w.stockChecks.every(check => check.plans.every(member => member.tier === 0)), 'a native force does not wait for another task\'s compound stock');
    }
});

test('stale reconnaissance stops before previews or stock checks, with the exact max-age boundary accepted', () => {
    const w = world(); assert.equal(w.plan({ intel: { seenAt: w.game.time - w.policy.intelMaxAge - 1 } }), undefined);
    assert.equal(w.previews.length, 0); assert.equal(w.stockChecks.length, 0);
    assert.ok(w.plan({ options: { boostTier: 0 }, intel: { seenAt: w.game.time - w.policy.intelMaxAge } }));
});

test('both physical spawn capacity and remaining task body-energy budget are enforced', () => {
    const limited = world({ capacity: 1300 });
    assert.equal(limited.plan({ options: { boostTier: 0, formation: 'solo' } }), undefined);
    const split = limited.plan({ options: { boostTier: 0 } }); legal(split);
    assert.ok(split.members.every(member => member.energy <= 1300), 'a legal multi-spawn wave is bounded per physical body');
    const w = world(); assert.equal(w.plan({ options: { maxEnergy: 2000, boostTier: 0 }, spent: 1000 }), undefined);
    const plan = w.plan({ options: { maxEnergy: 1400, boostTier: 0 } }); legal(plan); assert.ok(plan.energy <= 1400);
});

test('other not-yet-born task members share the compound pool before an additional complete squad can be planned', () => {
    const reference = world(), original = reference.plan({ options: { formation: 'duo', boostTier: 3 } }); legal(original);
    const stock = requirement(original.members.map(member => member.boostPlan));
    const w = world({ stock }); w.memory.combatTasks.other = w.task({ id: 'other', phase: 'spawning',
        plan: { members: [original.members[0]] }, memberNames: ['pending-other'] });
    assert.equal(w.plan({ options: { formation: 'duo', boostTier: 3 } }), undefined);
    assert.ok(w.stockChecks.some(check => check.plans.length === 3), 'pending reservations are checked together with both new bodies');
    assert.ok(w.stockChecks.every(check => check.plans.includes(original.members[0].boostPlan)));
    w.memory.combatTasks.other.phase = 'completed'; const plan = w.plan({ options: { formation: 'duo', boostTier: 3 } }); legal(plan);
});

test('a born member is left to live boost reservations rather than counting its full pending plan a second time', () => {
    const original = world().plan({ options: { formation: 'duo', boostTier: 3 } });
    const stock = requirement(original.members.map(member => member.boostPlan));
    const reserved = requirement([original.members[0].boostPlan]);
    const w = world({ stock, reserved }); w.memory.combatTasks.other = w.task({ id: 'other', phase: 'spawning',
        plan: { members: [original.members[0]] }, memberNames: ['already-born'] }); w.game.creeps['already-born'] = {};
    assert.equal(w.plan({ options: { formation: 'duo', boostTier: 3 } }), undefined);
    assert.ok(w.stockChecks.every(check => check.plans.length === 2));
});

test('cached real body previews bound the complete candidate search without a brittle wall-clock assertion', t => {
    const w = world({ stock: 0 }); const started = performance.now(); legal(w.plan({ intel: { core: undefined } }));
    const elapsed = performance.now() - started;
    const key = preview => JSON.stringify([preview.role, preview.team, preview.tier, preview.profile]);
    const integrated = w.previews.filter(preview => preview.role === 'integrate');
    assert.equal(new Set(integrated.map(key)).size, integrated.length, 'duo/quad repetitions reuse a physical-body preview');
    assert.ok(w.previews.length <= 500, `candidate previews ${w.previews.length}`);
    assert.ok(w.stockChecks.length <= 500, `inventory preflights ${w.stockChecks.length}`);
    t.diagnostic(`real body previews=${w.previews.length}, stock checks=${w.stockChecks.length}, local benchmark=${elapsed.toFixed(2)} ms (Node, not a live Screeps CPU sample)`);
});


test('front T3 TOUGH requires effective output to beat enemy healing, not just raw ranged damage', () => {
    const w = world();
    const fields = { options: { formation: 'duo', boostTier: 3 }, intel: { category: 'player', core: undefined,
        hostileCount: 1, armedCount: 1, ranged: 600, healing: 240 } };
    const plain = w.plan(fields); legal(plain);
    const armoured = w.plan({ ...fields, intel: { ...fields.intel,
        enemyBodies: [[{ hits: 1000, damageRatio: 0.3 }, { hits: 4000, damageRatio: 1 }]] } });
    if (armoured) {
        legal(armoured); assert.ok(armoured.damage * 0.3 > 240 * w.policy.safetyMargin);
    }
    assert.ok(!armoured || armoured.damage > plain.damage, 'an indefinitely healed front shield cannot be called a viable cheap raid');
});

test('a candidate search yields before spending the reserved operating CPU', () => {
    const w = world(); let calls = 0;
    w.game.cpu = { tickLimit: 500, bucket: 10000, getUsed: () => calls++ === 0 ? 0 : 11 };
    const plan = w.plan({ intel: { hostileCount: 4, armedCount: 4, ranged: 1200, healing: 10000 } });
    assert.equal(plan, undefined); assert.ok(w.previews.length <= 16);
    assert.equal(w.stockChecks.length, 0); assert.ok(calls >= 2);
});
