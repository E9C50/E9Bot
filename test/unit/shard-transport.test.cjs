const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world(overrides = {}) {
    const storage = {};
    const reads = [];
    const writes = [];
    const clock = { now: 1000000 };
    const policy = {
        enabled: true, namespace: 'ecbotShard', peers: ['shardA', 'shardB', 'shardC'],
        allowedRoles: ['sClaimer', 'sBuilder', 'sHauler'], transferTtl: 1200000, ackTtl: 1200000,
        maximumTransfers: 100, maximumAcks: 200, maximumBytes: 90000, ...overrides
    };
    const route = [
        { shard: 'shardA', roomName: 'W1N1', x: 10, y: 10, destinationShard: 'shardB', destinationRoom: 'W2N2' },
        { shard: 'shardB', roomName: 'W2N2', x: 20, y: 20, destinationShard: 'shardC', destinationRoom: 'W3N3' }
    ];
    function runtime(shard, tick = 1, apiAvailable = true) {
        const game = { shard: { name: shard }, time: tick, creeps: {}, rooms: {} };
        const memory = { creeps: {} };
        const moves = [];
        class RoomPosition {
            constructor(x, y, roomName) { this.x = x; this.y = y; this.roomName = roomName; }
            getRangeTo(other) { return Math.max(Math.abs(this.x - other.x), Math.abs(this.y - other.y)); }
        }
        class TestDate extends Date { static now() { return clock.now; } }
        const interShardMemory = {
            getLocal() { reads.push(`${shard}:local`); return storage[shard] || ''; },
            getRemote(peer) { reads.push(`${shard}:${peer}`); return storage[peer] || ''; },
            setLocal(text) { writes.push({ shard, text }); storage[shard] = text; }
        };
        const loader = createSourceLoader({
            globals: {
                Game: game, Memory: memory, Date: TestDate, RoomPosition,
                ...(apiAvailable ? { InterShardMemory: interShardMemory } : {}),
                LOOK_STRUCTURES: 'structure', STRUCTURE_PORTAL: 'portal', OK: 0, ERR_NO_PATH: -2, ERR_TIRED: -11
            },
            modules: { 'settings/interShard': { interShardPolicy: policy } }
        });
        const api = loader.load('shard/transport');
        const travel = loader.load('shard/travel');
        function creep(name = 'support', role = 'sBuilder', hopIndex = 0, roomName = shard === 'shardA' ? 'W1N1' : shard === 'shardB' ? 'W2N2' : 'W3N3') {
            memory.creeps[name] = role === undefined ? {} : {
                displayName: name, name, role, ready: true, working: true, spawnRoom: 'W1N1', spawnPriority: 4,
                data: { missionId: 'mission', originShard: 'shardA', route: JSON.parse(JSON.stringify(route)), hopIndex, task: { targetRoom: 'W3N3' }, unitKind: 'builder' }
            };
            const unit = {
                id: `object:${shard}:${name}`, name, my: true, pos: new RoomPosition(9, 10, roomName), room: { name: roomName },
                moveTo(pos, options) { moves.push({ x: pos.x, y: pos.y, roomName: pos.roomName, options }); return 0; }
            };
            Object.defineProperty(unit, 'memory', { get: () => memory.creeps[name] || (memory.creeps[name] = {}), set: value => { memory.creeps[name] = value; } });
            game.creeps[name] = unit;
            return unit;
        }
        function portal(hopIndex, destination = { shard: route[hopIndex].destinationShard, room: route[hopIndex].destinationRoom }) {
            const hop = route[hopIndex];
            game.rooms[hop.roomName] = { lookForAt(type, x, y) { return x === hop.x && y === hop.y ? [{ structureType: 'portal', destination }] : []; } };
        }
        return { api, travel, game, memory, moves, creep, portal, interShardMemory, loader };
    }
    return { storage, reads, writes, clock, policy, route, runtime };
}

test('shard modules have no Game or InterShardMemory access during import', () => {
    const loader = createSourceLoader({ modules: { 'settings/interShard': { interShardPolicy: {} } } });
    assert.doesNotThrow(() => loader.load('shard/transport'));
    assert.doesNotThrow(() => loader.load('shard/travel'));
});

test('transport preserves other namespaces and extension fields, caches reads, and writes only when dirty', () => {
    const shared = world();
    shared.storage.shardA = JSON.stringify({ otherBot: { keep: '中文 🚀' }, ecbotShard: { version: 1, transfers: {}, acks: {}, custom: { keep: true } } });
    shared.storage.shardB = JSON.stringify({ ecbotShard: { version: 1, transfers: {}, acks: {}, reports: { task: { done: true } } } });
    const source = shared.runtime('shardA');
    assert.equal(source.api.getLocalShardState().custom.keep, true);
    source.api.getLocalShardState();
    source.api.readRemoteShardState('shardB'); source.api.readRemoteShardState('shardB');
    assert.deepEqual(shared.reads, ['shardA:local', 'shardA:shardB']);
    source.api.flushInterShardMemory();
    assert.equal(shared.writes.length, 0);
    source.api.getLocalShardState().reports = { example: { ready: true } };
    source.api.markShardStateDirty();
    assert.equal(source.api.flushInterShardMemory(), true);
    source.api.flushInterShardMemory();
    assert.equal(shared.writes.length, 1);
    const stored = JSON.parse(shared.storage.shardA);
    assert.deepEqual(stored.otherBot, { keep: '中文 🚀' });
    assert.deepEqual(stored.ecbotShard.custom, { keep: true });
    assert.deepEqual(stored.ecbotShard.reports, { example: { ready: true } });
    source.game.time++;
    source.api.readRemoteShardState('shardB');
    assert.equal(shared.reads.filter(read => read === 'shardA:shardB').length, 2);
});

test('invalid local JSON and unsupported versions are retained instead of being overwritten', () => {
    for (const original of ['{broken data', JSON.stringify({ other: 'keep', ecbotShard: { version: 2, transfers: {}, acks: {} } })]) {
        const shared = world(); shared.storage.shardA = original;
        const source = shared.runtime('shardA'); const unit = source.creep();
        assert.equal(source.api.publishCreepTransfer(unit, 'shardB', 1), false);
        source.api.markShardStateDirty();
        assert.equal(source.api.flushInterShardMemory(), false);
        assert.equal(shared.storage.shardA, original);
        assert.ok(source.api.getShardTransportError());
        assert.equal(shared.writes.length, 0);
    }
});

test('malformed local reports retain the original namespace and cannot be overwritten', () => {
    for (const reports of [null, [], 'invalid', 42]) {
        const shared = world();
        const original = JSON.stringify({ otherBot: { keep: true }, ecbotShard: { version: 1, transfers: {}, acks: {}, reports } });
        shared.storage.shardA = original;
        shared.storage.shardB = original;
        const source = shared.runtime('shardA'); const unit = source.creep();
        assert.equal(source.api.publishCreepTransfer(unit, 'shardB', 1), false);
        source.api.getLocalShardState().reports = { example: { ready: true } };
        source.api.markShardStateDirty();
        assert.equal(source.api.flushInterShardMemory(), false);
        assert.equal(source.api.readRemoteShardState('shardB'), undefined);
        assert.equal(shared.storage.shardA, original);
        assert.ok(source.api.getShardTransportError());
        assert.equal(shared.writes.length, 0);
    }
});

test('in-capacity acknowledgment maintenance does not sort or write idle state', () => {
    for (const count of [0, 2]) {
        const shared = world({ maximumAcks: 2 });
        const acks = {};
        for (let index = 0; index < count; index++) {
            const id = `ack-${index}`;
            acks[id] = { id, fromShard: 'shardA', toShard: 'shardB', creepName: id, createdAt: shared.clock.now - index, expiresAt: shared.clock.now + 1000 };
        }
        shared.storage.shardA = JSON.stringify({ ecbotShard: { version: 1, transfers: {}, acks } });
        const source = shared.runtime('shardA');
        vm.runInContext("Array.prototype.sort = function () { throw new Error('Idle acknowledgment maintenance must not sort'); };", source.loader.globals);
        assert.equal(source.api.flushInterShardMemory(), true);
        assert.equal(Object.keys(source.api.getLocalShardState().acks).length, count);
        assert.equal(shared.writes.length, 0);
    }
});

test('republication keeps the latest full memory snapshot even when its route and phase are unchanged', () => {
    const shared = world(); const source = shared.runtime('shardA'); const unit = source.creep();
    unit.memory.data.phase = 'outbound';
    unit.memory.customState = { revision: 1 };
    source.api.publishCreepTransfer(unit, 'shardB', 1); source.api.flushInterShardMemory();
    const firstId = Object.keys(source.api.getLocalShardState().transfers)[0];
    source.game.time++; shared.clock.now++;
    unit.memory.ready = false;
    unit.memory.working = false;
    unit.memory.customState.revision = 2;
    unit.memory.data.task.targetRoom = 'W4N4';
    unit.memory.data.pendingDelivery = { amount: 50, energyBefore: 75, tick: source.game.time };
    assert.equal(source.api.publishCreepTransfer(unit, 'shardB', 1), true);
    assert.equal(source.api.flushInterShardMemory(), true);
    assert.equal(Object.keys(source.api.getLocalShardState().transfers)[0], firstId);
    const target = shared.runtime('shardB'); const arriving = target.creep(); arriving.memory = {};
    assert.equal(target.api.restoreArrivingCreeps(), 1);
    assert.equal(arriving.memory.ready, false);
    assert.equal(arriving.memory.working, false);
    assert.equal(arriving.memory.customState.revision, 2);
    assert.equal(arriving.memory.data.task.targetRoom, 'W4N4');
    assert.deepEqual(JSON.parse(JSON.stringify(arriving.memory.data.pendingDelivery)), unit.memory.data.pendingDelivery);
    assert.equal(arriving.memory.data.hopIndex, 1);
    assert.equal(unit.memory.data.hopIndex, 0);
});

test('a full memory snapshot survives source creep GC and restores the next hop on a different shard clock', () => {
    const shared = world(); const source = shared.runtime('shardA', 100000); const unit = source.creep();
    unit.memory.customState = { nested: ['preserve'] };
    const before = JSON.stringify(unit.memory);
    assert.equal(source.api.publishCreepTransfer(unit, 'shardB', 1), true);
    assert.equal(source.api.flushInterShardMemory(), true);
    assert.equal(JSON.stringify(unit.memory), before, 'publishing changes only the copied hop index');
    delete source.game.creeps.support; delete source.memory.creeps.support;

    const destination = shared.runtime('shardB', 7); const arriving = destination.creep('support', undefined);
    // The fixture's default role only applies to omitted arguments, so clear this arrival explicitly.
    arriving.memory = {};
    assert.equal(destination.api.restoreArrivingCreeps(), 1);
    assert.equal(arriving.memory.role, 'sBuilder');
    assert.equal(arriving.memory.data.hopIndex, 1);
    assert.equal(arriving.memory.data.task.targetRoom, 'W3N3');
    assert.deepEqual(Array.from(arriving.memory.customState.nested), ['preserve']);
    assert.equal(destination.api.flushInterShardMemory(), true);
    source.game.time++;
    source.api.flushInterShardMemory();
    assert.equal(Object.keys(source.api.getLocalShardState().transfers).length, 0, 'matching destination acknowledgment releases the source snapshot');
});

test('arrival recovery ignores existing local roles, expired transfers, bad remote JSON and disallowed roles', () => {
    const shared = world(); const source = shared.runtime('shardA'); const unit = source.creep();
    source.api.publishCreepTransfer(unit, 'shardB', 1); source.api.flushInterShardMemory();
    shared.storage.shardC = '{bad remote';
    const destination = shared.runtime('shardB'); const local = destination.creep('support', 'builder');
    const original = local.memory;
    assert.doesNotThrow(() => destination.api.restoreArrivingCreeps());
    assert.equal(destination.api.restoreArrivingCreeps(), 0);
    assert.equal(local.memory, original);
    local.memory = {};
    const document = JSON.parse(shared.storage.shardA);
    const transfer = Object.values(document.ecbotShard.transfers)[0];
    transfer.memory.role = 'harvester';
    shared.storage.shardA = JSON.stringify(document);
    destination.game.time++;
    assert.equal(destination.api.restoreArrivingCreeps(), 0);
    transfer.memory.role = 'sBuilder'; transfer.expiresAt = shared.clock.now - 1;
    shared.storage.shardA = JSON.stringify(document); destination.game.time++;
    assert.equal(destination.api.restoreArrivingCreeps(), 0);
});

test('arrival recovery chooses the newest snapshot across all peers regardless of peer order', () => {
    for (const peers of [['shardA', 'shardB', 'shardC'], ['shardB', 'shardA', 'shardC']]) {
        const shared = world({ peers });
        const stale = shared.runtime('shardA', 100000);
        const oldUnit = stale.creep('support', 'sHauler');
        oldUnit.memory.data.route = [{ shard: 'shardA', roomName: 'W1N1', x: 10, y: 10, destinationShard: 'shardC', destinationRoom: 'W3N3' }];
        oldUnit.memory.data.unitKind = 'hauler';
        oldUnit.memory.data.phase = 'return';
        oldUnit.memory.customState = { revision: 'stale-A-to-C' };
        assert.equal(stale.api.publishCreepTransfer(oldUnit, 'shardC', 1), true);
        assert.equal(stale.api.flushInterShardMemory(), true);
        const oldId = Object.keys(stale.api.getLocalShardState().transfers)[0];

        shared.clock.now += 100;
        const current = shared.runtime('shardB', 7);
        const currentUnit = current.creep('support', 'sHauler', 1);
        currentUnit.memory.data.unitKind = 'hauler';
        currentUnit.memory.data.phase = 'outbound';
        currentUnit.memory.customState = { revision: 'current-B-to-C' };
        assert.equal(current.api.publishCreepTransfer(currentUnit, 'shardC', 2), true);
        assert.equal(current.api.flushInterShardMemory(), true);
        const currentId = Object.keys(current.api.getLocalShardState().transfers)[0];

        const destination = shared.runtime('shardC', 2);
        const arriving = destination.creep('support', 'sHauler');
        arriving.memory = {};
        assert.equal(destination.api.restoreArrivingCreeps(), 1);
        assert.equal(arriving.memory.customState.revision, 'current-B-to-C');
        assert.equal(arriving.memory.data.phase, 'outbound');
        assert.equal(arriving.memory.data.hopIndex, 2);
        assert.deepEqual(JSON.parse(JSON.stringify(arriving.memory.data.route)), shared.route);
        const acknowledgments = destination.api.getLocalShardState().acks;
        assert.equal(acknowledgments[currentId].toShard, 'shardB');
        assert.equal(acknowledgments[oldId], undefined, 'the stale snapshot must not claim acknowledgment of this arrival');
    }
});

test('cancelling a changed route persists removal of only that unit and mission while retaining other state', () => {
    const shared = world();
    shared.storage.shardA = JSON.stringify({ otherBot: { keep: ['中文', 'namespace'] }, ecbotShard: {
        version: 1, transfers: {}, acks: {}, reports: { keep: { state: 'active' } }, extension: { preserve: true },
    } });
    const source = shared.runtime('shardA');
    const unit = source.creep('support', 'sHauler');
    const originalMemory = JSON.parse(JSON.stringify(unit.memory));
    assert.equal(source.api.publishCreepTransfer(unit, 'shardB', 1), true);
    unit.memory.data.route = [
        shared.route[0],
        { shard: 'shardB', roomName: 'W2N2', x: 20, y: 20, destinationShard: 'shardA', destinationRoom: 'W1N1' },
        { shard: 'shardA', roomName: 'W1N1', x: 30, y: 30, destinationShard: 'shardC', destinationRoom: 'W3N3' },
    ];
    unit.memory.data.hopIndex = 2;
    assert.equal(source.api.publishCreepTransfer(unit, 'shardC', 3), true);
    unit.memory = JSON.parse(JSON.stringify(originalMemory));
    unit.memory.data.missionId = 'another-mission';
    assert.equal(source.api.publishCreepTransfer(unit, 'shardB', 1), true);
    const another = source.creep('other-support', 'sHauler');
    assert.equal(source.api.publishCreepTransfer(another, 'shardB', 1), true);
    const local = source.api.getLocalShardState();
    const ack = { id: 'retained-ack', fromShard: 'shardA', toShard: 'shardB', creepName: 'other-unit', createdAt: shared.clock.now, expiresAt: shared.clock.now + 10000 };
    local.acks[ack.id] = ack;
    source.api.markShardStateDirty();
    assert.equal(source.api.flushInterShardMemory(), true);
    assert.equal(Object.keys(JSON.parse(shared.storage.shardA).ecbotShard.transfers).length, 4);

    unit.memory = JSON.parse(JSON.stringify(originalMemory));
    source.api.cancelCreepTransfers(unit);
    assert.equal(Object.keys(local.transfers).length, 2);
    assert.equal(Object.values(local.transfers).some(transfer => transfer.creepName === unit.name && transfer.missionId === 'mission'), false);
    assert.equal(Object.values(local.transfers).some(transfer => transfer.creepName === unit.name && transfer.missionId === 'another-mission'), true);
    assert.equal(Object.values(local.transfers).some(transfer => transfer.creepName === another.name && transfer.missionId === 'mission'), true);
    assert.equal(Object.keys(JSON.parse(shared.storage.shardA).ecbotShard.transfers).length, 4, 'cancellation marks the tick cache dirty before its scheduled flush');
    assert.equal(source.api.flushInterShardMemory(), true);
    const persisted = JSON.parse(shared.storage.shardA);
    assert.equal(Object.keys(persisted.ecbotShard.transfers).length, 2);
    assert.deepEqual(persisted.ecbotShard.acks, { [ack.id]: ack });
    assert.deepEqual(persisted.ecbotShard.reports, { keep: { state: 'active' } });
    assert.deepEqual(persisted.ecbotShard.extension, { preserve: true });
    assert.deepEqual(persisted.otherBot, { keep: ['中文', 'namespace'] });
});

test('capacity refuses additional pending transfers and UTF-8 overflow prevents portal entry', () => {
    const shared = world({ maximumTransfers: 1 }); const source = shared.runtime('shardA');
    const first = source.creep('first'); const second = source.creep('second');
    assert.equal(source.api.publishCreepTransfer(first, 'shardB', 1), true);
    assert.equal(source.api.publishCreepTransfer(second, 'shardB', 1), false);
    assert.equal(Object.keys(source.api.getLocalShardState().transfers).length, 1);
    source.api.flushInterShardMemory();
    shared.clock.now += shared.policy.transferTtl + 1; source.game.time++;
    assert.equal(source.api.publishCreepTransfer(second, 'shardB', 1), true, 'expired transfer frees capacity');

    const overflow = world({ maximumBytes: 500 });
    overflow.storage.shardA = JSON.stringify({ other: '中'.repeat(150) });
    const blocked = overflow.runtime('shardA'); const unit = blocked.creep(); blocked.portal(0);
    assert.equal(blocked.travel.travelPortalRoute(unit, unit.memory.data).status, 'waiting');
    assert.deepEqual(blocked.moves, []);
    assert.equal(overflow.writes.length, 0);
    assert.equal(blocked.api.serializedByteLength('中🚀'), Buffer.byteLength('中🚀', 'utf8'));
});

test('portal travel flushes the memory envelope one source tick before moving onto the exact portal', () => {
    const shared = world(); const source = shared.runtime('shardA'); const unit = source.creep(); source.portal(0);
    assert.equal(source.travel.travelPortalRoute(unit, unit.memory.data).status, 'waiting');
    assert.equal(shared.writes.length, 1);
    assert.equal(unit.memory.data.hopIndex, 0);
    assert.deepEqual(source.moves, []);
    assert.equal(source.travel.travelPortalRoute(unit, unit.memory.data).status, 'waiting');
    assert.deepEqual(source.moves, []);
    source.game.time++;
    assert.equal(source.travel.travelPortalRoute(unit, unit.memory.data).status, 'moving');
    assert.deepEqual(JSON.parse(JSON.stringify(source.moves)), [{ x: 10, y: 10, roomName: 'W1N1', options: { range: 0 } }]);
});

test('multi-hop recovery advances forward and never reenters the previous shard portal', () => {
    const shared = world(); const source = shared.runtime('shardA'); const unit = source.creep();
    source.api.publishCreepTransfer(unit, 'shardB', 1); source.api.flushInterShardMemory();
    const middle = shared.runtime('shardB', 50); const arriving = middle.creep(); arriving.memory = {};
    middle.api.restoreArrivingCreeps(); middle.api.flushInterShardMemory(); middle.portal(1);
    arriving.pos.x = 19; arriving.pos.y = 20;
    assert.equal(middle.travel.travelPortalRoute(arriving, arriving.memory.data).status, 'waiting');
    middle.game.time++;
    assert.equal(middle.travel.travelPortalRoute(arriving, arriving.memory.data).status, 'moving');
    assert.equal(middle.moves[0].x, 20);
    assert.equal(middle.moves[0].roomName, 'W2N2');
    assert.equal(arriving.memory.data.hopIndex, 1);
    const final = shared.runtime('shardC', 2); const landed = final.creep(); landed.memory = {};
    assert.equal(final.api.restoreArrivingCreeps(), 1);
    assert.equal(landed.memory.data.hopIndex, 2);
    assert.equal(final.travel.travelPortalRoute(landed, landed.memory.data).status, 'arrived');
    assert.deepEqual(final.moves, []);
});

test('missing or mismatched explicit portals wait or report errors without selecting alternate portals', () => {
    const shared = world(); const source = shared.runtime('shardA'); const unit = source.creep();
    source.game.rooms.W1N1 = { lookForAt: () => [] };
    assert.equal(source.travel.travelPortalRoute(unit, unit.memory.data).status, 'waiting');
    source.portal(0, { shard: 'shardC', room: 'W3N3' });
    assert.equal(source.travel.travelPortalRoute(unit, unit.memory.data).status, 'error');
    source.portal(0, { shard: 'shardB', room: 'wrongRoom' });
    assert.equal(source.travel.travelPortalRoute(unit, unit.memory.data).status, 'error');
    assert.deepEqual(source.moves, []);
    assert.equal(shared.writes.length, 0);
});

test('unavailable InterShardMemory leaves a supported creep outside the portal', () => {
    const shared = world(); const source = shared.runtime('shardA', 1, false); const unit = source.creep(); source.portal(0);
    assert.equal(source.travel.travelPortalRoute(unit, unit.memory.data).status, 'waiting');
    assert.deepEqual(source.moves, []);
});

test('mission state is copied while source-only transfer preparation markers are cleared on arrival', () => {
    const shared = world(); const source = shared.runtime('shardA'); const unit = source.creep();
    Object.assign(unit.memory.data, { phase: 'delivery', pendingDelivery: 150, transferPreparedAt: 1, transferPreparedHop: 0, transferPreparedShard: 'shardA' });
    source.api.publishCreepTransfer(unit, 'shardB', 1); source.api.flushInterShardMemory();
    const target = shared.runtime('shardB'); const arriving = target.creep(); arriving.memory = {};
    target.api.restoreArrivingCreeps();
    assert.equal(arriving.memory.data.phase, 'delivery');
    assert.equal(arriving.memory.data.pendingDelivery, 150);
    assert.equal(arriving.memory.data.unitKind, 'builder');
    assert.equal(arriving.memory.data.transferPreparedAt, undefined);
    assert.equal(arriving.memory.data.transferPreparedHop, undefined);
    assert.equal(arriving.memory.data.transferPreparedShard, undefined);
    assert.equal(unit.memory.data.transferPreparedAt, 1, 'publishing keeps local travel state unchanged');
});

test('a later journey through the same hop receives a new transfer ID and survives its previous acknowledgment', () => {
    const shared = world(); const source = shared.runtime('shardA'); const unit = source.creep();
    source.api.publishCreepTransfer(unit, 'shardB', 1); source.api.flushInterShardMemory();
    const firstId = Object.keys(source.api.getLocalShardState().transfers)[0];
    const target = shared.runtime('shardB'); const arriving = target.creep(); arriving.memory = {};
    target.api.restoreArrivingCreeps(); target.api.flushInterShardMemory();
    source.game.time++; source.api.flushInterShardMemory();
    assert.deepEqual(Object.keys(source.api.getLocalShardState().transfers), []);
    shared.clock.now++; source.game.time++;
    assert.equal(source.api.publishCreepTransfer(unit, 'shardB', 1), true);
    assert.equal(source.api.flushInterShardMemory(), true);
    const secondId = Object.keys(source.api.getLocalShardState().transfers)[0];
    assert.notEqual(secondId, firstId);
    assert.equal(Object.keys(JSON.parse(shared.storage.shardA).ecbotShard.transfers).length, 1);
});

test('acknowledgment capacity and wall-clock expiry prune owned records without touching reports', () => {
    const shared = world({ maximumAcks: 2 });
    const ack = (id, createdAt, expiresAt) => ({ id, fromShard: 'shardA', toShard: 'shardB', creepName: id, createdAt, expiresAt });
    shared.storage.shardA = JSON.stringify({ ecbotShard: {
        version: 1, transfers: {},
        acks: { expired: ack('expired', 1, shared.clock.now - 1), oldest: ack('oldest', 2, shared.clock.now + 100), middle: ack('middle', 3, shared.clock.now + 100), newest: ack('newest', 4, shared.clock.now + 100) },
        reports: { mission: { keep: true } }
    } });
    const source = shared.runtime('shardA', 99999);
    source.api.flushInterShardMemory();
    const stored = JSON.parse(shared.storage.shardA).ecbotShard;
    assert.deepEqual(Object.keys(stored.acks).sort(), ['middle', 'newest']);
    assert.deepEqual(stored.reports, { mission: { keep: true } });
    shared.clock.now += 101; source.game.time++;
    source.api.flushInterShardMemory();
    assert.deepEqual(Object.keys(JSON.parse(shared.storage.shardA).ecbotShard.acks), []);
});

test('arrival peer expansion works for a private shard and idle recovery avoids unnecessary remote reads', () => {
    const shared = world({ peers: [] }); const source = shared.runtime('shardA'); const unit = source.creep();
    source.api.publishCreepTransfer(unit, 'shardB', 1); source.api.flushInterShardMemory();
    const target = shared.runtime('shardB');
    target.api.restoreArrivingCreeps(['shardA']);
    assert.equal(shared.reads.filter(read => read === 'shardB:shardA').length, 0, 'no orphan arrival means no remote scan');
    const arriving = target.creep(); arriving.memory = {};
    assert.equal(target.api.restoreArrivingCreeps(), 0);
    assert.equal(target.api.restoreArrivingCreeps(['shardA']), 1);
    assert.equal(shared.reads.filter(read => read === 'shardB:shardA').length, 1);
});

test('a failed InterShardMemory write prevents the portal move and preserves the original string', () => {
    const shared = world(); shared.storage.shardA = JSON.stringify({ other: { keep: true } });
    const source = shared.runtime('shardA'); const unit = source.creep(); source.portal(0);
    source.interShardMemory.setLocal = () => { throw new Error('storage unavailable'); };
    assert.equal(source.travel.travelPortalRoute(unit, unit.memory.data).status, 'waiting');
    assert.deepEqual(source.moves, []);
    assert.deepEqual(JSON.parse(shared.storage.shardA), { other: { keep: true } });
    assert.match(source.api.getShardTransportError(), /storage unavailable/);
    assert.equal(unit.memory.data.transferPreparedAt, undefined);
});
