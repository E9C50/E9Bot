const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function position(x, y, roomName = 'E39N6') {
    return { x, y, roomName, isNearTo(target) {
        const point = target.pos || target;
        return roomName === point.roomName && Math.max(Math.abs(x - point.x), Math.abs(y - point.y)) <= 1;
    } };
}

function world({ work = 0, carry = 0, move = 15, spawning = false, automatic = false, spawn = true, busy = false } = {}) {
    const calls = [], data = { sourceId: 'source', targetRoom: 'E39N6',
        ...(automatic ? { developmentRemote: { kind: 'harvester' } } : {}) };
    const home = { name: 'E39N5', spawns: [] }, remote = { name: 'E39N6' };
    const creep = { name: 'RHARVESTER_disabled', spawning, room: remote, pos: position(33, 41),
        memory: { role: 'rHarvester', spawnRoom: home.name, data, ready: true, working: true, dontPullMe: true },
        getActiveBodyparts(part) { return part === 'work' ? work : part === 'carry' ? carry : move; },
        moveTo(target, options) { calls.push(['move', target.pos || target, { ...options }]); this.memory.dontPullMe = true; return 0; },
        harvest() { throw Error('a disabled miner must never issue a harvest intent'); },
        suicide() { throw Error('retirement must use recycling instead of killing the miner'); },
    };
    if (spawn) home.spawns.push({ id: 'spawn', my: true, pos: position(20, 20, home.name),
        spawning: busy ? { name: 'another-worker' } : null,
        recycleCreep(unit) { calls.push(['recycle', unit.name]); return 0; } });
    const source = { id: 'source', pos: position(34, 40) };
    const game = { rooms: { [home.name]: home, [remote.name]: remote }, getObjectById() { return source; } };
    const loader = createSourceLoader({ globals: { Game: game, WORK: 'work', MOVE: 'move',
        RoomPosition: function (x, y, roomName) { return position(x, y, roomName); },
    }, modules: {
        utils: {},
        'creep/stationaryMining': { prepareStationaryMining() { calls.push(['prepare-mining']); return true; } },
        'creep/sourceLinkMining': { retireSourceLinkMiner() { return false; } },
        'room/sourceLinks': { sourceLinkWithCenter() { return undefined; } },
    } });
    return { calls, creep, home, data, source, game, loader,
        api: loader.load('creep/remoteHarvesterRetirement'), role: loader.load('role/adv/RoleAdvRemoteHarvester').default(data),
        heal() { work = 6; carry = 12; },
    };
}

test('a manual miner that lost all WORK leaves the Source before further mining and keeps retiring after healing', () => {
    const state = world();
    assert.equal(state.role.prepare(state.creep), false);
    assert.equal(state.data.disabledMinerRetiring, true);
    assert.equal(state.creep.memory.ready, false);
    assert.equal(state.creep.memory.working, false);
    assert.equal(state.creep.memory.dontPullMe, false);
    assert.deepEqual(state.calls[0], ['move', state.home.spawns[0].pos, { range: 1 }]);
    state.heal();
    assert.equal(state.role.prepare(state.creep), false, 'healing cannot send the retiring body back to occupy its Source');
    assert.equal(state.calls.length, 2);
    assert.ok(state.calls.every(call => call[0] === 'move'));
});

test('a disabled miner recycles through the nearest home Spawn even while that Spawn is busy', () => {
    const state = world({ busy: true });
    state.home.spawns.push({ id: 'nearby', my: true, spawning: { name: 'next-worker' }, pos: position(39, 39, state.home.name),
        recycleCreep(unit) { state.calls.push(['recycle-nearby', unit.name]); return 0; } });
    state.creep.room = state.home; state.creep.pos = position(38, 39, state.home.name);
    assert.equal(state.role.prepare(state.creep), false);
    assert.deepEqual(state.calls, [['recycle-nearby', state.creep.name]]);
});

test('healthy or zero-CARRY ground miners keep working while automatic and spawning bodies remain outside this retirement', () => {
    for (const options of [{ work: 6, carry: 12 }, { work: 6, carry: 0 }, { spawning: true }, { automatic: true }]) {
        const state = world(options);
        assert.equal(state.api.retireDisabledRemoteHarvester(state.creep, state.data), false);
        assert.equal(state.data.disabledMinerRetiring, undefined);
        assert.equal(state.calls.length, 0);
    }
});

test('without a home Spawn a disabled miner returns home once and stays available for a later Spawn', () => {
    const state = world({ spawn: false });
    assert.equal(state.role.prepare(state.creep), false);
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0][0], 'move');
    assert.deepEqual([state.calls[0][1].x, state.calls[0][1].y, state.calls[0][1].roomName], [25, 25, state.home.name]);
    assert.deepEqual(state.calls[0][2], { range: 20 });
    state.creep.room = state.home; state.creep.pos = position(25, 25, state.home.name);
    assert.equal(state.role.prepare(state.creep), false);
    assert.equal(state.calls.length, 1, 'retirement must not send the miner back to the remote when no Spawn exists');
    state.home.spawns.push({ id: 'rebuilt', my: true, pos: position(27, 25, state.home.name),
        recycleCreep(unit) { state.calls.push(['recycle', unit.name]); return 0; } });
    assert.equal(state.role.prepare(state.creep), false);
    assert.equal(state.calls.length, 2);
    assert.equal(state.calls[1][1], state.home.spawns[0].pos, 'the persistent retirement discovers a rebuilt home Spawn');
});

test('an immobile disabled miner yields its tile and can still recycle when pulled beside a Spawn', () => {
    const state = world({ move: 0 });
    assert.equal(state.role.prepare(state.creep), false);
    assert.equal(state.creep.memory.dontPullMe, false);
    assert.equal(state.calls.length, 0);
    state.creep.room = state.home; state.creep.pos = position(19, 20, state.home.name);
    assert.equal(state.role.prepare(state.creep), false);
    assert.deepEqual(state.calls, [['recycle', state.creep.name]]);
});
