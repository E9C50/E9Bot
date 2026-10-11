const assert = require('node:assert/strict');
const test = require('node:test');
const { performance } = require('node:perf_hooks');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function coords(room) {
    const [, horizontal, x, vertical, y] = /^([WE])(\d+)([NS])(\d+)$/.exec(room);
    return [horizontal === 'W' ? -Number(x) - 1 : Number(x), vertical === 'N' ? -Number(y) - 1 : Number(y)];
}
function roomName(x, y) { return `${x < 0 ? `W${-x - 1}` : `E${x}`}${y < 0 ? `N${-y - 1}` : `S${y}`}`; }

function world(overrides = {}) {
    let now = 1000000;
    let id = 0;
    const calls = [];
    const statuses = new Map();
    const noPaths = new Set();
    const avoided = [], avoidByShard = { A: avoided };
    const policy = {
        portalDiscovery: { intelMaxAge: 86400000 },
        portalRouting: {
            maximumNodes: 640, maximumHops: 8, portalCost: 1, roomCost: 50,
            maximumLocalRouteChecks: 40, maximumPlanningCpu: 20, minimumCpuHeadroom: 20,
            ...overrides
        }
    };
    class ClockDate extends Date { static now() { return now; } }
    const game = {
        time: 1, shard: { name: 'A' },
        map: {
            getRoomStatus(room) { return { status: statuses.get(room) || 'normal', timestamp: null }; },
            findRoute(from, to, options) {
                calls.push({ from, to, options });
                if (noPaths.has(`${from}>${to}`)) return -2;
                const [startX, startY] = coords(from);
                const pending = [[startX, startY, []]];
                const seen = new Set([from]);
                for (let cursor = 0; cursor < pending.length; cursor++) {
                    const [x, y, route] = pending[cursor];
                    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                        const nx = x + dx;
                        const ny = y + dy;
                        if (Math.abs(nx) > 36 || Math.abs(ny) > 36) continue;
                        const name = roomName(nx, ny);
                        if (seen.has(name) || options.routeCallback(name, roomName(x, y)) === Infinity) continue;
                        seen.add(name);
                        const next = [...route, { exit: 1, room: name }];
                        if (name === to) return next;
                        pending.push([nx, ny, next]);
                    }
                }
                return -2;
            }
        }
    };
    const loader = createSourceLoader({
        globals: { Game: game, Date: ClockDate },
        modules: { 'settings/interShard': { interShardPolicy: policy }, 'settings/settings': { findPathAvoidRooms: avoidByShard,
            getFindPathAvoidRooms: (shard = game.shard.name) => avoidByShard[shard] || [],
            getFindPathAvoidRoomsSignature: () => JSON.stringify(Object.keys(avoidByShard).sort()
                .map(shard => [shard, [...new Set(avoidByShard[shard])].sort()])) } }
    });
    function portal(shard, room, destinationShard, destinationRoom, extra = {}) {
        return { id: `portal${id++}`, shard, roomName: room, x: 25, y: 25,
            destinationShard, destinationRoom, observedAt: now, ...extra };
    }
    return { ...loader.load('shard/routePlanner'), game, policy, calls, statuses, noPaths, avoided, avoidByShard, portal,
        setNow: value => { now = value; } };
}

test('route planner imports without Game access', () => {
    const loader = createSourceLoader();
    assert.equal(typeof loader.load('shard/routePlanner').planPortalRoute, 'function');
    assert.equal(loader.globals.Game, undefined);
});

test('the best portal includes the final walk from its landing room to the target', () => {
    const state = world();
    const near = state.portal('A', 'E1S0', 'B', 'E20S0');
    const far = state.portal('A', 'E4S0', 'B', 'E0S0');
    const result = state.planPortalRoute('A', 'E0S0', 'B', 'E0S0', [near, far]);
    assert.equal(result.route[0].roomName, far.roomName);
    assert.equal(result.cost, 201);
    assert.deepEqual(state.calls.map(call => [call.from, call.to]), [['E0S0', 'E4S0']]);
    assert(state.isPortalRouteKnown(result.route, [near, far]));
});

test('nearest-hop selection ignores the final landing walk when choosing the first entrance', () => {
    const state = world({ strategy: 'nearestHop' });
    const near = state.portal('A', 'E1S0', 'B', 'E20S0');
    const far = state.portal('A', 'E4S0', 'B', 'E0S0');
    const result = state.planPortalRoute('A', 'E0S0', 'B', 'E0S0', [far, near]);
    assert.equal(result.route[0].roomName, near.roomName);
    assert.equal(result.cost, 1051);
    assert.deepEqual(state.calls.map(call => [call.from, call.to]), [['E0S0', 'E1S0']]);
    assert.equal(state.planPortalRoute('A', 'E0S0', 'B', 'E0S0', [far, near], { strategy: 'totalCost' }).route[0].roomName, far.roomName);
});

test('shard3 to shard1 chooses the nearest shard2 entrance and then the nearest next door from its landing room', () => {
    const state = world({ strategy: 'nearestHop' }); state.game.shard.name = 'shard3';
    const near = state.portal('shard3', 'E1S0', 'shard2', 'E20S20');
    const far = state.portal('shard3', 'E8S0', 'shard2', 'E0S0');
    const nextNear = state.portal('shard2', 'E21S20', 'shard1', 'E30S30');
    const nextFar = state.portal('shard2', 'E0S0', 'shard1', 'E0S0');
    const portals = [far, nextFar, near, nextNear];
    const result = state.planPortalRoute('shard3', 'E0S0', 'shard1', 'E0S0', portals);
    assert.deepEqual(Array.from(result.route, hop => hop.roomName), ['E1S0', 'E21S20']);
    assert.equal(result.cost, 3102);
    assert.ok(state.calls.every(call => call.from === 'E0S0' && call.to === 'E1S0'));
    const total = state.planPortalRoute('shard3', 'E0S0', 'shard1', 'E0S0', portals, { strategy: 'totalCost' });
    assert.equal(total.route[0].roomName, 'E8S0');
    assert.ok(total.cost < result.cost, 'whole-journey cost must not override the requested nearest first door');
});

test('nearest-hop planning respects native reachability and retries a budget-deferred closer-door search', () => {
    const state = world({ strategy: 'nearestHop', maximumLocalRouteChecks: 1 });
    const near = state.portal('A', 'E1S0', 'B', 'E20S0');
    const far = state.portal('A', 'E3S0', 'B', 'E0S0');
    state.noPaths.add('E0S0>E1S0');
    assert.equal(state.planPortalRoute('A', 'E0S0', 'B', 'E0S0', [near, far]), undefined);
    assert.equal(state.calls.length, 1);
    state.policy.portalRouting.maximumLocalRouteChecks = 2;
    assert.equal(state.planPortalRoute('A', 'E0S0', 'B', 'E0S0', [near, far]).route[0].roomName, 'E3S0');
    assert.equal(state.calls.length, 2, 'same-tick retries reuse the known unreachable entrance');
});

test('unreachable direct doors fall back to a reachable nearest intermediate crossing', () => {
    const state = world({ strategy: 'nearestHop' }); state.game.shard.name = 'shard3';
    const direct = state.portal('shard3', 'E2S0', 'shard1', 'E0S0');
    const via = state.portal('shard3', 'E1S0', 'shard2', 'E1S0');
    const next = state.portal('shard2', 'E1S0', 'shard1', 'E0S0');
    state.noPaths.add('E0S0>E2S0');
    const result = state.planPortalRoute('shard3', 'E0S0', 'shard1', 'E0S0', [direct, via, next]);
    assert.deepEqual(Array.from(result.route, hop => hop.destinationShard), ['shard2', 'shard1']);
    assert.equal(result.route[0].roomName, 'E1S0');
    assert.equal(state.planPortalRoute('shard3', 'E0S0', 'shard1', 'E0S0', [direct, via, next], { maximumHops: 1 }), undefined);
});

test('nearest-hop remote planning never queries another shard through the local map', () => {
    const state = world({ strategy: 'nearestHop' }); state.game.shard.name = 'unrelated';
    state.game.map.findRoute = () => { throw new Error('remote native lookup'); };
    state.game.map.getRoomStatus = () => { throw new Error('remote status lookup'); };
    const near = state.portal('A', 'W0N0', 'B', 'E20S20');
    const far = state.portal('A', 'E10S10', 'B', 'E0S0');
    assert.equal(state.planPortalRoute('A', 'E0S0', 'B', 'E0S0', [far, near]).route[0].roomName, 'W0N0');
    assert.equal(state.calls.length, 0);
});

test('nearest-hop return skips an unreachable landing without ranking reachable doors by the final walk', () => {
    const state = world({ strategy: 'nearestHop' }); state.game.shard.name = 'shard3';
    const near = state.portal('shard1', 'E1S0', 'shard3', 'E20S0');
    const far = state.portal('shard1', 'E3S0', 'shard3', 'E0S0');
    state.noPaths.add('E20S0>E0S0');
    assert.equal(state.planPortalRoute('shard1', 'E0S0', 'shard3', 'E0S0', [near, far]).route[0].roomName, 'E3S0');
    assert.ok(state.calls.every(call => call.from === 'E20S0' && call.to === 'E0S0'), 'only landing-to-home native routing is local');
    state.noPaths.clear(); state.game.time++;
    const result = state.planPortalRoute('shard1', 'E0S0', 'shard3', 'E0S0', [far, near]);
    assert.equal(result.route[0].roomName, 'E1S0');
    assert.equal(result.cost, 1051, 'a long reachable final walk must not favor the farther portal entrance');
});

test('known multi-hop portals beat a longer direct crossing and cycles remain bounded', () => {
    const state = world();
    const portals = [
        state.portal('A', 'E1S0', 'B', 'W0N0'),
        state.portal('B', 'W1N1', 'C', 'E0S0'),
        state.portal('B', 'W0N0', 'A', 'E0S0'),
        state.portal('A', 'E10S0', 'C', 'E1S1')
    ];
    const result = state.planPortalRoute('A', 'E0S0', 'C', 'E1S1', portals);
    assert.deepEqual(Array.from(result.route, hop => hop.destinationShard), ['B', 'C']);
    assert.equal(result.cost, 252);
    state.policy.portalRouting.maximumHops = 1;
    const direct = state.planPortalRoute('A', 'E0S0', 'C', 'E1S1', portals);
    assert.equal(direct.route.length, 1);
    assert.equal(direct.cost, 501);
    assert.equal(state.planPortalRoute('A', 'E0S0', 'C', 'E1S1', portals.slice(0, 3)), undefined);
});

test('negative W/N coordinates and E/W, N/S boundaries use cardinal room distances remotely', () => {
    const state = world();
    state.game.shard.name = 'unrelated';
    state.game.map.findRoute = () => { throw new Error('must not query a remote map'); };
    state.game.map.getRoomStatus = () => { throw new Error('must not query a remote map'); };
    const portal = state.portal('A', 'E0S0', 'B', 'W0N0');
    const result = state.planPortalRoute('A', 'W0N0', 'B', 'E0S0', [portal]);
    assert.equal(result.cost, 201, 'each W0/E0 or N0/S0 boundary is one room, not zero');
    const negative = state.portal('A', 'W0N0', 'B', 'W2N3');
    assert.equal(state.planPortalRoute('A', 'W2N3', 'B', 'W0N0', [negative]).cost, 501);
});

test('local routes avoid configured rooms and closed intermediate rooms, charging the actual detour', () => {
    const state = world();
    state.avoided.push('E1S0');
    state.statuses.set('E0S1', 'closed');
    const result = state.planPortalRoute('A', 'E0S0', 'B', 'E0S0', [state.portal('A', 'E2S0', 'B', 'E0S0')]);
    assert.equal(result.cost, 201);
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0].options.routeCallback('E1S0', 'E0S0'), Infinity);
    assert.equal(state.calls[0].options.routeCallback('E0S1', 'E0S0'), Infinity);
    assert.equal(state.calls[0].options.routeCallback('E0N0', 'E0S0'), 1);
});

test('unreachable local entrances are removed and the next candidate is tried within the check budget', () => {
    const state = world({ maximumLocalRouteChecks: 1 });
    const portals = [state.portal('A', 'E1S0', 'B', 'E0S0'), state.portal('A', 'E2S0', 'B', 'E0S0')];
    state.noPaths.add('E0S0>E1S0');
    assert.equal(state.planPortalRoute('A', 'E0S0', 'B', 'E0S0', portals), undefined);
    assert.equal(state.calls.length, 1);
    state.policy.portalRouting.maximumLocalRouteChecks = 2;
    const result = state.planPortalRoute('A', 'E0S0', 'B', 'E0S0', portals);
    assert.equal(result.route[0].roomName, 'E2S0');
    assert.equal(state.calls.length, 2, 'same-tick retries reuse the already rejected entrance');
    assert.equal(state.planPortalRoute('A', 'E0S0', 'B', 'E0S0', portals).cost, result.cost);
    assert.equal(state.calls.length, 2, 'successful walking segments are cached during this tick');
    state.game.time++;
    state.noPaths.clear();
    assert.equal(state.planPortalRoute('A', 'E0S0', 'B', 'E0S0', portals).route[0].roomName, 'E1S0');
    assert.equal(state.calls.length, 3, 'next-tick routes must observe newly reachable exits');
});

test('walking after an arrival on the current shard is validated before accepting the route', () => {
    const state = world();
    const portals = [state.portal('B', 'E0S0', 'A', 'E0S0'), state.portal('B', 'E0S0', 'A', 'E2S1')];
    state.noPaths.add('E0S0>E2S0');
    const result = state.planPortalRoute('B', 'E0S0', 'A', 'E2S0', portals);
    assert.equal(result.route[0].destinationRoom, 'E2S1');
    assert.equal(result.cost, 51);
    assert.deepEqual(state.calls.map(call => [call.from, call.to]), [['E2S1', 'E2S0']]);
    const onlyBlocked = state.planPortalRoute('B', 'E0S0', 'A', 'E2S0', portals.slice(0, 1));
    assert.equal(onlyBlocked, undefined);
});

test('closed, novice and respawn portal rooms are refused conservatively on this shard', () => {
    for (const status of ['closed', 'novice', 'respawn']) {
        const state = world();
        state.statuses.set('E1S0', status);
        assert.equal(state.planPortalRoute('A', 'E0S0', 'B', 'E0S0', [state.portal('A', 'E1S0', 'B', 'E0S0')]), undefined);
        assert.equal(state.calls.length, 0);
    }
});

test('expired, old, future, malformed and destination-unknown records cannot create or recognize a route', () => {
    const state = world();
    const valid = state.portal('A', 'E0S0', 'B', 'E0S0');
    const hop = { shard: 'A', roomName: 'E0S0', x: 25, y: 25, destinationShard: 'B', destinationRoom: 'E0S0' };
    for (const invalid of [
        { ...valid, expiresAt: 1000000 }, { ...valid, observedAt: 1000001 },
        { ...valid, observedAt: -1 }, { ...valid, destinationRoom: undefined },
        { ...valid, x: 50 }, { ...valid, roomName: 'W00N0' }, null
    ]) {
        assert.equal(state.planPortalRoute('A', 'E0S0', 'B', 'E0S0', [invalid]), undefined);
        assert.equal(state.isPortalRouteKnown([hop], [invalid]), false);
    }
    state.setNow(1000000 + state.policy.portalDiscovery.intelMaxAge + 1);
    assert.equal(state.isPortalRouteKnown([hop], [valid]), false);
    assert.equal(state.planPortalRoute('A', 'E0S0', 'B', 'E0S0', [valid]), undefined);
});

test('route recognition uses all exact endpoints and rejects disconnected hop sequences', () => {
    const state = world();
    const records = [state.portal('A', 'E0S0', 'B', 'E0S0'), state.portal('B', 'E1S0', 'C', 'E0S0')];
    const route = state.planPortalRoute('A', 'E0S0', 'C', 'E0S0', records).route;
    assert(state.isPortalRouteKnown(route, records.map(record => ({ ...record, id: 'new-object-id' }))));
    for (const mutation of [{ x: 24 }, { destinationShard: 'D' }, { destinationRoom: 'E2S0' }, { shard: 'D' }]) {
        assert.equal(state.isPortalRouteKnown([{ ...route[0], ...mutation }, route[1]], records), false);
    }
    assert.equal(state.isPortalRouteKnown([route[1], route[0]], records), false);
    assert(state.isPortalRouteKnown([], records));
});

test('reachable shard pruning removes dead-end records before applying the graph bound', () => {
    const state = world({ maximumNodes: 2 });
    const records = [state.portal('A', 'E0S0', 'B', 'E0S0')];
    for (let index = 0; index < 5; index++) records.push(state.portal('A', `E${index}S0`, 'deadEnd', `E${index}S0`));
    assert.equal(state.planPortalRoute('A', 'E0S0', 'B', 'E0S0', records).route.length, 1);
    records.push(state.portal('A', 'E1S0', 'B', 'E1S0'), state.portal('A', 'E2S0', 'B', 'E2S0'));
    assert.equal(state.planPortalRoute('A', 'E0S0', 'B', 'E0S0', records), undefined);
    assert.equal(state.planPortalRoute('A', 'bad-room', 'B', 'E0S0', records), undefined);
    assert.equal(state.planPortalRoute('A', 'E0S0', 'missing', 'E0S0', records), undefined);
});

test('CPU headroom and planning CPU budgets stop before more native searches', () => {
    const state = world();
    const records = [state.portal('A', 'E1S0', 'B', 'E0S0')];
    state.game.cpu = { tickLimit: 10, getUsed: () => 0 };
    assert.equal(state.planPortalRoute('A', 'E0S0', 'B', 'E0S0', records), undefined);
    assert.equal(state.calls.length, 0);
    let used = 0;
    state.game.cpu = { tickLimit: 500, getUsed: () => used };
    const nativeRoute = state.game.map.findRoute;
    state.game.map.findRoute = (...args) => { const result = nativeRoute(...args); used += 25; return result; };
    assert.equal(state.planPortalRoute('A', 'E0S0', 'B', 'E0S0', records), undefined);
    assert.equal(state.calls.length, 1, 'a native call cannot be interrupted, but no further work is accepted');
});

test('the pure graph search checks its CPU budget while processing heap nodes', () => {
    const state = world();
    state.game.shard.name = 'unrelated';
    const records = Array.from({ length: 130 }, (_, index) => state.portal('A', 'E0S0', 'B', `E0S${index}`));
    records.push(state.portal('B', 'E1000S0', 'C', 'E0S0'));
    let reads = 0;
    state.game.cpu = { tickLimit: 500, getUsed: () => ++reads < 7 ? 0 : 25 };
    assert.equal(state.planPortalRoute('A', 'E0S0', 'C', 'E0S0', records), undefined);
    assert.equal(reads, 7);
    assert.equal(state.calls.length, 0);
});

test('a bounded 640-record four-shard directory completes using only known crossings', context => {
    const state = world();
    state.game.shard.name = 'unrelated';
    const shards = ['A', 'B', 'C', 'D'];
    const records = [];
    for (let shard = 0; shard < shards.length; shard++) {
        for (let index = 0; index < 160; index++) {
            const x = (index % 16) * 10;
            const y = Math.floor(index / 16) * 10;
            records.push(state.portal(shards[shard], `E${x}S${y}`, shards[(shard + 1) % shards.length], `E${x + shard}S${y + shard}`));
        }
    }
    const started = performance.now();
    const result = state.planPortalRoute('A', 'E0S0', 'D', 'E500S500', records);
    const elapsed = performance.now() - started;
    assert(result);
    assert(result.route.length <= state.policy.portalRouting.maximumHops);
    assert(state.isPortalRouteKnown(result.route, records));
    assert.equal(result.route[result.route.length - 1].destinationShard, 'D');
    assert.equal(state.calls.length, 0);
    context.diagnostic(`640 known portals: ${elapsed.toFixed(2)} ms local wall-clock, ${result.route.length} hops; no Screeps CPU claim`);
});


test('the same room name is independent on each shard for both portal selection strategies', () => {
    for (const strategy of ['nearestHop', 'totalCost']) {
        const w = world({ strategy }); w.game.shard.name = 'shard1';
        w.avoidByShard.shard3 = ['E39N4'];
        const door = w.portal('shard1', 'E39N4', 'shard2', 'E0S0');
        assert.ok(w.planPortalRoute('shard1', 'E39N4', 'shard2', 'E0S0', [door]),
            'shard3 E39N4 does not ban the source or entrance on shard1');
        w.avoidByShard.shard1 = ['E39N4'];
        assert.equal(w.planPortalRoute('shard1', 'E39N4', 'shard2', 'E0S0', [door]), undefined);
    }
});

test('remote portal landings and entrances honor their own shard list without remote map queries', () => {
    for (const strategy of ['nearestHop', 'totalCost']) {
        const w = world({ strategy }); w.game.shard.name = 'unrelated';
        w.game.map.findRoute = () => { throw new Error('remote route query'); };
        w.game.map.getRoomStatus = () => { throw new Error('remote status query'); };
        const blocked = w.portal('A', 'E0S0', 'B', 'E2S0');
        const safe = w.portal('A', 'E1S0', 'B', 'E3S0');
        w.avoidByShard.B = ['E2S0'];
        const result = w.planPortalRoute('A', 'E0S0', 'B', 'E0S0', [blocked, safe]);
        assert.equal(result.route[0].destinationRoom, 'E3S0');
        assert.equal(w.isPortalRouteKnown([blocked], [blocked]), false);
        const first = w.portal('A', 'E0S0', 'B', 'E1S0');
        const second = w.portal('B', 'E2S0', 'C', 'E0S0');
        assert.equal(w.planPortalRoute('A', 'E0S0', 'C', 'E0S0', [first, second]), undefined,
            'a forbidden remote entrance cannot connect the shard graph');
        assert.equal(w.calls.length, 0);
    }
});

test('remote mission source and final target are checked even when neither is a portal endpoint', () => {
    for (const blocked of ['source', 'target']) {
        const w = world(); w.game.shard.name = 'unrelated';
        w.game.map.findRoute = w.game.map.getRoomStatus = () => { throw new Error('remote map query'); };
        const door = w.portal('A', 'E1S0', 'B', 'E2S0');
        assert.ok(w.planPortalRoute('A', 'E0S0', 'B', 'E3S0', [door]));
        w.avoidByShard[blocked === 'source' ? 'A' : 'B'] = [blocked === 'source' ? 'E0S0' : 'E3S0'];
        assert.equal(w.planPortalRoute('A', 'E0S0', 'B', 'E3S0', [door]), undefined);
        assert.equal(w.calls.length, 0);
    }
});
