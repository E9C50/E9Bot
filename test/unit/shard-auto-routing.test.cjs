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

function roomCoordinates(roomName) {
    const match = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);
    return [match[1] === 'E' ? Number(match[2]) : -Number(match[2]) - 1,
        match[3] === 'S' ? Number(match[4]) : -Number(match[4]) - 1];
}

function world({ realIntel = false } = {}) {
    const clock = { now: 1000000 };
    const calls = [];
    const local = { version: 1, transfers: {}, acks: {}, reports: {} };
    const peers = {};
    const plans = new Map();
    const intel = { portals: [], observers: 0 };
    const objects = {};
    const home = {
        name: 'W1N1', my: true, level: 8, controller: { my: true, level: 8 }, energyAvailable: 3000, energyCapacityAvailable: 3000,
        memory: { creepConfig: {}, creepSpawnQueue: [] }, spawns: [], extensions: [], containers: [], sources: [], constructionSites: [], structuresNeedRepair: [],
        find(type) {
            if (type === 'my-spawns') return this.spawns;
            if (type === 'structures' || type === 'my-structures') return [...this.spawns, ...this.extensions, ...this.containers, ...(this.observer ? [this.observer] : []), ...(this.portals || [])];
            if (type === 'sources') return this.sources;
            if (type === 'my-sites') return this.constructionSites;
            return [];
        },
        lookForAt(type, x, y) { return (this.portals || []).filter(portal => portal.pos.x === x && portal.pos.y === y); },
    };
    home.spawns.push({ id: 'spawn', my: true, structureType: 'spawn', pos: position(11, 10, home.name), store: { getFreeCapacity: () => 0 } });
    const memory = { warMode: {}, creeps: {}, rooms: { [home.name]: home.memory } };
    const game = {
        time: 10, shard: { name: 'shard0' }, rooms: { [home.name]: home }, creeps: {}, structures: {}, cpu: { bucket: 10000, getUsed: () => 0 },
        getObjectById: id => objects[id],
        map: {
            getRoomLinearDistance(first, second) {
                const a = roomCoordinates(first); const b = roomCoordinates(second);
                return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
            },
            getRoomStatus: () => ({ status: 'normal', timestamp: null }),
            findRoute: (first, second) => first === second ? [] : [{ exit: 1, room: second }],
        },
    };
    const transport = {
        getLocalShardState: () => local, readRemoteShardState: shard => peers[shard], markShardStateDirty() {},
        flushInterShardMemory: () => true, restoreArrivingCreeps: () => 0, getShardTransportError: () => undefined,
        cancelCreepTransfers: creep => calls.push({ type: 'cancel-transfer', name: creep.name, missionId: creep.memory.data.missionId }),
    };
    const planKey = (sourceShard, sourceRoom, targetShard, targetRoom) => `${sourceShard}/${sourceRoom}->${targetShard}/${targetRoom}`;
    const planner = {
        planPortalRoute(sourceShard, sourceRoom, targetShard, targetRoom, portals) {
            calls.push({ type: 'plan', sourceShard, sourceRoom, targetShard, targetRoom });
            const plan = plans.get(planKey(sourceShard, sourceRoom, targetShard, targetRoom));
            return typeof plan === 'function' ? plan(portals) : plan;
        },
        isPortalRouteKnown: route => route.every(hop => intel.portals.some(record => hopKey(record) === hopKey(hop))),
    };
    const portalIntel = {
        getKnownPortals: () => intel.portals,
        getPortalIntelStatus: () => ({ observers: intel.observers, portals: intel.portals.length }),
        runPortalDiscovery: () => calls.push({ type: 'discovery' }),
        forgetPortal(hop) {
            calls.push({ type: 'forget', hop });
            intel.portals = intel.portals.filter(record => hopKey(record) !== hopKey(hop));
        },
    };
    const travel = { result: { status: 'waiting', message: 'test portal travel' } };
    const modules = {
        utils: { sha1String: value => createHash('sha1').update(value).digest('hex') }, role: { isRoleSupported: () => true },
        './transport': transport, 'shard/transport': transport,
        './travel': { travelPortalRoute: () => { calls.push({ type: 'travel' }); return travel.result; } },
    };
    if (!realIntel) Object.assign(modules, { './portalIntel': portalIntel, 'shard/portalIntel': portalIntel, './routePlanner': planner, 'shard/routePlanner': planner });
    const loader = createSourceLoader({ globals: {
        Game: game, Memory: memory, Date: class extends Date { static now() { return clock.now; } }, InterShardMemory: {},
        RoomPosition: class { constructor(x, y, roomName) { Object.assign(this, position(x, y, roomName)); } },
        WORK: 'work', CARRY: 'carry', MOVE: 'move', CLAIM: 'claim', ATTACK: 'attack', HEAL: 'heal', TOUGH: 'tough', RANGED_ATTACK: 'ranged_attack',
        BODYPART_COST: { work: 100, carry: 50, move: 50, claim: 600 }, RESOURCE_ENERGY: 'energy',
        FIND_MY_SPAWNS: 'my-spawns', FIND_STRUCTURES: 'structures', FIND_MY_STRUCTURES: 'my-structures', FIND_SOURCES: 'sources', FIND_DROPPED_RESOURCES: 'dropped', FIND_MY_CONSTRUCTION_SITES: 'my-sites',
        STRUCTURE_SPAWN: 'spawn', STRUCTURE_EXTENSION: 'extension', STRUCTURE_OBSERVER: 'observer', STRUCTURE_PORTAL: 'portal', STRUCTURE_RAMPART: 'rampart', STRUCTURE_WALL: 'constructedWall',
        OBSERVER_RANGE: 10, LOOK_STRUCTURES: 'structures', OK: 0, ERR_NOT_IN_RANGE: -9, ERR_GCL_NOT_ENOUGH: -15, ERR_NO_PATH: -2, ERR_TIRED: -11,
    }, modules });
    const api = loader.load('shard/controller');
    const routing = loader.load('shard/routing');
    const workers = loader.load('shard/workers');
    const policy = loader.load('settings/interShard').interShardPolicy;
    policy.reportInterval = 1;
    return { loader, game, memory, home, objects, local, peers, plans, intel, calls, travel, api, routing, workers, policy,
        mission: () => Object.values(memory.shardMissions || {})[0],
        advance(ticks = 1) { game.time += ticks; clock.now += ticks * 1000; },
        plan(sourceShard, sourceRoom, targetShard, targetRoom, route, cost = 1) { plans.set(planKey(sourceShard, sourceRoom, targetShard, targetRoom), { route: copy(route), cost }); },
    };
}

function task(overrides = {}) {
    return { id: 'settle', key: 'shard0:settle', sourceShard: 'shard0', sourceRoom: 'W1N1', targetShard: 'shard1', targetRoom: 'W3N3',
        route: copy(outward), returnRoute: copy(returning), autoRoute: true, autoReturn: true,
        claim: true, builders: 2, haulers: 1, targetLevel: 4, energyAmount: 0, homeEnergyReserve: 10000, verifyRoute: false, explorePortals: false, ...overrides };
}

function unit(w, kind, options = {}) {
    const spec = task(options.task);
    const data = { missionId: spec.key, task: spec, unitKind: kind, originShard: spec.sourceShard, route: copy(spec.route), hopIndex: 0, phase: 'outbound', ...options.data };
    const activeRoom = { ...w.home, name: options.roomName || 'W2N2', controller: { my: true, level: 1, pos: position(10, 10, options.roomName || 'W2N2'), ticksToDowngrade: 10000 } };
    const store = { energy: options.energy || 0, getCapacity: () => 100, getFreeCapacity: () => 100 - store.energy };
    const creep = { name: 'support', id: 'support-id', my: true, spawning: false, owner: { username: 'me' }, ticksToLive: 1400,
        pos: position(10, 10, activeRoom.name), room: activeRoom, store, memory: { role: { claimer: 'sClaimer', builder: 'sBuilder', hauler: 'sHauler' }[kind], data, working: true },
        moveTo: target => { w.calls.push({ type: 'move', target }); return 0; },
        claimController: target => { w.calls.push({ type: 'claim', target }); return 0; },
        build: target => { w.calls.push({ type: 'build', target }); return 0; },
        transfer: target => { w.calls.push({ type: 'transfer', target }); return 0; },
        upgradeController: target => { w.calls.push({ type: 'upgrade', target }); return 0; },
        harvest: target => { w.calls.push({ type: 'harvest', target }); return 0; },
        getActiveBodyparts: () => kind === 'builder' ? 1 : 0,
    };
    w.game.creeps[creep.name] = creep;
    return { creep, data, behavior: w.workers.createShardRole(kind)(data) };
}

test('short form creates an idempotent auto-route task and publishes no units while routes are unknown', () => {
    const w = world();
    assert.match(w.api.createShardTask('W1N1', 'shard1/W3N3', { haulers: 1, explorePortals: false }), /已创建/);
    const mission = w.mission();
    assert.ok(mission.task.id);
    assert.equal(mission.task.autoRoute, true);
    assert.equal(mission.task.autoReturn, true);
    assert.equal(mission.routing.status, 'waiting');
    assert.match(mission.routing.message, /Observer/);
    w.api.releaseShardCreepConfig();
    assert.equal(Object.keys(mission.leases).length, 0);
    assert.equal(Object.keys(w.home.memory.creepConfig).length, 0);
    assert.match(w.api.createShardTask('W1N1', 'shard1/W3N3', { haulers: 1, explorePortals: false }), /已存在/);
    assert.equal(Object.keys(w.memory.shardMissions).length, 1);
});

test('object form permits omitted id and route while automatic haulers wait for an independent return route', () => {
    const w = world();
    w.intel.portals = copy(outward);
    w.plan('shard0', 'W1N1', 'shard1', 'W3N3', outward);
    assert.match(w.api.createShardTask({ sourceRoom: 'W1N1', targetShard: 'shard1', targetRoom: 'W3N3', claim: false, builders: 0, haulers: 1, verifyRoute: false, explorePortals: false }), /已创建/);
    assert.equal(w.mission().task.route.length, 1);
    assert.equal(w.mission().routing.status, 'waiting');
    assert.match(w.mission().routing.message, /返程/);
    w.api.releaseShardCreepConfig();
    assert.equal(Object.keys(w.mission().leases).length, 0);
    w.intel.portals.push(...copy(returning));
    w.plan('shard1', 'W3N3', 'shard0', 'W1N1', returning);
    w.advance(w.policy.portalRouting.retryInterval);
    w.api.runShardController();
    w.api.releaseShardCreepConfig();
    assert.equal(w.mission().routing.status, 'ready');
    assert.deepEqual(copy(w.mission().task.returnRoute), returning);
    assert.equal(Object.values(w.home.memory.creepConfig)[0].role, 'sHauler');
});

test('explicit legacy routes stay one-way and roundTrip false allows automatic one-way dispatch', () => {
    const manual = world();
    manual.api.createShardTask({ id: 'manual', sourceRoom: 'W1N1', targetShard: 'shard1', targetRoom: 'W3N3', route: outward, claim: false, builders: 0, haulers: 1 });
    assert.equal(manual.mission().task.autoRoute, false);
    assert.equal(manual.mission().task.autoReturn, false);
    assert.equal(manual.mission().task.returnRoute, undefined);
    manual.api.releaseShardCreepConfig();
    assert.equal(Object.keys(manual.home.memory.creepConfig).length, 1);
    assert.equal(manual.calls.some(call => call.type === 'plan'), false);

    const automatic = world();
    automatic.intel.portals = copy(outward);
    automatic.plan('shard0', 'W1N1', 'shard1', 'W3N3', outward);
    automatic.api.createShardTask('shard0/W1N1', 'shard1/W3N3', { claim: false, builders: 0, haulers: 1, roundTrip: false, verifyRoute: false, explorePortals: false });
    assert.equal(automatic.mission().routing.status, 'ready');
    assert.equal(automatic.mission().task.autoReturn, false);
    automatic.api.releaseShardCreepConfig();
    assert.equal(Object.keys(automatic.home.memory.creepConfig).length, 1);
});

test('changing to nearest-hop routing migrates a known ready task and withdraws its old verified dispatch', () => {
    const w = world(); w.policy.portalRouting.strategy = 'totalCost';
    const far = [{ ...outward[0], roomName: 'W10N10' }];
    w.intel.portals = [...copy(far), ...copy(outward)];
    w.plan('shard0', 'W1N1', 'shard1', 'W3N3', far);
    w.api.createShardTask('W1N1', 'shard1/W3N3', { builders: 0, explorePortals: false });
    w.api.releaseShardCreepConfig();
    const mission = w.mission(), oldRevision = mission.scouting.revision;
    Object.assign(mission.scouting, { status: 'verified', outbound: true, verifiedAt: w.loader.globals.Date.now() });
    w.api.releaseShardCreepConfig();
    const oldWorker = Object.keys(w.home.memory.creepConfig).find(name => w.home.memory.creepConfig[name].role === 'sClaimer');
    assert.ok(oldWorker);
    assert.match(mission.routing.portalSignature, /^totalCost:/);
    w.policy.portalRouting.strategy = 'nearestHop';
    w.plan('shard0', 'W1N1', 'shard1', 'W3N3', outward);
    w.advance(w.policy.portalRouting.retryInterval); w.api.runShardController();
    assert.deepEqual(copy(mission.task.route), outward);
    assert.match(mission.routing.portalSignature, /^nearestHop:/);
    assert.notEqual(mission.scouting.revision, oldRevision);
    assert.equal(mission.scouting.status, 'pending');
    assert.equal(w.home.memory.creepConfig[oldWorker], undefined);
    w.api.releaseShardCreepConfig();
    assert.deepEqual(Object.values(w.home.memory.creepConfig).map(config => config.role), ['sScout']);
});

for (const missingLeg of ['outbound', 'return']) test(`a deferred ${missingLeg} plan cannot mark the old route's strategy migration complete`, () => {
    const w = world(); w.policy.portalRouting.strategy = 'totalCost';
    const far = [{ ...outward[0], roomName: 'W10N10' }];
    const nextReturn = [{ ...returning[0], x: 21 }];
    w.intel.portals = [...copy(far), ...copy(outward), ...copy(returning), ...copy(nextReturn)];
    w.plan('shard0', 'W1N1', 'shard1', 'W3N3', far);
    w.plan('shard1', 'W3N3', 'shard0', 'W1N1', returning);
    w.api.createShardTask('W1N1', 'shard1/W3N3', { builders: 0, haulers: 1, verifyRoute: false, explorePortals: false });
    const mission = w.mission(), oldSignature = mission.routing.portalSignature;
    w.policy.portalRouting.strategy = 'nearestHop';
    w.plan('shard0', 'W1N1', 'shard1', 'W3N3', outward);
    w.plan('shard1', 'W3N3', 'shard0', 'W1N1', nextReturn);
    const missingKey = missingLeg === 'outbound' ? 'shard0/W1N1->shard1/W3N3' : 'shard1/W3N3->shard0/W1N1';
    w.plans.delete(missingKey);
    w.advance(w.policy.portalRouting.retryInterval); w.routing.updateMissionRouting(mission);
    assert.equal(mission.routing.portalSignature, oldSignature, 'an internal planner deferral must remain eligible for retry');
    if (missingLeg === 'outbound') w.plan('shard0', 'W1N1', 'shard1', 'W3N3', outward);
    else w.plan('shard1', 'W3N3', 'shard0', 'W1N1', nextReturn);
    w.advance(w.policy.portalRouting.retryInterval); w.routing.updateMissionRouting(mission);
    assert.match(mission.routing.portalSignature, /^nearestHop:/);
    assert.deepEqual(copy(mission.task.route), outward);
    assert.deepEqual(copy(mission.task.returnRoute), nextReturn);
});

test('lost mission routes clear queued demand while preserving lease identity and unrelated workers', () => {
    const w = world();
    w.intel.portals = copy(outward);
    w.plan('shard0', 'W1N1', 'shard1', 'W3N3', outward);
    w.api.createShardTask('W1N1', 'shard1/W3N3', { builders: 0, verifyRoute: false, explorePortals: false });
    w.api.releaseShardCreepConfig();
    const mission = w.mission();
    const firstLease = Object.values(mission.leases)[0];
    w.home.memory.creepConfig.regular = { role: 'harvester', data: {} };
    w.home.memory.creepSpawnQueue = [...Object.keys(w.home.memory.creepConfig)];
    w.intel.portals = [];
    w.plans.clear();
    w.advance(w.policy.portalRouting.retryInterval);
    w.api.runShardController();
    w.api.releaseShardCreepConfig();
    assert.equal(mission.routing.status, 'waiting');
    assert.deepEqual(Object.keys(w.home.memory.creepConfig), ['regular']);
    assert.deepEqual(Array.from(w.home.memory.creepSpawnQueue), ['regular']);
    assert.equal(Object.values(mission.leases)[0], firstLease);
    assert.equal(mission.generation, 1);
});

test('in-transit replan starts at the current shard and room and preserves cargo and delivery state', () => {
    const w = world();
    w.game.shard.name = 'shard2';
    const replacement = [{ shard: 'shard2', roomName: 'W2N2', x: 15, y: 15, destinationShard: 'shard1', destinationRoom: 'W3N3' }];
    w.plan('shard2', 'W2N2', 'shard1', 'W3N3', replacement, 80);
    const u = unit(w, 'hauler', { energy: 70, data: { hopIndex: 1, pendingDelivery: { amount: 20, energyBefore: 90, tick: 5 }, transferPreparedAt: 8, transferPreparedHop: 1, transferPreparedShard: 'shard2' } });
    const pending = u.data.pendingDelivery;
    assert.equal(w.routing.ensureUnitRoute(u.creep, u.data), true);
    assert.equal(u.data.originShard, 'shard2');
    assert.equal(u.data.hopIndex, 0);
    assert.deepEqual(copy(u.data.route), replacement);
    assert.equal(u.data.pendingDelivery, pending);
    assert.equal(u.creep.store.energy, 70);
    assert.equal(u.creep.name, 'support');
    assert.equal(u.data.transferPreparedAt, undefined);
    assert.equal(u.data.transferPreparedHop, undefined);
    assert.equal(u.data.transferPreparedShard, undefined);
    assert.equal(w.calls.filter(call => call.type === 'cancel-transfer').length, 1);
});

test('automatic return waits for missing portal intel and retries using the current shard clock', () => {
    const w = world();
    w.game.shard.name = 'shard1';
    const u = unit(w, 'hauler', { roomName: 'W3N3', data: { phase: 'return', route: copy(returning), originShard: 'shard1', transferPreparedAt: 1, transferPreparedHop: 0, transferPreparedShard: 'shard1' } });
    u.behavior.source(u.creep);
    assert.equal(u.data.phase, 'return');
    assert.notEqual(u.data.done, true);
    assert.equal(u.data.transferPreparedAt, undefined);
    const retries = w.calls.filter(call => call.type === 'plan').length;
    u.behavior.source(u.creep);
    assert.equal(w.calls.filter(call => call.type === 'plan').length, retries);
    w.plan('shard1', 'W3N3', 'shard0', 'W1N1', returning);
    w.advance(w.policy.portalRouting.retryInterval);
    u.behavior.source(u.creep);
    assert.deepEqual(copy(u.data.route), returning);
    assert.equal(u.data.routeRetryAt, undefined);
    assert.equal(u.data.phase, 'return');
    assert.notEqual(u.data.done, true);
});

test('missing or changed portals invalidate their record and force replan without a second same-tick travel', () => {
    for (const reason of ['portal-missing', 'portal-destination']) {
        const w = world();
        const replacement = [{ ...outward[0], x: 25, y: 25 }];
        w.intel.portals = copy(outward);
        w.plan('shard0', 'W2N2', 'shard1', 'W3N3', replacement);
        w.travel.result = { status: 'waiting', reason, message: 'portal changed' };
        const u = unit(w, 'builder', { data: { transferPreparedAt: 1, transferPreparedHop: 0, transferPreparedShard: 'shard0' } });
        u.behavior.source(u.creep);
        assert.equal(w.calls.filter(call => call.type === 'travel').length, 1);
        assert.equal(w.calls.filter(call => call.type === 'forget').length, 1);
        assert.deepEqual(copy(u.data.route), replacement);
        assert.equal(u.data.transferPreparedAt, undefined);
        assert.equal(u.data.phase, 'outbound');
    }
});

test('an unreachable entrance waits for retry instead of repeatedly selecting the same portal', () => {
    const w = world();
    w.intel.portals = copy(outward);
    w.plans.set('shard0/W2N2->shard1/W3N3', portals => portals.length ? { route: [portals[0]], cost: 1 } : undefined);
    w.travel.result = { status: 'waiting', reason: 'no-path', message: 'no path to entrance' };
    const u = unit(w, 'builder');
    u.behavior.source(u.creep);
    assert.equal(w.calls.filter(call => call.type === 'travel').length, 1);
    assert.equal(w.calls.some(call => call.type === 'forget'), false, 'a local path failure does not erase a valid portal');
    u.behavior.source(u.creep);
    w.advance(w.policy.portalRouting.retryInterval - 1);
    u.behavior.source(u.creep);
    assert.equal(w.calls.filter(call => call.type === 'travel').length, 1);
    w.advance();
    u.behavior.source(u.creep);
    assert.equal(w.calls.filter(call => call.type === 'travel').length, 2);
    assert.equal(u.data.phase, 'outbound');
});

test('a builder already working at the target keeps building after the mission route becomes stale', () => {
    const w = world();
    w.game.shard.name = 'shard1';
    const u = unit(w, 'builder', { energy: 100, roomName: 'W3N3', data: { phase: 'work', hopIndex: 1 } });
    u.creep.room.constructionSites = [{ id: 'spawn-site', structureType: 'spawn', pos: position(11, 10, 'W3N3') }];
    u.creep.room.spawns = [];
    u.behavior.target(u.creep);
    assert.equal(w.calls.find(call => call.type === 'build').target.id, 'spawn-site');
    assert.equal(w.calls.some(call => call.type === 'plan' || call.type === 'travel'), false);
});

test('paused and cancelled waiting tasks stay stopped when portal routes become available', () => {
    for (const state of ['paused', 'cancelled']) {
        const w = world();
        w.api.createShardTask('W1N1', 'shard1/W3N3', { explorePortals: false });
        w.api.setShardTaskState(w.mission().task.id, state);
        w.intel.portals = copy(outward);
        w.plan('shard0', 'W1N1', 'shard1', 'W3N3', outward);
        w.advance(w.policy.portalRouting.retryInterval);
        w.api.runShardController();
        w.api.releaseShardCreepConfig();
        assert.equal(w.mission().state, state);
        assert.equal(Object.keys(w.mission().leases).length, 0);
        assert.equal(Object.keys(w.home.memory.creepConfig).length, 0);
    }
});

test('mission and in-transit planning share a per-tick budget and deferred units recover next tick', () => {
    const w = world();
    w.policy.portalRouting.maximumPlansPerTick = 2;
    w.intel.portals = copy([...outward, ...returning]);
    w.plan('shard0', 'W1N1', 'shard1', 'W3N3', outward);
    w.plan('shard1', 'W3N3', 'shard0', 'W1N1', returning);
    w.plan('shard0', 'W2N2', 'shard1', 'W3N3', outward);
    w.api.createShardTask('W1N1', 'shard1/W3N3', { haulers: 1, explorePortals: false });
    assert.equal(w.mission().routing.status, 'ready');
    assert.equal(w.calls.filter(call => call.type === 'plan').length, 2);
    const u = unit(w, 'hauler', { energy: 70, data: { route: [], transferPreparedAt: 5 } });
    assert.equal(w.routing.ensureUnitRoute(u.creep, u.data), false);
    assert.equal(w.calls.filter(call => call.type === 'plan').length, 2);
    assert.equal(u.data.routeRetryAt, w.game.time + 1);
    assert.equal(u.creep.store.energy, 70);
    assert.equal(u.data.transferPreparedAt, undefined);
    w.advance();
    assert.equal(w.routing.ensureUnitRoute(u.creep, u.data), true);
    assert.equal(w.calls.filter(call => call.type === 'plan').length, 3);
    assert.equal(u.data.routeRetryAt, undefined);
});

test('low CPU Bucket delays mission and unit replanning without losing their state', () => {
    const w = world();
    w.game.cpu.bucket = w.policy.portalRouting.minimumBucket - 1;
    w.intel.portals = copy(outward);
    w.plan('shard0', 'W1N1', 'shard1', 'W3N3', outward);
    w.plan('shard0', 'W2N2', 'shard1', 'W3N3', outward);
    w.api.createShardTask('W1N1', 'shard1/W3N3', { explorePortals: false });
    assert.equal(w.mission().routing.status, 'waiting');
    assert.match(w.mission().routing.message, /Bucket/);
    w.api.releaseShardCreepConfig();
    assert.equal(Object.keys(w.mission().leases).length, 0);
    const u = unit(w, 'hauler', { energy: 70, data: { route: [] } });
    assert.equal(w.routing.ensureUnitRoute(u.creep, u.data), false);
    assert.equal(w.calls.some(call => call.type === 'plan'), false);
    assert.equal(u.creep.store.energy, 70);
    assert.equal(u.data.routeRetryAt, w.game.time + w.policy.portalRouting.retryInterval);
    w.game.cpu.bucket = 10000;
    w.advance(w.policy.portalRouting.retryInterval);
    w.api.runShardController();
    assert.equal(w.mission().routing.status, 'ready');
    assert.equal(w.routing.ensureUnitRoute(u.creep, u.data), true);
});

test('refreshing observation times avoids redundant planning while a newly discovered entrance can improve a ready route', () => {
    const w = world();
    w.intel.portals = copy(outward);
    w.plan('shard0', 'W1N1', 'shard1', 'W3N3', outward, 100);
    w.api.createShardTask('W1N1', 'shard1/W3N3', { builders: 0, explorePortals: false });
    assert.equal(w.calls.filter(call => call.type === 'plan').length, 1);
    w.intel.portals[0].observedAt = w.loader.globals.Date.now();
    w.advance(w.policy.portalRouting.retryInterval);
    w.api.runShardController();
    assert.equal(w.calls.filter(call => call.type === 'plan').length, 1);
    const alternative = [{ ...outward[0], x: 25, y: 25 }];
    w.intel.portals.push(...copy(alternative));
    w.plan('shard0', 'W1N1', 'shard1', 'W3N3', alternative, 1);
    w.advance(w.policy.portalRouting.retryInterval);
    w.api.runShardController();
    assert.equal(w.calls.filter(call => call.type === 'plan').length, 2);
    assert.equal(w.mission().routing.status, 'ready');
    assert.equal(w.mission().routing.cost, 1);
    assert.deepEqual(copy(w.mission().task.route), alternative);
});

test('real Observer next-tick discovery plans both legs, dispatches a scout, and waits for both endpoint proofs before work', () => {
    const w = world({ realIntel: true });
    const requested = [];
    const observer = { id: 'observer', my: true, structureType: 'observer', pos: position(25, 25, w.home.name), room: w.home,
        isActive: () => true, observeRoom: roomName => { requested.push({ roomName, tick: w.game.time }); return 0; } };
    w.home.observer = observer;
    w.game.structures[observer.id] = observer;
    w.objects[observer.id] = observer;
    const now = w.loader.globals.Date.now();
    const returnPortal = { ...returning[0], id: 'remote-return-portal', observedAt: now };
    w.peers.shard1 = { version: 1, transfers: {}, acks: {}, reports: {}, portalIntel: { shard: 'shard1', updatedAt: now, portals: [returnPortal] } };
    const realIntel = w.loader.load('shard/portalIntel');
    assert.match(w.api.createShardTask('W1N1', 'shard1/W3N3', { claim: false, builders: 0, haulers: 1, explorePortals: false }), /已创建/);
    w.api.runShardController();
    assert.equal(requested.length, 1);
    const observedRoom = requested[0].roomName;
    const observedCoordinates = /^([WE])(\d+)([NS])(\d+)$/.exec(observedRoom);
    assert.equal(Number(observedCoordinates[2]) % 10, 0);
    assert.equal(Number(observedCoordinates[4]) % 10, 0);
    assert.ok(w.game.map.getRoomLinearDistance(w.home.name, observedRoom) <= 10);
    assert.equal(w.game.rooms[observedRoom], undefined);
    assert.equal(realIntel.getKnownPortals().some(record => record.shard === 'shard0'), false, 'observeRoom intent does not grant same-tick vision');
    w.api.releaseShardCreepConfig();
    assert.equal(Object.keys(w.mission().leases).length, 0);

    w.advance();
    const portal = { id: 'observed-outward-portal', structureType: 'portal', pos: position(12, 13, observedRoom), destination: { shard: 'shard1', room: 'W3N3' } };
    w.game.rooms[observedRoom] = { name: observedRoom, find: type => type === 'structures' ? [portal] : [] };
    w.api.runShardController();
    assert.equal(realIntel.getKnownPortals().some(record => record.id === portal.id), true);
    assert.equal(w.local.portalIntel.portals.some(record => record.id === portal.id), true, 'confirmed local discovery is published for other shards');
    delete w.game.rooms[observedRoom];
    w.advance(w.policy.portalRouting.retryInterval - 1);
    w.api.runShardController();
    w.api.releaseShardCreepConfig();
    assert.equal(w.mission().routing.status, 'ready');
    assert.deepEqual(copy(w.mission().task.route), [{ shard: 'shard0', roomName: observedRoom, x: 12, y: 13, destinationShard: 'shard1', destinationRoom: 'W3N3' }]);
    assert.deepEqual(copy(w.mission().task.returnRoute), returning);
    assert.deepEqual(Object.values(w.home.memory.creepConfig).map(config => config.role), ['sScout']);
    assert.equal(w.mission().task.verifyRoute, true);
    assert.equal(w.mission().scouting.status, 'scouting');
    assert.equal(Object.keys(w.mission().leases).length, 1);

    const scout = w.mission().leases['scout:0'];
    const proof = leg => ({
        missionId: w.mission().task.key, sourceShard: 'shard0', scoutName: scout.name,
        revision: w.mission().scouting.revision, leg, result: 'verified',
        route: copy(leg === 'outbound' ? w.mission().task.route : w.mission().task.returnRoute),
        shard: leg === 'outbound' ? 'shard1' : 'shard0', roomName: leg === 'outbound' ? 'W3N3' : 'W1N1',
        updatedAt: w.loader.globals.Date.now(), elapsedTicks: 15,
    });
    w.peers.shard1.scoutProofs = { [`${w.mission().task.key}:outbound`]: proof('outbound') };
    w.advance();
    w.api.runShardController();
    w.api.releaseShardCreepConfig();
    assert.equal(w.mission().scouting.outbound, true);
    assert.deepEqual(Object.values(w.home.memory.creepConfig).map(config => config.role), ['sScout']);
    w.local.scoutProofs = { [`${w.mission().task.key}:return`]: proof('return') };
    w.advance();
    w.api.runShardController();
    w.home.memory.creepConfig = {};
    w.api.releaseShardCreepConfig();
    assert.equal(w.mission().scouting.status, 'verified');
    assert.deepEqual(Object.values(w.home.memory.creepConfig).map(config => config.role), ['sHauler']);

    const lease = w.mission().leases['hauler:0'];
    w.home.memory.creepSpawnQueue = [lease.name];
    w.game.rooms[observedRoom] = { name: observedRoom, find: () => [] };
    w.advance(w.policy.portalRouting.retryInterval);
    w.api.runShardController();
    w.api.releaseShardCreepConfig();
    assert.equal(realIntel.getKnownPortals().some(record => record.id === portal.id), false);
    assert.equal(w.mission().routing.status, 'waiting');
    assert.equal(Object.keys(w.home.memory.creepConfig).length, 0);
    assert.equal(w.home.memory.creepSpawnQueue.length, 0);
    assert.equal(w.mission().leases['hauler:0'], lease);
});
