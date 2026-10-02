const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const copy = value => JSON.parse(JSON.stringify(value));

function coords(name) {
    const [, horizontal, x, vertical, y] = /^([WE])(\d+)([NS])(\d+)$/.exec(name);
    return [horizontal === 'W' ? -Number(x) - 1 : Number(x), vertical === 'N' ? -Number(y) - 1 : Number(y)];
}
function roomName(x, y) { return `${x < 0 ? 'W' + (-x - 1) : 'E' + x}${y < 0 ? 'N' + (-y - 1) : 'S' + y}`; }

function world(overrides = {}) {
    let id = 0;
    const clock = { now: 1000000 };
    const calls = [];
    const statuses = new Map();
    const noPaths = new Set();
    const routeOverrides = new Map();
    const avoided = [];
    const cpu = { used: 0, nativeCost: 0, tickLimit: 100, bucket: 10000, getUsed() { return this.used; } };
    const game = { time: 1, shard: { name: 'shard3' }, cpu, map: {
        getRoomStatus: room => ({ status: statuses.get(room) || 'normal' }),
        findRoute(from, to, options) {
            calls.push({ from, to, options }); cpu.used += cpu.nativeCost;
            if (noPaths.has(`${from}>${to}`)) return -2;
            if (routeOverrides.has(`${from}>${to}`)) return routeOverrides.get(`${from}>${to}`);
            if (from === to) return [];
            const [sx, sy] = coords(from); const [tx, ty] = coords(to);
            let x = sx; let y = sy;
            const direct = [];
            while (x !== tx) { x += Math.sign(tx - x); direct.push({ exit: 1, room: roomName(x, y) }); }
            while (y !== ty) { y += Math.sign(ty - y); direct.push({ exit: 1, room: roomName(x, y) }); }
            if (direct.every(step => options.routeCallback(step.room) !== Infinity)) return direct;
            const pending = [[sx, sy, []]], visited = new Set([from]);
            for (let cursor = 0; cursor < pending.length; cursor++) {
                const [cx, cy, route] = pending[cursor];
                for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const nx = cx + dx; const ny = cy + dy; const name = roomName(nx, ny);
                    if (Math.abs(nx) > 35 || Math.abs(ny) > 35 || visited.has(name) || options.routeCallback(name) === Infinity) continue;
                    const next = [...route, { exit: 1, room: name }];
                    if (name === to) return next;
                    visited.add(name); pending.push([nx, ny, next]);
                }
            }
            return -2;
        },
    } };
    const loader = createSourceLoader({ globals: { Game: game, Date: class extends Date { static now() { return clock.now; } } },
        modules: { 'settings/settings': { findPathAvoidRooms: avoided } } });
    const policy = loader.load('settings/interShard').interShardPolicy;
    Object.assign(policy.portalExploration, overrides);
    const api = loader.load('shard/explorationRoutes');
    const portal = (shard, roomName, destinationShard, destinationRoom, extra = {}) => ({
        id: `portal-${++id}`, shard, roomName, x: 10 + id, y: 10, destinationShard, destinationRoom, observedAt: clock.now, ...extra,
    });
    return { ...api, policy, game, clock, cpu, calls, statuses, noPaths, routeOverrides, avoided, portal };
}

test('exploration helpers import without Game and shard heuristics never invent a portal hop', () => {
    const loader = createSourceLoader();
    const api = loader.load('shard/explorationRoutes');
    assert.equal(loader.globals.Game, undefined);
    assert.deepEqual(copy(api.getExplorationItinerary('shard3', 'shard1', [])), ['shard3', 'shard2', 'shard1']);
    assert.deepEqual(copy(api.planExplorationEntry('shard3', 'E0S0', 'shard1', 'E0S0', [])), []);
});

test('observed direct shard connections override the configured main chain', () => {
    const w = world();
    const direct = w.portal('shard3', 'E1S0', 'shard1', 'E0S0');
    assert.deepEqual(copy(w.getExplorationItinerary('shard3', 'shard1', [direct])), ['shard3', 'shard1']);
    assert.equal(w.planExplorationEntry('shard3', 'E0S0', 'shard1', 'E0S0', [direct])[0].destinationShard, 'shard1');
});

test('an actual 3-to-2 prefix can be used while the 2-to-1 crossing is still unknown', () => {
    const w = world();
    const first = w.portal('shard3', 'E1S0', 'shard2', 'W0N0');
    const entry = w.planExplorationEntry('shard3', 'E0S0', 'shard1', 'W3N3', [first]);
    assert.deepEqual(copy(entry), [{ shard: first.shard, roomName: first.roomName, x: first.x, y: first.y,
        destinationShard: first.destinationShard, destinationRoom: first.destinationRoom }]);
    assert.equal(entry.length, 1);
    assert.ok(w.calls.every(call => call.from === 'E0S0' && call.to === 'E1S0'));
});

test('prefix entries minimize actual known travel without inventing a walk on the frontier', () => {
    const w = world();
    const far = w.portal('shard3', 'E8S0', 'shard2', 'E0S0');
    const near = w.portal('shard3', 'E1S0', 'shard2', 'E50S50');
    const entry = w.planExplorationEntry('shard3', 'E0S0', 'shard1', 'E0S0', [far, near]);
    assert.equal(entry[0].x, near.x, 'frontier landing coordinates must not create an unrelated final-walk penalty');
});

test('complete known routes still commit only one local crossing before planning the next shard', () => {
    const w = world();
    const portals = [w.portal('shard3', 'E1S0', 'shard2', 'W0N0'), w.portal('shard2', 'W1N1', 'shard1', 'E0S0')];
    const entry = w.planExplorationEntry('shard3', 'E0S0', 'shard1', 'E0S0', portals);
    assert.deepEqual(Array.from(entry, hop => hop.destinationShard), ['shard2']);
    assert.ok(w.calls.every(call => call.from === 'E0S0' && call.to === 'E1S0'));
});

test('a complete known route cannot pull the explorer toward a farther first entrance with a cheaper onward journey', () => {
    const w = world();
    const near = w.portal('shard3', 'E1S0', 'shard2', 'E50S50');
    const far = w.portal('shard3', 'E8S0', 'shard2', 'E1S0');
    const onward = w.portal('shard2', 'E2S0', 'shard1', 'E0S0');
    const entry = w.planExplorationEntry('shard3', 'E0S0', 'shard1', 'E0S0', [far, onward, near]);
    assert.equal(entry.length, 1);
    assert.equal(entry[0].roomName, 'E1S0', 'the nearest real shard3-to-shard2 entrance wins independently of the shard2 journey');
    assert.equal(entry[0].destinationRoom, 'E50S50');
    assert.deepEqual(w.calls.map(({ from, to }) => [from, to]), [['E0S0', 'E1S0']]);
});

test('a next-shard entrance is ranked without the landing-room to final-room distance', () => {
    const w = world();
    w.game.shard.name = 'shard2';
    const near = w.portal('shard2', 'E1S0', 'shard1', 'E50S50');
    const far = w.portal('shard2', 'E8S0', 'shard1', 'E0S0');
    const entrance = w.selectExplorationPortal('shard2', 'E0S0', 'shard1', 'E0S0', [far, near], ['shard3']);
    assert.equal(entrance.roomName, 'E1S0');
    assert.equal(entrance.destinationRoom, 'E50S50');
    assert.deepEqual(w.calls.map(({ from, to }) => [from, to]), [['E0S0', 'E1S0']]);
});

test('portal candidates query the closest local entrance first even with a single native-check allowance', () => {
    const w = world({ maximumLocalRouteChecks: 1 });
    const far = w.portal('shard3', 'E8S0', 'shard2', 'E0S0');
    const near = w.portal('shard3', 'E1S0', 'shard2', 'E50S50');
    const entrance = w.selectExplorationPortal('shard3', 'E0S0', 'shard1', 'E0S0', [far, near]);
    assert.equal(entrance.roomName, 'E1S0');
    assert.equal(w.calls.length, 1);
    assert.equal(w.isExplorationPlanningDeferred(), false);
});

test('entrance selection skips the closest unreachable door and keeps the same next shard', () => {
    const w = world();
    const near = w.portal('shard3', 'E1S0', 'shard2', 'E50S50');
    const farther = w.portal('shard3', 'E2S0', 'shard2', 'E0S0');
    w.noPaths.add('E0S0>E1S0');
    assert.equal(w.planExplorationEntry('shard3', 'E0S0', 'shard1', 'E0S0', [farther, near])[0].roomName, 'E2S0');
    assert.deepEqual(w.calls.map(call => call.to), ['E1S0', 'E2S0']);
});

test('entrance selection minimizes actual local route length and breaks equal local lengths by current geometry', () => {
    const w = world();
    const geometricNear = w.portal('shard3', 'E10S10', 'shard2', 'E0S0');
    const localNear = w.portal('shard3', 'E0S10', 'shard2', 'E50S50');
    w.routeOverrides.set('E9S9>E10S10', crossroadDetour(15));
    assert.equal(w.selectExplorationPortal('shard3', 'E9S9', 'shard1', 'E0S0', [geometricNear, localNear]).roomName, 'E0S10');
    w.game.time++;
    w.routeOverrides.set('E9S9>E10S10', crossroadDetour(14));
    assert.equal(w.selectExplorationPortal('shard3', 'E9S9', 'shard1', 'E0S0', [localNear, geometricNear]).roomName, 'E10S10');
});

test('portal selection shares local walking cache with crossroad scanning and invalidates changed avoidance', () => {
    const w = world();
    const near = w.portal('shard3', 'E10S10', 'shard2', 'E0S0');
    const far = w.portal('shard3', 'E20S10', 'shard2', 'E0S0');
    assert.equal(w.getExplorationRooms('E9S9', [], [], { nearestOnly: true })[0], 'E10S10');
    assert.equal(w.calls.length, 1);
    assert.equal(w.selectExplorationPortal('shard3', 'E9S9', 'shard1', 'E0S0', [far, near]).roomName, 'E10S10');
    assert.equal(w.calls.length, 1, 'a real entrance in the previously checked crossroad reuses its local distance');
    w.avoided.push('E10S10');
    assert.equal(w.selectExplorationPortal('shard3', 'E9S9', 'shard1', 'E0S0', [far, near]).roomName, 'E20S10');
    assert.equal(w.calls.length, 2);
    assert.equal(w.calls[1].options.routeCallback('E10S10'), Infinity);
});

test('portal selection respects closed entrance rooms and configured avoid rooms', () => {
    const w = world();
    const closed = w.portal('shard3', 'E1S0', 'shard2', 'E0S0');
    const avoided = w.portal('shard3', 'E2S0', 'shard2', 'E0S0');
    const reachable = w.portal('shard3', 'E3S0', 'shard2', 'E0S0');
    w.statuses.set('E1S0', 'closed');
    w.avoided.push('E2S0');
    assert.equal(w.planExplorationEntry('shard3', 'E0S0', 'shard1', 'E0S0', [closed, avoided, reachable])[0].roomName, 'E3S0');
    assert.deepEqual(w.calls.map(call => call.to), ['E3S0']);
});

test('record filters reject expired, future, stale, missing-endpoint and invalid-coordinate portals', async t => {
    const cases = {
        expired: (w, p) => { p.expiresAt = w.clock.now; },
        future: (w, p) => { p.observedAt = w.clock.now + 1; },
        stale: (w, p) => { w.clock.now += w.policy.portalDiscovery.intelMaxAge + 1; },
        'missing destination': (w, p) => { delete p.destinationRoom; },
        'bad room': (w, p) => { p.roomName = 'E01S0'; },
        'bad coordinate': (w, p) => { p.x = 50; },
        'same shard': (w, p) => { p.destinationShard = p.shard; },
    };
    for (const [name, mutate] of Object.entries(cases)) await t.test(name, () => {
        const w = world(); const portal = w.portal('shard3', 'E0S0', 'shard1', 'E0S0');
        mutate(w, portal);
        assert.deepEqual(copy(w.planExplorationEntry('shard3', 'E0S0', 'shard1', 'E0S0', [portal])), []);
        assert.equal(w.selectExplorationPortal('shard3', 'E0S0', 'shard1', 'E0S0', [portal]), undefined);
        assert.equal(w.calls.length, 0);
    });
});

test('a fresher record replaces conflicting destinations at the same physical portal entrance', () => {
    const w = world();
    const old = w.portal('shard3', 'E1S0', 'shard1', 'E0S0', { observedAt: w.clock.now - 1 });
    const newer = { ...old, id: 'new', destinationShard: 'shard2', observedAt: w.clock.now };
    const result = w.selectExplorationPortal('shard3', 'E0S0', 'shard1', 'E0S0', [old, newer]);
    assert.equal(result.destinationShard, 'shard2');
});

test('explorers choose real direct goals before intermediate doors and reject previous-shard loops', () => {
    const w = world();
    const next = w.portal('shard3', 'E0S0', 'shard2', 'W0N0');
    const direct = w.portal('shard3', 'E2S0', 'shard1', 'E0S0');
    assert.equal(w.selectExplorationPortal('shard3', 'E0S0', 'shard1', 'E0S0', [next, direct]).destinationShard, 'shard1');
    w.game.shard.name = 'shard2';
    const back = w.portal('shard2', 'E0S0', 'shard3', 'E0S0');
    const onward = w.portal('shard2', 'E1S0', 'shard1', 'E0S0');
    assert.equal(w.selectExplorationPortal('shard2', 'E0S0', 'shard1', 'E0S0', [back, onward], ['shard3', 'shard2']).destinationShard, 'shard1');
    assert.equal(w.selectExplorationPortal('shard2', 'E0S0', 'shard3', 'E0S0', [back], ['shard3']), undefined);
    assert.equal(w.selectExplorationPortal('shard2', 'E0S0', 'shard3', 'E0S0', [back], []).destinationShard, 'shard3');
});

test('selection never looks up another shard through the current Game.map', () => {
    const w = world();
    const portal = w.portal('shard2', 'E1S0', 'shard1', 'E0S0');
    assert.equal(w.selectExplorationPortal('shard2', 'E0S0', 'shard1', 'E0S0', [portal]), undefined);
    assert.equal(w.calls.length, 0);
});

test('a direct goal door with no local path falls back to the real configured intermediate crossing', () => {
    const w = world();
    const direct = w.portal('shard3', 'E1S0', 'shard1', 'E0S0');
    const next = w.portal('shard3', 'E2S0', 'shard2', 'E0S0');
    w.noPaths.add('E0S0>E1S0');
    const result = w.selectExplorationPortal('shard3', 'E0S0', 'shard1', 'E0S0', [direct, next]);
    assert.equal(result.destinationShard, 'shard2');
});

test('highway crossroads include both W0/E0 and N0/S0 sides with actual near-to-far ordering', () => {
    const w = world({ searchRadius: 2 });
    const rooms = w.getExplorationRooms('W0N0');
    assert.deepEqual(copy(rooms), ['W0N0', 'E0N0', 'W0S0', 'E0S0']);
    for (const room of rooms) {
        const match = /^([WE])(\d+)([NS])(\d+)$/.exec(room);
        assert.equal(Number(match[2]) % 10, 0); assert.equal(Number(match[4]) % 10, 0);
    }
    assert.equal(w.calls.length, 3);
});

test('room candidates skip visited, excluded, avoided, closed, novice and locally unreachable crossroads', () => {
    const w = world({ searchRadius: 20 });
    w.avoided.push('E0S10');
    w.statuses.set('E10S0', 'closed'); w.statuses.set('W0N0', 'novice');
    w.noPaths.add('E0S0>E10S10');
    const rooms = w.getExplorationRooms('E0S0', ['E0S0'], ['W0S0']);
    for (const room of ['E0S0', 'W0S0', 'E0S10', 'E10S0', 'W0N0', 'E10S10']) assert.equal(rooms.includes(room), false);
    for (const call of w.calls) {
        assert.equal(call.options.routeCallback('E0S10'), Infinity);
        assert.equal(call.options.routeCallback('E10S0'), Infinity);
        assert.equal(call.options.routeCallback('W0N0'), Infinity);
    }
});

test('crossroad priority and native route origins follow the scout while the arrival search area stays fixed', () => {
    const w = world({ searchRadius: 20 });
    const options = { searchOriginRoom: 'E0S0' };
    const first = w.getExplorationRooms('E19S9', ['E0S0'], [], options);
    assert.equal(first[0], 'E20S10', 'the closest crossroad is chosen from the scout current room, not the old arrival room');
    assert.ok(w.calls.every(call => call.from === 'E19S9'));
    w.game.time++;
    w.calls.length = 0;
    const next = w.getExplorationRooms('E20S10', ['E0S0', 'E20S10'], [], options);
    assert.equal(next[0], 'E10S10', 'after visiting a crossroad, the next target is recalculated from that crossroad');
    assert.ok(w.calls.every(call => call.from === 'E20S10'));
    assert.equal(next.includes('E30S10'), false, 'moving the scout must not expand the original search radius');
});

test('bounded native checks examine the currently closest crossroad before rooms closest to the arrival', () => {
    const w = world({ maximumLocalRouteChecks: 1, searchRadius: 20 });
    const rooms = w.getExplorationRooms('E19S9', ['E0S0'], [], { searchOriginRoom: 'E0S0' });
    assert.deepEqual(copy(rooms), ['E20S10']);
    assert.deepEqual(w.calls.map(({ from, to }) => [from, to]), [['E19S9', 'E20S10']]);
});

test('the original arrival bounds candidates even when the scout has moved outside that search area', () => {
    const w = world({ maximumLocalRouteChecks: 1, searchRadius: 20 });
    const rooms = w.getExplorationRooms('E39S9', [], [], { searchOriginRoom: 'E0S0' });
    assert.deepEqual(copy(rooms), ['E20S10']);
    assert.equal(w.calls[0].from, 'E39S9');
    assert.equal(rooms.includes('E40S10'), false);
});

test('an unreachable nearest crossroad is skipped in favor of the next reachable current-room candidate', () => {
    const w = world({ maximumLocalRouteChecks: 2, searchRadius: 20 });
    w.noPaths.add('E19S9>E20S10');
    const rooms = w.getExplorationRooms('E19S9', ['E0S0'], [], { searchOriginRoom: 'E0S0' });
    assert.deepEqual(copy(rooms), ['E10S10']);
    assert.deepEqual(w.calls.map(call => call.to), ['E20S10', 'E10S10']);
});

function crossroadDetour(highestY) {
    const rooms = [];
    for (let y = 10; y <= highestY; y++) rooms.push(`E9S${y}`);
    rooms.push(`E10S${highestY}`);
    for (let y = highestY - 1; y >= 10; y--) rooms.push(`E10S${y}`);
    return rooms.map(room => ({ exit: 1, room }));
}

test('native travel length outranks geometry and equal travel lengths prefer the geometrically closer crossroad', () => {
    const fartherByRoute = world();
    fartherByRoute.routeOverrides.set('E9S9>E10S10', crossroadDetour(15));
    assert.equal(fartherByRoute.getExplorationRooms('E9S9')[0], 'E0S10', 'a twelve-room detour loses to a ten-room reachable crossroad');
    assert.equal(fartherByRoute.calls[0].to, 'E10S10', 'native queries still start at the geometrically nearest candidate');
    const equalTravel = world();
    equalTravel.routeOverrides.set('E9S9>E10S10', crossroadDetour(14));
    assert.equal(equalTravel.getExplorationRooms('E9S9')[0], 'E10S10', 'equal ten-room routes prefer the two-room geometric distance');
});

test('CPU exhaustion while checking a closer route defers instead of selecting an already checked detour', () => {
    const w = world({ maximumPlanningCpu: 5 });
    w.cpu.nativeCost = 3;
    w.routeOverrides.set('E9S9>E10S10', crossroadDetour(15));
    assert.deepEqual(copy(w.getExplorationRooms('E9S9')), []);
    assert.equal(w.calls.length, 2);
    assert.equal(w.isExplorationPlanningDeferred(), true);
});

test('nearest-only scanning proves the current closest crossroad with one paid native query across ticks', () => {
    const w = world({ searchRadius: 20, maximumPlanningCpu: 5 });
    w.cpu.nativeCost = 0.5;
    for (let tick = 0; tick < 3; tick++) {
        w.game.time++;
        w.cpu.used = 0;
        const before = w.calls.length;
        const rooms = w.getExplorationRooms('E19S9', ['E0S0'], [], { searchOriginRoom: 'E0S0', nearestOnly: true });
        assert.deepEqual(copy(rooms), ['E20S10']);
        assert.equal(w.calls.length - before, 1, 'the next Manhattan lower bound cannot improve the first reachable result');
        assert.equal(w.isExplorationPlanningDeferred(), false);
        assert.equal(w.cpu.used, 0.5);
    }
});

test('nearest-only scanning continues past a detour until another candidate has the proven shortest path', () => {
    const w = world();
    w.cpu.nativeCost = 0.5;
    w.routeOverrides.set('E9S9>E10S10', crossroadDetour(15));
    const rooms = w.getExplorationRooms('E9S9', [], [], { nearestOnly: true });
    assert.equal(rooms[0], 'E0S10');
    assert.deepEqual(w.calls.map(call => call.to), ['E10S10', 'E0S10']);
    assert.equal(w.isExplorationPlanningDeferred(), false);
});

test('list callers keep a proven nearest target if their remaining candidate queries consume the CPU budget', () => {
    const w = world({ maximumPlanningCpu: 5 });
    w.cpu.nativeCost = 0.5;
    const rooms = w.getExplorationRooms('E9S9');
    assert.equal(rooms[0], 'E10S10');
    assert.equal(w.calls.length, 10);
    assert.equal(w.cpu.used, 5);
});

test('nearest-only scanning defers when even its first native query exceeds the CPU allowance', () => {
    const w = world();
    w.cpu.nativeCost = 6;
    assert.deepEqual(copy(w.getExplorationRooms('E9S9', [], [], { nearestOnly: true })), []);
    assert.equal(w.calls.length, 1);
    assert.equal(w.isExplorationPlanningDeferred(), true);
});

test('invalid explicit search origins are rejected without any native route query', () => {
    const w = world();
    assert.deepEqual(copy(w.getExplorationRooms('E9S9', [], [], { searchOriginRoom: 'E01S0' })), []);
    assert.deepEqual(copy(w.getExplorationRooms('E9S9', [], [], { searchOriginRoom: 'E9007199254740991S0' })), []);
    assert.equal(w.calls.length, 0);
});

test('native route checks and returned candidate counts are bounded independently', () => {
    const w = world({ maximumLocalRouteChecks: 2, maximumCandidates: 3 });
    const rooms = w.getExplorationRooms('E0S0');
    assert.equal(w.calls.length, 2);
    assert.ok(rooms.length <= 3);
    assert.ok(rooms.includes('E0S0'));
});

test('walking cache reuses only this tick and shard, and avoid-list changes invalidate it', () => {
    const w = world({ searchRadius: 2 });
    const first = w.getExplorationRooms('W0N0');
    const calls = w.calls.length;
    assert.deepEqual(copy(w.getExplorationRooms('W0N0')), copy(first));
    assert.equal(w.calls.length, calls);
    w.game.time++;
    w.getExplorationRooms('W0N0'); assert.equal(w.calls.length, calls * 2);
    w.game.shard.name = 'shard2';
    w.getExplorationRooms('W0N0'); assert.equal(w.calls.length, calls * 3);
    w.avoided.push('W0S0');
    assert.equal(w.getExplorationRooms('W0N0').includes('W0S0'), false);
    assert.ok(w.calls.length > calls * 3);
});

test('radius zero permits the current zero-coordinate crossroad without a native call', () => {
    const w = world({ searchRadius: 0 });
    assert.deepEqual(copy(w.getExplorationRooms('E0S0')), ['E0S0']);
    assert.deepEqual(copy(w.getExplorationRooms('W0N0')), ['W0N0']);
    assert.deepEqual(copy(w.getExplorationRooms('E1S1')), []);
    assert.equal(w.calls.length, 0);
});

test('multiple entry plans share the native-check allowance', () => {
    const w = world({ maximumLocalRouteChecks: 1 });
    const portals = [w.portal('shard3', 'E1S0', 'shard2', 'E0S0'), w.portal('shard3', 'E2S0', 'shard2', 'E1S0')];
    w.noPaths.add('E0S0>E1S0');
    assert.deepEqual(copy(w.planExplorationEntry('shard3', 'E0S0', 'shard1', 'E0S0', portals)), []);
    assert.equal(w.calls.length, 1);
    w.policy.portalExploration.maximumLocalRouteChecks = 2;
    const entry = w.planExplorationEntry('shard3', 'E0S0', 'shard1', 'E0S0', portals);
    assert.equal(entry[0].roomName, 'E2S0');
    assert.equal(w.calls.length, 2, 'the cached blocked entrance does not spend the new allowance');
});

test('exploration CPU budget and tick headroom stop additional native work', () => {
    const scanning = world(); scanning.cpu.nativeCost = 6;
    assert.deepEqual(copy(scanning.getExplorationRooms('E1S1')), []);
    assert.equal(scanning.calls.length, 1);
    const planning = world(); planning.cpu.nativeCost = 6;
    const portal = planning.portal('shard3', 'E1S0', 'shard2', 'E0S0');
    assert.deepEqual(copy(planning.planExplorationEntry('shard3', 'E0S0', 'shard1', 'E0S0', [portal])), []);
    assert.equal(planning.calls.length, 1);
    const headroom = world(); headroom.cpu.used = 95;
    assert.deepEqual(copy(headroom.getExplorationRooms('E0S0')), []);
    assert.deepEqual(copy(headroom.planExplorationEntry('shard3', 'E0S0', 'shard1', 'E0S0', [headroom.portal('shard3', 'E1S0', 'shard2', 'E0S0')])), []);
    assert.equal(headroom.calls.length, 0);
});

test('bad room inputs and bounded shard cycles do not hang exploration', () => {
    const w = world();
    assert.equal(w.getExplorationItinerary('', 'shard1', []), undefined);
    assert.equal(w.getExplorationItinerary('unknown', 'shard1', []), undefined);
    assert.deepEqual(copy(w.getExplorationRooms('E01S0')), []);
    assert.deepEqual(copy(w.getExplorationRooms('E9007199254740991S0')), []);
    const portals = [w.portal('A', 'E0S0', 'B', 'E0S0'), w.portal('B', 'E0S0', 'A', 'E0S0')];
    assert.equal(w.getExplorationItinerary('A', 'C', portals), undefined);
    assert.deepEqual(copy(w.planExplorationEntry('shard3', 'broken', 'shard1', 'E0S0', [])), []);
});

test('budget-deferred status covers native checks and expires with its tick or shard', () => {
    const w = world({ maximumLocalRouteChecks: 0 });
    assert.deepEqual(copy(w.getExplorationRooms('E1S1')), []);
    assert.equal(w.isExplorationPlanningDeferred(), true);
    assert.equal(w.calls.length, 0);
    w.game.time++;
    assert.equal(w.isExplorationPlanningDeferred(), false);
    w.getExplorationRooms('E1S1');
    assert.equal(w.isExplorationPlanningDeferred(), true);
    w.game.shard.name = 'shard2';
    assert.equal(w.isExplorationPlanningDeferred(), false);
});

test('ordinary missing portals or unreachable rooms are distinct from exhausted planning budgets', () => {
    const w = world({ searchRadius: 0 });
    assert.equal(w.selectExplorationPortal('shard3', 'E0S0', 'shard1', 'E0S0', []), undefined);
    assert.equal(w.isExplorationPlanningDeferred(), false);
    assert.deepEqual(copy(w.getExplorationRooms('E1S1')), []);
    assert.equal(w.isExplorationPlanningDeferred(), false);
    w.policy.portalExploration.searchRadius = 1;
    w.noPaths.add('E1S1>E0S0');
    assert.deepEqual(copy(w.getExplorationRooms('E1S1')), []);
    assert.equal(w.isExplorationPlanningDeferred(), false);
});

test('callers can spend one CPU allowance across portal selection and subsequent room scanning', () => {
    const w = world();
    w.cpu.nativeCost = 5;
    const portal = w.portal('shard3', 'E1S0', 'shard1', 'E0S0');
    const start = w.cpu.used;
    const options = () => ({ maximumPlanningCpu: Math.max(0, w.policy.portalExploration.maximumPlanningCpu - (w.cpu.used - start)) });
    assert.equal(w.selectExplorationPortal('shard3', 'E0S0', 'shard1', 'E0S0', [portal], [], options()), undefined);
    assert.equal(w.isExplorationPlanningDeferred(), true);
    assert.equal(w.calls.length, 1);
    assert.deepEqual(copy(w.getExplorationRooms('E1S1', [], [], options())), []);
    assert.equal(w.isExplorationPlanningDeferred(), true);
    assert.equal(w.calls.length, 1, 'scanning must not acquire a new five-CPU allowance');
    assert.equal(w.cpu.used - start, w.policy.portalExploration.maximumPlanningCpu);
});
