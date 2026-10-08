const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world() {
    const game = { shard: { name: 'shard0' } }, memory = {};
    const data = { missionId: 'shard0:haul:run1', task: { sourceShard: 'shard0' } };
    const local = { reports: {} }, remote = { reports: {} }, reads = { local: 0, remote: [] };
    const loader = createSourceLoader({ globals: { Game: game, Memory: memory }, modules: {
        './transport': {
            getLocalShardState() { reads.local++; return local; },
            readRemoteShardState(shard) { reads.remote.push(shard); return remote; },
        },
    } });
    return { game, memory, data, local, remote, reads, ...loader.load('shard/missionControl') };
}

test('mission control imports without reading game APIs', () => {
    assert.doesNotThrow(() => createSourceLoader().load('shard/missionControl'));
});

test('local mission revisions and pause state take precedence over retained commands', () => {
    const w = world(), key = w.data.missionId;
    w.memory.shardMissions = { [key]: { state: 'paused', scouting: { revision: 'local-scout', status: 'pending' },
        exploration: { revision: 'local-explorer', status: 'exploring' } } };
    w.memory.shardMissionStops = { [key]: { state: 'cancelled', updatedAt: 10, expiresAt: 20 } };
    w.local.reports[key] = { type: 'command', state: 'active', scoutRevision: 'stale', explorerRevision: 'stale' };
    const control = w.getShardMissionControl(w.data);
    assert.equal(control.state, 'paused');
    assert.equal(control.scoutRevision, 'local-scout'); assert.equal(control.scoutStatus, 'pending');
    assert.equal(control.explorerRevision, 'local-explorer'); assert.equal(control.explorerStatus, 'exploring');
    assert.equal(w.reads.local, 0); assert.deepEqual(w.reads.remote, []);
});

test('persistent terminal control survives mission removal and failed publication', () => {
    for (const state of ['complete', 'cancelled']) {
        const w = world(), key = w.data.missionId;
        w.memory.shardMissionStops = { [key]: { state, updatedAt: 10, expiresAt: 20, published: false } };
        w.local.reports[key] = { type: 'command', state: 'active' };
        assert.equal(w.getShardMissionControl(w.data).state, state);
        assert.equal(w.getShardMissionControl(w.data).updatedAt, 10);
        assert.equal(w.reads.local, 0, 'unpublished local termination must not fall back to stale active ISM');
    }
});

test('a removed local mission can still consume its retained ISM terminal command', () => {
    const w = world();
    w.local.reports[w.data.missionId] = { type: 'command', missionId: w.data.missionId,
        state: 'complete', scoutRevision: 'route-revision', explorerStatus: 'complete' };
    const control = w.getShardMissionControl(w.data);
    assert.equal(control.state, 'complete'); assert.equal(control.scoutRevision, 'route-revision');
    assert.equal(control.explorerStatus, 'complete'); assert.equal(w.reads.local, 1);
    assert.deepEqual(w.reads.remote, []);
});

test('remote workers use source commands and ignore destination records with the same key', () => {
    const w = world(), key = w.data.missionId;
    w.game.shard.name = 'shard1';
    w.memory.shardMissions = { [key]: { state: 'active' } };
    w.memory.shardMissionStops = { [key]: { state: 'complete', updatedAt: 10, expiresAt: 20 } };
    w.remote.reports[key] = { type: 'command', state: 'cancelled', missionId: key };
    assert.equal(w.getShardMissionControl(w.data).state, 'cancelled');
    assert.equal(w.reads.local, 0); assert.deepEqual(w.reads.remote, ['shard0']);
});

test('status reports, mismatched mission identities and unknown states cannot control workers', () => {
    for (const report of [{ type: 'status', state: 'cancelled' },
        { type: 'command', state: 'cancelled', missionId: 'different' }, { type: 'command', state: 'unknown' }]) {
        const w = world(); w.local.reports[w.data.missionId] = report;
        assert.equal(w.getShardMissionControl(w.data), undefined);
    }
});

test('terminal control belongs to the closed run and does not stop a reused console id', () => {
    const w = world(), old = w.data.missionId, next = 'shard0:haul:run2';
    w.memory.shardMissionStops = { [old]: { state: 'cancelled', updatedAt: 10, expiresAt: 20 } };
    w.memory.shardMissions = { [next]: { state: 'active' } };
    assert.equal(w.getShardMissionControl(w.data).state, 'cancelled');
    assert.equal(w.getShardMissionControl({ ...w.data, missionId: next }).state, 'active');
});

test('an initialized source catalogue stops a missing run after its terminal record and command expire', () => {
    const w = world();
    assert.equal(w.getShardMissionControl(w.data), undefined, 'uninitialized source memory keeps legacy compatibility');
    w.memory.shardMissions = {};
    assert.equal(w.getShardMissionControl(w.data).state, 'cancelled');
    w.game.shard.name = 'shard1';
    assert.equal(w.getShardMissionControl(w.data), undefined, 'a missing remote heartbeat does not terminate a traveller');
});
