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
            './bodySelection': { selectCreepBody() { throw Error('mature mission priority tests never plan a development recovery body'); } },
            role: { isRoleSupported: () => true },
            utils: { sha1String: value => value },
            './transport': transport, 'shard/transport': transport,
        },
    });
    const api = loader.load('shard/controller');
    loader.load('settings/interShard').interShardPolicy.reportInterval = 1;
    const list = () => Object.values(memory.shardMissions || {});
    const summary = () => JSON.parse(api.listShardTasks());
    return { loader, api, list, summary, game, memory, home, local, peers, transport, now: () => now, advance: milliseconds => { now += milliseconds; game.time++; } };
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
    assert.match(mission.task.key, /^shard0:settle:/);
    assert.equal(mission.task.sourceShard, 'shard0');
    assert.equal(mission.task.claim, true);
    assert.equal(mission.task.builders, 2);
    assert.equal(mission.task.haulers, 0);
    assert.equal(mission.task.targetLevel, 4);
    assert.equal(mission.task.energyAmount, 0);
    assert.equal(mission.task.homeEnergyReserve, 10000);
    assert.deepEqual(JSON.parse(JSON.stringify(mission.task.route)), outward);
    assert.deepEqual(JSON.parse(JSON.stringify(mission.task.returnRoute)), returning);
    assert.equal(w.summary()[0].key, mission.task.key);
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
    const mission = w.list()[0];
    w.api.releaseShardCreepConfig();
    report(w, { targetOwned: true, targetLevel: 1, targetSpawns: 0 });
    w.home.memory.creepConfig = {};
    w.api.releaseShardCreepConfig();
    assert.equal(Object.values(w.home.memory.creepConfig).some(config => config.role === 'sClaimer'), false);
    assert.equal(Object.values(w.home.memory.creepConfig).filter(config => config.role === 'sBuilder').length, 2);
    w.advance(1000);
    report(w, { targetOwned: true, targetLevel: 4, targetSpawns: 1 });
    assert.equal(mission.state, 'complete');
    assert.equal(w.list().length, 0);
    assert.deepEqual(w.summary(), []);
    assert.equal(w.memory.shardMissionStops[mission.task.key].state, 'complete');
    w.home.memory.creepConfig = {};
    w.api.releaseShardCreepConfig();
    assert.equal(Object.keys(w.home.memory.creepConfig).length, 0);
});

test('finite logistics completes only at confirmed delivery amount and replaces done haulers below the goal', () => {
    const w = world();
    w.api.createShardTask(input({ id: 'energy', claim: false, builders: 0, haulers: 1, energyAmount: 1000 }));
    const mission = w.list()[0];
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
    assert.equal(w.list().length, 0);
    assert.deepEqual(w.summary(), []);
    assert.equal(mission.energyDelivered, 1000);
    assert.equal(w.memory.shardMissionStops[mission.task.key].state, 'complete');
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
        const key = w.list()[0].task.key;
        w.api.createShardTask(input({ id: 'other' }));
        w.api.releaseShardCreepConfig();
        w.home.memory.creepConfig.regular = { role: 'harvester', data: {} };
        const original = Object.entries(w.home.memory.creepConfig);
        const ours = original.filter(([, config]) => config.data.missionId === key).map(([name]) => name);
        const preserved = original.filter(([, config]) => config.data.missionId !== key).map(([name]) => name).sort();
        w.home.memory.creepSpawnQueue = original.map(([name]) => name);
        assert.match(w.api.setShardTaskState('settle', state), new RegExp(state));
        assert.deepEqual(Object.keys(w.home.memory.creepConfig).sort(), preserved);
        assert.deepEqual(Array.from(w.home.memory.creepSpawnQueue).sort(), preserved);
        assert.equal(ours.some(name => w.home.memory.creepSpawnQueue.includes(name)), false);
        assert.equal(w.local.reports[key].state, state);
        w.api.releaseShardCreepConfig();
        assert.equal(Object.values(w.home.memory.creepConfig).some(config => config.data.missionId === key), false);
        if (state === 'cancelled') {
            assert.equal(w.memory.shardMissions[key], undefined);
            assert.equal(w.summary().some(task => task.key === key), false);
        }
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
    assert.equal(Object.values(w.home.memory.creepConfig).filter(config => config.data.missionId === scout[1].data.missionId).length, 1,
        'the unverified mission still publishes only a scout');
    const workerKey = w.list().find(mission => mission.task.id === 'workers').task.key;
    const workers = Object.values(w.home.memory.creepConfig).filter(config => config.data.missionId === workerKey);
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

test('the same console id can restart immediately without adopting old units, progress or commands', () => {
    const w = world();
    const configured = input({ claim: false, builders: 0, haulers: 1, energyAmount: 1000 });
    w.api.createShardTask(configured); w.api.releaseShardCreepConfig();
    const old = w.list()[0], oldLease = Object.values(old.leases)[0];
    assert.match(w.api.setShardTaskState('shard0:settle', 'cancelled'), /cancelled/);
    assert.deepEqual(w.summary(), []);
    assert.match(w.api.createShardTask(configured), /已创建/);
    const fresh = w.list()[0];
    assert.notEqual(fresh.task.key, old.task.key, 'even the same millisecond uses a new run identity');
    w.peers.shard2 = { version: 1, transfers: {}, acks: {}, reports: {
        [old.task.key]: { type: 'status', missionId: old.task.key, originShard: 'shard0', shard: 'shard2',
            updatedAt: w.now(), energyDelivered: 99999, units: [{ name: oldLease.name, kind: 'hauler', done: false }] },
    } };
    w.api.runShardController(); w.api.releaseShardCreepConfig();
    assert.equal(fresh.state, 'active'); assert.equal(fresh.energyDelivered, 0);
    assert.notEqual(Object.values(fresh.leases)[0].name, oldLease.name);
    assert.equal(w.local.reports[old.task.key].state, 'cancelled');
    assert.equal(w.local.reports[fresh.task.key].state, 'active');
    assert.match(w.api.setShardTaskState('settle', 'paused'), /paused/);
    assert.equal(fresh.state, 'paused');
    assert.equal(w.api.setShardTaskState(old.task.key, 'active'), '任务不存在');
});

test('failed terminal publication survives deleting the full task and retries from persistent Memory', () => {
    const w = world(); w.api.createShardTask(input());
    const mission = w.list()[0];
    w.transport.flushInterShardMemory = () => false;
    w.api.setShardTaskState('settle', 'cancelled');
    assert.equal(w.memory.shardMissions[mission.task.key], undefined);
    const stop = w.memory.shardMissionStops[mission.task.key];
    assert.equal(stop.published, false);
    // A later VM/tick sees the previously persisted active command, not the failed write.
    w.local.reports[mission.task.key] = { type: 'command', state: 'active', missionId: mission.task.key };
    w.advance(1000); w.api.runShardController();
    assert.equal(w.local.reports[mission.task.key].state, 'cancelled');
    assert.equal(stop.published, false);
    w.transport.flushInterShardMemory = () => true;
    w.advance(1000); w.api.runShardController();
    assert.equal(stop.published, true);
    assert.deepEqual(w.summary(), []);
});

test('old terminal records migrate out of the task list while paused tasks and unrelated work remain', () => {
    const w = world(); w.api.createShardTask(input());
    const retired = w.list()[0]; retired.state = 'complete';
    w.api.createShardTask(input({ id: 'paused' })); w.api.setShardTaskState('paused', 'paused');
    w.home.memory.creepConfig.regular = { role: 'harvester', data: {} };
    w.home.memory.creepSpawnQueue = ['regular'];
    assert.deepEqual(w.summary().map(task => task.id), ['paused']);
    assert.equal(w.memory.shardMissions[retired.task.key], undefined);
    assert.equal(w.memory.shardMissionStops[retired.task.key].state, 'complete');
    assert.ok(w.home.memory.creepConfig.regular);
    assert.deepEqual(Array.from(w.home.memory.creepSpawnQueue), ['regular']);
});

test('published stops expire without deleting unrelated reports, transfers or acknowledgements', () => {
    const w = world(); w.api.createShardTask(input());
    const key = w.list()[0].task.key;
    w.local.reports.other = { type: 'targetDismantleCommand', state: 'cancelled' };
    w.local.transfers.other = { missionId: 'other', expiresAt: w.now() + 200000000 };
    w.local.acks.other = { id: 'other' };
    w.api.setShardTaskState('settle', 'cancelled');
    w.advance(w.loader.load('settings/interShard').interShardPolicy.arrivalHistoryTtl + 1);
    w.api.runShardController();
    assert.equal(w.memory.shardMissionStops[key], undefined);
    assert.equal(w.local.reports[key], undefined);
    assert.equal(w.local.reports.other.type, 'targetDismantleCommand');
    assert.ok(w.local.transfers.other); assert.ok(w.local.acks.other);
});

test('unpublished stops and still-in-flight identities survive the nominal stop retention deadline', () => {
    for (const reason of ['write-failed', 'transfer', 'unit']) {
        const w = world(); w.api.createShardTask(input()); w.api.releaseShardCreepConfig();
        const mission = w.list()[0], lease = Object.values(mission.leases)[0];
        const data = w.home.memory.creepConfig[lease.name].data;
        if (reason === 'write-failed') w.transport.flushInterShardMemory = () => false;
        if (reason === 'transfer') w.local.transfers.pending = { missionId: mission.task.key,
            expiresAt: w.now() + 200000000 };
        if (reason === 'unit') w.game.creeps[lease.name] = { name: lease.name, memory: { data } };
        w.api.setShardTaskState('settle', 'cancelled');
        w.advance(w.loader.load('settings/interShard').interShardPolicy.arrivalHistoryTtl + 1);
        w.api.runShardController();
        assert.equal(w.memory.shardMissionStops[mission.task.key].state, 'cancelled', reason);
        assert.ok(w.memory.shardMissionStops[mission.task.key].expiresAt > w.now(), reason);
        if (reason === 'transfer') assert.ok(w.local.transfers.pending);
        assert.equal(w.local.reports[mission.task.key].state, 'cancelled');
        assert.deepEqual(w.summary(), []);
    }
});

test('expiry cleanup retries after its last command removal fails to persist', () => {
    const w = world(); w.api.createShardTask(input());
    const key = w.list()[0].task.key;
    w.api.setShardTaskState('settle', 'cancelled');
    const oldCommand = { ...w.local.reports[key] };
    w.advance(w.loader.load('settings/interShard').interShardPolicy.arrivalHistoryTtl + 1);
    w.transport.flushInterShardMemory = () => false;
    w.api.runShardController();
    assert.ok(w.memory.shardMissionStops[key], 'failed cleanup retains its durable retry source');
    w.local.reports[key] = { ...oldCommand };
    w.advance(1000); w.transport.flushInterShardMemory = () => true;
    w.api.runShardController();
    assert.equal(w.memory.shardMissionStops[key], undefined);
    assert.equal(w.local.reports[key], undefined);
});
