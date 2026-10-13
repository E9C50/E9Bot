const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function store(resources, capacity) {
    const result = { ...resources };
    Object.defineProperties(result, {
        getUsedCapacity: { value: () => Object.values(result).reduce((sum, value) => sum + value, 0) },
        getFreeCapacity: { value: () => capacity - result.getUsedCapacity() },
        getCapacity: { value: () => capacity }
    });
    return result;
}
function world({ orders = [{ id: 'buy', amount: 2000000, remainingAmount: 2000000, price: 10, roomName: 'W5N1' }],
    scanInterval = 25, feeRatio = 0.1,
    roomSales = [{ resourceType: 'energy', threshold: 600000, minPrice: 20, sellAmount: 10000 }],
    centerSales = [{ resourceType: 'energy', threshold: 300000, minPrice: 0.001, sellAmount: 10000 }] } = {}) {
    let queries = 0, costs = 0, due = true, dealResult = 0;
    const deals = [];
    const game = { time: 1, shard: { name: 'test' }, rooms: {}, creeps: {}, market: {
        orders: {},
        getAllOrders: () => { queries++; return orders; },
        calcTransactionCost(amount, from, to) { costs++; return Math.ceil(amount * (typeof feeRatio === 'function' ? feeRatio(to) : feeRatio)); },
        deal(id, amount, room) { deals.push({ id, amount, room }); return typeof dealResult === 'function' ? dealResult(id) : dealResult; }
    } };
    const roomPolicy = { market: { scanInterval, staggerScans: true, ordinaryEnergyStorageReserve: 400000,
        warehouseEnergyStorageReserve: 1000000, energyMaximumSaleAmount: 100000, maximumDealsPerTick: 10,
        defaultMinimumPrice: 20, defaultSaleAmount: 10000, energyValue: 20, minimumOrderAmount: 100 },
        terminal: { centerResourceReserve: 5000 } };
    const loader = createSourceLoader({ globals: { Game: game, Memory: {}, RESOURCE_ENERGY: 'energy', ORDER_BUY: 'buy',
        OK: 0, ERR_FULL: -8, ERR_NOT_FOUND: -5, ERR_INVALID_ARGS: -10, ERR_NOT_ENOUGH_RESOURCES: -6,
        PWR_OPERATE_TERMINAL: 17, POWER_INFO: { 17: { effect: [0.5] } }, console: { log() {} } },
        modules: {
            'settings/roomPolicy': { roomPolicy,
                roomResourceSales: roomSales,
                centerResourceSales: centerSales,
                centerTerminalResources: [] },
            'runtime/roomSchedule': { roomWorkDue: () => due },
            'runtime/cpuRecovery': { cpuRecoveryInterval: () => roomPolicy.market.scanInterval },
            './evacuation': { getEvacuationIncomingCapacity: room => room.terminal.store.getFreeCapacity(), reserveEvacuationIncoming() {} }
        } });
    function add(name = 'W1N1', { warehouse = false, storage = { energy: 500000 }, terminal = { energy: 50000 },
        terminalCapacity = 300000 } = {}) {
        const room = { name, my: true, controller: { my: true, level: 8, isPowerEnabled: warehouse },
            memory: { terminalSendJob: {}, terminalAmount: { energy: 50000 } }, labs: [],
            storage: { store: store(storage, warehouse ? 8000000 : 1000000) },
            terminal: { my: true, cooldown: 0, store: store(terminal, terminalCapacity) } };
        game.rooms[name] = room;
        return room;
    }
    function tick(count = 1) {
        game.time += count;
        for (const room of Object.values(game.rooms)) room.memory.terminalAmount = { energy: 50000 };
    }
    return { game, roomPolicy, add, tick, orders, deals, network: loader.load('room/resourceNetwork'),
        ...loader.load('room/market'), queries: () => queries, costs: () => costs,
        setDue: value => { due = value; }, setDealResult: value => { dealResult = value; } };
}

test('eleven ordinary rooms share one mineral order query and never sell beyond its executable stock', () => {
    const w = world({ orders: [{ id: 'ops-buy', amount: 3000, remainingAmount: 10000, price: 10, roomName: 'W5N1' }], feeRatio: 0.1 });
    const rooms = Array.from({ length: 11 }, (_, index) => w.add(`W${index + 1}N1`, {
        storage: { energy: 100000, ops: 100000 }, terminal: { energy: 60000, ops: 1000 },
    }));
    for (const room of rooms) w.sellResource(room, 'ops', 5000, 0.001, 1000);
    assert.equal(w.queries(), 1);
    assert.equal(w.deals.length, 3);
    assert.equal(w.deals.reduce((sum, deal) => sum + deal.amount, 0), 3000);
    assert.equal(w.orders[0].amount, 3000, 'debits stay in the shared intent ledger');
    w.tick(); w.orders[0].amount = 2000;
    w.sellResource(rooms[3], 'ops', 5000, 0.001, 1000);
    assert.equal(w.queries(), 2, 'next tick observes a fresh native order snapshot immediately');
    assert.equal(w.deals.length, 4);
});

test('unstaged, reserved and already withdrawn mineral stock does not query or rank native market orders', () => {
    const w = world({ orders: [{ id: 'ops-buy', amount: 3000, remainingAmount: 10000, price: 10, roomName: 'W5N1' }] });
    const unstaged = w.add('W1N1', { storage: { energy: 100000, ops: 100000 }, terminal: { energy: 60000 } });
    const reserved = w.add('W2N1', { storage: { energy: 100000, ops: 100000 }, terminal: { energy: 60000, ops: 1000 } });
    const withdrawn = w.add('W3N1', { storage: { energy: 100000, ops: 100000 }, terminal: { energy: 60000, ops: 1000 } });
    reserved.memory.boostNeed = { ops: 101000 };
    Object.defineProperty(unstaged, 'labs', { get() { assert.fail('an empty staged mineral does not need whole-room availability'); } });
    w.network.recordTerminalWithdrawal(withdrawn, 'ops', 1000);
    for (const room of [unstaged, reserved, withdrawn]) w.sellResource(room, 'ops', 5000, 0.001, 1000);
    assert.equal(w.queries(), 0);
    assert.equal(w.costs(), 0);
    assert.equal(w.deals.length, 0);
    delete reserved.memory.boostNeed;
    w.sellResource(reserved, 'ops', 5000, 0.001, 1000);
    assert.equal(w.queries(), 1, 'releasing a reservation makes the same-tick sale immediate');
    assert.equal(w.deals[0].amount, 1000);
});

test('a rejected mineral order invalidates the shared snapshot so other rooms avoid duplicate deal attempts', () => {
    const w = world(); w.setDealResult(-6);
    for (let index = 0; index < 5; index++) w.sellResource(w.add(`W${index + 1}N1`, {
        storage: { energy: 100000, ops: 100000 }, terminal: { energy: 60000, ops: 1000 },
    }), 'ops', 5000, 0.001, 1000);
    assert.equal(w.queries(), 1);
    assert.equal(w.deals.length, 1);
});

test('400k storage plus 50k terminal is the ordinary-room floor and does not scan orders', () => {
    const w = world(), room = w.add('W1N1', { storage: { energy: 400000 } });
    w.processRoomMarket(room);
    assert.equal(w.queries(), 0);
    assert.equal(room.memory.terminalAmount.energy, 50000);
    assert.equal(w.deals.length, 0);
});

test('ordinary energy-sale planning reads zero Lab or Factory energy while preserving the same daily staging budget', () => {
    const w = world(), room = w.add('W1N1', { storage: { energy: 401100 } });
    let labReads = 0, factoryReads = 0;
    room.labs = Array.from({ length: 10 }, () => ({ store: { get energy() { labReads++; return 2000; } } }));
    room.factory = { store: { get energy() { factoryReads++; return 20000; } } };
    room.terminal.cooldown = 0;
    for (let tick = 0; tick < 25; tick++) {
        w.processEnergySale(room);
        assert.equal(room.memory.terminalAmount.energy, 51100, 'only the same 1100 movable surplus can be staged');
        w.tick();
    }
    assert.equal(labReads, 0, 'previous whole-room-minus-fixed algebra read 500 Lab energy entries');
    assert.equal(factoryReads, 0, 'previous whole-room-minus-fixed algebra read Factory twice per planning pass');
    assert.equal(w.queries(), 1, 'market scan cadence and shared order cache remain unchanged');
    room.storage.store.energy = 400000;
    w.processEnergySale(room);
    assert.equal(room.memory.terminalAmount.energy, 50000, 'fresh native storage changes still cancel a no-longer-funded sale');
    assert.equal(w.deals.length, 0);
});

test('a room without a movable energy surplus avoids native terminal capacity and fixed-stock queries', () => {
    const w = world(), room = w.add('W1N1', { storage: { energy: 400000 } });
    room.terminal.store = new Proxy(room.terminal.store, { get(target, key) {
        if (key === 'getFreeCapacity') assert.fail('no staging space is needed without a surplus');
        return target[key];
    } });
    Object.defineProperties(room, {
        labs: { get() { assert.fail('no sale budget uses fixed Lab stock'); } },
        factory: { get() { assert.fail('no sale budget uses fixed Factory stock'); } },
    });
    w.processEnergySale(room);
    assert.equal(room.memory.terminalAmount.energy, 50000);
    assert.equal(w.queries(), 0);
    assert.equal(w.deals.length, 0);
});

test('the surplus budget pays both cargo and the transaction fee', () => {
    const w = world(), room = w.add('W1N1', { storage: { energy: 401100 } });
    w.processRoomMarket(room);
    assert.equal(room.memory.terminalAmount.energy, 51100, '1000 cargo + 100 fee + 50k reserve');
    room.storage.store.energy -= 1100;
    room.terminal.store.energy += 1100;
    w.tick(); w.setDue(false); w.processRoomMarket(room);
    assert.equal(w.deals[0].amount, 1000);
    assert.equal(w.network.getRoomResourceAmount(room, 'energy'), 450000);
    assert.equal(w.network.getTerminalResourceAmount(room, 'energy'), 50000);
});

test('a positive ordinary-room buy price does not inherit the legacy 20-credit floor', () => {
    const w = world({ orders: [{ id: 'cheap', amount: 100000, remainingAmount: 100000, price: 0.001, roomName: 'W5N1' }] });
    const room = w.add('W1N1', { storage: { energy: 400000 }, terminal: { energy: 160000 } });
    w.processRoomMarket(room);
    assert.equal(w.deals[0].amount, 100000);
});

test('warehouse energy below or at 1M plus the 50k terminal reserve cannot use either legacy sale list', () => {
    for (const energy of [350000, 600001, 1000000]) {
        const w = world(), room = w.add('W1N1', { warehouse: true, storage: { energy } });
        w.processRoomMarket(room);
        assert.equal(w.queries(), 0);
        assert.equal(room.memory.terminalAmount.energy, 50000);
        assert.deepEqual(w.deals, []);
    }
});

test('warehouse last surplus batch includes its fee and survives movement out of Storage', () => {
    const w = world(), room = w.add('W1N1', { warehouse: true, storage: { energy: 1001100 } });
    w.processRoomMarket(room);
    assert.equal(room.memory.terminalAmount.energy, 51100);
    assert.equal(w.deals.length, 0);
    room.storage.store.energy -= 1100;
    room.terminal.store.energy += 1100;
    w.tick(); w.setDue(false); w.processRoomMarket(room);
    assert.equal(w.deals[0].amount, 1000);
    assert.equal(w.network.getRoomResourceAmount(room, 'energy'), 1050000);
    assert.equal(w.network.getTerminalResourceAmount(room, 'energy'), 50000);
});

test('warehouses sell large batches at a positive price and share executable stock with ordinary rooms', () => {
    const w = world({ orders: [{ id: 'cheap', amount: 150000, remainingAmount: 1000000, price: 0.001, roomName: 'W5N1' }] });
    const warehouse = w.add('W1N1', { warehouse: true, storage: { energy: 1000000 }, terminal: { energy: 160000 } });
    const ordinary = w.add('W2N1', { storage: { energy: 400000 }, terminal: { energy: 160000 } });
    w.processRoomMarket(warehouse); w.processRoomMarket(ordinary);
    assert.deepEqual(w.deals.map(deal => deal.amount), [100000, 50000]);
    assert.equal(w.queries(), 1);
    assert.equal(w.network.getRoomResourceAmount(warehouse, 'energy'), 1050000);
});

test('warehouse staging respects cooldown, terminal space, outgoing cargo and production commitments', () => {
    const w = world(), room = w.add('W1N1', { warehouse: true, storage: { energy: 1100000 },
        terminal: { energy: 50000, H: 200000 } });
    room.memory.terminalSendJob.promised = { resourceType: 'energy', amount: 60000, targetRoom: 'W9N9' };
    room.memory.productionReserve = { factory: { energy: 10000 } };
    room.terminal.cooldown = 10;
    w.processRoomMarket(room);
    assert.equal(room.memory.terminalAmount.energy, 80000, 'only 30k including fee is uncommitted');
    assert.equal(w.deals.length, 0);
    w.tick(); w.setDue(false); w.processRoomMarket(room);
    assert.equal(room.memory.terminalAmount.energy, 80000);
    assert.equal(w.queries(), 1);
    delete room.memory.terminalSendJob.promised;
    w.tick(); w.setDue(true); w.processRoomMarket(room);
    assert.equal(room.memory.terminalAmount.energy, 100000, 'available terminal space caps staged energy');
});

test('warehouse fixed energy and a loss of sale surplus never consume the 1M floor', () => {
    const w = world(), room = w.add('W1N1', { warehouse: true, storage: { energy: 1001100 } });
    w.processRoomMarket(room);
    assert.equal(w.queries(), 1);
    room.storage.store.energy = 1000000;
    Object.defineProperties(room, {
        labs: { get() { assert.fail('fixed Lab energy is not movable surplus'); } },
        factory: { get() { assert.fail('fixed Factory energy is not movable surplus'); } }
    });
    w.tick(); w.setDue(false); w.processRoomMarket(room);
    assert.equal(room.memory.terminalAmount.energy, 50000);
    assert.equal(w.deals.length, 0);
    assert.equal(w.queries(), 1);
});

test('power-enabled rooms whose Storage capacity is only 1M retain the ordinary 400k floor', () => {
    const w = world(), room = w.add('W1N1', { storage: { energy: 400000 }, terminal: { energy: 160000 } });
    room.controller.isPowerEnabled = true;
    w.processRoomMarket(room);
    assert.equal(w.deals[0].amount, 100000);
    assert.equal(w.network.getRoomResourceAmount(room, 'energy'), 450000);
});

test('warehouse automatic sales leave all raw mineral surplus for compression in either sale list', () => {
    const sales = ['H', 'O', 'U', 'L', 'K', 'Z', 'X', 'G'].map(resourceType =>
        ({ resourceType, threshold: 300000, minPrice: 0.001, sellAmount: 5000 }));
    for (const field of ['centerSales', 'roomSales']) {
        const w = world({ centerSales: [], roomSales: [], [field]: sales });
        const raw = Object.fromEntries(sales.map(sale => [sale.resourceType, 400000]));
        const staged = Object.fromEntries(sales.map(sale => [sale.resourceType, 5000]));
        const room = w.add('W1N1', { warehouse: true, storage: { energy: 100000, ...raw },
            terminal: { energy: 60000, ...staged } });
        w.processRoomMarket(room);
        assert.equal(w.queries(), 0, 'raw surplus must not trigger native market order scans');
        assert.deepEqual(w.deals, []);
        assert.equal(w.network.getRoomResourceAmount(room, 'O'), 405000);
    }
});

test('warehouse compression policy retains direct manual selling and other automatic sale categories', () => {
    const sale = { resourceType: 'O', threshold: 300000, minPrice: 0.001, sellAmount: 5000 };
    const w = world({ centerSales: [sale] });
    const room = w.add('W1N1', { warehouse: true, storage: { energy: 100000, O: 400000 }, terminal: { energy: 60000, O: 5000 } });
    w.processRoomMarket(room); assert.deepEqual(w.deals, []);
    w.sellResource(room, 'O', 300000, 0.001, 5000);
    assert.equal(w.deals[0].amount, 5000, 'an explicit sale remains available');
    const other = world({ centerSales: [{ ...sale, resourceType: 'ops' }] });
    other.processRoomMarket(other.add('W2N1', { warehouse: true, storage: { energy: 100000, ops: 400000 }, terminal: { energy: 60000, ops: 5000 } }));
    assert.equal(other.deals[0].amount, 5000, 'unrelated automatic categories retain their behavior');
    const ordinary = world({ roomSales: [sale] });
    ordinary.processRoomMarket(ordinary.add('W3N1', { storage: { energy: 100000, O: 400000 }, terminal: { energy: 60000, O: 5000 } }));
    assert.equal(ordinary.deals[0].amount, 5000, 'the raw sale restriction applies only to warehouses');
});

test('ordinary sale staging stays active during terminal cooldown and between scans', () => {
    const w = world(), room = w.add();
    room.terminal.cooldown = 10;
    w.processRoomMarket(room);
    const target = room.memory.terminalAmount.energy;
    assert.equal(target, 150000);
    assert.equal(w.deals.length, 0);
    w.tick(); w.setDue(false); w.processRoomMarket(room);
    assert.equal(room.memory.terminalAmount.energy, target);
    assert.equal(w.queries(), 1);
});

test('partly staged cargo waits for the entire planned batch instead of small Manager-sized sales', () => {
    const w = world(), room = w.add('W1N1', { storage: { energy: 450000 }, terminal: { energy: 100000 } });
    w.processRoomMarket(room);
    assert.equal(room.memory.terminalAmount.energy, 150000);
    assert.equal(w.deals.length, 0);
    room.storage.store.energy -= 50000;
    room.terminal.store.energy += 50000;
    w.tick(); w.setDue(false); w.processRoomMarket(room);
    assert.equal(w.deals.length, 1);
    assert.equal(w.deals[0].amount, 90909);
    assert.equal(w.network.getRoomResourceAmount(room, 'energy'), 450000);
});

test('Lab and Factory energy contents never create a false sellable surplus', () => {
    const w = world(), room = w.add('W1N1', { storage: { energy: 400000 } });
    room.labs.push({ store: store({ energy: 2000 }, 5000) });
    room.factory = { store: store({ energy: 30000 }, 50000) };
    w.processRoomMarket(room);
    assert.equal(w.queries(), 0);
    assert.equal(room.memory.terminalAmount.energy, 50000);
});

test('energy promised to outgoing jobs and production is retained above both ordinary floors', () => {
    const w = world(), room = w.add();
    room.memory.terminalSendJob.promised = { resourceType: 'energy', amount: 15000, targetRoom: 'W9N9' };
    room.memory.productionReserve = { lab: { energy: 10000 } };
    w.processRoomMarket(room);
    assert.equal(room.memory.terminalAmount.energy, 125000, '75k surplus after 15k outgoing and 10k production');
});

test('boost energy above 50k extends the protected ordinary-room reserve', () => {
    const w = world(), room = w.add();
    room.memory.boostNeed = { energy: 70000 };
    w.processRoomMarket(room);
    assert.equal(room.memory.terminalAmount.energy, 130000);
});

test('already stocked terminal energy can be sold while Storage is below its nominal floor', () => {
    const w = world(), room = w.add('W1N1', { storage: { energy: 350000 }, terminal: { energy: 200000 } });
    w.processRoomMarket(room);
    assert.equal(w.deals[0].amount, 90909);
    assert.equal(w.network.getRoomResourceAmount(room, 'energy'), 450000);
});

test('an executable amount cap overrides a much larger unfunded remainingAmount', () => {
    const w = world({ orders: [{ id: 'funded', amount: 10000, remainingAmount: 1000000, price: 10, roomName: 'W5N1' }] });
    const first = w.add('W1N1', { storage: { energy: 400000 }, terminal: { energy: 100000 } });
    const second = w.add('W2N1', { storage: { energy: 400000 }, terminal: { energy: 100000 } });
    w.processRoomMarket(first); w.processRoomMarket(second);
    assert.equal(w.deals.length, 1);
    assert.equal(w.deals[0].amount, 10000);
    assert.equal(second.memory.terminalAmount.energy, 50000);
    assert.equal(w.orders[0].amount, 10000, 'the native order object is not mutated');
});

test('the smaller remainingAmount still caps executable stock', () => {
    const w = world({ orders: [{ id: 'almost-complete', amount: 10000, remainingAmount: 2000, price: 10, roomName: 'W5N1' }] });
    w.processRoomMarket(w.add('W1N1', { storage: { energy: 400000 }, terminal: { energy: 100000 } }));
    assert.equal(w.deals[0].amount, 2000);
});

test('an unfunded buy order with zero amount is neither selected nor staged', () => {
    const w = world({ orders: [{ id: 'unfunded', amount: 0, remainingAmount: 1000000, price: 1000, roomName: 'W5N1' }] });
    const room = w.add(); w.processRoomMarket(room);
    assert.equal(room.memory.terminalAmount.energy, 50000);
    assert.equal(w.deals.length, 0);
});

test('cached executable stock remains depleted on later ticks before the next native scan', () => {
    const w = world({ orders: [{ id: 'funded', amount: 10000, remainingAmount: 1000000, price: 10, roomName: 'W5N1' }] });
    w.processRoomMarket(w.add('W1N1', { storage: { energy: 400000 }, terminal: { energy: 100000 } }));
    w.tick(); const room = w.add('W2N1', { storage: { energy: 400000 }, terminal: { energy: 100000 } });
    w.processRoomMarket(room);
    assert.equal(w.queries(), 1);
    assert.equal(w.deals.length, 1);
});

test('all ordinary rooms share the native ten-deal limit and resume pending batches next tick', () => {
    const w = world();
    const rooms = Array.from({ length: 11 }, (_, index) => w.add(`W${index}N1`, {
        storage: { energy: 400000 }, terminal: { energy: 160000 } }));
    rooms.forEach(w.processRoomMarket);
    assert.equal(w.deals.length, 10);
    assert.ok(w.deals.every(deal => deal.amount === 100000));
    assert.equal(w.queries(), 1);
    w.tick(); w.setDue(false); w.processRoomMarket(rooms[10]);
    assert.equal(w.deals.length, 11);
});

test('manual legacy sales and ordinary automatic sales share same-tick order stock', () => {
    const w = world({ orders: [{ id: 'limited', amount: 15000, remainingAmount: 1000000, price: 100, roomName: 'W5N1' }] });
    const warehouse = w.add('W1N1', { warehouse: true, storage: { energy: 700000 }, terminal: { energy: 100000 } });
    const ordinary = w.add('W2N1', { storage: { energy: 400000 }, terminal: { energy: 100000 } });
    w.sellResource(warehouse, 'energy', 600000);
    w.processRoomMarket(ordinary);
    assert.deepEqual(w.deals.map(deal => deal.amount), [10000, 5000]);
    assert.equal(w.queries(), 1);
});

test('an operate-terminal effect is used for sizing, staging, and the successful debit', () => {
    const w = world(), room = w.add('W1N1', { storage: { energy: 400000 }, terminal: { energy: 150000 } });
    room.terminal.effects = [{ effect: 17, level: 1, ticksRemaining: 100 }];
    w.processRoomMarket(room);
    assert.equal(w.deals[0].amount, 95238);
    assert.equal(w.network.getTerminalResourceAmount(room, 'energy'), 50000);
    assert.equal(w.network.getRoomResourceAmount(room, 'energy'), 450000);
});

test('order choice compares revenue after energy cost rather than raw quoted price', () => {
    const w = world({ feeRatio: target => target === 'W5N1' ? 1 : 0, orders: [
        { id: 'expensive', amount: 1000000, remainingAmount: 1000000, price: 10, roomName: 'W5N1' },
        { id: 'nearby', amount: 1000000, remainingAmount: 1000000, price: 9, roomName: 'W2N1' }
    ] });
    w.processRoomMarket(w.add('W1N1', { storage: { energy: 400000 }, terminal: { energy: 150000 } }));
    assert.equal(w.deals[0].id, 'nearby');
    assert.equal(w.deals[0].amount, 100000);
});

test('selection costs one fee call per candidate and only the winner gets a binary search', () => {
    const orders = Array.from({ length: 433 }, (_, index) => ({ id: `order${index}`, amount: 1000000,
        remainingAmount: 1000000, price: index + 1, roomName: 'W5N1' }));
    const w = world({ orders }), room = w.add();
    room.terminal.cooldown = 100;
    w.processRoomMarket(room);
    assert.ok(w.costs() < 460, `candidate selection performed ${w.costs()} fee calculations`);
    const before = w.costs();
    w.tick(); w.setDue(false); w.processRoomMarket(room);
    assert.equal(w.costs() - before, 1, 'a pending batch checks only its cached selected order');
});

test('existing terminal minerals limit the batch to actual remaining capacity', () => {
    const w = world(), room = w.add('W1N1', { terminal: { energy: 50000, H: 200000 } });
    w.processRoomMarket(room);
    assert.equal(room.memory.terminalAmount.energy, 100000);
    assert.equal(room.memory.terminalAmount.energy + room.terminal.store.H, 300000);
});

test('a completely full terminal can sell its stocked energy surplus to make initial space', () => {
    const w = world(), room = w.add('W1N1', { storage: { energy: 900000, wire: 100000 },
        terminal: { energy: 60000, wire: 240000 } });
    w.processRoomMarket(room);
    assert.equal(w.deals[0].amount, 9090);
    assert.equal(w.network.getTerminalResourceAmount(room, 'energy'), 50001);
});

test('both stores full with only the 50k terminal reserve cannot invent staging space', () => {
    const w = world(), room = w.add('W1N1', { storage: { energy: 900000, wire: 100000 },
        terminal: { energy: 50000, wire: 250000 } });
    w.processRoomMarket(room);
    assert.equal(w.queries(), 0);
    assert.equal(w.deals.length, 0);
    assert.equal(room.memory.terminalAmount.energy, 50000);
});

test('mineral and energy send staging takes priority over market staging', () => {
    const w = world(), mineral = w.add(), energy = w.add('W2N1');
    mineral.memory.terminalAmount.H = 10000;
    energy.memory.terminalAmount.energy = 110000;
    w.processRoomMarket(mineral); w.processRoomMarket(energy);
    assert.equal(w.queries(), 0);
    assert.equal(mineral.memory.terminalAmount.energy, 50000);
    assert.equal(mineral.memory.terminalAmount.H, 10000);
    assert.equal(energy.memory.terminalAmount.energy, 110000);
});

test('cancelled orders clear obsolete market staging when the shared cache refreshes', () => {
    const w = world(), room = w.add();
    w.processRoomMarket(room);
    assert.equal(room.memory.terminalAmount.energy, 150000);
    w.orders[0].amount = 0;
    w.tick(25); w.processRoomMarket(room);
    assert.equal(room.memory.terminalAmount.energy, 50000);
    assert.equal(w.queries(), 2);
});

test('losing a true surplus cancels the staging target without another native order scan', () => {
    const w = world(), room = w.add(); w.processRoomMarket(room);
    room.storage.store.energy = 400000;
    w.tick(); w.setDue(false); w.processRoomMarket(room);
    assert.equal(room.memory.terminalAmount.energy, 50000);
    assert.equal(w.queries(), 1);
});

test('own buy orders and nonpositive prices are never selected for ordinary sales', () => {
    const w = world({ orders: [
        { id: 'mine', amount: 1000000, remainingAmount: 1000000, price: 100, roomName: 'W1N1' },
        { id: 'zero', amount: 1000000, remainingAmount: 1000000, price: 0, roomName: 'W5N1' },
        { id: 'valid', amount: 1000000, remainingAmount: 1000000, price: 1, roomName: 'W5N1' }
    ] });
    w.game.market.orders.mine = w.orders[0];
    w.processRoomMarket(w.add('W1N1', { storage: { energy: 400000 }, terminal: { energy: 160000 } }));
    assert.equal(w.deals[0].id, 'valid');
});

for (const error of [-10, -6, -5]) test(`stale order error ${error} immediately switches to another cached order next tick`, () => {
    const w = world({ scanInterval: 250, orders: [
        { id: 'stale', amount: 1000000, remainingAmount: 1000000, price: 100, roomName: 'W5N1' },
        { id: 'valid', amount: 1000000, remainingAmount: 1000000, price: 10, roomName: 'W5N1' }
    ] });
    const room = w.add('W1N1', { storage: { energy: 400000 }, terminal: { energy: 160000 } });
    w.setDealResult(id => id === 'stale' ? error : 0);
    w.processRoomMarket(room);
    assert.equal(room.memory.terminalAmount.energy, 50000);
    assert.equal(w.network.getRoomResourceAmount(room, 'energy'), 560000, 'failed deals never debit stock');
    w.tick(); w.setDue(false); w.processRoomMarket(room);
    assert.deepEqual(w.deals.map(deal => deal.id), ['stale', 'valid']);
    assert.equal(w.queries(), 1);
});

test('native ERR_FULL stops every room for the current tick without invalidating its buy order', () => {
    const w = world(), first = w.add('W1N1', { storage: { energy: 400000 }, terminal: { energy: 160000 } }),
        second = w.add('W2N1', { storage: { energy: 400000 }, terminal: { energy: 160000 } });
    w.setDealResult(-8);
    w.processRoomMarket(first); w.processRoomMarket(second);
    assert.equal(w.deals.length, 1);
    w.tick(); w.setDue(false); w.setDealResult(0); w.processRoomMarket(first);
    assert.equal(w.deals.length, 2);
    assert.equal(w.deals[1].id, 'buy');
    assert.equal(w.queries(), 1);
});

test('effective terminal energy protects stock already withdrawn by local logistics', () => {
    const w = world(), room = w.add('W1N1', { storage: { energy: 400000 }, terminal: { energy: 160000 } });
    w.network.recordTerminalWithdrawal(room, 'energy', 20000);
    w.processRoomMarket(room);
    assert.equal(w.deals.length, 0, 'native Store still says 160k, but the full planned batch is not physically available');
});

test('a same-tick shard change resets its order cache and deal allowance', () => {
    const w = world();
    for (let index = 0; index < 10; index++) w.processRoomMarket(w.add(`W${index}N1`, {
        storage: { energy: 400000 }, terminal: { energy: 160000 } }));
    assert.equal(w.deals.length, 10);
    w.game.shard.name = 'next-shard';
    w.processRoomMarket(w.add('W20N1', { storage: { energy: 400000 }, terminal: { energy: 160000 } }));
    assert.equal(w.deals.length, 11);
    assert.equal(w.queries(), 2);
});

test('evacuating ordinary rooms leave all terminal staging to evacuation', () => {
    const w = world(), room = w.add();
    room.memory.evacuation = {};
    w.processRoomMarket(room);
    assert.equal(w.queries(), 0);
    assert.equal(room.memory.terminalAmount.energy, 50000);
});
