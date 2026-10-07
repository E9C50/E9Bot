const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function store(resources, capacity) {
    const result = { ...resources };
    Object.defineProperties(result, {
        getUsedCapacity: { value: () => Object.values(result).reduce((total, value) => total + value, 0) },
        getFreeCapacity: { value: () => capacity - result.getUsedCapacity() },
        getCapacity: { value: () => capacity }
    });
    return result;
}
function world() {
    const game = { time: 1, shard: { name: 'test' }, rooms: {}, creeps: {}, market: {
        calcTransactionCost: amount => Math.ceil(amount / 10),
        getAllOrders: () => [{ id: 'buy', remainingAmount: 100000, price: 10, roomName: 'W5N1' }],
        deal: () => 0
    } };
    const roomPolicy = { market: { defaultMinimumPrice: 0, defaultSaleAmount: 5000,
        energyValue: 1, minimumOrderAmount: 100 }, terminal: { centerResourceReserve: 5000 } };
    const evacuationState = { isRoomEvacuating: () => false };
    const loader = createSourceLoader({ globals: { Game: game, Memory: {}, RESOURCE_ENERGY: 'energy',
        ORDER_BUY: 'buy', OK: 0, console: { log() {} } }, modules: {
        './evacuationState': evacuationState,
        './evacuation': { getEvacuationIncomingCapacity: room => room.terminal.store.getFreeCapacity(),
            reserveEvacuationIncoming() {} },
        'settings/roomPolicy': { roomPolicy, centerResourceSales: [], centerTerminalResources: [], roomResourceSales: [] },
        'runtime/roomSchedule': { roomWorkDue: () => true },
        'runtime/cpuRecovery': { cpuRecoveryInterval: () => 1 }
    } });
    function add(name, { warehouse = false, storage = {}, terminal = { energy: 50000 },
        storageCapacity = warehouse ? 8000000 : 1000000, terminalCapacity = 300000 } = {}) {
        const room = { name, my: true, controller: { my: true, level: 8, isPowerEnabled: warehouse },
            memory: { terminalSendJob: {}, terminalAmount: {} }, labs: [],
            storage: { id: `${name}:storage`, store: store(storage, storageCapacity) },
            terminal: { id: `${name}:terminal`, my: true, cooldown: 0, store: store(terminal, terminalCapacity) } };
        game.rooms[name] = room;
        return room;
    }
    return { game, add, network: loader.load('room/resourceNetwork'), market: () => loader.load('room/market') };
}

test('production reserve includes existing lab reagents without reserving them twice', () => {
    const w = world();
    const room = w.add('W1N1', { storage: { H: 10000 } });
    room.labs.push({ store: store({ H: 3000 }, 3000) });
    room.memory.productionReserve = { lab: { H: 3000 } };
    assert.equal(w.network.getRoomResourceAmount(room, 'H'), 13000);
    assert.equal(w.network.getResourceKeep(room, 'H'), 13000);
    assert.equal(w.network.getAvailableResource(room, 'H'), 0);
    w.game.creeps.manager = { room, memory: { role: 'manager' }, store: store({ H: 500 }, 2450) };
    w.game.time++;
    assert.equal(w.network.getAvailableResource(room, 'H'), 500);
});

test('multiple production recipients share only the donor stock left above ordinary mineral reserves', () => {
    const w = world();
    const donor = w.add('W1N1', { storage: { H: 15000 } });
    const first = w.add('W2N1'), second = w.add('W3N1');
    w.network.requestRoomResource(first, 'H', 4000);
    w.network.requestRoomResource(second, 'H', 4000);
    assert.equal(w.network.getIncomingResourceAmount(first.name, 'H'), 4000);
    assert.equal(w.network.getIncomingResourceAmount(second.name, 'H'), 1000);
    assert.equal(w.network.getOutgoingResourceAmount(donor.name, 'H'), 5000);
    assert.equal(w.network.getAvailableResource(donor, 'H'), 0);
});

test('successful terminal sends turn promises into actual stock and debit the transaction energy once', () => {
    const w = world();
    const donor = w.add('W1N1', { warehouse: true, storage: { H: 20000, energy: 100000 } });
    const target = w.add('W2N1');
    w.network.requestRoomResource(target, 'H', 5000);
    const id = Object.keys(donor.memory.terminalSendJob)[0];
    w.network.updateResourceJob(donor, id);
    w.network.recordResourceSend(donor, target.name, 'H', 5000, 500);
    assert.equal(w.network.getRoomResourceAmount(donor, 'H'), 15000);
    assert.equal(w.network.getRoomResourceAmount(donor, 'energy'), 149500);
    assert.equal(w.network.getRoomResourceAmount(target, 'H'), 5000);
    assert.equal(w.network.getIncomingResourceAmount(target.name, 'H'), 0);
    assert.equal(w.network.projectedResource(target, 'H'), 5000);
});

test('same-tick received cargo still occupies receiving headroom after its promise is removed', () => {
    const w = world();
    const donor = w.add('W1N1', { warehouse: true, storage: { H: 100000 } });
    const target = w.add('W2N1', { storageCapacity: 10000, terminal: { energy: 280000 } });
    w.network.requestRoomResource(target, 'H', 10000);
    w.network.updateResourceJob(donor, Object.keys(donor.memory.terminalSendJob)[0]);
    w.network.recordResourceSend(donor, target.name, 'H', 10000, 1000);
    w.network.requestRoomResource(target, 'H', 30000);
    assert.equal(w.network.getIncomingResourceAmount(target.name, 'H'), 10000);
});

test('market deals debit the shared resource snapshot before later production can reserve the sold stock', () => {
    const w = world();
    const room = w.add('W1N1', { warehouse: true, storage: { H: 300001, energy: 100000 },
        terminal: { H: 99999, energy: 60000 } });
    const beforeEnergy = w.network.getRoomResourceAmount(room, 'energy');
    w.market().sellResource(room, 'H', 300000, 0, 5000);
    assert.equal(w.network.getRoomResourceAmount(room, 'H'), 395000);
    assert.equal(w.network.getRoomResourceAmount(room, 'energy'), beforeEnergy - 500);
    assert.equal(w.network.terminalUsed(room), true);
});

test('stale automatic import promises are reduced to available donor stock and can be replaced', () => {
    const w = world();
    const donor = w.add('W1N1', { warehouse: true, storage: { H: 5000 } });
    const target = w.add('W2N1');
    w.network.requestRoomResource(target, 'H', 5000);
    donor.storage.store.H = 500;
    w.add('W3N1', { warehouse: true, storage: { H: 4500 } });
    w.game.time++;
    w.network.planResourceDistribution();
    assert.equal(w.network.getIncomingResourceAmount(target.name, 'H'), 500);
    w.network.requestRoomResource(target, 'H', 5000);
    assert.equal(w.network.getIncomingResourceAmount(target.name, 'H'), 5000);
    assert.equal(w.network.getOutgoingResourceAmount(donor.name, 'H'), 500);
});

test('local terminal withdrawals debit dispatchable stock while preserving the room total through transit', () => {
    const w = world();
    const room = w.add('W1N1', { warehouse: true, storage: { H: 10000, energy: 100000 },
        terminal: { H: 5000, energy: 60000 } });
    w.network.recordResourceDebit(room, 'H', 2000, 10000);
    assert.equal(w.network.getTerminalResourceAmount(room, 'H'), 3000);
    assert.equal(w.network.getTerminalResourceAmount(room, 'energy'), 50000);
    w.network.recordTerminalWithdrawal(room, 'H', 1000);
    assert.equal(w.network.getTerminalResourceAmount(room, 'H'), 2000);
    assert.equal(w.network.getRoomResourceAmount(room, 'H'), 13000);
    assert.equal(w.network.getRoomResourceAmount(room, 'energy'), 150000);
});
