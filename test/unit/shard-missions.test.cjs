const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

const outward = [
    { shard: 'shard0', roomName: 'W1N1', x: 10, y: 10, destinationShard: 'shard1', destinationRoom: 'W2N2' },
    { shard: 'shard1', roomName: 'W2N2', x: 20, y: 20, destinationShard: 'shard2', destinationRoom: 'W3N3' },
];
const returning = [
    { shard: 'shard2', roomName: 'W3N3', x: 20, y: 20, destinationShard: 'shard1', destinationRoom: 'W2N2' },
    { shard: 'shard1', roomName: 'W2N2', x: 10, y: 10, destinationShard: 'shard0', destinationRoom: 'W1N1' },
];

function world() {
    let now = 1000000;
    const local = { version: 1, transfers: {}, acks: {}, reports: {} };
    const peers = {};
    const home = {
        name: 'W1N1', my: true, level: 8, energyAvailable: 3000, energyCapacityAvailable: 3000,
        spawns: [{ id: 'spawn' }], memory: { creepConfig: {}, creepSpawnQueue: [] },
        storage: { id: 'storage', store: { energy: 50000 } },
        controller: { my: true, level: 8 },
        find(type) { return type === 'my-spawns' ? this.spawns : []; },
    };
    const memory = { warMode: {}, creeps: {} };
    const game = { time: 10, shard: { name: 'shard0' }, rooms: { W1N1: home }, creeps: {}, structures: {}, cpu: { bucket: 10000, getUsed: () => 0 },
        map: { getRoomStatus: () => ({ status: 'normal' }), getRoomLinearDistance: () => 1, findRoute: () => [] } };
    const transport = {
        getLocalShardState: () => local,
        readRemoteShardState: shard => peers[shard],
        markShardStateDirty() {}, flushInterShardMemory: () => true,
        restoreArrivingCreeps: () => 0, getShardTransportError: () => undefined,
    };
    const loader = createSourceLoader({
        globals: {
            Game: game, Memory: memory, Date: class extends Date { static now() { return now; } }, InterShardMemory: {},
            WORK: 'work', CARRY: 'carry', MOVE: 'move', CLAIM: 'claim', ATTACK: 'attack', HEAL: 'heal', TOUGH: 'tough', RANGED_ATTACK: 'ranged_attack',
            RESOURCE_ENERGY: 'energy',
            FIND_MY_SPAWNS: 'my-spawns', FIND_STRUCTURES: 'structures', STRUCTURE_OBSERVER: 'observer', STRUCTURE_PORTAL: 'portal', OBSERVER_RANGE: 10,
            BODYPART_COST: { work: 100, carry: 50, move: 50, claim: 600 },
        },
        modules: {
            role: { isRoleSupported: () => true },
            utils: { sha1String: value => value },
            './transport': transport, 'shard/transport': transport,
        },
    });
    const api = loader.load('shard/controller');
    loader.load('settings/interShard').interShardPolicy.reportInterval = 1;
    const list = () => Object.values(memory.shardMissions || {});
    const summary = () => JSON.parse(api.listShardTasks());
    return { loader, api, list, summary, game, memory, home, local, peers, now: () => now, advance: milliseconds => { now += milliseconds; game.time++; } };
}

function input(overrides = {}) {
    return { id: 'settle', sourceRoom: 'W1N1', targetShard: 'shard2', targetRoom: 'W3N3', route: outward, returnRoute: returning, ...overrides };
}

test('mission creation preserves a validated multi-hop route and applies documented settlement defaults', () => {
    const w = world();
    const message = w.api.createShardTask(input());
    assert.equal(typeof message, 'string');
    assert.match(message, /已创建/);
    const mission = w.list()[0];
    assert.equal(mission.task.key, 'shard0:settle');
    assert.equal(mission.task.sourceShard, 'shard0');
    assert.equal(mission.task.claim, true);
    assert.equal(mission.task.builders, 2);
    assert.equal(mission.task.haulers, 0);
    assert.equal(mission.task.targetLevel, 4);
    assert.equal(mission.task.energyAmount, 0);
    assert.equal(mission.task.homeEnergyReserve, 10000);
    assert.deepEqual(JSON.parse(JSON.stringify(mission.task.route)), outward);
    assert.deepEqual(JSON.parse(JSON.stringify(mission.task.returnRoute)), returning);
    assert.equal(w.summary()[0].key, 'shard0:settle');
});

function report(w, overrides = {}) {
    const mission = w.list()[0];
    w.peers.shard2 = { version: 1, transfers: {}, acks: {}, reports: {
        [mission.task.key]: {
            type: 'status', missionId: mission.task.key, originShard: 'shard0', shard: 'shard2', updatedAt: w.now(),
            energyDelivered: 0, targetOwned: true, targetLevel: 1, targetSpawns: 0, units: [], ...overrides,
        },
    } };
    w.api.runShardController();
}

test('a departed unit without a source-shard Game.creep does not get replaced during its lease', () => {
    const w = world();
    w.api.createShardTask(input({ builders: 0 }));
    w.api.releaseShardCreepConfig();
    const mission = w.list()[0];
    const lease = Object.values(mission.leases)[0];
    const config = w.home.memory.creepConfig[lease.name];
    w.game.creeps[lease.name] = { name: lease.name, memory: config };
    config.data.transferPreparedAt = w.game.time;
    w.api.runShardController();
    delete w.game.creeps[lease.name];
    w.advance(1000);
    w.api.runShardController();
    assert.equal(lease.departed, true);
    w.home.memory.creepConfig = {};
    w.api.releaseShardCreepConfig();
    assert.equal(mission.generation, 1);
    assert.equal(Object.keys(w.home.memory.creepConfig).length, 0);
});

test('an owned-target report stops claimer dispatch and a completed settlement stops all renewal', () => {
    const w = world();
    w.api.createShardTask(input());
    w.api.releaseShardCreepConfig();
    report(w, { targetOwned: true, targetLevel: 1, targetSpawns: 0 });
    w.home.memory.creepConfig = {};
    w.api.releaseShardCreepConfig();
    assert.equal(Object.values(w.home.memory.creepConfig).some(config => config.role === 'sClaimer'), false);
    assert.equal(Object.values(w.home.memory.creepConfig).filter(config => config.role === 'sBuilder').length, 2);
    w.advance(1000);
    report(w, { targetOwned: true, targetLevel: 4, targetSpawns: 1 });
    assert.equal(w.list()[0].state, 'complete');
    w.home.memory.creepConfig = {};
    w.api.releaseShardCreepConfig();
    assert.equal(Object.keys(w.home.memory.creepConfig).length, 0);
});

test('finite logistics completes only at confirmed delivery amount and replaces done haulers below the goal', () => {
    const w = world();
    w.api.createShardTask(input({ id: 'energy', claim: false, builders: 0, haulers: 1, energyAmount: 1000 }));
    w.api.releaseShardCreepConfig();
    const first = Object.values(w.list()[0].leases)[0];
    report(w, { energyDelivered: 200, units: [{ name: first.name, kind: 'hauler', done: true }] });
    assert.equal(w.list()[0].state, 'active');
    assert.equal(Object.keys(w.list()[0].leases).length, 0);
    w.home.memory.creepConfig = {};
    w.api.releaseShardCreepConfig();
    const replacement = Object.values(w.list()[0].leases)[0];
    assert.notEqual(replacement.name, first.name);
    assert.ok(replacement.generation > first.generation);
    w.advance(1000);
    report(w, { energyDelivered: 1000 });
    assert.equal(w.list()[0].state, 'complete');
    assert.equal(w.summary()[0].energyDelivered, 1000);
});

test('an expired missing lease creates exactly one replacement with a new identity', () => {
    const w = world();
    w.api.createShardTask(input({ claim: false, builders: 0, haulers: 1, energyAmount: 1000 }));
    w.api.releaseShardCreepConfig();
    const original = Object.values(w.list()[0].leases)[0];
    w.advance(w.loader.load('settings/interShard').interShardPolicy.leaseDuration + 1);
    w.home.memory.creepConfig = {};
    w.api.releaseShardCreepConfig();
    const leases = Object.values(w.list()[0].leases);
    assert.equal(leases.length, 1);
    assert.notEqual(leases[0].name, original.name);
    assert.equal(leases[0].generation, original.generation + 1);
});

test('invalid routes and duplicate mission ids cannot create a second mission', () => {
    const w = world();
    w.api.createShardTask(input({ route: [{ ...outward[0], shard: 'unexpected' }] }));
    assert.equal(w.list().length, 0);
    w.api.createShardTask(input());
    w.api.createShardTask(input());
    assert.equal(w.list().length, 1);
});

test('logistics-only missions never publish a claimer or builder', () => {
    const w = world();
    w.api.createShardTask(input({ id: 'energy', claim: false, builders: 0, haulers: 2, energyAmount: 1000 }));
    w.api.releaseShardCreepConfig();
    const mission = w.list()[0];
    assert.equal(mission.task.claim, false);
    assert.deepEqual(Object.values(mission.leases).map(lease => lease.kind), ['hauler', 'hauler']);
    assert.deepEqual(Object.values(w.home.memory.creepConfig).map(config => config.role), ['sHauler', 'sHauler']);
});

test('active leases prevent duplicate dispatch and paused missions stop publishing demand', () => {
    const w = world();
    w.api.createShardTask(input());
    w.api.releaseShardCreepConfig();
    const original = w.list()[0];
    const identities = Object.values(original.leases).map(lease => lease.displayName).sort();
    w.home.memory.creepConfig = {};
    w.advance(1000);
    w.api.releaseShardCreepConfig();
    const current = w.list()[0];
    assert.deepEqual(Object.values(current.leases).map(lease => lease.displayName).sort(), identities);
    assert.equal(current.generation, original.generation);
    w.api.setShardTaskState('settle', 'paused');
    w.home.memory.creepConfig = {};
    w.api.releaseShardCreepConfig();
    assert.equal(Object.keys(w.home.memory.creepConfig).length, 0);
    assert.equal(w.list()[0].state, 'paused');
});

test('task creation rejects invalid console values and same-shard route hops without side effects', () => {
    const invalid = [
        { id: 123 }, { claim: 'false' }, { sourceEnergyId: 123 }, { targetEnergyId: {} },
        { builders: -1 }, { haulers: 100 }, { targetLevel: 9 }, { energyAmount: 0.5 },
        { route: [{ ...outward[0], destinationShard: 'shard0' }, { ...outward[1], shard: 'shard0' }] },
        { returnRoute: [{ ...returning[0], destinationShard: 'shard2' }, { ...returning[1], shard: 'shard2' }] },
    ];
    for (const overrides of invalid) {
        const w = world();
        assert.doesNotThrow(() => {
            const message = w.api.createShardTask(input(overrides));
            assert.equal(typeof message, 'string');
            assert.equal(message.includes('已创建'), false);
        });
        assert.equal(w.list().length, 0);
        assert.equal(Object.keys(w.local.reports).length, 0);
    }
});

test('task routes are copied so later console-input mutation cannot alter a running mission', () => {
    const w = world();
    const configured = input({ route: outward.map(hop => ({ ...hop })), returnRoute: returning.map(hop => ({ ...hop })) });
    w.api.createShardTask(configured);
    configured.route[0].x = 49;
    configured.returnRoute[0].destinationShard = 'other-shard';
    assert.equal(w.list()[0].task.route[0].x, 10);
    assert.equal(w.list()[0].task.returnRoute[0].destinationShard, 'shard1');
});

test('pausing and cancelling immediately remove only that mission from demand and the existing spawn queue', () => {
    for (const state of ['paused', 'cancelled']) {
        const w = world();
        w.api.createShardTask(input());
        w.api.createShardTask(input({ id: 'other' }));
        w.api.releaseShardCreepConfig();
        w.home.memory.creepConfig.regular = { role: 'harvester', data: {} };
        const original = Object.entries(w.home.memory.creepConfig);
        const ours = original.filter(([, config]) => config.data.missionId === 'shard0:settle').map(([name]) => name);
        const preserved = original.filter(([, config]) => config.data.missionId !== 'shard0:settle').map(([name]) => name).sort();
        w.home.memory.creepSpawnQueue = original.map(([name]) => name);
        assert.match(w.api.setShardTaskState('settle', state), new RegExp(state));
        assert.deepEqual(Object.keys(w.home.memory.creepConfig).sort(), preserved);
        assert.deepEqual(Array.from(w.home.memory.creepSpawnQueue).sort(), preserved);
        assert.equal(ours.some(name => w.home.memory.creepSpawnQueue.includes(name)), false);
        assert.equal(w.local.reports['shard0:settle'].state, state);
        w.api.releaseShardCreepConfig();
        assert.equal(Object.values(w.home.memory.creepConfig).some(config => config.data.missionId === 'shard0:settle'), false);
    }
});

test('malformed or stale peer reports cannot complete a mission or break the tick', () => {
    const invalid = [
        { units: null }, { units: [null] }, { units: [{}] }, { units: [{ name: 'fake', kind: 'unknown' }] },
        { updatedAt: NaN }, { updatedAt: 0 }, { originShard: 'other-shard' }, { missionId: 'other-task' },
    ];
    for (const overrides of invalid) {
        const w = world();
        w.api.createShardTask(input());
        w.api.releaseShardCreepConfig();
        assert.doesNotThrow(() => report(w, { targetOwned: true, targetLevel: 8, targetSpawns: 3, ...overrides }));
        assert.equal(w.list()[0].state, 'active');
        assert.equal(w.list()[0].targetOwned, undefined);
    }
});

test('arrival acknowledgment allows replacement after grace when a unit dies before its first status report', () => {
    const w = world();
    w.api.createShardTask(input({ builders: 0 }));
    w.api.releaseShardCreepConfig();
    const mission = w.list()[0];
    const lease = Object.values(mission.leases)[0];
    const config = w.home.memory.creepConfig[lease.name];
    config.data.transferPreparedAt = w.game.time;
    w.game.creeps[lease.name] = { name: lease.name, memory: config };
    w.api.runShardController();
    delete w.game.creeps[lease.name];
    w.advance(1000);
    const acknowledgedAt = w.now();
    w.peers.shard1 = { version: 1, transfers: {}, reports: {}, acks: {
        arrival: { id: 'arrival', fromShard: 'shard1', toShard: 'shard0', creepName: lease.name, createdAt: acknowledgedAt, expiresAt: acknowledgedAt + 1200000 },
    } };
    w.api.runShardController();
    assert.equal(lease.lastShard, 'shard1');
    assert.equal(lease.departed, true);
    assert.equal(lease.acknowledgedAt, acknowledgedAt);
    const policy = w.loader.load('settings/interShard').interShardPolicy;
    w.advance(policy.missingUnitGrace + 1);
    w.peers.shard1.reports[mission.task.key] = {
        type: 'status', missionId: mission.task.key, originShard: 'shard0', shard: 'shard1', updatedAt: w.now(), energyDelivered: 0, units: [],
    };
    w.api.runShardController();
    assert.equal(Object.keys(mission.leases).length, 0, 'the repeated ack must not keep refreshing the missing unit forever');
    w.home.memory.creepConfig = {};
    w.api.releaseShardCreepConfig();
    const replacement = Object.values(mission.leases)[0];
    assert.notEqual(replacement.name, lease.name);
    assert.equal(replacement.generation, lease.generation + 1);
    assert.ok(w.now() - acknowledgedAt < policy.leaseDuration);
});

test('a native low-bucket scout sorts ahead of optional growth while essential floor and worker priorities stay intact', () => {
    const w = world();
    Object.assign(w.game.cpu, { bucket: 1, limit: 20, tickLimit: 21, getUsed: () => 18 });
    w.api.createShardTask(input({ verifyRoute: true }));
    w.api.createShardTask(input({ id: 'workers', verifyRoute: false }));
    w.api.releaseShardCreepConfig();
    const scout = Object.entries(w.home.memory.creepConfig).find(([, config]) => config.role === 'sScout');
    assert.ok(scout); assert.equal(scout[1].spawnPriority, 3.75);
    assert.equal(Object.values(w.home.memory.creepConfig).filter(config => config.data.missionId === 'shard0:settle').length, 1,
        'the unverified mission still publishes only a scout');
    const workers = Object.values(w.home.memory.creepConfig).filter(config => config.data.missionId === 'shard0:workers');
    assert.equal(workers.find(config => config.role === 'sClaimer').spawnPriority, 9);
    assert.equal(workers.filter(config => config.role === 'sBuilder').every(config => config.spawnPriority === 12), true);
    w.home.containers = []; w.home.sources = [];
    w.home.memory.creepConfig.floor = { role: 'filler', spawnPriority: 3.5, data: {} };
    w.home.memory.creepConfig.growthBuilder = { role: 'builder', spawnPriority: 4, data: {} };
    w.home.memory.creepConfig.growthUpgrader = { role: 'upgrader', spawnPriority: 5, data: {} };
    w.game.creeps.harvester = { room: w.home, memory: { role: 'harvester' } };
    w.game.creeps.filler = { room: w.home, memory: { role: 'filler' } };
    const queue = w.loader.load('creep/spawnQueue').buildSpawnQueue(w.home);
    assert.deepEqual(Array.from(queue.slice(0, 4)), ['floor', scout[0], 'growthBuilder', 'growthUpgrader']);
    const normal = world(); normal.api.createShardTask(input({ verifyRoute: true })); normal.api.releaseShardCreepConfig();
    assert.equal(Object.values(normal.home.memory.creepConfig).find(config => config.role === 'sScout').spawnPriority, 8);
});
