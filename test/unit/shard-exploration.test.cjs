const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const copy = value => JSON.parse(JSON.stringify(value));

function world({ prefix = true, returning = false, policy = {} } = {}) {
    const clock = { now: 1000000 }, cpu = { used: 0 };
    const game = { shard: { name: 'shard3' }, time: 100, rooms: {}, structures: {}, creeps: {},
        cpu: { bucket: 10000, tickLimit: 100, getUsed: () => cpu.used } };
    const first = { shard: 'shard3', roomName: 'W0N0', x: 10, y: 10, destinationShard: 'shard2', destinationRoom: 'W0N0' };
    const second = { shard: 'shard2', roomName: 'W10N0', x: 20, y: 20, destinationShard: 'shard1', destinationRoom: 'W20N20' };
    const back1 = { shard: 'shard1', roomName: 'W20N20', x: 30, y: 30, destinationShard: 'shard2', destinationRoom: 'W10N0' };
    const back2 = { shard: 'shard2', roomName: 'W0N0', x: 40, y: 40, destinationShard: 'shard3', destinationRoom: 'W0N0' };
    const task = { id: 'm', key: 'shard3:m', sourceShard: 'shard3', sourceRoom: 'W1N1', targetShard: 'shard1', targetRoom: 'W2N2',
        route: [], autoRoute: true, claim: true, builders: 1, haulers: 0, targetLevel: 4, energyAmount: 0, homeEnergyReserve: 10000 };
    const progress = { revision: 'explore-1', goalShard: 'shard1', goalRoom: 'W2N2', ...(returning ? { returnGoal: { shard: 'shard3', roomName: 'W1N1' } } : {}),
        stage: 'outbound', startedAt: clock.now, elapsedTicks: 0, visitedRooms: [], visitedShards: [] };
    const data = { missionId: task.key, task, unitKind: 'scout', originShard: 'shard3', route: prefix ? [copy(first)] : [], hopIndex: 0,
        phase: 'outbound', exploration: progress };
    const memory = { shardMissions: { [task.key]: { state: 'active', exploration: { revision: progress.revision, status: 'exploring' } } } };
    const remote = { reports: { [task.key]: { type: 'command', state: 'active', explorerRevision: progress.revision, explorerStatus: 'exploring' } } };
    const local = { version: 1, transfers: {}, acks: {}, reports: { unrelated: { keep: true } }, scoutProofs: { evidence: { keep: true } } };
    const config = { enabled: true, portalDiscovery: { enabled: true }, portalRouting: { maximumHops: 8 }, portalExploration: { enabled: true, minimumBucket: 1000,
        minimumCpuHeadroom: 10, maximumPlanningCpu: 5, maximumVisitedRooms: 128, maximumSearchTicks: 1200, minimumRemainingTicks: 50,
        stuckTicks: 25, roomTimeout: 150, blockedRoomTtl: 300000, maximumAge: 1800000, reportInterval: 10, reportTtl: 1200000,
        maximumReports: 80, ...policy } };
    const transport = { succeed: true, attempts: 0, writes: [], dirty: 0, cancellations: 0 };
    const intel = { known: prefix ? [copy(first)] : [], scans: 0, forgotten: [] };
    const helpers = { selections: [], scans: [], candidates: ['W0N0', 'W10N0'], spent: 0, deferred: false };
    const travel = { calls: [], result: undefined }, moves = [], hostiles = [], structures = [];
    class Position { constructor(x, y, roomName) { this.x = x; this.y = y; this.roomName = roomName; } }
    class ClockDate extends Date { static now() { return clock.now; } }
    const creep = { name: 'explorer-unique', memory: { role: 'sScout', data }, spawning: false, fatigue: 0, hits: 100, hitsMax: 100,
        ticksToLive: 1450, owner: { username: 'me' },
        moveTo(pos, options) { moves.push({ ...pos, options }); return creep.moveResult ?? 0; } };
    for (const action of ['claimController', 'reserveController', 'build', 'harvest', 'withdraw', 'transfer']) creep[action] = () => { throw new Error(`Explorer cannot ${action}`); };
    function place(shard, roomName, tick = game.time) {
        game.shard.name = shard; game.time = tick; creep.pos = new Position(25, 25, roomName);
        creep.room = { name: roomName, find: type => type === 'hostile-creeps' ? hostiles : structures };
        game.rooms = { [roomName]: creep.room }; return creep;
    }
    place('shard3', 'W1N1');
    const loader = createSourceLoader({ globals: { Game: game, Memory: memory, Date: ClockDate, RoomPosition: Position, OK: 0, ERR_NO_PATH: -2, ERR_TIRED: -11,
        FIND_HOSTILE_CREEPS: 'hostile-creeps', FIND_HOSTILE_STRUCTURES: 'hostile-structures', ATTACK: 'attack', RANGED_ATTACK: 'ranged_attack',
        STRUCTURE_TOWER: 'tower', RESOURCE_ENERGY: 'energy', TOWER_ENERGY_COST: 10 }, modules: {
            'settings/interShard': { interShardPolicy: config },
            './transport': { getLocalShardState: () => local, readRemoteShardState: () => remote, markShardStateDirty: () => transport.dirty++,
                getShardTransportError: () => 'publish unavailable', cancelCreepTransfers: () => transport.cancellations++,
                flushInterShardMemory() { transport.attempts++; if (!transport.succeed) return false; transport.writes.push(copy(local)); return true; } },
            './portalIntel': { runPortalDiscovery: () => intel.scans++, getKnownPortals: () => intel.known,
                forgetPortal(hop) { intel.forgotten.push(copy(hop)); } },
            './explorationRoutes': {
                isExplorationPlanningDeferred: () => helpers.deferred,
                selectExplorationPortal(shard, room, goal, goalRoom, portals, visited, options) {
                    helpers.selections.push({ shard, room, goal, goalRoom, portals: copy(portals), visited: [...visited], options: copy(options) });
                    cpu.used += helpers.spent;
                    const next = goal === 'shard1' ? { shard3: 'shard2', shard2: 'shard1' }[shard] : { shard1: 'shard2', shard2: 'shard3' }[shard];
                    return portals.find(hop => hop.shard === shard && hop.destinationShard === next && !visited.includes(hop.destinationShard));
                },
                getExplorationRooms(anchor, visited, excluded, options) { helpers.scans.push({ anchor, visited: [...visited], excluded: [...excluded], options: copy(options) });
                    cpu.used += helpers.spent; return (helpers.candidatesFrom?.(anchor) || helpers.candidates).filter(room => !visited.includes(room) && !excluded.includes(room)); }
            },
            './travel': { travelPortalRoute(unit, current) { travel.calls.push({ route: copy(current.route), origin: current.originShard, hop: current.hopIndex });
                return travel.result || { status: current.hopIndex === current.route.length ? 'arrived' : 'moving' }; } }
        } });
    const api = loader.load('shard/exploration'), factory = loader.load('shard/scouting');
    const role = factory.createShardScoutRole(data);
    function arrive(shard, roomName, tick = 5) { place(shard, roomName, tick); data.hopIndex = data.route.length; }
    return { clock, cpu, game, data, task, progress, memory, remote, local, config, transport, intel, helpers, travel, moves, hostiles, structures,
        creep, first, second, back1, back2, loader, api, role, place, arrive };
}

test('exploration imports without game API access', () => {
    const loader = createSourceLoader({ modules: { 'settings/interShard': { interShardPolicy: {} } } });
    assert.doesNotThrow(() => loader.load('shard/exploration'));
});

test('empty prefix dispatches explorer behavior instead of verification and cannot publish a scout proof', () => {
    const w = world({ prefix: false });
    assert.equal(w.role.prepare(w.creep), true); w.role.source(w.creep);
    assert.equal(w.travel.calls.length, 0); assert.equal(w.moves[0].roomName, 'W0N0');
    assert.equal(w.local.explorationReports[w.task.key].status, 'exploring');
    assert.deepEqual(w.local.scoutProofs, { evidence: { keep: true } }); assert.equal(w.data.scouting, undefined);
    assert.deepEqual(w.local.reports, { unrelated: { keep: true } });
});

test('known 3→2 prefix reaches an empty intermediate shard, then crawls crossroads until an actual 2→1 portal exists', () => {
    const w = world(); w.role.source(w.creep);
    assert.equal(w.travel.calls[0].hop, 0); assert.equal(w.travel.calls[0].route[0].destinationShard, 'shard2');
    w.arrive('shard2', 'W0N0', 3); w.role.source(w.creep);
    assert.equal(w.data.route.length, 1); assert.equal(w.moves.at(-1).roomName, 'W10N0');
    assert.deepEqual(w.helpers.scans.at(-1).visited, ['W0N0']);
    assert.equal(w.data.done, undefined); assert.equal(Object.keys(w.game.structures).length, 0);
    w.place('shard2', 'W10N0', 4); w.intel.known.push(copy(w.second)); w.role.source(w.creep);
    assert.equal(w.data.originShard, 'shard3'); assert.equal(w.data.hopIndex, 1);
    assert.deepEqual(copy(w.data.route), [w.first, w.second]); assert.equal(w.travel.calls.at(-1).hop, 1);
    w.arrive('shard1', 'W20N20', 80); w.role.source(w.creep);
    assert.equal(w.moves.at(-1).roomName, 'W2N2'); assert.equal(w.data.done, undefined);
    w.place('shard1', 'W2N2', 81); w.role.source(w.creep);
    const report = w.local.explorationReports[w.task.key];
    assert.equal(report.status, 'complete'); assert.equal(report.shard, 'shard1'); assert.equal(report.roomName, 'W2N2');
    assert.equal(w.data.done, true); assert.deepEqual(copy(report.route), [w.first, w.second]);
    assert.deepEqual(w.local.scoutProofs, { evidence: { keep: true } });
});

test('a live automatic explorer discards old far prefetched hops and locks only the current nearest door', () => {
    const w = world();
    const oldFar = { ...copy(w.first), roomName: 'W20N20' };
    w.data.route = [oldFar, copy(w.second)];
    w.data.transferPreparedAt = w.game.time; w.data.transferPreparedShard = 'shard3'; w.data.transferPreparedHop = 0;
    w.role.source(w.creep);
    assert.deepEqual(copy(w.data.route), [w.first]);
    assert.equal(w.travel.calls.at(-1).route[0].roomName, 'W0N0');
    assert.equal(w.progress.selectedPortalHop, 0);
    assert.equal(w.data.transferPreparedAt, undefined); assert.ok(w.transport.cancellations > 0);
    const selections = w.helpers.selections.length;
    w.game.time++; w.creep.pos.x++; w.role.source(w.creep);
    assert.equal(w.helpers.selections.length, selections, 'the selected door remains stable during this leg');
    w.place('shard2', 'W0N0', 3); w.data.hopIndex = 1; w.intel.known.push(copy(w.second)); w.role.source(w.creep);
    assert.deepEqual(copy(w.data.route), [w.first, w.second]);
    assert.equal(w.progress.selectedPortalHop, 1); assert.equal(w.travel.calls.at(-1).hop, 1);
    assert.deepEqual(w.local.scoutProofs, { evidence: { keep: true } });
});

test('explicit manual outbound routes are retained while only automatic portal choices change', () => {
    const w = world({ returning: true });
    const manual = { ...copy(w.first), roomName: 'W20N20' };
    w.task.autoRoute = false; w.task.autoReturn = true; w.task.haulers = 1;
    w.data.route = [manual, copy(w.second)]; w.task.route = copy(w.data.route);
    w.role.source(w.creep);
    assert.deepEqual(copy(w.travel.calls.at(-1).route), [manual, w.second]);
    assert.equal(w.helpers.selections.length, 0);
});

test('return exploration appends the real reverse hops without resetting source origin or cumulative hop index', () => {
    const w = world({ returning: true }); w.data.route.push(copy(w.second)); w.arrive('shard1', 'W2N2');
    w.role.source(w.creep);
    assert.equal(w.progress.stage, 'return'); assert.deepEqual(copy(w.progress.visitedShards), ['shard1']);
    assert.equal(w.data.done, undefined); assert.equal(w.local.explorationReports[w.task.key].status, 'exploring');
    w.intel.known.push(copy(w.back1)); w.game.time++; w.role.source(w.creep);
    assert.equal(w.data.hopIndex, 2); assert.equal(w.data.originShard, 'shard3');
    w.arrive('shard2', 'W10N0', 600); w.intel.known.push(copy(w.back2)); w.role.source(w.creep);
    assert.equal(w.data.hopIndex, 3); assert.equal(w.data.originShard, 'shard3');
    assert.deepEqual(copy(w.data.route), [w.first, w.second, w.back1, w.back2]);
    w.arrive('shard3', 'W1N1', 104); w.role.source(w.creep);
    assert.equal(w.data.done, true); assert.equal(w.local.explorationReports[w.task.key].status, 'complete');
    assert.equal(w.local.explorationReports[w.task.key].shard, 'shard3');
});

test('global visited keys are bounded and passed to room selection as local room names', () => {
    const w = world({ prefix: false, policy: { maximumVisitedRooms: 3 } });
    w.progress.visitedRooms = ['shard1/W0N0', 'shard2/W10N0', 'shard3/W0N0'];
    w.role.source(w.creep);
    assert.equal(w.progress.visitedRooms.length, 3);
    assert.deepEqual(w.helpers.scans[0].visited, ['W0N0', 'W1N1']);
    assert.equal(w.moves[0].roomName, 'W10N0');
});

test('each new crossroad is selected near the actual scout instead of returning toward the initial search origin', () => {
    const w = world({ prefix: false });
    w.helpers.candidatesFrom = room => room === 'W10N10' ? ['W20N10', 'W0N0'] : ['W10N10', 'W0N0'];
    w.role.source(w.creep);
    assert.equal(w.moves.at(-1).roomName, 'W10N10');
    w.place('shard3', 'W10N10', 101); w.role.source(w.creep);
    assert.equal(w.moves.at(-1).roomName, 'W20N10');
    assert.equal(w.helpers.scans.at(-1).anchor, 'W10N10');
    assert.equal(w.helpers.scans.at(-1).options.searchOriginRoom, 'W1N1');
    assert.equal(w.helpers.scans.at(-1).options.nearestOnly, true);
    assert.ok(w.helpers.scans.at(-1).visited.includes('W10N10'));
    assert.equal(w.data.done, undefined);
});

test('an explorer keeps its chosen crossroad while moving through intermediate rooms', () => {
    const w = world({ prefix: false });
    w.helpers.candidates = ['W10N10', 'W0N0']; w.role.source(w.creep);
    w.helpers.candidates = ['W0N0', 'W10N10'];
    w.place('shard3', 'W5N5', 101); w.role.source(w.creep);
    assert.equal(w.moves.at(-1).roomName, 'W10N10');
    assert.equal(w.helpers.scans.length, 1);
    assert.equal(w.progress.targetStartedTick, 101);
});

test('observer-visible crossroads are already scanned and do not need a scout visit', () => {
    const w = world({ prefix: false });
    w.game.rooms.W0N0 = { name: 'W0N0' }; w.role.source(w.creep);
    assert.equal(w.moves.at(-1).roomName, 'W10N0');
    assert.ok(w.progress.visitedRooms.includes('shard3/W0N0'));
    const moving = world({ prefix: false }); moving.role.source(moving.creep);
    assert.equal(moving.progress.searchTarget, 'W0N0');
    moving.game.rooms.W0N0 = { name: 'W0N0' }; moving.game.time++; moving.creep.pos.x++;
    moving.role.source(moving.creep);
    assert.equal(moving.moves.at(-1).roomName, 'W10N0');
    assert.equal(moving.data.done, undefined);
});

test('visible real portals remain usable despite the crossroad being scanned', () => {
    const w = world({ prefix: false });
    w.game.rooms.W0N0 = { name: 'W0N0' }; w.intel.known.push(copy(w.first));
    w.role.source(w.creep);
    assert.equal(w.travel.calls.length, 1);
    assert.equal(w.travel.calls[0].route[0].roomName, 'W0N0');
    assert.equal(w.helpers.scans.length, 0);
});

test('frontier no-path excludes that room temporarily and chooses another crossroad', () => {
    const w = world({ prefix: false }); w.creep.moveResult = -2;
    w.role.source(w.creep);
    assert.equal(w.progress.searchTarget, undefined); assert.equal(w.progress.excludedRooms[0].roomName, 'W0N0');
    assert.equal(w.progress.excludedRooms[0].until, w.clock.now + w.config.portalExploration.blockedRoomTtl);
    w.creep.moveResult = 0; w.game.time++; w.role.source(w.creep);
    assert.equal(w.moves.at(-1).roomName, 'W10N0'); assert.equal(w.data.done, undefined);
    assert.deepEqual(w.intel.forgotten, []);
});

test('cross-room progress refreshes room timeout; a stalled room target is skipped', () => {
    const w = world({ prefix: false }); w.role.source(w.creep);
    w.place('shard3', 'W1N2', 200); w.role.source(w.creep);
    assert.equal(w.progress.targetStartedTick, 200); assert.equal(w.progress.searchTarget, 'W0N0');
    w.game.time = 349; w.creep.pos.x++; w.role.source(w.creep);
    assert.equal(w.progress.searchTarget, 'W0N0');
    w.game.time = 350; w.creep.pos.x++; w.role.source(w.creep);
    assert.equal(w.progress.searchTarget, 'W10N0');
    assert.ok(w.helpers.scans.at(-1).excluded.includes('W0N0'));
});

test('visible missing or changed portal fails with its full route snapshot; no-path does not erase a real portal', () => {
    for (const reason of ['portal-missing', 'portal-destination', 'no-path']) {
        const w = world(); w.travel.result = { status: 'waiting', reason, message: reason };
        w.role.source(w.creep);
        const report = w.local.explorationReports[w.task.key];
        assert.equal(report.status, 'failed'); assert.deepEqual(copy(report.failedHop), w.first);
        assert.deepEqual(copy(report.route), [w.first]); assert.equal(w.data.done, true);
        assert.equal(w.intel.forgotten.length, reason === 'no-path' ? 0 : 1);
    }
});

test('transfer propagation waiting keeps exploration alive and does not claim a portal failure', () => {
    const w = world(); w.travel.result = { status: 'waiting', message: 'waiting one source tick' };
    w.role.source(w.creep); w.game.time++; w.role.source(w.creep);
    assert.equal(w.data.done, undefined); assert.equal(w.progress.status, 'exploring');
    assert.equal(w.local.explorationReports[w.task.key].failedHop, undefined);
});

test('low CPU pauses discovery movement, and helper budget exhaustion cannot falsely declare the search impossible', () => {
    const w = world({ prefix: false }); w.game.cpu.bucket = 999; w.role.source(w.creep);
    assert.equal(w.helpers.selections.length, 0); assert.equal(w.moves.length, 0); assert.equal(w.data.done, undefined);
    w.game.cpu.bucket = 10000; w.game.time++; w.helpers.spent = 5; w.role.source(w.creep);
    assert.equal(w.moves.length, 0); assert.equal(w.helpers.scans.length, 0); assert.equal(w.data.done, undefined);
    w.helpers.spent = 0; w.cpu.used = 0; w.game.time++; w.role.source(w.creep);
    assert.equal(w.moves.length, 1);
});

function enableLowBucket(w) {
    w.config.lowBucketPlanning = { minimumCpuHeadroom: 2, maximumPlanningCpu: 0.75,
        maximumPlansPerTick: 1, maximumLocalRouteChecks: 2, maximumCandidates: 8 };
    w.game.cpu.bucket = 0; w.game.cpu.limit = 20; w.game.cpu.tickLimit = 21; w.cpu.used = 1.5;
}

test('zero bucket scouts select one lightweight nearest crossroads candidate with bounded shared options', () => {
    const w = world({ prefix: false }); enableLowBucket(w); w.role.source(w.creep);
    assert.equal(w.moves.at(-1).roomName, 'W0N0');
    assert.equal(w.helpers.selections[0].options.candidateOnly, true);
    assert.equal(w.helpers.selections[0].options.minimumCpuHeadroom, 2);
    assert.equal(w.helpers.selections[0].options.maximumPlanningCpu, 0.75);
    assert.equal(w.helpers.scans[0].options.maximumCandidates, 8);
    assert.equal(w.data.done, undefined); assert.deepEqual(w.local.scoutProofs, { evidence: { keep: true } });
});

test('zero bucket scouts select a known next-shard door instead of searching farther crossroads', () => {
    const w = world({ prefix: false }); enableLowBucket(w); w.intel.known.push(copy(w.first)); w.role.source(w.creep);
    assert.deepEqual(copy(w.data.route), [w.first]); assert.equal(w.travel.calls.at(-1).hop, 0);
    assert.equal(w.helpers.scans.length, 0); assert.equal(w.data.scouting, undefined);
    assert.deepEqual(w.local.scoutProofs, { evidence: { keep: true } });
});

test('a shared low bucket planning reservation pauses only new selection until the following tick', () => {
    const w = world({ prefix: false }); enableLowBucket(w);
    assert.ok(w.loader.load('shard/planningBudget').reserveLowBucketPlanning());
    w.role.source(w.creep);
    assert.equal(w.helpers.selections.length, 0); assert.equal(w.moves.length, 0);
    assert.equal(w.progress.cpuWaitStartedAt, w.clock.now);
    w.game.time++; w.role.source(w.creep);
    assert.equal(w.moves.at(-1).roomName, 'W0N0'); assert.equal(w.progress.cpuWaitStartedAt, undefined);
});

test('CPU headroom waiting does not consume active tick or wall search timeout and resumes movement', () => {
    const w = world({ prefix: false }); enableLowBucket(w); w.cpu.used = 20;
    w.role.source(w.creep); assert.equal(w.progress.cpuWaitStartedAt, w.clock.now);
    w.clock.now += w.config.portalExploration.maximumAge + 1000;
    w.game.time += w.config.portalExploration.maximumSearchTicks + 10;
    w.role.source(w.creep);
    assert.equal(w.progress.elapsedTicks, 0); assert.equal(w.progress.status, 'exploring'); assert.equal(w.data.done, undefined);
    w.clock.now += 50; w.game.time++; w.cpu.used = 1.5; w.role.source(w.creep);
    assert.equal(w.moves.at(-1).roomName, 'W0N0'); assert.equal(w.progress.cpuWaitStartedAt, undefined);
    assert.equal(w.progress.cpuWaitMilliseconds, w.config.portalExploration.maximumAge + 1050);
    assert.equal(w.progress.elapsedTicks, 0); assert.equal(w.data.done, undefined);
});

test('a queued explorer zero start sentinel begins its wall timeout at its first actual run', () => {
    const w = world({ prefix: false }); w.progress.startedAt = 0;
    w.clock.now += w.config.portalExploration.maximumAge * 3;
    w.role.source(w.creep);
    assert.equal(w.progress.startedAt, w.clock.now); assert.equal(w.data.done, undefined);
    assert.equal(w.moves.at(-1).roomName, 'W0N0');
});

test('clock uses local deltas plus one arrival tick and never compares tick counters across shards', () => {
    const w = world(); w.game.time = 900000; w.role.source(w.creep);
    w.game.time += 7; w.creep.pos.x++; w.role.source(w.creep);
    w.arrive('shard2', 'W0N0', 3); w.role.source(w.creep);
    assert.equal(w.progress.elapsedTicks, 8);
    w.game.time += 4; w.creep.pos.x++; w.role.source(w.creep);
    assert.equal(w.progress.elapsedTicks, 12);
});

test('portal selection and room enumeration receive only the remaining shared CPU budget', () => {
    const w = world({ prefix: false }); w.helpers.spent = 2;
    w.role.source(w.creep);
    assert.equal(w.helpers.selections[0].options.maximumPlanningCpu, 5);
    assert.equal(w.helpers.scans[0].options.maximumPlanningCpu, 3);
    assert.equal(w.cpu.used, 4); assert.equal(w.moves.length, 1);
});

test('native planner budget deferral with ample CPU is waiting, never a false no-portals failure', () => {
    const w = world({ prefix: false }); w.helpers.deferred = true;
    w.role.source(w.creep);
    assert.equal(w.data.done, undefined); assert.equal(w.progress.status, 'exploring');
    assert.equal(w.helpers.scans.length, 0); assert.equal(w.moves.length, 0);
    assert.match(w.data.lastError, /预算/);
    w.helpers.deferred = false; w.game.time++; w.role.source(w.creep);
    assert.equal(w.moves.length, 1);
});

test('danger, short lifetime and bounded search duration stop exploration without emitting validation proofs', () => {
    const changes = [w => { w.creep.hits--; }, w => { w.creep.ticksToLive = 49; }, w => { w.progress.elapsedTicks = 1201; },
        w => { w.clock.now += 1800001; }, w => w.hostiles.push({ getActiveBodyparts: () => 1 }),
        w => w.structures.push({ structureType: 'tower', my: false, isActive: () => true, store: { energy: 10 } })];
    for (const change of changes) {
        const w = world(); change(w); w.role.source(w.creep);
        assert.equal(w.local.explorationReports[w.task.key].status, 'failed'); assert.equal(w.data.done, true);
        assert.equal(w.travel.calls.length, 0); assert.deepEqual(w.local.scoutProofs, { evidence: { keep: true } });
    }
});

test('stationary unfatigued explorer fails at the threshold while fatigue does not count as a blocked route', () => {
    const w = world({ policy: { stuckTicks: 3 } }); w.role.source(w.creep);
    w.game.time += 3; w.creep.fatigue = 2; w.role.source(w.creep);
    assert.equal(w.data.done, undefined);
    w.game.time += 3; w.creep.fatigue = 0; w.role.source(w.creep);
    assert.equal(w.local.explorationReports[w.task.key].status, 'failed'); assert.match(w.data.lastError, /没有移动/);
});

test('source pause prevents movement and cancel, revision change or completed intel retires the explorer', () => {
    const paused = world(); paused.remote.reports[paused.task.key].state = 'paused'; paused.arrive('shard2', 'W0N0');
    paused.role.source(paused.creep); assert.equal(paused.moves.length, 0); assert.equal(paused.data.done, undefined);
    for (const change of ['cancelled', 'revision', 'complete']) {
        const w = world(); w.arrive('shard2', 'W0N0');
        if (change === 'cancelled') w.remote.reports[w.task.key].state = 'cancelled';
        else if (change === 'revision') w.remote.reports[w.task.key].explorerRevision = 'new';
        else w.remote.reports[w.task.key].explorerStatus = 'complete';
        w.role.source(w.creep);
        assert.equal(w.data.done, true); assert.equal(w.role.prepare(w.creep), false);
        assert.equal(w.moves.length, 0); assert.equal(w.travel.calls.length, 0); assert.ok(w.transport.cancellations > 0);
    }
});

test('local portal explorers retire after their mission is removed despite a stale active ISM command', () => {
    for (const state of ['complete', 'cancelled']) {
        const w = world();
        delete w.memory.shardMissions[w.task.key];
        w.memory.shardMissionStops = { [w.task.key]: { state, updatedAt: w.clock.now,
            expiresAt: w.clock.now + 1200000, published: false } };
        w.local.reports[w.task.key] = { type: 'command', state: 'active', explorerRevision: w.progress.revision };
        w.data.transferPreparedAt = w.game.time; w.progress.reportPending = true;
        w.role.source(w.creep);
        assert.equal(w.data.done, true); assert.equal(w.data.phase, 'done');
        assert.equal(w.data.transferPreparedAt, undefined); assert.equal(w.progress.reportPending, undefined);
        assert.equal(w.moves.length, 0); assert.equal(w.travel.calls.length, 0);
        assert.equal(w.transport.attempts, 0); assert.ok(w.transport.cancellations > 0);
    }
});

test('report write failure keeps previous evidence and retries the original failure before retiring', () => {
    const w = world(); const old = { unrelated: { updatedAt: w.clock.now, keep: true } };
    w.local.explorationReports = old; w.transport.succeed = false;
    w.travel.result = { status: 'waiting', reason: 'portal-missing', message: 'missing exact entry' };
    w.role.source(w.creep); assert.equal(w.local.explorationReports, old); assert.equal(w.progress.reportPending, true);
    // The initial heartbeat must be persisted before the unit starts moving.
    assert.equal(w.travel.calls.length, 0);
    w.transport.succeed = true; w.game.time++; w.role.source(w.creep);
    assert.equal(w.data.done, true); assert.equal(w.local.explorationReports[w.task.key].lastError, 'missing exact entry');
    assert.deepEqual(w.local.explorationReports.unrelated, old.unrelated);
});

test('terminal publication failure preserves failure details and does not mark done until persisted', () => {
    const w = world(); w.role.source(w.creep); w.transport.succeed = false;
    w.game.time++; w.creep.hits--; w.role.source(w.creep);
    assert.equal(w.progress.status, 'failed'); assert.equal(w.data.done, undefined); assert.equal(w.progress.reportPending, true);
    assert.match(w.data.lastError, /受到伤害/);
    w.transport.succeed = true; w.game.time++; w.role.source(w.creep);
    assert.equal(w.data.done, true); assert.match(w.local.explorationReports[w.task.key].lastError, /受到伤害/);
});

test('full report directory preserves live entries and uses only expired capacity; malformed namespace is retained', () => {
    const w = world({ policy: { maximumReports: 2, reportTtl: 1000 } });
    const old = { one: { updatedAt: w.clock.now - 900, keep: true }, two: { updatedAt: w.clock.now, keep: true } };
    w.local.explorationReports = old;
    assert.equal(w.api.reportPortalExploration(w.data, w.creep, 'exploring'), false);
    assert.equal(w.local.explorationReports, old); assert.equal(w.transport.attempts, 0);
    w.clock.now += 200;
    assert.equal(w.api.reportPortalExploration(w.data, w.creep, 'exploring'), true);
    assert.equal(w.local.explorationReports.one, undefined); assert.deepEqual(w.local.explorationReports.two, old.two);
    for (const bad of [null, [], 'invalid']) {
        const broken = world(); broken.local.explorationReports = bad;
        assert.equal(broken.api.reportPortalExploration(broken.data, broken.creep, 'exploring'), false);
        assert.equal(broken.local.explorationReports, bad); assert.equal(broken.transport.attempts, 0);
    }
});

test('complete report requires the precise actual final endpoint and return leg when a return goal exists', () => {
    const w = world({ returning: true }); w.arrive('shard1', 'W2N2');
    assert.equal(w.api.reportPortalExploration(w.data, w.creep, 'complete'), false); assert.equal(w.local.explorationReports, undefined);
    w.progress.stage = 'return'; w.place('shard3', 'W0N0');
    assert.equal(w.api.reportPortalExploration(w.data, w.creep, 'complete'), false);
    w.place('shard3', 'W1N1');
    assert.equal(w.api.reportPortalExploration(w.data, w.creep, 'complete'), true);
    assert.equal(w.local.explorationReports[w.task.key].roomName, 'W1N1');
});

test('ordinary roles and malformed exploration state are never taken over or executed', () => {
    const w = world(); w.creep.memory.role = 'sBuilder';
    assert.equal(w.role.prepare(w.creep), false); assert.equal(w.role.source(w.creep), false);
    w.creep.memory.role = 'sScout';
    for (const invalid of [null, {}, { ...copy(w.progress), searchOrigin: null }, { ...copy(w.progress), excludedRooms: [null] }]) {
        w.data.exploration = invalid;
        assert.equal(w.role.prepare(w.creep), false); assert.equal(w.role.source(w.creep), false);
    }
    assert.equal(w.transport.attempts, 0); assert.equal(w.travel.calls.length, 0);
});
