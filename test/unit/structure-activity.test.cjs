const assert = require('node:assert/strict');
const test = require('node:test');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

test('activation is shared across consumers while tick, shard and replacement objects invalidate it', () => {
    const Game = { time: 100, shard: { name: 'shard3' } };
    const loader = createSourceLoader({ globals: { Game } });
    const { isStructureActive } = loader.load('runtime/structureActivity');
    let reads = 0, active = false;
    const structure = { isActive() { reads++; assert.equal(this, structure); return active; } };
    for (let i = 0; i < 30; i++) assert.equal(isStructureActive(structure), false);
    assert.equal(reads, 1, 'inactive results are cached too');
    active = true; Game.time++;
    assert.equal(isStructureActive(structure), true);
    assert.equal(reads, 2);
    Game.shard.name = 'shard1';
    assert.equal(isStructureActive(structure), true);
    assert.equal(reads, 3);
    const replacement = { isActive() { reads++; return false; } };
    assert.equal(isStructureActive(replacement), false);
    assert.equal(reads, 4, 'a new native object never inherits the previous result');
    Game.time = 1;
    assert.equal(isStructureActive(structure), true);
    assert.equal(reads, 5, 'test worlds and shard resets cannot retain results');
    assert.equal(isStructureActive({}), true);
});

test('failed native checks are retried instead of caching an exception', () => {
    const loader = createSourceLoader({ globals: { Game: { time: 1 } } });
    const { isStructureActive } = loader.load('runtime/structureActivity');
    let reads = 0;
    const structure = { isActive() { if (++reads === 1) throw new Error('native failure'); return true; } };
    assert.throws(() => isStructureActive(structure), /native failure/);
    assert.equal(isStructureActive(structure), true);
    assert.equal(reads, 2);
});
