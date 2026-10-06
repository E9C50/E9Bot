const assert = require('node:assert/strict');
const test = require('node:test');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function store(energy = 0, capacity = 100) {
    return { energy, getFreeCapacity() { return capacity - this.energy; }, getUsedCapacity() { return this.energy; }, getCapacity: () => capacity };
}

function world({ level = 2, capacity = 300, my = true, disabled = false } = {}) {
    const objects = new Map(), calls = [];
    class RoomPosition {
        constructor(x, y, roomName = 'W1N1') { Object.assign(this, { x, y, roomName }); }
        getRangeTo(value) { const target = value.pos || value; return Math.max(Math.abs(target.x - this.x), Math.abs(target.y - this.y)); }
        isNearTo(value) { return this.getRangeTo(value) <= 1; }
        isEqualTo(value) { return this.getRangeTo(value) === 0; }
    }
    const p = (x, y) => new RoomPosition(x, y);
    const room = {
        name: 'W1N1', level, controller: { id: 'controller', my, level, pos: p(25, 25) },
        memory: { roomFillJob: {}, fastUpgrade: !disabled }, energyCapacityAvailable: capacity,
        containers: [], links: [], sources: [], constructionSites: [], ramparts: [], wallsNeedRepair: [],
        spawns: [{ id: 'spawn', pos: p(20, 20) }], structures: [], getTerrain: () => ({ get: () => 0 }),
        lookForAt: (type, x, y) => type === 'structure' ? room.structures.filter(item => item.pos.x === x && item.pos.y === y) : []
    };
    const game = { time: 100, shard: { name: 'shard3' }, flags: {}, getObjectById: id => objects.get(id) || null };
    function source(id = 'source', x = 10, y = 10, energy = 3000) {
        const object = { id, pos: p(x, y), energy }; room.sources.push(object); objects.set(id, object); return object;
    }
    function structure(id, type, x, y, energy = 0) {
        const object = { id, pos: p(x, y), structureType: type, store: store(energy, 2000), my: true, isActive: () => true, hits: 250000, hitsMax: 250000 };
        objects.set(id, object); room.structures.push(object);
        if (type === 'container') room.containers.push(object);
        else if (type === 'link') room.links.push(object);
        else if (type === 'storage' || type === 'terminal') room[type] = object;
        return object;
    }
    function site(id, type, x, y) {
        const object = { id, pos: p(x, y), structureType: type, my: true };
        room.constructionSites.push(object); objects.set(id, object); return object;
    }
    const data = { sourceId: '', buildTarget: '' };
    const creep = { name: 'builder', room, pos: p(15, 15), store: store(50), memory: { role: 'builder', working: true, data }, getActiveBodyparts: part => part === 'work' ? 4 : 0 };
    creep.goBoost = () => { calls.push({ method: 'goBoost' }); return false; };
    for (const method of ['build', 'repair', 'upgradeController', 'withdraw', 'harvest']) creep[method] = target => {
        calls.push({ method, target: target.id });
        return creep.pos.getRangeTo(target) <= (['build', 'repair', 'upgradeController'].includes(method) ? 3 : 1) ? 0 : -9;
    };
    creep.moveTo = (target, options) => { calls.push({ method: 'moveTo', target: target.id, range: options?.range }); return 0; };
    creep.say = () => {};
    const loader = createSourceLoader({
        globals: {
            Game: game, Memory: { warMode: {} }, RoomPosition,
            WORK: 'work', RESOURCE_ENERGY: 'energy', ERR_NOT_IN_RANGE: -9,
            STRUCTURE_SPAWN: 'spawn', STRUCTURE_EXTENSION: 'extension', STRUCTURE_CONTAINER: 'container',
            STRUCTURE_ROAD: 'road', STRUCTURE_RAMPART: 'rampart', LOOK_STRUCTURES: 'structure', LOOK_CREEPS: 'creep', TERRAIN_MASK_WALL: 1
        },
        modules: { utils: {
            getDistance: (a, b) => a.getRangeTo(b),
            getClosestTarget: (origin, values) => values.reduce((closest, item) => !closest || origin.getRangeTo(item) < origin.getRangeTo(closest) ? item : closest, undefined)
        } }
    });
    const behavior = loader.load('role/base/RoleBaseBuilder').default(data);
    return {
        objects, calls, room, data, creep, game, source, site, structure, p, behavior,
        policy: loader.load('settings/development').developmentPolicy,
        intents: method => calls.filter(call => call.method === method), clear: () => { calls.length = 0; }
    };
}

test('a builder with construction work bypasses development boost waiting while RCL8, opt-out and non-owned rooms retain it', () => {
    const growing = world(); growing.site('pending', 'road', 40, 40);
    assert.equal(growing.behavior.prepare(growing.creep), true); assert.equal(growing.calls.length, 0);
    for (const options of [{ level: 8 }, { disabled: true, level: 7 }, { my: false, level: 7 }]) {
        const w = world(options);
        w.site('pending', 'road', 40, 40);
        Object.defineProperty(w.room, 'controllerLink', { get() { throw new Error('legacy builder read buffer'); } });
        assert.equal(w.behavior.prepare(w.creep), false);
        assert.equal(w.calls[0].method, 'goBoost');
    }
});

test('sub-550 capacity builder chooses extensions before nearer roads, containers and labs', () => {
    const w = world(); w.source();
    w.site('road', 'road', 15, 16); w.site('source-container', 'container', 10, 11); w.site('lab', 'lab', 16, 16);
    const extension = w.site('extension', 'extension', 30, 10);
    w.data.buildTarget = 'road';
    assert.equal(w.behavior.target(w.creep), true);
    assert.equal(w.data.buildTarget, extension.id);
    assert.equal(w.data.buildTarget, extension.id);
    assert.equal(w.intents('moveTo')[0].range, 3);
});

test('extension threshold is configurable and infrastructure priority begins exactly at 550 capacity', () => {
    const w = world({ capacity: 549 }); w.source();
    const extension = w.site('extension', 'extension', 15, 16), buffer = w.site('buffer', 'container', 23, 25);
    w.behavior.target(w.creep); assert.equal(w.intents('build')[0].target, extension.id);
    w.room.energyCapacityAvailable = 550; w.clear(); w.behavior.target(w.creep);
    assert.equal(w.data.buildTarget, buffer.id);
    w.policy.building.infrastructureMinimumCapacity = 600; w.clear(); w.behavior.target(w.creep);
    assert.equal(w.intents('build')[0].target, extension.id);
});

test('550-capacity builder prioritizes controller containers within three tiles', () => {
    const w = world({ capacity: 550 }); w.source();
    w.site('road', 'road', 15, 16); w.site('lab', 'lab', 16, 15); w.site('extension', 'extension', 16, 16);
    const buffer = w.site('buffer', 'container', 22, 25);
    w.behavior.target(w.creep);
    assert.equal(w.data.buildTarget, buffer.id);
});

test('550-capacity builder prioritizes source containers within one tile and rejects unrelated containers', () => {
    const w = world({ capacity: 550 }); w.source();
    w.site('unrelated', 'container', 15, 16); w.site('controller-far', 'container', 21, 25);
    const sourceContainer = w.site('source-container', 'container', 10, 11);
    w.behavior.target(w.creep);
    assert.equal(w.data.buildTarget, sourceContainer.id);
});

test('development builder chooses nearest among equally prioritized logistics sites', () => {
    const w = world({ capacity: 550 }); w.source();
    const sourceContainer = w.site('source-container', 'container', 10, 11); w.site('buffer', 'container', 23, 25);
    w.behavior.target(w.creep);
    assert.equal(w.data.buildTarget, sourceContainer.id);
});

test('other essential structures precede decorative roads and ramparts without blocking road-only work', () => {
    const w = world({ capacity: 800 }); w.source();
    w.site('road', 'road', 15, 16); w.site('rampart', 'rampart', 16, 15); const tower = w.site('tower', 'tower', 23, 20);
    w.behavior.target(w.creep); assert.equal(w.data.buildTarget, tower.id);
    w.room.constructionSites = w.room.constructionSites.filter(item => item.id !== tower.id); w.objects.delete(tower.id); w.clear();
    w.behavior.target(w.creep);
    assert.equal(w.intents('build')[0].target, 'road');
    assert.equal(w.room.memory.needUpdateCache, true, 'completed targets still invalidate the room site cache');
});

test('development builder prioritizes the first spawn before extension and logistics heuristics', () => {
    const w = world(); w.source(); w.room.spawns = [];
    w.site('extension', 'extension', 15, 16); const spawn = w.site('first-spawn', 'spawn', 30, 20);
    w.behavior.target(w.creep); assert.equal(w.data.buildTarget, spawn.id);
});

test('development infrastructure construction is not diverted by nearby low-hit rampart maintenance', () => {
    const w = world(), extension = w.site('extension', 'extension', 15, 16);
    const rampart = w.structure('damaged', 'rampart', 16, 15); rampart.hits = 1; w.room.ramparts = [rampart];
    w.behavior.target(w.creep);
    assert.equal(w.intents('build')[0].target, extension.id);
    assert.equal(w.intents('repair').length, 0);
});

test('development builder excludes even its cached controller buffer and withdraws from source logistics', () => {
    const w = world(); w.source(); w.creep.store = store(0);
    w.site('pending', 'road', 40, 40);
    const buffer = w.structure('controller-buffer', 'container', 22, 25, 1000);
    const mine = w.structure('mine', 'container', 15, 16, 1000); w.data.sourceId = buffer.id;
    w.behavior.source(w.creep);
    assert.equal(w.intents('withdraw')[0].target, mine.id);
    assert.equal(w.data.sourceId, mine.id);
});

test('development builder excludes a controller link and falls back to self-harvest without source stores', () => {
    const w = world(); const source = w.source('source', 15, 16); w.creep.store = store(0);
    w.site('pending', 'road', 40, 40);
    const link = w.structure('controller-link', 'link', 23, 25, 1000); w.room.controllerLink = link; w.data.sourceId = link.id;
    w.behavior.source(w.creep);
    assert.equal(w.intents('withdraw').length, 0);
    assert.equal(w.intents('harvest')[0].target, source.id);
    assert.equal(w.data.sourceId, source.id);
});

test('Source.id development builder can self-harvest even with an empty storage present', () => {
    const w = world(); const source = w.source('source', 10, 10); w.structure('storage', 'storage', 16, 16, 0);
    w.site('pending', 'road', 40, 40);
    w.creep.store = store(0); w.data.sourceId = source.id;
    w.behavior.source(w.creep);
    assert.equal(w.intents('harvest')[0].target, source.id);
    assert.equal(w.intents('moveTo')[0].range, 1);
});

test('development builder handles depleted sources, partial retained loads and empty working state', () => {
    const w = world(); w.source('source', 10, 10, 0); w.creep.memory.working = false;
    w.site('pending', 'road', 40, 40);
    assert.equal(w.behavior.source(w.creep), false);
    assert.equal(w.creep.memory.working, true, 'a partial load can still finish useful work while sources regenerate');
    w.creep.store = store(0); w.clear();
    assert.equal(w.behavior.target(w.creep), false);
    assert.equal(w.creep.memory.working, false);
    assert.equal(w.calls.length, 0);
});

test('full development builder transitions to work and an in-range loaded worker submits its build immediately', () => {
    const w = world(), extension = w.site('extension', 'extension', 15, 16);
    w.creep.store = store(100); w.creep.memory.working = false;
    assert.equal(w.behavior.source(w.creep), false); assert.equal(w.creep.memory.working, true);
    w.behavior.target(w.creep); assert.equal(w.intents('build')[0].target, extension.id);
    assert.equal(w.intents('moveTo').length, 0);
});

test('a living four WORK builder with quota one uses ten construction intents and at most two hundred energy in forty ticks', () => {
    const w = world(); w.site('extension', 'extension', 15, 16);
    w.room.memory.creepConfig = { builder: { development: { workParts: 1 } } };
    let spent = 0;
    for (let tick = 0; tick < 40; tick++) {
        w.clear(); w.behavior.target(w.creep);
        spent += w.intents('build').length * 4 * 5;
        w.game.time++;
    }
    assert.equal(spent, 200, 'one WORK quota spends BUILD_POWER five energy per tick on average');
});

test('reduced builder WORK quota never gates travel to an out-of-range infrastructure site', () => {
    const w = world(); const target = w.site('extension', 'extension', 30, 10);
    w.room.memory.creepConfig = { builder: { development: { workParts: 1 } } };
    for (let tick = 0; tick < 12; tick++) { w.behavior.target(w.creep); w.game.time++; }
    assert.equal(w.intents('moveTo').length, 12);
    assert.equal(w.intents('moveTo')[0].target, target.id);
    assert.equal(w.intents('build').length, 0, 'no out-of-range native build calls are needed');
});

test('RCL8 builder ignores development quotas and keeps all forty native build ticks', () => {
    const w = world({ level: 8 }); w.site('extension', 'extension', 15, 16);
    w.room.memory.creepConfig = { builder: { development: { workParts: 1 } } };
    w.creep.getActiveBodyparts = () => { throw new Error('RCL8 read development WORK'); };
    for (let tick = 0; tick < 40; tick++) { w.behavior.target(w.creep); w.game.time++; }
    assert.equal(w.intents('build').length, 40);
});

for (const options of [{ level: 8, capacity: 12900 }, { disabled: true, level: 7, capacity: 300 }, { my: false, level: 7, capacity: 550 }]) {
    test(`legacy builder retains closest-site and rampart-first behavior (${JSON.stringify(options)})`, () => {
        const w = world(options);
        Object.defineProperty(w.room, 'controllerLink', { get() { throw new Error('legacy builder read controller buffer'); } });
        const road = w.site('road', 'road', 15, 16); w.site('extension', 'extension', 30, 10);
        w.behavior.target(w.creep); assert.equal(w.intents('build')[0].target, road.id);
        const rampart = w.structure('damaged', 'rampart', 16, 15); rampart.hits = 1; w.room.ramparts = [rampart]; w.clear();
        w.behavior.target(w.creep); assert.equal(w.intents('repair')[0].target, rampart.id);
        assert.equal(w.intents('build').length, 0);
        w.creep.store = store(0); const controllerStore = w.structure('controller-store', 'container', 22, 25, 1000); w.data.sourceId = controllerStore.id; w.clear();
        w.behavior.source(w.creep); assert.equal(w.intents('moveTo')[0].target, controllerStore.id);
    });
}


test('RCL1 self-supplied constructor fills its 50-energy batch and then builds source infrastructure before logistics exist', () => {
    const w = world({ level: 1, capacity: 300 });
    const source = w.source('source', 15, 16);
    const site = w.site('source-container', 'container', 15, 16);
    w.creep.store = store(0, 50); w.creep.memory.working = false; w.data.sourceId = source.id;
    for (let tick = 0; tick < 25; tick++) {
        w.clear();
        assert.equal(w.behavior.source(w.creep), true);
        assert.equal(w.intents('harvest').length, 1);
        assert.equal(w.intents('build').length, 0);
        assert.equal(w.intents('moveTo').length, 0);
        assert.equal(w.creep.memory.working, false);
        w.creep.store.energy += 2; w.game.time++;
    }
    w.clear(); assert.equal(w.behavior.source(w.creep), false);
    assert.equal(w.creep.memory.working, true);
    assert.equal(w.intents('harvest').length, 0);
    assert.equal(w.behavior.target(w.creep), true);
    assert.equal(w.intents('build')[0].target, site.id);
    assert.equal(w.intents('moveTo').length, 0);
});
