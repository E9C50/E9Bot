const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world() {
    class Position {
        constructor(x, y) { Object.assign(this, { x, y, roomName: 'E39N5' }); }
        getRangeTo(value) { const p = value.pos || value; return Math.max(Math.abs(this.x - p.x), Math.abs(this.y - p.y)); }
        isNearTo(value) { return this.getRangeTo(value) <= 1; }
        inRangeTo(value, range) { return this.getRangeTo(value) <= range; }
    }
    const p = (x, y) => new Position(x, y), objects = new Map(), calls = [], intents = [];
    const store = (energy, capacity) => ({ energy, getCapacity: () => capacity, getFreeCapacity() { return capacity - this.energy; } });
    const structure = (id, type, x, y, energy, capacity) => {
        const target = { id, structureType: type, pos: p(x, y), store: store(energy, capacity), my: true };
        objects.set(id, target); return target;
    };
    const source = { id: 'mine', pos: p(42, 32), energy: 3000 };
    const storage = structure('storage', 'storage', 18, 29, 0, 1000000);
    const terminal = structure('terminal', 'terminal', 19, 30, 8509, 300000);
    const container = structure('mine-container', 'container', 43, 33, 0, 2000);
    const controllerBuffer = structure('controller-container', 'container', 11, 31, 2000, 2000);
    const spawn = structure('spawn', 'spawn', 17, 27, 300, 300);
    const extensions = Array.from({ length: 38 }, (_, i) => structure(`extension-${i}`, 'extension', 20 + i % 10, 24 + Math.floor(i / 10), 0, 50));
    const minerBody = [...Array(13).fill('work'), ...Array(3).fill('carry'), ...Array(13).fill('move')];
    const distributorBody = [...Array(22).fill('carry'), ...Array(22).fill('move')];
    const room = { name: 'E39N5', energyCapacityAvailable: 2200, controller: { my: true, level: 6, pos: p(9, 29) },
        storage, terminal, sources: [source], containers: [controllerBuffer, container], links: [], droppedResource: [], spawns: [spawn], extensions,
        memory: { creepConfig: {
            miner: { role: 'harvester', spawnRoom: 'E39N5', data: { sourceId: source.id }, development: { fullBody: true }, testBody: minerBody },
            distributor: { role: 'filler', spawnRoom: 'E39N5', data: { sourceId: storage.id }, development: { fullBody: true }, testBody: distributorBody },
        } } };
    Object.defineProperty(room, 'energyAvailable', { get: () => [spawn, ...extensions].reduce((total, target) => total + target.store.energy, 0) });
    source.room = room; objects.set(source.id, source);
    const game = { time: 100, shard: { name: 'shard1' }, rooms: { E39N5: room }, creeps: {}, getObjectById: id => objects.get(id) || null };
    function filler(name = 'carrier', capacity = 600) {
        const carrier = { name, room, pos: p(42, 34), spawning: false, ticksToLive: 1200, store: store(0, capacity),
            memory: { role: 'filler', name: 'E39N5_DEVELOP_FILLER_mine_0', spawnRoom: room.name, data: { sourceId: container.id, mineId: source.id },
                developmentHauler: { shard: 'shard1', roomName: room.name, mineId: source.id, phase: 'load', energy: 0, lastGainTick: 99 } },
            getActiveBodyparts: part => part === 'carry' || part === 'move' ? 12 : 0,
            moveTo(target) { calls.push({ method: 'move', target: target.id }); this.pos = p(target.pos.x + 1, target.pos.y); return 0; },
            withdraw(target, resource, amount) {
                calls.push({ method: 'withdraw', target: target.id, amount });
                if (!this.pos.isNearTo(target)) return -9;
                intents.push(() => { const quantity = Math.min(amount, target.store.energy, this.store.getFreeCapacity()); target.store.energy -= quantity; this.store.energy += quantity; }); return 0;
            },
            transfer(target, resource, amount) {
                calls.push({ method: 'transfer', target: target.id, amount });
                if (!this.pos.isNearTo(target)) return -9;
                intents.push(() => { const quantity = Math.min(amount, this.store.energy, target.store.getFreeCapacity()); this.store.energy -= quantity; target.store.energy += quantity; }); return 0;
            },
            pickup() { assert.fail('there is no dropped energy in this world'); },
        };
        game.creeps[name] = carrier; return carrier;
    }
    const carrier = filler(); let previews = 0, linked = false;
    const loader = createSourceLoader({ globals: { Game: game, RESOURCE_ENERGY: 'energy', WORK: 'work', CARRY: 'carry', MOVE: 'move',
        BODYPART_COST: { work: 100, carry: 50, move: 50 }, STRUCTURE_CONTAINER: 'container', STRUCTURE_LINK: 'link', OK: 0, ERR_NOT_IN_RANGE: -9 },
        modules: {
            './bodySelection': { previewBodySelection(room, config) { previews++; return { body: config.testBody }; } },
            'creep/bodySelection': { previewBodySelection(room, config) { previews++; return { body: config.testBody }; } },
            'room/sourceLinks': { sourceLinkWithCenter: () => linked ? { id: 'source-link' } : undefined },
            'creep/developmentLogistics': { controllerEnergyBuffer: () => controllerBuffer },
            'creep/haulerPickup': { haulerEnergyPickupReserved: () => 0, reserveHaulerEnergyPickup() {} },
            './haulerPickup': { haulerEnergyPickupReserved: () => 0, reserveHaulerEnergyPickup() {} },
            utils: { getDistance: (a, b) => a.getRangeTo(b) },
            'room/labBoostPriority': { boostLabEnergyDeficit: () => 0, prioritizeLabBoostJobs: () => false, recordBoostLabEnergyTransfer() {} },
            'creep/haulerDelivery': { withHaulerTraffic: behavior => behavior, deliverHaulerEnergy: () => false },
            'creep/storageFillerLifecycle': { retireSupersededStorageFiller: () => false },
        } });
    const api = loader.load('creep/fillerProductionRecovery');
    return { api, game, room, carrier, filler, source, container, controllerBuffer, terminal, storage, spawn, calls,
        get previews() { return previews; },
        setLinked(value) { linked = value; },
        behavior: () => loader.load('role/base/RoleBaseFiller').default(carrier.memory.data),
        tick(run = () => api.runFillerProductionRecovery(carrier)) { const result = run(); intents.splice(0).forEach(intent => intent()); game.time++; return result; },
        miner() { const miner = { name: 'miner', room, pos: source.pos, spawning: false, ticksToLive: 1400,
            memory: { role: 'harvester', spawnRoom: room.name, data: { sourceId: source.id } }, getActiveBodyparts: part => part === 'work' ? 13 : part === 'carry' ? 3 : 13 };
            game.creeps.miner = miner; return miner; },
        carrierPredicate: loader.load('creep/spawnEnergyCarrier').isSpawnEnergyCarrier };
}

test('a stranded mine carrier borrows only the complete miner deficit and preserves its original lane', () => {
    const w = world(), original = JSON.stringify(w.carrier.memory.data), state = JSON.stringify(w.carrier.memory.developmentHauler);
    for (let i = 0; i < 100 && w.room.energyAvailable < 2100; i++) w.tick();
    assert.equal(w.room.energyAvailable, 2100); assert.equal(w.terminal.store.energy, 6709);
    assert.equal(w.controllerBuffer.store.energy, 2000); assert.equal(w.carrier.store.energy, 0);
    assert.equal(JSON.stringify(w.carrier.memory.data), original); assert.equal(JSON.stringify(w.carrier.memory.developmentHauler), state);
    assert.equal(w.room.memory.productionRecoveryTerminalDebt.restoreEnergy, 8509);
    assert.equal(w.api.getProductionRecoveryMiner(w.room).cost, 2100);
});

for (const phase of ['source', 'target']) test(`the actual filler ${phase} hook performs critical recovery before its permanent mine lane`, () => {
    const w = world(), behavior = w.behavior();
    for (let i = 0; i < 100 && w.room.energyAvailable < 2100; i++) w.tick(() => behavior[phase](w.carrier));
    assert.equal(w.room.energyAvailable, 2100); assert.equal(w.terminal.store.energy, 6709);
    assert.equal(w.carrier.memory.data.mineId, w.source.id);
});

test('zero-CARRY ground miners retain native production while incompatible Link miners cannot hide an outage', () => {
    const w = world(), miner = w.miner();
    miner.getActiveBodyparts = part => part === 'carry' ? 0 : 1;
    assert.equal(w.api.hasProductionRecoveryMiner(w.room), true);
    w.setLinked(true); assert.equal(w.api.hasProductionRecoveryMiner(w.room), false);
});

test('critical borrowing can be disabled without touching ordinary terminal reserves', () => {
    const w = world(); w.api.fillerProductionRecoveryPolicy.borrowTerminalReserve = false;
    assert.equal(w.tick(), false); assert.equal(w.terminal.store.energy, 8509);
    w.terminal.store.energy = 50100;
    for (let i = 0; i < 5; i++) w.tick();
    assert.equal(w.terminal.store.energy, 50000);
    assert.equal(w.room.memory.productionRecoveryTerminalDebt, undefined);
});

test('healthy miners never borrow reserves or preview births, and fresh markers cannot survive stale ticks', () => {
    const w = world(); w.miner();
    assert.equal(w.tick(), false); assert.equal(w.previews, 0); assert.equal(w.terminal.store.energy, 8509);
    assert.equal(w.carrierPredicate(w.room, w.carrier), false);
    w.carrier.memory.productionRecoverySpawn = { roomName: w.room.name, tick: w.game.time };
    assert.equal(w.carrierPredicate(w.room, w.carrier), true);
    w.game.time += 2; assert.equal(w.carrierPredicate(w.room, w.carrier), false);
    w.carrier.memory.productionRecoverySpawn.tick = w.game.time + 1;
    assert.equal(w.carrierPredicate(w.room, w.carrier), false);
});

test('healthy rooms share one global harvester scan per tick and skip unrelated body/catalog reads', () => {
    const w = world(); w.miner();
    const secondRoom = { ...w.room, name: 'E40N5', energyAvailable: 300, memory: { creepConfig: {} } };
    const secondCarrier = w.filler('second-carrier'); secondCarrier.room = secondRoom; secondCarrier.memory.spawnRoom = secondRoom.name;
    w.game.creeps.secondMiner = { ...w.game.creeps.miner, name: 'secondMiner', room: secondRoom,
        memory: { ...w.game.creeps.miner.memory, spawnRoom: secondRoom.name } };
    w.carrier.getActiveBodyparts = secondCarrier.getActiveBodyparts = () => assert.fail('healthy path must not read unrelated filler bodies');
    let scans = 0;
    w.game.creeps = new Proxy(w.game.creeps, { ownKeys(target) { scans++; return Reflect.ownKeys(target); } });
    w.tick(() => { assert.equal(w.api.runFillerProductionRecovery(w.carrier), false); assert.equal(w.api.runFillerProductionRecovery(secondCarrier), false); });
    assert.equal(scans, 1); assert.equal(w.previews, 0);
    w.tick(); assert.equal(scans, 2);
    w.game.time -= 10; w.tick(); assert.equal(scans, 3);
    w.game.shard.name = 'shard3'; w.tick(); assert.equal(scans, 4);
});

test('the temporary carrier keeps the first miner producing until a complete distributor is usable, then repays the loan', () => {
    const w = world(), original = JSON.stringify(w.carrier.memory.data);
    for (let i = 0; i < 100 && w.room.energyAvailable < 2100; i++) w.tick();
    w.spawn.store.energy = 0; w.room.extensions.forEach(target => { target.store.energy = 0; });
    const miner = w.miner(); miner.spawning = true;
    w.container.store.energy = 2000;
    for (let i = 0; i < 120 && w.room.energyAvailable < 2200; i++) { w.container.store.energy = 2000; w.tick(); }
    assert.equal(w.room.energyAvailable, 2200); assert.equal(w.terminal.store.energy, 6709, 'loan repayment waits for real distribution');
    assert.equal(w.carrierPredicate(w.room, w.carrier), true);
    const distributor = w.filler('distributor'); distributor.memory.data = { sourceId: w.storage.id }; delete distributor.memory.developmentHauler;
    distributor.spawning = true; miner.spawning = false;
    w.tick(); assert.ok(w.carrier.memory.productionRecoverySpawn, 'spawning distributor cannot take over');
    distributor.spawning = false; w.carrier.store.energy = 600;
    for (let i = 0; i < 5; i++) w.tick();
    assert.equal(w.carrier.memory.productionRecoverySpawn, undefined);
    assert.equal(w.terminal.store.energy, 7309);
    assert.equal(JSON.stringify(w.carrier.memory.data), original);
    for (let batch = 0; batch < 2; batch++) {
        w.carrier.store.energy = 600;
        for (let i = 0; i < 5; i++) w.tick();
    }
    assert.equal(w.terminal.store.energy, 8509);
    assert.equal(w.room.memory.productionRecoveryTerminalDebt, undefined);
    assert.equal(w.carrier.memory.productionRecoveryLoad, undefined);
});

test('the sole permanent Storage survivor takes over its own temporary lane and repays the critical loan', () => {
    const w = world(); w.carrier.memory.data = { sourceId: w.storage.id }; delete w.carrier.memory.developmentHauler;
    w.carrier.memory.name = 'E39N5_DEVELOP_FILLER_STORAGE_0';
    delete w.game.creeps.carrier;
    w.carrier.name = 'distributor'; w.game.creeps.distributor = w.carrier;
    const original = JSON.stringify(w.carrier.memory.data);
    for (let i = 0; i < 100 && w.room.energyAvailable < 2100; i++) w.tick();
    assert.equal(w.terminal.store.energy, 6709);
    assert.equal(w.api.getProductionRecoveryDistributor(w.room), undefined, 'the only Storage demand is already occupied by its survivor');
    assert.ok(w.carrier.memory.productionRecoverySpawn);
    w.miner(); w.tick();
    assert.equal(w.carrier.memory.productionRecoverySpawn, undefined, 'its native Storage identity can take over without another birth');
    assert.equal(w.carrier.memory.productionRecoveryLoad, undefined);
    for (let batch = 0; batch < 3; batch++) {
        w.carrier.store.energy = 600;
        for (let i = 0; i < 5; i++) w.tick();
    }
    assert.equal(w.terminal.store.energy, 8509);
    assert.equal(w.room.memory.productionRecoveryTerminalDebt, undefined);
    assert.equal(w.tick(), false, 'normal Storage delivery resumes once the debt is paid');
    assert.equal(JSON.stringify(w.carrier.memory.data), original); assert.equal(w.carrier.memory.developmentHauler, undefined);
});

test('cargo already loaded for production finishes its route after distributor handover', () => {
    const w = world(); w.miner();
    w.carrier.store.energy = 200;
    w.carrier.memory.productionRecoverySpawn = { roomName: w.room.name, tick: w.game.time - 1 };
    w.carrier.memory.productionRecoveryCargo = { targetEnergy: 2100 };
    const distributor = w.filler('distributor'); distributor.memory.data = { sourceId: w.storage.id }; delete distributor.memory.developmentHauler;
    for (let i = 0; i < 20 && w.carrier.store.energy > 0; i++) w.tick();
    assert.equal(w.room.energyAvailable, 500); assert.equal(w.storage.store.energy, 0);
    assert.equal(w.carrier.memory.productionRecoverySpawn, undefined);
    w.tick(); assert.equal(w.carrier.memory.productionRecoveryCargo, undefined);
});

test('simultaneous survivors reserve a shared deficit instead of draining duplicate terminal batches', () => {
    const w = world(), other = w.filler('other', 2000); w.carrier.store = { energy: 0, getCapacity: () => 2000, getFreeCapacity() { return 2000 - this.energy; } };
    w.carrier.pos = other.pos = w.terminal.pos;
    w.tick(() => { w.api.runFillerProductionRecovery(w.carrier); w.api.runFillerProductionRecovery(other); });
    assert.equal(w.carrier.store.energy + other.store.energy, 1800);
    assert.equal(w.terminal.store.energy, 6709);
});
