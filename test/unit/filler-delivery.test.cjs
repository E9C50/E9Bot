const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world(level = 6) {
    const objects = new Map(), calls = [], boosts = [];
    class Position {
        constructor(x, y, roomName = 'W1N1') { Object.assign(this, { x, y, roomName }); }
        getRangeTo(value) { const pos = value.pos || value; return pos.roomName === this.roomName ? Math.max(Math.abs(pos.x - this.x), Math.abs(pos.y - this.y)) : Infinity; }
        inRangeTo(value, range) { return this.getRangeTo(value) <= range; }
        isNearTo(value) { return this.inRangeTo(value, 1); }
    }
    const p = (x, y) => new Position(x, y);
    function store(energy, capacity) {
        const result = { energy };
        Object.defineProperties(result, {
            getUsedCapacity: { value: () => result.energy },
            getCapacity: { value: () => capacity },
            getFreeCapacity: { value: () => Math.max(0, capacity - result.energy) },
        });
        return result;
    }
    const game = { time: 100, shard: { name: 'shard3' }, getObjectById: id => objects.get(id) || null };
    const room = { name: 'W1N1', memory: { roomFillJob: {}, creepConfig: {} }, controller: { my: true, level, pos: p(25, 25) },
        sources: [], containers: [], links: [], extensions: [], spawns: [], towers: [], labs: [], units: [], droppedResource: [], energyAvailable: 300,
        enemies: [], find: () => room.units };
    game.rooms = { [room.name]: room }; game.creeps = {};
    function structure(id, type, x, y, energy = 0, capacity = 2000) {
        const value = { id, pos: p(x, y), structureType: type, my: true, store: store(energy, capacity), isActive: () => true };
        objects.set(id, value);
        const group = { container: 'containers', link: 'links', spawn: 'spawns', extension: 'extensions', tower: 'towers', lab: 'labs' }[type];
        if (group) room[group].push(value); else room[type] = value;
        return value;
    }
    function source(id = 'mine', x = 10, y = 10) {
        const value = { id, pos: p(x, y), energy: 3000 }; objects.set(id, value); room.sources.push(value); return value;
    }
    function drop(id, x, y, amount) {
        const value = { id, pos: p(x, y), amount, resourceType: 'energy' }; objects.set(id, value); room.droppedResource.push(value); return value;
    }
    function creep(energy = 0, capacity = 100, x = 20, y = 20) {
        const value = { id: 'carrier', name: 'carrier', room, pos: p(x, y), memory: { role: 'filler' }, store: store(energy, capacity), spawning: false };
        value.moveTo = (target, options) => { calls.push({ method: 'moveTo', target: target.id, range: options?.range }); return 0; };
        for (const method of ['withdraw', 'transfer', 'pickup']) value[method] = (target, resource, amount) => {
            calls.push({ method, target: target.id, resource, amount }); return value.pos.isNearTo(target) ? 0 : -9;
        };
        for (const method of ['takeFromTarget', 'transferToTarget']) value[method] = (target, resource) => {
            calls.push({ method, target: target.id, resource }); return true;
        };
        value.pickupDroppedResource = () => {
            if (!room.droppedResource.length) return false;
            const target = room.droppedResource[0]; calls.push({ method: 'pickupDroppedResource', target: target.id }); return true;
        };
        value.say = () => {};
        room.units.push(value); return value;
    }
    const loader = createSourceLoader({ globals: { Game: game, RoomPosition: Position, RESOURCE_ENERGY: 'energy', OK: 0, ERR_NOT_IN_RANGE: -9,
        FIND_MY_CREEPS: 'my-creeps', STRUCTURE_LINK: 'link', STRUCTURE_CONTAINER: 'container', STRUCTURE_STORAGE: 'storage',
        STRUCTURE_EXTENSION: 'extension', STRUCTURE_SPAWN: 'spawn', STRUCTURE_TOWER: 'tower', STRUCTURE_LAB: 'lab',
        STRUCTURE_NUKER: 'nuker', STRUCTURE_POWER_SPAWN: 'powerSpawn', LAB_BOOST_MINERAL: 30, LAB_BOOST_ENERGY: 20 }, modules: {
        'creep/boosting': { getActiveRoomBoostRequests: () => boosts },
        'runtime/creepIndex': { getRoomProcessors: () => [] },
        'creep/fillerProductionRecovery': { runFillerProductionRecovery: () => false },
        utils: { getDistance: (first, second) => first.getRangeTo(second) },
        'creep/developmentLogistics': { controllerEnergyBuffer: value => value.controller.level < 8 ? value.controllerLink ||
            value.containers.find(container => container.pos.inRangeTo(value.controller.pos, 3)) : undefined },
    } });
    return { game, room, calls, boosts, p, structure, source, drop, creep,
        network: () => loader.load('room/resourceNetwork'),
        behavior: data => loader.load('role/base/RoleBaseFiller').default(data) };
}

for (const level of [6, 8]) test(`RCL${level} distribution uses partial Storage stock before a larger mine batch or drop`, () => {
    const w = world(level), storage = w.structure('stock', 'storage', 30, 30, 40, 100000);
    w.structure('mine-stock', 'container', 20, 20, 2000); w.drop('large-drop', 20, 20, 2000);
    const data = { sourceId: 'mine-stock' }, unit = w.creep();
    w.behavior(data).source(unit);
    assert.equal(w.calls.find(call => ['withdraw', 'takeFromTarget', 'pickup', 'pickupDroppedResource'].includes(call.method)).target, storage.id);
    assert.equal(unit.store.energy, 0, 'native intent must not be assumed to mutate this tick Store');
});

for (const level of [6, 8]) test(`RCL${level} dry Storage recovers from a mine Container without draining the controller Container`, () => {
    const w = world(level); w.structure('stock', 'storage', 30, 30, 0, 100000);
    const buffer = w.structure('controller-buffer', 'container', 25, 28, 2000);
    const mine = w.structure('mine-stock', 'container', 10, 11, 100);
    w.source();
    w.behavior({ sourceId: buffer.id }).source(w.creep());
    assert.equal(w.calls.find(call => ['withdraw', 'takeFromTarget'].includes(call.method)).target, mine.id);
});

test('RCL8 no-stock fallback still collects loose energy and central Link stock', () => {
    const w = world(8), unit = w.creep();
    w.drop('overflow', 20, 20, 40); w.behavior({}).source(unit);
    assert.equal(w.calls[0].method, 'pickupDroppedResource');
    w.calls.length = 0; w.room.droppedResource.length = 0;
    const link = w.structure('central-link', 'link', 19, 20, 800, 800);
    w.behavior({}).source(unit);
    assert.equal(w.calls.find(call => call.method === 'takeFromTarget').target, link.id);
});

for (const level of [6, 8]) test(`RCL${level} ordinary Terminal fallback protects 50000 energy and withdraws only the surplus`, () => {
    const w = world(level), terminal = w.structure('terminal', 'terminal', 20, 20, 8509, 300000);
    const unit = w.creep(0, 1000), data = { sourceId: terminal.id }, behavior = w.behavior(data);
    behavior.source(unit);
    assert.equal(w.calls.some(call => ['withdraw', 'takeFromTarget'].includes(call.method)), false);
    terminal.store.energy = 50040; w.game.time++; w.calls.length = 0;
    behavior.source(unit);
    const withdrawal = w.calls.find(call => call.method === 'withdraw');
    assert.equal(withdrawal.target, terminal.id); assert.equal(withdrawal.amount, 40);
});

for (const level of [6, 8]) test(`RCL${level} simultaneous Terminal withdrawals share the same 50000 reserve`, () => {
    const w = world(level), terminal = w.structure('terminal', 'terminal', 20, 20, 50040, 300000);
    w.behavior({ sourceId: terminal.id }).source(w.creep(0, 1000));
    w.behavior({ sourceId: terminal.id }).source(w.creep(0, 1000));
    const withdrawals = w.calls.filter(call => call.method === 'withdraw');
    assert.equal(withdrawals.length, 1); assert.equal(withdrawals[0].amount, 40);
    w.game.time++; w.calls.length = 0;
    w.behavior({ sourceId: terminal.id }).source(w.creep(0, 1000));
    assert.equal(w.calls.find(call => call.method === 'withdraw').amount, 40, 'the next native snapshot gets a new ledger');
});

for (const level of [6, 8]) for (const intent of ['send', 'deal-fee', 'manager-withdrawal'])
    test(`RCL${level} normal Filler honors an earlier ${intent} Terminal debit in the same tick`, () => {
        const w = world(level), terminal = w.structure('terminal', 'terminal', 20, 20, 50040, 300000), network = w.network();
        if (intent === 'send') network.recordResourceSend(w.room, 'W2N1', 'energy', 20, 1);
        else if (intent === 'deal-fee') network.recordResourceDebit(w.room, 'H', 100, 21);
        else network.recordTerminalWithdrawal(w.room, 'energy', 21);
        assert.equal(network.getTerminalResourceAmount(w.room, 'energy'), 50019);
        w.behavior({ sourceId: terminal.id }).source(w.creep(0, 1000));
        assert.equal(w.calls.find(call => call.method === 'withdraw').amount, 19);
        assert.equal(network.getTerminalResourceAmount(w.room, 'energy'), 50000, 'Filler debits remain visible to later Manager and market decisions');
        assert.equal(terminal.store.energy, 50040, 'native Store still awaits intent settlement');
    });

test('ordinary Filler Terminal withdrawals do not initialize the global resource inventory', () => {
    const w = world(8), terminal = w.structure('terminal', 'terminal', 20, 20, 50040, 300000);
    Object.defineProperty(w.game, 'rooms', { get() { assert.fail('normal Filler must use the lightweight intent ledger'); } });
    w.behavior({ sourceId: terminal.id }).source(w.creep(0, 1000));
    assert.equal(w.calls.find(call => call.method === 'withdraw').amount, 40);
});

test('development sends energy to the controller Container when a controller Link also exists', () => {
    const w = world(), buffer = w.structure('controller-buffer', 'container', 25, 28, 0);
    w.room.controllerLink = w.structure('controller-link', 'link', 24, 25, 0, 800);
    w.behavior({}).target(w.creep(100));
    assert.equal(w.calls.find(call => call.method === 'transfer').target, buffer.id);
    assert.equal(w.calls.some(call => call.target === 'controller-link'), false);
});

function starvedControllerWorld({ energy = 300, stock = 10001, bufferEnergy = 0 } = {}) {
    const w = world(), storage = w.structure('stock', 'storage', 20, 21, stock, 1000000);
    const buffer = w.structure('controller-buffer', 'container', 25, 28, bufferEnergy);
    const spawn = w.structure('spawn', 'spawn', 10, 10, 0, 300), unit = w.creep(800, 850, 20, 20);
    w.room.energyAvailable = energy;
    w.room.energyCapacityAvailable = 1800;
    return { ...w, storage, buffer, spawn, unit, behavior: w.behavior({ sourceId: storage.id }) };
}

test('a dry controller receives one batch after a new birth without repeated production recalls', () => {
    const w = starvedControllerWorld({ energy: 1800 });
    w.spawn.store.energy = 300;
    let received = 0;
    for (let tick = 0; tick < 10; tick++) {
        // The next birth empties the production pool while this carrier is travelling.
        if (tick === 1) { w.room.energyAvailable = 255; w.spawn.store.energy = 0; }
        if (tick === 2) w.room.energyAvailable = 300;
        w.calls.length = 0;
        w.behavior.target(w.unit);
        const transfer = w.calls.find(call => call.method === 'transfer');
        assert.equal(transfer.target, tick === 1 ? w.spawn.id : w.buffer.id, `delivery at tick ${tick}`);
        const moving = w.calls.find(call => call.method === 'moveTo');
        if (moving) {
            const target = moving.target === w.buffer.id ? w.buffer : w.spawn;
            w.unit.pos = w.p(w.unit.pos.x + Math.sign(target.pos.x - w.unit.pos.x),
                w.unit.pos.y + Math.sign(target.pos.y - w.unit.pos.y));
        } else {
            const amount = Math.min(w.unit.store.energy, w.buffer.store.getFreeCapacity());
            w.unit.store.energy -= amount; w.buffer.store.energy += amount; received += amount;
        }
        w.game.time++;
    }
    assert.equal(received, 800, 'the funded controller batch reaches its native Container despite a continuing production deficit');
    assert.equal(w.room.energyAvailable, 300);
    assert.equal(w.spawn.store.energy, 0);
    // A nonempty Container releases the special priority immediately.
    w.unit.store.energy = 100; w.calls.length = 0;
    w.behavior.target(w.unit);
    assert.equal(w.calls.find(call => call.method === 'transfer').target, w.spawn.id);
});

test('controller starvation relief starts exactly at the existing 300 energy production safety floor', () => {
    for (const [energy, target] of [[299, 'spawn'], [300, 'controller-buffer']]) {
        const w = starvedControllerWorld({ energy });
        w.behavior.target(w.unit);
        assert.equal(w.calls.find(call => call.method === 'transfer').target, target);
    }
});

test('controller starvation relief uses only Storage above the existing 10000 recovery reserve', () => {
    for (const [stock, target] of [[0, 'spawn'], [10000, 'spawn'], [10001, 'controller-buffer']]) {
        const w = starvedControllerWorld({ stock });
        w.structure('terminal', 'terminal', 20, 22, 50000, 300000);
        w.behavior.target(w.unit);
        assert.equal(w.calls.find(call => call.method === 'transfer').target, target);
    }
    const w = starvedControllerWorld(); delete w.room.storage;
    w.structure('terminal', 'terminal', 20, 22, 100000, 300000);
    w.behavior.target(w.unit);
    assert.equal(w.calls.find(call => call.method === 'transfer').target, w.spawn.id);
});

test('local hostiles keep production priority while the controller Container is dry', () => {
    const w = starvedControllerWorld(); w.room.enemies.push({});
    w.behavior.target(w.unit);
    assert.equal(w.calls.find(call => call.method === 'transfer').target, w.spawn.id);
});

test('a tower below the existing safety floor precedes dry-controller relief and a safe tower does not', () => {
    for (const [energy, target] of [[499, 'tower'], [500, 'controller-buffer']]) {
        const w = starvedControllerWorld(); w.structure('tower', 'tower', 20, 22, energy, 1000);
        w.behavior.target(w.unit);
        assert.equal(w.calls.find(call => call.method === 'transfer').target, target);
    }
});

test('active boosts still precede dry-controller relief, towers and production', () => {
    const w = starvedControllerWorld(), lab = w.structure('boost-lab', 'lab', 20, 21, 0, 2000);
    w.structure('tower', 'tower', 20, 22, 499, 1000);
    lab.store.GH = 60;
    w.room.memory.roomLabConfig = { singleLabConfig: { [lab.id]: { boostMode: true, resourceType: 'GH' } } };
    w.boosts.push({ resource: 'GH', parts: 2 });
    w.behavior.target(w.unit);
    const transfer = w.calls.find(call => call.method === 'transfer');
    assert.equal(transfer.target, lab.id); assert.equal(transfer.amount, 40);
    assert.equal(w.calls.some(call => call.target === w.buffer.id), false);
});

test('a nonempty controller Container retains production-first priority and the existing refill threshold', () => {
    const w = starvedControllerWorld({ bufferEnergy: 1 });
    w.behavior.target(w.unit);
    assert.equal(w.calls.find(call => call.method === 'transfer').target, w.spawn.id);
    w.spawn.store.energy = 300;
    for (const [energy, target] of [[1499, w.buffer.id], [1500, undefined]]) {
        w.buffer.store.energy = energy; w.calls.length = 0; w.game.time++;
        w.behavior.target(w.unit);
        assert.equal(w.calls.find(call => call.method === 'transfer')?.target, target);
    }
});

test('dry-controller relief uses existing structure lists without native room searches', () => {
    const w = starvedControllerWorld();
    w.room.find = () => { throw new Error('a known controller Container must not trigger another native room search'); };
    w.behavior.target(w.unit);
    assert.equal(w.calls.find(call => call.method === 'transfer').target, w.buffer.id);
});

test('a Link-only controller does not block direct delivery to a hungry upgrader', () => {
    const w = world(); w.room.controllerLink = w.structure('controller-link', 'link', 24, 25, 0, 800);
    const upgrader = w.creep(0, 100, 24, 26); upgrader.id = 'upgrader'; upgrader.name = 'upgrader'; upgrader.memory.role = 'upgrader';
    w.behavior({}).target(w.creep(100));
    assert.equal(w.calls.find(call => call.method === 'transfer').target, upgrader.id);
});

for (const level of [6, 8]) test(`RCL${level} discards stale Link fill jobs and chooses the real Lab`, () => {
    const w = world(level), link = w.structure('link', 'link', 20, 20, 0, 800), lab = w.structure('lab', 'lab', 21, 20, 0);
    w.room.memory.roomFillJob.labInEnergy = [link.id, lab.id];
    w.behavior({}).target(w.creep(100));
    assert.equal(w.calls.find(call => ['transfer', 'transferToTarget'].includes(call.method)).target, lab.id);
    assert.equal(w.room.memory.roomFillJob.labInEnergy.includes(link.id), false);
});

test('RCL8 cached production target cannot make the filler send energy to a Link', () => {
    const w = world(8), link = w.structure('link', 'link', 20, 20, 0, 800), spawn = w.structure('spawn', 'spawn', 21, 20, 0, 300);
    w.room.memory.roomFillJob.extension = true;
    w.behavior({ targetId: link.id }).target(w.creep(100));
    assert.equal(w.calls.find(call => call.method === 'transferToTarget').target, spawn.id);
});

test('development mine lane collects its own mine and returns to Storage instead of the controller', () => {
    const w = world(), mine = w.source(), stock = w.structure('mine-stock', 'container', 10, 11, 2000);
    const storage = w.structure('stock', 'storage', 30, 30, 100000, 1000000);
    const buffer = w.structure('controller-buffer', 'container', 25, 28, 0), data = { sourceId: stock.id, mineId: mine.id }, unit = w.creep(0, 100, 11, 11);
    const behavior = w.behavior(data); behavior.source(unit);
    assert.equal(w.calls.find(call => call.method === 'withdraw').target, stock.id);
    unit.store.energy = 100; w.calls.length = 0; w.game.time++;
    behavior.target(unit);
    assert.equal(w.calls.find(call => call.method === 'transfer' || call.method === 'moveTo').target, storage.id);
    assert.equal(w.calls.some(call => call.target === buffer.id), false);
    assert.equal(data.mineId, mine.id);
});

test('a surviving RCL8 mine carrier keeps its collection lane while Storage distributors use stock', () => {
    const w = world(8), mine = w.source(), stock = w.structure('mine-stock', 'container', 10, 11, 2000);
    const storage = w.structure('stock', 'storage', 30, 30, 100000, 1000000);
    const data = { sourceId: stock.id, mineId: mine.id }, unit = w.creep(), behavior = w.behavior(data);
    behavior.source(unit); assert.equal(w.calls.find(call => call.method === 'takeFromTarget').target, stock.id);
    w.calls.length = 0; unit.store.energy = 100; behavior.target(unit);
    assert.equal(w.calls.find(call => call.method === 'transfer' || call.method === 'moveTo').target, storage.id);
});

test('local stock distribution releases a traffic lock set by the movement wrapper', () => {
    for (const phase of ['source', 'target']) {
        const w = world(), storage = w.structure('stock', 'storage', 20, 21, 100000, 1000000);
        const spawn = w.structure('spawn', 'spawn', 30, 30, 0, 300), unit = w.creep(100), originalMove = unit.moveTo;
        unit.moveTo = function (...args) { originalMove.apply(this, args); this.memory.dontPullMe = true; return 0; };
        w.behavior({ sourceId: storage.id })[phase](unit);
        assert.equal(w.calls.find(call => call.method === 'transfer').target, spawn.id);
        assert.equal(w.calls.find(call => call.method === 'moveTo').target, spawn.id);
        assert.equal(unit.memory.dontPullMe, false);
    }
});

test('a loaded local filler with no task releases its old traffic lock while idling', () => {
    for (const level of [6, 8]) {
        const w = world(level), unit = w.creep(100); unit.memory.dontPullMe = true;
        w.behavior({}).target(unit);
        assert.equal(unit.memory.dontPullMe, false);
        assert.equal(w.calls.some(call => ['transfer', 'transferToTarget', 'moveTo'].includes(call.method)), false);
        assert.equal(unit.store.energy, 100);
    }
});
