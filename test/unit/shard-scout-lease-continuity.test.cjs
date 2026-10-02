const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const copy = value => JSON.parse(JSON.stringify(value));

function world(exploring = false) {
    const clock = { now: 1000000 }, cancelled = [], local = { version: 1, transfers: {}, acks: {}, reports: {}, scoutProofs: {}, explorationReports: {} };
    const peers = Object.fromEntries(['shard1', 'shard2'].map(shard => [shard, { version: 1, transfers: {}, acks: {}, reports: {}, scoutProofs: {} }]));
    const route = [{ shard: 'shard3', roomName: 'W0N0', x: 10, y: 10, destinationShard: 'shard2', destinationRoom: 'W1N1' },
        { shard: 'shard2', roomName: 'W0N0', x: 20, y: 20, destinationShard: 'shard1', destinationRoom: 'W2N2' }];
    const home = { name: 'W1N1', my: true, controller: { my: true }, memory: { creepConfig: {}, creepSpawnQueue: [] }, find: () => [{ id: 'spawn' }] };
    const task = { id: 'm', key: 'shard3:m', sourceShard: 'shard3', sourceRoom: home.name, targetShard: 'shard1', targetRoom: 'W2N2',
        route: exploring ? [] : route, autoRoute: exploring, autoReturn: false, explorePortals: true, verifyRoute: true,
        claim: false, builders: 1, haulers: 0, targetLevel: 4, energyAmount: 0, homeEnergyReserve: 10000 };
    const mission = { task, state: 'active', createdAt: clock.now, generation: 0, leases: {}, energyDelivered: 0,
        routing: { status: exploring ? 'waiting' : 'ready', updatedAt: clock.now } };
    const memory = { shardMissions: { [task.key]: mission }, creeps: {}, warMode: {} };
    const game = { time: 100, shard: { name: 'shard3' }, creeps: {}, rooms: { [home.name]: home }, flags: {}, structures: {},
        cpu: { bucket: 10000, tickLimit: 100, getUsed: () => 0 } };
    const loader = createSourceLoader({ globals: { Game: game, Memory: memory, Date: class extends Date { static now() { return clock.now; } },
        FIND_MY_SPAWNS: 'my-spawns', console: { log() {} } }, modules: {
        'creep/demand': { createCreepName: (role, name) => `${role}:${name}`,
            addCreepConfig(room, role, name, data) { const key = `${role}:${name}`; room.memory.creepConfig[key] = { role, name, data }; return key; } },
        './routing': { updateMissionRouting() {} },
        './transport': { getLocalShardState: () => local, readRemoteShardState: shard => peers[shard], markShardStateDirty() {},
            restoreArrivingCreeps() {}, getShardTransportError: () => undefined, cancelCreepTransfers: creep => cancelled.push(creep.name) },
        './portalIntel': { runPortalDiscovery() {}, getKnownPortals: () => route, getPortalIntelStatus: () => ({ observers: 0, portals: 2 }) },
        './explorationRoutes': { planExplorationEntry: () => [route[0]] },
        './routePlanner': { isPortalRouteKnown: () => true },
        './scoutSafety': { getScoutDanger: creep => creep.danger ? 'nearby threat' : undefined },
    } });
    const api = loader.load('shard/controller'), exploration = loader.load('shard/explorationControl'), policy = loader.load('settings/interShard').interShardPolicy;
    policy.peers = ['shard1', 'shard2']; policy.reportInterval = 1;
    api.releaseShardCreepConfig();
    const lease = () => mission.leases[exploring ? 'explorer:0' : 'scout:0'];
    const advance = milliseconds => { clock.now += milliseconds; game.time++; };
    function unit(name = lease().name, extra = {}) {
        const original = home.memory.creepConfig[lease().name];
        const creep = { name, room: { name: 'W1N7' }, pos: { x: 25, y: 25, roomName: 'W1N7' }, hits: 100, hitsMax: 100, ticksToLive: 1000,
            memory: { role: 'sScout', name: original.name, data: copy(original.data), ready: true, working: true }, ...extra };
        game.creeps[name] = creep; return creep;
    }
    function report(shard, updatedAt, units = [{ name: lease().name, kind: 'scout', done: false }]) {
        peers[shard].reports[task.key] = { type: 'status', missionId: task.key, originShard: 'shard3', shard, updatedAt,
            energyDelivered: 0, targetOwned: false, targetLevel: 0, targetSpawns: 0, units };
    }
    function failure(creep) {
        creep.memory.data.done = true; creep.memory.data.phase = 'done'; creep.memory.data.exploration.status = 'failed';
        creep.memory.data.lastError = 'old threat'; exploration.failPortalExploration(mission, 'old threat');
    }
    const explorationReport = (creep, updatedAt, extra = {}) => ({ missionId: task.key, sourceShard: 'shard3', explorerName: creep.name,
        revision: mission.exploration.revision, status: 'failed', shard: 'shard3', roomName: creep.room.name,
        updatedAt, elapsedTicks: 10, visitedRooms: ['shard3/W1N7'], route: copy(creep.memory.data.route), lastError: 'old threat', ...extra });
    return { loader, api, exploration, policy, game, clock, home, task, mission, local, peers, route, cancelled, lease, advance, unit, report, failure, explorationReport };
}

test('newer final-shard unit status cannot be overwritten by an older intermediate-shard snapshot', () => {
    const w = world(); w.advance(2000);
    w.report('shard1', w.clock.now); w.report('shard2', w.clock.now - 1000);
    w.api.runShardController();
    assert.equal(w.lease().lastShard, 'shard1'); assert.equal(w.lease().locationUpdatedAt, w.clock.now);
    assert.equal(w.mission.scouting.status, 'scouting');
});

test('a newer portal acknowledgement prevents stale intermediate presence and later empty reports from falsely losing the scout', () => {
    const w = world(); w.advance(2000);
    const lease = w.lease(), name = lease.name;
    w.peers.shard1.acks.arrival = { creepName: name, fromShard: 'shard1', toShard: 'shard2', createdAt: w.clock.now, expiresAt: w.clock.now + 200000 };
    w.report('shard2', w.clock.now - 1000); w.api.runShardController();
    assert.equal(lease.lastShard, 'shard1');
    w.advance(w.policy.missingUnitGrace + 1000); w.report('shard2', w.clock.now, []); w.api.runShardController(); w.api.releaseShardCreepConfig();
    assert.equal(w.lease().name, name); assert.equal(w.mission.scouting.status, 'scouting');
});

test('a prior creep-stage local failure is accepted after the next controller refreshes the live local lease timestamp', () => {
    const w = world(true), creep = w.unit();
    w.api.runShardController();
    const publishedAt = w.clock.now + 1;
    w.local.explorationReports[w.task.key] = w.explorationReport(creep, publishedAt);
    w.advance(1000); w.api.runShardController();
    assert.equal(w.mission.exploration.status, 'failed');
    assert.equal(w.mission.exploration.lastReportAt, publishedAt);
    assert.equal(w.lease().locationUpdatedAt, w.clock.now, 'old progress cannot move the current local observation backwards');
    assert.equal(w.lease().lastShard, 'shard3');
});

test('healthy failed explorer is rearmed after cooldown with the same identity and revision, empty current-position route, and no stale failure replay', () => {
    const w = world(true), creep = w.unit(), oldData = creep.memory.data, name = creep.name, revision = w.mission.exploration.revision, generation = w.mission.generation;
    oldData.transferPreparedAt = 99; oldData.transferPreparedHop = 0; oldData.transferPreparedShard = 'shard3';
    const failed = w.explorationReport(creep, w.clock.now);
    w.local.explorationReports[w.task.key] = failed; w.api.runShardController(); w.failure(creep);
    w.api.releaseShardCreepConfig(); assert.equal(w.mission.exploration.status, 'failed');
    w.advance(w.policy.portalExploration.retryDelay); w.api.runShardController(); w.api.releaseShardCreepConfig();
    assert.equal(w.mission.exploration.status, 'exploring'); assert.equal(w.mission.exploration.revision, revision);
    assert.equal(w.mission.generation, generation); assert.equal(w.lease().name, name);
    assert.notEqual(creep.memory.data, oldData); assert.equal(creep.memory.data.done, undefined);
    assert.deepEqual(copy(creep.memory.data.route), []); assert.equal(creep.memory.data.hopIndex, 0);
    assert.equal(creep.room.name, 'W1N7'); assert.equal(creep.memory.data.transferPreparedAt, undefined);
    assert.equal(creep.memory.ready, false); assert.equal(creep.memory.working, false);
    assert.deepEqual(w.cancelled, [name]); assert.deepEqual(Object.keys(w.home.memory.creepConfig), [name]);
    assert.equal(w.exploration.acceptPortalExplorationReport(w.mission, failed, 'shard3'), false);
    assert.equal(w.mission.exploration.status, 'exploring'); assert.notEqual(w.mission.scouting.status, 'verified');
});

test('retry removes legacy distant-hostile false blocks while retaining unrelated genuine portal failures', () => {
    const w = world(true), creep = w.unit(); w.failure(creep);
    const falseHop = w.route[0], genuineHop = { ...falseHop, x: 11 };
    creep.memory.data.lastError = '探门房间存在敌对攻击单位';
    creep.memory.data.exploration.lastPosition = { shard: 'shard3', roomName: 'W1N7', x: 25, y: 1 };
    creep.memory.data.routeIssue = { hop: copy(falseHop), updatedAt: w.clock.now, message: creep.memory.data.lastError };
    w.mission.blockedPortals = [falseHop, genuineHop].map(hop => ({ hop: copy(hop), until: w.clock.now + 300000 }));
    w.advance(w.policy.portalExploration.retryDelay); w.api.runShardController();
    assert.deepEqual(copy(w.mission.blockedPortals).map(entry => entry.hop), [genuineHop]);
    assert.deepEqual(copy(creep.memory.data.exploration.excludedRooms).map(entry => entry.roomName), [genuineHop.roomName]);
});

test('legacy false blocks also refresh an active scout far route without retiring or spawning another unit', () => {
    const w = world(true), current = w.unit(), old = w.unit('historical');
    const name = w.lease().name, revision = w.mission.exploration.revision, generation = w.mission.generation;
    old.memory.data.done = true; old.memory.data.lastError = '探门房间存在敌对攻击单位';
    old.memory.data.routeIssue = { hop: copy(w.route[0]), updatedAt: w.clock.now, message: old.memory.data.lastError };
    w.mission.blockedPortals = [{ hop: copy(w.route[0]), until: w.clock.now + 300000 }];
    current.memory.data.transferPreparedAt = 99; current.memory.data.exploration.selectedPortalHop = 0;
    current.memory.data.exploration.excludedRooms = [{ shard: 'shard3', roomName: w.route[0].roomName, until: w.clock.now + 300000 }];
    w.exploration.refreshPortalExploration(w.mission);
    assert.deepEqual(copy(current.memory.data.route), []); assert.deepEqual(copy(current.memory.data.exploration.excludedRooms), []);
    assert.equal(current.memory.data.transferPreparedAt, undefined); assert.equal(current.memory.data.exploration.selectedPortalHop, undefined);
    assert.equal(current.memory.data.done, undefined); assert.equal(w.lease().name, name);
    assert.equal(w.mission.generation, generation); assert.equal(w.mission.exploration.revision, revision);
    assert.deepEqual(w.cancelled, [name]); assert.equal(w.mission.routing.nextAttemptTick, w.game.time);
});

test('legacy in-flight route is refreshed once even after old false blocks have expired', () => {
    const w = world(true), creep = w.unit(), generation = w.mission.generation;
    delete w.mission.exploration.safetyVersion;
    creep.memory.data.exploration.selectedPortalHop = 0;
    creep.memory.data.exploration.excludedRooms = [{ shard: 'shard3', roomName: 'W10N10', until: w.clock.now + 300000 }];
    w.exploration.refreshPortalExploration(w.mission);
    assert.deepEqual(copy(creep.memory.data.route), []); assert.deepEqual(w.cancelled, [creep.name]);
    assert.equal(creep.memory.data.exploration.excludedRooms[0].roomName, 'W10N10', 'unrelated timeout exclusions survive migration');
    assert.equal(w.mission.generation, generation);
    creep.memory.data.route = [copy(w.route[0])]; creep.memory.data.exploration.selectedPortalHop = 0;
    w.exploration.refreshPortalExploration(w.mission);
    assert.equal(creep.memory.data.route.length, 1); assert.deepEqual(w.cancelled, [creep.name]);
});

test('a still-threatened current healthy explorer waits without new demand, then reuses itself once safe', () => {
    const w = world(true), actual = w.unit(); w.failure(actual); actual.danger = true;
    const name = actual.name, revision = w.mission.exploration.revision, generation = w.mission.generation;
    w.advance(w.policy.portalExploration.retryDelay); w.api.runShardController(); w.api.releaseShardCreepConfig();
    assert.equal(w.mission.exploration.status, 'failed'); assert.equal(w.mission.generation, generation);
    assert.equal(w.lease().name, name); assert.deepEqual(Object.keys(w.home.memory.creepConfig), []);
    actual.danger = false; w.advance(1000); w.api.runShardController(); w.api.releaseShardCreepConfig();
    assert.equal(w.mission.exploration.status, 'exploring'); assert.equal(w.lease().name, name); assert.equal(w.mission.exploration.revision, revision);
});

test('when the current scout is gone only the longest-lived healthy historical explorer is adopted and queued aliases are removed', () => {
    const w = world(true), old = w.unit(); w.failure(old); delete w.game.creeps[old.name];
    const shorter = w.unit('historical-short', { ticksToLive: 500 }), longer = w.unit('historical-long', { ticksToLive: 1200 });
    for (const creep of [shorter, longer]) { creep.memory.data.done = true; creep.memory.data.phase = 'done'; creep.memory.data.exploration.status = 'failed'; creep.memory.name = 'unrecoverable-friendly-name'; }
    w.advance(w.policy.portalExploration.retryDelay); w.api.runShardController(); w.api.releaseShardCreepConfig();
    assert.equal(w.lease().name, longer.name); assert.equal(longer.memory.data.done, undefined); assert.equal(shorter.memory.data.done, true);
    assert.deepEqual(Object.keys(w.home.memory.creepConfig), [longer.name], 'same-revision old aliases must not generate extra scouts');
});

test('damaged and short-lived failed explorers cannot be reused as healthy retries', () => {
    for (const change of [creep => { creep.hits--; }, creep => { creep.ticksToLive = 200; }]) {
        const w = world(true), creep = w.unit(), old = creep.name; w.failure(creep); change(creep);
        w.advance(w.policy.portalExploration.retryDelay); w.api.runShardController(); w.api.releaseShardCreepConfig();
        assert.notEqual(w.lease().name, old); assert.equal(creep.memory.data.done, true);
        assert.equal(Object.keys(w.home.memory.creepConfig).length, 1);
    }
});

test('route revision cleanup removes a living obsolete scout spawn configuration while preserving its creep memory', () => {
    const w = world(), creep = w.unit(), name = creep.name, oldData = creep.memory.data;
    w.home.memory.creepSpawnQueue = [name]; w.task.route = copy(w.task.route); w.task.route[0].x++;
    w.api.runShardController(); w.api.releaseShardCreepConfig();
    assert.equal(w.home.memory.creepConfig[name], undefined); assert.equal(w.home.memory.creepSpawnQueue.includes(name), false);
    assert.equal(creep.memory.data, oldData); assert.ok(w.game.creeps[name]);
    assert.equal(Object.keys(w.home.memory.creepConfig).length, 1); assert.notEqual(w.mission.scouting.status, 'verified');
});
