const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

const recipes = {
    utrium_bar: { amount: 100, cooldown: 20, components: { U: 500, energy: 200 } },
    oxidant: { amount: 100, cooldown: 20, components: { O: 500, energy: 200 } },
    U: { amount: 500, cooldown: 20, components: { utrium_bar: 100, energy: 200 } },
    energy: { amount: 500, cooldown: 10, components: { battery: 50 } },
    battery: { amount: 50, cooldown: 10, components: { energy: 600 } },
    wire: { amount: 20, cooldown: 8, components: { silicon: 20, utrium_bar: 100, energy: 40 } },
    condensate: { amount: 20, cooldown: 8, components: { keanium_bar: 20, mist: 100, energy: 40 } },
    switch: { amount: 5, cooldown: 70, level: 1, components: { wire: 40, oxidant: 40, utrium_bar: 20, energy: 95 } },
    composite: { amount: 20, cooldown: 50, level: 1, components: { utrium_bar: 20, zynthium_bar: 20, energy: 20 } },
    crystal: { amount: 6, cooldown: 21, level: 2, components: { composite: 6, lemergium_bar: 6, purifier: 6, energy: 45 } },
};

function store(resources = {}, capacity = 50000) {
    const value = { ...resources };
    const used = () => Object.values(value).filter(item => typeof item === 'number').reduce((a, b) => a + b, 0);
    Object.defineProperties(value, {
        getCapacity: { value: () => capacity },
        getUsedCapacity: { value: resource => resource ? value[resource] || 0 : used() },
        getFreeCapacity: { value: () => capacity - used() },
    });
    return value;
}

function world(options = {}) {
    const objects = new Map(), actions = [], intents = [];
    const room = {
        name: 'W1N1', level: 8, mineral: { mineralType: options.mineral || 'U' }, labs: options.labs || [],
        memory: { roomFillJob: {}, roomLabConfig: { singleLabConfig: {} }, boostNeed: {}, ...options.memory },
        controller: { my: true, isPowerEnabled: !!options.warehouse },
    };
    const position = (x, y) => ({ x, y, roomName: room.name });
    const storage = { id: 'storage', structureType: 'storage', pos: position(10, 10),
        store: store(options.storage || { energy: 100000 }, options.warehouse ? 8000000 : 1000000) };
    const terminal = { id: 'terminal', structureType: 'terminal', pos: position(10, 11),
        store: store(options.terminal || { energy: 50000 }, 300000) };
    const factory = { id: 'factory', my: true, structureType: 'factory', room, pos: position(11, 10),
        store: store(options.factory || {}, options.capacity || 50000), cooldown: 0, level: options.level,
        effects: options.effects || [], isActive: () => options.active !== false,
        produce(resource) {
            actions.push(['produce', resource]);
            if (options.produceResult !== undefined) return options.produceResult;
            intents.push(() => {
                for (const [component, amount] of Object.entries(recipes[resource].components)) factory.store[component] -= amount;
                factory.store[resource] = (factory.store[resource] || 0) + recipes[resource].amount;
            });
            return 0;
        },
    };
    Object.assign(room, { storage, terminal, factory });
    for (const object of [storage, terminal, factory]) objects.set(object.id, object);
    const game = { time: 1, shard: { name: 'test' }, creeps: {}, rooms: { [room.name]: room }, getObjectById: id => objects.get(id) || null };
    const loader = createSourceLoader({ globals: {
        Game: game, COMMODITIES: recipes, PWR_OPERATE_FACTORY: 19,
        RESOURCE_ENERGY: 'energy', RESOURCE_BATTERY: 'battery', RESOURCE_GHODIUM: 'G',
        STRUCTURE_TERMINAL: 'terminal', OK: 0,
    }, modules: options.realNetwork ? {} : {
        'creep/boosting': { getActiveRoomBoostRequests: () => [] },
        'runtime/creepIndex': { getRoomProcessors: () => [] },
        './resourceNetwork': {
            getOutgoingResourceAmount: (name, resource) => options.outgoing?.[resource] || 0,
            getTerminalResourceAmount: (target, resource) => target.terminal.store[resource] || 0,
            recordTerminalWithdrawal() {},
            isWarehouseRoom: target => !!target.controller.isPowerEnabled && target.storage.store.getCapacity() >= 8000000,
            getGlobalResourceAmount: resource => Object.values(game.rooms).reduce((sum, target) => sum +
                (target.storage?.store[resource] || 0) + (target.terminal?.store[resource] || 0) + (target.factory?.store[resource] || 0), 0),
        },
    } });
    const production = loader.load('room/factory');
    function creep(name = 'processer', x = 11, y = 11, held = {}) {
        const worker = { name, room, pos: position(x, y), store: store(held, 1000),
            memory: { role: name.startsWith('manager') ? 'manager' : 'processer', working: false },
            moveTo(target) { actions.push(['move', name, target.id]); return 0; },
            withdraw(target, resource, amount) {
                actions.push(['withdraw', name, target.id, resource, amount]);
                intents.push(() => { target.store[resource] -= amount; worker.store[resource] = (worker.store[resource] || 0) + amount; });
                return 0;
            },
            transfer(target, resource, amount) {
                actions.push(['transfer', name, target.id, resource, amount]);
                intents.push(() => { worker.store[resource] -= amount; target.store[resource] = (target.store[resource] || 0) + amount; });
                return 0;
            },
        };
        game.creeps[name] = worker;
        return worker;
    }
    const nextTick = () => { intents.splice(0).forEach(intent => intent()); game.time++; actions.length = 0; };
    return { production, loader, room, factory, storage, terminal, game, actions, creep, nextTick };
}

function measuredPlanning(available = true) {
    const w = world({ storage: { energy: 100000, shared: available ? 1000 : 0, utrium_bar: 100 } });
    const metrics = { components: 0, ingredientReads: 0, globalReads: 0, capacityReads: 0 };
    const catalog = {};
    for (let index = 0; index < 25; index++) catalog[`commodity${String(index).padStart(2, '0')}`] = {
        amount: 20, cooldown: 10, components: new Proxy({ shared: 10, energy: 20, utrium_bar: 2 }, {
            ownKeys(target) { metrics.components++; return Reflect.ownKeys(target); },
        }),
    };
    w.loader.globals.COMMODITIES = catalog;
    for (const object of [w.storage, w.terminal, w.factory]) object.store = new Proxy(object.store, {
        get(target, key) {
            if (['shared', 'energy', 'utrium_bar'].includes(key)) metrics.ingredientReads++;
            if (typeof key === 'string' && key.startsWith('commodity')) metrics.globalReads++;
            if (object === w.factory && key === 'getCapacity') metrics.capacityReads++;
            return target[key];
        },
    });
    return { ...w, metrics, resetMetrics() { for (const key in metrics) metrics[key] = 0; } };
}

test('factory planning parses static recipes once and reads each shared ingredient and global candidate only once per pass', () => {
    const w = measuredPlanning();
    w.production.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.factoryProduction.resourceType, 'commodity00', 'equal global stock keeps the original lexical tie break');
    assert.deepEqual(w.metrics, { components: 25, ingredientReads: 9, globalReads: 75, capacityReads: 1 });
    w.resetMetrics(); w.game.time++;
    w.production.planFactoryProduction(w.factory);
    assert.deepEqual(w.metrics, { components: 0, ingredientReads: 9, globalReads: 0, capacityReads: 1 }, 'a stable batch retains its recipe without scanning candidates');
});

test('an unavailable shared reagent short-circuits factory candidates while keeping precursor reserves current', () => {
    const w = measuredPlanning(false);
    w.production.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.factoryProduction, undefined);
    assert.equal(w.room.memory.productionReserve.factory.utrium_bar, 2);
    assert.deepEqual(w.metrics, { components: 25, ingredientReads: 6, globalReads: 0, capacityReads: 1 });
    w.resetMetrics(); w.game.time++;
    w.production.planFactoryProduction(w.factory);
    assert.deepEqual(w.metrics, { components: 0, ingredientReads: 6, globalReads: 0, capacityReads: 1 });
    w.storage.store.utrium_bar = 1;
    w.production.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.productionReserve.factory.utrium_bar, 1, 'cached requirements never cache actual inventory');
});

test('factory recipe tables and changed component objects refresh both batch inputs and precursor requirements', () => {
    const w = world({ storage: { energy: 100000, silicon: 100, utrium_bar: 100, keanium_bar: 100 } });
    w.production.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.factoryProduction.resourceType, 'wire');
    const changed = { ...recipes, wire: { ...recipes.wire, components: { silicon: 30, utrium_bar: 50, energy: 40 } } };
    w.loader.globals.COMMODITIES = changed;
    w.production.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.factoryProduction.inputs.utrium_bar, 50);
    assert.equal(w.room.memory.productionReserve.factory.utrium_bar, 50);
    changed.wire.components = { silicon: 10, utrium_bar: 20, energy: 40 };
    w.production.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.factoryProduction.inputs.utrium_bar, 20);
    assert.equal(w.room.memory.productionReserve.factory.utrium_bar, 20);
    w.storage.store.mist = 100;
    w.loader.globals.COMMODITIES = { condensate: recipes.condensate };
    w.production.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.factoryProduction.resourceType, 'condensate');
    assert.equal(w.room.memory.productionReserve.factory.utrium_bar, undefined);
});

test('factory selection preserves higher-level preference then minimum global stock per produced unit', () => {
    for (const [switchAmount, compositeAmount, expected] of [[50, 20, 'composite'], [5, 40, 'switch'], [5, 20, 'composite']]) {
        const w = world({ level: 1, effects: [{ effect: 19, level: 1, ticksRemaining: 20 }], storage: {
            energy: 100000, silicon: 1000, wire: 80, oxidant: 80, utrium_bar: 400, zynthium_bar: 400,
            switch: switchAmount, composite: compositeAmount,
        } });
        w.production.planFactoryProduction(w.factory);
        assert.equal(w.room.memory.factoryProduction.resourceType, expected);
        assert.equal(w.room.memory.factoryProduction.mode, 'commodity');
    }
});

test('separate same-tick factory planning calls observe new lab, boost and outgoing reservations', () => {
    const outgoing = {}, w = world({ outgoing, storage: { energy: 100000, silicon: 1000, utrium_bar: 1000 } });
    w.production.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.factoryProduction.resourceType, 'wire');
    w.room.memory.productionReserve.lab = { utrium_bar: 1000 };
    w.production.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.factoryProduction, undefined);
    w.room.memory.productionReserve.lab = {};
    w.room.memory.boostNeed.utrium_bar = 1000;
    w.production.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.factoryProduction, undefined);
    w.room.memory.boostNeed.utrium_bar = 0; outgoing.utrium_bar = 1000;
    w.production.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.factoryProduction, undefined);
    outgoing.utrium_bar = 0;
    w.production.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.factoryProduction.resourceType, 'wire');
});

test('factory reserve refresh after successful production excludes ingredients consumed by its pending native intent', () => {
    const w = world({ storage: { energy: 100000 }, factory: { silicon: 20, utrium_bar: 100, energy: 40 } });
    w.production.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.productionReserve.factory.utrium_bar, 100);
    w.production.runFactoryProduction(w.factory);
    assert.equal(w.factory.store.utrium_bar, 100, 'native stores still contain pre-intent stock');
    assert.equal(w.room.memory.productionReserve.factory.utrium_bar, 0, 'reservation already observes scheduled consumption');
});

test('factory prioritizes a locally feasible commodity over compression and immediately preempts compression', () => {
    const w = world({ storage: { energy: 100000, U: 15000 } });
    w.production.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.factoryProduction.resourceType, 'utrium_bar');
    assert.equal(w.room.memory.factoryProduction.remaining, 10);
    w.storage.store.silicon = 200;
    w.storage.store.utrium_bar = 1000;
    w.game.time++;
    w.production.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.factoryProduction.resourceType, 'wire');
    assert.equal(w.room.memory.factoryProduction.mode, 'commodity');
    assert.equal(w.room.memory.factoryProduction.remaining, 10);
    assert.equal(w.room.memory.productionReserve.factory.utrium_bar, 1000);
});

test('factory compresses only its mined mineral surplus above the 10000 ordinary-room floor', () => {
    const w = world({ storage: { energy: 100000, U: 10499, O: 20000 } });
    w.production.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.factoryProduction, undefined);
    w.storage.store.U = 10500;
    w.production.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.factoryProduction.resourceType, 'utrium_bar');
    assert.equal(w.room.memory.factoryProduction.remaining, 1);
    assert.equal(w.room.memory.productionReserve.factory.U, 500);
    assert.equal(w.room.memory.productionReserve.factory.O, undefined);
    const warehouse = world({ warehouse: true, storage: { energy: 100000, U: 500 } });
    warehouse.production.planFactoryProduction(warehouse.factory);
    assert.equal(warehouse.room.memory.factoryProduction.resourceType, 'utrium_bar');
});

test('terminal energy reserve and lab-reserved ingredients cannot be spent by factory production', () => {
    const energy = world({ storage: { energy: 199, U: 11000 }, terminal: { energy: 50000 } });
    energy.production.planFactoryProduction(energy.factory);
    assert.equal(energy.room.memory.factoryProduction, undefined);
    const labs = world({ storage: { energy: 100000, U: 10500 }, memory: { productionReserve: { lab: { U: 500 } } } });
    labs.production.planFactoryProduction(labs.factory);
    assert.equal(labs.room.memory.factoryProduction, undefined);
    assert.equal(labs.room.memory.productionReserve.lab.U, 500);
    const committed = world({ warehouse: true, storage: { energy: 100000, U: 500 }, outgoing: { U: 500 } });
    committed.production.planFactoryProduction(committed.factory);
    assert.equal(committed.room.memory.factoryProduction, undefined, 'committed terminal cargo is not factory stock');
});

test('lab stock is not counted as movable factory ingredients, even if empire totals contain it', () => {
    const w = world({ storage: { energy: 100000, silicon: 20 }, labs: [{ store: store({ utrium_bar: 100 }) }] });
    w.production.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.factoryProduction, undefined);
    w.terminal.store.utrium_bar = 100;
    w.production.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.factoryProduction.resourceType, 'wire');
});

test('leveled commodities require the exact permanent level and a live matching power effect', () => {
    const w = world({ level: 1, storage: { energy: 100000, wire: 80, oxidant: 80, utrium_bar: 40, U: 10500 } });
    assert.equal(w.production.canProduceFactoryRecipe(w.factory, 'switch'), false);
    w.factory.effects = [{ effect: 19, level: 1, ticksRemaining: 0 }];
    assert.equal(w.production.canProduceFactoryRecipe(w.factory, 'switch'), false);
    w.factory.effects[0].ticksRemaining = 20;
    assert.equal(w.production.canProduceFactoryRecipe(w.factory, 'switch'), true);
    assert.equal(w.production.canProduceFactoryRecipe(w.factory, 'crystal'), false);
    w.production.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.factoryProduction.resourceType, 'switch');
    w.factory.effects[0].level = 2;
    assert.equal(w.production.canProduceFactoryRecipe(w.factory, 'switch'), false);
    assert.equal(w.production.canProduceFactoryRecipe(w.factory, 'utrium_bar'), false);
});

test('commodity precursors remain reserved for the next recipe while factory power is refreshed', () => {
    const w = world({ level: 1, storage: { energy: 100000, wire: 100, oxidant: 100, utrium_bar: 100 } });
    w.production.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.factoryProduction, undefined);
    assert.equal(w.room.memory.productionReserve.factory.wire, 40);
    assert.equal(w.room.memory.productionReserve.factory.oxidant, 40);
    assert.equal(w.room.memory.productionReserve.factory.utrium_bar, 100);
});

test('production observes cooldown, checks output capacity after ingredient consumption and schedules once per tick', () => {
    const w = world({ storage: { energy: 100000 }, factory: { silicon: 20, utrium_bar: 100, energy: 40 }, capacity: 160 });
    w.production.planFactoryProduction(w.factory);
    w.factory.cooldown = 3;
    w.production.runFactoryProduction(w.factory);
    assert.deepEqual(w.actions, []);
    w.factory.cooldown = 0;
    w.production.runFactoryProduction(w.factory);
    w.production.runFactoryProduction(w.factory);
    assert.deepEqual(w.actions, [['produce', 'wire']]);
    assert.equal(w.room.memory.factoryProduction, undefined);
    w.nextTick();
    assert.equal(w.factory.store.wire, 20);
});

test('batch inputs fit factory capacity and an impossible recipe does not get a plan', () => {
    const w = world({ storage: { energy: 100000, silicon: 10000, utrium_bar: 10000 }, capacity: 1200 });
    w.production.planFactoryProduction(w.factory);
    const inputs = Object.values(w.room.memory.factoryProduction.inputs).reduce((a, b) => a + b, 0);
    assert.equal(w.room.memory.factoryProduction.remaining, 1);
    assert.ok(inputs <= 1200);
    const impossible = world({ storage: { energy: 100000, silicon: 20, utrium_bar: 100 }, capacity: 159 });
    impossible.production.planFactoryProduction(impossible.factory);
    assert.equal(impossible.room.memory.factoryProduction, undefined);
});

test('factory logistics fills one bounded batch, holds in-transit reservations and leaves terminal energy untouched', () => {
    const w = world({ storage: { silicon: 20, utrium_bar: 100 }, terminal: { energy: 50100 } });
    const first = w.creep('processer-first'), second = w.creep('manager-second');
    w.production.planFactoryProduction(w.factory);
    assert.equal(w.production.runFactoryLogistics(first), true);
    assert.deepEqual(w.actions, [['withdraw', first.name, 'storage', 'silicon', 20]]);
    assert.equal(w.production.runFactoryLogistics(second, true), true);
    assert.deepEqual(w.actions[1], ['withdraw', second.name, 'storage', 'utrium_bar', 100]);
    w.nextTick();
    w.production.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.factoryProduction.resourceType, 'wire', 'in-transit input must keep its plan alive');
    w.production.runFactoryLogistics(first);
    w.production.runFactoryLogistics(second, true);
    assert.deepEqual(w.actions, [['transfer', first.name, 'factory', 'silicon', 20], ['transfer', second.name, 'factory', 'utrium_bar', 100]]);
    w.nextTick();
    w.production.runFactoryLogistics(first);
    assert.deepEqual(w.actions, [['withdraw', first.name, 'terminal', 'energy', 40]]);
    w.nextTick();
    assert.equal(w.terminal.store.energy, 50060);
});

test('a stationary manager does not leave its seat; a mobile processor clears output to the terminal', () => {
    const w = world({ factory: { wire: 2000 } });
    const manager = w.creep('manager', 30, 30), processor = w.creep('processer', 30, 30);
    assert.equal(w.production.runFactoryLogistics(manager, true), false);
    assert.equal(manager.memory.factoryLogistics, undefined);
    assert.equal(w.production.runFactoryLogistics(processor), true);
    assert.deepEqual(w.actions, [['move', processor.name, 'factory']]);
    processor.pos = { x: 11, y: 11, roomName: w.room.name };
    w.production.runFactoryLogistics(processor);
    assert.deepEqual(w.actions[1], ['withdraw', processor.name, 'factory', 'wire', 1000]);
    w.nextTick();
    w.production.runFactoryLogistics(processor);
    assert.deepEqual(w.actions, [['transfer', processor.name, 'terminal', 'wire', 1000]]);
    w.nextTick();
    assert.equal(w.terminal.store.wire, 1000);
    assert.equal(processor.memory.factoryLogistics, undefined);
});

test('a warehouse loads available commodity inputs before clearing its existing 24457 factory energy', () => {
    const w = world({ warehouse: true, storage: { energy: 100000, keanium_bar: 122, mist: 600 }, factory: { energy: 24457 } });
    const worker = w.creep();
    w.production.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.factoryProduction.resourceType, 'condensate');
    assert.equal(w.room.memory.factoryProduction.remaining, 6);
    w.production.runFactoryLogistics(worker);
    assert.deepEqual(w.actions, [['withdraw', worker.name, 'storage', 'keanium_bar', 120]]);
    for (let tick = 0; tick < 4; tick++) {
        w.nextTick();
        w.production.runFactoryLogistics(worker);
        w.production.runFactoryProduction(w.factory);
        assert.equal(w.actions.some(action => action[0] === 'withdraw' && action[2] === 'factory' && action[3] === 'energy'), false);
    }
    assert.ok(w.actions.some(action => action[0] === 'produce' && action[1] === 'condensate'));
    w.nextTick();
    assert.equal(w.factory.store.condensate, 20);
    assert.equal(w.factory.store.energy, 24417, 'the fuel stays available for further commodity production');
    assert.equal(w.terminal.store.energy, 50000);
});

test('a full factory clears only enough excess fuel to make room for its next commodity reaction', () => {
    const w = world({ warehouse: true, storage: { energy: 100000, keanium_bar: 122, mist: 600 }, factory: { energy: 50000 } });
    const worker = w.creep();
    w.production.planFactoryProduction(w.factory);
    w.production.runFactoryLogistics(worker);
    assert.deepEqual(w.actions, [['withdraw', worker.name, 'factory', 'energy', 120]]);
    w.nextTick();
    w.production.runFactoryLogistics(worker);
    w.nextTick();
    w.production.runFactoryLogistics(worker);
    assert.deepEqual(w.actions, [['withdraw', worker.name, 'storage', 'keanium_bar', 20]]);
    w.nextTick();
    w.production.runFactoryLogistics(worker);
    w.nextTick();
    w.production.runFactoryLogistics(worker);
    assert.deepEqual(w.actions, [['withdraw', worker.name, 'storage', 'mist', 100]]);
    w.nextTick();
    w.production.runFactoryLogistics(worker);
    w.nextTick();
    w.production.runFactoryProduction(w.factory);
    assert.deepEqual(w.actions, [['produce', 'condensate']]);
});

test('factory carriers share remaining capacity and leave room for every next-reaction component', () => {
    const w = world({ storage: { energy: 100000, silicon: 120, utrium_bar: 600 }, factory: { wire: 1840 }, capacity: 2000 });
    const workers = [w.creep('processer-first'), w.creep('processer-second'), w.creep('manager-third')];
    w.production.planFactoryProduction(w.factory);
    for (const worker of workers) w.production.runFactoryLogistics(worker);
    assert.deepEqual(w.actions, [
        ['withdraw', workers[0].name, 'storage', 'silicon', 20],
        ['withdraw', workers[1].name, 'storage', 'utrium_bar', 100],
        ['withdraw', workers[2].name, 'storage', 'energy', 40],
    ]);
    w.nextTick();
    for (const worker of workers) w.production.runFactoryLogistics(worker);
    assert.equal(w.actions.reduce((sum, action) => sum + action[4], 0), 160);
    w.nextTick();
    assert.equal(w.factory.store.getFreeCapacity(), 0);
    w.production.runFactoryProduction(w.factory);
    assert.deepEqual(w.actions, [['produce', 'wire']]);
});

test('same-tick production consumption is not mistaken for surplus to drain', () => {
    const w = world({ storage: { energy: 100000 }, factory: { silicon: 40, utrium_bar: 200, energy: 80 } });
    const worker = w.creep();
    w.production.planFactoryProduction(w.factory);
    w.production.runFactoryProduction(w.factory);
    assert.equal(w.production.runFactoryLogistics(worker), false);
    assert.deepEqual(w.actions, [['produce', 'wire']]);
    assert.equal(w.room.memory.factoryProduction.remaining, 1);
});

test('completed transfer intents prevent a second processor from loading the same factory deficit in that tick', () => {
    const w = world({ storage: { energy: 100000, silicon: 100 } });
    const first = w.creep('processer-first', 11, 11, { silicon: 20 }), second = w.creep('processer-second');
    w.room.memory.factoryProduction = { resourceType: 'wire', mode: 'commodity', remaining: 1, inputs: { silicon: 20 }, createdAt: 1 };
    first.memory.factoryLogistics = { factoryId: 'factory', sourceId: 'storage', targetId: 'factory',
        resourceType: 'silicon', amount: 20, phase: 'transfer' };
    assert.equal(w.production.runFactoryLogistics(first), true);
    assert.equal(first.memory.factoryLogistics, undefined);
    assert.equal(w.production.runFactoryLogistics(second), false);
    assert.deepEqual(w.actions, [['transfer', first.name, 'factory', 'silicon', 20]]);
});

test('factory deliveries share terminal headroom with inbound sends and other local deliveries', () => {
    const w = world({ terminal: { energy: 298500 } });
    const first = w.creep('processer-first', 11, 11, { wire: 1000 }), second = w.creep('processer-second', 11, 11, { wire: 1000 });
    const incoming = w.loader.load('room/evacuation');
    incoming.reserveEvacuationIncoming(w.room, 200);
    for (const worker of [first, second]) worker.memory.factoryLogistics = { factoryId: 'factory', sourceId: 'factory', targetId: 'terminal',
        resourceType: 'wire', amount: 1000, phase: 'transfer' };
    w.production.runFactoryLogistics(first);
    w.production.runFactoryLogistics(second);
    assert.deepEqual(w.actions, [['transfer', first.name, 'terminal', 'wire', 1000], ['transfer', second.name, 'terminal', 'wire', 300]]);
    assert.equal(incoming.getEvacuationIncomingCapacity(w.room), 0);
});

test('a successful terminal send cannot leave factory logistics spending its stale pre-send energy or cargo', () => {
    const w = world({ realNetwork: true, storage: {}, terminal: { energy: 60000, wire: 100 },
        factory: { silicon: 20, utrium_bar: 100 } });
    const worker = w.creep();
    w.game.market = { calcTransactionCost: () => 10000 };
    w.terminal.send = (resource, amount) => { w.actions.push(['send', resource, amount]); return 0; };
    w.production.planFactoryProduction(w.factory);
    w.room.memory.terminalSendJob = { manual: { resourceType: 'wire', amount: 100, targetRoom: 'W9N9' } };
    w.loader.load('room/terminal').processTerminalResource(w.room);
    const network = w.loader.load('room/resourceNetwork');
    assert.deepEqual(w.actions, [['send', 'wire', 100]]);
    assert.equal(w.terminal.store.energy, 60000, 'the fixture preserves real Screeps delayed intent settlement');
    assert.equal(network.getTerminalResourceAmount(w.room, 'energy'), 50000);
    assert.equal(network.getTerminalResourceAmount(w.room, 'wire'), 0);
    assert.equal(w.production.runFactoryLogistics(worker), false, 'factory cannot borrow the just-spent transmission fee');
    w.production.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.factoryProduction, undefined, 'already transmitted balances cannot fund a new batch');
});

test('factory terminal withdrawals share a balance ledger with other room logistics without reducing global inventory', () => {
    const w = world({ realNetwork: true, storage: {}, terminal: { energy: 50050 }, factory: { silicon: 20, utrium_bar: 100 } });
    const worker = w.creep();
    w.production.planFactoryProduction(w.factory);
    const network = w.loader.load('room/resourceNetwork'), total = network.getRoomResourceAmount(w.room, 'energy');
    assert.equal(w.production.runFactoryLogistics(worker), true);
    assert.deepEqual(w.actions, [['withdraw', worker.name, 'terminal', 'energy', 40]]);
    assert.equal(network.getTerminalResourceAmount(w.room, 'energy'), 50010);
    assert.equal(network.getRoomResourceAmount(w.room, 'energy'), total, 'internal logistics preserves total inventory');
});

test('cancelled factory plans return in-transit inputs and inactive/evacuating factories do not consume resources', () => {
    const w = world({ storage: { energy: 100000, silicon: 20, utrium_bar: 100 } });
    const worker = w.creep();
    w.production.planFactoryProduction(w.factory);
    w.production.runFactoryLogistics(worker);
    w.nextTick();
    delete w.room.memory.factoryProduction;
    w.production.runFactoryLogistics(worker);
    assert.deepEqual(w.actions, [['transfer', worker.name, 'terminal', 'silicon', 20]]);
    const inactive = world({ active: false, storage: { energy: 100000, U: 15000 } });
    inactive.production.planFactoryProduction(inactive.factory);
    assert.equal(inactive.room.memory.factoryProduction, undefined);
    w.room.memory.evacuation = {};
    w.production.planFactoryProduction(w.factory);
    assert.equal(w.room.memory.productionReserve.factory, undefined);
});

test('processer role stays useful in a room with a factory and no labs', () => {
    const w = world();
    assert.equal(w.loader.load('role/adv/RoleAdvProcesser').default({}).isNeed(w.room, 'processor'), true);
    delete w.room.factory;
    assert.equal(w.loader.load('role/adv/RoleAdvProcesser').default({}).isNeed(w.room, 'processor'), false);
});
