const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world({ buffered = true } = {}) {
    const calls = [], objects = new Map(), walls = new Set(), units = [], intents = new Map();
    const game = { time: 100, shard: { name: 'shard1' }, rooms: {}, creeps: {}, powerCreeps: {}, flags: {},
        getObjectById: id => objects.get(id) || null };
    const distance = (a, b) => { b = b.pos || b; return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); };
    class RoomPosition {
        constructor(x, y, roomName = 'E39N5') { Object.assign(this, { x, y, roomName }); }
        getRangeTo(target) { return distance(this, target); }
        isNearTo(target) { return this.getRangeTo(target) <= 1; }
        isEqualTo(target) { return this.getRangeTo(target) === 0; }
        inRangeTo(target, range) { return this.getRangeTo(target) <= range; }
    }
    const p = (x, y) => new RoomPosition(x, y);
    const room = { name: 'E39N5', my: true, level: 3, memory: { creepConfig: {} }, sources: [], containers: [], links: [],
        structures: [], constructionSites: [], spawns: [], extensions: [], ramparts: [], portals: [], droppedResource: [], structuresNeedRepair: [],
        getTerrain: () => ({ get: (x, y) => walls.has(`${x}/${y}`) ? 1 : 0 }),
        lookForAt(type, x, y) {
            const list = type === 'structures' ? room.structures : type === 'creeps' ? units : type === 'power' ? Object.values(game.powerCreeps) : [];
            return list.filter(item => item.pos.x === x && item.pos.y === y);
        },
        find: type => type === 'sources' ? room.sources : type === 'dropped' ? room.droppedResource : [],
    };
    room.controller = { id: 'controller', my: true, level: 3, ticksToDowngrade: 10000, pos: p(11, 28) };
    const source = { id: 'source', energy: 3000, pos: p(36, 34), room };
    room.sources.push(source); objects.set(source.id, source); objects.set(room.controller.id, room.controller);
    const buffer = { id: 'buffer', structureType: 'container', pos: p(11, 31), room,
        store: { energy: 2000 }, hits: 250000, hitsMax: 250000 };
    if (buffered) { room.containers.push(buffer); room.structures.push(buffer); objects.set(buffer.id, buffer); }
    game.rooms[room.name] = room;
    const transport = { readRemoteShardState: () => undefined, getLocalShardState: () => ({ reports: {} }), markShardStateDirty() {} };
    const loader = createSourceLoader({ globals: { Game: game, Memory: { warMode: {}, creeps: {} }, RoomPosition,
        RESOURCE_ENERGY: 'energy', WORK: 'work', LOOK_STRUCTURES: 'structures', LOOK_CREEPS: 'creeps', LOOK_POWER_CREEPS: 'power',
        FIND_DROPPED_RESOURCES: 'dropped', TERRAIN_MASK_WALL: 1,
        STRUCTURE_ROAD: 'road', STRUCTURE_CONTAINER: 'container', STRUCTURE_RAMPART: 'rampart', STRUCTURE_SPAWN: 'spawn',
        STRUCTURE_WALL: 'wall', OK: 0, ERR_NOT_IN_RANGE: -9, ERR_NO_PATH: -2, ERR_INVALID_TARGET: -7 },
        modules: { utils: { getDistance: distance, getClosestTarget: (pos, values) => [...values].sort((a, b) => distance(pos, a) - distance(pos, b))[0] },
            'shard/transport': transport, './transport': transport,
            'shard/travel': { travelPortalRoute: () => ({ status: 'arrived' }) }, './travel': { travelPortalRoute: () => ({ status: 'arrived' }) },
            'shard/routing': { ensureUnitRoute: () => true, clearTravelPreparation() {} }, './routing': { ensureUnitRoute: () => true, clearTravelPreparation() {} } } });
    function creep(name, role, x, y, energy = 400) {
        const task = { id: 'aid', key: 'shard3:aid', sourceShard: 'shard3', sourceRoom: 'E1S1', targetShard: 'shard1', targetRoom: room.name,
            route: [{ shard: 'shard3', roomName: 'E1S1', x: 20, y: 20, destinationShard: 'shard1', destinationRoom: room.name }],
            claim: true, builders: 2, haulers: 0, targetLevel: 4, energyAmount: 0, homeEnergyReserve: 10000 };
        const data = role === 'sBuilder' ? { missionId: task.key, task, unitKind: 'builder', phase: 'work', originShard: 'shard3', route: task.route, hopIndex: 1 }
            : { sourceFlag: source.id, targetFlag: source.id, bootstrap: true };
        const store = { energy, getCapacity: () => 800, getFreeCapacity: () => 800 - store.energy };
        const unit = { name, id: name, my: true, room, pos: p(x, y), store, spawning: false, fatigue: 0,
            memory: { role, working: true, data }, goBoost: () => true, getActiveBodyparts: () => 8,
            upgradeController(target) { const result = distance(unit.pos, target) <= 3 ? 0 : -9;
                calls.push({ type: 'upgrade', name, result }); if (result === 0) intents.set(name, { ...intents.get(name), upgrade: true }); return result; },
            moveTo(target, options) { const pos = target.pos || target; calls.push({ type: 'move', name, x: pos.x, y: pos.y, options });
                intents.set(name, { ...intents.get(name), move: { x: pos.x, y: pos.y } }); return 0; },
            harvest() { calls.push({ type: 'harvest', name }); return 0; },
            withdraw(target) {
                const result = distance(unit.pos, target) > 1 ? -9 : target.store.energy > 0 && unit.store.getFreeCapacity() > 0 ? 0 : -6;
                calls.push({ type: 'withdraw', name, target: target.id, result });
                if (result === 0) intents.set(name, { ...intents.get(name), withdraw: { target, amount: Math.min(target.store.energy, unit.store.getFreeCapacity()) } });
                return result;
            },
            build(target) { calls.push({ type: 'build', name }); return distance(unit.pos, target) <= 3 ? 0 : -9; },
            transfer(target) { calls.push({ type: 'transfer', name }); return distance(unit.pos, target) <= 1 ? 0 : -9; },
        };
        game.creeps[name] = unit; units.push(unit); objects.set(name, unit);
        return unit;
    }
    function behavior(unit) {
        return unit.memory.role === 'sBuilder' ? loader.load('shard/workers').createShardRole('builder')(unit.memory.data)
            : loader.load('role/adv/RoleAdvRemoteBuilder').default(unit.memory.data);
    }
    function nextTick() {
        for (const [name, intent] of intents) {
            const unit = game.creeps[name];
            if (intent.upgrade) unit.store.energy = Math.max(0, unit.store.energy - 8);
            if (intent.withdraw) {
                const amount = Math.min(intent.withdraw.amount, intent.withdraw.target.store.energy, unit.store.getFreeCapacity());
                unit.store.energy += amount; intent.withdraw.target.store.energy -= amount;
            }
            if (!intent.move) continue;
            const destination = intent.move;
            const neighbors = [];
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                const x = unit.pos.x + dx, y = unit.pos.y + dy;
                if (walls.has(`${x}/${y}`) || x === room.controller.pos.x && y === room.controller.pos.y ||
                    units.some(other => other !== unit && other.pos.x === x && other.pos.y === y)) continue;
                neighbors.push({ x, y });
            }
            neighbors.sort((a, b) => distance(a, destination) - distance(b, destination));
            const next = neighbors[0];
            if (next && distance(next, destination) < distance(unit.pos, destination)) unit.pos = p(next.x, next.y);
        }
        intents.clear(); game.time++;
    }
    return { game, room, source, buffer, units, calls, walls, p, creep, behavior, nextTick,
        logistics: loader.load('creep/developmentLogistics'), helper: loader.load('role/support/builderWorkPosition') };
}

for (const role of ['sBuilder', 'rBuilder']) test(`${role} keeps two productive outer/controller-container seats for thirty ticks without swapping or moving inward`, () => {
    const w = world(), a = w.creep('a', role, 11, 31), b = w.creep('b', role, 12, 31);
    const original = w.units.map(unit => `${unit.pos.x}/${unit.pos.y}`);
    for (let tick = 0; tick < 30; tick++) {
        for (const unit of tick % 2 ? [b, a] : [a, b]) assert.equal(w.behavior(unit).target(unit), true);
        assert.equal(a.memory.dontPullMe, true); assert.equal(b.memory.dontPullMe, true);
        w.nextTick();
        assert.deepEqual(w.units.map(unit => `${unit.pos.x}/${unit.pos.y}`), original);
    }
    assert.equal(w.calls.filter(call => call.type === 'move').length, 0);
    assert.equal(w.calls.filter(call => call.type === 'upgrade' && call.result === 0).length, 60);
    assert.equal(w.calls.filter(call => call.type === 'withdraw' && call.result === 0).length, 60);
    assert.equal(a.store.energy, 792); assert.equal(b.store.energy, 792);
    assert.equal(w.buffer.store.energy, 736, 'native withdraw plus upgrade consumes actual supplied energy');
});

for (const role of ['sBuilder', 'rBuilder']) test(`${role} protects a productive construction tile and approaches without swapping its working partner`, () => {
    const w = world(), site = { id: 'site', structureType: 'extension', pos: w.p(12, 29) };
    w.room.constructionSites.push(site);
    const working = w.creep('working', role, 11, 31), approaching = w.creep('approaching', role, 12, 38);
    for (let tick = 0; tick < 5; tick++) {
        w.calls.length = 0;
        w.behavior(working).target(working);
        assert.equal(working.memory.dontPullMe, true);
        assert.equal(w.calls.filter(c => c.type === 'move').length, 0);
        w.behavior(approaching).target(approaching);
        const move = w.calls.find(c => c.type === 'move');
        assert.equal(move.options.ignoreCreeps, false);
        assert.equal(approaching.memory.dontPullMe, false);
        w.game.time++;
    }
    working.store.energy = 0; w.calls.length = 0;
    w.behavior(working).target(working);
    assert.equal(working.memory.dontPullMe, false, 'a collecting worker releases its construction seat');
});

test('mixed aid workers share reservations with fixed upgraders, retain approach seats, and stop moving as soon as they can work', () => {
    const w = world(), stationary = w.creep('fixed', 'upgrader', 11, 31);
    w.logistics.controllerUpgradePosition(stationary, w.buffer);
    const a = w.creep('a', 'sBuilder', 11, 40), b = w.creep('b', 'rBuilder', 12, 40), fixedArrival = w.creep('future-fixed', 'upgrader', 14, 40);
    w.behavior(a).target(a); w.behavior(b).target(b);
    const goals = w.calls.filter(call => call.type === 'move');
    const third = w.logistics.controllerUpgradePosition(fixedArrival, w.buffer);
    assert.equal(new Set([...goals.map(move => `${move.x}/${move.y}`), `${third.x}/${third.y}`]).size, 3);
    for (const move of goals) {
        assert.notEqual(`${move.x}/${move.y}`, '11/31');
        assert.equal(move.options.range, 0); assert.equal(move.options.ignoreCreeps, false);
    }
    assert.equal(a.memory.dontPullMe, false); assert.equal(b.memory.dontPullMe, false);
    w.nextTick();
    w.calls.length = 0;
    w.behavior(b).target(b); w.behavior(a).target(a);
    for (const move of w.calls.filter(call => call.type === 'move')) {
        const original = goals.find(previous => previous.name === move.name);
        assert.equal(`${move.x}/${move.y}`, `${original.x}/${original.y}`, 'tick order cannot churn an existing approach destination');
    }
    for (let tick = 0; tick < 20; tick++) { w.nextTick(); w.behavior(a).target(a); w.behavior(b).target(b); }
    assert.ok(a.pos.inRangeTo(w.room.controller, 3)); assert.ok(b.pos.inRangeTo(w.room.controller, 3));
    assert.equal(a.pos.isEqualTo(b), false);
    assert.equal(stationary.pos.isEqualTo(w.buffer), true);
    const moveCount = w.calls.filter(call => call.type === 'move').length;
    for (let tick = 0; tick < 5; tick++) { w.nextTick(); w.behavior(b).target(b); w.behavior(a).target(a); }
    assert.equal(w.calls.filter(call => call.type === 'move').length, moveCount);
    assert.equal(a.memory.dontPullMe, true); assert.equal(b.memory.dontPullMe, true);
});

test('controllerUpgradePosition keeps an existing valid outer seat and protects it while seat capacity ignores occupants', () => {
    const w = world(), unit = w.creep('fixed', 'upgrader', 11, 31);
    const selected = w.logistics.controllerUpgradePosition(unit, w.buffer);
    assert.equal(selected.isEqualTo(unit.pos), true, 'an open inner seat does not displace a working occupant');
    assert.equal(unit.memory.dontPullMe, true);
    assert.equal(w.logistics.controllerUpgradeSeatCount(w.room, w.buffer), 6);
    for (const [x, y] of [[10, 30], [11, 30], [12, 30], [10, 31], [12, 31]]) w.creep(`fixed-${x}-${y}`, 'upgrader', x, y);
    assert.equal(w.logistics.controllerUpgradeSeatCount(w.room, w.buffer), 6, 'static capacity includes temporarily occupied seats');
    const arriving = w.creep('arriving', 'sBuilder', 11, 40);
    assert.equal(w.behavior(arriving).target(arriving), false);
    assert.equal(w.calls.filter(call => call.type === 'move').length, 0, 'full seats are not swapped out');
    assert.equal(arriving.memory.dontPullMe, false);
});

test('without a controller buffer mobile workers reserve separate open seats and preserve the selected destination across ticks', () => {
    const w = world({ buffered: false }), a = w.creep('a', 'sBuilder', 11, 40), b = w.creep('b', 'rBuilder', 12, 40);
    const occupied = w.creep('miner', 'harvester', 11, 31);
    occupied.memory.dontPullMe = true;
    w.behavior(a).target(a); w.behavior(b).target(b);
    const goals = w.calls.filter(call => call.type === 'move');
    assert.equal(goals.length, 2);
    assert.equal(new Set(goals.map(move => `${move.x}/${move.y}`)).size, 2);
    assert.ok(goals.every(move => `${move.x}/${move.y}` !== '11/31' && move.options.ignoreCreeps === false));
    w.nextTick(); w.calls.length = 0;
    w.behavior(b).target(b); w.behavior(a).target(a);
    for (const move of w.calls) assert.equal(`${move.x}/${move.y}`, `${goals.find(previous => previous.name === move.name).x}/${goals.find(previous => previous.name === move.name).y}`);
    assert.equal(occupied.pos.isEqualTo(w.p(11, 31)), true);
});

test('departing or empty workers release movement protection and emergency controller upgrades use the same stable work helper', () => {
    const w = world(), unit = w.creep('aid', 'sBuilder', 11, 31);
    w.room.controller.ticksToDowngrade = 1;
    w.room.constructionSites = [{ id: 'spawn-site', structureType: 'spawn', pos: w.p(20, 20) }];
    w.behavior(unit).target(unit);
    assert.equal(unit.memory.dontPullMe, true); assert.equal(w.calls.some(call => call.type === 'build'), false);
    unit.store.energy = 0;
    w.buffer.store.energy = 0;
    assert.equal(w.helper.upgradeBuilderAtStablePosition(unit, w.room.controller), false);
    assert.equal(unit.memory.dontPullMe, false); assert.equal(unit.memory.working, false);
    unit.store.energy = 200; unit.memory.working = true; unit.pos = w.p(11, 40);
    w.nextTick(); w.behavior(unit).target(unit);
    assert.equal(unit.memory.dontPullMe, false);
    assert.equal(w.calls.at(-1).type, 'move');
    assert.equal(w.calls.at(-1).options.ignoreCreeps, false);
    for (const role of ['sBuilder', 'rBuilder']) {
        const fresh = world(), departing = fresh.creep('departing', role, 11, 31, 0);
        fresh.room.constructionSites = [{ id: 'new-site', structureType: 'spawn', pos: fresh.p(20, 20) }];
        departing.memory.dontPullMe = true;
        fresh.behavior(departing).source(departing);
        assert.equal(departing.memory.dontPullMe, false, `${role} loading releases its previous work lock`);
        assert.equal(departing.memory.working, false);
        assert.equal(fresh.calls.at(-1).type, 'withdraw');
    }
});

for (const role of ['sBuilder', 'rBuilder']) test(`${role} refills an empty occupied work seat without a same-tick upgrade and resumes continuously after the native Store changes`, () => {
    const w = world(), unit = w.creep('aid', role, 11, 31, 0);
    w.behavior(unit).source(unit);
    assert.equal(unit.store.energy, 0, 'withdraw is an intent, not a synchronous Store change');
    assert.equal(w.buffer.store.energy, 2000);
    assert.equal(unit.memory.working, false);
    assert.equal(unit.memory.dontPullMe, true);
    assert.deepEqual(w.calls.map(call => call.type), ['withdraw']);
    w.nextTick();
    assert.equal(unit.store.energy, 800);
    for (let tick = 0; tick < 120; tick++) {
        w.behavior(unit)[unit.memory.working ? 'target' : 'source'](unit);
        w.nextTick();
    }
    assert.equal(w.calls.filter(call => call.type === 'upgrade' && call.result === 0).length, 120);
    assert.equal(w.calls.filter(call => call.type === 'move' || call.type === 'harvest').length, 0);
    assert.equal(unit.pos.isEqualTo(w.buffer), true);
    assert.equal(unit.store.energy, 792);
    assert.equal(w.buffer.store.energy, 248, 'continuous work draws 800 initial energy plus 119 eight-energy refills');
});

test('a productive distant work seat never moves for refills and a nearer real buffer is used when the preferred link is elsewhere', () => {
    const w = world(), distant = w.creep('distant', 'sBuilder', 11, 25);
    w.behavior(distant).target(distant);
    assert.deepEqual(w.calls.map(call => call.type), ['upgrade']);
    const link = { id: 'preferred-link', structureType: 'link', my: true, pos: w.p(11, 27), room: w.room,
        isActive: () => true, store: { energy: 800 } };
    w.room.links.push(link); w.room.structures.push(link); w.room.controllerLink = link;
    w.nextTick(); w.calls.length = 0;
    const nearby = w.creep('nearby', 'sBuilder', 11, 31);
    w.behavior(nearby).target(nearby);
    assert.deepEqual(w.calls.map(call => [call.type, call.target]), [['upgrade', undefined], ['withdraw', 'buffer']]);
    assert.equal(w.calls.some(call => call.type === 'move'), false);
    w.buffer.my = false;
    w.nextTick(); w.calls.length = 0;
    w.behavior(nearby).target(nearby);
    assert.equal(w.calls.some(call => call.type === 'withdraw'), false, 'an explicitly hostile store is never a controller supply buffer');
});

test('switching from continuous upgrade to construction or production filling releases the previous upgrade seat lock', () => {
    const w = world(), unit = w.creep('aid', 'sBuilder', 11, 31);
    w.behavior(unit).target(unit); assert.equal(unit.memory.dontPullMe, true);
    w.nextTick(); w.calls.length = 0;
    w.room.constructionSites.push({ id: 'spawn-site', structureType: 'spawn', pos: w.p(20, 20) });
    w.behavior(unit).target(unit);
    assert.equal(unit.memory.dontPullMe, false);
    assert.deepEqual(w.calls.map(call => call.type), ['build', 'move']);
    w.nextTick(); w.calls.length = 0;
    w.room.constructionSites = [];
    w.room.controller.level = unit.memory.data.task.targetLevel;
    w.room.extensions.push({ id: 'extension', my: true, pos: w.p(20, 20), store: { getFreeCapacity: () => 50 } });
    unit.memory.dontPullMe = true;
    w.behavior(unit).target(unit);
    assert.equal(unit.memory.dontPullMe, false);
    assert.deepEqual(w.calls.map(call => call.type), ['transfer', 'move']);
});

test('controller seat capacity excludes permanent walls, natural objects and obstacles while RCL8 selection keeps its legacy guard', () => {
    const w = world(), unit = w.creep('fixed', 'upgrader', 11, 31);
    w.walls.add('10/30');
    w.room.sources.push({ id: 'controller-source', pos: w.p(12, 30) });
    w.room.structures.push({ structureType: 'spawn', pos: w.p(10, 31) });
    assert.equal(w.logistics.controllerUpgradeSeatCount(w.room, w.buffer), 3);
    w.room.controller.level = 8;
    Object.defineProperty(w.room.memory, 'fastUpgrade', { get() { throw new Error('RCL8 must not read development state'); } });
    assert.equal(w.logistics.controllerUpgradePosition(unit, w.buffer), undefined);
});
