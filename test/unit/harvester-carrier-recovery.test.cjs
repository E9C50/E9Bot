const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world({ carrier = true } = {}) {
    const reads = { catalogs: 0, entries: 0 }, calls = { stationary: 0, transfers: [], body: 0 };
    const raw = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`other-${index}`, { role: 'manager' }]));
    raw.pending = { role: 'filler', spawnRoom: 'W1N1' };
    const configs = new Proxy(raw, {
        ownKeys(target) { reads.catalogs++; return Reflect.ownKeys(target); },
        get(target, name) { if (typeof name === 'string') reads.entries++; return Reflect.get(target, name); },
    });
    const pos = { x: 10, y: 10, roomName: 'W1N1', isNearTo: () => true, isEqualTo: () => true };
    const spawn = { id: 'spawn', pos, store: { getFreeCapacity: () => 300 } };
    const room = { name: 'W1N1', my: true, controller: { my: true, level: 8 },
        energyAvailable: 300, energyCapacityAvailable: 4000, memory: { creepConfig: configs },
        spawns: [spawn], extensions: [], containers: [], constructionSites: [] };
    const source = { id: 'source', room, pos, energy: 3000 };
    const creep = { name: 'harvester', room, pos, memory: { role: 'harvester', spawnRoom: room.name, ready: true, data: { sourceId: source.id } },
        store: { energy: 250, getCapacity: () => 250, getFreeCapacity: () => 0 },
        transfer(target, resource) { calls.transfers.push({ target: target.id, resource }); return 0; }, moveTo: () => 0 };
    const game = { time: 100, shard: { name: 'shard3' }, rooms: { W1N1: room }, creeps: { harvester: creep }, getObjectById: () => source };
    const filler = { name: 'carrier', spawning: false, ticksToLive: 1000, room,
        memory: { role: 'filler', spawnRoom: room.name },
        getActiveBodyparts(part) { calls.body++; return part === 'carry' || part === 'move' ? 1 : 0; } };
    if (carrier) game.creeps.carrier = filler;
    const loader = createSourceLoader({ globals: { Game: game, RESOURCE_ENERGY: 'energy', CARRY: 'carry', MOVE: 'move', OK: 0, ERR_NOT_IN_RANGE: -9 }, modules: {
        utils: { getDistance: () => 1 }, 'creep/development': { isDevelopingRoom: () => false },
        'creep/developmentLogistics': { sourceHarvestPosition: () => pos },
        'creep/stationaryMining': { prepareStationaryMining: () => true, runStationaryMining: () => { calls.stationary++; return true; } },
        'creep/sourceLinkMining': { retireSourceLinkMiner: () => false },
        'room/sourceLinks': { sourceLinkWithCenter: () => ({ id: 'link' }) },
    } });
    const behavior = loader.load('role/base/RoleBaseHarvester').default(creep.memory.data);
    return { reads, calls, raw, configs, room, source, creep, filler, game, behavior,
        run() { assert.equal(behavior.prepare(creep), true); behavior.source(creep); } };
}

test('a working local carrier skips catalog scans without disturbing stationary harvest work', () => {
    const w = world();
    for (let tick = 0; tick < 10; tick++) { w.run(); w.game.time++; }
    assert.equal(w.reads.catalogs, 0); assert.equal(w.reads.entries, 0);
    assert.equal(w.calls.body, 20, 'the existing carrier index still checks one CARRY/MOVE pair per tick');
    assert.equal(w.calls.stationary, 10); assert.deepEqual(w.calls.transfers, []);
});

test('healthy mature carriers never query recovery stock or preview pending bodies', () => {
    const w = world();
    Object.defineProperty(w.room, 'storage', { get() { assert.fail('healthy mining never reads emergency Storage stock'); } });
    Object.defineProperty(w.room, 'containers', { get() { assert.fail('healthy mining never scans emergency Containers'); } });
    for (let tick = 0; tick < 10; tick++) { w.run(); w.game.time++; }
    assert.equal(w.reads.catalogs, 0); assert.equal(w.reads.entries, 0);
    assert.equal(w.calls.stationary, 10);
});

test('prepare and work share one positive pending-carrier witness per room and tick', () => {
    const w = world({ carrier: false });
    w.run();
    assert.equal(w.reads.catalogs, 1);
    assert.equal(w.reads.entries, 42, '41 entries are scanned once; work rechecks only the pending entry');
    assert.deepEqual(w.calls.transfers, [{ target: 'spawn', resource: 'energy' }]);
    w.game.time++; w.run();
    assert.equal(w.reads.catalogs, 2);
    assert.equal(w.calls.transfers.length, 2);
});

test('a missing catalog witness is not cached, so same-tick carrier publication starts recovery immediately', () => {
    const w = world({ carrier: false }); delete w.raw.pending;
    w.run(); assert.equal(w.calls.stationary, 1);
    w.raw.pending = { role: 'filler', spawnRoom: w.room.name };
    w.run(); assert.deepEqual(w.calls.transfers, [{ target: 'spawn', resource: 'energy' }]);
});

test('removing, changing or spawning the cached carrier immediately stops catalog recovery', () => {
    for (const change of ['remove', 'role', 'home', 'spawn']) {
        const w = world({ carrier: false }); w.run();
        if (change === 'remove') delete w.raw.pending;
        if (change === 'role') w.raw.pending.role = 'manager';
        if (change === 'home') w.raw.pending.spawnRoom = 'W2N2';
        if (change === 'spawn') w.game.creeps.pending = { ...w.filler, name: 'pending', spawning: true };
        w.run();
        assert.equal(w.calls.transfers.length, 1, change);
        assert.equal(w.calls.stationary, 1, change);
    }
});

test('catalog replacement, shard changes and tick rollback do not reuse a stale positive witness', () => {
    for (const change of ['catalog', 'shard', 'rollback']) {
        const w = world({ carrier: false }); w.run();
        const before = w.reads.catalogs;
        if (change === 'catalog') w.room.memory.creepConfig = {};
        if (change === 'shard') w.game.shard.name = 'shard2';
        if (change === 'rollback') w.game.time--;
        w.run();
        if (change === 'catalog') assert.equal(w.calls.transfers.length, 1);
        else { assert.equal(w.calls.transfers.length, 2); assert.equal(w.reads.catalogs, before + 1); }
    }
});

test('full spawn capacity and foreign miners retain their normal work without catalog scans', () => {
    for (const change of ['full', 'foreign']) {
        const w = world({ carrier: false });
        if (change === 'full') w.room.energyAvailable = w.room.energyCapacityAvailable;
        if (change === 'foreign') w.creep.memory.spawnRoom = 'W2N2';
        w.run(); assert.equal(w.reads.catalogs, 0); assert.equal(w.calls.stationary, 1);
        assert.deepEqual(w.calls.transfers, []);
    }
});
