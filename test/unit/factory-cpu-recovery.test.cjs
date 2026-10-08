const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world() {
    const recipes = {
        utrium_bar: { amount: 100, cooldown: 20, components: { U: 500, energy: 200 } },
        wire: { amount: 20, cooldown: 8, components: { silicon: 20, utrium_bar: 100, energy: 40 } },
    };
    const scans = { capacity: 0, resources: 0 };
    const store = (resources, capacity) => {
        const result = new Proxy({ ...resources }, {
            get(target, key) {
                if (typeof key === 'string' && !key.startsWith('get')) scans.resources++;
                return target[key];
            },
        });
        Object.defineProperties(result, {
            getCapacity: { value: () => capacity, configurable: true },
            getFreeCapacity: { value: () => capacity - Object.values(result).reduce((total, amount) => total + amount, 0) },
        });
        return result;
    };
    const room = { name: 'E31N2', mineral: { mineralType: 'U' }, labs: [],
        controller: { my: true, isPowerEnabled: false }, memory: { boostNeed: {} },
        storage: { store: store({ U: 320000, energy: 100000 }, 1000000) },
        terminal: { store: store({ energy: 50000 }, 300000) } };
    const factory = { id: 'factory', room, my: true, level: undefined, effects: [], cooldown: 0,
        isActive: () => true, store: store({}, 50000) };
    Object.defineProperty(factory.store, 'getCapacity', { value: () => { scans.capacity++; return 50000; } });
    room.factory = factory;
    const game = { time: 1, shard: { name: 'shard3' }, cpu: { bucket: 1000 }, creeps: {}, rooms: { [room.name]: room } };
    const loader = createSourceLoader({ globals: {
        Game: game, COMMODITIES: recipes, PWR_OPERATE_FACTORY: 19, StructureFactory: class {},
        RESOURCE_ENERGY: 'energy', RESOURCE_BATTERY: 'battery', RESOURCE_GHODIUM: 'G', STRUCTURE_TERMINAL: 'terminal', OK: 0,
    }, modules: { './resourceNetwork': {
        getOutgoingResourceAmount: () => 0,
        getTerminalResourceAmount: (target, resource) => target.terminal.store[resource] || 0,
        recordTerminalWithdrawal() {}, isWarehouseRoom: () => false,
        getGlobalResourceAmount: resource => (room.storage.store[resource] || 0) +
            (room.terminal.store[resource] || 0) + (factory.store[resource] || 0),
        createResourceInventory: () => ({ globalAmount: resource => (room.storage.store[resource] || 0) +
            (room.terminal.store[resource] || 0) + (factory.store[resource] || 0) }),
    } } });
    const api = loader.load('room/factory');
    return { room, factory, game, loader, api, scans };
}

test('factory plans every tick even with an empty bucket and keeps reservations current', () => {
    const w = world();
    w.api.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.factoryProduction.resourceType, 'utrium_bar');
    w.game.cpu.bucket = 0;
    w.scans.capacity = 0;
    for (let tick = 1; tick <= 100; tick++) {
        w.game.time = tick;
        w.api.planFactoryProduction(w.factory);
        assert.equal(w.room.memory.factoryProduction.resourceType, 'utrium_bar');
        assert.equal(w.room.memory.productionReserve.factory.U, w.room.memory.factoryProduction.inputs.U);
    }
    assert.equal(w.scans.capacity, 100, 'low CPU does not change the production planning cadence');
});

test('factory extension still prepares a batch with an empty bucket', () => {
    const w = world();
    w.game.cpu.bucket = 0;
    w.loader.load('mount/structure/FactoryExtension').default.prototype.init.call(w.factory);
    assert.equal(w.scans.capacity, 1);
    assert.equal(w.room.memory.factoryProduction.resourceType, 'utrium_bar');
});

test('newly available commodities preempt compression immediately even with an empty bucket', () => {
    const w = world();
    w.api.planFactoryProduction(w.factory);
    w.game.cpu.bucket = 0;
    w.room.storage.store.silicon = 1000;
    w.room.storage.store.utrium_bar = 2000;
    w.api.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.factoryProduction.resourceType, 'wire');
    assert.equal(w.room.memory.factoryProduction.mode, 'commodity');
});

test('invalid factories clear batch and reservations immediately with an empty bucket', () => {
    const invalidate = [
        w => { w.room.memory.evacuation = {}; },
        w => { w.factory.my = false; },
        w => { w.factory.isActive = () => false; },
        w => { delete w.room.storage; },
        w => { delete w.room.terminal; },
    ];
    for (const change of invalidate) {
        const w = world();
        w.api.planFactoryProduction(w.factory);
        w.room.memory.productionReserve.lab = { U: 1000 };
        w.game.cpu.bucket = 0;
        change(w);
        w.api.planFactoryProduction(w.factory);
        assert.equal(w.room.memory.factoryProduction, undefined);
        assert.equal(w.room.memory.productionReserve.factory, undefined);
        assert.equal(w.room.memory.productionReserve.lab.U, 1000);
    }
});

test('same-tick stock changes remain observable during ordinary planning', () => {
    const w = world();
    w.api.planFactoryProduction(w.factory);
    w.room.storage.store.silicon = 1000;
    w.room.storage.store.utrium_bar = 2000;
    w.api.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.factoryProduction.resourceType, 'wire');
    assert.equal(w.scans.capacity, 2, 'planning does not reuse an obsolete same-tick inventory snapshot');
});
