const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const nativeBodies = require('../helpers/native-bodies.cjs');

const costs = { work: 100, carry: 50, move: 50, claim: 600, tough: 10, attack: 80, ranged_attack: 150, heal: 250 };

function world({ available = 300, level = 8 } = {}) {
    const calls = [];
    const p = (x, y) => ({ x, y, roomName: 'W1N1', inRangeTo(target, range) {
        const other = target.pos || target;
        return Math.max(Math.abs(x - other.x), Math.abs(y - other.y)) <= range;
    } });
    const store = (energy, capacity) => ({ energy, getCapacity: () => capacity,
        getUsedCapacity() { return this.energy; }, getFreeCapacity() { return capacity - this.energy; } });
    const room = { name: 'W1N1', my: true, level, controller: { my: true, level, ticksToDowngrade: 200000 },
        memory: { creepConfig: {}, creepSpawnQueue: [], roomFillJob: {} },
        energyCapacityAvailable: 12900, energyAvailable: available,
        storage: { id: 'storage', pos: p(25, 25), store: store(250000, 1000000) },
        mineral: { id: 'mineral' }, sources: [], spawns: [], extensions: [], containers: [], labs: [], links: [],
        constructionSites: [], ramparts: [], wallsNeedRepair: [], getTerrain: () => ({ get: () => 0 }), lookForAt: () => [] };
    const game = { rooms: { W1N1: room }, creeps: {}, flags: {}, time: 100,
        getObjectById: id => id === 'storage' ? room.storage : null };
    class NativeSpawn {
        spawnCreep(body, name, { memory }) {
            const cost = body.reduce((sum, part) => sum + costs[part], 0);
            if (game.creeps[name]) return -3;
            if (cost > room.energyAvailable) return -6;
            const creep = unit(memory.name, { carry: body.filter(p => p === 'carry').length,
                move: body.filter(p => p === 'move').length, spawning: true });
            creep.memory = { ...memory };
            creep.body = body.map(type => ({ type, hits: 100 }));
            room.energyAvailable -= cost;
            calls.push(['spawn', name, body]);
            return 0;
        }
        recycleCreep(creep) { calls.push(['recycle', creep.name]); return 0; }
    }
    const factories = Object.fromEntries(['manager', 'processer', 'miner', 'builder', 'repairer'].map(role =>
        [role, () => ({ isNeed: () => false })]));
    factories.isRoleSupported = () => true;
    const loader = createSourceLoader({ globals: { ...nativeBodies.globals, Game: game, Memory: {},
        RESOURCE_ENERGY: 'energy', CREEP_SPAWN_TIME: 3, BODYPART_COST: costs,
        StructureSpawn: NativeSpawn, OK: 0, ERR_NOT_IN_RANGE: -9 }, modules: {
        ...nativeBodies.modules, role: factories,
        utils: { sha1String: name => name, getDistance: (a, b) => Math.max(Math.abs(a.x-b.x), Math.abs(a.y-b.y)) },
        'creep/haulerDelivery': { withHaulerTraffic: behavior => behavior, deliverHaulerEnergy: () => false },
    } });
    const lifecycle = loader.load('creep/storageFillerLifecycle');
    const demand = loader.load('creep/demand');
    const names = Array.from(lifecycle.storageFillerNames(room));
    const spawn = new (loader.load('mount/structure/SpawnExtension').default)();
    Object.assign(spawn, { id: 'spawn', room, pos: p(10, 10), store: store(300, 300) });
    room.spawns.push(spawn);
    function unit(logicalName = names[0], { carry = 4, move = 2, ttl = 1000, spawning = false, data = {}, boostPlan } = {}) {
        const name = demand.createCreepName('filler', logicalName);
        const creep = { name, room, spawning, ticksToLive: ttl, pos: p(10, 11),
            memory: { name: logicalName, role: 'filler', spawnRoom: room.name, ready: true, working: true,
                data: { sourceId: 'storage', ...data }, ...(boostPlan ? { boostPlan } : {}) },
            store: store(0, carry * 50), getActiveBodyparts: part => part === 'carry' ? carry : part === 'move' ? move : 0,
            transfer(target, resource) { calls.push(['transfer', target.id, resource]); return this.pos.inRangeTo(target, 1) ? 0 : -9; },
            moveTo(target) { calls.push(['move', target.id]); return 0; } };
        game.creeps[name] = creep;
        return creep;
    }
    const base = loader.load('creep/basePopulation');
    return { loader, lifecycle, demand, names, room, game, spawn, calls, unit, p,
        release() {
            room.memory.creepConfig = {};
            base.releaseBaseCreepConfig();
            room.memory.creepSpawnQueue = loader.load('creep/spawnQueue').buildSpawnQueue(room);
            return Object.values(room.memory.creepConfig).filter(c => c.role === 'filler').map(c => c.name);
        },
    };
}

test('a six-part mature storage filler keeps working while one complete successor waits for energy', () => {
    const w = world(), old = w.unit();
    assert.deepEqual(Array.from(w.release()), w.names);
    for (let tick = 0; tick < 5; tick++) {
        w.spawn.doWork(); w.game.time++; w.release();
    }
    assert.equal(w.calls.length, 0, '300 energy must not shrink a replacement while the old carrier still works');
    assert.equal(w.lifecycle.retireSupersededStorageFiller(old), false);
    assert.equal(Object.keys(w.game.creeps).length, 1);
    w.room.energyAvailable = 2500;
    w.spawn.doWork();
    const birth = w.calls.find(c => c[0] === 'spawn');
    assert.equal(birth[2].length, 50);
    assert.equal(birth[2].filter(p => p === 'carry').length, 33);
    assert.deepEqual(Array.from(w.release()), w.names);
    assert.equal(w.lifecycle.retireSupersededStorageFiller(old), false, 'a still-spawning successor cannot retire its bridge');
    const successor = w.game.creeps[birth[1]];
    successor.spawning = false; successor.ticksToLive = 1500;
    assert.deepEqual(Array.from(w.release()), [w.names[1]]);
    old.store.energy = 200;
    const behavior = w.loader.load('role/base/RoleBaseFiller').default(old.memory.data);
    assert.equal(behavior.prepare(old), false, 'ready=true residents still enter the every-tick handover guard');
    assert.equal(w.calls.at(-1)[0], 'move', 'paid-for cargo is delivered before recycling');
    old.store.energy = 0;
    assert.equal(behavior.prepare(old), false);
    assert.deepEqual(w.calls.at(-1), ['recycle', old.name]);
    delete w.game.creeps[old.name];
    for (let tick = 0; tick < 5; tick++) { w.release(); w.spawn.doWork(); }
    assert.equal(w.calls.filter(c => c[0] === 'spawn').length, 1, 'catalog refreshes retain one resident without alternating births');
});

test('an ordinary twenty-four-part carrier is retained rather than upgraded merely for being below maximum', () => {
    const w = world(); w.unit(w.names[0], { carry: 16, move: 8 });
    assert.deepEqual(Array.from(w.release()), [w.names[0]]);
    assert.equal(w.room.memory.storageFillerHandover.replacement, undefined);
});

test('an empty recovery slot restarts with one consistent birth name across spawning refreshes', () => {
    const w = world();
    w.room.memory.storageFillerHandover = { active: w.names[1], replacement: 'obsolete-slot' };
    assert.deepEqual(Array.from(w.release()), [w.names[1]]);
    assert.equal(w.room.memory.storageFillerHandover.replacement, undefined);
    w.spawn.doWork();
    for (let tick = 0; tick < 5; tick++) {
        w.game.time++; w.room.energyAvailable = 2500;
        assert.deepEqual(Array.from(w.release()), [w.names[1]]);
        w.spawn.doWork();
    }
    assert.equal(Object.keys(w.game.creeps).length, 1);
    assert.equal(w.calls.filter(c => c[0] === 'spawn').length, 1);
});

test('a dying full carrier hands over to the planned successor even after a custom body profile reduces its capacity', () => {
    const w = world({ available: 500 });
    const old = w.unit(w.names[0], { carry: 33, move: 17, ttl: 40 });
    w.room.memory.bodyProfiles = { filler: { carryParts: 6 } };
    assert.deepEqual(Array.from(w.release()), w.names);
    w.spawn.doWork();
    const successor = Object.values(w.game.creeps).find(c => c !== old);
    successor.spawning = false; successor.ticksToLive = 1500;
    assert.equal(successor.store.getCapacity(), 300);
    assert.deepEqual(Array.from(w.release()), [w.names[1]]);
    assert.equal(w.lifecycle.retireSupersededStorageFiller(old), true);
});

test('an absent carrier can restart on current energy and bypass a requested boost', () => {
    const w = world();
    w.room.memory.bodyProfiles = { filler: { boostTier: 3, boostFallback: 'wait' } };
    w.release(); w.spawn.doWork();
    const successor = Object.values(w.game.creeps)[0];
    assert.equal(successor.body.length, 6);
    assert.equal(successor.memory.boostPlan.tier, 0);
    assert.equal(successor.store.getCapacity(), 200);
});

test('a physically disabled resident releases the other slot and cannot keep the needed carrier behind a full manager', () => {
    for (const disabled of [{ carry: 0 }, { move: 0 }, { boostPlan: { tier: 3, steps: [], failed: true } }]) {
        const w = world(); const old = w.unit(w.names[0], disabled);
        w.release();
        w.demand.addCreepConfig(w.room, 'manager', 'manager');
        w.room.memory.creepSpawnQueue = w.loader.load('creep/spawnQueue').buildSpawnQueue(w.room);
        assert.equal(w.room.memory.creepConfig[w.room.memory.creepSpawnQueue[0]].role, 'filler');
        w.spawn.doWork();
        const successor = Object.values(w.game.creeps).find(c => c !== old);
        assert.ok(successor && successor.spawning);
        assert.equal(successor.body.length, 6);
        assert.equal(w.lifecycle.retireSupersededStorageFiller(old), false);
    }
});

test('a pending successor boost keeps its old carrier and birth slot until actual transport is possible', () => {
    const w = world(); const old = w.unit(); w.release();
    const successor = w.unit(w.names[1], { carry: 33, move: 17,
        boostPlan: { tier: 3, steps: [{ resource: 'XKH2O', parts: 33 }], completed: false } });
    assert.deepEqual(Array.from(w.release()), w.names);
    assert.equal(w.lifecycle.retireSupersededStorageFiller(old), false);
    successor.memory.boostPlan.completed = true;
    successor.memory.ready = false;
    assert.deepEqual(Array.from(w.release()), [w.names[1]]);
    assert.equal(w.lifecycle.retireSupersededStorageFiller(old), true);
});

test('two disabled slots can recycle one empty mobile wreck before reusing its exact emergency birth name', () => {
    const w = world(), immobile = w.unit(w.names[0], { move: 0 }), mobile = w.unit(w.names[1], { carry: 0 });
    assert.deepEqual(Array.from(w.release()), [w.names[0]]);
    assert.equal(w.room.memory.storageFillerHandover.replacement, w.names[1]);
    assert.equal(w.lifecycle.retireSupersededStorageFiller(immobile), false);
    assert.equal(w.lifecycle.retireSupersededStorageFiller(mobile), true);
    assert.deepEqual(w.calls.at(-1), ['recycle', mobile.name]);
    delete w.game.creeps[mobile.name];
    assert.deepEqual(Array.from(w.release()), w.names);
    w.spawn.doWork();
    assert.ok(w.game.creeps[mobile.name].spawning);
    assert.equal(w.calls.filter(c => c[0] === 'spawn').length, 1);
    assert.equal(Object.keys(w.game.creeps).length, 2);
});

test('two immobile wrecks retain their fixed slots until healing or natural death creates safe capacity', () => {
    const w = world(), first = w.unit(w.names[0], { move: 0 }), second = w.unit(w.names[1], { move: 0 });
    w.release();
    assert.equal(w.lifecycle.retireSupersededStorageFiller(first), false);
    assert.equal(w.lifecycle.retireSupersededStorageFiller(second), false);
    w.spawn.doWork();
    assert.equal(w.calls.length, 0, 'recovery never suicides an immobile resident or adds a third birth slot');
});

test('a lone carrier stalled on legacy boosting gets one native emergency colleague without losing its own demand', () => {
    const w = world(); const pending = w.unit(w.names[0], {
        boostPlan: { tier: 3, steps: [{ resource: 'XKH2O', parts: 4 }], completed: false } });
    w.release(); w.spawn.doWork();
    const emergency = Object.values(w.game.creeps).find(c => c !== pending);
    assert.ok(emergency);
    assert.equal(emergency.memory.boostPlan.tier, 0);
    assert.equal(w.lifecycle.retireSupersededStorageFiller(pending), false);
    assert.deepEqual(Array.from(w.release()), w.names);
});

test('development, mine-bound and evacuation carriers keep their original population and never enter storage handover', () => {
    const w = world(); const old = w.unit(), successor = w.unit(w.names[1], { carry: 33, move: 17 });
    w.room.memory.creepConfig[successor.name] = successor.memory;
    for (const data of [{ mineId: 'mine' }, { sourceId: 'container' }, { evacuationRoom: 'W1N1' }]) {
        old.memory.data = { sourceId: 'storage', ...data };
        assert.equal(w.lifecycle.retireSupersededStorageFiller(old), false);
    }
    old.memory.data = { sourceId: 'storage' }; old.memory.development = {};
    assert.equal(w.lifecycle.retireSupersededStorageFiller(old), false);
    delete old.memory.development; w.room.memory.evacuation = {};
    assert.equal(w.lifecycle.retireSupersededStorageFiller(old), false);
    delete w.room.memory.evacuation; w.room.controller.level = 7;
    assert.equal(w.lifecycle.retireSupersededStorageFiller(old), false);
});
