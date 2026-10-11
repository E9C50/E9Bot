const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const nativeBodies = require('../helpers/native-bodies.cjs');

function world() {
    const room = { name: 'E41N6', controller: { my: true, level: 8 },
        memory: { creepConfig: {} }, containers: [], sources: [] };
    const game = { time: 100, creeps: {}, rooms: { [room.name]: room }, flags: {} };
    const loader = createSourceLoader({ globals: { ...nativeBodies.globals, Game: game, Memory: {} },
        modules: { ...nativeBodies.modules, role: { isRoleSupported: role => role !== 'unsupported' } } });
    const build = () => Array.from(loader.load('creep/spawnQueue').buildSpawnQueue(room));
    const demand = (name, priority = 2.6, role = 'rHarvester') => ({ name, role, spawnPriority: priority,
        spawnRoom: room.name, data: {} });
    return { room, game, build, demand };
}

test('older maintained OUT births precede a new OUT0 replacement even when demand is republished in flag order', () => {
    const w = world();
    w.room.memory.creepConfig = { out1: w.demand('out1'), out2: w.demand('out2') };
    assert.deepEqual(w.build(), ['out1', 'out2']);
    w.game.time = 200;
    w.room.memory.creepConfig = { out0: w.demand('out0'), out1: w.demand('out1'), out2: w.demand('out2') };
    assert.deepEqual(w.build(), ['out1', 'out2', 'out0']);
    assert.deepEqual({ ...w.room.memory.creepSpawnWaitingSince }, { out1: 100, out2: 100, out0: 200 });
    w.game.creeps.out1 = { memory: { role: 'rHarvester' }, room: { name: 'E42N5' }, spawning: true };
    w.game.time = 205;
    assert.deepEqual(w.build(), ['out2', 'out0']);
    delete w.game.creeps.out1;
    w.game.time = 300;
    assert.deepEqual(w.build(), ['out2', 'out0', 'out1'], 'a later generation starts waiting anew');
});

test('birth age cannot outrank local mining, hauling, Invader defense or the established mine startup priority', () => {
    const w = world();
    w.room.memory.creepConfig = { newMine: w.demand('newMine', 2.7) };
    w.build(); w.game.time = 1000;
    w.room.memory.creepConfig = { newMine: w.demand('newMine', 2.7), maintained: w.demand('maintained'),
        local: w.demand('local', 1, 'harvester'), carrier: w.demand('carrier', 2, 'filler'),
        defense: w.demand('defense', 2.5, 'rdefender') };
    assert.deepEqual(w.build(), ['local', 'carrier', 'defense', 'maintained', 'newMine']);
});

test('cancelled, born and unsupported demand removes its age; an empty queue leaves no memory field', () => {
    const w = world();
    w.room.memory.creepConfig = { cancelled: w.demand('cancelled'), born: w.demand('born'), keep: w.demand('keep') };
    w.build();
    w.game.creeps.born = { memory: { role: 'rHarvester' }, room: { name: 'E41N5' } };
    w.room.memory.creepConfig = { born: w.demand('born'), keep: w.demand('keep'),
        unknown: w.demand('unknown', 2.6, 'unsupported') };
    w.game.time = 200;
    assert.deepEqual(w.build(), ['keep']);
    assert.deepEqual({ ...w.room.memory.creepSpawnWaitingSince }, { keep: 100 });
    w.room.memory.creepConfig = {};
    assert.deepEqual(w.build(), []);
    assert.equal(w.room.memory.creepSpawnWaitingSince, undefined);
});

test('same-tick births keep publication order and invalid or future ages are repaired', () => {
    const w = world();
    w.room.memory.creepConfig = { first: w.demand('first'), second: w.demand('second') };
    w.room.memory.creepSpawnWaitingSince = { first: NaN, second: 101, removed: 1 };
    assert.deepEqual(w.build(), ['first', 'second']);
    assert.deepEqual({ ...w.room.memory.creepSpawnWaitingSince }, { first: 100, second: 100 });
});

test('unrelated equal-priority work retains its original order without recording waiting ages', () => {
    const w = world();
    w.room.memory.creepConfig = { older: w.demand('older', 4, 'builder') };
    w.build(); w.game.time = 200;
    w.room.memory.creepConfig = { first: w.demand('first', 4, 'builder'), older: w.demand('older', 4, 'builder') };
    assert.deepEqual(w.build(), ['first', 'older']);
    assert.equal(w.room.memory.creepSpawnWaitingSince, undefined);
});
