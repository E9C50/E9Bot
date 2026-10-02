const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const copy = value => JSON.parse(JSON.stringify(value));

function world() {
    const game = { time: 100, shard: { name: 'shard3' }, rooms: {}, spawns: {},
        cpu: { bucket: 10000, tickLimit: 100, getUsed: () => 0 },
        map: { getRoomTerrain: () => ({ get: (x, y) => walls.has(`${x}/${y}`) ? 1 : 0 }) } };
    const walls = new Set(), tiles = new Map(), hostiles = [], structures = [], moves = [], nativeMoves = [], proofs = [], travel = [], planning = [];
    const first = { shard: 'shard3', roomName: 'E40N0', x: 10, y: 10, destinationShard: 'shard2', destinationRoom: 'E0N0' };
    const second = { shard: 'shard2', roomName: 'E0N0', x: 20, y: 20, destinationShard: 'shard1', destinationRoom: 'E1N1' };
    const task = { id: 'border', key: 'shard3:border', sourceShard: 'shard3', sourceRoom: 'E40N7', targetShard: 'shard1', targetRoom: 'E1N1',
        autoRoute: true, route: [], claim: true, builders: 1, haulers: 0, targetLevel: 4, energyAmount: 0, homeEnergyReserve: 10000 };
    const progress = { revision: 'explore-1', goalShard: task.targetShard, goalRoom: task.targetRoom, stage: 'outbound',
        startedAt: Date.now(), elapsedTicks: 0, visitedRooms: [], visitedShards: [], selectedPortalHop: 0 };
    const data = { missionId: task.key, task, unitKind: 'scout', originShard: 'shard3', route: [copy(first)], hopIndex: 0, phase: 'outbound', exploration: progress };
    const mission = { state: 'active', leases: {}, exploration: { revision: progress.revision, status: 'exploring' }, scouting: { revision: 'verify-1' } };
    const local = { version: 1, transfers: {}, acks: {}, reports: {}, scoutProofs: {} };
    const config = { enabled: true, scoutSafety: { meleeThreatRange: 2, rangedThreatRange: 4 }, portalDiscovery: { enabled: true },
        portalExploration: { enabled: true, minimumBucket: 1000, minimumCpuHeadroom: 10, maximumPlanningCpu: 5, maximumVisitedRooms: 128,
            maximumSearchTicks: 1200, minimumRemainingTicks: 50, stuckTicks: 25, roomTimeout: 150, blockedRoomTtl: 300000,
            maximumAge: 1800000, reportInterval: 10, reportTtl: 1200000, maximumReports: 80 },
        routeScouting: { enabled: true, maximumLegTicks: 1200, minimumRemainingTicks: 50, stuckTicks: 25 } };
    class Position { constructor(x, y, roomName) { this.x = x; this.y = y; this.roomName = roomName; } }
    const creep = { name: 'border-scout', memory: { role: 'sScout', data }, hits: 100, hitsMax: 100, fatigue: 0, ticksToLive: 1400,
        owner: { username: 'me' }, spawning: false,
        moveTo(pos, options) { moves.push({ ...pos, options }); return 0; },
        move(direction) { nativeMoves.push(direction); return 0; } };
    function place(roomName, x = 25, y = 0, shard = game.shard.name) {
        game.shard.name = shard; creep.pos = new Position(x, y, roomName);
        creep.room = { name: roomName, controller: { my: false },
            find: type => (type === 'hostile-creeps' ? hostiles : structures).filter(value => !value.pos || value.pos.roomName === roomName),
            lookForAt: (type, px, py) => tiles.get(`${type}/${px}/${py}`) || [] };
        game.rooms = { [roomName]: creep.room };
    }
    place('E40N6');
    const loader = createSourceLoader({ globals: { Game: game, Memory: { shardMissions: { [task.key]: mission } }, RoomPosition: Position,
        OK: 0, ERR_NO_PATH: -2, ERR_TIRED: -11, ERR_NOT_IN_RANGE: -9,
        FIND_HOSTILE_CREEPS: 'hostile-creeps', FIND_HOSTILE_STRUCTURES: 'hostile-structures', ATTACK: 'attack', RANGED_ATTACK: 'ranged_attack',
        STRUCTURE_TOWER: 'tower', STRUCTURE_PORTAL: 'portal', STRUCTURE_RAMPART: 'rampart', RESOURCE_ENERGY: 'energy', TOWER_ENERGY_COST: 10,
        TOP: 1, TOP_RIGHT: 2, RIGHT: 3, BOTTOM_RIGHT: 4, BOTTOM: 5, BOTTOM_LEFT: 6, LEFT: 7, TOP_LEFT: 8,
        TERRAIN_MASK_WALL: 1, LOOK_STRUCTURES: 'structures', LOOK_CREEPS: 'creeps', LOOK_POWER_CREEPS: 'power-creeps', OBSTACLE_OBJECT_TYPES: ['spawn', 'wall', 'extension'] }, modules: {
        'settings/interShard': { interShardPolicy: config },
        './transport': { getLocalShardState: () => local, readRemoteShardState: () => ({ reports: { [task.key]: {
            type: 'command', state: 'active', explorerRevision: progress.revision, explorerStatus: 'exploring', scoutRevision: 'verify-1' } } }),
            markShardStateDirty() {}, flushInterShardMemory: () => true, cancelCreepTransfers() {}, getShardTransportError: () => undefined },
        './portalIntel': { runPortalDiscovery() {}, getKnownPortals: () => [], forgetPortal() {} },
        './explorationRoutes': { isExplorationPlanningDeferred: () => false,
            selectExplorationPortal() { planning.push('portal'); return undefined; },
            getExplorationRooms() { planning.push('rooms'); return ['E40N0']; } },
        './travel': { travelPortalRoute(unit, current) { travel.push({ room: unit.room.name, hop: current.hopIndex });
            return { status: current.hopIndex === current.route.length ? 'arrived' : 'moving' }; } },
        './scoutProof': { sameScoutRoute: (a, b) => JSON.stringify(a) === JSON.stringify(b),
            reportScoutProof(current, unit, leg, result, message) { proofs.push({ leg, result, message }); delete current.scouting.proofPending; return true; } }
    } });
    const safety = loader.load('shard/scoutSafety');
    const explorer = loader.load('shard/exploration').createPortalExplorerRole(data);
    function enemy(x, y, parts = { attack: 25 }, roomName = creep.room.name) {
        const unit = { pos: new Position(x, y, roomName), bodyReads: 0, getActiveBodyparts(part) { unit.bodyReads++; return parts[part] || 0; } };
        hostiles.push(unit); return unit;
    }
    function verifier() {
        delete data.exploration; data.route = [copy(first), copy(second)];
        data.scouting = { revision: 'verify-1', outboundRoute: copy(data.route), leg: 'outbound', elapsedTicks: 0 };
        return loader.load('shard/scouting').createShardScoutRole(data);
    }
    return { game, config, data, progress, mission, local, creep, safety, explorer, enemy, verifier, place,
        walls, tiles, hostiles, structures, moves, nativeMoves, proofs, travel, planning };
}

test('live highway border position passes distant PowerBank fighters without body scans or retirement', () => {
    const w = world(), fighter = w.enemy(16, 43);
    assert.equal(w.safety.getScoutDanger(w.creep), undefined);
    w.explorer.source(w.creep);
    assert.equal(fighter.bodyReads, 0);
    assert.equal(w.travel.length, 1);
    assert.equal(w.data.done, undefined);
    assert.equal(w.local.explorationReports[w.data.missionId].status, 'exploring');
    assert.equal(w.data.routeIssue, undefined);
});

test('near melee and ranged fighters block exploration without blaming a future Portal', () => {
    for (const parts of [{ attack: 25 }, { ranged_attack: 10 }]) {
        const w = world(); w.enemy(25, parts.attack ? 2 : 4, parts); w.explorer.source(w.creep);
        assert.equal(w.travel.length, 0);
        assert.equal(w.data.done, true);
        assert.equal(w.local.explorationReports[w.data.missionId].status, 'failed');
        assert.equal(w.local.explorationReports[w.data.missionId].failedHop, undefined);
        assert.equal(w.data.routeIssue, undefined);
    }
});

test('injury and an energized active hostile tower remain unsafe, harmless towers do not', () => {
    const w = world(); w.creep.hits = 99;
    assert.match(w.safety.getScoutDanger(w.creep), /受到伤害/); w.creep.hits = 100;
    const tower = { structureType: 'tower', my: false, isActive: () => true, store: { energy: 10 } };
    w.structures.push(tower); assert.match(w.safety.getScoutDanger(w.creep), /Tower/);
    tower.store.energy = 0; assert.equal(w.safety.getScoutDanger(w.creep), undefined);
    tower.store.energy = 10; tower.isActive = () => false; assert.equal(w.safety.getScoutDanger(w.creep), undefined);
    tower.isActive = () => true; tower.my = true; assert.equal(w.safety.getScoutDanger(w.creep), undefined);
});

test('low bucket continues an already selected Portal leg without replanning', () => {
    const w = world(); w.game.cpu.bucket = 663; w.explorer.source(w.creep);
    assert.equal(w.travel.length, 1); assert.deepEqual(w.planning, []);
    assert.equal(w.data.done, undefined);
});

test('low bucket selected crossroad traverses the border then ignores distant fighters in the new room', () => {
    const w = world(); w.data.route = []; delete w.progress.selectedPortalHop;
    w.progress.searchTarget = 'E40N0'; w.progress.searchOrigin = { shard: 'shard3', roomName: 'E40N7' };
    w.game.cpu.bucket = 0; w.place('E40N7', 26, 49); w.enemy(16, 43, { attack: 25 }, 'E40N6');
    w.explorer.source(w.creep);
    assert.equal(w.moves.at(-1).roomName, 'E40N0');
    // Resolve the previous downward diagonal intent as Screeps does at a north-room exit.
    w.game.time++; w.place('E40N6', 25, 0); w.explorer.source(w.creep);
    assert.equal(w.moves.length, 2); assert.equal(w.moves.at(-1).options.ignoreSwamps, true);
    assert.equal(w.data.done, undefined); assert.deepEqual(w.planning, []);
    assert.equal(w.progress.targetStartedTick, w.game.time);
});

test('low bucket without a selected target defers planning without a false route failure', () => {
    const w = world(); w.data.route = []; delete w.progress.selectedPortalHop; w.game.cpu.bucket = 0;
    w.explorer.source(w.creep);
    assert.deepEqual(w.moves, []); assert.deepEqual(w.planning, []);
    assert.equal(w.data.done, undefined); assert.match(w.data.lastError, /CPU/);
});

test('verification uses the same nearby threat rule and rechecks pending success before publishing proof', () => {
    const far = world(); far.enemy(16, 43); const role = far.verifier(); role.source(far.creep);
    assert.equal(far.travel.length, 1); assert.deepEqual(far.proofs, []); assert.equal(far.data.done, undefined);
    const near = world(), verify = near.verifier(); near.place('E1N1', 25, 25, 'shard1');
    near.data.hopIndex = 2; near.data.scouting.proofPending = { leg: 'outbound', result: 'verified' };
    near.enemy(25, 27); verify.source(near.creep);
    assert.deepEqual(near.proofs.map(proof => proof.result), ['failed']);
    assert.equal(near.travel.length, 0); assert.equal(near.data.done, true);
});

test('a healthy reusable scout steps away from a close fighter without entering Portal, wall or occupied tiles', () => {
    const w = world(); w.place('E40N6', 25, 25); w.enemy(25, 27);
    w.tiles.set('structures/25/24', [{ structureType: 'portal' }]);
    w.walls.add('26/24'); w.tiles.set('creeps/24/24', [{}]);
    assert.equal(w.safety.moveScoutAwayFromThreat(w.creep), false);
    assert.deepEqual(w.nativeMoves, []);
    w.tiles.delete('creeps/24/24');
    assert.equal(w.safety.moveScoutAwayFromThreat(w.creep), true);
    assert.deepEqual(w.nativeMoves, [8]);
    w.creep.fatigue = 1; assert.equal(w.safety.moveScoutAwayFromThreat(w.creep), false);
});

test('near-threat escape cannot authorize a damaged scout or move a scout with no nearby threat', () => {
    const w = world(); w.enemy(16, 43);
    assert.equal(w.safety.moveScoutAwayFromThreat(w.creep), false);
    w.enemy(25, 2); w.creep.hits = 99;
    assert.equal(w.safety.moveScoutAwayFromThreat(w.creep), false);
    assert.deepEqual(w.nativeMoves, []);
});
