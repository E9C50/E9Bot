const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function coordinates(name) {
    const [, horizontal, x, vertical, y] = /^([WE])(\d+)([NS])(\d+)$/.exec(name);
    return [horizontal === 'W' ? -Number(x) - 1 : Number(x), vertical === 'N' ? -Number(y) - 1 : Number(y)];
}

function world(overrides = {}) {
    const counts = { structureEnumerations: 0, structureReads: 0, statuses: 0, distances: 0, finds: new Map(), observations: [] };
    const rows = {}, memory = {}, statuses = {}, local = { version: 1, transfers: {}, acks: {} };
    const clock = { now: 1000000 };
    const game = { time: 5, shard: { name: 'shard3' }, rooms: {}, cpu: { bucket: 10000 },
        structures: new Proxy(rows, {
            ownKeys(target) { counts.structureEnumerations++; return Reflect.ownKeys(target); },
            get(target, key, receiver) { if (typeof key === 'string') counts.structureReads++; return Reflect.get(target, key, receiver); },
        }),
        map: {
            getRoomStatus(name) {
                counts.statuses++;
                const status = statuses[name];
                if (status instanceof Error) throw status;
                return status || { status: 'normal' };
            },
            getRoomLinearDistance(first, second) {
                counts.distances++;
                const from = coordinates(first), to = coordinates(second);
                return Math.max(Math.abs(from[0] - to[0]), Math.abs(from[1] - to[1]));
            },
        },
    };
    const loader = createSourceLoader({
        globals: { Game: game, Memory: memory, Date: class extends Date { static now() { return clock.now; } },
            STRUCTURE_OBSERVER: 'observer', STRUCTURE_PORTAL: 'portal', FIND_STRUCTURES: 'structures', OBSERVER_RANGE: 10, OK: 0 },
        modules: { './transport': { getLocalShardState: () => local, markShardStateDirty() {}, readRemoteShardState() {} } },
    });
    const policy = loader.load('settings/interShard').interShardPolicy;
    policy.peers = ['shard3'];
    Object.assign(policy.portalDiscovery, overrides);
    const api = loader.load('shard/portalIntel');
    function room(name, structures = []) {
        const value = { name, structures, find(type) {
            assert.equal(type, 'structures');
            counts.finds.set(name, (counts.finds.get(name) || 0) + 1);
            return this.structures;
        } };
        game.rooms[name] = value;
        return value;
    }
    function observer(id, name = 'E1S1') {
        const value = { id, structureType: 'observer', my: true, active: true, pos: { roomName: name },
            isActive() { return this.active; },
            observeRoom(target) { counts.observations.push({ id, target, tick: game.time }); return 0; },
        };
        rows[id] = value;
        return value;
    }
    function portal(id, name, destinationShard = 'shard2', destinationRoom = 'E0S0', ticksToDecay) {
        return { id, structureType: 'portal', pos: { roomName: name, x: 10, y: 10 },
            destination: { shard: destinationShard, room: destinationRoom }, ticksToDecay };
    }
    function advance(ticks = 1) { game.time += ticks; clock.now += ticks * 1000; }
    return { api, counts, rows, memory, statuses, clock, local, game, policy: policy.portalDiscovery, room, observer, portal, advance };
}

test('a low-bucket empire indexes thousands of buildings once per 25 ticks while checking cached Observers every tick', () => {
    const w = world();
    w.game.cpu.bucket = 663;
    for (let index = 0; index < 4980; index++) w.rows['building-' + index] = { structureType: 'extension' };
    for (let index = 0; index < 20; index++) w.observer('observer-' + index, `E${index * 20 + 1}S1`);
    for (let tick = 0; tick < 100; tick++) {
        w.api.runPortalDiscovery();
        assert.equal(w.api.getPortalIntelStatus().observers, 20);
        assert.match(w.api.getPortalIntelStatus().message, /Bucket/);
        w.api.getKnownPortals();
        w.api.getKnownPortals();
        if (tick === 24) {
            assert.equal(w.counts.structureEnumerations, 1);
            assert.equal(w.counts.structureReads, 5000 + 25 * 20);
        }
        w.advance();
    }
    assert.equal(w.counts.structureEnumerations, 4, 'the previous every-tick empire enumeration would perform 100 scans');
    assert.equal(w.counts.structureReads, 4 * 5000 + 100 * 20);
    assert.ok(w.counts.structureReads < 100 * 5000 * 0.05, 'building property reads fall by more than 95% in this stable-index workload');
    assert.equal(w.counts.observations.length, 0, 'low bucket still delays observation intents');
});

test('stable visible ordinary rooms and empty hotspots avoid native queries while a known portal is checked every tick', () => {
    const w = world();
    const ordinary = [], hotspots = [];
    for (let index = 0; index < 100; index++) {
        const name = `E${1 + Math.floor(index / 9) * 10}S${1 + index % 9}`;
        ordinary.push(name); w.room(name);
    }
    for (let index = 0; index < 20; index++) {
        const name = `E${index * 10}S0`;
        hotspots.push(name); w.room(name);
    }
    const knownRoom = w.room('E500S500', [w.portal('known', 'E500S500')]);
    for (let tick = 0; tick < 100; tick++) {
        w.api.runPortalDiscovery();
        assert.equal(w.api.getKnownPortals()[0].id, 'known');
        w.api.getKnownPortals();
        w.advance();
    }
    for (const name of ordinary) assert.equal(w.counts.finds.get(name), 1);
    for (const name of hotspots) assert.equal(w.counts.finds.get(name), 4);
    assert.equal(w.counts.finds.get(knownRoom.name), 100);
    assert.equal(w.counts.statuses, 121, 'stable room status is shared across the entire 100-tick window');
    assert.ok(w.counts.statuses < 280 * 0.5, 'bounded status caching cuts more than half the native queries left by the earlier scan optimization');
    assert.ok(w.counts.statuses < 121 * 100 * 0.03, 'the old all-visible status loop alone would perform 12,100 native calls');
    const finds = Array.from(w.counts.finds.values()).reduce((sum, count) => sum + count, 0);
    assert.equal(finds, 280, 'the old empty-crossroad scan would perform 2,200 structure finds in this workload');
    assert.ok(finds < 2200 * 0.13);
    knownRoom.structures = [];
    w.api.runPortalDiscovery();
    assert.equal(w.api.getKnownPortals().length, 0, 'a visible known door disappears immediately after the measured window');
    assert.equal(w.local.portalIntel.portals.length, 0);
});

test('cached Observer destruction, ownership loss and inactivity are immediate; new construction joins at the configured refresh', () => {
    const w = world();
    const original = w.observer('original');
    w.api.runPortalDiscovery();
    assert.equal(w.api.getPortalIntelStatus().observers, 1);
    original.active = false;
    w.advance(); w.api.runPortalDiscovery();
    assert.equal(w.api.getPortalIntelStatus().observers, 0);
    original.active = true; original.my = false;
    w.advance(); w.api.runPortalDiscovery();
    assert.equal(w.api.getPortalIntelStatus().observers, 0);
    original.my = true;
    w.advance(); w.api.runPortalDiscovery();
    assert.equal(w.api.getPortalIntelStatus().observers, 1);
    delete w.rows.original;
    w.observer('replacement');
    w.advance(); w.api.runPortalDiscovery();
    assert.equal(w.api.getPortalIntelStatus().observers, 0, 'destroyed IDs do not remain available, even before an index refresh');
    w.advance(20); w.api.runPortalDiscovery();
    assert.equal(w.game.time, 29);
    assert.equal(w.api.getPortalIntelStatus().observers, 0);
    w.advance(); w.api.runPortalDiscovery();
    assert.equal(w.game.time, 30);
    assert.equal(w.api.getPortalIntelStatus().observers, 1);
    assert.equal(w.counts.structureEnumerations, 2);
});

test('Observer indexes reset with shard identity and tick rollback', () => {
    const w = world(); w.observer('first');
    w.api.runPortalDiscovery();
    delete w.rows.first; w.observer('second');
    w.game.shard.name = 'shard2';
    w.api.runPortalDiscovery();
    assert.equal(w.api.getPortalIntelStatus().observers, 1);
    assert.equal(w.counts.structureEnumerations, 2);
    delete w.rows.second; w.observer('third');
    w.game.time = 4;
    w.api.runPortalDiscovery();
    assert.equal(w.api.getPortalIntelStatus().observers, 1);
    assert.equal(w.counts.structureEnumerations, 3);
});

test('empty hotspots have bounded refresh, while newly visible scout rooms are sampled immediately without Observer ownership', () => {
    const w = world({ emptyHotspotRescanInterval: 3 });
    const hotspot = w.room('E10S10');
    w.api.runPortalDiscovery();
    hotspot.structures.push(w.portal('new-door', hotspot.name));
    w.advance(); w.api.runPortalDiscovery();
    assert.equal(w.api.getKnownPortals().length, 0);
    w.advance(); w.api.runPortalDiscovery();
    assert.equal(w.api.getKnownPortals().length, 0);
    w.advance(); w.api.runPortalDiscovery();
    assert.equal(w.api.getKnownPortals()[0].id, 'new-door');
    assert.equal(w.counts.finds.get(hotspot.name), 2);
    delete w.game.rooms[hotspot.name];
    w.advance(); w.api.runPortalDiscovery();
    w.room('E20S20', [w.portal('scout-arrival', 'E20S20', 'shard1')]);
    w.advance(); w.api.runPortalDiscovery();
    assert.equal(w.api.getKnownPortals().some(record => record.id === 'scout-arrival'), true);
    assert.equal(w.api.getPortalIntelStatus().observers, 0);
    assert.equal(w.counts.finds.get('E20S20'), 1);
});

test('known portal changes invalidate a same-tick route cache immediately and temporary decay keeps its tick safety margin', () => {
    const w = world({ emptyHotspotRescanInterval: 100 });
    const door = w.portal('door', 'E10S10');
    w.room('E10S10', [door]);
    w.api.runPortalDiscovery();
    w.advance();
    assert.equal(w.api.getKnownPortals()[0].destinationShard, 'shard2');
    door.destination = { shard: 'shard1', room: 'E30S30' };
    w.api.runPortalDiscovery();
    assert.equal(w.api.getKnownPortals()[0].destinationShard, 'shard1');
    assert.equal(w.local.portalIntel.portals[0].destinationRoom, 'E30S30');
    door.ticksToDecay = 2001;
    w.advance(); w.api.runPortalDiscovery();
    assert.equal(w.api.getKnownPortals().length, 1);
    assert.equal(w.local.portalIntel.portals.length, 0, 'shard-local temporary tick lifetimes are never published');
    door.ticksToDecay = 2000;
    w.advance(); w.api.runPortalDiscovery();
    assert.equal(w.api.getKnownPortals().length, 1);
    door.ticksToDecay = 1999;
    w.advance(); w.api.runPortalDiscovery();
    assert.equal(w.api.getKnownPortals().length, 0);
    assert.equal(w.counts.finds.get('E10S10'), 5, 'even the invalidation tick checks actual vision for a replacement door');
});

test('a visible replacement for an expired known entrance bypasses the empty-hotspot refresh interval', () => {
    const w = world({ emptyHotspotRescanInterval: 100 });
    const hotspot = w.room('E10S10', [w.portal('temporary', 'E10S10', 'shard2', 'E0S0', 2001)]);
    w.api.runPortalDiscovery();
    hotspot.structures = [w.portal('replacement', hotspot.name, 'shard1', 'E30S30')];
    w.advance(2); w.api.runPortalDiscovery();
    assert.equal(w.api.getKnownPortals().length, 1);
    assert.equal(w.api.getKnownPortals()[0].id, 'replacement');
    assert.equal(w.local.portalIntel.portals[0].destinationShard, 'shard1');
    assert.equal(w.counts.finds.get(hotspot.name), 2);
});

test('default Observer scheduling uses bounded real candidates without repeated native distance calls', () => {
    const w = world(); w.observer('source', 'E1S1');
    for (let tick = 0; tick < 25; tick++) { w.api.runPortalDiscovery(); w.advance(); }
    assert.equal(w.counts.structureEnumerations, 1);
    assert.equal(w.counts.distances, 0, 'signed room coordinates already define the native Observer range');
    assert.equal(w.counts.observations.length, 5);
    for (const { target } of w.counts.observations) {
        assert.match(target, /^[WE]\d*0[NS]\d*0$/);
        const from = coordinates('E1S1'), to = coordinates(target);
        assert.ok(Math.max(Math.abs(from[0] - to[0]), Math.abs(from[1] - to[1])) <= 10);
    }
});

test('disabling automatic discovery avoids even the cold full-empire Observer enumeration', () => {
    const w = world({ enabled: false }); w.observer('unused');
    w.api.runPortalDiscovery();
    assert.equal(w.counts.structureEnumerations, 0);
    assert.equal(w.counts.structureReads, 0);
    assert.equal(w.counts.observations.length, 0);
    assert.match(w.api.getPortalIntelStatus().message, /关闭/);
});

test('normal status uses the configured tick TTL and same-tick portal readers share one native query', () => {
    const w = world({ roomStatusCacheTicks: 100 });
    w.room('E10S10', [w.portal('door', 'E10S10')]);
    w.api.runPortalDiscovery();
    assert.equal(w.api.getKnownPortals().length, 1);
    w.api.getPortalIntelStatus();
    w.api.getKnownPortals();
    assert.equal(w.counts.statuses, 1);
    w.advance(99); w.api.runPortalDiscovery();
    assert.equal(w.api.getKnownPortals().length, 1);
    assert.equal(w.counts.statuses, 1, 'the final tick before expiry remains cached');
    w.advance(); w.api.runPortalDiscovery();
    assert.equal(w.api.getKnownPortals().length, 1);
    assert.equal(w.counts.statuses, 2, 'the TTL boundary refreshes before accepting the door');
    assert.equal(w.counts.finds.get('E10S10'), 3, 'status caching does not defer physical portal checks');
});

test('a scheduled wall-clock room status transition invalidates a normal result before its tick TTL', () => {
    const w = world({ roomStatusCacheTicks: 100 });
    w.statuses.E10S10 = { status: 'normal', timestamp: w.clock.now + 1500 };
    w.room('E10S10', [w.portal('door', 'E10S10')]);
    w.api.runPortalDiscovery();
    w.advance(); w.api.runPortalDiscovery();
    assert.equal(w.api.getKnownPortals().length, 1);
    assert.equal(w.counts.statuses, 1);
    w.statuses.E10S10 = { status: 'closed', timestamp: null };
    w.advance(); w.api.runPortalDiscovery();
    assert.equal(w.counts.statuses, 2);
    assert.equal(w.api.getKnownPortals().length, 0, 'the deadline prevents reuse of the formerly normal entrance');
    assert.equal(w.local.portalIntel.portals.length, 0);
});

test('non-normal and unavailable statuses recover next tick instead of waiting for the normal-room TTL', () => {
    for (const unavailable of [{ status: 'closed' }, new Error('status unavailable')]) {
        const w = world({ roomStatusCacheTicks: 100 });
        w.statuses.E10S10 = unavailable;
        w.room('E10S10', [w.portal('door', 'E10S10')]);
        w.api.runPortalDiscovery();
        w.api.getKnownPortals();
        assert.equal(w.counts.statuses, 1);
        assert.equal(w.api.getKnownPortals().length, 0);
        w.statuses.E10S10 = { status: 'normal' };
        w.advance(); w.api.runPortalDiscovery();
        assert.equal(w.counts.statuses, 2);
        assert.equal(w.api.getKnownPortals()[0].id, 'door');
    }
});

test('status caches reset on shard identity changes and tick rollback', () => {
    const w = world({ roomStatusCacheTicks: 100 });
    w.room('E10S10', [w.portal('door', 'E10S10')]);
    w.api.runPortalDiscovery();
    assert.equal(w.counts.statuses, 1);
    w.game.shard.name = 'shard0';
    w.api.runPortalDiscovery();
    assert.equal(w.counts.statuses, 2);
    w.game.time = 4;
    w.api.runPortalDiscovery();
    assert.equal(w.counts.statuses, 3);

    const empty = world({ roomStatusCacheTicks: 100 });
    empty.room('E1S1');
    empty.api.runPortalDiscovery();
    empty.advance(20); empty.api.runPortalDiscovery();
    assert.equal(empty.counts.statuses, 1, 'empty ordinary rooms did not update the last queried tick');
    empty.game.time = 10;
    empty.api.runPortalDiscovery();
    assert.equal(empty.counts.statuses, 2, 'a rollback beyond the last queried tick still clears the status cache');
});

test('normal status caching remains bounded and refreshes an evicted room on new vision', () => {
    const w = world({ maximumScanRooms: 2, roomStatusCacheTicks: 100 });
    for (const name of ['E1S1', 'E2S2', 'E3S3']) w.room(name);
    w.api.runPortalDiscovery();
    assert.equal(w.counts.statuses, 3);
    assert.equal(Object.keys(w.memory.shardPortalIntel.scannedRooms).length, 2, 'new scan entries are trimmed immediately');
    w.game.rooms = {};
    w.advance(); w.api.runPortalDiscovery();
    w.room('E1S1');
    w.advance(); w.api.runPortalDiscovery();
    assert.equal(w.counts.statuses, 4, 'the oldest status cannot remain in an unbounded cache');
    assert.equal(w.counts.finds.get('E1S1'), 2);
});

test('stable scan-history maintenance traverses its bounded dictionary once per interval', () => {
    const w = world({ maintenanceInterval: 25 });
    w.api.runPortalDiscovery();
    const history = {};
    for (let index = 0; index < 300; index++) history[`E${index + 1}S1`] = w.game.time;
    let traversals = 0;
    w.memory.shardPortalIntel.scannedRooms = new Proxy(history, {
        ownKeys(target) { traversals++; return Reflect.ownKeys(target); },
    });
    for (let tick = 1; tick < 100; tick++) { w.advance(); w.api.runPortalDiscovery(); }
    assert.equal(traversals, 3, 'stable history is inspected at ticks 30, 55 and 80 rather than on all 99 ticks');
    assert.equal(Object.keys(history).length, 300);
});
