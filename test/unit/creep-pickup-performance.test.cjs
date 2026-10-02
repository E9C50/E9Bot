const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world() {
    let distanceReads = 0;
    const actions = [];
    const room = { name: 'W1N1', storage: {}, droppedResource: [], ruins: [], tombstones: [] };
    const game = { rooms: { W1N1: room } }, memory = { warMode: {} };
    const loader = createSourceLoader({ globals: { Creep: class {}, Game: game, Memory: memory, RESOURCE_ENERGY: 'energy' }, modules: {
        'settings/structures': { structurePolicy: { creep: { minimumDroppedResource: 100 } } },
        'settings/boost': {}, 'settings/settings': {}, utils: { getDistance(a, b) { distanceReads++; return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); } },
    } });
    const creep = new (loader.load('mount/extension/CreepExtension').default)();
    Object.assign(creep, { room, memory: { spawnRoom: 'W1N1' }, pos: { x: 10, y: 10 }, store: { getFreeCapacity: () => 50 },
        pickup: target => actions.push(['pickup', target.id]), withdraw: (target, resource) => actions.push(['withdraw', target.id, resource]),
        moveTo: target => actions.push(['move', target.id]),
    });
    const dropped = (id, x = 11, type = 'energy', amount = 101) => ({ id, pos: { x, y: 10 }, resourceType: type, amount });
    const remains = (id, values, x = 11) => ({ id, pos: { x, y: 10 }, store: values });
    return { creep, room, game, memory, actions, dropped, remains, reads: () => distanceReads };
}

test('nearby first eligible dropped resource stops scanning without constructing filtered candidate arrays', () => {
    const w = world(); w.room.droppedResource = Array.from({ length: 100 }, (_, index) => w.dropped(`drop${index}`));
    w.room.droppedResource.filter = () => { throw new Error('must not filter the whole dropped list'); };
    Object.defineProperty(w.room, 'ruins', { get() { throw new Error('must not query remains after selecting a drop'); } });
    assert.equal(w.creep.pickupDroppedResource(true, 3), true);
    assert.deepEqual(w.actions, [['pickup', 'drop0']]); assert.equal(w.reads(), 1);
});

test('energy-only pickup skips unavailable minerals and works when the home room is invisible', () => {
    const w = world(); delete w.game.rooms.W1N1;
    w.room.droppedResource = [w.dropped('mineral', 11, 'U'), w.dropped('energy')];
    assert.equal(w.creep.pickupDroppedResource(true, 3), true);
    assert.deepEqual(w.actions, [['pickup', 'energy']]);
});

test('ruins precede tombstones and only one resource intent is issued per tick', () => {
    const w = world();
    w.room.ruins = [w.remains('ruin', { U: 3, energy: 4 })];
    Object.defineProperty(w.room, 'tombstones', { get() { throw new Error('must stop at the first usable ruin'); } });
    assert.equal(w.creep.pickupDroppedResource(true, 3), true);
    assert.deepEqual(w.actions, [['withdraw', 'ruin', 'U']]);
});

test('unusable remains do not hide later energy or report false success', () => {
    const w = world(); w.room.storage = undefined;
    w.room.ruins = [w.remains('empty', {}), w.remains('mineral', { U: 3 })];
    w.room.tombstones = [w.remains('tomb', { energy: 5 })];
    assert.equal(w.creep.pickupDroppedResource(true, 3), true);
    assert.deepEqual(w.actions, [['withdraw', 'tomb', 'energy']]);
    w.room.tombstones = []; w.actions.length = 0;
    assert.equal(w.creep.pickupDroppedResource(true, 3), false); assert.deepEqual(w.actions, []);
});

test('war pickup stays within one tile, distant candidates move once and a full creep does no search', () => {
    const w = world(); w.memory.warMode.W1N1 = true;
    w.room.droppedResource = [w.dropped('far', 13)];
    assert.equal(w.creep.pickupDroppedResource(true, 5), false);
    w.memory.warMode.W1N1 = false;
    assert.equal(w.creep.pickupDroppedResource(true, 5), true); assert.deepEqual(w.actions, [['move', 'far']]);
    w.creep.store.getFreeCapacity = () => 0; w.actions.length = 0;
    const before = w.reads(); assert.equal(w.creep.pickupDroppedResource(true, 5), false);
    assert.equal(w.reads(), before); assert.deepEqual(w.actions, []);
});
