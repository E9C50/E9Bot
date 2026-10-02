const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function coordinates(name) {
    const match = /^([WE])(\d+)([NS])(\d+)$/.exec(name);
    return [match[1] === 'W' ? -Number(match[2]) - 1 : Number(match[2]), match[3] === 'N' ? -Number(match[4]) - 1 : Number(match[4])];
}

function world(overrides = {}) {
    const clock = { now: 1000000 };
    class ClockDate extends Date { static now() { return clock.now; } }
    const discovery = {
        enabled: true, scanInterval: 5, rescanInterval: 500, minimumBucket: 1000,
        maximumPortals: 160, maximumScanRooms: 300, maximumObserversPerTick: 2,
        intelMaxAge: 86400000, publishInterval: 25, minimumDecayTicks: 2000, observerRange: 10, includeSectorCenters: false,
        ...overrides,
    };
    const calls = { observations: [], finds: [], remote: [], dirty: 0 };
    const local = { version: 1, transfers: {}, acks: {} }, remotes = {}, statuses = {};
    const memory = { unrelated: { preserve: true } };
    const game = {
        time: 5, shard: { name: 'shardA' }, rooms: {}, structures: {}, cpu: { bucket: 10000 },
        map: {
            getRoomStatus: name => ({ status: statuses[name] || 'normal' }),
            getRoomLinearDistance(first, second) {
                const from = coordinates(first), to = coordinates(second);
                return Math.max(Math.abs(from[0] - to[0]), Math.abs(from[1] - to[1]));
            },
        },
    };
    const transport = {
        getLocalShardState: () => local,
        markShardStateDirty: () => calls.dirty++,
        readRemoteShardState: shard => { calls.remote.push(shard); return remotes[shard]; },
    };
    const loader = createSourceLoader({
        globals: { Game: game, Memory: memory, Date: ClockDate, STRUCTURE_OBSERVER: 'observer', STRUCTURE_PORTAL: 'portal', FIND_STRUCTURES: 'structures', OBSERVER_RANGE: 10, OK: 0 },
        modules: { 'settings/interShard': { interShardPolicy: { enabled: true, peers: ['shardA', 'shardB'], portalDiscovery: discovery } }, './transport': transport },
    });
    function room(name, structures = []) {
        const value = { name, structures, find(type) { assert.equal(type, 'structures'); calls.finds.push(name); return this.structures; } };
        game.rooms[name] = value;
        return value;
    }
    function portal(id, name, x = 10, y = 10, destinationShard = 'shardB', ticksToDecay) {
        return { id, structureType: 'portal', pos: { x, y, roomName: name }, destination: { shard: destinationShard, room: 'W15N15' }, ticksToDecay };
    }
    function observer(id = 'observer', name = 'W1N1', options = {}) {
        const value = { id, structureType: 'observer', my: options.my ?? true, pos: { roomName: name }, isActive: () => options.active ?? true,
            observeRoom(target) { calls.observations.push({ id, target, tick: game.time }); return options.result ?? 0; } };
        game.structures[id] = value;
        return value;
    }
    function advance(ticks = 1, milliseconds = 1000) { game.time += ticks; clock.now += milliseconds; }
    return { loader, api: loader.load('shard/portalIntel'), scheduling: loader.load('runtime/observerScheduling'), clock, discovery, calls, local, remotes, statuses, memory, game, room, portal, observer, advance };
}

test('portal discovery and observer scheduling import without game or memory access', () => {
    const loader = createSourceLoader({ modules: { 'settings/interShard': { interShardPolicy: {} }, './transport': {} } });
    assert.doesNotThrow(() => loader.load('shard/portalIntel'));
    assert.doesNotThrow(() => loader.load('runtime/observerScheduling'));
    assert.doesNotThrow(() => loader.load('module/ObserverController'));
});

test('visible stable and sufficiently long-lived local portals are discovered without requiring an Observer', () => {
    const w = world();
    const sameShard = w.portal('same', 'W1N1', 14, 10, 'shardA');
    const interRoom = { ...w.portal('inter-room', 'W1N1'), destination: { x: 20, y: 20, roomName: 'W2N2' } };
    w.room('W1N1', [w.portal('stable', 'W1N1'), w.portal('temporary', 'W1N1', 11, 10, 'shardB', 2001),
        w.portal('near-decay', 'W1N1', 12, 10, 'shardB', 1999), sameShard, interRoom]);
    w.api.runPortalDiscovery();
    assert.deepEqual(Array.from(w.api.getKnownPortals(), portal => portal.id).sort(), ['stable', 'temporary']);
    assert.deepEqual(Array.from(w.local.portalIntel.portals, portal => portal.id), ['stable']);
    assert.equal(w.memory.shardPortalIntel.portals['W1N1:11:10'].expiresAtTick, 2006);
    assert.equal(w.local.portalIntel.portals[0].expiresAt, undefined, 'stable portal lifetime is not guessed from ticks');
    assert.match(w.api.getPortalIntelStatus().message, /Observer/);
    assert.deepEqual(w.memory.unrelated, { preserve: true });
    w.advance(2);
    delete w.game.rooms.W1N1;
    w.api.runPortalDiscovery();
    assert.deepEqual(Array.from(w.api.getKnownPortals(), portal => portal.id), ['stable'], 'local temporary safety margin uses only this shard tick');
});

test('Observer scanning is bounded, stays within range, respects room status, and consumes only next-tick vision', () => {
    const w = world({ maximumObserversPerTick: 1 });
    const observer = w.observer();
    w.statuses.W0N0 = 'closed';
    w.api.runPortalDiscovery();
    assert.equal(w.calls.observations.length, 1);
    const requested = w.calls.observations[0].target;
    assert.match(requested, /^[WE]\d*0[NS]\d*0$/);
    assert.notEqual(requested, 'W0N0');
    assert.ok(w.game.map.getRoomLinearDistance(observer.pos.roomName, requested) <= 10);
    assert.equal(w.api.getKnownPortals().length, 0);
    assert.equal(w.game.rooms[requested], undefined, 'an observation intent does not create same-tick vision');
    w.api.runPortalDiscovery();
    w.loader.load('module/ObserverController').obScannerController();
    assert.equal(w.calls.observations.length, 1, 'both entry points are idempotent within the tick');
    assert.equal(w.scheduling.scheduleObservation(observer, 'W2N2', 'path'), undefined);
    assert.equal(w.calls.observations.length, 1, 'path observation cannot overwrite the scan reservation');
    w.advance();
    w.room(requested, [w.portal('newly-visible', requested)]);
    w.api.runPortalDiscovery();
    assert.equal(w.api.getKnownPortals()[0].id, 'newly-visible');
    assert.equal(w.scheduling.scheduleObservation(observer, 'W2N2', 'path'), 0, 'ordinary path observation remains available on non-scan ticks');
});

test('failed observations do not reserve an Observer and each tick permits only one successful intent', () => {
    const w = world();
    let result = -9;
    const observer = w.observer();
    observer.observeRoom = target => { w.calls.observations.push({ target, tick: w.game.time }); return result; };
    assert.equal(w.scheduling.scheduleObservation(observer, 'W2N2', 'portal'), -9);
    result = 0;
    assert.equal(w.scheduling.scheduleObservation(observer, 'W3N3', 'path'), 0);
    assert.equal(w.scheduling.scheduleObservation(observer, 'W4N4', 'portal'), undefined);
    w.advance();
    assert.equal(w.scheduling.scheduleObservation(observer, 'W4N4', 'portal'), 0);
    w.game.shard.name = 'shardB';
    assert.equal(w.scheduling.scheduleObservation(observer, 'W5N5', 'path'), 0, 'reservations also isolate shard identity');
});

test('scan requests leave alternate ticks for paths even if configured scanInterval is one', () => {
    const w = world({ scanInterval: 1 }); const observer = w.observer();
    w.game.time = 6;
    w.api.runPortalDiscovery();
    assert.equal(w.scheduling.scheduleObservation(observer, 'W2N2', 'path'), undefined);
    w.advance();
    w.api.runPortalDiscovery();
    assert.equal(w.scheduling.scheduleObservation(observer, 'W2N2', 'path'), 0);
});

test('visible missing portals are removed immediately while lack of vision retains their last observation', () => {
    const w = world(); const visible = w.room('W1N1', [w.portal('stable', 'W1N1')]);
    w.api.runPortalDiscovery();
    delete w.game.rooms.W1N1;
    w.advance(); w.api.runPortalDiscovery();
    assert.equal(w.api.getKnownPortals().length, 1);
    w.game.rooms.W1N1 = visible; visible.structures = [];
    w.advance(); w.api.runPortalDiscovery();
    assert.equal(w.api.getKnownPortals().length, 0);
    assert.equal(w.local.portalIntel.portals.length, 0);
});

test('continuously visible empty ordinary rooms avoid repeated structure scans but new vision is scanned', () => {
    const w = world({ rescanInterval: 10 }); const ordinary = w.room('W1N1');
    w.api.runPortalDiscovery();
    w.advance(); w.api.runPortalDiscovery();
    assert.deepEqual(w.calls.finds, ['W1N1']);
    delete w.game.rooms.W1N1;
    w.advance(); w.api.runPortalDiscovery();
    ordinary.structures.push(w.portal('incidental', ordinary.name));
    w.game.rooms.W1N1 = ordinary;
    w.advance(); w.api.runPortalDiscovery();
    assert.equal(w.api.getKnownPortals()[0].id, 'incidental');
    ordinary.structures = [];
    w.advance(); w.api.runPortalDiscovery();
    assert.equal(w.api.getKnownPortals().length, 0, 'known ordinary-room portals are still checked every visible tick');
});

test('known entry rooms outside highway crossroads are periodically observed again', () => {
    const w = world({ rescanInterval: 5, maximumObserversPerTick: 1 });
    const observer = w.observer();
    w.room('W2N2', [w.portal('off-center', 'W2N2')]); w.api.runPortalDiscovery();
    delete w.game.rooms.W2N2;
    for (const horizontal of ['W10', 'W0', 'E0']) for (const vertical of ['N10', 'N0', 'S0']) w.statuses[horizontal + vertical] = 'closed';
    w.advance(5); w.api.runPortalDiscovery();
    assert.equal(w.calls.observations.at(-1).target, 'W2N2');
    assert.ok(w.game.map.getRoomLinearDistance(observer.pos.roomName, 'W2N2') <= 10);
});

test('crossroad candidates use signed W/E/N/S boundary distances and exclude rooms beyond native range', () => {
    for (const origin of ['W1N1', 'E1N1', 'W1S1', 'E1S1']) {
        const w = world({ scanInterval: 2, maximumObserversPerTick: 1 }); const observer = w.observer('observer', origin);
        w.game.time = 6;
        for (let scan = 0; scan < 12; scan++) { w.api.runPortalDiscovery(); w.advance(2); }
        const targets = Array.from(new Set(w.calls.observations.map(call => call.target)));
        assert.equal(targets.length, 9, `${origin} covers nine highway crossings across the zero-axis boundaries`);
        for (const target of targets) {
            assert.match(target, /^[WE]\d*0[NS]\d*0$/);
            assert.ok(w.game.map.getRoomLinearDistance(observer.pos.roomName, target) <= 10, `${origin} cannot observe ${target}`);
        }
        for (const boundary of ['W0N0', 'W0S0', 'E0N0', 'E0S0']) assert.ok(targets.includes(boundary), `${origin} should scan ${boundary}`);
    }
    const reduced = world({ observerRange: 1, maximumObserversPerTick: 1 }); reduced.observer('near-boundary', 'E1S1');
    reduced.api.runPortalDiscovery();
    assert.deepEqual(reduced.calls.observations.map(call => call.target), ['E0S0'], 'configured lower range remains stricter than the native limit');
});

test('private-server sector centers are optional and highway crossroads retain scanning priority', () => {
    const priority = world({ includeSectorCenters: true, maximumObserversPerTick: 1 }); priority.observer(); priority.api.runPortalDiscovery();
    assert.match(priority.calls.observations[0].target, /^[WE]\d*0[NS]\d*0$/);
    const compatibility = world({ includeSectorCenters: true, maximumObserversPerTick: 1 }); compatibility.observer();
    for (const horizontal of ['W10', 'W0', 'E0']) for (const vertical of ['N10', 'N0', 'S0']) compatibility.statuses[horizontal + vertical] = 'closed';
    compatibility.api.runPortalDiscovery();
    assert.match(compatibility.calls.observations[0].target, /^[WE]\d*5[NS]\d*5$/);
    const official = world({ maximumObserversPerTick: 1 }); official.observer();
    Object.assign(official.statuses, compatibility.statuses); official.api.runPortalDiscovery();
    assert.equal(official.calls.observations.length, 0, 'default scanning does not spend requests on inter-room portal centers');
});

test('remote intel validates source shard, room coordinates, freshness and wall-clock expiry with tick caching', () => {
    const w = world();
    const good = { id: 'good', shard: 'shardB', roomName: 'W15N15', x: 10, y: 11, destinationShard: 'shardC', destinationRoom: 'E5S5', observedAt: w.clock.now };
    const records = [good, { ...good, id: 'bad-x', x: 50 }, { ...good, id: 'bad-room', roomName: 'bad' },
        { ...good, id: 'same-shard', destinationShard: 'shardB' }, { ...good, id: 'missing-landing', destinationRoom: undefined },
        { ...good, id: 'spoofed', shard: 'shardC' }, { ...good, id: 'stale', observedAt: w.clock.now - w.discovery.intelMaxAge - 1 },
        { ...good, id: 'future', observedAt: w.clock.now + 1 }, { ...good, id: 'expired', expiresAt: w.clock.now - 1 },
        { ...good, id: 'cross-shard-ticks', expiresAtTick: 500000 }];
    w.remotes.shardB = { portalIntel: { shard: 'shardB', updatedAt: w.clock.now, portals: records } };
    w.remotes.private = { portalIntel: { shard: 'shardC', updatedAt: w.clock.now, portals: [good] } };
    w.statuses.W15N15 = 'closed';
    assert.deepEqual(Array.from(w.api.getKnownPortals(['private']), portal => portal.id), ['good']);
    const returned = w.api.getKnownPortals(['private']); returned[0].destinationShard = 'tampered';
    assert.equal(w.api.getKnownPortals(['private'])[0].destinationShard, 'shardC');
    assert.deepEqual(w.calls.remote, ['private', 'shardB']);
    w.advance(1, w.discovery.intelMaxAge + 1);
    assert.equal(w.api.getKnownPortals(['private']).length, 0);
});

test('forgetting a verified broken hop publishes removal and preserves newly changed destinations', () => {
    const w = world(); w.room('W1N1', [w.portal('stable', 'W1N1')]); w.api.runPortalDiscovery();
    const record = w.api.getKnownPortals()[0];
    w.api.forgetPortal({ ...record, destinationShard: 'other' });
    assert.equal(w.api.getKnownPortals().length, 1);
    w.api.forgetPortal(record);
    assert.equal(w.api.getKnownPortals().length, 0);
    assert.equal(w.local.portalIntel.portals.length, 0);
    assert.equal(w.api.getPortalIntelStatus().portals, 0);
});

test('discovery caps persisted records and scan history without changing unrelated memory', () => {
    const w = world({ maximumPortals: 2, maximumScanRooms: 2 });
    w.room('W1N1', [w.portal('one', 'W1N1'), w.portal('two', 'W1N1', 11, 10), w.portal('three', 'W1N1', 12, 10)]);
    w.room('W2N2'); w.room('W3N3'); w.api.runPortalDiscovery();
    assert.equal(Object.keys(w.memory.shardPortalIntel.portals).length, 2);
    assert.equal(Object.keys(w.memory.shardPortalIntel.scannedRooms).length, 2);
    assert.equal(w.local.portalIntel.portals.length, 2);
    assert.deepEqual(w.memory.unrelated, { preserve: true });
});

test('inactive or foreign Observers are excluded and low CPU or observation failures remain visible', () => {
    const low = world(); low.observer('inactive', 'W1N1', { active: false }); low.observer('foreign', 'W2N2', { my: false }); low.observer('active');
    low.game.cpu.bucket = 10; low.api.runPortalDiscovery();
    assert.equal(low.api.getPortalIntelStatus().observers, 1);
    assert.match(low.api.getPortalIntelStatus().message, /Bucket/);
    assert.equal(low.calls.observations.length, 0);
    const failed = world({ maximumObserversPerTick: 1 }); failed.observer('first', 'W1N1', { result: -9 }); failed.observer('second', 'W2N2', { result: -9 });
    failed.api.runPortalDiscovery();
    assert.equal(failed.calls.observations.length, 1, 'the request budget also bounds failed observations');
    assert.match(failed.api.getPortalIntelStatus().message, /无法观测/);
    assert.equal(failed.api.getKnownPortals().length, 0);
});
