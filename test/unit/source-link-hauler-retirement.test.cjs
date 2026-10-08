const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world({ cargo = 0, backlog = 0, published = false, transport = true, mineId = 'mine' } = {}) {
    const calls = [], source = { id: 'mine', pos: { inRangeTo: () => true } };
    const room = { name: 'E1N1', controller: { my: true }, links: [{}], sources: [source], containers: [],
        droppedResource: backlog ? [{ resourceType: 'energy', amount: backlog }] : [],
        memory: { creepConfig: {} }, spawns: [{ recycleCreep: creep => calls.push(creep.name) }] };
    const creep = { name: 'old-mine-hauler', store: { energy: cargo },
        memory: { spawnRoom: room.name, role: 'filler', development: {}, data: { sourceId: mineId, mineId } },
        pos: { inRangeTo: () => true } };
    if (published) room.memory.creepConfig[creep.name] = { role: 'filler', development: {} };
    const loader = createSourceLoader({ globals: { Game: { rooms: { [room.name]: room } }, RESOURCE_ENERGY: 'energy' },
        modules: { './development': { isDevelopingRoom: () => true }, 'room/sourceLinks': { hasSourceLinkTransport: () => transport } } });
    return { room, creep, calls, retire: loader.load('creep/developmentRetirement').retireDevelopmentCreep };
}

test('obsolete empty source hauler yields only after its demand and backlog disappear on a usable Link network', () => {
    const w = world(); assert.equal(w.retire(w.creep), true); assert.deepEqual(w.calls, [w.creep.name]);
    for (const options of [{ cargo: 20 }, { backlog: 100 }, { published: true }, { transport: false }, { mineId: 'storage' }]) {
        const w = world(options); assert.equal(w.retire(w.creep), false, JSON.stringify(options)); assert.equal(w.calls.length, 0);
    }
});

test('growth source hauler finishes delivering its last real load before recycling', () => {
    const w = world({ cargo: 50 });
    assert.equal(w.retire(w.creep), false);
    w.creep.store.energy = 0;
    assert.equal(w.retire(w.creep), true);
});

test('native source-only and controller-only topology never retires the last empty mine carrier', () => {
    for (const controllerOnly of [false, true]) {
        const calls = [], pos = (x, y) => ({ x, y, roomName: 'E1N1', inRangeTo: () => true });
        const source = { id: 'mine', pos: pos(10, 10) };
        const origin = { id: 'origin', structureType: 'link', my: true, pos: pos(12, 10), isActive: () => true };
        const receiver = { id: 'receiver', structureType: 'link', my: true, pos: pos(24, 25), isActive: () => true };
        const room = { name: 'E1N1', controller: { my: true, level: 6, pos: pos(25, 25) }, sources: [source],
            links: [origin, ...(controllerOnly ? [receiver] : [])], controllerLink: controllerOnly ? receiver : undefined,
            containers: [], droppedResource: [], memory: { creepConfig: {} }, spawns: [{ recycleCreep: () => calls.push('recycle') }],
            getTerrain: () => ({ get: () => 0 }), lookForAt: () => [], find: () => [] };
        const creep = { name: 'carrier', store: { energy: 0 }, pos: pos(11, 10),
            memory: { spawnRoom: room.name, role: 'filler', development: {}, data: { sourceId: source.id, mineId: source.id } } };
        const loader = createSourceLoader({ globals: { Game: { time: 1, shard: { name: 'shard1' }, rooms: { [room.name]: room } },
            RESOURCE_ENERGY: 'energy' }, modules: { './development': { isDevelopingRoom: () => true } } });
        assert.equal(loader.load('creep/developmentRetirement').retireDevelopmentCreep(creep), false);
        assert.deepEqual(calls, []);
    }
});
