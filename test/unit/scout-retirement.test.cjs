const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world({ pending = false, retry = false, shard = 'shard3' } = {}) {
    const calls = [], data = { unitKind: 'scout', done: true, phase: 'done', missionId: 'm', task: { sourceShard: 'shard3', sourceRoom: 'E41N8' },
        exploration: { reportPending: pending } };
    const creep = { name: 'SCOUT', spawning: false, memory: { role: 'sScout', data }, pos: { x: 25, y: 0, getRangeTo: () => 0 }, room: { name: 'E40N6' }, hits: 100, hitsMax: 100, ticksToLive: 1000,
        moveTo(target, options) { calls.push(['move', target, options]); return 0; } };
    const game = { shard: { name: shard }, spawns: {}, map: { getRoomLinearDistance: () => 1 } };
    const mission = { state: 'active', exploration: { status: 'failed' }, leases: { 'explorer:0': { name: retry ? creep.name : 'NEW' } } };
    const memory = { shardMissions: { m: mission } };
    class Position { constructor(x, y, roomName) { Object.assign(this, { x, y, roomName }); } }
    const loader = createSourceLoader({ globals: { Game: game, Memory: memory, RoomPosition: Position, ERR_NOT_IN_RANGE: -9 }, modules: {
        'settings/interShard': { interShardPolicy: { portalExploration: { minimumRemainingTicks: 50, roomTimeout: 150 } } },
        './missions': { isShardUnitData: value => value?.unitKind === 'scout' && !!value.task },
        './scoutMovement': { scoutMovementOptions: { ignoreSwamps: true, plainCost: 1, swampCost: 1 } },
        './scoutSafety': { moveScoutAwayFromThreat(unit) { if (unit.retreat) { calls.push(['flee']); return true; } return false; } },
    } });
    const original = { isNeed: () => true, prepare: () => { calls.push(['prepare']); return true; }, source: () => { calls.push(['work']); return true; }, target: () => true };
    const role = loader.load('shard/scoutRetirement').withScoutRetirement(data, original);
    function spawn(room, result = -9) {
        const value = { my: true, room: { name: room }, recycleCreep(unit) { calls.push(['recycle', unit.name]); return result; } };
        game.spawns[room] = value; return value;
    }
    return { data, creep, calls, game, mission, role, spawn };
}

test('historical done scout walks to source spawn for recycling while retaining done state', () => {
    const w = world(), spawn = w.spawn('E41N8');
    assert.equal(w.role.prepare(w.creep), false);
    assert.deepEqual(w.calls.map(call => call[0]), ['move']);
    assert.equal(w.calls[0][1], spawn); assert.equal(w.data.done, true); assert.equal(w.data.phase, 'done');
});

test('nearby spawn recycles without issuing another movement intent', () => {
    const w = world(); w.spawn('E40N6', 0); w.role.prepare(w.creep);
    assert.deepEqual(w.calls.map(call => call[0]), ['recycle']);
});

test('current healthy failed explorer waits for reuse and clears the border', () => {
    const w = world({ retry: true }); w.spawn('E41N8'); w.role.prepare(w.creep);
    assert.deepEqual(w.calls.map(call => call[0]), ['move']);
    assert.equal(w.calls[0][1].roomName, 'E40N6'); assert.equal(w.data.done, true);
});

test('damaged current scout is recycled instead of reused', () => {
    const w = world({ retry: true }); w.creep.hits = 50; w.spawn('E41N8'); w.role.prepare(w.creep);
    assert.deepEqual(w.calls.map(call => call[0]), ['move']);
});

test('pending report still runs original role and cannot be recycled prematurely', () => {
    const w = world({ pending: true }); w.spawn('E41N8');
    assert.equal(w.role.prepare(w.creep), true); assert.equal(w.role.source(w.creep), true);
    assert.deepEqual(w.calls.map(call => call[0]), ['prepare', 'work']);
});

test('completed scout on empty intermediate shard clears border without resuming old portal route', () => {
    const w = world({ shard: 'shard2' }); w.role.prepare(w.creep);
    assert.deepEqual(w.calls.map(call => call[0]), ['move']); assert.equal(w.calls[0][1].roomName, 'E40N6');
    w.creep.pos.y = 5; w.calls.length = 0; w.role.source(w.creep); assert.equal(w.calls.length, 0);
});

test('cancelled task releases current scout for recycling', () => {
    const w = world({ retry: true }); w.mission.state = 'cancelled'; w.spawn('E41N8'); w.role.prepare(w.creep);
    assert.deepEqual(w.calls.map(call => call[0]), ['move']);
});

test('current failed scout near a threat retreats before waiting for reuse', () => {
    const w = world({ retry: true }); w.creep.retreat = true; w.spawn('E41N8'); w.role.prepare(w.creep);
    assert.deepEqual(w.calls.map(call => call[0]), ['flee']);
});

test('a far busy spawn cannot freeze retirement movement', () => {
    const w = world(), spawn = w.spawn('E40N6', -4); w.creep.pos.getRangeTo = () => 20; w.role.prepare(w.creep);
    assert.deepEqual(w.calls.map(call => call[0]), ['move']); assert.equal(w.calls[0][1], spawn);
});
