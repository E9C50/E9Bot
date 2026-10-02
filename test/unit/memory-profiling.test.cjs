const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

test('first native Memory access is attributed separately from portal work without modifying stored data', () => {
    let used = 0, parsedTick = -1, parses = 0;
    const memory = { rooms: { W1N1: { preserved: true } }, shardPortalIntel: { preserved: true } };
    const game = { time: 1, shard: { name: 'shard3' }, cpu: { getUsed: () => used } };
    const loader = createSourceLoader({ globals: { Game: game } });
    Object.defineProperty(loader.globals, 'Memory', { get() {
        if (parsedTick !== game.time) { used += 5; parses++; parsedTick = game.time; }
        return memory;
    } });
    const { loadMemory } = loader.load('runtime/memory');
    const runner = loader.load('runtime/TickRunner').createTickRunner([
        { name: 'memory', run: loadMemory },
        { name: 'shards', run() { void loader.globals.Memory.shardPortalIntel; used += 1; } },
    ]);
    const profiling = loader.load('runtime/profiling');
    runner(); game.time++; used = 0; runner();
    const entries = profiling.getCpuProfile(100);
    assert.equal(parses, 2);
    assert.equal(entries.find(entry => entry.name === 'tick:memory').rollingAverage, 5);
    assert.equal(entries.find(entry => entry.name === 'tick:shards').rollingAverage, 1);
    assert.deepEqual(memory, { rooms: { W1N1: { preserved: true } }, shardPortalIntel: { preserved: true } });
});
