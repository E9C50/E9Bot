const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world({ orders = [] } = {}) {
    const game = { time: 1, shard: { name: 'shard3' }, market: {
        getAllOrders() { queries++; return orders; },
        calcTransactionCost(amount) { return Math.ceil(amount / 10); },
        deal() { assert.fail('these terminal reserves have no staged energy to sell'); },
    } };
    let queries = 0;
    const policy = { market: { scanInterval: 25, staggerScans: true, ordinaryEnergyStorageReserve: 400000,
        warehouseEnergyStorageReserve: 1000000, energyMaximumSaleAmount: 100000,
        maximumDealsPerTick: 10 }, terminal: { centerResourceReserve: 5000 } };
    const loader = createSourceLoader({ globals: { Game: game, Memory: { centerStorage: 'E31N2' }, ORDER_BUY: 'buy', RESOURCE_ENERGY: 'energy' },
        modules: { 'settings/roomPolicy': { roomPolicy: policy,
            roomResourceSales: [],
            centerResourceSales: [], centerTerminalResources: ['X'] },
            './resourceNetwork': { isWarehouseRoom: room => room.name === 'E31N2', terminalUsed: () => false,
                getResourceKeep: () => 50000, getOutgoingResourceAmount: () => 0,
                getRoomResourceAmount: room => room.storage.store.energy + room.terminal.store.energy,
                getRoomMovableResourceAmount: room => room.storage.store.energy + room.terminal.store.energy,
                getAvailableResource: room => room.storage.store.energy + room.terminal.store.energy - 50000,
                getTerminalResourceAmount: room => room.terminal.store.energy } } });
    const rooms = ['E31N2', 'E34N3', 'E35N1', 'E35N3', 'E36N2', 'E37N7', 'E38N5', 'E38N6', 'E41N7', 'E41N8', 'E37N5']
        .map(name => ({ name, storage: { store: { energy: name === 'E31N2' ? 1700000 : 700000 } },
            terminal: { cooldown: 0, store: { energy: 50000, getFreeCapacity: () => 250000 } },
            memory: { terminalAmount: {} } }));
    return { game, policy, rooms, ...loader.load('room/market'), queries: () => queries,
        recovery: loader.load('settings/runtime').runtimePolicy.cpuRecovery };
}

test('warehouse and ordinary energy-selling rooms share one scan in 25 ticks and refresh central reserves every tick', () => {
    const w = world(), ticks = [];
    for (let tick = 1; tick <= 25; tick++) {
        w.game.time = tick; const before = w.queries();
        w.rooms[0].memory.terminalAmount.X = 0;
        for (const room of w.rooms) w.processRoomMarket(room);
        assert.equal(w.rooms[0].memory.terminalAmount.X, 5000);
        ticks.push(w.queries() - before);
    }
    assert.equal(w.queries(), 1, 'energy orders are shared across all rooms instead of eleven repeated native scans');
    assert.ok(Math.max(...ticks) <= 1);
    for (let tick = 26; tick <= 50; tick++) { w.game.time = tick; for (const room of w.rooms) w.processRoomMarket(room); }
    assert.equal(w.queries(), 2, 'cached empty orders are refreshed after the next interval');
});

test('direct selling remains immediate while automatic scans respect fresh storage and continue during cooldown', () => {
    const w = world(), room = w.rooms[0];
    w.sellResource(room, 'energy', 600000); assert.equal(w.queries(), 1);
    room.storage.store.energy = 0;
    for (let tick = 1; tick <= 25; tick++) {
        w.game.time = tick; room.memory.terminalAmount = { energy: 50000 }; w.processRoomMarket(room);
    }
    assert.equal(w.queries(), 1);
    room.storage.store.energy = 1700000; room.terminal.cooldown = 1;
    for (let tick = 26; tick <= 50; tick++) {
        w.game.time = tick; room.memory.terminalAmount = { energy: 50000 }; w.processRoomMarket(room);
    }
    assert.equal(w.queries(), 2, 'cooldown can prepare the next batch using the periodic shared scan');
    room.terminal.cooldown = 0;
    for (let tick = 51; tick <= 75; tick++) {
        w.game.time = tick; room.memory.terminalAmount = { energy: 50000 }; w.processRoomMarket(room);
    }
    assert.equal(w.queries(), 3);
});

test('warehouse cooldown stages a full sale and fee between scans without repeating native order queries', () => {
    const w = world({ orders: [{ id: 'energy-buy', amount: 2000000, remainingAmount: 2000000,
        price: 10, roomName: 'W5N1' }] }), room = w.rooms[0];
    room.terminal.cooldown = 10;
    let staged = false;
    for (let tick = 1; tick <= 25; tick++) {
        w.game.time = tick;
        // Terminal demand is refreshed before the room market runs each tick.
        room.memory.terminalAmount = { energy: 50000 };
        w.processRoomMarket(room);
        if (room.memory.terminalAmount.energy > 50000) staged = true;
        if (staged) assert.equal(room.memory.terminalAmount.energy, 160000, '100k cargo and 10k fee above the terminal reserve');
        assert.equal(room.memory.terminalAmount.X, 5000);
    }
    assert.ok(staged, 'the scheduled warehouse scan starts preparation even while its terminal is cooling down');
    assert.equal(w.queries(), 1);
});

test('empty-bucket market scans remain periodic and keep central resource reserves fresh', () => {
    const w = world();
    w.recovery.enabled = true;
    w.game.cpu = { bucket: 0 };
    for (let tick = 1; tick <= 250; tick++) {
        w.game.time = tick;
        w.rooms[0].memory.terminalAmount.X = 0;
        for (const room of w.rooms) w.processRoomMarket(room);
        assert.equal(w.rooms[0].memory.terminalAmount.X, 5000);
    }
    assert.equal(w.queries(), 1);
    w.recovery.enabled = false;
    for (let tick = 251; tick <= 275; tick++) { w.game.time = tick; for (const room of w.rooms) w.processRoomMarket(room); }
    assert.equal(w.queries(), 2, 'disabling recovery immediately restores the normal scan interval');
});
