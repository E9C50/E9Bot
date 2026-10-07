const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world(maximum = 1024) {
    let hashes = 0;
    const policy = { maximumNameCacheEntries: maximum };
    const loader = createSourceLoader({ globals: { Memory: { warMode: {} } }, modules: {
        utils: { sha1String: name => { hashes++; return createHash('sha1').update(name).digest('hex').slice(0, 10).toUpperCase(); } },
        'settings/population': { populationPolicy: policy },
        'settings/creep': { spawnPriority: { harvester: 1, filler: 2 }, warModeRole: [] },
        role: { isRoleSupported: () => true },
    } });
    return { api: loader.load('creep/demand'), policy, hashes: () => hashes };
}

test('repeated eleven-room demand refreshes hash each stable role/name only once', () => {
    const w = world();
    const rooms = Array.from({ length: 11 }, (_, index) => ({ name: `E${index}N1`, memory: { creepConfig: {} } }));
    for (let tick = 0; tick < 100; tick += 5) {
        for (const room of rooms) {
            room.memory.creepConfig = {};
            w.api.addCreepConfig(room, 'harvester', `${room.name}_mine`, { sourceId: 'source' });
            w.api.addCreepConfig(room, 'filler', `${room.name}_storage`, { sourceId: 'storage' });
        }
    }
    assert.equal(w.hashes(), 22, '440 demand publications reuse 22 immutable hashes');
    for (const room of rooms) assert.equal(Object.keys(room.memory.creepConfig).length, 2);
});

test('bounded demand-name cache preserves names across eviction and runtime resize', () => {
    const w = world(2), first = w.api.createCreepName('harvester', 'first');
    assert.equal(first, 'HARVESTER_' + createHash('sha1').update('first').digest('hex').slice(0, 10).toUpperCase());
    w.api.createCreepName('filler', 'second');
    assert.equal(w.api.createCreepName('harvester', 'first'), first);
    assert.equal(w.hashes(), 2);
    w.api.createCreepName('harvester', 'third');
    assert.equal(w.api.createCreepName('harvester', 'first'), first);
    assert.equal(w.hashes(), 4, 'oldest immutable result is recomputed when evicted');
    w.policy.maximumNameCacheEntries = 0;
    assert.equal(w.api.createCreepName('harvester', 'first'), first);
    assert.equal(w.api.createCreepName('harvester', 'first'), first);
    assert.equal(w.hashes(), 6, 'disabling releases cache and retains original naming semantics');
});

test('role cache entries and fresh demand data remain independent', () => {
    const w = world(), room = { name: 'E1N1', memory: { creepConfig: {} } };
    const miner = w.api.addCreepConfig(room, 'harvester', 'same', { sourceId: 'old' });
    const filler = w.api.addCreepConfig(room, 'filler', 'same', { sourceId: 'storage' });
    assert.notEqual(miner, filler);
    w.api.addCreepConfig(room, 'harvester', 'same', { sourceId: 'new' });
    assert.equal(room.memory.creepConfig[miner].data.sourceId, 'new');
    assert.equal(room.memory.creepConfig[filler].data.sourceId, 'storage');
    assert.equal(w.hashes(), 2);
});

test('invalid cache capacity keeps hashing behavior without retaining an unbounded cache', () => {
    for (const maximum of [Infinity, NaN, -1, 0.5]) {
        const w = world(maximum), first = w.api.createCreepName('harvester', 'first');
        assert.equal(w.api.createCreepName('harvester', 'first'), first);
        assert.equal(w.hashes(), 2);
    }
});
