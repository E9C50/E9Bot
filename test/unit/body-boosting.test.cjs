const assert = require('node:assert/strict');
const test = require('node:test');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

const constants = {
    WORK: 'work', CARRY: 'carry', MOVE: 'move', ATTACK: 'attack', RANGED_ATTACK: 'ranged_attack', HEAL: 'heal', TOUGH: 'tough',
    MAX_CREEP_SIZE: 50, LAB_BOOST_MINERAL: 30, LAB_BOOST_ENERGY: 20, RESOURCE_ENERGY: 'energy',
    OK: 0, ERR_NOT_OWNER: -1, ERR_NOT_FOUND: -5, ERR_NOT_ENOUGH_RESOURCES: -6, ERR_INVALID_TARGET: -7, ERR_NOT_IN_RANGE: -9, ERR_RCL_NOT_ENOUGH: -14,
    FIND_HOSTILE_CREEPS: 'hostiles', LOOK_STRUCTURES: 'structures', COLOR_WHITE: 1,
    RESOURCE_ZYNTHIUM_OXIDE: 'ZO', RESOURCE_ZYNTHIUM_ALKALIDE: 'ZHO2', RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE: 'XZHO2',
    RESOURCE_KEANIUM_HYDRIDE: 'KH', RESOURCE_KEANIUM_ACID: 'KH2O', RESOURCE_CATALYZED_KEANIUM_ACID: 'XKH2O',
    RESOURCE_KEANIUM_OXIDE: 'KO', RESOURCE_KEANIUM_ALKALIDE: 'KHO2', RESOURCE_CATALYZED_KEANIUM_ALKALIDE: 'XKHO2',
    RESOURCE_LEMERGIUM_HYDRIDE: 'LH', RESOURCE_LEMERGIUM_ACID: 'LH2O', RESOURCE_CATALYZED_LEMERGIUM_ACID: 'XLH2O',
    RESOURCE_GHODIUM_HYDRIDE: 'GH', RESOURCE_GHODIUM_ACID: 'GH2O', RESOURCE_CATALYZED_GHODIUM_ACID: 'XGH2O',
    RESOURCE_UTRIUM_OXIDE: 'UO', RESOURCE_UTRIUM_ALKALIDE: 'UHO2', RESOURCE_CATALYZED_UTRIUM_ALKALIDE: 'XUHO2',
    RESOURCE_ZYNTHIUM_HYDRIDE: 'ZH', RESOURCE_ZYNTHIUM_ACID: 'ZH2O', RESOURCE_CATALYZED_ZYNTHIUM_ACID: 'XZH2O',
    RESOURCE_LEMERGIUM_OXIDE: 'LO', RESOURCE_LEMERGIUM_ALKALIDE: 'LHO2', RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE: 'XLHO2',
    RESOURCE_GHODIUM_OXIDE: 'GO', RESOURCE_GHODIUM_ALKALIDE: 'GHO2', RESOURCE_CATALYZED_GHODIUM_ALKALIDE: 'XGHO2',
    RESOURCE_UTRIUM_HYDRIDE: 'UH', RESOURCE_UTRIUM_ACID: 'UH2O', RESOURCE_CATALYZED_UTRIUM_ACID: 'XUH2O'
};

function store(values = {}, capacity = 100000) {
    const result = { ...values };
    Object.defineProperties(result, {
        getUsedCapacity: { value: resource => resource ? result[resource] || 0 : Object.values(result).reduce((sum, amount) => sum + amount, 0) },
        getFreeCapacity: { value: () => capacity - Object.values(result).reduce((sum, amount) => sum + amount, 0) },
        getCapacity: { value: () => capacity }
    });
    return result;
}

function world() {
    const objects = new Map(), calls = [], logs = [], nativeIntents = [];
    let enumerations = 0;
    const members = {};
    const game = {
        time: 100, shard: { name: 'shard3' }, rooms: {}, flags: {},
        creeps: new Proxy(members, { ownKeys(target) { enumerations++; return Reflect.ownKeys(target); } }),
        getObjectById: id => objects.get(id) || null
    };
    class RoomPosition {
        constructor(x, y, roomName = 'W1N1') { Object.assign(this, { x, y, roomName }); }
        getRangeTo(value) { const pos = value.pos || value; return this.roomName === pos.roomName ? Math.max(Math.abs(this.x - pos.x), Math.abs(this.y - pos.y)) : Infinity; }
        isNearTo(value) { return this.getRangeTo(value) <= 1; }
        isEqualTo(value) { return this.getRangeTo(value) === 0; }
        inRangeTo(value, range) { return this.getRangeTo(value) <= range; }
        findInRange() { return []; }
        lookFor() { return []; }
    }
    const policy = { boost: { timeoutTicks: 300, logFailures: true } };
    const loader = createSourceLoader({
        globals: { ...constants, Game: game, Creep: class {}, RoomPosition, console: { log: value => logs.push(value) } },
        modules: {
            'settings/bodyPolicy': { bodyPolicy: policy },
            'settings/settings': { findPathAvoidRooms: [] },
            'settings/creep': { roleAdvEnum: { PROCESSER: 'processer' } },
            'settings/labs': { reactionConfig: {}, reactionSource: {} },
            'settings/roomPolicy': { roomPolicy: { labs: { updateInterval: 10, minimumReactionReagent: 1000 } } },
            utils: { getDistance: (a, b) => a.getRangeTo(b), getOppositeDirection() {}, serializeMovePath() {} }
        }
    });
    const CreepExtension = loader.load('mount/extension/CreepExtension').default;
    const boost = loader.load('creep/boosting'), labController = loader.load('room/labs'), settings = loader.load('settings/boost');
    const p = (x, y, name = 'W1N1') => new RoomPosition(x, y, name);
    function room(name = 'W1N1') {
        const result = {
            name, my: true, enemies: [], controller: { my: true, level: 8 }, labs: [],
            memory: { boostNeed: {}, roomLabConfig: { sourceLab1: 'source1', sourceLab2: 'source2', singleLabConfig: {} }, roomFillJob: {} },
            storage: { store: store({}) }, terminal: { store: store({}) }
        };
        const spawn = { id: `spawn-${name}`, my: true, pos: p(10, 9, name), recycleCreep: creep => { calls.push({ method: 'recycle', name: creep.name }); return 0; } };
        result.spawns = [spawn]; objects.set(spawn.id, spawn); game.rooms[name] = result;
        return result;
    }
    const home = room();
    function lab(id, resource, amount = 0, energy = 2000, targetRoom = home) {
        const result = {
            id, room: targetRoom, my: true, cooldown: 0, pos: p(11, 10, targetRoom.name), mineralType: resource,
            store: store({ energy, ...(resource ? { [resource]: amount } : {}) }), isActive: () => true,
            boostReturn: 0,
            boostCreep(creep, parts) {
                calls.push({ method: 'boostCreep', id, name: creep.name, parts, resource: result.mineralType });
                if (result.boostReturn === 0) nativeIntents.push({ lab: result, creep, parts });
                return result.boostReturn;
            }
        };
        targetRoom.labs.push(result); objects.set(id, result); return result;
    }
    function plan(tier = 1, type = 'boostUpgrade', parts = 2) {
        return tier === 0 ? { tier: 0, steps: [] } : { tier, steps: [{ type, resource: settings.boostConfig[type][tier - 1], parts }] };
    }
    const body = (type, count, boost) => Array.from({ length: count }, () => ({ type, hits: 100, ...(boost ? { boost } : {}) }));
    function creep(name = 'worker', parts = body('work', 2), boostPlan = plan(), role = 'upgrader', targetRoom = home) {
        const result = new CreepExtension();
        Object.assign(result, {
            name, id: name, room: targetRoom, pos: p(10, 10, targetRoom.name), body: parts,
            store: store({}), memory: { role, spawnRoom: targetRoom.name, ...(boostPlan === undefined ? {} : { boostPlan }) },
            spawning: false, fatigue: 0, hits: 300, hitsMax: 300,
            getActiveBodyparts: type => result.body.filter(part => part.type === type && part.hits > 0).length,
            moveTo: (target, options) => { calls.push({ method: 'moveTo', name, target: target.id, range: options?.range }); return 0; },
            heal: target => { calls.push({ method: 'heal', name, target: target.id }); return 0; }
        });
        members[name] = result; objects.set(name, result); return result;
    }
    function configure(target, type, tier) {
        home.memory.roomLabConfig.singleLabConfig[target.id] = { boostMode: true, boostType: type, resourceType: settings.boostConfig[type][tier - 1] };
    }
    function resolve() {
        for (const { lab: target, creep: unit, parts } of nativeIntents.splice(0)) {
            const resource = target.mineralType;
            const type = Object.keys(settings.boostConfig).find(key => settings.boostConfig[key].includes(resource));
            const ordered = settings.boostBodyPart[type] === 'tough' ? unit.body : [...unit.body].reverse();
            let applied = 0;
            for (const part of ordered) if (part.hits > 0 && !part.boost && part.type === settings.boostBodyPart[type] && applied < parts) { part.boost = resource; applied++; }
            target.store[resource] -= applied * 30; target.store.energy -= applied * 20;
        }
        game.time++;
    }
    return {
        game, members, home, objects, calls, logs, loader, settings, policy, p, room, lab, plan, body, creep, configure, resolve,
        ...boost, ...labController, enumerations: () => enumerations,
        intents: method => calls.filter(call => call.method === method), clear: () => { calls.length = 0; }
    };
}

test('boost helpers import without Game and native empty plans skip legacy defaults without reading the body', () => {
    const loader = createSourceLoader({ globals: constants, modules: { 'settings/bodyPolicy': { bodyPolicy: { boost: {} } } } });
    assert.equal(typeof loader.load('creep/boosting').canPrepareBoosts, 'function');
    assert.equal(loader.globals.Game, undefined);
    const w = world(), unit = w.creep('native', [], w.plan(0), 'attacker');
    Object.defineProperty(unit, 'body', { get() { throw new Error('empty plan read body'); } });
    assert.equal(unit.goBoost(), true);
    assert.equal(unit.memory.boostPlan.completed, true);
    assert.equal(w.calls.length, 0);
});

test('paused, completed and cancelled dismantle orders release boost requests and never submit native boost intents', () => {
    for (const state of ['paused', 'completed', 'cancelled']) {
        const w = world(), plan = w.plan(3, 'boostDismantle', 2), unit = w.creep('yellow', w.body('work', 2), plan, 'sBuilder');
        unit.memory.targetDismantle = { targetShard: 'shard3', targetRoom: 'W1N1', targets: [], flagName: 'yellow', controlState: 'active' };
        const lab = w.lab('dismantle', plan.steps[0].resource, 60); w.configure(lab, 'boostDismantle', 3);
        assert.equal(w.getRoomBoostRequests(w.home).length, 1);
        assert.equal(w.getActiveRoomBoostRequests(w.home).length, 1);
        unit.memory.targetDismantle.controlState = state;
        assert.equal(w.getRoomBoostRequests(w.home).length, 0, state);
        assert.equal(w.getActiveRoomBoostRequests(w.home).length, 0, state);
        assert.equal(w.hasActiveRoomBoost(w.home), false, state);
        assert.equal(unit.goBoost(), false, state);
        assert.equal(w.calls.length, 0, state);
        assert.equal(plan.failed, undefined, state);
    }
});

test('same-tick dismantle resume refreshes the boost-only index without enumerating all creeps again', () => {
    const w = world(), plan = w.plan(3, 'boostDismantle', 2), unit = w.creep('yellow', w.body('work', 2), plan, 'sBuilder');
    unit.memory.targetDismantle = { targetShard: 'shard3', targetRoom: 'W1N1', targets: [], flagName: 'yellow', controlState: 'paused' };
    const lab = w.lab('dismantle', plan.steps[0].resource, 60); w.configure(lab, 'boostDismantle', 3);
    assert.equal(w.getActiveRoomBoostRequests(w.home).length, 0);
    assert.equal(w.getRoomBoostRequests(w.home).length, 0);
    assert.equal(w.enumerations(), 1);
    unit.memory.targetDismantle.controlState = 'active'; w.invalidateBoostRequestIndex();
    assert.equal(w.getActiveRoomBoostRequests(w.home).length, 1);
    assert.equal(w.getRoomBoostRequests(w.home).length, 1);
    assert.equal(w.enumerations(), 1);
    assert.equal(unit.goBoost(), false);
    assert.equal(w.intents('boostCreep').length, 1);
});

for (const tier of [1, 2, 3]) test(`T${tier} plans boost exactly their requested compound and part count, completing only after resolution`, () => {
    const w = world(), plan = w.plan(tier), unit = w.creep('worker', w.body('work', 4), plan);
    const lab = w.lab('output', plan.steps[0].resource, 60); w.configure(lab, 'boostUpgrade', tier);
    assert.equal(unit.goBoost(), false);
    assert.equal(plan.completed, false);
    assert.equal(w.intents('boostCreep')[0].parts, 2);
    assert.equal(w.intents('boostCreep')[0].resource, plan.steps[0].resource);
    w.resolve(); assert.equal(unit.goBoost(), true);
    assert.equal(plan.completed, true);
    assert.equal(unit.body.filter(part => part.boost === plan.steps[0].resource).length, 2);
});

test('a T3 lab never satisfies a pending T1 plan just because its boost type matches', () => {
    const w = world(), unit = w.creep(), wrong = w.lab('output', w.plan(3).steps[0].resource, 1000);
    w.configure(wrong, 'boostUpgrade', 3);
    assert.equal(unit.goBoost(), false);
    assert.equal(w.intents('boostCreep').length, 0);
    assert.equal(w.canPrepareBoosts(w.home, unit.memory.boostPlan), false);
});

test('malformed tiers and duplicated WORK action steps fail explicitly and log once', () => {
    const w = world(), invalid = w.plan(); invalid.steps[0].resource = w.plan(3).steps[0].resource;
    const unit = w.creep('wrong-tier', w.body('work', 2), invalid);
    assert.equal(w.canPrepareBoosts(w.home, invalid), false);
    assert.equal(unit.goBoost(), false); assert.equal(invalid.failed, true); assert.equal(w.logs.length, 1);
    unit.goBoost(); assert.equal(w.logs.length, 1);
    const duplicate = w.plan(); duplicate.steps.push(w.plan(1, 'boostBuild').steps[0]);
    assert.equal(w.canPrepareBoosts(w.home, duplicate), false);
});

test('already matched parts are subtracted while wrong-tier body parts cannot be treated as complete', () => {
    const w = world(), plan = w.plan(), unit = w.creep('partial', [...w.body('work', 1, plan.steps[0].resource), ...w.body('work', 1)], plan);
    const lab = w.lab('output', plan.steps[0].resource, 30, 20); w.configure(lab, 'boostUpgrade', 1);
    unit.goBoost(); assert.equal(w.intents('boostCreep')[0].parts, 1);
    w.resolve(); assert.equal(unit.goBoost(), true);
    const wrong = w.creep('wrong-body', w.body('work', 2, w.plan(3).steps[0].resource));
    assert.equal(wrong.goBoost(), false); assert.equal(wrong.memory.boostPlan.failed, true);
});

test('destroyed, inactive, cooling, mineral-short or energy-short labs never receive boost intents', () => {
    for (const condition of ['destroyed', 'inactive', 'cooldown', 'minerals', 'energy']) {
        const w = world(), plan = w.plan(), unit = w.creep(), lab = w.lab('output', plan.steps[0].resource, 60, 40);
        w.configure(lab, 'boostUpgrade', 1);
        if (condition === 'destroyed') w.objects.delete(lab.id);
        if (condition === 'inactive') lab.isActive = () => false;
        if (condition === 'cooldown') lab.cooldown = 3;
        if (condition === 'minerals') lab.store[plan.steps[0].resource] = 59;
        if (condition === 'energy') lab.store.energy = 39;
        assert.equal(unit.goBoost(), false, condition);
        assert.equal(w.intents('boostCreep').length, 0, condition);
    }
});

test('one lab cannot overwrite two creep boosts in a tick and repeated goBoost calls do not duplicate an intent', () => {
    const w = world(), plan = w.plan(1, 'boostUpgrade', 1), lab = w.lab('output', plan.steps[0].resource, 60);
    w.configure(lab, 'boostUpgrade', 1);
    const a = w.creep('a', w.body('work', 1), plan), b = w.creep('b', w.body('work', 1), w.plan(1, 'boostUpgrade', 1));
    a.goBoost(); a.goBoost(); b.goBoost(); assert.equal(w.intents('boostCreep').length, 1);
    w.resolve(); w.clear(); assert.equal(a.goBoost(), true); b.goBoost(); assert.equal(w.intents('boostCreep').length, 1);
});

test('distinct body-type steps progress across ticks with their exact remaining counts', () => {
    const w = world(), plan = w.plan(2), move = w.plan(2, 'boostMove', 1).steps[0]; plan.steps.push(move);
    const unit = w.creep('worker', [...w.body('work', 2), ...w.body('move', 1)], plan);
    const workLab = w.lab('work', plan.steps[0].resource, 60), moveLab = w.lab('move', move.resource, 30);
    w.configure(workLab, 'boostUpgrade', 2); w.configure(moveLab, 'boostMove', 2);
    unit.goBoost(); assert.equal(w.intents('boostCreep')[0].id, workLab.id);
    w.resolve(); w.clear(); unit.goBoost(); assert.equal(w.intents('boostCreep')[0].id, moveLab.id);
    w.resolve(); assert.equal(unit.goBoost(), true);
});

test('missing labs never release a boost-dependent body and timeout returns it for recycling with one log', () => {
    const w = world(), unit = w.creep('dependent', w.body('move', 1), w.plan(3, 'boostMove', 1));
    assert.equal(unit.goBoost(), false);
    w.game.time += w.policy.boost.timeoutTicks;
    assert.equal(unit.goBoost(), false);
    assert.equal(unit.memory.boostPlan.failed, true); assert.equal(w.logs.length, 1);
    assert.equal(w.intents('recycle').length, 1);
    unit.pos = w.p(30, 30); unit.goBoost(); assert.equal(w.logs.length, 1);
    assert.equal(w.intents('moveTo').at(-1).range, 1);
});

test('legacy role defaults become bounded T3 plans rather than waiting forever for an unconfigured lab', () => {
    const w = world(); w.settings.roleBoostConfig.upgrader = ['boostBuild', 'boostUpgrade'];
    const unit = w.creep('legacy', w.body('work', 2), undefined);
    // The factory default supplies a plan; delete it to model a real legacy Memory entry.
    delete unit.memory.boostPlan;
    unit.goBoost(); assert.equal(unit.memory.boostPlan.tier, 3);
    assert.equal(unit.memory.boostPlan.steps.length, 1);
    assert.equal(unit.memory.boostPlan.steps[0].type, 'boostBuild');
    w.game.time += 300; assert.equal(unit.goBoost(), false); assert.equal(unit.memory.boostPlan.failed, true);
});

test('legacy partial matching boosts reserve and apply only the remaining native parts', () => {
    const w = world(); w.settings.roleBoostConfig.attacker = ['boostAttack'];
    const unit = w.creep('legacy', [...w.body('attack', 5, 'XUH2O'), ...w.body('attack', 5)], w.plan(0), 'attacker');
    delete unit.memory.boostPlan;
    const lab = w.lab('output', 'XUH2O', 150, 100); w.configure(lab, 'boostAttack', 3);
    const request = w.getRoomBoostRequests(w.home)[0];
    assert.equal(request.parts, 5); assert.equal(request.resource, 'XUH2O');
    assert.equal(unit.goBoost(), false); assert.equal(unit.memory.boostPlan.steps[0].parts, 10);
    assert.equal(w.intents('boostCreep')[0].parts, 5);
    assert.equal(w.getRoomBoostRequests(w.home)[0].parts, 5);
    w.resolve(); assert.equal(unit.goBoost(), true);
    assert.equal(unit.body.filter(part => part.boost === 'XUH2O').length, 10);
});

test('legacy partial other-tier parts stay intact while native parts receive the legacy compound', () => {
    const w = world(); w.settings.roleBoostConfig.attacker = ['boostAttack'];
    const unit = w.creep('legacy', [...w.body('attack', 1, 'UH'), ...w.body('attack', 2)], w.plan(0), 'attacker');
    delete unit.memory.boostPlan;
    const lab = w.lab('output', 'XUH2O', 60, 40); w.configure(lab, 'boostAttack', 3);
    assert.equal(unit.goBoost(), false); assert.equal(w.intents('boostCreep')[0].parts, 2);
    w.resolve(); assert.equal(unit.goBoost(), true);
    assert.equal(unit.body[0].boost, 'UH'); assert.equal(unit.memory.boostPlan.failed, undefined);
});

test('completed T3 TOUGH damage never revokes boosting or stops duo preparation', () => {
    const w = world();
    const leaderPlan = w.plan(3, 'boostTough', 1); leaderPlan.completed = true;
    const leader = w.creep('leader', [...w.body('tough', 1, 'XGHO2'), ...w.body('attack', 1, 'XUH2O'), ...w.body('move', 1, 'XZHO2')], leaderPlan, 'attacker');
    leader.body[0].hits = 0; leader.hits = 250;
    const healPlan = w.plan(3, 'boostHeal', 1); healPlan.completed = true;
    const healer = w.creep('healer', [...w.body('heal', 1, 'XLHO2'), ...w.body('move', 1, 'XZHO2')], healPlan, 'healer'); healer.pos = w.p(11, 10);
    w.game.flags.duo = { pos: w.p(20, 20), color: 1 };
    const duo = w.loader.load('squard/TeamDuo').default({ teamFlag: 'duo', creepNameList: ['leader', 'healer'] });
    for (let tick = 0; tick < 3; tick++) { assert.equal(duo.prepare(), true); w.game.time++; }
    assert.equal(leaderPlan.failed, undefined); assert.equal(healPlan.failed, undefined);
    assert.equal(w.intents('recycle').length, 0);
    assert.equal(w.intents('boostCreep').length, 0);
});

test('loaded exact labs are prepared without movers; storage-only or wrong-tier empty delivery paths are not', () => {
    const w = world(), plan = w.plan(); w.lab('output', plan.steps[0].resource, 60, 40);
    assert.equal(w.canPrepareBoosts(w.home, plan), true);
    w.home.labs[0].store[plan.steps[0].resource] = 0; w.home.storage.store[plan.steps[0].resource] = 60;
    assert.equal(w.canPrepareBoosts(w.home, plan), false);
    w.creep('processor', [...w.body('carry', 1), ...w.body('move', 1)], w.plan(0), 'processer');
    w.game.time++; assert.equal(w.canPrepareBoosts(w.home, plan), true);
});

test('preflight sums real storage, terminal, lab and processor mineral amounts without writing Memory', () => {
    const w = world(), plan = w.plan(2, 'boostUpgrade', 4), resource = plan.steps[0].resource;
    w.lab('output', resource, 60); w.home.storage.store[resource] = 30; w.home.terminal.store[resource] = 20;
    const carrier = w.creep('processor', [...w.body('carry', 2), ...w.body('move', 2)], w.plan(0), 'processer'); carrier.store[resource] = 10;
    const before = JSON.stringify(w.home.memory), creepBefore = JSON.stringify(carrier.memory), candidateBefore = JSON.stringify(plan);
    assert.equal(w.canPrepareBoosts(w.home, plan), true);
    assert.equal(JSON.stringify(w.home.memory), before); assert.equal(JSON.stringify(carrier.memory), creepBefore); assert.equal(JSON.stringify(plan), candidateBefore);
    w.home.terminal.store[resource] = 19;
    assert.equal(w.canPrepareBoosts(w.home, plan), false, 'Store values remain live within the membership cache');
});

test('energy on a different lab cannot prepare the target lab without a fueled filler', () => {
    const w = world(), plan = w.plan(), resource = plan.steps[0].resource;
    w.lab('target', resource, 60, 0); w.lab('unrelated', 'ZO', 30, 2000);
    assert.equal(w.canPrepareBoosts(w.home, plan), false);
    w.home.storage.store.energy = 40;
    const filler = w.creep('filler', [...w.body('carry', 1), ...w.body('move', 1)], w.plan(0), 'filler'); w.game.time++;
    assert.equal(w.canPrepareBoosts(w.home, plan), true);
    w.home.storage.store.energy = 39; assert.equal(w.canPrepareBoosts(w.home, plan), false);
    filler.store.energy = 1; assert.equal(w.canPrepareBoosts(w.home, plan), true);
});

test('pending or failed boosted processors cannot be counted as mineral delivery capacity', () => {
    const w = world(), plan = w.plan(), resource = plan.steps[0].resource;
    w.lab('target', resource, 0, 40); w.lab('move', 'ZO', 30, 20); w.home.storage.store[resource] = 60;
    const processor = w.creep('processor', [...w.body('carry', 1), ...w.body('move', 1)], w.plan(1, 'boostMove', 1), 'processer');
    assert.equal(w.canPrepareBoosts(w.home, plan), false);
    processor.memory.boostPlan.failed = true; assert.equal(w.canPrepareBoosts(w.home, plan), false);
    processor.memory.boostPlan.failed = false; processor.memory.boostPlan.completed = true;
    assert.equal(w.canPrepareBoosts(w.home, plan), true);
    delete processor.memory.boostPlan; assert.equal(w.canPrepareBoosts(w.home, plan), true);
    w.settings.roleBoostConfig.processer = ['boostMove']; assert.equal(w.canPrepareBoosts(w.home, plan), false);
});

test('pending or failed boosted fillers cannot be counted as lab energy delivery capacity', () => {
    const w = world(), plan = w.plan();
    w.lab('target', plan.steps[0].resource, 60, 0); w.lab('move', 'ZO', 30, 20); w.home.storage.store.energy = 40;
    const filler = w.creep('filler', [...w.body('carry', 1), ...w.body('move', 1)], w.plan(1, 'boostMove', 1), 'filler');
    assert.equal(w.canPrepareBoosts(w.home, plan), false);
    filler.memory.boostPlan.failed = true; assert.equal(w.canPrepareBoosts(w.home, plan), false);
    filler.memory.boostPlan.failed = false; filler.memory.boostPlan.completed = true;
    assert.equal(w.canPrepareBoosts(w.home, plan), true);
});

test('reserved reaction labs cannot be assigned or used as boost stock', () => {
    const w = world(), plan = w.plan(), unit = w.creep(), source = w.lab('source1', plan.steps[0].resource, 60);
    w.configure(source, 'boostUpgrade', 1); w.lab('output', undefined);
    assert.equal(w.canPrepareBoosts(w.home, plan), false);
    w.updateLabBoostConfig(w.home);
    assert.equal(w.home.memory.roomLabConfig.singleLabConfig.source1, undefined);
    assert.equal(w.home.memory.roomLabConfig.singleLabConfig.output.resourceType, plan.steps[0].resource);
    assert.equal(unit.goBoost(), false); assert.equal(w.intents('boostCreep').length, 0);
});

test('preflight subtracts unfinished live parts and releases completed, failed and already matched claims', () => {
    const w = world(), plan = w.plan(), resource = plan.steps[0].resource; w.lab('output', resource, 60, 100);
    const live = w.creep('live', [...w.body('work', 1, resource), ...w.body('work', 1)], plan);
    assert.equal(w.canPrepareBoosts(w.home, w.plan(1, 'boostUpgrade', 1)), true);
    assert.equal(w.canPrepareBoosts(w.home, w.plan()), false);
    live.memory.boostPlan.completed = true; assert.equal(w.canPrepareBoosts(w.home, w.plan()), true);
    live.memory.boostPlan.completed = false; live.memory.boostPlan.failed = true; assert.equal(w.canPrepareBoosts(w.home, w.plan()), true);
    live.memory.boostPlan.failed = false; live.body[1].boost = resource; assert.equal(w.canPrepareBoosts(w.home, w.plan()), true);
});

test('accepted spawn reservations prevent shared-stock double allocation even with the same plan object', () => {
    const w = world(), plan = w.plan(); w.lab('output', plan.steps[0].resource, 60, 100);
    assert.equal(w.canPrepareBoosts(w.home, plan), true);
    w.reserveBoostPlan(w.home, 'first', plan);
    assert.equal(w.canPrepareBoosts(w.home, plan), false);
    w.game.time++; const live = w.creep('first', w.body('work', 2), plan); live.spawning = true;
    assert.equal(w.canPrepareBoosts(w.home, w.plan()), false, 'the next tick uses the spawning body reservation');
    w.home.labs[0].store[plan.steps[0].resource] = 120; w.reserveBoostPlan(w.home, 'first', plan);
    assert.equal(w.canPrepareBoosts(w.home, w.plan()), true, 'one name appearing in Game and heap is counted only once');
});

test('stale queued configs and previous-tick spawn claims never reserve minerals forever', () => {
    const w = world(), plan = w.plan(); w.lab('output', plan.steps[0].resource, 60, 100);
    w.home.memory.creepConfig = { stale: { boostPlan: plan } }; w.home.memory.creepSpawnQueue = ['stale'];
    assert.equal(w.canPrepareBoosts(w.home, w.plan()), true);
    w.reserveBoostPlan(w.home, 'accepted', plan); assert.equal(w.canPrepareBoosts(w.home, w.plan()), false);
    w.game.time++; assert.equal(w.canPrepareBoosts(w.home, w.plan()), true);
});

test('boost demand is refreshed every tick while exact-resource lab reassignment follows its interval', () => {
    const w = world(), a = w.creep('t1', w.body('work', 2), w.plan()), b = w.creep('t3', w.body('work', 3), w.plan(3, 'boostUpgrade', 3));
    w.lab('first', a.memory.boostPlan.steps[0].resource, 60); w.lab('second', b.memory.boostPlan.steps[0].resource, 90);
    w.updateLabBoostConfig(w.home);
    assert.deepEqual({ ...w.home.memory.boostNeed }, { GH: 60, XGH2O: 90 });
    const assigned = w.home.memory.roomLabConfig.singleLabConfig;
    assert.equal(assigned.first.resourceType, 'GH'); assert.equal(assigned.second.resourceType, 'XGH2O');
    w.game.time++; a.body[0].boost = 'GH'; w.updateLabBoostConfig(w.home);
    assert.deepEqual({ ...w.home.memory.boostNeed }, { GH: 30, XGH2O: 90 });
    b.memory.boostPlan.failed = true; w.updateLabBoostConfig(w.home);
    assert.deepEqual({ ...w.home.memory.boostNeed }, { GH: 30 });
    assert.equal(assigned.second.resourceType, 'XGH2O', 'configuration is not rebuilt on an off-cycle tick');
    w.game.time = 110; w.updateLabBoostConfig(w.home); assert.equal(assigned.second, undefined);
});

test('running explicit plans take a scarce output lab before legacy role defaults and clear old hauling jobs', () => {
    const w = world(); w.settings.roleBoostConfig.upgrader = ['boostUpgrade'];
    const legacy = w.creep('legacy', w.body('work', 1), w.plan(0)); delete legacy.memory.boostPlan;
    const current = w.creep('current', w.body('work', 1), w.plan(1, 'boostUpgrade', 1));
    const lab = w.lab('output', 'XGH2O', 30); w.configure(lab, 'boostUpgrade', 3);
    w.home.memory.roomFillJob.labInMineral = [{ labId: lab.id, resourceType: 'XGH2O' }];
    w.updateLabBoostConfig(w.home);
    assert.equal(w.home.memory.roomLabConfig.singleLabConfig.output.resourceType, current.memory.boostPlan.steps[0].resource);
    assert.equal(w.home.memory.roomFillJob.labInMineral.length, 0);
});

test('boost membership scans the empire once across rooms and still rereads live body and Store state', () => {
    const w = world(), second = w.room('W2N2'), firstPlan = w.plan(1, 'boostUpgrade', 1), secondPlan = w.plan(2, 'boostUpgrade', 1);
    w.creep('first', w.body('work', 1), firstPlan); w.creep('second', w.body('work', 1), secondPlan, 'upgrader', second);
    w.getRoomBoostRequests(w.home); w.getRoomBoostRequests(second); w.getRoomBoostRequests(w.home);
    assert.equal(w.enumerations(), 1);
    w.game.time++; w.getRoomBoostRequests(second); assert.equal(w.enumerations(), 2);
    w.game.shard.name = 'shard2'; w.getRoomBoostRequests(w.home); assert.equal(w.enumerations(), 3);
});

test('native empty plans contribute no demand and never scan their bodies during lab aggregation', () => {
    const w = world();
    for (let index = 0; index < 20; index++) {
        const unit = w.creep(`native-${index}`, [], w.plan(0), 'filler');
        Object.defineProperty(unit, 'body', { get() { throw new Error('native body must not be scanned'); } });
    }
    w.updateLabBoostConfig(w.home); w.updateLabBoostConfig(w.home);
    assert.deepEqual({ ...w.home.memory.boostNeed }, {}); assert.equal(w.enumerations(), 1);
});

test('ordinary boost aggregation skips the live-name set until an accepted spawn needs reservation deduplication', () => {
    const w = world();
    let namesAdded = 0;
    w.loader.globals.Set = class extends Set {
        add(value) {
            if (typeof value === 'string' && value.startsWith('native-')) namesAdded++;
            return super.add(value);
        }
    };
    for (let index = 0; index < 20; index++) w.creep(`native-${index}`, [], w.plan(0), 'filler');
    assert.equal(w.getRoomBoostRequests(w.home).length, 0);
    assert.equal(w.getRoomBoostRequests(w.home).length, 0);
    assert.equal(namesAdded, 0, 'no pending spawn means membership names are not inserted into a throwaway Set');
    const pending = w.plan();
    w.reserveBoostPlan(w.home, 'accepted', pending);
    const requests = w.getRoomBoostRequests(w.home);
    assert.equal(namesAdded, 0, 'native bodies are filtered before room indexing and name-set allocation');
    assert.equal(requests.length, 1); assert.equal(requests[0].parts, 2); assert.equal(requests[0].priority, 1);
    assert.equal(w.getRoomBoostRequests(w.home, pending).length, 0, 'the exact plan identity remains excludable');
    w.creep('accepted', [], w.plan(0), 'filler');
    assert.equal(w.getRoomBoostRequests(w.home).length, 0, 'a live native body owns its accepted name without joining the boost index');
    w.game.time++;
    namesAdded = 0;
    assert.equal(w.getRoomBoostRequests(w.home).length, 0);
    assert.equal(namesAdded, 0, 'expired prior-tick reservations do not allocate a live-name Set');
});
