const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world() {
    const game = { time: 1, market: { getAllOrders() { queries++; return []; } } };
    let queries = 0;
    const policy = { market: { scanInterval: 25, staggerScans: true }, terminal: { centerResourceReserve: 5000 } };
    const loader = createSourceLoader({ globals: { Game: game, Memory: { centerStorage: 'E31N2' }, ORDER_BUY: 'buy', RESOURCE_ENERGY: 'energy' },
        modules: { 'settings/roomPolicy': { roomPolicy: policy,
            roomResourceSales: [{ resourceType: 'energy', threshold: 600000, minPrice: 20, sellAmount: 10000 }],
            centerResourceSales: [], centerTerminalResources: ['X'] },
            './resourceNetwork': { isWarehouseRoom: room => room.name === 'E31N2', terminalUsed: () => false } } });
    const rooms = ['E31N2', 'E34N3', 'E35N1', 'E35N3', 'E36N2', 'E37N7', 'E38N5', 'E38N6', 'E41N7', 'E41N8', 'E37N5']
        .map(name => ({ name, storage: { store: { energy: 700000 } }, terminal: { cooldown: 0 }, memory: { terminalAmount: {} } }));
    return { game, policy, rooms, ...loader.load('room/market'), queries: () => queries,
        recovery: loader.load('settings/runtime').runtimePolicy.cpuRecovery };
}

test('market scans once per room in 25 ticks, spreads queries and refreshes central reserves every tick', () => {
    const w = world(), ticks = [];
    for (let tick = 1; tick <= 25; tick++) {
        w.game.time = tick; const before = w.queries();
        w.rooms[0].memory.terminalAmount.X = 0;
        for (const room of w.rooms) w.processRoomMarket(room);
        assert.equal(w.rooms[0].memory.terminalAmount.X, 5000);
        ticks.push(w.queries() - before);
    }
    assert.equal(w.queries(), 11, 'the old loop issued 275 queries while no profitable orders existed');
    assert.ok(Math.max(...ticks) < 11);
    for (let tick = 26; tick <= 50; tick++) { w.game.time = tick; for (const room of w.rooms) w.processRoomMarket(room); }
    assert.equal(w.queries(), 22, 'no eligible room is permanently skipped');
});

test('direct selling remains immediate and scheduled scans still respect fresh cooldown and storage', () => {
    const w = world(), room = w.rooms[0];
    w.sellResource(room, 'energy', 600000); assert.equal(w.queries(), 1);
    room.storage.store.energy = 0;
    for (let tick = 1; tick <= 25; tick++) { w.game.time = tick; w.processRoomMarket(room); }
    assert.equal(w.queries(), 1);
    room.storage.store.energy = 700000; room.terminal.cooldown = 1;
    for (let tick = 26; tick <= 50; tick++) { w.game.time = tick; w.processRoomMarket(room); }
    assert.equal(w.queries(), 1);
    room.terminal.cooldown = 0;
    for (let tick = 51; tick <= 75; tick++) { w.game.time = tick; w.processRoomMarket(room); }
    assert.equal(w.queries(), 2);
});

test('empty-bucket market scans remain periodic and keep central resource reserves fresh', () => {
    const w = world();
    w.game.cpu = { bucket: 0 };
    for (let tick = 1; tick <= 250; tick++) {
        w.game.time = tick;
        w.rooms[0].memory.terminalAmount.X = 0;
        for (const room of w.rooms) w.processRoomMarket(room);
        assert.equal(w.rooms[0].memory.terminalAmount.X, 5000);
    }
    assert.equal(w.queries(), 11);
    w.recovery.enabled = false;
    for (let tick = 251; tick <= 275; tick++) { w.game.time = tick; for (const room of w.rooms) w.processRoomMarket(room); }
    assert.equal(w.queries(), 22, 'disabling recovery immediately restores the normal scan interval');
});
