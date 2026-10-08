const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

test('the exported main loop mounts once and preserves the complete tick dependency order', () => {
    const calls = [];
    const mark = name => () => calls.push(name);
    const loader = createSourceLoader({
        globals: { Game: { time: 1, shard: { name: 'shard0' }, cpu: { getUsed: () => 0, bucket: 1000 } }, console: { log() {} } },
        modules: {
            './utils/BetterMove': {}, './utils/RoomResource': {},
            mount: { mountWork: mark('mount') },
            './utils/ErrorMapper': { ErrorMapper: { wrapLoop: loop => loop } },
            './utils/ExportStats': { exportStats: mark('stats') },
            './module/RoomController': { roomController: mark('rooms') },
            'role/pc/PowerCreep': { powerSpawnController: mark('powerCreeps') },
            './module/VisualController': { visualController: mark('visuals') },
            './module/ObserverController': { obScannerController: mark('observers') },
            './module/StructureController': { structureWorkController: mark('structures') },
            './module/CreepController': {
                creepNumberController: mark('population'), creepWorkController: mark('creeps'), teamWorkController: mark('teams')
            },
            './runtime/maintenance': {
                generatePixel: mark('pixels'), purchasePrivateServerEnergy: mark('privateMarket'), recordCpuHistory: mark('cpuHistory')
            },
            './runtime/memory': { loadMemory: mark('memory') },
            './shard/controller': { runShardController: mark('shards') },
            './shard/targetDismantleControl': { runTargetDismantleControl: mark('targetDismantle') },
            './shard/transport': { flushInterShardMemory: mark('shardFlush') },
            './combat/missions': { runCombatTasks: mark('combat') }
        }
    });
    const { loop } = loader.load('main');
    assert.deepEqual(calls, ['mount']);
    calls.length = 0;
    loop();
    loop();
    const tick = ['memory', 'shards', 'rooms', 'combat', 'population', 'targetDismantle', 'creeps', 'powerCreeps', 'teams', 'structures', 'observers', 'visuals', 'stats', 'pixels', 'privateMarket', 'cpuHistory', 'shardFlush'];
    assert.deepEqual(calls, [...tick, ...tick]);
});

test('tick stages keep their declared order on every tick', () => {
    const calls = [];
    const { createTickRunner } = createSourceLoader({
        globals: { Game: { time: 1, shard: { name: 'shard0' }, cpu: { getUsed: () => 0 } } }
    }).load('runtime/TickRunner');
    const runner = createTickRunner([
        { name: 'initialize', run: () => calls.push('initialize') },
        { name: 'population', run: () => calls.push('population') },
        { name: 'roles', run: () => calls.push('roles') },
        { name: 'structures', run: () => calls.push('structures') }
    ]);
    runner();
    runner();
    assert.deepEqual(calls, ['initialize', 'population', 'roles', 'structures', 'initialize', 'population', 'roles', 'structures']);
});

test('a failed prerequisite stops the tick and rethrows the original error', () => {
    const calls = [];
    const logs = [];
    const failure = new Error('room initialization failed');
    const { createTickRunner } = createSourceLoader({
        globals: {
            Game: { time: 1, shard: { name: 'shard0' }, cpu: { getUsed: () => 0 } },
            console: { log: message => logs.push(message) }
        }
    }).load('runtime/TickRunner');
    const runner = createTickRunner([
        { name: 'rooms', run() { calls.push('rooms'); throw failure; } },
        { name: 'creeps', run: () => calls.push('creeps') }
    ]);
    assert.throws(runner, error => error === failure);
    assert.deepEqual(calls, ['rooms']);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /rooms/);
});

test('pixel generation follows bucket, shard, capability, and enabled policy boundaries', () => {
    let pixels = 0;
    const game = { shard: { name: 'shard0' }, cpu: { bucket: 9999, generatePixel: () => pixels++ } };
    const loader = createSourceLoader({ globals: { Game: game } });
    const { generatePixel } = loader.load('runtime/maintenance');
    generatePixel();
    assert.equal(pixels, 0);
    game.cpu.bucket = 10000;
    generatePixel();
    assert.equal(pixels, 1);
    game.shard.name = 'shard3';
    generatePixel();
    assert.equal(pixels, 1);
    game.shard.name = 'shard0';
    const policy = loader.load('settings/runtime').runtimePolicy;
    policy.pixel.enabled = false;
    generatePixel();
    assert.equal(pixels, 1);
    policy.pixel.enabled = true;
    delete game.cpu.generatePixel;
    assert.doesNotThrow(generatePixel);
});

test('CPU history keeps the configured window and ignores disabled or unmatched samples', () => {
    const game = { shard: { name: 'shard3' }, cpu: { getUsed: () => 6 } };
    const loader = createSourceLoader({ globals: { Game: game } });
    const { recordCpuHistory } = loader.load('runtime/maintenance');
    const policy = loader.load('settings/runtime').runtimePolicy;
    policy.cpuHistory.sampleCount = 3;
    const previous = [1, 2, 3, 4, 5];
    loader.globals.cpuList = previous;
    recordCpuHistory();
    assert.equal(loader.globals.cpuList, previous);
    assert.deepEqual(previous, [4, 5, 6]);
    game.shard.name = 'shard0';
    recordCpuHistory();
    assert.deepEqual(previous, [4, 5, 6]);
    game.shard.name = 'shard3';
    policy.cpuHistory.sampleCount = 0;
    recordCpuHistory();
    assert.deepEqual(previous, [4, 5, 6]);
});

function createMarketWorld({ storageEnergy, terminalEnergy, credits = 100000, orders = [], results = [], transactionCost = () => 0 }) {
    const deals = [];
    let orderQueries = 0;
    const room = {
        name: 'W1N1', my: true,
        storage: { store: { energy: storageEnergy } },
        terminal: { cooldown: 0, store: { energy: terminalEnergy, getFreeCapacity: () => 200000 } }
    };
    const game = {
        time: 10,
        shard: { name: 'b7b7cfd29cac' },
        rooms: { W1N1: room },
        market: {
            credits,
            getAllOrders() { orderQueries++; return [...orders]; },
            calcTransactionCost: transactionCost,
            deal(id, amount, roomName) {
                deals.push({ id, amount, roomName });
                return results[deals.length - 1] ?? 0;
            }
        }
    };
    const loader = createSourceLoader({ globals: { Game: game, RESOURCE_ENERGY: 'energy', ORDER_SELL: 'sell', OK: 0 } });
    return { api: loader.load('runtime/maintenance'), deals, queries: () => orderQueries };
}

test('private server energy purchases include energy already in the terminal', () => {
    const { api, deals, queries } = createMarketWorld({ storageEnergy: 480000, terminalEnergy: 30000 });
    api.purchasePrivateServerEnergy();
    assert.deepEqual(deals, []);
    assert.equal(queries(), 0);
});

test('private server energy purchases are limited by remaining demand and make one successful deal', () => {
    const { api, deals } = createMarketWorld({
        storageEnergy: 400000, terminalEnergy: 50000,
        orders: [
            { id: 'expensive', price: 2, amount: 90000, roomName: 'W2N2' },
            { id: 'cheapest', price: 1, amount: 90000, roomName: 'W2N2' }
        ]
    });
    api.purchasePrivateServerEnergy();
    assert.deepEqual(deals, [{ id: 'cheapest', amount: 50000, roomName: 'W1N1' }]);
});

test('a failed deal does not consume demand and the next order can succeed', () => {
    const { api, deals } = createMarketWorld({
        storageEnergy: 400000, terminalEnergy: 50000,
        orders: [
            { id: 'failed', price: 1, amount: 90000, roomName: 'W2N2' },
            { id: 'success', price: 2, amount: 90000, roomName: 'W2N2' },
            { id: 'unused', price: 3, amount: 90000, roomName: 'W2N2' }
        ],
        credits: 200000, results: [-6, 0, 0]
    });
    api.purchasePrivateServerEnergy();
    assert.deepEqual(deals, [
        { id: 'failed', amount: 50000, roomName: 'W1N1' },
        { id: 'success', amount: 50000, roomName: 'W1N1' }
    ]);
});

test('private server purchases respect credits and available transfer energy', () => {
    const { api, deals } = createMarketWorld({
        storageEnergy: 400000, terminalEnergy: 7000,
        credits: 50000,
        orders: [{ id: 'order', price: 2, amount: 100000, roomName: 'W2N2' }],
        transactionCost: amount => Math.ceil(amount / 2)
    });
    api.purchasePrivateServerEnergy();
    assert.deepEqual(deals, [{ id: 'order', amount: 14000, roomName: 'W1N1' }]);
});
