const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const clone = value => JSON.parse(JSON.stringify(value));

function world() {
    const clock = { now: 1000000 };
    const game = { shard: { name: 'shard3' }, time: 100, creeps: {}, cpu: { bucket: 10000, tickLimit: 100, getUsed: () => 0 } };
    const portal = { id: 'entry', observedAt: clock.now, shard: 'shard3', roomName: 'W0N0', x: 10, y: 10, destinationShard: 'shard2', destinationRoom: 'W1N1' };
    const source = { memory: { creepConfig: {} } };
    const task = { id: 'settle', key: 'shard3:settle', sourceShard: 'shard3', sourceRoom: 'W1N1', targetShard: 'shard1', targetRoom: 'W2N2',
        autoRoute: true, autoReturn: false, explorePortals: true, route: [], claim: true, builders: 2, haulers: 0, targetLevel: 4, energyAmount: 0, homeEnergyReserve: 10000 };
    const mission = { task, createdAt: clock.now, generation: 0, state: 'active', leases: {}, energyDelivered: 0, routing: { status: 'waiting' } };
    const calls = [];
    const loader = createSourceLoader({ globals: { Game: game, Date: class extends Date { static now() { return clock.now; } } }, modules: {
        'creep/demand': {
            createCreepName: (role, name) => `${role}:${name}`,
            addCreepConfig(room, role, name, data) { const key = `${role}:${name}`; room.memory.creepConfig[key] = { role, data }; calls.push(data); },
        },
        './portalIntel': { getKnownPortals: () => [portal] },
        './explorationRoutes': { planExplorationEntry: () => [portal] },
        './routePlanner': { isPortalRouteKnown: () => true },
    } });
    const api = loader.load('shard/explorationControl');
    const policy = loader.load('settings/interShard').interShardPolicy;
    const dispatch = () => { api.refreshPortalExploration(mission); api.releasePortalExplorer(mission, source); };
    const report = (extra = {}) => ({ missionId: task.key, sourceShard: 'shard3', explorerName: mission.leases['explorer:0'].name,
        revision: mission.exploration.revision, status: 'exploring', shard: 'shard2', roomName: 'W0N0', updatedAt: clock.now,
        elapsedTicks: 50, visitedRooms: ['shard2/W0N0'], route: [portal], ...extra });
    return { game, clock, task, mission, source, api, policy, calls, portal, dispatch, report };
}

test('a missing complete route dispatches a separate explorer with an observed prefix and no verification proof', () => {
    const w = world(); w.dispatch();
    assert.equal(w.mission.exploration.status, 'exploring');
    assert.deepEqual(Object.keys(w.mission.leases), ['explorer:0']);
    const data = w.calls[0];
    assert.deepEqual(clone(data.route), [w.portal]);
    assert.equal(data.exploration.goalShard, 'shard1');
    assert.equal(data.scouting, undefined);
    assert.equal(w.api.keepPortalExplorer(w.mission, data), true);
    assert.equal(w.mission.scouting, undefined);
});

test('return exploration stages through the complete outbound route and aims back at source without requiring a transit Spawn', () => {
    const w = world(); w.task.autoReturn = true; w.task.haulers = 1; w.task.route = [w.portal]; w.dispatch();
    const data = w.calls[0];
    assert.deepEqual(clone(data.exploration.returnGoal), { shard: 'shard3', roomName: 'W1N1' });
    assert.equal(data.originShard, 'shard3');
    assert.deepEqual(clone(data.route), [w.portal]);
});

test('discovery completion retires pending exploration while retaining full-route verification as a separate gate', () => {
    const w = world(); w.dispatch(); const data = w.calls[0];
    w.mission.routing.status = 'ready'; w.api.refreshPortalExploration(w.mission);
    assert.equal(w.mission.exploration.status, 'complete');
    assert.equal(w.api.keepPortalExplorer(w.mission, data), false);
    const count = w.calls.length; w.api.releasePortalExplorer(w.mission, w.source);
    assert.equal(w.calls.length, count);
    assert.equal(w.mission.scouting, undefined);
});

test('an explorer that has crossed the portal is not duplicated at source', () => {
    const w = world(); w.dispatch();
    Object.assign(w.mission.leases['explorer:0'], { departed: true, lastShard: 'shard2', seenAt: w.clock.now });
    const name = w.mission.leases['explorer:0'].name; w.api.releasePortalExplorer(w.mission, w.source);
    assert.equal(w.calls.length, 1);
    assert.equal(w.mission.leases['explorer:0'].name, name);
});

test('source death enters bounded retry backoff, then issues a new explorer identity', () => {
    const w = world(); w.dispatch(); const old = w.mission.leases['explorer:0'].name;
    Object.assign(w.mission.leases['explorer:0'], { seenAt: w.clock.now, lastShard: 'shard3', departed: false });
    w.api.releasePortalExplorer(w.mission, w.source);
    assert.equal(w.mission.exploration.status, 'failed');
    w.dispatch(); assert.equal(w.calls.length, 1);
    w.clock.now += w.policy.portalExploration.retryDelay; w.dispatch();
    assert.notEqual(w.mission.leases['explorer:0'].name, old);
    assert.equal(w.calls.length, 2);
});

test('discovery reports update bounded exploration history but do not become verified route proofs', () => {
    const w = world(); w.dispatch();
    assert.equal(w.api.acceptPortalExplorationReport(w.mission, w.report(), 'shard2'), true);
    assert.equal(w.mission.exploration.lastShard, 'shard2');
    assert.deepEqual(clone(w.mission.exploration.visitedRooms), ['shard2/W0N0']);
    assert.equal(w.mission.scouting, undefined);
    assert.equal(w.mission.routing.status, 'waiting');
});

test('bad explorer identity, revision, publishing shard, timestamp and completion endpoint cannot affect source', async t => {
    const cases = [{ explorerName: 'other' }, { revision: 'obsolete' }, { sourceShard: 'shard0' }, { updatedAt: 1000001 },
        { updatedAt: 999999 }, { shard: 'shard1' }, { status: 'complete', shard: 'shard2' }, { visitedRooms: ['W0N0'] }];
    for (const invalid of cases) await t.test(JSON.stringify(invalid), () => {
        const w = world(); w.dispatch();
        assert.equal(w.api.acceptPortalExplorationReport(w.mission, w.report(invalid), 'shard2'), false);
        assert.equal(w.mission.exploration.status, 'exploring');
    });
});

test('confirmed explorer failure retains visited rooms for the next bounded attempt and temporarily blocks a bad portal', () => {
    const w = world(); w.dispatch();
    assert.equal(w.api.acceptPortalExplorationReport(w.mission, w.report({ status: 'failed', lastError: 'no path', failedHop: w.portal }), 'shard2'), true);
    assert.equal(w.mission.exploration.status, 'failed');
    assert.equal(w.mission.blockedPortals.length, 1);
    w.clock.now += w.policy.portalExploration.retryDelay; w.dispatch();
    assert.deepEqual(clone(w.mission.exploration.visitedRooms), ['shard2/W0N0']);
});

test('task opt-out, pause, low bucket and maximum age preserve the source gate', () => {
    for (const kind of ['opt-out', 'paused', 'bucket']) {
        const w = world();
        if (kind === 'opt-out') w.task.explorePortals = false;
        if (kind === 'paused') w.mission.state = 'paused';
        if (kind === 'bucket') w.game.cpu.bucket = 0;
        w.dispatch(); assert.equal(w.calls.length, 0);
    }
    const w = world(); w.dispatch(); w.clock.now += w.policy.portalExploration.maximumAge;
    w.api.refreshPortalExploration(w.mission); assert.equal(w.mission.exploration.status, 'failed');
});

test('replayed completion reports cannot extend retry backoff indefinitely when full routing is still unavailable', () => {
    const w = world(); w.dispatch();
    const terminal = w.report({ status: 'complete', shard: 'shard1', roomName: 'W2N2' });
    assert.equal(w.api.acceptPortalExplorationReport(w.mission, terminal, 'shard1'), true);
    const retryAt = w.mission.exploration.retryAt, revision = w.mission.exploration.revision;
    w.clock.now += 10000;
    assert.equal(w.api.acceptPortalExplorationReport(w.mission, terminal, 'shard1'), false);
    assert.equal(w.mission.exploration.retryAt, retryAt);
    w.clock.now = retryAt; w.dispatch();
    assert.notEqual(w.mission.exploration.revision, revision);
});
