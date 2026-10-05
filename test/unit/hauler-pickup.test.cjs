const assert = require('node:assert/strict');
const test = require('node:test');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world() {
    const calls = [], objects = new Map(), routes = {}, steps = {}, memory = { warMode: {} };
    let scans = 0;
    class Position {
        constructor(x, y, roomName = 'E1S1') { Object.assign(this, { x, y, roomName }); }
        getRangeTo(target) { target = target.pos || target; return this.roomName === target.roomName ? Math.max(Math.abs(this.x - target.x), Math.abs(this.y - target.y)) : Infinity; }
        isNearTo(target) { return this.getRangeTo(target) <= 1; }
        inRangeTo(target, range) { return this.getRangeTo(target) <= range; }
        isEqualTo(target) { return this.getRangeTo(target) === 0; }
        getDirectionTo(x, y) { assert.equal(y, this.y); assert.equal(x, this.x + 1); return 3; }
    }
    const store = (energy, capacity, minerals = 0) => ({ energy, ...(minerals ? { H: minerals } : {}),
        getUsedCapacity: () => energy + minerals, getCapacity: () => capacity, getFreeCapacity: () => capacity - energy - minerals });
    function room(name = 'E1S1', owned = true) {
        const drops = [];
        const value = { name, level: 3, my: owned, memory: {}, sources: [], links: [], containers: [], spawns: [], extensions: [], towers: [], labs: [], constructionSites: [], structures: [], units: [],
            controller: { my: owned, level: 3, pos: new Position(25, 25, name), ...(owned ? { owner: { username: 'me' } } : {}) },
            find: type => type === 'dropped' ? drops : type === 'my' ? value.units : [], getTerrain: () => ({ get: () => 0 }), lookForAt: () => [] };
        Object.defineProperty(value, 'droppedResource', { get() { scans++; return drops; } });
        return { value, drops };
    }
    const current = room(), remote = room('E2S1', false), home = current.value;
    home.spawns.push({ id: 'spawn', owner: { username: 'me' }, pos: new Position(20, 20), store: store(0, 300) });
    const source = { id: 'source', pos: new Position(40, 10), energy: 3000 }, remoteSource = { id: 'remote-source', pos: new Position(40, 10, remote.value.name), energy: 3000 };
    home.sources.push(source); remote.value.sources.push(remoteSource); objects.set(source.id, source); objects.set(remoteSource.id, remoteSource);
    const game = { time: 100, shard: { name: 'shard1' }, flags: {}, rooms: { [home.name]: home, [remote.value.name]: remote.value }, creeps: {}, getObjectById: id => objects.get(id) || null };
    function drop(id = 'drop', x = 11, y = 10, amount = 100, type = 'energy', where = current) {
        const item = { id, pos: new Position(x, y, where.value.name), amount, resourceType: type };
        where.drops.push(item); objects.set(id, item); return item;
    }
    function unit(name = 'hauler', energy = 20, capacity = 100, role = 'filler', minerals = 0, where = current) {
        const value = { name, room: where.value, pos: new Position(10, 10, where.value.name), spawning: false, fatigue: 0,
            memory: { role, working: energy > 0, data: { sourceId: source.id, mineId: source.id } }, store: store(energy, capacity, minerals),
            pickup(target) { assert.equal(target.resourceType, 'energy'); assert.ok(value.pos.isNearTo(target)); calls.push({ type: 'pickup', name, id: target.id }); return 0; },
            move(direction) { calls.push({ type: 'move', name, direction }); return 0; },
            moveTo(target) { calls.push({ type: 'moveTo', name, target }); return 0; },
            withdraw(target) { calls.push({ type: 'withdraw', name, id: target.id }); return 0; },
            transfer(target, resource) { calls.push({ type: 'transfer', name, id: target.id, resource }); return 0; },
            drop() { throw Error('hauling pickup must never dump a mineral'); }, say() {}, getActiveBodyparts: () => 1 };
        value.room.units.push(value); game.creeps[name] = value; return value;
    }
    const movement = { creepPathCache: routes, getNextCachedStep: unit => steps[unit.name] };
    const loader = createSourceLoader({ globals: { Game: game, Memory: memory, RoomPosition: Position, BetterMove: movement,
        PathFinder: { search() { throw Error('on-route pickup must never call PathFinder'); } },
        RESOURCE_ENERGY: 'energy', FIND_DROPPED_RESOURCES: 'dropped', FIND_MY_CREEPS: 'my', FIND_HOSTILE_STRUCTURES: 'hostile-structures', FIND_HOSTILE_CREEPS: 'hostiles',
        STRUCTURE_CONTAINER: 'container', STRUCTURE_LINK: 'link', STRUCTURE_INVADER_CORE: 'invaderCore', STRUCTURE_TOWER: 'tower',
        OK: 0, ERR_NOT_IN_RANGE: -9, ERR_NO_PATH: -2,
    }, modules: { utils: { getDistance: (a, b) => a.getRangeTo(b), getClosestTarget: () => undefined },
        'settings/runtime': { runtimePolicy: { warModeScope: 'room' } } } });
    const pickup = loader.load('creep/haulerPickup'), delivery = loader.load('creep/haulerDelivery');
    function cached(unit, dst = source.pos) { routes[unit.name] = { dst }; steps[unit.name] = { x: 11, y: 10, roomName: unit.room.name, index: 1 }; }
    const behavior = { isNeed: () => true, prepare: () => true, source: unit => { calls.push({ type: 'source', name: unit.name }); return true; }, target: unit => { calls.push({ type: 'target', name: unit.name }); return true; } };
    function automatic(unit) {
        const data = { developmentRemote: { kind: 'hauler', homeRoom: home.name, targetRoom: remote.value.name, homePosition: { x: 20, y: 20 }, source: { id: remoteSource.id, x: 40, y: 10 } } };
        unit.memory.data = data;
        home.memory.developmentRemotes = { candidates: [], selectedRooms: [remote.value.name], intel: { [remote.value.name]: { seenAt: game.time, status: 'safe', sources: [data.developmentRemote.source] } } };
        return loader.load('creep/developmentRemotes').withDevelopmentRemoteRole(data, behavior);
    }
    return { calls, game, memory, home, current, remote, source, drop, unit, pickup, delivery, behavior, cached, automatic, loader, scans: () => scans };
}

test('adjacent recovery uses real native free capacity, ignores minerals and distant drops, and never projects the new cargo', () => {
    const w = world(), unit = w.unit();
    w.drop('mineral', 10, 10, 5000, 'H'); w.drop('far-energy', 13, 10, 5000); const drop = w.drop('adjacent-energy', 11, 10, 500);
    assert.equal(w.pickup.pickupAdjacentHaulerEnergy(unit), true);
    assert.deepEqual(w.calls, [{ type: 'pickup', name: unit.name, id: drop.id }]);
    assert.equal(unit.store.energy, 20); assert.equal(unit.store.getFreeCapacity(), 80);
    assert.equal(w.pickup.haulerEnergyPickupReserved(drop), 80);
    assert.equal(w.pickup.pickupAdjacentHaulerEnergy(unit), false, 'one native pickup per carrier/tick');
});

test('a full or mineral-carrying hauler and an adjacent mineral-only pile create no pickup or drop intent', () => {
    for (const kind of ['full', 'mixed', 'mineral-only', 'spawning', 'boosting', 'hostile']) {
        const w = world(), unit = w.unit('hauler', kind === 'full' ? 100 : 20, 100, 'rFiller', kind === 'mixed' ? 5 : 0);
        w.drop('drop', 11, 10, 500, kind === 'mineral-only' ? 'H' : 'energy');
        if (kind === 'spawning') unit.spawning = true;
        if (kind === 'boosting') unit.memory.boostPlan = { steps: [{}], completed: false };
        if (kind === 'hostile') unit.room.enemies = [{}];
        assert.equal(w.pickup.pickupAdjacentHaulerEnergy(unit), false, kind); assert.deepEqual(w.calls, []);
    }
});

test('native pickup batches share drop reservations and cannot request a smaller remainder, including a regular mine collector', () => {
    const w = world(), drop = w.drop('drop', 11, 10, 80), first = w.unit('first', 0, 50), second = w.unit('second', 0, 50), third = w.unit('third', 0, 30);
    assert.equal(w.pickup.pickupAdjacentHaulerEnergy(first), true);
    assert.equal(w.pickup.pickupAdjacentHaulerEnergy(second), false, 'pickup cannot cap its native 50 batch to the last 30');
    assert.equal(w.pickup.pickupAdjacentHaulerEnergy(third), true);
    assert.equal(w.pickup.haulerEnergyPickupReserved(drop), 80);
    w.game.time++; w.pickup.reserveHaulerEnergyPickup(first, drop, 50);
    assert.equal(w.pickup.pickupAdjacentHaulerEnergy(second), false, 'regular mine collection uses the same batch ledger');
    w.game.shard.name = 'shard2'; assert.equal(w.pickup.pickupAdjacentHaulerEnergy(second), true, 'shard transitions clear ephemeral reservations');
});

test('the shared carrier wrapper picks during delivery and keeps the exact cached native step without a transfer, withdraw or new path', () => {
    const w = world(), unit = w.unit(); w.drop(); w.cached(unit);
    const wrapped = w.delivery.withHaulerTraffic(w.behavior);
    assert.equal(wrapped.target(unit), true);
    assert.deepEqual(w.calls.map(call => call.type), ['pickup', 'move']);
    assert.equal(unit.memory.working, true); assert.equal(unit.memory.dontPullMe, false);
    wrapped.target(unit); assert.equal(w.calls.filter(call => call.type === 'pickup').length, 1);
});

test('loading pickup follows only a validated existing source route and does not advance a stale delivery route or replace a mine batch', () => {
    for (const kind of ['source-route', 'stale-route', 'at-source']) {
        const w = world(), unit = w.unit('hauler', 0); w.drop();
        if (kind === 'source-route') w.cached(unit);
        else if (kind === 'stale-route') w.cached(unit, { x: 20, y: 20, roomName: w.home.name });
        else { unit.pos.x = 39; w.drop('mine-drop', 40, 10); w.cached(unit); }
        w.delivery.withHaulerTraffic(w.behavior).source(unit);
        assert.deepEqual(w.calls.map(call => call.type), kind === 'source-route' ? ['pickup', 'move'] : ['source']);
    }
});

test('an idle loading carrier can recover adjacent stray energy without any global destination or movement search', () => {
    const w = world(), unit = w.unit('hauler', 0); w.drop();
    const idle = { ...w.behavior, source: () => false };
    w.delivery.withHaulerTraffic(idle).source(unit);
    assert.deepEqual(w.calls.map(call => call.type), ['pickup']);
    assert.equal(unit.memory.working, false);
});

test('actual RCL8 local and manual remote filler factories share adjacent recovery while preserving their identity and data', () => {
    for (const role of ['filler', 'rFiller']) {
        const w = world(), unit = w.unit('hauler', 20, 100, role); w.home.controller.level = 8; w.drop(); w.cached(unit);
        const original = JSON.stringify(unit.memory.data);
        const path = role === 'filler' ? 'role/base/RoleBaseFiller' : 'role/adv/RoleAdvRemoteFiller';
        w.loader.load(path).default(unit.memory.data).target(unit);
        assert.deepEqual(w.calls.map(call => call.type), ['pickup', 'move']);
        assert.equal(JSON.stringify(unit.memory.data), original);
    }
});

for (const returning of [false, true]) test(`automatic remote ${returning ? 'return' : 'outward'} prepare keeps its existing movement and picks only current adjacent energy`, () => {
    const w = world(), unit = w.unit('automatic', returning ? 20 : 0, 100, 'rFiller', 0, returning ? w.remote : w.current);
    w.drop('route-drop', 11, 10, 200, 'energy', returning ? w.remote : w.current);
    const behavior = w.automatic(unit), original = JSON.stringify(unit.memory.data);
    assert.equal(behavior.prepare(unit), false);
    assert.deepEqual(w.calls.map(call => call.type), ['moveTo', 'pickup']);
    assert.equal(unit.store.energy, returning ? 20 : 0); assert.equal(unit.memory.working, returning);
    assert.equal(JSON.stringify(unit.memory.data), original);
});

test('unsafe or war-paused automatic haulers keep safety movement without stopping for loose energy', () => {
    for (const kind of ['war', 'inactive']) {
        const w = world(), unit = w.unit('automatic', 20, 100, 'rFiller', 0, w.remote); w.drop('drop', 11, 10, 200, 'energy', w.remote);
        const behavior = w.automatic(unit);
        if (kind === 'war') w.memory.warMode[w.home.name] = true;
        else w.home.memory.developmentRemotes.selectedRooms = [];
        behavior.prepare(unit);
        assert.deepEqual(w.calls.map(call => call.type), ['moveTo'], kind);
    }
});

test('handoff reservations prohibit both participants from treating incoming energy or future outgoing capacity as pickup credit', () => {
    const w = world(), donor = w.unit('donor', 20), receiver = w.unit('receiver', 0); w.drop();
    w.pickup.blockHaulerEnergyPickup(donor); w.pickup.blockHaulerEnergyPickup(receiver);
    assert.equal(w.pickup.pickupAdjacentHaulerEnergy(donor), false);
    assert.equal(w.pickup.pickupAdjacentHaulerEnergy(receiver), false);
    assert.deepEqual(w.calls, []);
});

test('room energy piles are indexed once per tick and pickup import/lightweight fixtures do not require shard metadata', () => {
    const w = world(), a = w.unit('a', 0, 10), b = w.unit('b', 0, 10); w.drop('drop', 11, 10, 100);
    delete w.game.shard; delete w.game.time;
    assert.equal(w.pickup.pickupAdjacentHaulerEnergy(a), true); assert.equal(w.pickup.pickupAdjacentHaulerEnergy(b), true);
    assert.equal(w.scans(), 1);
    const loader = createSourceLoader(); assert.equal(typeof loader.load('creep/haulerPickup').pickupAdjacentHaulerEnergy, 'function');
});
