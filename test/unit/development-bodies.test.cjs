const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const nativeBodies = require('../helpers/native-bodies.cjs');

const costs = { work: 100, carry: 50, move: 50, claim: 600, tough: 10, attack: 80, ranged_attack: 150, heal: 250 };
const bodyCost = body => body.reduce((sum, part) => sum + costs[part], 0);
const count = (body, part) => body.filter(value => value === part).length;

function config(role, development = {}) {
    return { role, name: `home_${role}`, data: {}, spawnRoom: 'W1N1', development: {
        ...(['harvester', 'rHarvester'].includes(role) ? { stationary: true } : {}), ...development } };
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
    return { room, memory: { role, spawnRoom: room.name, data }, getActiveBodyparts: () => 1 };
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

test('an inhabited room with an oversized carrying preference waits for a useful complete worker', () => {
    const state = world({ capacity: 1300, available: 1249 });
    state.game.creeps.local = resident(state.room, 'filler');
    state.room.memory.bodyProfiles = { upgrader: {
        workParts: 20, carryParts: 25, maximumCost: 12900, boostTier: 0, terrain: 'plain', stationary: false,
    } };
    const spawn = makeSpawn(state, { upgrader: config('upgrader', { fullBody: true, workParts: 1 }) });
    spawn.doWork();
    assert.equal(state.spawned.length, 0, 'current energy cannot buy the selected 1250-energy complete body');
    state.room.energyAvailable = 1250;
    spawn.doWork();
    assert.equal(state.spawned.length, 1);
    assert.equal(count(state.spawned[0].body, 'work'), 5);
    assert.equal(count(state.spawned[0].body, 'carry'), 5);
    assert.equal(count(state.spawned[0].body, 'move'), 10);
    assert.equal(bodyCost(state.spawned[0].body), 1250);
});

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

test('source miners use the largest legal native station body at each capacity', () => {
    for (const [capacity, work, carry, move] of [[300, 1, 1, 1], [550, 3, 1, 3], [700, 4, 1, 4], [5600, 23, 4, 23]]) {
        const state = world({ capacity });
        const body = state.body(state.room, config('harvester'));
        assert.equal(count(body, 'work'), work, `capacity ${capacity}`);
        assert.equal(count(body, 'carry'), carry);
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
    assert.equal(count(rescue, 'work'), 1);
    assert.equal(bodyCost(rescue), 200);
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
    assert.ok(count(mobile, 'carry') >= count(mobile, 'work'));
    assert.ok(state.room.energyAvailable - bodyCost(stationary) >= state.policy.bodies.spawnEnergyReserve);
    state.game.creeps.resident = resident(state.room, 'scout');
    state.room.energyAvailable = bodyCost(stationary) + state.policy.bodies.spawnEnergyReserve - 1;
    assert.deepEqual(Array.from(state.body(state.room, config('upgrader', { stationary: true, workParts: 20 }))), []);
});

test('the first mobile upgrader fits 300 capacity without reducing capacity for an automatic reserve', () => {
    const state = world({ capacity: 300, level: 1 });
    const body = state.body(state.room, config('upgrader', { stationary: false, workParts: 1 }));
    assert.deepEqual(Array.from(body), ['work', 'carry', 'move', 'move']);
    assert.equal(bodyCost(body), 250);
    state.game.creeps.resident = resident(state.room, 'scout');
    state.room.energyAvailable = 249;
    assert.deepEqual(Array.from(state.body(state.room, config('upgrader', { workParts: 1 }))), []);
});

test('a supplied 550-capacity controller buys a full-speed 3-WORK upgrade body and waits for its complete price', () => {
    const state = world({ capacity: 550, bufferEnergy: 300 });
    const demand = config('upgrader', { stationary: true, workParts: 4 });
    let selected = state.body(state.room, demand);
    assert.equal(count(selected, 'work'), 3);
    assert.equal(bodyCost(selected), 550);
    state.game.creeps.resident = resident(state.room, 'builder');
    state.room.energyAvailable = 549;
    assert.deepEqual(Array.from(state.body(state.room, demand)), [], 'a nearly full Spawn cannot shrink the planned upgrade body');
    state.room.energyAvailable = 550; state.buffer.store.energy = 299;
    selected = state.body(state.room, demand);
    assert.equal(count(selected, 'work'), 3, 'controller stock does not reduce the full capacity body');
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

test('haulers use maximum legal CARRY even when the demand contains a short travel estimate', () => {
    const state = world({ capacity: 5600 });
    const planned = state.body(state.room, config('rFiller', { workParts: 5, travelTicks: 60 }));
    assert.equal(count(planned, 'carry'), 25);
    assert.equal(count(planned, 'move'), 25);
    const unknown = state.body(state.room, config('rFiller'));
    assert.equal(count(unknown, 'carry'), 25);
    assert.equal(count(unknown, 'move'), 25);
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
    state.game.creeps.resident = resident(state.room, 'scout');
    state.room.energyAvailable = 249;
    assert.deepEqual(Array.from(state.body(state.room, demand)), []);
});

test('RCL8 managers use the full 50-part hub body without reading growth state', () => {
    const state = world({ capacity: 5600, level: 8 });
    Object.defineProperty(state.room.memory, 'fastUpgrade', { get() { throw new Error('RCL8 must exit first'); } });
    assert.equal(state.body(state.room, config('manager', { carryParts: 4, stationary: true })), undefined);
    const spawn = makeSpawn(state, { manager: { role: 'manager', name: 'old-manager', data: {} } });
    spawn.doWork();
    assert.equal(count(state.spawned[0].body, 'carry'), 49);
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
    assert.equal(count(state.spawned[0].body, 'work'), 4);
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

test('any local ordinary creep blocks partial-energy selection for every economic role', () => {
    for (const level of [4, 8]) for (const livingRole of ['builder', 'scout', 'attacker', 'harvester', 'filler']) {
        const state = world({ capacity: 3000, available: 300, level });
        state.game.creeps.resident = resident(state.room, livingRole);
        for (const role of ['harvester', 'filler', 'manager', 'processer', 'builder', 'upgrader', 'repairer', 'rBuilder']) {
            const demand = { role, data: {}, spawnRoom: state.room.name,
                bodyProfile: { boostTier: 0, ...(role === 'harvester' ? { stationary: true } : {}) },
                ...(level < 8 ? { development: { fullBody: true, workParts: 1, carryParts: 1, maximumCost: 200 } } : {}) };
            const selector = state.loader.load('creep/bodySelection');
            const preview = selector.previewBodySelection(state.room, demand, 0);
            assert.ok(bodyCost(preview.body) > 300, `${level}/${livingRole}/${role}: complete body`);
            const selected = selector.selectCreepBody(state.room, demand, true);
            assert.ok(selected.body.length === 0 || bodyCost(selected.body) > 300, `${role}: no undersized selection`);
        }
    }
});

test('visiting and spawning creeps count physically, while remote residents and PowerCreeps do not', () => {
    const state = world({ capacity: 3000, available: 300, level: 8 });
    const policy = state.loader.load('creep/spawnEnergyPolicy').needsEmergencyBody;
    state.game.creeps.remote = resident({ name: 'W2N1' }, 'harvester');
    state.game.creeps.remote.memory.spawnRoom = state.room.name;
    state.game.powerCreeps = { operator: { room: state.room } };
    assert.equal(policy(state.room), true);
    const visiting = resident(state.room, 'scout'); visiting.memory.spawnRoom = 'W2N1';
    state.game.creeps.visiting = visiting;
    assert.equal(policy(state.room), false);
    delete state.game.creeps.visiting;
    state.game.creeps.spawning = { ...resident(state.room, 'builder'), spawning: true };
    assert.equal(policy(state.room), false);
});

test('bootstrap assistance waits for its complete mobile body while any local creep remains', () => {
    const state = world({ capacity: 3000, available: 300, level: 8 });
    state.game.creeps.visitor = resident(state.room, 'scout');
    const demand = { role: 'rBuilder', name: 'aid', data: { bootstrap: true }, spawnRoom: state.room.name };
    const spawn = makeSpawn(state, { aid: demand });
    spawn.doWork();
    assert.deepEqual(state.spawned, []);
    assert.deepEqual(state.room.memory.creepSpawnQueue, ['aid']);
    state.room.energyAvailable = 3000;
    spawn.doWork();
    assert.equal(state.spawned.length, 1);
    assert.ok(bodyCost(state.spawned[0].body) > 300);
});

test('a stale expensive queue head permits an affordable complete local recovery body', () => {
    const state = world({ capacity: 1300, available: 500, level: 8 });
    state.game.creeps.resident = resident(state.room, 'builder');
    const config = (role, bodyProfile = {}) => ({ role, data: {}, spawnRoom: state.room.name, bodyProfile: { boostTier: 0, ...bodyProfile } });
    const spawn = makeSpawn(state, { manager: config('manager'), mine: config('harvester', {
        stationary: true, terrain: 'plain', maximumCost: 500,
    }) });
    spawn.doWork();
    assert.equal(state.spawned.length, 1);
    assert.equal(state.spawned[0].name, 'mine');
    assert.equal(bodyCost(state.spawned[0].body), 500);
    assert.deepEqual(state.room.memory.creepSpawnQueue, ['manager']);
});

test('automatic full-body quotas preserve explicit room part, cost and stationary preferences', () => {
    const state = world({ capacity: 3000, level: 4 });
    state.game.creeps.resident = resident(state.room, 'builder');
    state.room.memory.bodyProfiles = { harvester: { workParts: 3, carryParts: 2, maximumCost: 1000, stationary: false, boostTier: 0 } };
    const demand = config('harvester', { fullBody: true, stationary: true, workParts: 1, carryParts: 1, maximumCost: 200 });
    const selector = state.loader.load('creep/bodySelection');
    const selected = selector.selectCreepBody(state.room, demand, true);
    assert.equal(count(selected.body, 'work'), 3);
    assert.equal(count(selected.body, 'carry'), 2);
    assert.equal(count(selected.body, 'move'), 5);
    assert.equal(bodyCost(selected.body), 650);
});

test('pending boosts and expired local workers do not block an affordable complete recovery behind a stale head', () => {
    for (const role of ['harvester', 'filler']) for (const unavailable of ['boost', 'ttl']) {
        const state = world({ capacity: 3000, available: 500, level: 8 });
        const stalled = resident(state.room, role);
        stalled.ticksToLive = unavailable === 'ttl' ? 0 : 1000;
        if (unavailable === 'boost') stalled.memory.boostPlan = { tier: 3, steps: [{ resource: 'XKH2O', parts: 1 }] };
        state.game.creeps.stalled = stalled;
        state.game.creeps.other = resident(state.room, role === 'harvester' ? 'filler' : 'harvester');
        const recovery = { role, data: {}, spawnRoom: state.room.name, bodyProfile: {
            boostTier: 0, terrain: 'plain', maximumCost: role === 'harvester' ? 500 : 400,
            ...(role === 'harvester' ? { stationary: true } : {}),
        } };
        const spawn = makeSpawn(state, { manager: { role: 'manager', data: {}, bodyProfile: { boostTier: 0 } }, recovery });
        spawn.doWork();
        assert.equal(state.spawned.length, 1, `${role}/${unavailable}`);
        assert.equal(state.spawned[0].name, 'recovery');
        assert.equal(bodyCost(state.spawned[0].body), recovery.bodyProfile.maximumCost);
        assert.deepEqual(state.room.memory.creepSpawnQueue, ['manager']);
    }
});

test('a still-spawning local successor occupies the recovery slot until its full body finishes', () => {
    const state = world({ capacity: 3000, available: 500, level: 8 });
    state.game.creeps.harvester = resident(state.room, 'harvester');
    state.game.creeps.filler = { ...resident(state.room, 'filler'), spawning: true,
        ticksToLive: 0 };
    state.game.creeps.filler.memory.boostPlan = { tier: 3, steps: [{ resource: 'XKH2O', parts: 1 }] };
    const spawn = makeSpawn(state, { manager: { role: 'manager', data: {}, bodyProfile: { boostTier: 0 } },
        filler: { role: 'filler', data: {}, bodyProfile: { boostTier: 0, maximumCost: 400, terrain: 'plain' } } });
    spawn.doWork();
    assert.deepEqual(state.spawned, []);
    assert.deepEqual(state.room.memory.creepSpawnQueue, ['manager', 'filler']);
});
