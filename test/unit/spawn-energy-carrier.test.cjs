const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world() {
    const room = { name: 'W1N1', controller: { my: true, level: 6 }, memory: {}, storage: {} };
    const parts = { carry: 1, move: 1 };
    const creep = { room, ticksToLive: 1000, spawning: false, memory: {
        role: 'filler', spawnRoom: room.name, data: {} }, getActiveBodyparts: part => parts[part] || 0 };
    const game = {};
    Object.defineProperty(game, 'creeps', { get() { throw new Error('local carrier checks must not scan a catalog'); } });
    const loader = createSourceLoader({ globals: { Game: game, CARRY: 'carry', MOVE: 'move' } });
    return { room, creep, parts, ready: () => loader.load('creep/spawnEnergyCarrier').isSpawnEnergyCarrier(room, creep) };
}

test('a development mine carrier cannot replace the distributor which moves Storage energy into Spawn', () => {
    const w = world();
    assert.equal(w.ready(), true);
    w.creep.memory.data.mineId = 'source';
    assert.equal(w.ready(), false);
    delete w.creep.memory.data.mineId;
    w.creep.memory.developmentHauler = { mineId: 'source' };
    assert.equal(w.ready(), false);
    delete w.room.storage;
    assert.equal(w.ready(), true, 'without Storage the mine carrier itself supplies local consumers');
    w.room.storage = {};
    w.room.controller.level = 8;
    assert.equal(w.ready(), true, 'mature mine carriers retain the existing carrier availability rule');
    w.room.controller.level = 6;
    w.room.memory.fastUpgrade = false;
    assert.equal(w.ready(), true, 'opting out of development retains ordinary logistics');
});

test('production carriers retain live role, room, active body and boost health checks', () => {
    const changes = [
        w => { w.creep.memory.role = 'manager'; },
        w => { w.creep.spawning = true; },
        w => { w.creep.ticksToLive = 0; },
        w => { w.creep.memory.spawnRoom = 'W2N1'; },
        w => { w.creep.room = { name: 'W2N1' }; },
        w => { w.parts.carry = 0; },
        w => { w.parts.move = 0; },
        w => { w.creep.memory.boostPlan = { steps: [{}] }; },
    ];
    for (const change of changes) {
        const w = world(); assert.equal(w.ready(), true); change(w); assert.equal(w.ready(), false);
    }
    const w = world();
    w.creep.memory.boostPlan = { steps: [{}], completed: true };
    assert.equal(w.ready(), true);
    w.creep.memory.boostPlan = { steps: [{}], failed: true };
    assert.equal(w.ready(), true, 'failed optional plans preserve the previous native carrier rule');
    delete w.creep.memory.spawnRoom;
    delete w.creep.memory.data;
    assert.equal(w.ready(), true, 'legacy compact local carriers remain compatible');
});

test('unrelated roles exit before native room or body queries', () => {
    const w = world(); w.creep.memory.role = 'repairer';
    Object.defineProperty(w.creep, 'room', { get() { throw new Error('unrelated native room read'); } });
    w.creep.getActiveBodyparts = () => { throw new Error('unrelated body scan'); };
    assert.equal(w.ready(), false);
});
