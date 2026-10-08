const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world() {
    const calls = [], objects = new Map(), safe = new Set(['E39N5', 'E38N5', 'E37N5']);
    const admitted = new Set(safe), policy = { warModeScope: 'empire' };
    const game = { time: 100, shard: { name: 'shard1' }, flags: {}, rooms: {}, getObjectById: id => objects.get(id) || null };
    const memory = { warMode: {} };
    class Position {
        constructor(x, y, roomName) { Object.assign(this, { x, y, roomName }); }
        getRangeTo(target) { const pos = target.pos || target; return this.roomName === pos.roomName ? Math.max(Math.abs(this.x - pos.x), Math.abs(this.y - pos.y)) : Infinity; }
        inRangeTo(target, range) { return this.getRangeTo(target) <= range; }
    }
    function room(name, my = false) {
        const value = { name, my, level: 8, memory: {}, sources: [], containers: [], droppedResource: [], portals: [],
            constructionSites: [], spawns: [], extensions: [], towers: [], find: () => [] };
        value.controller = { my, pos: new Position(25, 25, name) };
        game.rooms[name] = value;
        return value;
    }
    const home = room('E39N5', true), transit = room('E38N5'), remote = room('E37N5');
    home.spawns.push({ id: 'spawn', room: home, pos: new Position(25, 25, home.name) });
    const source = { id: 'mine', room: remote, pos: new Position(15, 15, remote.name), energy: 3000 };
    remote.sources.push(source); objects.set(source.id, source);
    const fallback = { roomName: remote.name, x: source.pos.x, y: source.pos.y, sourceId: source.id };
    let work, workReads = 0;
    const role = createSourceLoader({ globals: { Game: game, Memory: memory, RoomPosition: Position,
        RESOURCE_ENERGY: 'energy', FIND_DROPPED_RESOURCES: 'drops', OK: 0, ERR_NOT_IN_RANGE: -9, ERR_INVALID_TARGET: -7 },
        modules: {
            'creep/remoteRoads': { getRemoteRoadWork() { workReads++; return work; }, getRemoteRoadFallback: () => fallback,
                hasRemoteRoadRoom: (_, name) => admitted.has(name), isRemoteRoadRoomSafe: value => safe.has(value.name) },
            'settings/runtime': { runtimePolicy: policy },
            'role/base/RoleBaseBuilder': { __esModule: true, default: () => ({ target(creep) { calls.push({ type: 'legacy-build' }); return true; } }) },
            'role/base/RoleBaseUpgrader': { __esModule: true, default: () => ({ target() { calls.push({ type: 'legacy-upgrade' }); return true; } }) },
            'role/support/builderWorkPosition': { upgradeBuilderAtStablePosition() { calls.push({ type: 'legacy-upgrade' }); return true; } },
            utils: { getDistance: (first, second) => first.getRangeTo(second) },
        } }).load('role/adv/RoleAdvRemoteBuilder').default;
    function target(value = remote, kind = 'build', x = 20, y = 20) {
        const entity = { id: `${value.name}-${kind}`, room: value, pos: new Position(x, y, value.name),
            structureType: kind === 'repair' ? 'road' : 'container', hits: 100, hitsMax: 5000, progress: 99, progressTotal: 100 };
        objects.set(entity.id, entity);
        work = { roomName: value.name, x, y, id: entity.id, kind };
        return entity;
    }
    function unit(value = remote, energy = 0, data = { roadHome: home.name, sourceFlag: 'removed-flag', targetFlag: 'removed-flag' }) {
        const store = { energy, getFreeCapacity: () => 100 - store.energy, getCapacity: () => 100 };
        const creep = { name: 'road-worker', room: value, pos: new Position(20, 20, value.name), store, spawning: false, fatigue: 0,
            memory: { role: 'rBuilder', spawnRoom: home.name, working: energy > 0, data },
            goBoost() { calls.push({ type: 'boost' }); return true; },
            moveTo(target, options) { const pos = target.pos || target; calls.push({ type: 'move', roomName: pos.roomName, x: pos.x, y: pos.y, options }); return 0; },
            pickup(target) { calls.push({ type: 'pickup', id: target.id }); return creep.pos.getRangeTo(target) <= 1 ? 0 : -9; },
            withdraw(target) { calls.push({ type: 'withdraw', id: target.id }); return creep.pos.getRangeTo(target) <= 1 ? 0 : -9; },
            harvest(target) { calls.push({ type: 'harvest', id: target.id }); return creep.pos.getRangeTo(target) <= 1 ? 0 : -9; },
            build(target) { calls.push({ type: 'build', id: target.id }); return creep.pos.getRangeTo(target) <= 3 ? 0 : -9; },
            repair(target) { calls.push({ type: 'repair', id: target.id }); return creep.pos.getRangeTo(target) <= 3 ? 0 : -9; } };
        return creep;
    }
    function container(value = remote) {
        const entity = { id: 'mine-container', room: value, pos: new Position(20, 21, value.name), store: { energy: 1000 } };
        value.containers.push(entity); objects.set(entity.id, entity); return entity;
    }
    return { game, memory, home, transit, remote, source, safe, admitted, calls, policy, role, unit, target, container, objects,
        setWork(value) { work = value; }, workReads: () => workReads };
}

test('road workers draw from the current remote container without any source flag or same-room flag restriction', () => {
    const w = world(), creep = w.unit(); w.target(); w.container();
    assert.equal(w.role(creep.memory.data).prepare(creep), true);
    assert.equal(w.role(creep.memory.data).source(creep), true);
    assert.deepEqual(w.calls, [{ type: 'withdraw', id: 'mine-container' }]);
    assert.equal(creep.store.energy, 0, 'an issued withdraw intent does not make the native Store full this tick');
    assert.equal(creep.memory.working, false);
});

test('road workers prefer usable dropped mining energy before containers and harvest any local Source as a fallback', () => {
    const drop = world(), collector = drop.unit(); drop.target(); drop.container();
    drop.remote.droppedResource.push({ id: 'drop', resourceType: 'energy', amount: 100, pos: collector.pos });
    drop.role(collector.memory.data).source(collector);
    assert.deepEqual(drop.calls, [{ type: 'pickup', id: 'drop' }]);
    const harvest = world(), miner = harvest.unit(); harvest.target();
    harvest.role(miner.memory.data).source(miner);
    assert.equal(harvest.calls[0].type, 'harvest'); assert.equal(harvest.calls[0].id, 'mine');
    assert.equal(harvest.calls[1].type, 'move');
    assert.equal(harvest.calls[1].roomName, harvest.remote.name);
});

test('an empty worker in a transit room with no Source loads at the admitted remote mine', () => {
    const w = world(), creep = w.unit(w.transit); w.target(w.transit);
    assert.equal(w.role(creep.memory.data).source(creep), true);
    assert.equal(w.calls.length, 1); assert.equal(w.calls[0].type, 'move');
    assert.equal(w.calls[0].roomName, w.remote.name); assert.equal(w.calls[0].options.range, 1);
});

test('an empty worker in home can reach remote construction even when neither legacy flag exists', () => {
    const w = world(), creep = w.unit(w.home); w.target();
    assert.equal(w.role(creep.memory.data).source(creep), true);
    assert.equal(w.calls[0].roomName, w.remote.name); assert.equal(w.calls[0].options.range, 3);
});

for (const name of ['home', 'transit', 'remote']) test(`road worker builds and repairs selected work in the ${name} room without ordinary upgrade behavior`, () => {
    const w = world(), creep = w.unit(w[name], 100); const build = w.target(w[name]);
    assert.equal(w.role(creep.memory.data).prepare(creep), true);
    assert.equal(w.role(creep.memory.data).target(creep), true);
    assert.deepEqual(w.calls, [{ type: 'build', id: build.id }]);
    assert.equal(w[name].memory.needUpdateCache, undefined, 'incremental build intents retain the hauler path cache');
    assert.equal(creep.memory.dontPullMe, false);
    w.objects.delete(build.id); w.game.time++;
    w.role(creep.memory.data).prepare(creep);
    assert.equal(w[name].memory.needUpdateCache, true, 'completed sites refresh the room on the next real tick');
    w.game.time++; w.calls.length = 0; const road = w.target(w[name], 'repair');
    w.role(creep.memory.data).target(creep);
    assert.deepEqual(w.calls, [{ type: 'repair', id: road.id }]);
});

test('a loaded worker travels to its selected work in another admitted room with a cached movement path', () => {
    const w = world(), creep = w.unit(w.home, 100); w.target(w.remote, 'repair');
    w.role(creep.memory.data).target(creep);
    assert.equal(w.calls[0].type, 'repair'); assert.equal(w.calls[1].roomName, w.remote.name);
    assert.equal(w.calls[1].options.range, 3); assert.equal(w.calls[1].options.reusePath, 20);
});

test('full and exhausted native Stores switch phases, while a partial load can work when no further energy is available', () => {
    const w = world(), full = w.unit(w.remote, 100); w.target(); full.memory.working = false;
    assert.equal(w.role(full.memory.data).source(full), false); assert.equal(full.memory.working, true);
    assert.deepEqual(w.calls, []);
    w.game.time++; full.store.energy = 0;
    assert.equal(w.role(full.memory.data).target(full), false); assert.equal(full.memory.working, false);
    w.game.time++; full.store.energy = 25; w.source.energy = 0;
    assert.equal(w.role(full.memory.data).source(full), false); assert.equal(full.memory.working, true);
});

for (const reason of ['unsafe', 'removed', 'no-work']) test(`${reason} remote work makes the worker retreat instead of acquiring energy or building`, () => {
    const w = world(), creep = w.unit(w.remote, 100); w.target(); w.container();
    if (reason === 'unsafe') w.safe.delete(w.remote.name);
    if (reason === 'removed') w.admitted.delete(w.remote.name);
    if (reason === 'no-work') w.setWork(undefined);
    assert.equal(w.role(creep.memory.data).prepare(creep), false);
    assert.equal(w.calls.length, 1); assert.equal(w.calls[0].type, 'move'); assert.equal(w.calls[0].roomName, w.home.name);
    assert.equal(creep.memory.dontPullMe, false);
});

for (const reason of ['empire-war', 'home-war', 'room-war', 'home-evacuation']) test(`${reason} pauses road work and withdraws the remote worker`, () => {
    const w = world(), creep = w.unit(w.remote, 100); w.target();
    if (reason === 'empire-war') w.memory.warMode.E11N1 = true;
    if (reason === 'home-war') { w.policy.warModeScope = 'room'; w.memory.warMode[w.home.name] = true; }
    if (reason === 'room-war') { w.policy.warModeScope = 'room'; w.memory.warMode[w.remote.name] = true; }
    if (reason === 'home-evacuation') w.home.memory.evacuation = {};
    assert.equal(w.role(creep.memory.data).prepare(creep), false);
    assert.deepEqual(w.calls.map(call => call.type), ['move']); assert.equal(w.calls[0].roomName, w.home.name);
});

test('an idle home worker holds its existing load and remains movable instead of draining stores or upgrading', () => {
    const w = world(), creep = w.unit(w.home, 100); w.container(w.home);
    assert.equal(w.role(creep.memory.data).prepare(creep), false);
    assert.deepEqual(w.calls, []); assert.equal(creep.store.energy, 100); assert.equal(creep.memory.dontPullMe, false);
});

test('road work target lookup runs once per worker tick across prepare and work hooks', () => {
    const w = world(), creep = w.unit(w.remote, 100); w.target();
    w.role(creep.memory.data).prepare(creep); w.role(creep.memory.data).target(creep);
    assert.equal(w.workReads(), 1);
    w.game.time++; w.role(creep.memory.data).prepare(creep); w.role(creep.memory.data).target(creep);
    assert.equal(w.workReads(), 2);
});

test('ordinary manual RB and bootstrap workers retain their previous boost, source-flag and building behavior', () => {
    const w = world();
    const sourceFlag = { pos: w.source.pos, room: w.remote }; w.game.flags.source = sourceFlag; w.game.flags.target = sourceFlag;
    const manual = w.unit(w.home, 0, { sourceFlag: 'source', targetFlag: 'target' });
    assert.equal(w.role(manual.memory.data).prepare(manual), true);
    w.role(manual.memory.data).source(manual);
    assert.deepEqual(w.calls.map(call => call.type), ['boost', 'move']); assert.equal(w.calls[1].roomName, w.remote.name);
    const bootstrap = w.unit(w.remote, 100, { sourceFlag: 'source', targetFlag: 'target', bootstrap: true });
    w.calls.length = 0;
    assert.equal(w.role(bootstrap.memory.data).prepare(bootstrap), true);
    assert.equal(w.role(bootstrap.memory.data).target(bootstrap), true);
    assert.deepEqual(w.calls.map(call => call.type), ['legacy-build']); assert.equal(w.workReads(), 0);
});
