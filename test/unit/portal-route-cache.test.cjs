const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

const copy = value => JSON.parse(JSON.stringify(value));
const outward = [{ shard: 'shard0', roomName: 'W2N1', x: 10, y: 10, destinationShard: 'shard1', destinationRoom: 'W3N3' }];
const returning = [{ shard: 'shard1', roomName: 'W3N3', x: 20, y: 20, destinationShard: 'shard0', destinationRoom: 'W2N1' }];

function world() {
    const clock = { now: 1000000, cpu: 0, nativeCpu: 0 };
    const memory = {}, avoid = [], statuses = new Map(), calls = { native: [], statuses: [], plans: [] };
    const intel = { portals: [] }, avoidByShard = { shard0: avoid };
    let nativeResult;
    const game = { time: 10, shard: { name: 'shard0' }, cpu: { bucket: 10000, tickLimit: 100, getUsed: () => clock.cpu },
        map: {
            getRoomStatus(room) { calls.statuses.push(room); return { status: statuses.get(room) || 'normal' }; },
            findRoute(first, last, options) {
                calls.native.push({ first, last, options }); clock.cpu += clock.nativeCpu;
                return nativeResult === undefined ? [{ exit: 1, room: last }] :
                    typeof nativeResult === 'function' ? nativeResult(first, last, options) : nativeResult;
            },
        },
    };
    const loader = createSourceLoader({ globals: { Game: game, Memory: memory,
        Date: class extends Date { static now() { return clock.now; } }, ERR_NO_PATH: -2 }, modules: {
        'settings/settings': { findPathAvoidRooms: avoidByShard,
            getFindPathAvoidRooms: (shard = game.shard.name) => avoidByShard[shard] || [],
            getFindPathAvoidRoomsSignature: () => JSON.stringify(Object.keys(avoidByShard).sort()
                .map(shard => [shard, [...new Set(avoidByShard[shard])].sort()])) },
        './portalIntel': { getKnownPortals: () => intel.portals, getPortalIntelStatus: () => ({ observers: 1, portals: intel.portals.length }) },
        './transport': { cancelCreepTransfers() {}, getLocalShardState: () => ({ reports: {} }), readRemoteShardState: () => undefined },
    } });
    const policy = loader.load('settings/interShard').interShardPolicy;
    const planner = loader.load('shard/routePlanner'), realPlan = planner.planPortalRoute;
    planner.planPortalRoute = (...args) => { calls.plans.push(args); return realPlan(...args); };
    const cache = loader.load('shard/routeCache'), routing = loader.load('shard/routing'), verification = loader.load('shard/verification');
    const w = { clock, memory, avoid, avoidByShard, statuses, calls, intel, game, policy, cache, routing, verification,
        add(route) { intel.portals.push(...route.map((hop, index) => ({ ...hop, id: `${intel.portals.length}:${index}`, observedAt: clock.now }))); },
        native(result) { nativeResult = result; },
        advance(milliseconds = 1) { clock.now += milliseconds; game.time++; clock.cpu = 0; },
    };
    w.add([...outward, ...returning]);
    return w;
}

function store(w, targetRoom = 'W3N3', route = outward) {
    return w.cache.storePortalRoute('shard0', 'W1N1', 'shard1', targetRoom, { route, cost: 999 }, w.intel.portals);
}

function get(w, targetRoom = 'W3N3', options = {}) {
    return w.cache.getCachedPortalRoute('shard0', 'W1N1', 'shard1', targetRoom, w.intel.portals, options);
}

function mission(w, key, overrides = {}) {
    return { state: 'active', createdAt: w.clock.now, generation: 0, leases: {}, energyDelivered: 0,
        task: { id: key, key, sourceShard: 'shard0', sourceRoom: 'W1N1', targetShard: 'shard1', targetRoom: 'W3N3',
            route: [], autoRoute: true, autoReturn: false, verifyRoute: true, claim: false, builders: 0, haulers: 0,
            targetLevel: 4, energyAmount: 0, homeEnergyReserve: 10000, ...overrides } };
}

test('independent route directory clones candidates and recalculates the live local walking cost', () => {
    const w = world(), route = copy(outward);
    assert.equal(store(w, 'W3N3', route), true);
    route[0].x = 49;
    const result = get(w);
    assert.equal(result.cost, 51);
    assert.deepEqual(copy(result.route), outward);
    result.route[0].x = 48;
    assert.deepEqual(copy(get(w).route), outward);
    assert.equal(w.calls.native.length, 2);
    assert.equal(w.cache.getCachedPortalRoute('shard1', 'W3N3', 'shard0', 'W1N1', w.intel.portals), undefined);
    assert.equal(w.cache.getCachedPortalRoute('shard0', 'W9N9', 'shard1', 'W3N3', w.intel.portals), undefined);
});

test('observation refresh preserves topology but added, removed and redirected portals invalidate a candidate', () => {
    for (const change of ['add', 'remove', 'redirect']) {
        const w = world(); assert.equal(store(w), true);
        w.advance(); w.intel.portals.forEach(record => { record.observedAt = w.clock.now; });
        assert.ok(get(w));
        if (change === 'add') w.add([{ ...outward[0], x: 11 }]);
        if (change === 'remove') w.intel.portals.pop();
        if (change === 'redirect') w.intel.portals[0].destinationRoom = 'W4N4';
        assert.equal(get(w), undefined);
        assert.equal(Object.keys(w.memory.shardRouteCache.entries).length, 0);
    }
});

test('strategy, avoid-room policy and planning geometry limits belong to the route key', () => {
    for (const change of ['strategy', 'avoid', 'hops', 'nodes', 'roomCost', 'portalCost']) {
        const w = world(); assert.equal(store(w), true);
        if (change === 'strategy') w.policy.portalRouting.strategy = 'totalCost';
        if (change === 'avoid') w.avoid.push('W9N9');
        if (change === 'hops') w.policy.portalRouting.maximumHops--;
        if (change === 'nodes') w.policy.portalRouting.maximumNodes--;
        if (change === 'roomCost') w.policy.portalRouting.roomCost++;
        if (change === 'portalCost') w.policy.portalRouting.portalCost++;
        assert.equal(get(w), undefined);
        assert.equal(w.calls.native.length, 0);
    }
});

test('each cached hop must still be known and unexpired even when topology is unchanged', () => {
    for (const change of ['expired', 'stale', 'future']) {
        const w = world(); assert.equal(store(w), true);
        if (change === 'expired') w.intel.portals[0].expiresAt = w.clock.now;
        if (change === 'stale') w.intel.portals[0].observedAt = w.clock.now - w.policy.portalDiscovery.intelMaxAge - 1;
        if (change === 'future') w.intel.portals[0].observedAt = w.clock.now + 1;
        assert.equal(get(w), undefined);
        assert.equal(w.calls.native.length, 0);
    }
});

test('TTL is measured from storage and repeated reuse does not extend it', () => {
    const w = world(); w.policy.portalRouteCache.ttl = 100;
    assert.equal(store(w), true);
    w.advance(99); assert.ok(get(w));
    w.advance(1); assert.equal(get(w), undefined);
    assert.equal(Object.keys(w.memory.shardRouteCache.entries).length, 0);
});

test('route directory stays bounded and evicts least recently reused entries', () => {
    const w = world(); w.policy.portalRouteCache.maximumEntries = 2;
    assert.equal(store(w, 'W3N3'), true);
    w.advance(); assert.equal(store(w, 'W4N4'), true);
    w.advance(); assert.ok(get(w, 'W3N3'));
    w.advance(); assert.equal(store(w, 'W5N5'), true);
    assert.equal(Object.keys(w.memory.shardRouteCache.entries).length, 2);
    assert.equal(get(w, 'W4N4'), undefined);
    assert.ok(get(w, 'W3N3')); assert.ok(get(w, 'W5N5'));
});

test('malformed, disconnected, unknown or oversized routes are not cached', () => {
    const w = world();
    assert.equal(store(w, 'W3N3', []), false);
    assert.equal(store(w, 'W3N3', [{ ...outward[0], x: 50 }]), false);
    assert.equal(store(w, 'W3N3', [{ ...outward[0], destinationShard: 'shard0' }]), false);
    assert.equal(store(w, 'W3N3', [{ ...outward[0], x: 11 }]), false);
    assert.equal(store(w, 'E99999999999999999999999N1'), false);
    assert.equal(store(w, 'W03N3'), false);
    assert.equal(store(w, 'W3N3', [...outward, ...outward]), false);
    w.policy.portalRouting.maximumHops = 0; assert.equal(store(w), false);
    assert.equal(w.memory.shardRouteCache, undefined);
    assert.equal(w.calls.native.length, 0);
});

test('a damaged or another-shard directory is replaced without reading its candidates', () => {
    const w = world();
    w.memory.shardRouteCache = { version: 1, shard: 'shard2', entries: {} };
    assert.equal(get(w), undefined); assert.equal(store(w), true);
    assert.equal(w.memory.shardRouteCache.shard, 'shard0');
    const key = Object.keys(w.memory.shardRouteCache.entries)[0];
    w.memory.shardRouteCache.entries[key].storedAt = w.clock.now + 1;
    assert.equal(get(w), undefined);
    w.memory.shardRouteCache.entries.corrupt = null;
    assert.equal(store(w), true);
    assert.equal(Object.keys(w.memory.shardRouteCache.entries).length, 1);
});

test('local departure, entrance and native intermediate room status are rechecked', () => {
    for (const blocked of ['W1N1', 'W2N1', 'W8N8']) {
        const w = world(); assert.equal(store(w), true);
        w.statuses.set(blocked, 'closed');
        w.native([{ exit: 1, room: 'W8N8' }, { exit: 1, room: 'W2N1' }]);
        assert.equal(get(w), undefined);
        assert.equal(w.calls.native.length, blocked === 'W8N8' ? 1 : 0);
    }
});

test('an inaccessible local walking leg does not reuse the cached candidate', () => {
    const w = world(); assert.equal(store(w), true);
    w.native(-2); assert.equal(get(w), undefined);
    w.native([{ exit: 1, room: 'W7N7' }]); assert.equal(get(w), undefined);
    w.native((first, last, options) => {
        assert.equal(options.routeCallback('W9N9'), Infinity);
        return [{ exit: 1, room: 'W9N9' }, { exit: 1, room: last }];
    });
    // This entry is stored under the newly selected avoid policy.
    w.avoid.push('W9N9'); assert.equal(store(w), true); assert.equal(get(w), undefined);
});

test('cache lookup honors normal CPU, headroom and local-query allowances', () => {
    const w = world(); assert.equal(store(w), true);
    assert.equal(get(w, 'W3N3', { maximumLocalRouteChecks: 0 }), undefined);
    assert.equal(get(w, 'W3N3', { maximumPlanningCpu: 0 }), undefined);
    assert.equal(get(w, 'W3N3', { onLocalRouteCheck: () => false }), undefined);
    w.clock.cpu = 81; assert.equal(get(w), undefined);
    assert.equal(w.calls.native.length, 0);
});

test('terminal cleanup retains known explicit outbound and return routes with no native planning', () => {
    const w = world(), old = mission(w, 'old', { route: copy(outward), returnRoute: copy(returning), autoRoute: false });
    w.game.cpu.bucket = 0; w.clock.cpu = 100;
    old.routing = { status: 'ready', portalSignature: 'nearestHop:known', cost: 51, returnCost: 51 };
    old.state = 'complete';
    w.cache.cacheMissionRoutes(old);
    assert.equal(Object.keys(w.memory.shardRouteCache.entries).length, 2);
    assert.equal(w.calls.native.length, 0); assert.equal(w.calls.plans.length, 0);
    const saved = JSON.stringify(w.memory.shardRouteCache);
    assert.equal(saved.includes('missionId'), false); assert.equal(saved.includes('scouting'), false); assert.equal(saved.includes('leases'), false);
});

test('unverified low-bucket geometric routes are not promoted to normal cached plans', () => {
    for (const verifyRoute of [true, false]) {
        const w = world(), old = mission(w, 'old', { route: copy(outward), verifyRoute });
        old.routing = { status: 'ready', portalSignature: 'lowBucket:nearestHop:known' };
        old.state = 'cancelled'; w.cache.cacheMissionRoutes(old);
        assert.equal(w.memory.shardRouteCache, undefined);
        assert.equal(w.calls.native.length, 0); assert.equal(w.calls.plans.length, 0);
    }
});

test('fresh missions reuse route geometry while requiring their own scout and proof', () => {
    const w = world(), old = mission(w, 'old');
    w.routing.updateMissionRouting(old, true); w.verification.refreshMissionScouting(old);
    old.leases['scout:0'] = { name: 'old-scout', createdAt: w.clock.now };
    const proof = { missionId: old.task.key, sourceShard: 'shard0', scoutName: 'old-scout', revision: old.scouting.revision,
        shard: 'shard1', leg: 'outbound', result: 'verified', updatedAt: w.clock.now, elapsedTicks: 5, roomName: 'W3N3', route: copy(outward) };
    assert.equal(w.verification.acceptScoutProof(old, proof, 'shard1'), true);
    assert.equal(old.scouting.status, 'verified'); assert.equal(w.calls.plans.length, 1);
    w.memory.shardMissions = { old }; delete w.memory.shardMissions.old;
    w.advance(); const next = mission(w, 'new');
    w.routing.updateMissionRouting(next, true); w.verification.refreshMissionScouting(next);
    assert.deepEqual(copy(next.task.route), outward);
    assert.equal(w.calls.plans.length, 1); assert.equal(w.calls.native.length, 2);
    assert.equal(next.scouting.status, 'pending'); assert.equal(w.verification.isMissionVerified(next), false);
    assert.notEqual(next.scouting.revision, old.scouting.revision);
    next.leases['scout:0'] = { name: 'new-scout', createdAt: w.clock.now };
    assert.equal(w.verification.acceptScoutProof(next, proof, 'shard1'), false);
});

test('explicit user routes remain authoritative even with a different cached candidate', () => {
    const w = world(); assert.equal(store(w), true);
    const explicit = [{ ...outward[0], x: 11 }], next = mission(w, 'manual', { route: copy(explicit), autoRoute: false });
    w.routing.updateMissionRouting(next, true);
    assert.deepEqual(copy(next.task.route), explicit);
    assert.equal(w.calls.native.length, 0); assert.equal(w.calls.plans.length, 0);
});

test('low-bucket routing skips native cache validation and never stores its geometric result', () => {
    const w = world(); assert.equal(store(w), true);
    w.game.cpu.bucket = 0;
    const next = mission(w, 'low', { targetRoom: 'W4N4' });
    w.routing.updateMissionRouting(next, true);
    assert.deepEqual(copy(next.task.route), outward);
    assert.match(next.routing.portalSignature, /^lowBucket:/);
    assert.equal(w.calls.native.length, 0); assert.equal(w.calls.plans.length, 0);
    assert.equal(Object.keys(w.memory.shardRouteCache.entries).length, 1);
});

test('a failed cache walking check and graph fallback share one native and CPU allowance', () => {
    const w = world(); assert.equal(store(w), true);
    w.clock.nativeCpu = 2; w.native(-2);
    w.routing.updateMissionRouting(mission(w, 'fallback'), true);
    assert.equal(w.calls.plans.length, 1);
    const options = w.calls.plans[0][5];
    assert.equal(options.maximumLocalRouteChecks, w.policy.portalRouting.maximumLocalRouteChecks - 1);
    assert.equal(options.maximumPlanningCpu, w.policy.portalRouting.maximumPlanningCpu - 2);
});


test('cached geometry does not project the current shard blacklist onto a same-named remote landing', () => {
    const w = world(); w.avoidByShard.shard0 = ['W3N3'];
    assert.equal(store(w), true);
    assert.ok(get(w), 'shard1 W3N3 is allowed even when shard0 W3N3 is forbidden');
    const native = w.calls.native.length;
    w.avoidByShard.shard1 = ['W3N3'];
    assert.equal(get(w), undefined);
    assert.equal(store(w), false, 'forbidden landing geometry cannot be saved under its new policy');
    assert.equal(w.calls.native.length, native, 'remote admission never makes a native map query');
});

test('every shard blacklist contributes to the route cache key, even when the edited room is outside this route', () => {
    const w = world(); assert.equal(store(w), true);
    w.avoidByShard.shard2 = ['W8N8', 'W9N9'];
    assert.equal(get(w), undefined, 'changing a remote shard policy invalidates the previous signature');
    assert.equal(w.calls.native.length, 0);
    assert.equal(store(w), true);
    w.avoidByShard.shard2.reverse();
    assert.ok(get(w), 'reordering the same configuration retains its sorted signature');
});

test('cache admission validates both mission endpoints and each portal endpoint on its actual shard', () => {
    for (const [shard, room] of [['shard0', 'W1N1'], ['shard0', 'W2N1'], ['shard1', 'W3N3'], ['shard1', 'W4N4']]) {
        const w = world(); assert.equal(store(w, 'W4N4'), true);
        w.avoidByShard[shard] = [room];
        assert.equal(get(w, 'W4N4'), undefined);
        assert.equal(store(w, 'W4N4'), false);
        assert.equal(w.calls.native.length, 0);
    }
});
