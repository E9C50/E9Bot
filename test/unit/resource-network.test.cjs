const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function store(values = {}, capacity = 1000000) {
    const result = { ...values };
    Object.defineProperties(result, {
        getCapacity: { value: () => capacity },
        getUsedCapacity: { value: resource => resource ? result[resource] || 0 : Object.values(result).reduce((a, b) => a + b, 0) },
        getFreeCapacity: { value: () => capacity - result.getUsedCapacity() },
    });
    return result;
}
function world(time = 30) {
    const game = { time, shard: { name: 'shard3' }, rooms: {}, creeps: {},
        market: { calcTransactionCost: amount => Math.ceil(amount * 0.1) } };
    const incoming = new Map(), sends = [];
    const loader = createSourceLoader({ globals: { Game: game, Memory: { rooms: {} }, OK: 0 }, modules: {
        'room/evacuation': {
            getEvacuationIncomingCapacity: room => Math.max(0, room.terminal.store.getFreeCapacity() - (incoming.get(room.name) || 0)),
            reserveEvacuationIncoming: (room, amount) => incoming.set(room.name, (incoming.get(room.name) || 0) + amount),
        },
    } });
    function room(name, values = {}, { warehouse = false, terminal = { energy: 50000 }, terminalCapacity = 300000, cooldown = 1 } = {}) {
        const r = { name, my: true, level: 8, controller: { my: true, isPowerEnabled: warehouse },
            storage: { store: store({ energy: 350000, ...values }, warehouse ? 8000000 : 1000000) },
            terminal: { my: true, cooldown, store: store(terminal, terminalCapacity), send(resource, amount, target) {
                sends.push({ from: name, resource, amount, target }); return 0;
            } }, labs: [], memory: { terminalAmount: {}, terminalSendJob: {}, boostNeed: {} } };
        game.rooms[name] = r; return r;
    }
    return { game, sends, room, loader, ...loader.load('room/resourceNetwork'), ...loader.load('room/terminal'), ...loader.load('settings/resourcePolicy') };
}

test('warehouses require enabled power and actual 8M capacity, not amount of inventory or configured name', () => {
    const w = world(), ordinary = w.room('ordinary'), warehouse = w.room('warehouse', {}, { warehouse: true });
    assert.equal(w.isWarehouseRoom(ordinary), false); assert.equal(w.isWarehouseRoom(warehouse), true);
    warehouse.controller.isPowerEnabled = false; assert.equal(w.isWarehouseRoom(warehouse), false);
    ordinary.controller.isPowerEnabled = true; assert.equal(w.isWarehouseRoom(ordinary), false);
});

test('ordinary rooms receive all ten T3, seven basic minerals, G and 5k ops; T1/T2 have no refill obligation', () => {
    const w = world(), resources = [...w.t3Resources, ...w.basicMinerals, 'G', 'ops'];
    const donor = w.room('warehouse', Object.fromEntries(resources.map(r => [r, 100000])), { warehouse: true });
    const ordinary = w.room('ordinary'); w.planResourceDistribution();
    for (const resource of resources) assert.equal(w.projectedResource(ordinary, resource), w.ordinaryResourceTarget(resource), resource);
    assert.equal(w.getIncomingResourceAmount(ordinary.name, 'UH2O'), 0);
    assert.equal(w.getAvailableResource(donor, 'ops'), 95000);
});

test('ordinary surplus obeys T3/basic/G/ops/T1/T2 floors and protects active production and boost reservations', () => {
    const w = world(), source = w.room('ordinary', { XUH2O: 25000, H: 15000, G: 15000, ops: 7000, UH2O: 23000, wire: 9000 });
    source.memory.productionReserve = { lab: { H: 3000 }, factory: { wire: 500 } };
    source.memory.boostNeed.XUH2O = 30000;
    const warehouse = w.room('warehouse', {}, { warehouse: true }); w.planResourceDistribution();
    for (const [resource, amount] of Object.entries({ XUH2O: 0, H: 2000, G: 5000, ops: 2000, UH2O: 3000, wire: 8500 }))
        assert.equal(w.getIncomingResourceAmount(warehouse.name, resource), amount, resource);
});

test('ordinary rooms retain 300k of their own mineral before exporting while other minerals still retain 10k', () => {
    const w = world(), source = w.room('ordinary', { O: 300000, U: 15000 });
    source.mineral = { mineralType: 'O' };
    const warehouse = w.room('warehouse', {}, { warehouse: true });
    w.planResourceDistribution();
    assert.equal(w.getResourceKeep(source, 'O'), 300000);
    assert.equal(w.getOutgoingResourceAmount(source.name, 'O'), 0);
    assert.equal(w.getIncomingResourceAmount(warehouse.name, 'U'), 5000);
    source.storage.store.O = 302000;
    w.game.time = 60; w.planResourceDistribution();
    assert.equal(w.getOutgoingResourceAmount(source.name, 'O'), 2000);
    assert.equal(w.projectedResource(source, 'O'), 300000);
    assert.equal(w.getIncomingResourceAmount(warehouse.name, 'O'), 2000);
});

test('old automatic native-mineral exports are released under the raised reserve and production promises remain protected', () => {
    const w = world(1), source = w.room('ordinary', { O: 15000 });
    source.mineral = { mineralType: 'O' };
    const warehouse = w.room('warehouse', {}, { warehouse: true });
    source.memory.terminalSendJob.old = { targetRoom: warehouse.name, resourceType: 'O', amount: 5000, kind: 'surplus' };
    w.planResourceDistribution();
    assert.equal(source.memory.terminalSendJob.old, undefined);
    assert.equal(w.getOutgoingResourceAmount(source.name, 'O'), 0);
    source.storage.store.O = 304000;
    source.memory.productionReserve = { lab: { O: 3000 } };
    w.game.time = 30; w.planResourceDistribution();
    assert.equal(w.getOutgoingResourceAmount(source.name, 'O'), 1000);
    assert.equal(w.getResourceKeep(source, 'O'), 303000);
    assert.equal(w.ordinaryResourceTarget('O'), 10000, 'room refill does not import 300k of a locally mined mineral');
});

test('warehouse balancing includes queued stock and sends normal-room surplus directly to the least stocked warehouse', () => {
    const w = world(), source = w.room('ordinary', { wire: 100000 });
    const low = w.room('low', {}, { warehouse: true }), high = w.room('high', { wire: 100000 }, { warehouse: true });
    w.planResourceDistribution();
    assert.equal(w.projectedResource(low, 'wire'), 100000); assert.equal(w.projectedResource(high, 'wire'), 100000);
    assert.equal(w.getOutgoingResourceAmount(high.name, 'wire'), 0, 'avoid another hop');
    assert.equal(w.getOutgoingResourceAmount(source.name, 'wire'), 100000);
});

test('warehouses equalize each resource without double committing donor stock', () => {
    const w = world(), a = w.room('a', { wire: 90000, ops: 90000 }, { warehouse: true });
    const b = w.room('b', {}, { warehouse: true }), c = w.room('c', {}, { warehouse: true });
    w.planResourceDistribution();
    for (const room of [a, b, c]) for (const res of ['wire', 'ops']) assert.equal(w.projectedResource(room, res), 30000);
    assert.equal(w.getOutgoingResourceAmount(a.name, 'wire'), 60000);
});

test('production imports are idempotent and multiple rooms cannot spend the same warehouse stock', () => {
    const w = world(1), donor = w.room('warehouse', { UH2O: 4000 }, { warehouse: true });
    const a = w.room('a'), b = w.room('b');
    assert.equal(w.requestRoomResource(a, 'UH2O', 3000), 3000);
    assert.equal(w.requestRoomResource(a, 'UH2O', 3000), 3000);
    assert.equal(w.requestRoomResource(b, 'UH2O', 3000), 1000);
    assert.equal(w.getOutgoingResourceAmount(donor.name, 'UH2O'), 4000);
});

test('warehouse balancing includes small commodity batches below the bulk transfer threshold', () => {
    const w = world(), donor = w.room('donor', { wire: 400, device: 20 }, { warehouse: true });
    const target = w.room('target', {}, { warehouse: true });
    w.planResourceDistribution();
    for (const [resource, amount] of Object.entries({ wire: 200, device: 10 })) {
        assert.equal(w.projectedResource(donor, resource), amount);
        assert.equal(w.projectedResource(target, resource), amount);
    }
    donor.terminal.cooldown = 0;
    donor.terminal.store.wire = 200;
    donor.storage.store.wire -= 200;
    donor.terminal.store.energy = 50020;
    w.processTerminalResource(donor);
    assert.deepEqual(w.sends, [{ from: 'donor', resource: 'wire', amount: 200, target: 'target' }]);
});

test('cooldown stages one large batch plus fee, never all queued cargo', () => {
    const w = world(1), donor = w.room('donor', { H: 500000, O: 500000 });
    donor.memory.terminalSendJob = { a: { targetRoom: 'external', resourceType: 'H', amount: 500000 },
        b: { targetRoom: 'external', resourceType: 'O', amount: 400000 } };
    w.processTerminalResource(donor);
    assert.deepEqual({ ...donor.memory.terminalAmount }, { energy: 60000, H: 100000 }); assert.equal(w.sends.length, 0);
});

test('sends preserve 50k terminal energy and keep the unsent job remainder', () => {
    const w = world(1), donor = w.room('donor', { H: 200000 }, { cooldown: 0, terminal: { energy: 60000, H: 100000 } });
    donor.memory.terminalSendJob.a = { targetRoom: 'external', resourceType: 'H', amount: 120000 };
    w.processTerminalResource(donor); w.processTerminalResource(donor);
    assert.deepEqual(w.sends, [{ from: 'donor', resource: 'H', amount: 100000, target: 'external' }]);
    assert.equal(donor.memory.terminalSendJob.a.amount, 20000);
    assert.equal(w.getRoomResourceAmount(donor, 'energy'), 400000);
});

test('a terminal with exactly 50k energy stages fees and waits instead of draining its reserve', () => {
    const w = world(1), donor = w.room('donor', { H: 50000 }, { cooldown: 0, terminal: { energy: 50000, H: 5000 } });
    donor.memory.terminalSendJob.a = { targetRoom: 'external', resourceType: 'H', amount: 5000 };
    w.processTerminalResource(donor); assert.equal(w.sends.length, 0); assert.equal(donor.memory.terminalAmount.energy, 50500);
});

test('energy cargo costs cargo plus fee above the permanent reserve', () => {
    const w = world(1), donor = w.room('donor');
    assert.equal(w.affordableSendAmount(donor, 'energy', 'external', 100000, 61000), 10000);
    assert.equal(w.affordableSendAmount(donor, 'H', 'external', 100000, 61000), 100000);
});

test('all senders share incoming terminal capacity in the same tick', () => {
    const w = world(1), target = w.room('target', {}, { terminal: { energy: 295000 } });
    const a = w.room('a', { wire: 10000 }, { cooldown: 0, terminal: { energy: 51000, wire: 5000 } });
    const b = w.room('b', { wire: 10000 }, { cooldown: 0, terminal: { energy: 51000, wire: 5000 } });
    for (const donor of [a, b]) donor.memory.terminalSendJob.a = { targetRoom: target.name, resourceType: 'wire', amount: 5000 };
    w.processTerminalResource(a); w.processTerminalResource(b);
    assert.equal(w.sends.length, 1); assert.equal(w.sends[0].amount, 5000);
});

test('failed explicit sends back off and release staging priority to another useful job', () => {
    const w = world(1), donor = w.room('donor', { H: 50000, O: 50000 }, { cooldown: 0, terminal: { energy: 60000, H: 5000 } });
    donor.terminal.send = () => -7;
    donor.memory.terminalSendJob = { a: { targetRoom: 'old', resourceType: 'H', amount: 5000 },
        b: { targetRoom: 'external', resourceType: 'O', amount: 4000 } };
    w.processTerminalResource(donor);
    assert.equal(donor.memory.terminalSendJob.a.retryAfter, 31);
    assert.equal(donor.memory.terminalAmount.O, 4000); assert.equal(donor.memory.terminalAmount.H, undefined);
});

test('resource job indexes scan each existing job once, regardless of the number of import requests', () => {
    const w = world(1), resources = Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['r' + i, 1000]));
    const donor = w.room('donor', resources, { warehouse: true }), target = w.room('target');
    let reads = 0;
    for (let i = 0; i < 100; i++) donor.memory.terminalSendJob['old' + i] = {
        targetRoom: 'external', amount: 100, get resourceType() { reads++; return 'oldResource' + i; },
    };
    for (const resource of Object.keys(resources)) w.requestRoomResource(target, resource, 100);
    assert.equal(reads, 100, 'one read per job for the shared incoming/outgoing indexes');
    assert.equal(w.getIncomingResourceAmount(target.name, 'r39'), 100);
});

test('a fulfilled production request never scans donor inventories', () => {
    const w = world(1), target = w.room('target', { XUH2O: 20000 });
    const donor = w.room('warehouse', { XUH2O: 100000 }, { warehouse: true });
    let reads = 0;
    donor.labs = [{ store: new Proxy({}, { get() { reads++; return 0; } }) }];
    for (let i = 0; i < 20; i++) assert.equal(w.requestRoomResource(target, 'XUH2O', 20000), 0);
    assert.equal(reads, 0);
    assert.deepEqual(donor.memory.terminalSendJob, {});
});

test('global balancing reads each room/resource inventory once and preserves ordinary floors', () => {
    const w = world(), required = [...w.t3Resources, ...w.basicMinerals, 'G', 'ops', 'power'];
    const ordinary = Array.from({ length: 8 }, (_, i) => w.room('ordinary' + i,
        Object.fromEntries(required.map(resource => [resource, w.ordinaryResourceTarget(resource)]))));
    const warehouses = Array.from({ length: 3 }, (_, i) => w.room('warehouse' + i,
        i === 0 ? Object.fromEntries(required.map(resource => [resource, 60000])) : {}, { warehouse: true }));
    const reads = new Map();
    for (const room of [...ordinary, ...warehouses]) room.labs = Array.from({ length: 10 }, (_, i) => ({
        store: new Proxy({}, { get(_, resource) {
            const key = room.name + ':' + i + ':' + String(resource);
            reads.set(key, (reads.get(key) || 0) + 1); return 0;
        } }),
    }));
    w.planResourceDistribution();
    assert.equal(Math.max(...reads.values()), 1, 'sorting and queuing must reuse this pass\'s stock snapshot');
    assert.ok(reads.size <= 11 * 10 * (required.length + 1));
    for (const room of ordinary) for (const resource of required)
        assert.equal(w.getIncomingResourceAmount(room.name, resource), 0, room.name + ':' + resource);
    for (const room of warehouses) for (const resource of required)
        assert.equal(w.projectedResource(room, resource), 20000, room.name + ':' + resource);
});

test('the planning snapshot deducts new promises before refilling the next room', () => {
    const w = world(), donor = w.room('warehouse', { XUH2O: 25000 }, { warehouse: true });
    const a = w.room('a'), b = w.room('b');
    w.planResourceDistribution();
    assert.equal(w.getIncomingResourceAmount(a.name, 'XUH2O'), 20000);
    assert.equal(w.getIncomingResourceAmount(b.name, 'XUH2O'), 5000);
    assert.equal(w.getOutgoingResourceAmount(donor.name, 'XUH2O'), 25000);
});

test('the planning snapshot shares headroom across resources and does not persist outside the pass', () => {
    const w = world(), donor = w.room('warehouse', { XUH2O: 10000, XUHO2: 10000 }, { warehouse: true });
    const target = w.room('target');
    target.storage.store = store({}, 1000);
    target.terminal.store = store({ energy: 50000 }, 60000);
    w.planResourceDistribution();
    assert.equal(w.getIncomingResourceAmount(target.name, 'XUH2O'), 1000);
    assert.equal(w.getIncomingResourceAmount(target.name, 'XUHO2'), 0);
    assert.equal(Object.values(donor.memory.terminalSendJob).reduce((total, job) => total + job.amount, 0), 1000);

    for (const id of Object.keys(donor.memory.terminalSendJob)) w.updateResourceJob(donor, id);
    donor.storage.store.XUH2O = 0; donor.terminal.store.XUH2O = 4000;
    w.recordTerminalWithdrawal(donor, 'XUH2O', 1000);
    donor.memory.boostNeed.XUH2O = 4000;
    assert.equal(w.getAvailableResource(donor, 'XUH2O'), 0, 'new boost reservations are read in the same tick');
    donor.memory.boostNeed.XUH2O = 0;
    assert.equal(w.getAvailableResource(donor, 'XUH2O'), 3000, 'new stock and accepted withdrawals are read in the same tick');
    donor.memory.productionReserve = { lab: { XUH2O: 2000 } };
    assert.equal(w.getAvailableResource(donor, 'XUH2O'), 2000);
    w.recordResourceSend(donor, 'external', 'XUH2O', 1000, 100);
    assert.equal(w.getRoomResourceAmount(donor, 'XUH2O'), 3000);
    assert.equal(w.getAvailableResource(donor, 'XUH2O'), 1000);
});

test('full affordable shipments avoid repeated transaction-cost searches during cooldown and dispatch', () => {
    const w = world(1), donor = w.room('donor', { H: 200000 }, { cooldown: 1, terminal: { energy: 60000, H: 100000 } });
    donor.memory.terminalSendJob.a = { targetRoom: 'external', resourceType: 'H', amount: 100000 };
    let queries = 0;
    w.game.market.calcTransactionCost = amount => { queries++; return Math.ceil(amount * 0.1); };
    w.processTerminalResource(donor);
    assert.equal(queries, 2, 'one capacity/fuel check plus the staged fee');
    assert.equal(donor.memory.terminalAmount.H, 100000);
    assert.equal(donor.memory.terminalAmount.energy, 60000);
    donor.terminal.cooldown = 0; queries = 0;
    w.processTerminalResource(donor);
    assert.equal(queries, 5, 'staging and dispatch do not binary-search a full affordable batch');
    assert.deepEqual(w.sends, [{ from: 'donor', resource: 'H', amount: 100000, target: 'external' }]);
    assert.equal(w.getTerminalResourceAmount(donor, 'energy'), 50000);
});

test('partial shipment searches still find the largest integer allowed by fuel and terminal capacity', () => {
    const w = world(1), donor = w.room('donor', { H: 200000 }, { terminalCapacity: 150000 });
    donor.memory.terminalSendJob.a = { targetRoom: 'external', resourceType: 'H', amount: 100000 };
    w.processTerminalResource(donor);
    assert.equal(donor.memory.terminalAmount.H, 81818, '50k energy + 8182 fee + 81818 cargo + 10k headroom');
    assert.equal(donor.memory.terminalAmount.energy, 58182);
    assert.equal(w.affordableSendAmount(donor, 'H', 'external', 100000, 54321), 43210);
    assert.equal(w.affordableSendAmount(donor, 'energy', 'external', 100000, 54321), 3928);
});
