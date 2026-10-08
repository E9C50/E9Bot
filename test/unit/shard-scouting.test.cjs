const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

const copy = value => JSON.parse(JSON.stringify(value));

function world({ roundTrip = false, claim = false, policy = {} } = {}) {
    const clock = { now: 1000000 };
    const game = { shard: { name: 'shardA' }, time: 100, rooms: {}, creeps: {} };
    const route = [{ shard: 'shardA', roomName: 'W0N0', x: 10, y: 10, destinationShard: 'shardB', destinationRoom: 'W20N20' }];
    const returnRoute = [{ shard: 'shardB', roomName: 'W20N20', x: 20, y: 20, destinationShard: 'shardA', destinationRoom: 'W0N0' }];
    const task = { id: 'm1', key: 'shardA:m1', sourceShard: 'shardA', sourceRoom: 'W1N1', targetShard: 'shardB', targetRoom: 'W2N2',
        route: copy(route), ...(roundTrip ? { returnRoute: copy(returnRoute) } : {}), claim, builders: 0, haulers: 1,
        targetLevel: 4, energyAmount: 0, homeEnergyReserve: 10000 };
    const data = { task, unitKind: 'scout', missionId: task.key, originShard: 'shardA', route: copy(route), hopIndex: 0, phase: 'outbound',
        scouting: { revision: 'rev1', outboundRoute: copy(route), ...(roundTrip ? { returnRoute: copy(returnRoute) } : {}), leg: 'outbound', elapsedTicks: 0 } };
    const memory = { shardMissions: { [task.key]: { state: 'active', scouting: { revision: 'rev1' } } } };
    const remote = { reports: { [task.key]: { type: 'command', state: 'active', scoutRevision: 'rev1' } } };
    const local = { version: 1, transfers: {}, acks: {}, reports: { unrelated: { preserve: true } }, custom: { preserve: true } };
    const transport = { succeed: true, dirty: 0, attempts: 0, committed: [] };
    const travel = { result: undefined, calls: [] };
    const moves = [], hostiles = [], hostileStructures = [];
    const config = { enabled: true, routeScouting: { enabled: true, stuckTicks: 25, maximumLegTicks: 1400,
        minimumRemainingTicks: 10, proofMaxAge: 1200000, maximumProofs: 80, ...policy } };
    class Position {
        constructor(x, y, roomName) { this.x = x; this.y = y; this.roomName = roomName; }
    }
    class ClockDate extends Date { static now() { return clock.now; } }
    const creep = { name: 'scout-unique', memory: { role: 'sScout', data }, owner: { username: 'me' }, spawning: false,
        hits: 100, hitsMax: 100, fatigue: 0, ticksToLive: 1450,
        moveTo(pos, options) { moves.push({ ...pos, options }); return creep.moveResult ?? 0; }
    };
    for (const action of ['claimController', 'reserveController', 'build', 'harvest', 'withdraw', 'transfer']) {
        creep[action] = () => { throw new Error(`Scout must never perform ${action}`); };
    }
    function place(shard, roomName, tick = game.time) {
        game.shard.name = shard; game.time = tick;
        creep.pos = new Position(25, 25, roomName);
        creep.room = { name: roomName, controller: { my: false },
            find(type) { return type === 'hostile-creeps' ? hostiles : hostileStructures; } };
        return creep;
    }
    place('shardA', task.sourceRoom);
    const loader = createSourceLoader({ globals: { Game: game, Memory: memory, Date: ClockDate, RoomPosition: Position,
        FIND_HOSTILE_CREEPS: 'hostile-creeps', FIND_HOSTILE_STRUCTURES: 'hostile-structures', ATTACK: 'attack', RANGED_ATTACK: 'ranged_attack',
        STRUCTURE_TOWER: 'tower', RESOURCE_ENERGY: 'energy', TOWER_ENERGY_COST: 10, OK: 0, ERR_NO_PATH: -2, ERR_TIRED: -11 },
        modules: {
            'settings/interShard': { interShardPolicy: config },
            './transport': {
                getLocalShardState: () => local, readRemoteShardState: () => remote, markShardStateDirty: () => transport.dirty++,
                getShardTransportError: () => 'publish unavailable',
                flushInterShardMemory() { transport.attempts++; if (!transport.succeed) return false; transport.committed.push(copy(local)); return true; }
            },
            './travel': { travelPortalRoute(unit, current) { travel.calls.push({ unit, data: copy(current) });
                return travel.result || { status: current.hopIndex === current.route.length ? 'arrived' : 'moving' }; } }
        }
    });
    const proof = loader.load('shard/scoutProof'), scouting = loader.load('shard/scouting');
    const role = scouting.createShardScoutRole(data);
    function arrive(shard = task.targetShard, roomName = task.targetRoom, tick = 5) {
        place(shard, roomName, tick); data.hopIndex = data.route.length;
    }
    return { clock, game, task, route, returnRoute, data, memory, remote, local, transport, travel, config, creep, moves,
        hostiles, hostileStructures, place, arrive, loader, proof, scouting, role };
}

test('Scout modules import without accessing Game, Memory or InterShardMemory', () => {
    const loader = createSourceLoader({ modules: { 'settings/interShard': { interShardPolicy: {} } } });
    assert.doesNotThrow(() => loader.load('shard/scouting'));
    assert.doesNotThrow(() => loader.load('shard/scoutProof'));
});

test('Scout validates its own role and tolerates malformed progress without taking over an ordinary worker', () => {
    const w = world();
    w.creep.memory.role = 'sBuilder';
    assert.equal(w.role.prepare(w.creep), false); assert.equal(w.role.source(w.creep), false);
    w.creep.memory.role = 'sScout';
    for (const progress of [null, {}, { revision: 'r', leg: 'outbound', elapsedTicks: 0, outboundRoute: [], lastPosition: null },
        { revision: 'r', leg: 'outbound', elapsedTicks: 0, outboundRoute: [], proofPending: null }]) {
        w.data.scouting = progress;
        assert.equal(w.role.prepare(w.creep), false); assert.equal(w.role.source(w.creep), false);
    }
    assert.equal(w.travel.calls.length, 0); assert.equal(w.transport.attempts, 0);
});

test('Scout rejects a changed candidate route without silently replanning or publishing success', () => {
    const w = world(); w.data.route[0].x++;
    assert.equal(w.role.source(w.creep), false);
    assert.equal(w.travel.calls.length, 0);
    assert.equal(w.local.scoutProofs['shardA:m1:outbound'].result, 'failed');
    assert.deepEqual(copy(w.local.scoutProofs['shardA:m1:outbound'].route), w.data.scouting.outboundRoute);
    assert.equal(w.local.scoutProofs['shardA:m1:outbound'].failedHop, undefined);
});

test('landing on the destination shard is insufficient: Scout physically enters the precise target room', () => {
    const w = world(); w.arrive('shardB', 'W20N20');
    assert.equal(w.role.source(w.creep), false);
    assert.deepEqual(w.moves.map(move => [move.roomName, move.options.range]), [['W2N2', 20]]);
    assert.equal(w.local.scoutProofs, undefined);
    w.place('shardB', 'W2N2', 6);
    assert.equal(w.role.source(w.creep), true);
    const p = w.local.scoutProofs['shardA:m1:outbound'];
    assert.equal(p.result, 'verified'); assert.equal(p.shard, 'shardB'); assert.equal(p.roomName, 'W2N2');
    assert.equal(p.observation.controllerPresent, true); assert.equal(w.data.done, true);
    assert.deepEqual(w.local.reports, { unrelated: { preserve: true } });
});

test('a proof cannot certify a destination that differs from the actual Game shard or actual room', () => {
    const w = world();
    w.proof.reportScoutProof(w.data, w.creep, 'outbound', 'verified');
    assert.equal(w.local.scoutProofs, undefined); assert.equal(w.transport.attempts, 0);
    assert.equal(w.data.scouting.proofPending.result, 'verified');
    w.place('shardB', 'W20N20');
    w.proof.reportScoutProof(w.data, w.creep, 'outbound', 'verified');
    assert.equal(w.local.scoutProofs, undefined); assert.equal(w.transport.attempts, 0);
});

test('outbound and return proofs remain separate; switching legs clears the old transfer preparation', () => {
    const w = world({ roundTrip: true }); w.arrive();
    w.data.transferPreparedAt = 999; w.data.transferPreparedHop = 0; w.data.transferPreparedShard = 'shardA';
    assert.equal(w.role.source(w.creep), true);
    const outbound = copy(w.local.scoutProofs['shardA:m1:outbound']);
    assert.equal(w.data.scouting.leg, 'return'); assert.equal(w.data.originShard, 'shardB'); assert.equal(w.data.hopIndex, 0);
    assert.deepEqual(copy(w.data.route), w.returnRoute); assert.equal(w.data.transferPreparedAt, undefined);
    assert.equal(w.data.done, undefined);
    w.arrive('shardA', 'W1N1', 1000);
    assert.equal(w.role.target(w.creep), true);
    assert.equal(w.data.done, true); assert.equal(w.data.phase, 'done');
    assert.deepEqual(copy(w.local.scoutProofs['shardA:m1:outbound']), outbound);
    assert.equal(w.local.scoutProofs['shardA:m1:return'].result, 'verified');
    assert.equal(w.local.scoutProofs['shardA:m1:return'].shard, 'shardA');
});

test('Scout elapsed ticks use local shard deltas, never subtract unrelated shard tick counters', () => {
    const w = world({ roundTrip: true });
    w.game.time = 900000; w.role.source(w.creep);
    w.game.time += 7; w.role.source(w.creep);
    w.arrive('shardB', 'W2N2', 3); w.role.source(w.creep);
    assert.equal(w.local.scoutProofs['shardA:m1:outbound'].elapsedTicks, 8);
    w.game.time += 11; w.role.source(w.creep);
    w.arrive('shardA', 'W1N1', 900100); w.role.source(w.creep);
    assert.equal(w.local.scoutProofs['shardA:m1:return'].elapsedTicks, 12);
    assert.equal(w.data.scouting.elapsedTicks, 20);
});

test('failed publication preserves existing proof evidence and keeps outbound pending instead of starting return', () => {
    const w = world({ roundTrip: true });
    const old = { 'other:return': { updatedAt: w.clock.now, result: 'verified', keep: 'evidence' } };
    w.local.scoutProofs = old; w.transport.succeed = false; w.arrive();
    w.data.scouting.elapsedTicks = 18;
    assert.equal(w.role.source(w.creep), false);
    assert.equal(w.local.scoutProofs, old); assert.equal(w.data.scouting.leg, 'outbound'); assert.equal(w.data.done, undefined);
    assert.equal(w.data.scouting.proofPending.result, 'verified'); assert.equal(w.transport.committed.length, 0);
    w.game.time += 6; w.transport.succeed = true;
    assert.equal(w.role.source(w.creep), true);
    assert.equal(w.local.scoutProofs['shardA:m1:outbound'].elapsedTicks, 18);
    assert.equal(w.data.scouting.leg, 'return'); assert.equal(w.data.scouting.proofPending, undefined);
    assert.deepEqual(w.local.scoutProofs['other:return'], old['other:return']);
});

test('a full proof directory preserves every live entry and retries once an expired entry frees capacity', () => {
    const w = world({ policy: { maximumProofs: 2, proofMaxAge: 1000 } }); w.arrive();
    w.local.scoutProofs = { first: { updatedAt: w.clock.now - 900, keep: true }, second: { updatedAt: w.clock.now, keep: true } };
    const original = w.local.scoutProofs;
    w.proof.reportScoutProof(w.data, w.creep, 'outbound', 'verified');
    assert.equal(w.local.scoutProofs, original); assert.equal(w.transport.attempts, 0);
    assert.equal(w.data.scouting.proofPending.result, 'verified');
    w.clock.now += 200;
    w.proof.reportScoutProof(w.data, w.creep, 'outbound', 'verified');
    assert.equal(w.local.scoutProofs.first, undefined); assert.deepEqual(w.local.scoutProofs.second, original.second);
    assert.equal(Object.keys(w.local.scoutProofs).length, 2); assert.equal(w.data.scouting.proofPending, undefined);
});

test('pending success publication rechecks danger and target ownership before authorizing workers', () => {
    for (const change of ['armed', 'owner']) {
        const w = world({ roundTrip: true, claim: true }); w.arrive(); w.transport.succeed = false;
        w.role.source(w.creep); assert.equal(w.data.scouting.proofPending.result, 'verified');
        if (change === 'armed') w.hostiles.push({ getActiveBodyparts: () => 1 });
        else w.creep.room.controller.owner = { username: 'other' };
        w.transport.succeed = true; w.game.time++;
        w.role.source(w.creep);
        assert.equal(w.local.scoutProofs['shardA:m1:outbound'].result, 'failed');
        assert.equal(w.data.scouting.leg, 'outbound'); assert.equal(w.data.done, true);
    }
});

test('bad proof namespace remains intact instead of being overwritten', () => {
    for (const bad of [null, [], 'broken']) {
        const w = world(); w.arrive(); w.local.scoutProofs = bad;
        w.proof.reportScoutProof(w.data, w.creep, 'outbound', 'verified');
        assert.equal(w.local.scoutProofs, bad); assert.equal(w.transport.attempts, 0);
        assert.equal(w.data.scouting.proofPending.result, 'verified');
    }
});

test('Portal disappearance, destination mismatch and no-path produce failed evidence for the exact current entry', () => {
    for (const reason of ['portal-missing', 'portal-destination', 'no-path']) {
        const w = world(); w.travel.result = { status: 'waiting', reason, message: reason };
        assert.equal(w.role.source(w.creep), false);
        const p = w.local.scoutProofs['shardA:m1:outbound'];
        assert.equal(p.result, 'failed'); assert.equal(p.message, reason); assert.equal(p.shard, 'shardA');
        assert.deepEqual(copy(p.failedHop), w.route[0]); assert.equal(w.data.done, true);
    }
});

test('ordinary transfer propagation waiting does not falsely fail the route', () => {
    const w = world(); w.travel.result = { status: 'waiting', message: 'waiting one source tick' };
    assert.equal(w.role.source(w.creep), false);
    w.game.time++; assert.equal(w.role.source(w.creep), false);
    assert.equal(w.local.scoutProofs, undefined); assert.equal(w.data.done, undefined);
});

test('no path from the landing room identifies the final Portal instead of certifying an unreachable endpoint', () => {
    const w = world(); w.arrive('shardB', 'W20N20'); w.creep.moveResult = -2;
    assert.equal(w.role.source(w.creep), false);
    const p = w.local.scoutProofs['shardA:m1:outbound'];
    assert.equal(p.result, 'failed'); assert.deepEqual(copy(p.failedHop), w.route[0]);
    assert.equal(p.roomName, 'W20N20'); assert.equal(w.data.routeIssue.updatedAt, w.clock.now);
});

test('stationary unfatigued Scout stops at the configured threshold, while fatigue does not count as a blocked route', () => {
    const w = world({ policy: { stuckTicks: 3 } });
    w.role.source(w.creep); w.creep.fatigue = 5; w.game.time += 3; w.role.source(w.creep);
    assert.equal(w.local.scoutProofs, undefined);
    w.creep.fatigue = 0; w.game.time += 3; w.role.source(w.creep);
    assert.equal(w.local.scoutProofs['shardA:m1:outbound'].result, 'failed');
    assert.match(w.data.lastError, /同一位置/);
});

test('Scout refuses damage, hostile active attack parts, or an active energized hostile Tower', () => {
    const hazards = [w => { w.creep.hits--; }, w => w.hostiles.push({ getActiveBodyparts: type => type === 'attack' ? 1 : 0 }),
        w => w.hostiles.push({ getActiveBodyparts: type => type === 'ranged_attack' ? 1 : 0 }),
        w => w.hostileStructures.push({ structureType: 'tower', my: false, isActive: () => true, store: { energy: 10 } })];
    for (const hazard of hazards) {
        const w = world(); hazard(w); w.role.source(w.creep);
        assert.equal(w.travel.calls.length, 0); assert.equal(w.local.scoutProofs['shardA:m1:outbound'].result, 'failed');
    }
    const safe = world();
    safe.hostiles.push({ getActiveBodyparts: () => 0 });
    safe.hostileStructures.push({ structureType: 'tower', my: false, isActive: () => false, store: { energy: 100 } },
        { structureType: 'tower', my: false, isActive: () => true, store: { energy: 9 } },
        { structureType: 'tower', my: true, isActive: () => true, store: { energy: 100 } });
    safe.role.source(safe.creep); assert.equal(safe.travel.calls.length, 1); assert.equal(safe.local.scoutProofs, undefined);
});

test('insufficient lifetime or excessive local journey ticks produces failed evidence', () => {
    for (const age of ['lifetime', 'journey']) {
        const w = world();
        if (age === 'lifetime') w.creep.ticksToLive = 9;
        else w.data.scouting.elapsedTicks = 1401;
        w.role.source(w.creep);
        assert.equal(w.travel.calls.length, 0); assert.equal(w.local.scoutProofs['shardA:m1:outbound'].result, 'failed');
    }
});

test('paused commands stop travel, cancelled or revised commands retire the scout without publishing obsolete pending evidence', () => {
    const paused = world(); paused.remote.reports[paused.task.key].state = 'paused'; paused.place('shardB', 'W20N20');
    paused.role.source(paused.creep); assert.equal(paused.travel.calls.length, 0); assert.equal(paused.data.done, undefined);
    for (const change of ['cancelled', 'revision']) {
        const w = world(); w.place('shardB', 'W2N2');
        w.data.scouting.proofPending = { leg: 'outbound', result: 'verified' };
        if (change === 'cancelled') w.remote.reports[w.task.key].state = 'cancelled';
        else w.remote.reports[w.task.key].scoutRevision = 'new-revision';
        w.role.source(w.creep);
        assert.equal(w.data.done, true); assert.equal(w.data.scouting.proofPending, undefined);
        assert.equal(w.role.prepare(w.creep), false); assert.equal(w.transport.attempts, 0); assert.equal(w.travel.calls.length, 0);
    }
});

test('local scouts finish after their removed mission leaves a persistent terminal command', () => {
    for (const state of ['complete', 'cancelled']) {
        const w = world();
        delete w.memory.shardMissions[w.task.key];
        w.memory.shardMissionStops = { [w.task.key]: { state, updatedAt: w.clock.now,
            expiresAt: w.clock.now + 1200000, published: false } };
        w.local.reports[w.task.key] = { type: 'command', state: 'active', scoutRevision: 'rev1' };
        w.data.transferPreparedAt = w.game.time;
        w.data.scouting.proofPending = { leg: 'outbound', result: 'verified' };
        w.role.source(w.creep);
        assert.equal(w.data.done, true); assert.equal(w.data.phase, 'done');
        assert.equal(w.data.transferPreparedAt, undefined); assert.equal(w.data.scouting.proofPending, undefined);
        assert.equal(w.travel.calls.length, 0); assert.equal(w.transport.attempts, 0);
    }
});

test('claiming Scout reports incompatible target controller ownership with actual observation; owned or friendly reservation passes', () => {
    const controllers = [undefined, { my: false, owner: { username: 'other' } }, { my: false, reservation: { username: 'other' } }];
    for (const controller of controllers) {
        const w = world({ claim: true }); w.arrive(); w.creep.room.controller = controller;
        w.role.source(w.creep);
        const p = w.local.scoutProofs['shardA:m1:outbound'];
        assert.equal(p.result, 'failed'); assert.equal(p.observation.controllerPresent, controller !== undefined);
        assert.equal(p.failedHop, undefined);
        if (controller?.owner) assert.equal(p.observation.owner, 'other');
        if (controller?.reservation) assert.equal(p.observation.reservation, 'other');
    }
    for (const controller of [{ my: true, owner: { username: 'me' } }, { my: false, reservation: { username: 'me' } }, { my: false }]) {
        const w = world({ claim: true }); w.arrive(); w.creep.room.controller = controller;
        w.role.source(w.creep); assert.equal(w.local.scoutProofs['shardA:m1:outbound'].result, 'verified');
    }
});

test('failed proof publication remains retryable instead of marking the scout done before its source receives the failure', () => {
    const w = world(); w.transport.succeed = false; w.travel.result = { status: 'waiting', reason: 'portal-missing', message: 'missing' };
    w.role.source(w.creep); assert.equal(w.data.done, undefined); assert.equal(w.data.scouting.proofPending.result, 'failed');
    assert.equal(w.local.scoutProofs, undefined);
    w.transport.succeed = true; w.game.time++; w.role.source(w.creep);
    assert.equal(w.data.done, true); assert.equal(w.local.scoutProofs['shardA:m1:outbound'].result, 'failed');
    assert.equal(w.travel.calls.length, 1);
});
