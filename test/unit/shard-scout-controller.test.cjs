const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

const outward = [{ shard: 'shard0', roomName: 'W1N1', x: 10, y: 10, destinationShard: 'shard1', destinationRoom: 'W3N3' }];
const returning = [{ shard: 'shard1', roomName: 'W3N3', x: 20, y: 20, destinationShard: 'shard0', destinationRoom: 'W1N1' }];
const copy = value => JSON.parse(JSON.stringify(value));
const hopKey = hop => [hop.shard, hop.roomName, hop.x, hop.y, hop.destinationShard, hop.destinationRoom].join(':');

function position(x, y, roomName) {
    return { x, y, roomName, getRangeTo(target) {
        const pos = target.pos || target;
        return Math.max(Math.abs(this.x - pos.x), Math.abs(this.y - pos.y));
    } };
}

function world() {
    const clock = { now: 1000000 };
    const calls = [];
    const local = { version: 1, transfers: {}, acks: {}, reports: {}, scoutProofs: {} };
    const peers = { shard1: { version: 1, transfers: {}, acks: {}, reports: {}, scoutProofs: {} } };
    const plans = new Map();
    const intel = { portals: [...copy(outward), ...copy(returning)] };
    const home = {
        name: 'W1N1', my: true, level: 8, controller: { my: true, level: 8 }, energyAvailable: 3000, energyCapacityAvailable: 3000,
        memory: { creepConfig: {}, creepSpawnQueue: [] }, spawns: [], extensions: [], containers: [], sources: [], constructionSites: [], structuresNeedRepair: [],
        find(type) {
            if (type === 'my-spawns') return this.spawns;
            if (type === 'structures' || type === 'my-structures') return [...this.spawns, ...this.extensions, ...this.containers];
            if (type === 'sources') return this.sources;
            if (type === 'my-sites') return this.constructionSites;
            return [];
        },
        lookForAt: () => [],
    };
    home.spawns.push({ id: 'spawn', my: true, structureType: 'spawn', pos: position(11, 10, home.name), store: { getFreeCapacity: () => 0 } });
    const memory = { warMode: {}, creeps: {}, rooms: { [home.name]: home.memory } };
    const game = {
        time: 10, shard: { name: 'shard0' }, rooms: { [home.name]: home }, creeps: {}, structures: {}, cpu: { bucket: 10000, getUsed: () => 0 },
        getObjectById: () => undefined,
        map: { getRoomLinearDistance: () => 1, getRoomStatus: () => ({ status: 'normal', timestamp: null }), findRoute: () => [] },
    };
    const transport = {
        getLocalShardState: () => local, readRemoteShardState: shard => peers[shard], markShardStateDirty() {},
        flushInterShardMemory: () => true, restoreArrivingCreeps: () => 0, getShardTransportError: () => undefined,
        cancelCreepTransfers: creep => calls.push({ type: 'cancel-transfer', name: creep.name }),
    };
    const planKey = (sourceShard, sourceRoom, targetShard, targetRoom) => `${sourceShard}/${sourceRoom}->${targetShard}/${targetRoom}`;
    const planner = {
        planPortalRoute(sourceShard, sourceRoom, targetShard, targetRoom) {
            calls.push({ type: 'plan', sourceShard, sourceRoom, targetShard, targetRoom });
            return plans.get(planKey(sourceShard, sourceRoom, targetShard, targetRoom));
        },
        isPortalRouteKnown: (route, portals = intel.portals) => route.every(hop => portals.some(record => hopKey(record) === hopKey(hop))),
    };
    const portalIntel = {
        getKnownPortals: () => intel.portals,
        getPortalIntelStatus: () => ({ observers: 1, portals: intel.portals.length }),
        runPortalDiscovery() {},
        forgetPortal: hop => { intel.portals = intel.portals.filter(record => hopKey(record) !== hopKey(hop)); },
    };
    const loader = createSourceLoader({ globals: {
        Game: game, Memory: memory, Date: class extends Date { static now() { return clock.now; } }, InterShardMemory: {},
        RoomPosition: class { constructor(x, y, roomName) { Object.assign(this, position(x, y, roomName)); } },
        WORK: 'work', CARRY: 'carry', MOVE: 'move', CLAIM: 'claim', ATTACK: 'attack', HEAL: 'heal', TOUGH: 'tough', RANGED_ATTACK: 'ranged_attack',
        BODYPART_COST: { work: 100, carry: 50, move: 50, claim: 600 }, RESOURCE_ENERGY: 'energy',
        FIND_MY_SPAWNS: 'my-spawns', FIND_STRUCTURES: 'structures', FIND_MY_STRUCTURES: 'my-structures', FIND_SOURCES: 'sources', FIND_DROPPED_RESOURCES: 'dropped', FIND_MY_CONSTRUCTION_SITES: 'my-sites',
        STRUCTURE_SPAWN: 'spawn', STRUCTURE_EXTENSION: 'extension', STRUCTURE_OBSERVER: 'observer', STRUCTURE_PORTAL: 'portal', STRUCTURE_RAMPART: 'rampart', STRUCTURE_WALL: 'constructedWall',
        OBSERVER_RANGE: 10, LOOK_STRUCTURES: 'structures', OK: 0, ERR_NOT_IN_RANGE: -9, ERR_GCL_NOT_ENOUGH: -15, ERR_NO_PATH: -2, ERR_TIRED: -11,
    }, modules: {
        utils: { sha1String: value => createHash('sha1').update(value).digest('hex') }, role: { isRoleSupported: () => true },
        './transport': transport, 'shard/transport': transport,
        './portalIntel': portalIntel, 'shard/portalIntel': portalIntel,
        './routePlanner': planner, 'shard/routePlanner': planner,
        './travel': { travelPortalRoute: () => ({ status: 'waiting', message: 'test portal travel' }) },
    } });
    const api = loader.load('shard/controller');
    const routing = loader.load('shard/routing');
    const policy = loader.load('settings/interShard').interShardPolicy;
    policy.reportInterval = 1;
    plans.set(planKey('shard0', 'W1N1', 'shard1', 'W3N3'), { route: copy(outward), cost: 1 });
    plans.set(planKey('shard1', 'W3N3', 'shard0', 'W1N1'), { route: copy(returning), cost: 1 });
    return { loader, game, clock, memory, home, local, peers, plans, intel, calls, api, routing, policy, planKey,
        mission: () => Object.values(memory.shardMissions || {})[0],
        advance(ticks = 1) { game.time += ticks; clock.now += ticks * 1000; },
        configs: () => Object.values(home.memory.creepConfig),
        create(overrides = {}) {
            return api.createShardTask({ id: 'settle', sourceRoom: 'W1N1', targetShard: 'shard1', targetRoom: 'W3N3', claim: true, builders: 2, haulers: 1, ...overrides });
        },
    };
}

function dispatch(w) { w.api.runShardController(); w.api.releaseShardCreepConfig(); }

function scoutLease(w) { return Object.values(w.mission().leases).find(lease => lease.kind === 'scout'); }
function workConfigs(w) { return w.configs().filter(config => config.role !== 'sScout'); }

function ready(w, overrides = {}) {
    assert.match(w.create(overrides), /已创建/);
    dispatch(w);
    assert.equal(w.mission().routing.status, 'ready');
    return w.mission();
}

function proof(w, leg = 'outbound', overrides = {}) {
    const mission = w.mission();
    const lease = scoutLease(w);
    assert.ok(lease, 'the proof must be tied to an actual dispatched scout lease');
    const outbound = leg === 'outbound';
    return {
        missionId: mission.task.key, sourceShard: mission.task.sourceShard, scoutName: lease.name,
        revision: mission.scouting.revision, leg, result: 'verified',
        route: copy(outbound ? mission.task.route : mission.task.returnRoute),
        shard: outbound ? mission.task.targetShard : mission.task.sourceShard,
        roomName: outbound ? mission.task.targetRoom : mission.task.sourceRoom,
        updatedAt: w.clock.now, elapsedTicks: 100, ...overrides,
    };
}

function publish(w, record, shard = record.shard) {
    const envelope = shard === w.game.shard.name ? w.local : (w.peers[shard] || (w.peers[shard] = { version: 1, transfers: {}, acks: {}, reports: {}, scoutProofs: {} }));
    envelope.scoutProofs[`${w.mission().task.key}:${record.leg}`] = record;
}

test('an automatic ready route dispatches one scout and no work before live verification', () => {
    const w = world();
    const mission = ready(w);
    assert.equal(mission.task.verifyRoute, true);
    assert.equal(mission.scouting.status, 'scouting');
    assert.deepEqual(w.configs().map(config => config.role), ['sScout']);
    assert.equal(Object.keys(mission.leases).length, 1);
    const data = w.configs()[0].data;
    assert.equal(data.scouting.revision, mission.scouting.revision);
    assert.deepEqual(copy(data.scouting.outboundRoute), outward);
    assert.deepEqual(copy(data.scouting.returnRoute), returning);
    w.advance(); dispatch(w);
    assert.equal(Object.keys(mission.leases).length, 1);
    assert.equal(workConfigs(w).length, 0);
});

test('round trips wait for target and source proofs from the same scout revision', () => {
    const w = world();
    const mission = ready(w);
    const lease = scoutLease(w);
    publish(w, proof(w));
    w.advance(); dispatch(w);
    assert.equal(mission.scouting.outbound, true);
    assert.notEqual(mission.scouting.status, 'verified');
    assert.equal(workConfigs(w).length, 0);
    publish(w, proof(w, 'return'));
    w.advance(); dispatch(w);
    assert.equal(mission.scouting.status, 'verified');
    assert.equal(mission.scouting.returning, true);
    assert.equal(workConfigs(w).length, 4);
    assert.deepEqual(workConfigs(w).map(config => config.role).sort(), ['sBuilder', 'sBuilder', 'sClaimer', 'sHauler']);
    assert.equal(scoutLease(w).name, lease.name);
    w.advance(); dispatch(w);
    assert.equal(workConfigs(w).length, 4, 'successful verification must survive subsequent maintenance ticks');
    assert.equal(scoutLease(w).name, lease.name);
});

test('one-way automatic missions require only a target proof', () => {
    const w = world();
    const mission = ready(w, { roundTrip: false });
    assert.equal(mission.task.returnRoute, undefined);
    publish(w, proof(w));
    w.advance(); dispatch(w);
    assert.equal(mission.scouting.status, 'verified');
    assert.equal(workConfigs(w).length, 4);
});

test('explicit opt-out preserves direct work dispatch and fixed routes can opt into scouts', () => {
    const disabled = world();
    ready(disabled, { verifyRoute: false });
    assert.equal(scoutLease(disabled), undefined);
    assert.equal(workConfigs(disabled).length, 4);
    const manual = world();
    assert.match(manual.create({ route: copy(outward), returnRoute: copy(returning) }), /已创建/);
    dispatch(manual);
    assert.equal(scoutLease(manual), undefined);
    assert.equal(workConfigs(manual).length, 4);
    const enabled = world();
    assert.match(enabled.create({ route: copy(outward), returnRoute: copy(returning), verifyRoute: true }), /已创建/);
    dispatch(enabled);
    assert.equal(workConfigs(enabled).length, 0);
    assert.equal(enabled.configs()[0].role, 'sScout');
});

test('unknown routes dispatch no scout when active portal exploration is explicitly disabled', () => {
    const w = world();
    w.plans.clear(); w.intel.portals = [];
    assert.match(w.create({ explorePortals: false }), /已创建/);
    dispatch(w);
    assert.equal(w.mission().routing.status, 'waiting');
    assert.equal(w.configs().length, 0);
    assert.equal(Object.keys(w.mission().leases).length, 0);
});

test('proof identity, exact route, leg endpoint and timestamp bounds cannot be forged by stale envelopes', async t => {
    const cases = {
        'different mission': (w, p) => { p.missionId = 'shard0:other'; },
        'different source': (w, p) => { p.sourceShard = 'shard2'; },
        'different scout': (w, p) => { p.scoutName += '-old'; },
        'different revision': (w, p) => { p.revision += '-old'; },
        'different entrance coordinate': (w, p) => { p.route[0].x++; },
        'different destination room': (w, p) => { p.route[0].destinationRoom = 'W4N4'; },
        'different endpoint shard': (w, p) => { p.shard = 'shard2'; },
        'different endpoint room': (w, p) => { p.roomName = 'W4N4'; },
        'future timestamp': (w, p) => { p.updatedAt = w.clock.now + 1; },
        'predates lease': (w, p) => { p.updatedAt = scoutLease(w).createdAt - 1; },
        'expired proof': (w, p) => { w.clock.now += w.policy.routeScouting.proofMaxAge + 1; },
        'wrong leg in outbound slot': (w, p) => { p.leg = 'return'; },
        'wrong publishing shard': (w, p) => { p.publisher = 'shard2'; },
    };
    for (const [name, mutate] of Object.entries(cases)) await t.test(name, () => {
        const w = world(); ready(w, { roundTrip: false });
        const candidate = proof(w);
        mutate(w, candidate);
        const publisher = candidate.publisher || 'shard1';
        delete candidate.publisher;
        w.peers[publisher] ||= { version: 1, transfers: {}, acks: {}, reports: {}, scoutProofs: {} };
        w.peers[publisher].scoutProofs[`${w.mission().task.key}:outbound`] = candidate;
        dispatch(w);
        assert.equal(workConfigs(w).length, 0);
        assert.notEqual(w.mission().scouting.status, 'verified');
    });
});

test('a return proof naming the remote target does not complete a round trip', () => {
    const w = world(); ready(w);
    publish(w, proof(w));
    publish(w, proof(w, 'return', { shard: 'shard1', roomName: 'W3N3' }), 'shard1');
    w.advance(); dispatch(w);
    assert.equal(w.mission().scouting.outbound, true);
    assert.equal(workConfigs(w).length, 0);
    assert.notEqual(w.mission().scouting.status, 'verified');
});

test('changed routes invalidate old proofs and issue a new scout revision', () => {
    const w = world(); const mission = ready(w, { roundTrip: false });
    const oldProof = proof(w); const oldLease = scoutLease(w); const oldRevision = mission.scouting.revision;
    const alternate = copy(outward); alternate[0].x++;
    w.intel.portals = alternate;
    w.plans.set(w.planKey('shard0', 'W1N1', 'shard1', 'W3N3'), { route: copy(alternate), cost: 1 });
    publish(w, oldProof);
    w.advance(w.policy.portalRouting.retryInterval); dispatch(w);
    assert.deepEqual(copy(mission.task.route), alternate);
    assert.notEqual(mission.scouting.revision, oldRevision);
    assert.notEqual(scoutLease(w).name, oldLease.name);
    assert.equal(workConfigs(w).length, 0);
    assert.deepEqual(w.configs().map(config => config.role), ['sScout']);
});

test('a failed scout cannot dispatch work and is retried after the configured delay', () => {
    const w = world(); const mission = ready(w, { roundTrip: false });
    const oldRevision = mission.scouting.revision;
    publish(w, proof(w, 'outbound', { result: 'failed', message: 'portal entrance blocked' }));
    w.advance(); dispatch(w);
    assert.equal(mission.scouting.status, 'failed');
    assert.equal(workConfigs(w).length, 0);
    assert.equal(w.configs().length, 0);
    const retryAt = mission.scouting.retryAt;
    assert.ok(retryAt > w.clock.now);
    w.clock.now = retryAt - 1; w.game.time++; dispatch(w);
    assert.equal(w.configs().length, 0);
    w.clock.now = retryAt; w.game.time++; dispatch(w);
    assert.notEqual(mission.scouting.revision, oldRevision);
    assert.equal(w.configs()[0].role, 'sScout');
    assert.equal(workConfigs(w).length, 0);
});

test('expired scout leases enter retry backoff instead of releasing work', () => {
    const w = world(); const mission = ready(w, { roundTrip: false });
    scoutLease(w).expiresAt = w.clock.now - 1;
    w.advance(); dispatch(w);
    assert.equal(mission.scouting.status, 'failed');
    assert.equal(workConfigs(w).length, 0);
    assert.equal(w.configs().length, 0);
    assert.ok(mission.scouting.retryAt > w.clock.now);
});

test('a scout seen alive at source and subsequently missing is retried instead of treated as verified', () => {
    const w = world(); const mission = ready(w, { roundTrip: false });
    const lease = scoutLease(w);
    lease.seenAt = w.clock.now;
    lease.lastShard = w.game.shard.name; lease.leaving = false; lease.departed = false;
    w.advance(Math.ceil(w.policy.missingUnitGrace / 1000) + 1); dispatch(w);
    assert.equal(mission.scouting.status, 'failed');
    assert.equal(workConfigs(w).length, 0);
    assert.equal(w.configs().length, 0);
    assert.ok(mission.scouting.retryAt > w.clock.now);
});

test('scouting wall-clock timeout enters retry backoff even while its lease has time remaining', () => {
    const w = world(); const mission = ready(w, { roundTrip: false });
    mission.scouting.startedAt = w.clock.now - w.policy.routeScouting.maximumScoutingAge - 1;
    w.advance(); dispatch(w);
    assert.equal(mission.scouting.status, 'failed');
    assert.equal(workConfigs(w).length, 0);
    assert.equal(w.configs().length, 0);
    assert.ok(mission.scouting.retryAt > w.clock.now);
});

test('expired successful verification cannot keep publishing queued workers indefinitely', () => {
    const w = world(); const mission = ready(w, { roundTrip: false });
    publish(w, proof(w));
    w.advance(); dispatch(w);
    assert.equal(workConfigs(w).length, 4);
    w.clock.now += w.policy.routeScouting.proofMaxAge + 1;
    w.game.time++; dispatch(w);
    assert.notEqual(mission.scouting.status, 'verified');
    assert.equal(workConfigs(w).length, 0);
});

test('the default six-hour certificate keeps unchanged routes available after 45 minutes and two hours', async t => {
    for (const [label, elapsed] of [['45 minutes', 45 * 60 * 1000], ['two hours', 2 * 60 * 60 * 1000]]) await t.test(label, () => {
        const w = world(); const mission = ready(w, { roundTrip: false });
        assert.equal(w.policy.routeScouting.proofMaxAge, 6 * 60 * 60 * 1000, 'exercise the production default rather than a fixture override');
        publish(w, proof(w)); w.advance(); dispatch(w);
        const revision = mission.scouting.revision, verifiedAt = mission.scouting.verifiedAt, scoutName = scoutLease(w).name;
        assert.equal(workConfigs(w).length, 4);
        w.advance(elapsed / 1000);
        // Population rebuilds demand before release; after two hours the expired worker leases get replacement names.
        w.home.memory.creepConfig = {}; dispatch(w);
        assert.equal(mission.scouting.status, 'verified'); assert.equal(mission.scouting.revision, revision);
        assert.equal(mission.scouting.verifiedAt, verifiedAt, 'reusing a certificate must not make its original evidence look newer');
        assert.equal(workConfigs(w).length, 4, 'replacement work remains publishable throughout the reuse interval');
        assert.equal(w.configs().some(config => config.role === 'sScout'), false);
        assert.equal(scoutLease(w).name, scoutName, 'routine certificate age must not allocate another scout');
        assert.equal(w.local.reports[mission.task.key].verification.verifiedAt, verifiedAt);
        assert.deepEqual(copy(w.local.reports[mission.task.key].verification.route), outward);
    });
});

test('a remotely departed scout is not treated as dead just because it left source Game.creeps', () => {
    const w = world(); const mission = ready(w, { roundTrip: false });
    const lease = scoutLease(w);
    lease.seenAt = w.clock.now;
    lease.lastShard = 'shard1'; lease.departed = true;
    w.advance(Math.ceil(w.policy.missingUnitGrace / 1000) + 1); dispatch(w);
    assert.equal(scoutLease(w).name, lease.name);
    assert.equal(mission.scouting.status, 'scouting');
    assert.equal(workConfigs(w).length, 0);
});

test('late valid proofs cannot reactivate paused or cancelled missions', async t => {
    for (const state of ['paused', 'cancelled']) await t.test(state, () => {
        const w = world(); const mission = ready(w, { roundTrip: false });
        const record = proof(w);
        assert.match(w.api.setShardTaskState('settle', state), new RegExp(state));
        publish(w, record);
        w.advance(); dispatch(w);
        assert.equal(mission.state, state);
        assert.equal(w.configs().length, 0);
        assert.equal(w.home.memory.creepSpawnQueue.length, 0);
    });
});

test('invalid verifyRoute values are rejected at task creation', () => {
    const w = world();
    assert.doesNotMatch(w.create({ verifyRoute: 'true' }), /已创建/);
    assert.equal(w.mission(), undefined);
});

test('a verified worker cannot replace its approved route with an unscouted alternative', () => {
    const w = world(); ready(w, { roundTrip: false });
    publish(w, proof(w));
    w.advance(); dispatch(w);
    const config = workConfigs(w)[0];
    const data = copy(config.data);
    const approved = copy(data.route);
    const alternate = copy(outward); alternate[0].x++;
    w.intel.portals = alternate;
    w.plans.set(w.planKey('shard0', 'W1N1', 'shard1', 'W3N3'), { route: copy(alternate), cost: 1 });
    const creep = { name: 'approved-worker', room: w.home, memory: { role: config.role, data } };
    assert.equal(w.routing.ensureUnitRoute(creep, data, true, approved[0]), false);
    assert.deepEqual(copy(data.route), approved);
});

test('a new failure at an old blocked hop refreshes its report after route verification was renewed', () => {
    const w = world(); ready(w, { roundTrip: false });
    publish(w, proof(w));
    w.advance(); dispatch(w);
    const config = workConfigs(w)[0];
    const data = copy(config.data);
    data.routeIssue = { hop: copy(data.route[0]), updatedAt: w.mission().scouting.verifiedAt - 1, message: 'previous portal failure' };
    w.advance();
    const creep = { name: 'approved-worker', room: w.home, memory: { role: config.role, data } };
    assert.equal(w.routing.ensureUnitRoute(creep, data, true, data.route[0]), false);
    assert.equal(data.routeIssue.updatedAt, w.clock.now, 'this failure must not retain an older certificate-era timestamp');
    assert.ok(data.routeIssue.updatedAt > w.mission().scouting.verifiedAt);
});

test('a remote worker failure revokes its certificate until a new scout proves the alternative route', () => {
    const w = world(); const mission = ready(w, { roundTrip: false });
    publish(w, proof(w));
    w.advance(); dispatch(w);
    const oldRevision = mission.scouting.revision;
    const config = workConfigs(w).find(config => config.role === 'sClaimer');
    const data = copy(config.data);
    const lease = Object.values(mission.leases).find(lease => lease.kind === 'claimer');
    w.advance();
    w.peers.shard1.reports[mission.task.key] = {
        type: 'status', missionId: mission.task.key, originShard: 'shard0', shard: 'shard1',
        updatedAt: w.clock.now, energyDelivered: 0, targetOwned: false, targetLevel: 0, targetSpawns: 0,
        units: [{ name: lease.name, kind: 'claimer', done: false,
            routeIssue: { hop: copy(outward[0]), updatedAt: w.clock.now, message: 'observed missing portal' } }],
    };
    dispatch(w);
    assert.equal(mission.scouting.status, 'failed');
    assert.equal(workConfigs(w).length, 0);
    assert.equal(w.local.reports[mission.task.key].verification, undefined);
    const alternate = copy(outward); alternate[0].x++;
    w.intel.portals.push(...copy(alternate));
    w.plans.set(w.planKey('shard0', 'W1N1', 'shard1', 'W3N3'), { route: copy(alternate), cost: 1 });
    w.advance(Math.ceil(w.policy.routeScouting.retryDelay / 1000)); dispatch(w);
    assert.notEqual(mission.scouting.revision, oldRevision);
    assert.deepEqual(copy(mission.task.route), alternate);
    assert.deepEqual(w.configs().map(config => config.role), ['sScout']);
    assert.equal(w.local.reports[mission.task.key].verification, undefined);
    publish(w, proof(w));
    w.advance(); dispatch(w);
    assert.equal(mission.scouting.status, 'verified');
    assert.deepEqual(copy(w.local.reports[mission.task.key].verification.route), alternate);
    assert.ok(workConfigs(w).length > 0);
    const creep = { name: lease.name, room: w.home, memory: { role: config.role, data } };
    assert.equal(w.routing.ensureUnitRoute(creep, data, true, outward[0]), true);
    assert.deepEqual(copy(data.route), alternate);
    assert.equal(data.routeIssue, undefined);
});

test('route changes withdraw queued workers during the controller tick before population refresh', () => {
    const w = world(); const mission = ready(w, { roundTrip: false });
    publish(w, proof(w));
    w.advance(); dispatch(w);
    const workerName = Object.entries(w.home.memory.creepConfig).find(([, config]) => config.role === 'sClaimer')[0];
    const workerLease = Object.values(mission.leases).find(lease => lease.name === workerName);
    assert.ok(workerLease);
    w.home.memory.creepConfig.unrelated = { role: 'harvester', data: {} };
    w.home.memory.creepSpawnQueue.push(workerName, 'unrelated');
    const alternate = copy(outward); alternate[0].x++;
    w.intel.portals = alternate;
    w.plans.set(w.planKey('shard0', 'W1N1', 'shard1', 'W3N3'), { route: copy(alternate), cost: 1 });
    w.advance(w.policy.portalRouting.retryInterval);
    assert.notEqual(w.game.time % 5, 0, 'population refresh must not run in this fixture tick');
    w.api.runShardController();
    assert.deepEqual(copy(mission.task.route), alternate);
    assert.notEqual(mission.scouting.status, 'verified');
    assert.equal(w.home.memory.creepConfig[workerName], undefined);
    assert.equal(w.home.memory.creepSpawnQueue.includes(workerName), false);
    assert.ok(w.home.memory.creepConfig.unrelated);
    assert.equal(w.home.memory.creepSpawnQueue.includes('unrelated'), true);
});

test('expired proofs withdraw queued workers during the controller tick before population refresh', () => {
    const w = world(); const mission = ready(w, { roundTrip: false });
    publish(w, proof(w));
    w.advance(); dispatch(w);
    const workerName = Object.entries(w.home.memory.creepConfig).find(([, config]) => config.role === 'sClaimer')[0];
    w.home.memory.creepSpawnQueue.push(workerName);
    w.clock.now += w.policy.routeScouting.proofMaxAge + 1;
    w.game.time++;
    assert.notEqual(w.game.time % 5, 0, 'population refresh must not run in this fixture tick');
    w.api.runShardController();
    assert.notEqual(mission.scouting.status, 'verified');
    assert.equal(w.home.memory.creepConfig[workerName], undefined);
    assert.equal(w.home.memory.creepSpawnQueue.includes(workerName), false);
});
