const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function coordinates(name) {
    const [, horizontal, x, vertical, y] = /^([WE])(\d+)([NS])(\d+)$/.exec(name);
    return [horizontal === 'W' ? -Number(x) - 1 : Number(x), vertical === 'N' ? -Number(y) - 1 : Number(y)];
}
function roomName(x, y) { return `${x < 0 ? 'W' + (-x - 1) : 'E' + x}${y < 0 ? 'N' + (-y - 1) : 'S' + y}`; }

/** Native map and room movement are simulated; both exploration and its room selector are real source modules. */
function world() {
    const clock = { now: 1000000 }, calls = [], moves = [], noPaths = new Set();
    const avoided = ['E0S10', 'E10S0'];
    const avoidedByShard = { shard0: [], shard1: [], shard2: avoided, shard3: [] };
    const closed = new Set(Array.from({ length: 5 }, (_, i) => `E${i + 8}S15`));
    const local = { version: 1, transfers: {}, acks: {}, reports: {}, scoutProofs: {} };
    const progress = { revision: 'nearest-1', goalShard: 'shard1', goalRoom: 'E1S1', stage: 'outbound',
        startedAt: clock.now, elapsedTicks: 0, visitedRooms: [], visitedShards: ['shard3'] };
    const task = { key: 'shard3:nearest', sourceShard: 'shard3', sourceRoom: 'E1S1', targetShard: 'shard1', targetRoom: 'E1S1',
        route: [], claim: true, builders: 1, haulers: 0, targetLevel: 4, energyAmount: 0, homeEnergyReserve: 10000 };
    const data = { missionId: task.key, task, unitKind: 'scout', originShard: 'shard3', hopIndex: 1, phase: 'outbound', exploration: progress,
        route: [{ shard: 'shard3', roomName: 'E0S0', x: 10, y: 10, destinationShard: 'shard2', destinationRoom: 'E14S14' }] };
    const command = { reports: { [task.key]: { type: 'command', state: 'active', explorerRevision: progress.revision, explorerStatus: 'exploring' } } };
    const game = { time: 7, shard: { name: 'shard2' }, rooms: {}, cpu: { bucket: 10000, tickLimit: 100, getUsed: () => 0 }, map: {
        getRoomStatus: name => ({ status: closed.has(name) ? 'closed' : 'normal' }),
        findRoute(from, to, options) {
            calls.push({ from, to });
            if (noPaths.has(`${from}>${to}`)) return -2;
            if (from === to) return [];
            const [sx, sy] = coordinates(from), [tx, ty] = coordinates(to);
            const pending = [[sx, sy, []]], visited = new Set([from]);
            for (let i = 0; i < pending.length; i++) {
                const [x, y, route] = pending[i];
                for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const nx = x + dx, ny = y + dy, name = roomName(nx, ny);
                    if (nx < 0 || nx > 35 || ny < 0 || ny > 35 || visited.has(name) || options.routeCallback(name) === Infinity) continue;
                    const next = [...route, { exit: 1, room: name }];
                    if (name === to) return next;
                    visited.add(name); pending.push([nx, ny, next]);
                }
            }
            return -2;
        },
    } };
    class Position { constructor(x, y, roomName) { Object.assign(this, { x, y, roomName }); } }
    const creep = { name: 'nearest-explorer', memory: { role: 'sScout', data }, spawning: false, fatigue: 0,
        hits: 100, hitsMax: 100, ticksToLive: 1400, moveTo: target => { moves.push(target.roomName); return 0; } };
    const loader = createSourceLoader({ globals: { Game: game, Memory: {}, Date: class extends Date { static now() { return clock.now; } },
        RoomPosition: Position, FIND_HOSTILE_CREEPS: 'hostile-creeps', FIND_HOSTILE_STRUCTURES: 'hostile-structures', ATTACK: 'attack',
        RANGED_ATTACK: 'ranged_attack', STRUCTURE_TOWER: 'tower', RESOURCE_ENERGY: 'energy', TOWER_ENERGY_COST: 10,
        OK: 0, ERR_NO_PATH: -2, ERR_TIRED: -11 }, modules: {
        'settings/settings': {
            findPathAvoidRooms: avoidedByShard,
            getFindPathAvoidRooms: (shardName = game.shard.name) => avoidedByShard[shardName] || [],
            getFindPathAvoidRoomsSignature: () => JSON.stringify(Object.keys(avoidedByShard).sort()
                .map(shardName => [shardName, [...avoidedByShard[shardName]].sort()])),
        },
        './transport': { getLocalShardState: () => local, readRemoteShardState: () => command, markShardStateDirty() {},
            flushInterShardMemory: () => true, getShardTransportError: () => undefined, cancelCreepTransfers() {} },
        './portalIntel': { runPortalDiscovery() {}, getKnownPortals: () => [], forgetPortal() {} },
        './travel': { travelPortalRoute() { throw new Error('An unknown next portal must be sought on foot'); } },
    } });
    const policy = loader.load('settings/interShard').interShardPolicy;
    policy.portalExploration.maximumLocalRouteChecks = 32;
    const rooms = loader.load('shard/explorationRoutes');
    const role = loader.load('shard/exploration').createPortalExplorerRole(data);
    function place(name, advance = false) {
        if (advance) { game.time++; clock.now += 1000; creep.ticksToLive--; }
        creep.pos = new Position(25, 25, name); creep.room = { name, find: () => [] };
        game.rooms = { [name]: creep.room };
    }
    function run() { assert.equal(role.prepare(creep), true); role.source(creep); }
    place('E14S14');
    return { game, clock, data, progress, local, calls, moves, noPaths, avoided, avoidedByShard, closed, rooms, place, run };
}

test('real explorer chooses the nearest reachable unvisited crossroad from its current room after each arrival', () => {
    const w = world();
    w.run();
    assert.deepEqual(w.moves, ['E10S10']);
    assert.equal(w.progress.searchOrigin.roomName, 'E14S14');
    w.place('E10S10', true);
    const visited = ['E14S14', 'E10S10'];
    const oldOrder = w.rooms.getExplorationRooms('E14S14', visited, [], { searchOriginRoom: 'E14S14' });
    assert.equal(oldOrder[0], 'E10S20', 'the original starting room would favor the other side of the wall');
    const routeOptions = { routeCallback: name => w.closed.has(name) || w.avoided.includes(name) ? Infinity : 1 };
    assert.equal(w.game.map.findRoute('E10S10', 'E10S20', routeOptions).length, 16);
    assert.equal(w.game.map.findRoute('E10S10', 'E20S10', routeOptions).length, 10);
    w.calls.length = 0;
    w.run();
    assert.deepEqual(w.moves, ['E10S10', 'E20S10']);
    assert.equal(w.progress.searchOrigin.roomName, 'E14S14', 'arrival changes ranking without moving the bounded search origin');
    assert.equal(w.progress.searchTarget, 'E20S10');
    assert.ok(w.calls.length > 0);
    assert.ok(w.calls.every(call => call.from === 'E10S10'), 'native reachability queries use the current room');
    assert.ok(w.calls.every(call => !w.avoided.includes(call.to)), 'configured avoid rooms cannot become frontiers');
    assert.deepEqual(w.local.scoutProofs, {}, 'walking exploration still cannot certify a worker route');
    assert.equal(w.data.done, undefined);
});

test('real explorer skips the nearest crossroad when the native route from the current room is unavailable', () => {
    const w = world();
    w.run();
    w.place('E10S10', true);
    w.noPaths.add('E10S10>E20S10');
    w.run();
    assert.deepEqual(w.moves, ['E10S10', 'E10S20']);
    assert.ok(w.calls.some(call => call.from === 'E10S10' && call.to === 'E20S10'));
    assert.equal(w.data.done, undefined);
});

test('a shard3 blacklist does not hide the same nearest crossroad after the real explorer lands on shard2', () => {
    const w = world();
    w.avoidedByShard.shard3.push('E10S10');
    w.run();
    assert.deepEqual(w.moves, ['E10S10']);
    assert.equal(w.game.shard.name, 'shard2');
    assert.ok(w.calls.some(call => call.to === 'E10S10'), 'the current shard still pays for a reachable local route');
    assert.equal(w.data.done, undefined);
});

test('the real explorer obeys its current shard blacklist while another shard permits the same crossroad', () => {
    const w = world();
    w.avoidedByShard.shard2.push('E10S10');
    w.run();
    assert.deepEqual(w.moves, ['E10S20']);
    assert.equal(w.avoidedByShard.shard3.includes('E10S10'), false);
    assert.equal(w.calls.some(call => call.to === 'E10S10'), false);
});
