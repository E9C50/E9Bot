const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const nativeBodies = require('../helpers/native-bodies.cjs');

const costs = { work: 100, carry: 50, move: 50, claim: 600, tough: 10, attack: 80, ranged_attack: 150, heal: 250 };
const bodyCost = body => body.reduce((sum, part) => sum + costs[part], 0);
const count = (body, part) => body.filter(value => value === part).length;

function config(role, development = {}) {
    return { role, name: `home_${role}`, data: {}, spawnRoom: 'W1N1', development };
}

function world({ capacity = 700, available = capacity, level = 4, creeps = {}, bufferEnergy } = {}) {
    const room = { name: 'W1N1', energyCapacityAvailable: capacity, energyAvailable: available,
        controller: { my: true, level, pos: { x: 25, y: 25, roomName: 'W1N1' } }, level, memory: { creepConfig: {}, creepSpawnQueue: [], roomFillJob: {} } };
    const buffer = bufferEnergy === undefined ? undefined : { store: { energy: bufferEnergy } };
    const legacyCalls = [], spawned = [];
    const game = { creeps, rooms: { [room.name]: room }, getObjectById: () => null };
    const loader = createSourceLoader({
        globals: { ...nativeBodies.globals, Game: game, StructureSpawn: class {}, OK: 0, RESOURCE_ENERGY: 'energy', BODYPART_COST: costs,
            WORK: 'work', CARRY: 'carry', MOVE: 'move', CLAIM: 'claim', TOUGH: 'tough', ATTACK: 'attack',
            RANGED_ATTACK: 'ranged_attack', HEAL: 'heal', MAX_CREEP_SIZE: 50, CARRY_CAPACITY: 50, HARVEST_POWER: 2 },
        modules: {
            ...nativeBodies.modules,
            './developmentLogistics': { controllerEnergyBuffer: () => buffer },
            role: { isRoleSupported: () => true },
            utils: { getBodyConfig(target, templates, force) {
                legacyCalls.push({ templates, force });
                const budget = force ? target.energyAvailable : target.energyCapacityAvailable;
                for (const template of [...templates].reverse()) {
                    const body = Object.entries(template).flatMap(([part, amount]) => Array(amount).fill(part));
                    if (bodyCost(body) <= budget) return body;
                }
                return [];
            } },
        },
    });
    const body = loader.load('creep/developmentBodies').getDevelopmentBody;
    return { room, game, loader, legacyCalls, spawned, body, buffer, policy: loader.load('settings/development').developmentPolicy };
}

function resident(room, role, data = {}) {
    return { room, memory: { role, spawnRoom: room.name, data } };
}

function makeSpawn(state, configs) {
    const Spawn = state.loader.load('mount/structure/SpawnExtension').default;
    const spawn = new Spawn();
    spawn.room = state.room;
    spawn.spawnCreep = (body, name, options) => {
        state.spawned.push({ body: Array.from(body), name, memory: options.memory });
        return 0;
    };
    state.room.memory.creepConfig = configs;
    state.room.memory.creepSpawnQueue = Object.keys(configs);
    return spawn;
}

test('development selection is explicit and exits before reading RCL8 development Memory', () => {
    const state = world();
    assert.equal(state.body(state.room, { role: 'harvester', data: {} }), undefined);
    state.policy.enabled = false;
    assert.equal(state.body(state.room, config('harvester')), undefined);
    state.policy.enabled = true;
    state.room.memory.fastUpgrade = false;
    assert.equal(state.body(state.room, config('harvester')), undefined);
    state.room.controller.level = 8;
    Object.defineProperty(state.room.memory, 'fastUpgrade', { get() { throw new Error('RCL8 must exit first'); } });
    assert.equal(state.body(state.room, config('harvester')), undefined);
});

test('source miners fit low room capacities and stop at the sustainable WORK target', () => {
    for (const [capacity, work, move] of [[300, 2, 1], [550, 4, 2], [700, 5, 3], [5600, 5, 3]]) {
        const state = world({ capacity });
        const body = state.body(state.room, config('harvester'));
        assert.equal(count(body, 'work'), work, `capacity ${capacity}`);
        assert.equal(count(body, 'carry'), 1);
        assert.equal(count(body, 'move'), move);
        assert.ok(bodyCost(body) <= capacity);
    }
    const state = world({ capacity: 700 });
    assert.equal(count(state.body(state.room, config('rHarvester', { workParts: 2 })), 'work'), 2);
});

test('healthy production waits for the requested miner size, while a crash pays from current energy', () => {
    const state = world({ capacity: 1300, available: 300 });
    state.game.creeps.existing = resident(state.room, 'harvester');
    assert.deepEqual(Array.from(state.body(state.room, config('harvester'))), []);
    delete state.game.creeps.existing;
    const rescue = state.body(state.room, config('harvester'));
    assert.equal(count(rescue, 'work'), 2);
    assert.equal(bodyCost(rescue), 300);
    state.room.energyAvailable = 199;
    assert.deepEqual(Array.from(state.body(state.room, config('harvester'))), []);
});

test('missing fillers shrink to a useful mobile body and established fillers wait for their target', () => {
    const state = world({ capacity: 800, available: 200 });
    const demand = config('filler', { carryParts: 8 });
    let body = state.body(state.room, demand);
    assert.equal(count(body, 'carry'), 2);
    assert.equal(count(body, 'move'), 2);
    state.game.creeps.filler = resident(state.room, 'filler');
    state.game.creeps.harvester = resident(state.room, 'harvester');
    assert.deepEqual(Array.from(state.body(state.room, demand)), []);
    state.room.energyAvailable = 800;
    body = state.body(state.room, demand);
    assert.equal(count(body, 'carry'), 8);
    assert.equal(count(body, 'move'), 8);
});

test('stationary upgrading buys more WORK than a mobile worker and preserves spawn energy', () => {
    const state = world({ capacity: 1300 });
    const stationary = state.body(state.room, config('upgrader', { stationary: true, workParts: 20 }));
    const mobile = state.body(state.room, config('upgrader', { stationary: false, workParts: 20 }));
    assert.equal(count(stationary, 'work'), 8);
    assert.equal(count(stationary, 'carry'), 1);
    assert.ok(count(stationary, 'work') > count(mobile, 'work'));
    assert.ok(count(mobile, 'carry') >= count(mobile, 'work') * 2);
    assert.ok(state.room.energyAvailable - bodyCost(stationary) >= state.policy.bodies.spawnEnergyReserve);
    state.room.energyAvailable = bodyCost(stationary) + state.policy.bodies.spawnEnergyReserve - 1;
    assert.deepEqual(Array.from(state.body(state.room, config('upgrader', { stationary: true, workParts: 20 }))), []);
});

test('the first mobile upgrader fits 300 capacity with a 100-energy recovery reserve', () => {
    const state = world({ capacity: 300, level: 1 });
    const body = state.body(state.room, config('upgrader', { stationary: false, workParts: 1 }));
    assert.deepEqual(Array.from(body), ['work', 'carry', 'move']);
    assert.equal(bodyCost(body), 200);
    state.room.energyAvailable = 299;
    assert.deepEqual(Array.from(state.body(state.room, config('upgrader', { workParts: 1 }))), []);
});

test('a supplied 550-capacity controller buys a 4-WORK upgrade body and waits for its complete price', () => {
    const state = world({ capacity: 550, bufferEnergy: 300 });
    const demand = config('upgrader', { stationary: true, workParts: 4 });
    let selected = state.body(state.room, demand);
    assert.equal(count(selected, 'work'), 4);
    assert.equal(bodyCost(selected), 550);
    state.room.energyAvailable = 549;
    assert.deepEqual(Array.from(state.body(state.room, demand)), [], 'a nearly full Spawn cannot shrink the planned upgrade body');
    state.room.energyAvailable = 550; state.buffer.store.energy = 299;
    selected = state.body(state.room, demand);
    assert.equal(count(selected, 'work'), 2, 'a dry controller preserves bootstrap recovery energy');
});

test('custom body selection and body preview use the same supplied-controller reserve as population planning', () => {
    const state = world({ capacity: 550, bufferEnergy: 1500 });
    const demand = config('upgrader', { stationary: true, workParts: 4 });
    state.room.memory.bodyProfiles = { upgrader: { terrain: 'plain', boostTier: 0 } };
    const selection = state.loader.load('creep/bodySelection');
    const plan = selection.selectCreepBody(state.room, demand, false);
    assert.equal(count(plan.body, 'work'), 3, 'the explicit plain-speed profile pays for full travel MOVE, with no stale 200-energy reserve');
    assert.equal(bodyCost(plan.body), 550);
    const preview = selection.previewBodySelection(state.room, demand, 0);
    assert.deepEqual(Array.from(preview.body), Array.from(plan.body));
    const cost = bodyCost(plan.body); state.room.energyAvailable = cost - 1;
    assert.deepEqual(Array.from(selection.selectCreepBody(state.room, demand, false).body), []);
});

test('hauling estimates CARRY from a complete trip and productive WORK, with safe unknown-route defaults', () => {
    const state = world({ capacity: 5600 });
    const planned = state.body(state.room, config('rFiller', { workParts: 5, travelTicks: 60 }));
    assert.equal(count(planned, 'carry'), 12);
    assert.equal(count(planned, 'move'), 12);
    const unknown = state.body(state.room, config('rFiller'));
    assert.equal(count(unknown, 'carry'), 4);
    assert.equal(count(unknown, 'move'), 4);
    const huge = state.body(state.room, config('rFiller', { carryParts: 1000 }));
    assert.equal(huge.length, 50);
    assert.equal(count(huge, 'move'), 25);
});

test('scouts and reservers use the minimum mobile bodies and wait if not payable', () => {
    const state = world({ capacity: 800 });
    assert.deepEqual(Array.from(state.body(state.room, config('scout'))), ['move']);
    assert.deepEqual(Array.from(state.body(state.room, config('reserver'))), ['claim', 'move']);
    state.room.energyAvailable = 649;
    assert.deepEqual(Array.from(state.body(state.room, config('reserver'))), []);
    assert.equal(state.body(state.room, config('processer')), undefined);
});

test('a stationary development manager uses the affordable 4-CARRY 1-MOVE storage hub body', () => {
    const state = world({ capacity: 1300 });
    const demand = config('manager', { carryParts: 4, stationary: true });
    const selected = state.body(state.room, demand);
    assert.equal(count(selected, 'carry'), 4);
    assert.equal(count(selected, 'move'), 1);
    assert.equal(count(selected, 'work'), 0);
    assert.equal(bodyCost(selected), 250);
    state.room.energyAvailable = 249;
    assert.deepEqual(Array.from(state.body(state.room, demand)), []);
});

test('RCL8 managers use a one-link capacity hub body without reading growth state', () => {
    const state = world({ capacity: 5600, level: 8 });
    Object.defineProperty(state.room.memory, 'fastUpgrade', { get() { throw new Error('RCL8 must exit first'); } });
    assert.equal(state.body(state.room, config('manager', { carryParts: 4, stationary: true })), undefined);
    const spawn = makeSpawn(state, { manager: { role: 'manager', name: 'old-manager', data: {} } });
    spawn.doWork();
    assert.equal(count(state.spawned[0].body, 'carry'), 16);
    assert.equal(count(state.spawned[0].body, 'move'), 1);
    assert.deepEqual(state.legacyCalls, [], 'optimized spawning no longer reads legacy tier tables');
});

test('maximumCost, finite part limits and actual available energy bound every custom body', () => {
    const state = world({ capacity: 5600 });
    for (const role of ['harvester', 'rHarvester', 'upgrader', 'builder', 'rBuilder', 'repairer', 'filler', 'rFiller']) {
        for (const stationary of [true, false]) {
            const body = state.body(state.room, config(role, { workParts: 999, carryParts: Infinity,
                travelTicks: NaN, stationary, maximumCost: 700 }));
            assert.ok(body.length > 0 && body.length <= 50, role);
            assert.ok(body.every(part => Object.hasOwn(costs, part)), role);
            assert.ok(count(body, 'move') > 0, role);
            assert.ok(bodyCost(body) <= 700, role);
        }
    }
    assert.deepEqual(Array.from(state.body(state.room, config('scout', { maximumCost: 0 }))), []);
});

test('the Spawn hook pays the development body without falling back on an empty custom result', () => {
    const state = world({ capacity: 700 });
    const demand = config('harvester', { workParts: 5 });
    const spawn = makeSpawn(state, { growing: demand });
    spawn.doWork();
    assert.equal(state.spawned.length, 1);
    assert.equal(count(state.spawned[0].body, 'work'), 5);
    assert.equal(state.spawned[0].memory, demand);
    assert.deepEqual(state.legacyCalls, []);
    assert.deepEqual(state.room.memory.creepSpawnQueue, []);
    state.room.energyAvailable = 100;
    state.room.memory.creepSpawnQueue.push('growing');
    spawn.doWork();
    assert.equal(state.spawned.length, 1);
    assert.deepEqual(state.legacyCalls, []);
    assert.deepEqual(state.room.memory.creepSpawnQueue, ['growing']);
});

test('unmarked RCL8 demands use affordable recovery bodies and cap upgrading at 15 WORK', () => {
    const state = world({ capacity: 5600, available: 300, level: 8 });
    const legacyHarvester = config('harvester');
    delete legacyHarvester.development;
    const spawn = makeSpawn(state, { legacyHarvester });
    spawn.doWork();
    assert.deepEqual(state.legacyCalls, []);
    assert.ok(bodyCost(state.spawned[0].body) <= state.room.energyAvailable);
    assert.ok(count(state.spawned[0].body, 'work') >= 1);
    const ordinary = { role: 'upgrader', name: 'ordinary', data: {} };
    state.room.memory.creepConfig = { ordinary };
    state.room.memory.creepSpawnQueue = ['ordinary'];
    state.room.energyAvailable = 5600;
    spawn.doWork();
    assert.ok(count(state.spawned[1].body, 'work') <= 15);
    assert.ok(count(state.spawned[1].body, 'work') >= 1);
    assert.ok(state.spawned[1].body.length <= 50);
    assert.equal(state.spawned[1].memory.boostPlan.tier, 0);
});

test('RCL8 removes all stale development profiles and remote markers before the refreshed legacy demand', () => {
    const state = world({ capacity: 5600, level: 8 });
    const growth = config('upgrader');
    growth.name = 'W1N1_DEVELOP_UPGRADER_0';
    const remote = config('rHarvester');
    remote.data.developmentRemote = { homeRoom: 'W1N1', targetRoom: 'W1N2', kind: 'harvester', homePosition: { x: 25, y: 25 } };
    delete remote.development;
    const staleLocal = config('harvester');
    const legacy = config('harvester');
    delete legacy.development;
    const spawn = makeSpawn(state, { growth, remote, staleLocal, legacy });
    spawn.doWork();
    assert.equal(state.spawned.length, 1);
    assert.equal(state.spawned[0].name, 'legacy');
    assert.ok(state.spawned[0].body.length > 0 && state.spawned[0].body.length <= 50);
    assert.deepEqual(state.room.memory.creepSpawnQueue, []);
});

test('a local development queue that survives the RCL8 transition waits for its next legacy refresh', () => {
    const state = world({ capacity: 5600, level: 8 });
    const stale = config('harvester');
    const spawn = makeSpawn(state, { harvester: stale });
    spawn.doWork();
    assert.deepEqual(state.spawned, []);
    assert.deepEqual(state.legacyCalls, []);
    assert.deepEqual(state.room.memory.creepSpawnQueue, []);
    const legacy = { ...stale };
    delete legacy.development;
    state.room.memory.creepConfig.harvester = legacy;
    state.room.memory.creepSpawnQueue = ['harvester'];
    spawn.doWork();
    assert.equal(state.spawned.length, 1);
    assert.ok(state.spawned[0].body.length > 0 && state.spawned[0].body.length <= 50);
    assert.deepEqual(state.legacyCalls, []);
});
