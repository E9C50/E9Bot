const assert = require('node:assert/strict');
const test = require('node:test');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world(level = 3) {
    const objects = new Map(), calls = [], reads = { wallsNeedRepair: 0, structuresNeedRepair: 0 };
    const lists = { wallsNeedRepair: [], structuresNeedRepair: [] };
    const game = { time: 100, shard: { name: 'shard1' }, cpu: { bucket: 10000 }, flags: {}, creeps: {}, rooms: {}, getObjectById: id => objects.get(id) || null };
    const memory = { warMode: {} };
    class Position {
        constructor(x, y, roomName = 'E39N5') { Object.assign(this, { x, y, roomName }); }
        getRangeTo(value) { const target = value.pos || value; return target.roomName === this.roomName ? Math.max(Math.abs(target.x - this.x), Math.abs(target.y - this.y)) : Infinity; }
        isNearTo(value) { return this.getRangeTo(value) <= 1; }
        inRangeTo(value, range) { return this.getRangeTo(value) <= range; }
        isEqualTo(value) { return this.getRangeTo(value) === 0; }
    }
    const p = (x, y) => new Position(x, y);
    const room = { name: 'E39N5', level, my: true, memory: {}, energyAvailable: 550, energyCapacityAvailable: 550,
        sources: [], containers: [], links: [], spawns: [], extensions: [], towers: [], labs: [], ramparts: [], walls: [],
        constructionSites: [], structures: [], units: [], enemies: [], droppedResource: [],
        getTerrain: () => ({ get: () => 0 }),
        find: type => type === 'minerals' ? [] : type === 'structures' ? room.structures : room.units,
        lookForAt: (type, x, y) => (type === 'structure' ? room.structures : room.units).filter(item => item.pos.x === x && item.pos.y === y),
        getDefenderCostMatrix: () => ({ get: () => 0 }) };
    room.controller = { id: 'controller', my: true, level, pos: p(30, 30) };
    game.rooms[room.name] = room; objects.set(room.controller.id, room.controller);
    for (const key of Object.keys(lists)) Object.defineProperty(room, key, { get() { reads[key]++; return lists[key]; } });
    function store(energy = 0, capacity = 100) {
        const value = { energy };
        Object.defineProperties(value, {
            getUsedCapacity: { value: () => value.energy }, getCapacity: { value: () => capacity },
            getFreeCapacity: { value: () => capacity - value.energy }
        });
        return value;
    }
    function structure(id, type = 'road', x = 11, y = 10, hits = 100, hitsMax = 1000) {
        const item = { id, structureType: type, pos: p(x, y), room, my: true, hits, hitsMax, store: store(), isActive: () => true };
        objects.set(id, item); room.structures.push(item);
        const group = { container: 'containers', link: 'links', spawn: 'spawns', rampart: 'ramparts', constructedWall: 'walls' }[type];
        if (group) room[group].push(item); else if (type === 'storage') room.storage = item;
        return item;
    }
    function damaged(id = 'road', type = 'road', hits = 100, hitsMax = 1000, x = 11, y = 10) {
        const item = structure(id, type, x, y, hits, hitsMax);
        lists[type === 'rampart' || type === 'constructedWall' ? 'wallsNeedRepair' : 'structuresNeedRepair'].push(item);
        return item;
    }
    function site(id = 'site', type = 'extension', x = 11, y = 11) {
        const item = { id, my: true, pos: p(x, y), structureType: type, progress: 0, progressTotal: 5000 };
        objects.set(id, item); room.constructionSites.push(item); return item;
    }
    function creep(name = 'builder', energy = 50, data = {}, x = 10, y = 10) {
        const unit = { id: name, name, room, pos: p(x, y), store: store(energy), spawning: false,
            memory: { role: 'builder', data, working: energy > 0 }, getActiveBodyparts: () => 1 };
        for (const action of ['build', 'repair', 'harvest', 'withdraw', 'upgradeController', 'transfer', 'pickup']) unit[action] = target => {
            calls.push({ action, name, target: target.id });
            // Native intents leave this tick's Store/hits unchanged until engine resolution.
            return unit.pos.inRangeTo(target, ['build', 'repair', 'upgradeController'].includes(action) ? 3 : 1) ? 0 : -9;
        };
        unit.moveTo = (target, options) => { calls.push({ action: 'moveTo', name, target: target.id, range: options?.range }); return 0; };
        unit.goBoost = () => { calls.push({ action: 'goBoost', name }); return true; };
        unit.say = () => {};
        unit.pickupDroppedResource = () => { calls.push({ action: 'pickupDroppedResource', name }); return false; };
        room.units.push(unit); game.creeps[name] = unit; objects.set(name, unit); return unit;
    }
    const loader = createSourceLoader({ globals: { Game: game, Memory: memory, RoomPosition: Position,
        console: { log: (...args) => calls.push({ action: 'log', message: args.map(String).join(' ') }) },
        WORK: 'work', CARRY: 'carry', RESOURCE_ENERGY: 'energy', OK: 0, ERR_NOT_IN_RANGE: -9, ERR_INVALID_TARGET: -7,
        BUILD_POWER: 5, REPAIR_POWER: 100, HARVEST_POWER: 2, CREEP_LIFE_TIME: 1500,
        FIND_MINERALS: 'minerals', FIND_STRUCTURES: 'structures', FIND_MY_CREEPS: 'myCreeps', FIND_CREEPS: 'creeps', FIND_POWER_CREEPS: 'powerCreeps',
        LOOK_STRUCTURES: 'structure', LOOK_CREEPS: 'creep', TERRAIN_MASK_WALL: 1,
        STRUCTURE_SPAWN: 'spawn', STRUCTURE_EXTENSION: 'extension', STRUCTURE_CONTAINER: 'container', STRUCTURE_LINK: 'link',
        STRUCTURE_RAMPART: 'rampart', STRUCTURE_WALL: 'constructedWall', STRUCTURE_ROAD: 'road' },
        modules: { utils: { getDistance: (a, b) => a.getRangeTo(b),
            getClosestTarget: (origin, values) => values.reduce((best, item) => !best || origin.getRangeTo(item) < origin.getRangeTo(best) ? item : best, undefined) },
            // Keep execution and the actual builder/helper real; unrelated empire orchestration is outside this fixture.
            role: { createRoleBehavior: (name, data) => name === 'builder' ? role(data) : undefined }, squard: {},
            'settings/creep': { warModeRole: ['builder'] },
            'settings/runtime': { runtimePolicy: { warModeScope: 'room', profiling: { creepDetails: false, roleDetails: false } } },
            'runtime/profiling': { isCpuProfilingEnabled: () => false, recordCpuSample() {} },
            './developmentRemotes': { isDevelopmentRemoteData: () => false },
            './developmentRetirement': { retireDevelopmentCreep: () => false },
            './haulerRelay': { runHaulerRelays() {}, haulerRelayHandled: () => false },
            'combat/missions': { runCombatUnits() {} }, 'combat/defense': { requestTowerSupport() {} }
        } });
    const role = loader.load('role/base/RoleBaseBuilder').default;
    const maintenance = loader.load('role/support/builderMaintenance');
    function tick(unit) { const behavior = role(unit.memory.data); if (behavior.prepare(unit)) behavior[unit.memory.working ? 'target' : 'source'](unit); }
    return { game, room, memory, objects, calls, reads, lists, p, structure, damaged, site, creep, role, maintenance, tick,
        execute: () => loader.load('creep/execution').creepWorkController(),
        policy: loader.load('settings/rolePolicy').rolePolicy,
        clear() { calls.length = 0; }, actions: action => calls.filter(call => call.action === action) };
}

for (const level of [3, 8]) test(`RCL${level} building takes priority over ordinary maintenance`, () => {
    const w = world(level), build = w.site(), repair = w.damaged('rampart', 'rampart', 100000, 10000000);
    const unit = w.creep(); w.tick(unit);
    assert.deepEqual(w.calls.filter(call => call.action !== 'goBoost'), [{ action: 'build', name: unit.name, target: build.id }]);
    assert.equal(repair.hits, 100000, 'the native snapshot is not mutated by an intent');
    assert.equal(w.actions('upgradeController').length, 0);
});

test('a mature nearby emergency rampart still receives its existing urgent repair before ordinary construction', () => {
    const w = world(8), unit = w.creep(); w.site(); const rampart = w.damaged('urgent', 'rampart', 1000, 10000000);
    w.tick(unit);
    assert.deepEqual(w.calls.filter(call => call.action !== 'goBoost'), [{ action: 'repair', name: unit.name, target: rampart.id }]);
});

for (const level of [3, 8]) for (const energy of [0, 50]) test(`RCL${level} ${energy ? 'loaded' : 'empty'} builder idles through every role entry without collecting, moving, upgrading or finding a boost lab`, () => {
    const w = world(level), stock = w.structure('stock', 'container'); stock.store.energy = 1000;
    const unit = w.creep('idle', energy, { sourceId: stock.id, buildTarget: 'finished', repairTarget: 'gone' });
    const source = { id: 'source', pos: w.p(10, 9), energy: 3000 }; w.room.sources.push(source); w.objects.set(source.id, source);
    const originalPosition = unit.pos;
    const behavior = w.role(unit.memory.data);
    behavior.prepare(unit); behavior.source(unit); behavior.target(unit);
    assert.deepEqual(w.calls, []);
    assert.equal(unit.pos, originalPosition);
});

test('a new construction site wakes an idle loaded builder on the next native tick', () => {
    const w = world(), unit = w.creep(); w.tick(unit); assert.deepEqual(w.calls, []);
    const target = w.site('new-site'); w.game.time++; w.tick(unit);
    assert.deepEqual(w.actions('build'), [{ action: 'build', name: unit.name, target: target.id }]);
    assert.equal(w.actions('repair').length, 0); assert.equal(w.actions('upgradeController').length, 0);
});

for (const level of [3, 8]) test(`actual RCL${level} execution skips an idle builder before the explicit boost-plan hook, then wakes it for a new job`, () => {
    const w = world(level), unit = w.creep();
    unit.memory.boostPlan = { completed: false, steps: [{ resource: 'LH', parts: 1 }] };
    w.execute();
    assert.deepEqual(w.calls, [], 'the execution-level boost hook must not send an unemployed builder to a Lab');
    const target = w.site('wakeup'); w.game.time++; w.execute();
    assert.ok(w.actions('goBoost').length > 0, 'a real new job still permits the existing boost plan');
    assert.deepEqual(w.actions('build'), [{ action: 'build', name: unit.name, target: target.id }]);
    assert.equal(w.actions('log').length, 0, 'execution must not silently swallow a fixture/native error');
});

for (const type of ['rampart', 'road', 'container', 'spawn']) test(`after completing construction the builder repairs a damaged ${type} instead of upgrading`, () => {
    const w = world(), unit = w.creep(); const build = w.site(); w.tick(unit);
    w.room.constructionSites.length = 0; w.objects.delete(build.id); const repair = w.damaged('damaged', type, 1000, type === 'rampart' ? 10000000 : 10000);
    w.game.time++; w.clear(); w.tick(unit);
    assert.deepEqual(w.actions('repair'), [{ action: 'repair', name: unit.name, target: repair.id }]);
    assert.equal(w.actions('build').length, 0); assert.equal(w.actions('upgradeController').length, 0);
});

test('a stale repair target is discarded and a still damaged ordinary structure is selected', () => {
    const w = world(), unit = w.creep('builder', 50, { repairTarget: 'destroyed' }); const road = w.damaged('road');
    w.tick(unit);
    assert.deepEqual(w.actions('repair'), [{ action: 'repair', name: unit.name, target: road.id }]);
    assert.equal(unit.memory.data.repairTarget, road.id);
});

test('new ordinary damage waits for the current maintenance energy load to finish before taking priority', () => {
    const w = world(), rampart = w.damaged('ram', 'rampart', 250000, 10000000), unit = w.creep('builder', 50, { repairTarget: rampart.id });
    w.tick(unit); assert.equal(w.actions('repair')[0].target, rampart.id);
    const road = w.damaged('road'); w.game.time++; w.clear(); w.tick(unit);
    assert.deepEqual(w.actions('repair'), [{ action: 'repair', name: unit.name, target: rampart.id }]);
    unit.store.energy = 0; w.game.time++; w.tick(unit);
    assert.equal(unit.memory.working, false); assert.equal(unit.memory.data.repairTarget, '');
    const stock = w.structure('stock', 'container'); stock.store.energy = 1000; unit.memory.data.sourceId = stock.id;
    w.game.time++; w.clear(); w.tick(unit);
    assert.deepEqual(w.actions('withdraw'), [{ action: 'withdraw', name: unit.name, target: stock.id }]);
    assert.equal(unit.store.energy, 0, 'the native withdrawal intent cannot immediately credit energy');
    assert.equal(unit.memory.data.repairTarget, '', 'no repair target is selected during refilling');
    unit.store.energy = 100; w.game.time++; w.clear(); w.tick(unit);
    assert.equal(unit.memory.working, true); assert.equal(unit.memory.data.repairTarget, '');
    w.game.time++; w.tick(unit);
    assert.deepEqual(w.actions('repair'), [{ action: 'repair', name: unit.name, target: road.id }]);
});

for (const level of [3, 8]) test(`RCL${level} maintenance keeps its target when a new critical rampart appears`, () => {
    const w = world(level), unit = w.creep(), target = w.damaged('first', 'rampart', 250000, 10000000);
    w.tick(unit); assert.equal(unit.memory.data.repairTarget, target.id);
    w.damaged('new-critical', 'rampart', 1, 10000000);
    for (let index = 0; index < 3; index++) {
        w.game.time++; w.clear(); w.tick(unit);
        assert.deepEqual(w.actions('repair'), [{ action: 'repair', name: unit.name, target: target.id }]);
    }
});

test('a loaded maintenance builder finishes its load after its target leaves the configured repair list, then idles', () => {
    const w = world(), unit = w.creep(), target = w.damaged('goal-reached', 'rampart', 250000, 10000000);
    w.tick(unit); assert.equal(unit.memory.data.repairTarget, target.id);
    w.lists.wallsNeedRepair.length = 0; target.hits = 250100;
    const previousReads = { ...w.reads };
    w.game.time++; w.clear(); w.execute();
    assert.deepEqual(w.actions('repair'), [{ action: 'repair', name: unit.name, target: target.id }]);
    assert.deepEqual(w.reads, previousReads, 'an active repair cycle does not scan the room lists');
    unit.store.energy = 0; w.game.time++; w.clear(); w.execute();
    assert.deepEqual(w.calls, []); assert.equal(unit.memory.working, false);
    assert.equal(unit.memory.data.repairTarget, undefined);
});

test('refilling a builder clears its previous target before starting the next maintenance load', () => {
    const w = world(), old = w.damaged('old', 'rampart', 200000, 10000000), next = w.damaged('next', 'road');
    const stock = w.structure('stock', 'container'); stock.store.energy = 1000;
    const unit = w.creep('builder', 100, { repairTarget: old.id, sourceId: stock.id }); unit.memory.working = false;
    w.tick(unit);
    assert.equal(unit.memory.data.repairTarget, ''); assert.equal(unit.memory.working, true);
    assert.equal(w.actions('repair').length, 0);
    w.game.time++; w.tick(unit);
    assert.deepEqual(w.actions('repair'), [{ action: 'repair', name: unit.name, target: next.id }]);
});

test('a fully repaired cached target is replaced even when the shared room list still contains its old entry', () => {
    const w = world(), first = w.damaged('first'), unit = w.creep('builder', 50, { repairTarget: first.id });
    w.tick(unit); const second = w.damaged('second'); first.hits = first.hitsMax;
    w.game.time++; w.clear(); w.tick(unit);
    assert.deepEqual(w.actions('repair'), [{ action: 'repair', name: unit.name, target: second.id }]);
    second.hits = second.hitsMax; w.game.time++; w.clear(); w.tick(unit);
    assert.deepEqual(w.calls, [], 'a stale list containing only healthy structures must not trigger collection or an upgrade fallback');
});

for (const level of [3, 8]) test(`an empty RCL${level} builder collects energy only after real repair work appears`, () => {
    const w = world(level), stock = w.structure('stock', 'container'); stock.store.energy = 500;
    const unit = w.creep('empty', 0, { sourceId: stock.id }); w.tick(unit); assert.deepEqual(w.calls, []);
    w.damaged('road'); w.game.time++; w.tick(unit);
    assert.deepEqual(w.actions('withdraw'), [{ action: 'withdraw', name: unit.name, target: stock.id }]);
    assert.equal(w.actions('harvest').length, 0); assert.equal(w.actions('upgradeController').length, 0);
});

test('repair target movement uses its native repair range and never switches to the controller', () => {
    const w = world(), target = w.damaged('far-road', 'road', 100, 1000, 20, 20), unit = w.creep();
    w.tick(unit);
    assert.equal(w.actions('moveTo').length, 1); assert.equal(w.actions('moveTo')[0].target, target.id);
    assert.equal(w.actions('upgradeController').length, 0); assert.equal(w.actions('harvest').length, 0);
});

test('repair indexing is shared by role prepare/source/target and multiple builders once per room/tick', () => {
    const w = world(), road = w.damaged('road'), units = [w.creep('first'), w.creep('second')];
    for (let index = 0; index < 20; index++) assert.equal(w.maintenance.builderHasWork(w.room), true);
    for (const unit of units) w.tick(unit);
    assert.deepEqual(w.reads, { wallsNeedRepair: 1, structuresNeedRepair: 1 });
    assert.equal(w.actions('repair').length, 2);
    road.hits = road.hitsMax; w.game.time++; w.clear();
    for (const unit of units) w.tick(unit);
    assert.deepEqual(w.reads, { wallsNeedRepair: 2, structuresNeedRepair: 2 });
    assert.deepEqual(w.calls, []);
});

test('low bucket spreads high barrier maintenance over the configured interval but leaves critical repairs active', () => {
    for (const kind of ['high', 'critical', 'ordinary']) {
        const w = world(), unit = w.creep(); w.game.cpu.bucket = w.policy.repairer.cpuMaintenance.minimumBucket - 1;
        const target = w.damaged(kind, kind === 'ordinary' ? 'road' : 'rampart', kind === 'high' ? w.policy.repairer.cpuMaintenance.criticalHits + 1 : 1000, 10000000);
        const interval = w.policy.repairer.cpuMaintenance.interval;
        for (let index = 0; index < interval; index++) { w.tick(unit); w.game.time++; }
        assert.equal(w.actions('repair').filter(call => call.target === target.id).length, kind === 'high' ? 1 : interval, kind);
        assert.equal(w.actions('upgradeController').length, 0);
    }
});
