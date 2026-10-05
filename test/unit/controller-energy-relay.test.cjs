const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world() {
    const calls = [], intents = new Map(), walls = new Set(), units = [], objects = new Map(), spentByName = new Map(), builtByName = new Map();
    const counters = { terrain: 0, find: {}, look: 0, work: 0 };
    const game = { time: 100, shard: { name: 'shard1' }, creeps: {}, rooms: {}, flags: {}, getObjectById: id => objects.get(id) || null };
    const range = (a, b) => { a = a.pos || a; b = b.pos || b; return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); };
    class RoomPosition {
        constructor(x, y, roomName = 'E39N5') { Object.assign(this, { x, y, roomName }); }
        getRangeTo(target) { return range(this, target); }
        isNearTo(target) { return range(this, target) <= 1; }
        isEqualTo(target) { return range(this, target) === 0; }
    }
    const p = (x, y) => new RoomPosition(x, y);
    const room = { name: 'E39N5', memory: { creepConfig: {} }, sources: [], links: [], containers: [], structures: [], constructionSites: [],
        getTerrain: () => ({ get(x, y) { counters.terrain++; return walls.has(`${x}/${y}`) ? 1 : 0; } }),
        find(type) { counters.find[type] = (counters.find[type] || 0) + 1; return type === 'power' ? [] : type === 'structures' ? room.structures : type === 'my' ? units.filter(unit => unit.my) : units; },
        lookForAt(type, x, y) { counters.look++; return (type === 'structures' ? room.structures : type === 'power' ? [] : units).filter(item => item.pos.x === x && item.pos.y === y); } };
    room.controller = { id: 'controller', my: true, level: 3, pos: p(25, 25), ticksToDowngrade: 10000 };
    game.rooms[room.name] = room; objects.set('controller', room.controller);
    function store(energy, capacity) {
        return { energy, getUsedCapacity: () => energy, getCapacity: () => capacity, getFreeCapacity() { return Math.max(0, capacity - this.energy); } };
    }
    const buffer = { id: 'buffer', pos: p(22, 25), structureType: 'container', store: store(2000, 2000) };
    room.containers.push(buffer); room.structures.push(buffer); objects.set(buffer.id, buffer);
    const loader = createSourceLoader({ globals: { Game: game, RoomPosition, RESOURCE_ENERGY: 'energy', WORK: 'work', BUILD_POWER: 5,
        TERRAIN_MASK_WALL: 1, LOOK_STRUCTURES: 'structures', LOOK_CREEPS: 'creeps', LOOK_POWER_CREEPS: 'power',
        FIND_CREEPS: 'creeps', FIND_POWER_CREEPS: 'power', FIND_MY_CREEPS: 'my', FIND_STRUCTURES: 'structures',
        STRUCTURE_ROAD: 'road', STRUCTURE_CONTAINER: 'container', STRUCTURE_LINK: 'link', STRUCTURE_RAMPART: 'rampart', OK: 0, ERR_NOT_IN_RANGE: -9 },
        modules: { utils: { getDistance: range, getClosestTarget: (pos, list) => [...list].sort((a, b) => range(pos, a) - range(pos, b))[0] },
            'settings/rolePolicy': { rolePolicy: { remoteBuilder: { stopUpgradingAtLevel: 8 } } },
            'settings/interShard': { interShardPolicy: { downgradeWarningTicks: 100 } } } });
    function creep(name, x, y, energy = 20, work = 2, capacity = 100, role = 'upgrader') {
        const unit = { name, id: name, my: true, spawning: false, room, pos: p(x, y), store: store(energy, capacity), fatigue: 0,
            memory: { role, working: energy > 0, data: role === 'sBuilder' ? { unitKind: 'builder', phase: 'work', task: { targetRoom: room.name, targetShard: game.shard.name, targetLevel: 4 } } : {} },
            getActiveBodyparts() { counters.work++; return work; },
            moveTo(target, options) { calls.push({ type: 'move', name, target, options }); return 0; },
            upgradeController() { assert.ok(unit.store.energy > 0, 'no upgrade based on hypothetical incoming energy');
                assert.equal(intents.get(name)?.build, undefined, 'upgrade must not overwrite a build WORK intent');
                calls.push({ type: 'upgrade', name }); intents.set(name, { ...intents.get(name), upgrade: work }); return 0; },
            harvest() { assert.equal(intents.get(name)?.build, undefined, 'harvest must not overwrite a build WORK intent');
                calls.push({ type: 'harvest', name }); return 0; },
            build(target) { assert.ok(unit.store.energy > 0, 'no build based on hypothetical incoming energy'); assert.ok(range(unit, target) <= 3);
                assert.equal(intents.get(name)?.upgrade, undefined, 'build must not compete with an upgrade WORK intent');
                calls.push({ type: 'build', name, target: target.id }); intents.set(name, { ...intents.get(name), build: { target, amount: work * 5 } }); return 0; },
            transfer(target, resource, amount) { assert.ok(range(unit, target) <= 1); assert.ok(amount > 0 && amount <= unit.store.energy && amount <= target.store.getFreeCapacity());
                calls.push({ type: 'transfer', name, target: target.name, amount }); intents.set(name, { ...intents.get(name), transfer: { target, amount } }); return 0; },
            withdraw(target, resource, amount = unit.store.getFreeCapacity()) { assert.ok(amount > 0 && amount <= unit.store.getFreeCapacity() && amount <= target.store.energy);
                calls.push({ type: 'withdraw', name, target: target.id, amount }); intents.set(name, { ...intents.get(name), withdraw: { target, amount } }); return 0; },
        };
        units.push(unit); game.creeps[name] = unit; objects.set(name, unit); return unit;
    }
    let spent = 0;
    function nextTick(reverse = false) {
        for (const unit of reverse ? [...units].reverse() : units) {
            const intent = intents.get(unit.name);
            if (!intent) continue;
            if (intent.transfer) { const amount = Math.min(intent.transfer.amount, unit.store.energy, intent.transfer.target.store.getFreeCapacity()); unit.store.energy -= amount; intent.transfer.target.store.energy += amount; }
            if (intent.withdraw) { const amount = Math.min(intent.withdraw.amount, unit.store.getFreeCapacity(), intent.withdraw.target.store.energy); unit.store.energy += amount; intent.withdraw.target.store.energy -= amount; }
            if (intent.upgrade) { const amount = Math.min(unit.store.energy, intent.upgrade); unit.store.energy -= amount; spent += amount; spentByName.set(unit.name, (spentByName.get(unit.name) || 0) + amount); }
            if (intent.build) { const amount = Math.min(unit.store.energy, intent.build.amount, intent.build.target.progressTotal - intent.build.target.progress);
                unit.store.energy -= amount; intent.build.target.progress += amount; builtByName.set(unit.name, (builtByName.get(unit.name) || 0) + amount); }
        }
        intents.clear(); game.time++;
    }
    function link(x, y, energy = 0, id = 'controller-link') {
        const item = { id, pos: p(x, y), structureType: 'link', my: true, isActive: () => true, store: store(energy, 800) };
        room.links.push(item); room.structures.push(item); objects.set(id, item); return item;
    }
    function containerSite(x, y, id = 'controller-container-site') {
        const item = { id, pos: p(x, y), structureType: 'container', my: true, progress: 0, progressTotal: 5000 };
        room.constructionSites.push(item); objects.set(id, item); return item;
    }
    return { game, room, buffer, calls, counters, units, walls, p, creep, link, containerSite, nextTick, spentByName, builtByName, spent: () => spent,
        logistics: loader.load('creep/developmentLogistics'), relay: loader.load('creep/controllerEnergyRelay'),
        role: loader.load('role/base/RoleBaseUpgrader').default, aid: loader.load('role/support/builderWorkPosition') };
}

test('controller geometry exposes the whole connected 7x7, keeps distant occupied seats, and prefers buffer-side inner seats for new arrivals', () => {
    const w = world(), far = w.creep('far', 28, 28), arriving = w.creep('arriving', 15, 25);
    assert.equal(w.logistics.controllerUpgradeSeatCount(w.room, w.buffer), 48);
    assert.equal(w.logistics.controllerUpgradePosition(far, w.buffer).isEqualTo(far), true);
    assert.equal(far.memory.dontPullMe, true);
    const selected = w.logistics.controllerUpgradePosition(arriving, w.buffer);
    assert.equal(selected.x, 23, 'inner adjacent buffer seats precede the outer/container face');
    assert.equal(arriving.memory.dontPullMe, false);
    assert.equal(w.logistics.controllerUpgradeSeatCount(w.room, w.buffer), 48, 'occupancy never reduces static capacity');
});

test('a Link/filler-only buffer lookup checks one neighboring seat without building the full controller geometry or scanning units', () => {
    const w = world();
    Object.defineProperty(w.room, 'structures', { get() { throw Error('buffer lookup must not read the entire structure index'); } });
    w.room.lookForAt = () => { w.counters.look++; return []; };
    assert.equal(w.logistics.controllerEnergyBuffer(w.room), w.buffer);
    assert.equal(w.counters.terrain, 1);
    assert.equal(w.counters.look, 1);
    assert.deepEqual(w.counters.find, {});
    for (let index = 0; index < 10; index++) assert.equal(w.logistics.controllerEnergyBuffer(w.room), w.buffer);
    assert.equal(w.counters.terrain, 1, 'same-tick callers share the selected buffer');
});

test('isolated geometry is not published as buffer capacity but an already productive isolated seat is preserved', () => {
    const w = world();
    for (let y = 22; y <= 28; y++) w.walls.add(`24/${y}`);
    assert.equal(w.logistics.controllerUpgradeSeatCount(w.room, w.buffer), 14);
    const unit = w.creep('isolated', 28, 25);
    assert.equal(w.logistics.controllerUpgradePosition(unit, w.buffer).isEqualTo(unit), true);
});

test('three actual controller workers relay initial cargo along adjacency while roots withdraw and all supplied workers upgrade without moving', () => {
    const w = world(), root = w.creep('root', 23, 25, 20), middle = w.creep('middle', 24, 24, 0), far = w.creep('far', 25, 23, 0, 2, 100, 'sBuilder');
    const original = w.units.map(unit => `${unit.pos.x}/${unit.pos.y}`);
    const total = w.buffer.store.energy + w.units.reduce((sum, unit) => sum + unit.store.energy, 0);
    let triple = 0;
    for (let tick = 0; tick < 80; tick++) {
        w.calls.length = 0;
        for (const unit of tick % 2 ? [far, middle, root] : [root, middle, far]) {
            if (unit.memory.role === 'sBuilder') assert.equal(w.aid.upgradeBuilderAtStablePosition(unit, w.room.controller), true);
            else w.role({ sourceId: w.buffer.id }).target(unit);
        }
        if (w.calls.some(call => call.name === root.name && call.type === 'transfer') && w.calls.some(call => call.name === root.name && call.type === 'withdraw') && w.calls.some(call => call.name === root.name && call.type === 'upgrade')) triple++;
        assert.equal(w.calls.some(call => call.type === 'move'), false);
        assert.equal(new Set(w.calls.filter(call => call.type === 'transfer').map(call => call.name)).size, w.calls.filter(call => call.type === 'transfer').length, 'a donor has only one transfer intent');
        w.nextTick(tick % 2 !== 0);
    }
    assert.ok(triple > 0, 'the supply root can transfer, withdraw and upgrade independently in the same tick');
    assert.ok(w.spent() >= 450, `the two-hop outer aid worker must actually consume relayed energy: spent=${w.spent()}`);
    assert.deepEqual(w.units.map(unit => `${unit.pos.x}/${unit.pos.y}`), original);
    assert.equal(w.buffer.store.energy + w.units.reduce((sum, unit) => sum + unit.store.energy, 0) + w.spent(), total);
});

test('an empty bridge never forwards its planned refill; native incoming capacity and donor own WORK are reserved', () => {
    const w = world(), root = w.creep('root', 23, 25, 10, 2), middle = w.creep('middle', 24, 24, 0), far = w.creep('far', 25, 23, 0);
    w.relay.runControllerEnergyRelay(far, w.buffer);
    assert.equal(w.calls.some(call => call.name === middle.name && call.type === 'transfer'), false);
    const transfer = w.calls.find(call => call.name === root.name && call.type === 'transfer');
    assert.equal(transfer.amount, 8, 'donor keeps its actual two-WORK upgrade energy');
    assert.equal(root.store.energy, 10); assert.equal(middle.store.energy, 0); assert.equal(far.store.energy, 0);
    for (const unit of w.units) w.relay.runControllerEnergyRelay(unit, w.buffer);
    assert.equal(w.calls.filter(call => call.type === 'transfer').length, 1, 'repeat role calls do not overwrite intents');
    w.nextTick(); assert.equal(far.store.energy, 0, 'second hop cannot consume hypothetical first-hop arrival');
});

test('the reported four-worker Container/empty-Link layout sustains all 22 WORK through real role intents and initial one-CARRY stores', () => {
    const w = world(); w.buffer.pos = w.p(25, 28); w.buffer.store.energy = 1554;
    const link = w.link(23, 25); w.room.controllerLink = link;
    const a = w.creep('A', 22, 26, 0, 6, 50), b = w.creep('B', 23, 26, 11, 3, 50),
        c = w.creep('C', 24, 27, 44, 6, 50), d = w.creep('D', 24, 25, 0, 7, 50);
    const initial = w.buffer.store.energy + 55;
    let warmSpent = 0;
    for (let tick = 0; tick < 50; tick++) {
        w.calls.length = 0;
        // An aid worker may initialize the room cache with the Link before the
        // upgrader chooses Container stock. The cached graph must retain both.
        const cached = w.relay.prepareControllerEnergyRelay(w.room, link);
        assert.equal(w.relay.prepareControllerEnergyRelay(w.room, w.buffer), cached);
        assert.equal(cached.nodes.get(c.name).buffer, w.buffer);
        for (const unit of tick % 2 ? [d, c, b, a] : [a, b, c, d]) w.role({ sourceId: link.id }).target(unit);
        assert.equal(w.calls.some(call => call.type === 'move'), false, 'the existing supply chain stays in place');
        const transfers = w.calls.filter(call => call.type === 'transfer');
        assert.equal(new Set(transfers.map(call => call.name)).size, transfers.length, 'one transfer intent per actual donor');
        for (const unit of w.units) {
            const incoming = transfers.filter(call => call.target === unit.name).reduce((sum, call) => sum + call.amount, 0);
            const withdrawn = w.calls.filter(call => call.type === 'withdraw' && call.name === unit.name).reduce((sum, call) => sum + call.amount, 0);
            assert.ok(incoming + withdrawn <= unit.store.getFreeCapacity(), 'passive receipt and own withdraw share native free capacity');
            const sent = transfers.find(call => call.name === unit.name)?.amount || 0;
            assert.ok(sent <= Math.max(0, unit.store.energy - unit.getActiveBodyparts()), 'a donor reserves its own native WORK consumption');
        }
        w.nextTick(tick % 2 !== 0);
        if (tick === 9) warmSpent = w.spent();
        assert.equal(w.buffer.store.energy + link.store.energy + w.units.reduce((sum, unit) => sum + unit.store.energy, 0) + w.spent(), initial);
    }
    assert.ok(w.spentByName.get(a.name) >= 250, `A must upgrade through the real B bridge: ${w.spentByName.get(a.name)}`);
    assert.ok(w.spentByName.get(d.name) >= 290, `D must upgrade through the real B bridge: ${w.spentByName.get(d.name)}`);
    assert.equal(w.spent() - warmSpent, 40 * 22, 'after native initial-cargo warmup every real WORK part upgrades every tick');
    assert.ok(w.buffer.store.energy < 600, 'the stocked Container supplies the empty-Link component');
    assert.equal(link.store.energy, 0, 'no hypothetical Link pulse is needed');
});

test('shared buffer withdrawals and multiple donors cannot overbook one initial native Store batch', () => {
    const w = world(); w.buffer.store.energy = 10;
    w.creep('root-a', 23, 24, 0); w.creep('root-b', 23, 25, 0);
    const target = w.creep('target', 24, 25, 99, 2, 100);
    w.relay.runControllerEnergyRelay(target, w.buffer);
    assert.equal(w.calls.filter(call => call.type === 'withdraw').reduce((sum, call) => sum + call.amount, 0), 10);
    assert.ok(w.calls.filter(call => call.type === 'transfer').every(call => call.name === target.name),
        'empty roots cannot lend a planned withdrawal; the already-loaded neighbor may donate its real cargo back to them');
    w.nextTick(); w.calls.length = 0;
    w.units[0].store.energy = 100; w.units[1].store.energy = 100; target.store.energy = 0;
    w.relay.runControllerEnergyRelay(target, w.buffer);
    assert.equal(w.calls.filter(call => call.type === 'transfer').reduce((sum, call) => sum + call.amount, 0), 6, 'recipient demand and its current WORK reserve are not promised independently to each donor');
});

test('stocked Container selection is independent of the first cached preferred Link and depleted shared stock falls through to another adjacent store', () => {
    const w = world(), link = w.link(22, 26, 100);
    w.buffer.store.energy = 6; w.room.controllerLink = link;
    const a = w.creep('root-a', 23, 25, 0), b = w.creep('root-b', 23, 26, 0);
    const cached = w.relay.prepareControllerEnergyRelay(w.room, link);
    assert.equal(cached.nodes.get(a.name).buffer, w.buffer);
    assert.equal(w.relay.prepareControllerEnergyRelay(w.room, w.buffer), cached);
    w.relay.runControllerEnergyRelay(a, link);
    assert.deepEqual(w.calls.filter(call => call.type === 'withdraw').map(call => [call.name, call.target, call.amount]),
        [[a.name, w.buffer.id, 6], [b.name, link.id, 100]]);
    assert.equal(w.calls.some(call => call.type === 'transfer'), false, 'initially empty roots never lend their planned refill');
    assert.equal(w.counters.find.my, 1, 'alternate buffer calls share one worker graph');
    w.nextTick(); assert.equal(a.store.energy, 6); assert.equal(b.store.energy, 100);
});

test('adjacent buffer roots and sibling roots share real cargo while each retains its own WORK and native capacity', () => {
    const w = world(), a = w.creep('root-a', 23, 24, 0), b = w.creep('root-b', 23, 25, 20);
    const cached = w.relay.prepareControllerEnergyRelay(w.room, w.buffer);
    assert.equal(cached.nodes.get(a.name).depth, 0); assert.equal(cached.nodes.get(b.name).depth, 0);
    w.relay.runControllerEnergyRelay(a, w.buffer);
    const transfer = w.calls.find(call => call.type === 'transfer');
    assert.deepEqual([transfer.name, transfer.target, transfer.amount], [b.name, a.name, 6]);
    const refill = w.calls.find(call => call.type === 'withdraw' && call.name === a.name);
    assert.equal(refill.amount + transfer.amount, a.store.getFreeCapacity(), 'withdraw cannot reuse future WORK or outgoing capacity');
    w.nextTick(); assert.equal(a.store.energy, 100); assert.equal(b.store.energy, 94);
});

test('scarce shared buffer stock covers multiple native root demands before the first root fills spare CARRY', () => {
    const w = world(); w.buffer.store.energy = 10;
    const a = w.creep('root-a', 23, 24, 0), b = w.creep('root-b', 23, 25, 0);
    w.relay.runControllerEnergyRelay(a, w.buffer);
    assert.deepEqual(w.calls.filter(call => call.type === 'withdraw').map(call => [call.name, call.amount]), [[a.name, 6], [b.name, 4]]);
    w.nextTick(); assert.equal(a.store.energy + b.store.energy + w.buffer.store.energy, 10);
});

test('a no-CARRY worker cannot create a stocked root or physical bridge, and a loaded worker reserving all cargo for WORK does not promise supply to neighbors', () => {
    const w = world(), root = w.creep('root-without-carry', 23, 25, 0, 2, 0), bridge = w.creep('bridge-without-carry', 24, 24, 0, 2, 0),
        far = w.creep('far', 25, 23, 0);
    const cached = w.relay.prepareControllerEnergyRelay(w.room, w.buffer);
    assert.equal(cached.nodes.has(root.name), false); assert.equal(cached.nodes.has(bridge.name), false);
    assert.equal(w.relay.runControllerEnergyRelay(far, w.buffer), false);
    assert.deepEqual(w.calls, []);
    w.nextTick(); w.buffer.store.energy = 0;
    const loaded = w.creep('own-work-only', 24, 24, 2);
    assert.equal(w.relay.controllerEnergyRelayCanSupply(far, w.buffer), false);
    assert.equal(w.relay.runControllerEnergyRelay(loaded, w.buffer), false);
    assert.equal(w.calls.some(call => call.type === 'transfer'), false);
    w.nextTick(); loaded.store.energy = 10;
    assert.equal(w.relay.runControllerEnergyRelay(far, w.buffer), true, 'existing surplus is a real component supplier even without buffer stock');
    assert.deepEqual(w.calls.filter(call => call.type === 'transfer').map(call => [call.name, call.target, call.amount]), [[loaded.name, far.name, 6]]);
});

test('external carry reservations remain separate from WORK and repeated room execution never overwrites an intent', () => {
    const w = world(), root = w.creep('root', 23, 25, 20), receiver = w.creep('receiver', 24, 24, 0);
    assert.equal(w.relay.reserveControllerCarryIntent(root, 'transfer'), true);
    assert.equal(w.relay.reserveControllerCarryIntent(root, 'transfer'), false);
    w.relay.runControllerEnergyRelay(receiver, w.buffer);
    assert.equal(w.calls.some(call => call.name === root.name && call.type === 'transfer'), false);
    assert.equal(w.calls.some(call => call.name === root.name && call.type === 'withdraw'), true, 'reserving transfer does not forbid a separate native withdraw');
    const count = w.calls.length;
    w.relay.runControllerEnergyRelay(root, w.buffer); assert.equal(w.calls.length, count);
});

test('a mineral-only buffer without an energy key creates neither a NaN withdrawal nor fictional connected supply', () => {
    const w = world(), root = w.creep('root', 23, 25, 0), receiver = w.creep('receiver', 24, 24, 0);
    w.buffer.store = { H: 1000 };
    assert.equal(w.relay.runControllerEnergyRelay(root, w.buffer), false);
    assert.equal(w.relay.controllerEnergyRelayCanSupply(receiver, w.buffer), false);
    assert.deepEqual(w.calls, []);
    w.nextTick(); root.store.energy = 20;
    assert.equal(w.relay.runControllerEnergyRelay(receiver, w.buffer), true, 'real carried surplus can still supply a neighbor');
    assert.equal(w.calls.some(call => call.type === 'withdraw'), false, 'existing cargo does not make a mineral-only buffer withdrawable');
    assert.ok(w.calls.every(call => Number.isFinite(call.amount)), 'all planned carry quantities are finite');
});

test('a four-WORK upgrader preserves its real 20-energy build batch while construction and native withdraw coexist', () => {
    const w = world(), site = w.containerSite(25, 27), root = w.creep('root', 23, 25, 20, 4, 50), outer = w.creep('outer', 24, 24, 0, 2, 50);
    const initial = w.buffer.store.energy + root.store.energy;
    const cached = w.relay.prepareControllerEnergyRelay(w.room, w.buffer);
    assert.equal(cached.nodes.get(root.name).work, 4, 'public WORK remains actual active body parts');
    assert.equal(cached.nodes.get(root.name).energyDemand, 20, 'native construction reserves BUILD_POWER energy per WORK');
    for (const unit of [outer, root]) w.role({ sourceId: w.buffer.id }).target(unit);
    assert.equal(w.calls.some(call => call.name === root.name && call.type === 'transfer'), false, 'the actual construction batch cannot be lent to another worker');
    assert.deepEqual(w.calls.filter(call => call.name === root.name).map(call => call.type).sort(), ['build', 'withdraw']);
    assert.equal(w.calls.some(call => call.type === 'upgrade' || call.type === 'harvest'), false, 'the builder has one construction WORK intent and empty receivers use no hypothetical cargo');
    assert.equal(w.calls.find(call => call.name === root.name && call.type === 'withdraw').amount, 30, 'only initial native free capacity is available');
    w.nextTick();
    assert.equal(w.builtByName.get(root.name), 20); assert.equal(site.progress, 20);
    assert.equal(w.spent(), 0);
    assert.equal(w.buffer.store.energy + w.units.reduce((sum, unit) => sum + unit.store.energy, 0) + site.progress, initial);
});

test('a construction donor may lend only surplus above BUILD_POWER while an empty neighbor waits for native next-tick cargo', () => {
    const w = world(), site = w.containerSite(25, 27), root = w.creep('root', 23, 25, 40, 4, 50), outer = w.creep('outer', 24, 24, 0, 2, 50);
    for (const unit of [root, outer]) w.role({ sourceId: w.buffer.id }).target(unit);
    const transfer = w.calls.find(call => call.name === root.name && call.type === 'transfer');
    assert.equal(transfer.target, outer.name); assert.equal(transfer.amount, 20);
    assert.equal(w.calls.some(call => call.name === outer.name && call.type === 'build'), false);
    w.nextTick(); assert.equal(w.builtByName.get(root.name), 20); assert.equal(outer.store.energy, 20);
    w.calls.length = 0; w.role({ sourceId: w.buffer.id }).target(outer);
    assert.equal(w.calls.some(call => call.name === outer.name && call.type === 'build'), true);
    assert.equal(w.calls.some(call => call.name === outer.name && call.type === 'upgrade'), false);
    w.nextTick(); assert.equal(w.builtByName.get(outer.name), 10); assert.ok(site.progress >= 30);
});

test('only a real reachable controller Container build changes energy demand, and completed sites restore normal upgrade reserves next tick', () => {
    const w = world(), root = w.creep('root', 23, 25, 20, 4, 50);
    const site = w.containerSite(28, 28);
    assert.equal(w.relay.prepareControllerEnergyRelay(w.room, w.buffer).nodes.get(root.name).energyDemand, 4, 'a far site cannot consume this tick native WORK');
    site.pos = w.p(25, 27); w.nextTick();
    assert.equal(w.relay.prepareControllerEnergyRelay(w.room, w.buffer).nodes.get(root.name).energyDemand, 20);
    w.room.constructionSites.length = 0; w.nextTick();
    const cached = w.relay.prepareControllerEnergyRelay(w.room, w.buffer);
    assert.equal(cached.nodes.get(root.name).energyDemand, 4);
    assert.equal(cached.nodes.get(root.name).downstreamEnergy, 4);
    w.role({ sourceId: w.buffer.id }).target(root);
    assert.equal(w.calls.some(call => call.type === 'upgrade'), true);
    assert.equal(w.calls.some(call => call.type === 'build'), false);
});

test('geometry/native occupant and relay indexes are shared by all workers and only static changes rebuild terrain geometry', () => {
    const w = world();
    for (let index = 0; index < 8; index++) w.creep(`upgrader-${index}`, 23 + index % 3, 22 + Math.floor(index / 3), 20);
    for (let tick = 0; tick < 4; tick++) {
        for (const unit of w.units) { w.logistics.controllerUpgradePosition(unit, w.buffer); w.relay.runControllerEnergyRelay(unit, w.buffer); }
        w.nextTick();
    }
    assert.equal(w.counters.terrain, 48, 'controller tile is excluded before the cached static terrain lookup');
    assert.deepEqual(w.counters.find, { creeps: 4, power: 4, my: 4 });
    assert.equal(w.counters.look, 0, 'neither per-worker structure nor occupied-tile native lookups');
    w.room.structures.push({ id: 'new-spawn', structureType: 'spawn', pos: w.p(28, 28) });
    assert.equal(w.logistics.controllerUpgradeSeatCount(w.room, w.buffer), 47);
    assert.ok(w.counters.terrain > 48, 'a completed building invalidates geometry at the next tick');
    w.game.shard.name = 'shard2'; const before = w.counters.terrain;
    assert.equal(w.logistics.controllerUpgradeSeatCount(w.room, w.buffer), 47); assert.ok(w.counters.terrain > before);
    w.game.time = 1; const beforeRollback = w.counters.terrain;
    w.logistics.controllerUpgradeSeatCount(w.room, w.buffer); assert.ok(w.counters.terrain > beforeRollback);
});

test('no actual neighboring work bridge means no relay; builders constructing and immature boosted workers are excluded', () => {
    const w = world(), root = w.creep('root', 23, 25), far = w.creep('far', 25, 23, 0);
    assert.equal(w.relay.runControllerEnergyRelay(far, w.buffer), false);
    assert.equal(w.calls.some(call => call.type === 'transfer'), false);
    w.nextTick(); const bridge = w.creep('bridge', 24, 24, 30, 2, 100, 'sBuilder');
    bridge.memory.boostPlan = { tier: 3, steps: [], completed: false };
    assert.equal(w.relay.runControllerEnergyRelay(far, w.buffer), false);
    w.nextTick(); bridge.memory.boostPlan.completed = true;
    assert.equal(w.relay.runControllerEnergyRelay(far, w.buffer), true, 'a real finished worker connects the supply chain');
    w.nextTick(); w.calls.length = 0; w.room.constructionSites.push({ id: 'site' });
    w.relay.runControllerEnergyRelay(root, w.buffer);
    assert.equal(w.calls.some(call => call.target === bridge.name), false);
});

test('a failed boost plan remains a working supply node instead of starving beside a full controller buffer', () => {
    const w = world(), root = w.creep('root', 23, 25, 0), receiver = w.creep('receiver', 24, 24, 0);
    root.memory.boostPlan = { tier: 3, steps: [], failed: true };
    w.role({ sourceId: w.buffer.id }).source(root);
    assert.ok(w.calls.some(call => call.name === root.name && call.type === 'withdraw'));
    assert.equal(w.calls.some(call => call.type === 'upgrade'), false);
    w.nextTick(); w.calls.length = 0;
    w.role({ sourceId: w.buffer.id }).target(root);
    assert.ok(w.calls.some(call => call.name === root.name && call.type === 'upgrade'));
    assert.ok(w.calls.some(call => call.name === root.name && call.type === 'transfer' && call.target === receiver.name));
});

test('passing remote builders and completed or wrong-shard mission builders never become supply bridges', () => {
    for (const kind of ['rBuilder-other-room', 'rBuilder-missing-target', 'rBuilder-portal', 'sBuilder-done', 'sBuilder-other-shard']) {
        const w = world(), root = w.creep('root', 23, 25), outer = w.creep('outer', 25, 23, 0);
        const bridge = w.creep('bridge', 24, 24, 50, 2, 100, kind.startsWith('rBuilder') ? 'rBuilder' : 'sBuilder');
        if (kind === 'rBuilder-other-room') { bridge.memory.data.targetFlag = 'remote'; w.game.flags.remote = { pos: { x: 1, y: 1, roomName: 'E1S1' } }; }
        if (kind === 'rBuilder-portal') { bridge.memory.data.targetFlag = 'buffer'; w.room.portals = [{}]; }
        if (kind === 'sBuilder-done') bridge.memory.data.done = true;
        if (kind === 'sBuilder-other-shard') bridge.memory.data.task.targetShard = 'shard3';
        assert.equal(w.relay.runControllerEnergyRelay(outer, w.buffer), false, kind);
        assert.equal(w.calls.some(call => call.type === 'transfer'), false, kind);
        w.relay.runControllerEnergyRelay(root, w.buffer);
        assert.equal(w.calls.some(call => call.name === bridge.name), false, kind);
    }
});

test('an empty remote seat recovers from a newly built buffer or dead real bridge without moving productive workers or stealing occupied root seats', () => {
    for (const scenario of ['new-buffer', 'dead-bridge']) {
        const w = world(), root = w.creep('root', 23, 25), far = w.creep('far', 25, 23, 20);
        let bridge;
        if (scenario === 'dead-bridge') bridge = w.creep('bridge', 24, 24, 20);
        w.role({ sourceId: w.buffer.id }).target(far);
        assert.equal(w.calls.some(call => call.name === far.name && call.type === 'move'), false, 'a productive actual far seat is never rearranged');
        w.nextTick(); w.calls.length = 0; far.store.energy = 0;
        if (bridge) { w.units.splice(w.units.indexOf(bridge), 1); delete w.game.creeps[bridge.name]; }
        w.role({ sourceId: w.buffer.id }).source(far);
        const move = w.calls.find(call => call.name === far.name && call.type === 'move');
        assert.ok(move, scenario);
        assert.equal(move.target.isNearTo(w.buffer), true, scenario);
        assert.equal(move.target.isEqualTo(root), false, 'a surviving supplied root is not displaced');
        assert.equal(move.options.ignoreCreeps, false);
        assert.equal(far.memory.dontPullMe, false);
        far.pos = move.target; w.nextTick(); w.calls.length = 0;
        w.role({ sourceId: w.buffer.id }).source(far);
        assert.ok(w.calls.some(call => call.name === far.name && call.type === 'withdraw'));
        assert.equal(w.calls.some(call => call.name === far.name && call.type === 'upgrade'), false, 'new refill remains a native next-tick Store change');
        w.nextTick(); w.calls.length = 0; w.role({ sourceId: w.buffer.id }).target(far);
        assert.ok(w.calls.some(call => call.name === far.name && call.type === 'upgrade'));
        assert.equal(w.calls.some(call => call.name === far.name && call.type === 'move'), false);
    }
});

test('relay import does not access Game and RCL8 bypasses all scans and new carry intents', () => {
    const loader = createSourceLoader({ modules: { 'settings/rolePolicy': { rolePolicy: {} }, 'settings/interShard': { interShardPolicy: {} } } });
    assert.equal(typeof loader.load('creep/controllerEnergyRelay').runControllerEnergyRelay, 'function');
    const w = world(), unit = w.creep('upgrader', 23, 25); w.room.controller.level = 8;
    Object.defineProperty(w.room.memory, 'fastUpgrade', { get() { throw Error('RCL8 development access'); } });
    assert.equal(w.relay.runControllerEnergyRelay(unit, w.buffer), false);
    assert.deepEqual(w.counters.find, {}); assert.deepEqual(w.calls, []);
});
