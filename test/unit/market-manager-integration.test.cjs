const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function store(resources = {}, capacity = 300000) {
    const result = { ...resources };
    Object.defineProperties(result, {
        getUsedCapacity: { value: resource => resource ? result[resource] || 0 :
            Object.values(result).reduce((total, amount) => total + amount, 0) },
        getFreeCapacity: { value: () => Math.max(0, capacity - result.getUsedCapacity()) },
        getCapacity: { value: () => capacity }
    });
    return result;
}

/** Native stores change only after all room work and the Manager intent have run. */
function world({ storage = { energy: 600000 }, terminal = { energy: 50000 },
    warehouse = false, storageCapacity = warehouse ? 8000000 : 1000000,
    terminalCapacity = 300000, managerCapacity = 2450, scanInterval = 25 } = {}) {
    const events = [], intents = [], incoming = new Map();
    const order = { id: 'energy-buyer', type: 'buy', resourceType: 'energy',
        remainingAmount: 10000000, amount: 10000000, price: 1, roomName: 'W5N1' };
    const game = { time: scanInterval, shard: { name: 'shard3' }, rooms: {}, creeps: {},
        cpu: { bucket: 10000 }, market: {
            orders: {}, calcTransactionCost: amount => Math.ceil(amount / 10),
            getAllOrders: filter => filter.resourceType === 'energy' ? [{ ...order }] : [],
            deal(id, amount, roomName) {
                const room = game.rooms[roomName], fee = game.market.calcTransactionCost(amount);
                assert.equal(id, order.id);
                assert.ok(amount > 0 && amount <= order.remainingAmount, 'live buy order can accept the deal');
                assert.ok(room.terminal.cooldown === 0, 'deal waits for terminal cooldown');
                assert.ok(room.terminal.store.energy >= 50000 + amount + fee, 'sale leaves 50k terminal energy');
                events.push({ tick: game.time, kind: 'sale', amount, fee });
                intents.push(() => {
                    room.terminal.store.energy -= amount + fee;
                    room.terminal.cooldown = 10;
                    order.remainingAmount -= amount;
                });
                return 0;
            }
        } };
    const room = { name: 'W1N1', my: true, controller: { my: true, level: 8, isPowerEnabled: warehouse },
        memory: { terminalAmount: {}, terminalSendJob: {}, boostNeed: {} }, labs: [],
        storage: { id: 'storage', store: store(storage, storageCapacity) },
        terminal: { id: 'terminal', my: true, cooldown: 0, store: store(terminal, terminalCapacity),
            send(resource, amount, target) {
                const fee = game.market.calcTransactionCost(amount);
                assert.ok(room.terminal.store[resource] >= amount, 'transfer cargo is staged');
                assert.ok(room.terminal.store.energy >= 50000 + fee + (resource === 'energy' ? amount : 0),
                    'transfer leaves 50k terminal energy');
                events.push({ tick: game.time, kind: 'send', resource, amount, target });
                intents.push(() => {
                    room.terminal.store[resource] -= amount;
                    room.terminal.store.energy -= fee;
                    room.terminal.cooldown = 10;
                });
                return 0;
            } } };
    game.rooms[room.name] = room;
    const manager = { name: 'manager', room, memory: { role: 'manager' }, store: store({}, managerCapacity),
        withdraw(source, resource, amount) {
            assert.ok(amount > 0 && amount <= source.store[resource], 'withdraw uses available source stock');
            assert.ok(amount <= manager.store.getFreeCapacity(), 'withdraw fits Manager');
            events.push({ tick: game.time, kind: 'withdraw', source: source.id, resource, amount });
            intents.push(() => { source.store[resource] -= amount; manager.store[resource] = (manager.store[resource] || 0) + amount; });
            return 0;
        },
        transfer(target, resource, amount) {
            assert.ok(amount > 0 && amount <= manager.store[resource], 'delivery uses carried cargo');
            assert.ok(amount <= target.store.getFreeCapacity(), 'delivery fits target');
            events.push({ tick: game.time, kind: 'deliver', target: target.id, resource, amount });
            intents.push(() => { manager.store[resource] -= amount; target.store[resource] = (target.store[resource] || 0) + amount; });
            return 0;
        } };
    game.creeps[manager.name] = manager;
    const globals = { Game: game, Memory: { rooms: { [room.name]: room.memory } },
        ORDER_BUY: 'buy', ORDER_SELL: 'sell', OK: 0, ERR_FULL: -8, ERR_TIRED: -11,
        ERR_NOT_ENOUGH_RESOURCES: -6, ERR_INVALID_ARGS: -10,
        RESOURCE_ENERGY: 'energy', RESOURCE_KEANIUM: 'K', RESOURCE_LEMERGIUM: 'L',
        RESOURCE_OXYGEN: 'O', RESOURCE_HYDROGEN: 'H', RESOURCE_ZYNTHIUM: 'Z',
        RESOURCE_UTRIUM: 'U', RESOURCE_CATALYST: 'X', RESOURCE_OPS: 'ops',
        RESOURCE_ZYNTHIUM_KEANITE: 'ZK', RESOURCE_GHODIUM_OXIDE: 'GO', RESOURCE_KEANIUM_OXIDE: 'KO',
        console: { log() {} } };
    const loader = createSourceLoader({ globals, modules: {
        utils: { getDistance: () => 1 },
        'room/factory': { runFactoryLogistics: () => false },
        'room/evacuation': {
            getEvacuationIncomingCapacity: target => Math.max(0, target.terminal.store.getFreeCapacity() - (incoming.get(target.name) || 0)),
            reserveEvacuationIncoming: (target, amount) => incoming.set(target.name, (incoming.get(target.name) || 0) + amount)
        }
    } });
    const resourcePolicy = loader.load('settings/resourcePolicy').resourcePolicy;
    // These tests isolate competing explicit transfers from unrelated automatic balancing.
    resourcePolicy.distributionInterval = 1000000;
    resourcePolicy.distributionPhase = 0;
    const roomPolicy = loader.load('settings/roomPolicy').roomPolicy;
    roomPolicy.market.scanInterval = scanInterval;
    roomPolicy.market.staggerScans = false;
    loader.load('settings/runtime').runtimePolicy.cpuRecovery.enabled = false;
    const network = loader.load('room/resourceNetwork');
    const terminalApi = loader.load('room/terminal');
    const market = loader.load('room/market');
    const behavior = loader.load('role/adv/RoleAdvManager').default({});
    function step() {
        incoming.clear();
        terminalApi.processTerminalResource(room);
        market.processRoomMarket(room);
        behavior.target(manager);
        while (intents.length) intents.shift()();
        assert.ok(room.storage.store.getUsedCapacity() <= storageCapacity);
        assert.ok(room.terminal.store.getUsedCapacity() <= terminalCapacity);
        assert.ok(room.terminal.store.energy >= 50000, 'native inventory preserves the permanent terminal reserve');
        if (room.terminal.cooldown > 0) room.terminal.cooldown--;
        game.time++;
    }
    function until(predicate, maximum = 200) {
        for (let i = 0; i < maximum && !predicate(); i++) step();
        assert.ok(predicate(), 'the selected operation eventually completes');
    }
    return { room, manager, game, events, step, until, network, market };
}

test('last surplus energy batch survives a Manager withdrawal down to exactly 400k', () => {
    const w = world({ storage: { energy: 401100 } });
    w.step();
    assert.equal(w.room.storage.store.energy, 400000);
    assert.equal(w.manager.store.energy, 1100);
    assert.equal(w.room.terminal.store.energy, 50000);
    w.step();
    assert.equal(w.manager.store.energy, 0, 'carried energy reaches the terminal rather than being returned');
    assert.equal(w.room.terminal.store.energy, 51100);
    w.until(() => w.events.some(event => event.kind === 'sale'));
    const sale = w.events.find(event => event.kind === 'sale');
    assert.equal(sale.amount, 1000);
    assert.equal(sale.fee, 100);
    assert.equal(w.room.storage.store.energy, 400000);
    assert.equal(w.room.terminal.store.energy, 50000);
    assert.equal(w.events.filter(event => event.kind === 'deliver' && event.target === 'storage').length, 0);
});

test('warehouse Manager completes the last surplus batch while retaining 1M plus 50k terminal energy', () => {
    const w = world({ warehouse: true, storage: { energy: 1001100 } });
    w.step();
    assert.equal(w.room.storage.store.energy, 1000000);
    assert.equal(w.manager.store.energy, 1100);
    w.step();
    assert.equal(w.room.terminal.store.energy, 51100);
    w.until(() => w.events.some(event => event.kind === 'sale'));
    const sale = w.events.find(event => event.kind === 'sale');
    assert.equal(sale.amount, 1000);
    assert.equal(sale.fee, 100);
    assert.equal(w.room.storage.store.energy, 1000000);
    assert.equal(w.room.terminal.store.energy, 50000);
    assert.equal(w.events.filter(event => event.kind === 'deliver' && event.target === 'storage').length, 0);
    assert.equal(w.room.memory.terminalAmount.X, 5000, 'central mineral reserves coexist with sale staging');
});

test('full warehouse Storage stages a 100k sale to release capacity without spending the 1M floor', () => {
    const w = world({ warehouse: true, storage: { energy: 1200000, wire: 6800000 } });
    assert.equal(w.room.storage.store.getFreeCapacity(), 0);
    w.until(() => w.events.some(event => event.kind === 'sale'));
    assert.equal(w.events.find(event => event.kind === 'sale').amount, 100000);
    assert.ok(w.room.storage.store.getFreeCapacity() >= 110000);
    assert.ok(w.room.storage.store.energy >= 1000000);
});

test('warehouse explicit mineral transfer completes before surplus energy sale', () => {
    const w = world({ warehouse: true, storage: { energy: 1200000, H: 10000 }, terminal: { energy: 50000, H: 5000 } });
    w.room.memory.terminalSendJob.hydrogen = { targetRoom: 'external', resourceType: 'H', amount: 5000 };
    w.until(() => w.events.some(event => event.kind === 'send'), 10);
    assert.equal(w.events.filter(event => event.kind === 'sale').length, 0);
    w.until(() => w.events.some(event => event.kind === 'sale'));
    assert.equal(w.events.find(event => event.kind === 'sale' || event.kind === 'send').kind, 'send');
    assert.ok(w.room.storage.store.energy >= 1000000);
});

test('full Storage and a 50k terminal stage a large sale and release storage capacity', () => {
    const w = world({ storage: { energy: 900000, wire: 100000 } });
    assert.equal(w.room.storage.store.getFreeCapacity(), 0);
    w.until(() => w.events.some(event => event.kind === 'sale'));
    const sale = w.events.find(event => event.kind === 'sale');
    assert.equal(sale.amount, 100000, 'large batches amortize terminal cooldown');
    assert.ok(w.room.storage.store.getFreeCapacity() >= sale.amount + sale.fee);
    assert.ok(w.room.storage.store.energy >= 400000);
});

test('a prepared mineral transfer first releases space when both Storage and Terminal are full', () => {
    const w = world({ storage: { energy: 600000, wire: 400000 }, terminal: { energy: 60000, wire: 240000 } });
    w.room.memory.terminalSendJob.wire = { targetRoom: 'external', resourceType: 'wire', amount: 100000 };
    w.step();
    assert.equal(w.events.filter(event => event.kind === 'send').length, 1);
    assert.equal(w.events.filter(event => event.kind === 'sale').length, 0, 'sending and selling cannot use the same terminal tick');
    assert.ok(w.room.terminal.store.getFreeCapacity() >= 100000);
    w.until(() => w.events.some(event => event.kind === 'sale'));
    assert.equal(w.events.find(event => event.kind === 'sale' || event.kind === 'send').kind, 'send');
    assert.ok(w.room.storage.store.energy >= 400000);
});

test('already stocked terminal energy can sell to unblock a full terminal without a send job', () => {
    const w = world({ storage: { energy: 900000, wire: 100000 }, terminal: { energy: 60000, wire: 240000 } });
    assert.equal(w.room.storage.store.getFreeCapacity(), 0);
    assert.equal(w.room.terminal.store.getFreeCapacity(), 0);
    w.until(() => w.events.some(event => event.kind === 'sale'), 30);
    assert.ok(w.room.terminal.store.getFreeCapacity() > 0, 'sale releases terminal capacity without clearing minerals to full Storage');
    w.until(() => w.events.filter(event => event.kind === 'sale').length >= 2, 120);
    assert.ok(w.room.storage.store.getFreeCapacity() > 0, 'the next sale consumes newly staged Storage energy');
    assert.ok(w.room.storage.store.energy >= 400000);
});

test('existing send fee preparation finishes before an energy market batch', () => {
    const w = world({ storage: { energy: 600000, H: 10000 }, terminal: { energy: 50000, H: 5000 } });
    w.room.memory.terminalSendJob.hydrogen = { targetRoom: 'external', resourceType: 'H', amount: 5000 };
    w.until(() => w.events.some(event => event.kind === 'send'), 10);
    assert.equal(w.events.filter(event => event.kind === 'sale').length, 0);
    assert.equal(w.room.memory.terminalSendJob.hydrogen, undefined);
    w.until(() => w.events.some(event => event.kind === 'sale'));
    assert.equal(w.events.find(event => event.kind === 'sale' || event.kind === 'send').kind, 'send');
});

test('cancelled send preparation releases its goal without shuttling market energy back to Storage', () => {
    const w = world({ storage: { energy: 600000, H: 110000 }, scanInterval: 1 });
    w.room.memory.terminalSendJob.hydrogen = { targetRoom: 'external', resourceType: 'H', amount: 100000 };
    w.step();
    assert.ok(w.manager.store.energy > 0, 'Manager is carrying the cancelled shipment fee');
    w.network.updateResourceJob(w.room, 'hydrogen');
    w.step();
    assert.equal(w.room.memory.terminalAmount.H, undefined);
    w.until(() => w.events.some(event => event.kind === 'sale'));
    assert.equal(w.events.filter(event => event.kind === 'send').length, 0);
    assert.equal(w.events.filter(event => event.kind === 'deliver' && event.target === 'storage').length, 0);
});

test('a reduced send batch completes then yields to the market instead of keeping an obsolete staging goal', () => {
    const w = world({ storage: { energy: 600000, H: 110000 } });
    w.room.memory.terminalSendJob.hydrogen = { targetRoom: 'external', resourceType: 'H', amount: 100000 };
    w.step();
    w.network.updateResourceJob(w.room, 'hydrogen', { targetRoom: 'external', resourceType: 'H', amount: 1000 });
    w.until(() => w.events.some(event => event.kind === 'send'), 15);
    assert.equal(w.events.find(event => event.kind === 'send').amount, 1000);
    w.until(() => w.events.some(event => event.kind === 'sale'));
    assert.equal(w.room.memory.terminalAmount.H, undefined);
    assert.ok(w.room.storage.store.energy >= 400000);
});
