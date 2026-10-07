const assert = require('node:assert/strict');
const test = require('node:test');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function recoveryWorld() {
    const game = { time: 1, shard: { name: 'shard3' }, cpu: { bucket: 999 } };
    const loader = createSourceLoader({ globals: { Game: game } });
    const api = loader.load('runtime/cpuRecovery');
    return { game, loader, api, policy: loader.load('settings/runtime').runtimePolicy.cpuRecovery };
}

test('CPU recovery is configurable and only activates with a finite bucket below its threshold', () => {
    const { game, api, policy } = recoveryWorld();
    assert.equal(api.isCpuRecoveryActive(), true);
    assert.equal(api.cpuRecoveryInterval('market', 25), 250);
    game.cpu.bucket = 1000;
    assert.equal(api.isCpuRecoveryActive(), false);
    assert.equal(api.cpuRecoveryInterval('market', 25), 25);
    for (const bucket of [undefined, NaN, Infinity]) {
        game.cpu.bucket = bucket;
        assert.equal(api.isCpuRecoveryActive(), false);
    }
    delete game.cpu;
    assert.equal(api.isCpuRecoveryActive(), false);
    game.cpu = { bucket: 0 };
    policy.enabled = false;
    assert.equal(api.isCpuRecoveryActive(), false);
    policy.enabled = true;
    policy.shards = ['shard1'];
    assert.equal(api.isCpuRecoveryActive(), false);
    game.shard.name = 'shard1';
    assert.equal(api.isCpuRecoveryActive(), true);
});

test('CPU recovery imports without Game, validates periods, and never accelerates an existing schedule', () => {
    assert.doesNotThrow(() => createSourceLoader().load('runtime/cpuRecovery'));
    const { api, policy } = recoveryWorld();
    for (const interval of [0, -1, 2.5, NaN, Infinity]) {
        policy.intervals.market = interval;
        assert.equal(api.cpuRecoveryInterval('market', 25), 25);
    }
    policy.intervals.market = 5;
    assert.equal(api.cpuRecoveryInterval('market', 25), 25);
});

test('recovery rooms run once per configured period without overlapping normal-period starvation', () => {
    const { game, api, policy } = recoveryWorld();
    policy.intervals.market = 37;
    const names = ['E31N2', 'E34N3', 'E35N1', 'E35N3', 'E36N2', 'E37N7', 'E38N5', 'E38N6', 'E41N7', 'E41N8', 'E37N5'];
    const counts = new Map(names.map(name => [name, 0]));
    let maximum = 0;
    for (let tick = 1; tick <= 37; tick++) {
        game.time = tick;
        let due = 0;
        for (const name of names) if (api.cpuRecoveryWorkDue(name, 'market')) { counts.set(name, counts.get(name) + 1); due++; }
        maximum = Math.max(maximum, due);
    }
    assert.deepEqual([...counts.values()], names.map(() => 1));
    assert.ok(maximum < names.length, 'rooms spread optional work instead of batching the whole empire');
});

function structureWorld() {
    const w = recoveryWorld(), calls = {};
    const structure = id => ({ id, doWork() { calls[id] = (calls[id] || 0) + 1; } });
    const room = {
        name: 'E31N2', my: true, towers: [structure('tower')], labs: [structure('reaction'), structure('boost')],
        spawns: [structure('spawn')], links: [structure('link')], powerSpawn: structure('power'), factory: structure('factory'),
        memory: { boostNeed: {}, roomLabConfig: { singleLabConfig: { boost: { boostMode: true } } } },
    };
    w.game.rooms = { [room.name]: room, foreign: { my: false } };
    return { ...w, room, calls, run: w.loader.load('module/StructureController').structureWorkController };
}

test('recovery reduces only optional structure production and preserves every tower, link, spawn, and boost tick', () => {
    const w = structureWorld();
    for (let tick = 1; tick <= 50; tick++) { w.game.time = tick; w.run(); }
    assert.deepEqual(w.calls, { tower: 50, boost: 50, spawn: 50, link: 50, reaction: 10, power: 5, factory: 2 });
    w.game.cpu.bucket = 1000;
    w.game.time++;
    w.run();
    assert.equal(w.calls.reaction, 11);
    assert.equal(w.calls.power, 6);
    assert.equal(w.calls.factory, 3);
});

test('pending combat or shard boost demand preserves all reaction and precursor production during recovery', () => {
    const w = structureWorld();
    w.room.memory.boostNeed.XGH2O = 30;
    for (let tick = 1; tick <= 10; tick++) { w.game.time = tick; w.run(); }
    assert.equal(w.calls.reaction, 10);
    assert.equal(w.calls.boost, 10);
    w.room.memory.boostNeed.XGH2O = 0;
    const before = w.calls.reaction;
    for (let tick = 11; tick <= 20; tick++) { w.game.time = tick; w.run(); }
    assert.equal(w.calls.reaction - before, 2, 'cleared demand resumes the reduced schedule');
});

function minerWorld() {
    const w = recoveryWorld(), actions = [], reads = { lookups: 0 };
    const mineral = { id: 'mineral', mineralType: 'H', pos: { isNearTo: () => false } };
    const room = { name: 'E31N2', memory: { boostNeed: {} }, containers: [], extractor: { cooldown: 0 }, storage: { id: 'storage' } };
    let free = 100;
    const creep = { room, memory: {}, pos: {}, store: { H: 50, getFreeCapacity: () => free },
        harvest: () => actions.push('harvest'), moveTo: () => actions.push('move'), transferToTarget: () => actions.push('transfer') };
    w.game.getObjectById = id => { reads.lookups++; assert.equal(id, 'mineral'); return mineral; };
    const loader = createSourceLoader({ globals: { Game: w.game }, modules: { utils: { getDistance: () => 1 } } });
    const role = loader.load('role/base/RoleBaseMiner').default({ sourceId: 'mineral' });
    return { ...w, creep, room, role, actions, reads, setFree: value => { free = value; } };
}

test('mineral recovery skips gathering scans but keeps unloading every tick and immediately detects a full load', () => {
    const w = minerWorld();
    for (let tick = 1; tick <= 5; tick++) { w.game.time = tick; w.role.source(w.creep); }
    assert.deepEqual(w.actions, ['harvest']);
    assert.equal(w.reads.lookups, 1);
    w.actions.length = 0;
    for (let tick = 1; tick <= 5; tick++) { w.game.time = tick; w.role.target(w.creep); }
    assert.deepEqual(w.actions, Array(5).fill('transfer'));
    w.setFree(0);
    w.game.time++;
    w.role.source(w.creep);
    assert.equal(w.creep.memory.working, true);
    assert.equal(w.reads.lookups, 6, 'full-load transition needs no mineral or path scan');
});

test('mineral gathering keeps its ordinary throughput for pending boosts even with an empty bucket', () => {
    const w = minerWorld();
    w.room.memory.boostNeed.XGH2O = 30;
    for (let tick = 1; tick <= 5; tick++) { w.game.time = tick; w.role.source(w.creep); }
    assert.deepEqual(w.actions, Array(5).fill('harvest'));
});

function labPlanningWorld() {
    const game = { time: 1, cpu: { bucket: 0 }, shard: { name: 'shard3' } };
    let productReads = 0;
    const requests = [];
    const loader = createSourceLoader({ globals: { Game: game, LAB_BOOST_MINERAL: 30 }, modules: {
        'settings/roomPolicy': { roomPolicy: { labs: { updateInterval: 10, staggerUpdates: true, minimumReactionReagent: 1000 } } },
        'settings/labs': { reactionConfig: { product: 1000 }, reactionSource: { product: ['A', 'B'] } },
        'settings/boost': { boostConfig: {} },
        'runtime/creepIndex': { getRoomProcessors: () => [] },
        'creep/boosting': { getRoomBoostRequests: () => requests, usableBoostLabs: () => [] },
    } });
    const room = { name: 'E31N2', labs: [{ id: 'lab', store: {} }], getResource: () => 1000,
        storage: { store: { get product() { productReads++; return 1000; } } },
        memory: { boostNeed: {}, roomLabConfig: { sourceLab1: 'one', sourceLab2: 'two', singleLabConfig: {} } } };
    return { game, room, requests, reads: () => productReads, ...loader.load('room/labs') };
}

test('bucket recovery defers expensive Lab recipe scans without clearing the existing configuration between scans', () => {
    const w = labPlanningWorld();
    for (let tick = 1; tick <= 100; tick++) {
        w.game.time = tick;
        w.room.memory.roomLabConfig.labReactionConfig = 'product';
        const before = w.reads();
        w.updateLabReactionConfig(w.room);
        if (w.reads() === before) assert.equal(w.room.memory.roomLabConfig.labReactionConfig, 'product');
    }
    assert.equal(w.reads(), 1);
    w.game.cpu.bucket = 1000;
    for (let tick = 101; tick <= 110; tick++) { w.game.time = tick; w.updateLabReactionConfig(w.room); }
    assert.equal(w.reads(), 2, 'ordinary ten-tick planning resumes immediately when the bucket recovers');
});

test('pending boost demand refreshes each tick and preserves the ordinary Lab planning schedule', () => {
    const w = labPlanningWorld();
    w.requests.push({ resource: 'XGH2O', parts: 1, priority: 0 });
    for (let tick = 1; tick <= 100; tick++) {
        w.game.time = tick;
        w.room.memory.boostNeed.stale = 60;
        w.updateLabBoostConfig(w.room);
        assert.deepEqual({ ...w.room.memory.boostNeed }, { XGH2O: 30 });
        w.updateLabReactionConfig(w.room);
    }
    assert.equal(w.reads(), 10);
});
