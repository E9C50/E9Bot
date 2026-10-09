const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world() {
    let storeBuilds = 0, storeReads = 0, capacityCalls = 0, energyReads = 0, capacityReads = 0;
    const game = { time: 1 };
    const loader = createSourceLoader({ globals: { Game: game, StructureTower: class {}, RESOURCE_ENERGY: 'energy' },
        modules: { 'combat/towers': { runRoomTowerDefense() {} } } });
    const Tower = loader.load('mount/structure/TowerExtension').default;
    function tower(id, room, values = {}) {
        const instance = Object.create(Tower.prototype);
        instance.id = id; instance.room = room;
        let built;
        Object.defineProperties(instance, {
            energy: { get() { energyReads++; return values.energy; } },
            energyCapacity: { get() { capacityReads++; return values.capacity; } },
            store: { get() {
                storeReads++;
                if (built === undefined) {
                    storeBuilds++;
                    built = new Proxy({ getFreeCapacity(resource) {
                        capacityCalls++; assert.equal(resource, 'energy'); return values.free;
                    } }, { get(target, key) { return target[key]; } });
                }
                return built;
            } },
        });
        return instance;
    }
    return { game, tower, room: () => ({ memory: { roomFillJob: {} } }),
        tick: () => game.time++, reads: () => ({ storeBuilds, storeReads, capacityCalls, energyReads, capacityReads }) };
}

test('ten full rooms with six native-like towers keep per-tick initialization while constructing zero Stores', () => {
    const w = world(), rooms = Array.from({ length: 10 }, () => w.room());
    for (let tick = 0; tick < 31; tick++) {
        for (const [roomIndex, room] of rooms.entries()) {
            // Native game wrappers and their lazy Stores are fresh each tick.
            for (let index = 0; index < 6; index++)
                w.tower(`${roomIndex}:tower:${index}`, room, { energy: 1000, capacity: 1000, free: 0 }).init();
            assert.deepEqual(Array.from(room.memory.roomFillJob.tower), []);
        }
        w.tick();
    }
    assert.deepEqual(w.reads(), { storeBuilds: 0, storeReads: 0, capacityCalls: 0,
        energyReads: 10 * 6 * 31, capacityReads: 10 * 6 * 31 });
});

test('already queued tower IDs skip capacity work and stay in their original queue order without duplicate jobs', () => {
    const w = world(), room = w.room();
    room.memory.roomFillJob.tower = ['earlier', 'tower', 'later'];
    const tower = w.tower('tower', room, { energy: 0, capacity: 1000, free: 1000 });
    tower.init(); w.tick(); tower.init();
    assert.deepEqual(room.memory.roomFillJob.tower, ['earlier', 'tower', 'later']);
    assert.deepEqual(w.reads(), { storeBuilds: 0, storeReads: 0, capacityCalls: 0, energyReads: 0, capacityReads: 0 });
});

test('the exact refill threshold and newly consumed energy remain visible on the next tick', () => {
    const w = world(), room = w.room();
    const values = { energy: 900, capacity: 1000, free: 100 };
    w.tower('tower', room, values).init();
    assert.deepEqual(Array.from(room.memory.roomFillJob.tower), [], 'exactly one hundred free capacity does not queue');
    w.tick(); values.energy = 899;
    w.tower('tower', room, values).init();
    assert.deepEqual(Array.from(room.memory.roomFillJob.tower), ['tower'], 'one additional energy consumed queues immediately');
    assert.equal(w.reads().energyReads, 2); assert.equal(w.reads().storeBuilds, 0);
});

test('native scalar capacities preserve private-server limits and an empty tower can request energy', () => {
    for (const [energy, capacity, queued] of [[1400, 1500, false], [1399, 1500, true], [0, 1500, true]]) {
        const w = world(), room = w.room();
        w.tower('tower', room, { energy, capacity, free: -1 }).init();
        assert.equal(room.memory.roomFillJob.tower.includes('tower'), queued);
        assert.equal(w.reads().capacityCalls, 0, 'uses the actual scalar capacity without a standard-capacity assumption');
    }
});

test('missing or nonnumeric scalar aliases fall back to the real Store capacity, including null and boundary values', () => {
    for (const [energy, capacity, free, queued] of [
        [undefined, undefined, 101, true], [0, undefined, 100, false], [undefined, 1000, 0, false],
        ['900', 1000, 101, true], [900, null, 101, true], [undefined, undefined, null, false],
    ]) {
        const w = world(), room = w.room();
        w.tower('tower', room, { energy, capacity, free }).init();
        assert.equal(room.memory.roomFillJob.tower.includes('tower'), queued);
        assert.equal(w.reads().storeBuilds, 1); assert.equal(w.reads().capacityCalls, 1);
    }
});

test('removing a completed job permits a new refill request in the same tick', () => {
    const w = world(), room = w.room(), values = { energy: 500, capacity: 1000 };
    const tower = w.tower('tower', room, values);
    tower.init(); room.memory.roomFillJob.tower.length = 0; tower.init();
    assert.deepEqual(Array.from(room.memory.roomFillJob.tower), ['tower']);
    assert.equal(w.reads().energyReads, 2, 'queue membership and energy are reevaluated on every direct call');
});
