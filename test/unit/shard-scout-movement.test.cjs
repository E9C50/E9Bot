const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

const copy = value => JSON.parse(JSON.stringify(value));
const expectedOptions = range => ({ ignoreSwamps: true, plainCost: 1, swampCost: 1, range });

function portalWorld(role = 'sScout') {
    const calls = [], moves = [];
    const game = { shard: { name: 'shard3' }, time: 100, rooms: {} };
    class Position {
        constructor(x, y, roomName) { Object.assign(this, { x, y, roomName }); }
        getRangeTo(other) { return Math.max(Math.abs(this.x - other.x), Math.abs(this.y - other.y)); }
    }
    const hop = { shard: 'shard3', roomName: 'W0N0', x: 10, y: 10, destinationShard: 'shard2', destinationRoom: 'E0S0' };
    const data = { missionId: 'mission', originShard: 'shard3', route: [hop], hopIndex: 0 };
    const creep = { name: 'unit', memory: { role, data }, pos: new Position(25, 25, 'W0N0'),
        moveTo(pos, options) { moves.push({ ...pos, options: copy(options) }); return 0; } };
    game.rooms.W0N0 = { lookForAt() { return [{ structureType: 'portal', destination: { shard: 'shard2', room: 'E0S0' } }]; } };
    const transport = { publish: true, flush: true };
    const loader = createSourceLoader({ globals: { Game: game, RoomPosition: Position, LOOK_STRUCTURES: 'structures',
        STRUCTURE_PORTAL: 'portal', OK: 0, ERR_NO_PATH: -2, ERR_TIRED: -11 }, modules: {
        'settings/interShard': { interShardPolicy: { enabled: true, allowedRoles: ['sScout', 'sClaimer', 'sBuilder', 'sHauler'] } },
        './transport': {
            publishCreepTransfer(unit, destination, nextHop) { calls.push({ type: 'publish', name: unit.name, destination, nextHop }); return transport.publish; },
            flushInterShardMemory() { calls.push({ type: 'flush' }); return transport.flush; },
            getShardTransportError: () => 'write failed',
        },
    } });
    return { travel: loader.load('shard/travel'), game, creep, data, calls, moves, transport, Position };
}

test('scout movement options import without Game and isolate their BetterMove cache from ordinary movement', () => {
    const loader = createSourceLoader();
    const options = loader.load('shard/scoutMovement').scoutMovementOptions;
    assert.equal(loader.globals.Game, undefined);
    assert.deepEqual(copy(options), { ignoreSwamps: true, plainCost: 1, swampCost: 1 });
});

test('portal scouts use equal terrain costs and still target the entrance tile with range zero', () => {
    const w = portalWorld();
    assert.equal(w.travel.travelPortalRoute(w.creep, w.data).status, 'moving');
    assert.deepEqual(w.moves, [{ x: 10, y: 10, roomName: 'W0N0', options: expectedOptions(0) }]);
    assert.deepEqual(w.calls, [], 'distant scouts must not prepare a crossing before reaching the portal');
});

test('portal workers retain their normal terrain strategy instead of inheriting scout-only options', () => {
    for (const role of ['sClaimer', 'sBuilder', 'sHauler']) {
        const w = portalWorld(role);
        assert.equal(w.travel.travelPortalRoute(w.creep, w.data).status, 'moving');
        assert.deepEqual(w.moves[0].options, { range: 0 }, role);
    }
});

test('scout terrain optimization preserves durable transfer publication and the source-tick crossing delay', () => {
    const w = portalWorld(); w.creep.pos = new w.Position(9, 10, 'W0N0');
    assert.equal(w.travel.travelPortalRoute(w.creep, w.data).status, 'waiting');
    assert.equal(w.data.transferPreparedAt, 100); assert.equal(w.moves.length, 0);
    assert.deepEqual(w.calls.slice(0, 2), [{ type: 'publish', name: 'unit', destination: 'shard2', nextHop: 1 }, { type: 'flush' }]);
    assert.equal(w.travel.travelPortalRoute(w.creep, w.data).status, 'waiting');
    assert.equal(w.moves.length, 0);
    w.game.time++;
    assert.equal(w.travel.travelPortalRoute(w.creep, w.data).status, 'moving');
    assert.deepEqual(w.moves[0].options, expectedOptions(0));
    const failed = portalWorld(); failed.creep.pos = new failed.Position(9, 10, 'W0N0'); failed.transport.flush = false;
    assert.equal(failed.travel.travelPortalRoute(failed.creep, failed.data).status, 'waiting');
    assert.equal(failed.moves.length, 0); assert.equal(failed.data.transferPreparedAt, undefined);
});

test('verification scouts use the same terrain strategy while walking from their landing room to the task endpoint', () => {
    const moves = [];
    const hop = { shard: 'shard3', roomName: 'W0N0', x: 10, y: 10, destinationShard: 'shard2', destinationRoom: 'E0S0' };
    const task = { key: 'mission', sourceShard: 'shard3', sourceRoom: 'W1N1', targetShard: 'shard2', targetRoom: 'E2S2',
        route: [hop], claim: false, builders: 1, haulers: 0, targetLevel: 4, energyAmount: 0, homeEnergyReserve: 0 };
    const data = { missionId: task.key, task, originShard: 'shard3', route: [hop], hopIndex: 1, unitKind: 'scout', phase: 'outbound',
        scouting: { revision: 'revision', leg: 'outbound', outboundRoute: [hop], elapsedTicks: 0 } };
    class Position { constructor(x, y, roomName) { Object.assign(this, { x, y, roomName }); } }
    const game = { shard: { name: 'shard2' }, time: 100 };
    const creep = { name: 'verifier', memory: { role: 'sScout', data }, room: { name: 'E0S0', find: () => [] },
        pos: new Position(25, 25, 'E0S0'), hits: 100, hitsMax: 100, ticksToLive: 1400, fatigue: 0,
        moveTo(pos, options) { moves.push({ ...pos, options: copy(options) }); return 0; } };
    const loader = createSourceLoader({ globals: { Game: game, Memory: {}, RoomPosition: Position,
        FIND_HOSTILE_CREEPS: 'hostile-creeps', FIND_HOSTILE_STRUCTURES: 'hostile-structures', OK: 0, ERR_NO_PATH: -2, ERR_TIRED: -11 }, modules: {
        'settings/interShard': { interShardPolicy: { enabled: true, routeScouting: { enabled: true, maximumLegTicks: 1400, minimumRemainingTicks: 10, stuckTicks: 25 } } },
        './transport': { readRemoteShardState: () => ({ reports: { mission: { state: 'active', scoutRevision: 'revision' } } }) },
        './scoutProof': { sameScoutRoute: (first, second) => JSON.stringify(first) === JSON.stringify(second),
            reportScoutProof() { throw new Error('The landing room is not the verified task endpoint'); } },
        './travel': { travelPortalRoute: () => ({ status: 'arrived' }) },
        './exploration': { createPortalExplorerRole() { throw new Error('Verification scouts are not portal explorers'); } },
    } });
    const role = loader.load('shard/scouting').createShardScoutRole(data);
    assert.equal(role.source(creep), false);
    assert.deepEqual(moves, [{ x: 25, y: 25, roomName: 'E2S2', options: expectedOptions(20) }]);
    assert.equal(data.done, undefined);
});
