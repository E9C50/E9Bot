const assert = require('node:assert/strict');
const test = require('node:test');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function store(energy = 0, capacity = 50, other = {}) {
    const result = { energy, ...other };
    const used = resource => resource ? (result[resource] || 0) : Object.values(result).reduce((sum, value) => sum + value, 0);
    Object.defineProperties(result, {
        getUsedCapacity: { value: used },
        getCapacity: { value: () => capacity },
        getFreeCapacity: { value: resource => Math.max(0, capacity - used(resource)) }
    });
    return result;
}

function world(level = 3) {
    const objects = new Map(), calls = [], walls = new Set();
    const game = { time: 100, shard: { name: 'shard3' }, flags: {}, getObjectById: id => objects.get(id) || null };
    function position(value) { return value.pos || value; }
    class RoomPosition {
        constructor(x, y, roomName = 'W1N1') { Object.assign(this, { x, y, roomName }); }
        getRangeTo(value) { const target = position(value); return target.roomName === this.roomName ? Math.max(Math.abs(target.x - this.x), Math.abs(target.y - this.y)) : Infinity; }
        isNearTo(value) { return this.getRangeTo(value) <= 1; }
        inRangeTo(value, range) { return this.getRangeTo(value) <= range; }
        isEqualTo(value) { return this.getRangeTo(value) === 0; }
    }
    const p = (x, y) => new RoomPosition(x, y);
    let terrainReads = 0, structureLooks = 0;
    const room = {
        name: 'W1N1', level, memory: { roomFillJob: {} }, energyAvailable: 300,
        sources: [], containers: [], links: [], spawns: [], extensions: [], towers: [], labs: [],
        structures: [], units: [], constructionSites: [], droppedResource: [],
        getTerrain() { terrainReads++; return { get: (x, y) => walls.has(`${x},${y}`) ? 1 : 0 }; },
        lookForAt(type, x, y) {
            if (type === 'structure') { structureLooks++; return room.structures.filter(item => item.pos.x === x && item.pos.y === y); }
            return room.units.filter(item => item.pos.x === x && item.pos.y === y);
        },
        find: () => room.units,
        createConstructionSite(...args) { calls.push({ method: 'createConstructionSite', args }); return 0; }
    };
    room.controller = { id: 'controller', level, my: true, pos: p(25, 25) };
    objects.set(room.controller.id, room.controller);
    function structure(id, type, x, y, energy = 0, capacity = 2000) {
        const target = { id, structureType: type, pos: p(x, y), room, store: store(energy, capacity), hits: 250000, hitsMax: 250000, my: true, isActive: () => true };
        objects.set(id, target); room.structures.push(target);
        const group = { container: 'containers', link: 'links', spawn: 'spawns', extension: 'extensions', tower: 'towers', lab: 'labs' }[type];
        if (group) room[group].push(target); else if (type === 'storage' || type === 'terminal') room[type] = target;
        return target;
    }
    function source(id = 'source', x = 10, y = 10, energy = 3000) {
        const target = { id, pos: p(x, y), energy, room }; objects.set(id, target); room.sources.push(target); return target;
    }
    function drop(id, x, y, amount = 100, resourceType = 'energy') {
        const target = { id, pos: p(x, y), amount, resourceType }; objects.set(id, target); room.droppedResource.push(target); return target;
    }
    function creep(name = 'worker', role = 'upgrader', x = 23, y = 25, energy = 20, capacity = 100) {
        const unit = { name, id: name, room, pos: p(x, y), memory: { role }, store: store(energy, capacity), spawning: false };
        for (const method of ['upgradeController', 'harvest', 'withdraw', 'transfer', 'pickup', 'repair', 'build', 'signController']) {
            unit[method] = (target, resource, amount) => {
                calls.push({ method, name, target: target.id, resource, ...(amount === undefined ? {} : { amount }) });
                const range = ['upgradeController', 'repair', 'build'].includes(method) ? 3 : 1;
                return unit.pos.inRangeTo(target, range) ? 0 : -9;
            };
        }
        unit.moveTo = (target, options) => { calls.push({ method: 'moveTo', name, target: target.id, x: position(target).x, y: position(target).y, range: options?.range }); return 0; };
        unit.drop = resource => { calls.push({ method: 'drop', name, resource }); return 0; };
        unit.say = text => { calls.push({ method: 'say', name, text }); return 0; };
        unit.pickupDroppedResource = (...args) => { calls.push({ method: 'pickupDroppedResource', name, args }); return false; };
        for (const method of ['takeFromTarget', 'transferToTarget']) unit[method] = (target, resource) => { calls.push({ method, name, target: target.id, resource }); return true; };
        room.units.push(unit); objects.set(name, unit); return unit;
    }
    const loader = createSourceLoader({
        globals: {
            Game: game, RoomPosition, WORK: 'work', RESOURCE_ENERGY: 'energy', FIND_MY_CREEPS: 'myCreeps',
            LOOK_STRUCTURES: 'structure', LOOK_CREEPS: 'creep', TERRAIN_MASK_WALL: 1,
            STRUCTURE_ROAD: 'road', STRUCTURE_CONTAINER: 'container', STRUCTURE_RAMPART: 'rampart', STRUCTURE_LINK: 'link',
            CONTAINER_DECAY: 5000, OK: 0, ERR_NOT_IN_RANGE: -9,
        },
        modules: { utils: {
            getDistance: (a, b) => a.getRangeTo(b),
            getClosestTarget: (origin, values) => values.reduce((closest, item) => !closest || origin.getRangeTo(item) < origin.getRangeTo(closest) ? item : closest, undefined)
        } }
    });
    const roles = {
        upgrader: loader.load('role/base/RoleBaseUpgrader').default,
        filler: loader.load('role/base/RoleBaseFiller').default,
        harvester: loader.load('role/base/RoleBaseHarvester').default
    };
    return {
        game, room, objects, calls, walls, p, source, drop, structure, creep, roles,
        logistics: loader.load('creep/developmentLogistics'),
        policy: loader.load('settings/development').developmentPolicy,
        counts: () => ({ terrainReads, structureLooks }),
        intents: method => calls.filter(call => call.method === method),
        clear: () => { calls.length = 0; }
    };
}

for (const phase of ['source', 'target']) test(`new RCL8 upgrader ${phase} upgrades and refills at the controller link in one tick`, () => {
    const w = world(8), link = w.structure('controller-link', 'link', 22, 25, 800, 800);
    const unit = w.creep('upgrader', 'upgrader', 23, 25, 85, 100);
    unit.memory.boostPlan = { tier: 0, steps: [] };
    Object.defineProperty(w.room.memory, 'fastUpgrade', { get() { throw Error('RCL8 must not enter growth policy'); } });
    const behavior = w.roles.upgrader({ sourceId: link.id });
    behavior[phase](unit);
    assert.deepEqual(w.calls.map(call => [call.method, call.target]), [['upgradeController', 'controller'], ['withdraw', link.id]]);
    assert.equal(w.counts().terrainReads, 0, 'an already shared seat requires no tile scan');
});

test('new 15-WORK 2-CARRY upgrader continues at 15 energy per tick after its first refill', () => {
    const w = world(8), link = w.structure('controller-link', 'link', 22, 25, 800, 800);
    const unit = w.creep('upgrader', 'upgrader', 23, 25, 0, 100);
    unit.memory.boostPlan = { tier: 0, steps: [] };
    const behavior = w.roles.upgrader({ sourceId: link.id });
    let energySpent = 0;
    for (let tick = 0; tick < 30; tick++) {
        w.clear(); behavior.source(unit);
        const withdrawn = w.intents('withdraw').length ? 100 - unit.store.energy : 0;
        const spent = w.intents('upgradeController').length ? Math.min(15, unit.store.energy) : 0;
        unit.store.energy += withdrawn - spent;
        energySpent += spent;
    }
    assert.equal(energySpent, 29 * 15);
});

test('new RCL8 upgrader moves to a walkable supply/controller intersection and waits on an empty buffer', () => {
    const w = world(8), link = w.structure('controller-link', 'link', 22, 25, 0, 800);
    const unit = w.creep('upgrader', 'upgrader', 15, 25, 0, 100);
    unit.memory.boostPlan = { tier: 0, steps: [] };
    const behavior = w.roles.upgrader({ sourceId: link.id });
    behavior.source(unit);
    const move = w.intents('moveTo')[0], seat = w.p(move.x, move.y);
    assert.ok(seat.isNearTo(link) && seat.inRangeTo(w.room.controller, 3));
    assert.equal(seat.isEqualTo(link), false, 'cannot occupy a link tile');
    unit.pos = seat; w.clear(); behavior.target(unit);
    assert.deepEqual(w.calls, []);
});

test('new stationary upgrader preserves an explicit incompatible position flag and leaves legacy units unchanged', () => {
    const w = world(8), link = w.structure('controller-link', 'link', 22, 25, 800, 800);
    const unit = w.creep('upgrader', 'upgrader', 23, 25, 85, 100);
    unit.memory.boostPlan = { tier: 0, steps: [] };
    w.game.flags[unit.name] = { pos: w.p(27, 27) };
    w.roles.upgrader({ sourceId: link.id }).target(unit);
    assert.deepEqual(w.calls.map(call => call.method), ['moveTo']);
    assert.equal(w.intents('moveTo')[0].x, 27);
    delete w.game.flags[unit.name]; delete unit.memory.boostPlan; w.clear();
    w.roles.upgrader({ sourceId: link.id }).target(unit);
    assert.deepEqual(w.calls.map(call => call.method), ['upgradeController'], 'unmarked legacy link refill behavior remains intact');
});

test('controller logistics imports without Game and leaves RCL8 and disabled rooms untouched', () => {
    const loader = createSourceLoader();
    assert.equal(typeof loader.load('creep/developmentLogistics').controllerEnergyBuffer, 'function');
    for (const level of [8, 0]) {
        const w = world(level);
        Object.defineProperty(w.room.memory, 'fastUpgrade', { get() { throw new Error('mature room read development memory'); } });
        Object.defineProperty(w.room, 'controllerLink', { get() { throw new Error('mature room read development buffer'); } });
        assert.equal(w.logistics.controllerEnergyBuffer(w.room), undefined);
    }
    const w = world(); w.room.memory.fastUpgrade = false;
    Object.defineProperty(w.room, 'controllerLink', { get() { throw new Error('disabled room read buffer'); } });
    assert.equal(w.logistics.controllerEnergyBuffer(w.room), undefined);
    w.room.controller.my = false;
    assert.equal(w.logistics.controllerEnergyBuffer(w.room), undefined);
});

test('controller buffer prefers an active owned link over a nearby container', () => {
    const w = world(5), container = w.structure('container', 'container', 23, 25), link = w.structure('link', 'link', 25, 23);
    w.room.controllerLink = link;
    assert.equal(w.logistics.controllerEnergyBuffer(w.room), link);
    w.game.time++; link.isActive = () => false;
    assert.equal(w.logistics.controllerEnergyBuffer(w.room), container);
    w.game.time++; link.isActive = () => true; link.my = false;
    assert.equal(w.logistics.controllerEnergyBuffer(w.room), container);
});

test('controller buffer prefers the range-three container over legacy range-one and range-two containers', () => {
    const w = world(3);
    const one = w.structure('legacy-one', 'container', 24, 25, 1000);
    w.structure('legacy-two', 'container', 23, 25, 1000);
    const planned = w.structure('planned-three', 'container', 22, 25, 0);
    assert.equal(w.logistics.controllerEnergyBuffer(w.room), planned, 'station geometry wins even when the legacy containers have energy');
    w.room.containers.splice(w.room.containers.indexOf(planned), 1);
    w.game.time++;
    assert.equal(w.logistics.controllerEnergyBuffer(w.room), one, 'without a range-three station the existing nearest-container fallback remains');
});

test('controller buffer caches the structure once per tick and discovers a new station on the next tick', () => {
    const w = world();
    assert.equal(w.logistics.controllerEnergyBuffer(w.room), undefined);
    const container = w.structure('new', 'container', 22, 25);
    assert.equal(w.logistics.controllerEnergyBuffer(w.room), undefined);
    w.game.time++;
    assert.equal(w.logistics.controllerEnergyBuffer(w.room), container);
    const first = w.counts();
    for (let n = 0; n < 20; n++) assert.equal(w.logistics.controllerEnergyBuffer(w.room), container);
    assert.deepEqual(w.counts(), first, 'buffer discovery does not repeat seat/look scans');
    container.store.energy = 777;
    assert.equal(w.logistics.controllerEnergyBuffer(w.room).store.energy, 777, 'Store amounts are not cached');
    w.room.containers.length = 0; w.game.shard.name = 'shard2';
    assert.equal(w.logistics.controllerEnergyBuffer(w.room), undefined);
});

test('controller stations require an actual walkable tile in both native ranges', () => {
    const w = world(), buffer = w.structure('buffer', 'container', 22, 25);
    for (let x = 21; x <= 23; x++) for (let y = 24; y <= 26; y++) w.walls.add(`${x},${y}`);
    assert.equal(w.logistics.controllerEnergyBuffer(w.room), undefined);
    w.game.time++; w.walls.delete('23,25');
    const obstacle = w.structure('obstacle', 'spawn', 23, 25);
    assert.equal(w.logistics.controllerEnergyBuffer(w.room), undefined);
    w.game.time++; obstacle.structureType = 'rampart'; obstacle.my = false; obstacle.isPublic = false;
    assert.equal(w.logistics.controllerEnergyBuffer(w.room), undefined);
    w.game.time++; obstacle.isPublic = true;
    assert.equal(w.logistics.controllerEnergyBuffer(w.room), buffer);
    const unit = w.creep();
    const seat = w.logistics.controllerUpgradePosition(unit, buffer);
    assert.equal(seat.isNearTo(buffer), true);
    assert.equal(seat.inRangeTo(w.room.controller, 3), true);
});

test('controller seats reserve separate positions for moving workers and reject occupied tiles', () => {
    const w = world(), buffer = w.structure('buffer', 'container', 23, 25);
    const first = w.creep('first', 'upgrader', 15, 25), second = w.creep('second', 'upgrader', 15, 26);
    const a = w.logistics.controllerUpgradePosition(first, buffer), b = w.logistics.controllerUpgradePosition(second, buffer);
    assert.equal(a.isEqualTo(b), false);
    assert.equal(w.logistics.controllerUpgradePosition(first, buffer).isEqualTo(a), true);
    w.creep('blocker', 'builder', a.x, a.y);
    w.game.time++;
    assert.equal(w.logistics.controllerUpgradePosition(first, buffer).isEqualTo(a), false);
});

test('four development upgraders reserve legal container seats while preserving the outer hauler face', () => {
    const w = world(3), buffer = w.structure('buffer', 'container', 22, 25, 1000);
    const units = [24, 25, 26, 27].map((y, index) => w.creep(`upgrader-${index}`, 'upgrader', 19, y, 20));
    const behavior = w.roles.upgrader({ sourceId: buffer.id });
    for (const unit of units) assert.equal(behavior.source(unit), true);
    const moves = w.intents('moveTo');
    assert.equal(moves.length, 4);
    assert.equal(new Set(moves.map(move => `${move.x},${move.y}`)).size, 4, 'same-tick reservations cannot direct two upgraders to the same tile');
    for (const [index, move] of moves.entries()) {
        const seat = w.p(move.x, move.y);
        assert.equal(move.range, 0);
        assert.ok(seat.isNearTo(buffer) && seat.inRangeTo(w.room.controller, 3));
        assert.equal(seat.x === 21, false, 'the outward container face stays available for hauling');
        if (index < 3) assert.ok(seat.getRangeTo(w.room.controller) < 3, 'inner seats precede the closer outer seats');
        units[index].pos = seat;
    }
    const hauler = w.creep('hauler', 'filler', 21, 25, 100);
    assert.ok(hauler.pos.isNearTo(buffer));
    assert.equal(units.some(unit => unit.pos.isEqualTo(hauler)), false);
    w.game.time++; w.clear();
    for (const unit of units) assert.equal(behavior.target(unit), true);
    assert.equal(w.intents('moveTo').length, 0, 'all four occupied seats remain stable on the following tick');
    assert.deepEqual(w.intents('upgradeController').map(call => call.name), units.map(unit => unit.name));
    assert.deepEqual(w.intents('withdraw').map(call => [call.name, call.target]), units.map(unit => [unit.name, buffer.id]));
});

test('RCL8 controller station queries skip development memory and geometry even with a range-three container', () => {
    const w = world(8), buffer = w.structure('buffer', 'container', 22, 25, 1000), unit = w.creep();
    Object.defineProperty(w.room.memory, 'fastUpgrade', { get() { throw new Error('RCL8 read development policy'); } });
    Object.defineProperty(w.room, 'controllerLink', { get() { throw new Error('RCL8 scanned development stations'); } });
    const before = w.counts();
    assert.equal(w.logistics.controllerEnergyBuffer(w.room), undefined);
    assert.equal(w.logistics.controllerUpgradePosition(unit, buffer), undefined);
    assert.deepEqual(w.counts(), before);
    assert.deepEqual(w.calls, []);
});

test('controller seats reject natural Source and Mineral tiles even on plain terrain', () => {
    const w = world(), buffer = w.structure('buffer', 'container', 22, 25), unit = w.creep('upgrader', 'upgrader', 24, 25);
    const source = w.source('near-controller', 23, 24);
    w.room.mineral = { pos: w.p(23, 25) };
    const seat = w.logistics.controllerUpgradePosition(unit, buffer);
    assert.equal(seat.isEqualTo(source), false);
    assert.equal(seat.isEqualTo(w.room.mineral), false);
    assert.equal(seat.isNearTo(buffer), true);
    assert.equal(seat.inRangeTo(w.room.controller, 3), true);
});

for (const phase of ['source', 'target']) test(`stationary upgrader ${phase} upgrades a partial load and refills in the same tick without signing movement`, () => {
    const w = world(), buffer = w.structure('buffer', 'container', 22, 25, 1000);
    w.room.memory.roomSignText = 'new sign'; w.game.flags.worker = { pos: w.p(1, 1) };
    const unit = w.creep(), behavior = w.roles.upgrader({});
    assert.equal(behavior[phase](unit), true);
    assert.deepEqual(w.calls.map(call => call.method), ['upgradeController', 'withdraw']);
    assert.equal(w.intents('withdraw')[0].target, buffer.id);
});

test('an empty stationary upgrader refills immediately even while the old working flag is true', () => {
    const w = world(), buffer = w.structure('buffer', 'container', 22, 25, 1000), unit = w.creep('worker', 'upgrader', 23, 25, 0);
    unit.memory.working = true;
    w.roles.upgrader({}).target(unit);
    assert.deepEqual(w.calls.map(call => call.method), ['withdraw']);
    assert.equal(w.intents('withdraw')[0].target, buffer.id);
    assert.equal(unit.memory.working, false);
});

test('a dry controller buffer does not interrupt an upgrader that still carries energy', () => {
    const w = world(); w.structure('buffer', 'container', 22, 25, 0);
    w.roles.upgrader({}).source(w.creep());
    assert.deepEqual(w.calls.map(call => call.method), ['upgradeController']);
});

test('mobile RCL1 upgrader self-harvests the source nearest the controller without a container', () => {
    const w = world(1); w.source('far', 5, 5); const source = w.source('near', 20, 25);
    const unit = w.creep('worker', 'upgrader', 19, 25, 0), data = { sourceId: source.id };
    assert.equal(w.roles.upgrader(data).source(unit), true);
    assert.deepEqual(w.calls.map(call => [call.method, call.target]), [['harvest', 'near']]);
});

test('mobile upgrader consumes partial loads and walks only to native upgrade range', () => {
    const w = world(1), unit = w.creep('worker', 'upgrader', 10, 10, 3), behavior = w.roles.upgrader({});
    behavior.source(unit);
    assert.equal(w.intents('moveTo')[0].target, 'controller');
    assert.equal(w.intents('moveTo')[0].range, 3);
    unit.pos = w.p(23, 25); w.clear(); behavior.source(unit);
    assert.deepEqual(w.calls.map(call => call.method), ['upgradeController']);
});

test('mobile upgrader withdraws from a real source store and safely handles depleted sources', () => {
    const w = world(2), stock = w.structure('source-store', 'container', 10, 11, 100), unit = w.creep('worker', 'upgrader', 10, 10, 0);
    w.roles.upgrader({ sourceId: stock.id }).target(unit);
    assert.equal(w.intents('withdraw')[0].target, stock.id);
    stock.store.energy = 0; w.source('empty', 9, 9, 0); w.clear();
    assert.equal(w.roles.upgrader({}).source(unit), false);
    assert.equal(w.calls.length, 0);
});

test('development filler refills production before defense, labs and controller supply', () => {
    const w = world(), spawn = w.structure('spawn', 'spawn', 10, 10, 0, 300), tower = w.structure('tower', 'tower', 23, 24, 0, 1000);
    w.structure('buffer', 'container', 22, 25, 0); const lab = w.structure('lab', 'lab', 23, 26, 0, 2000);
    w.room.memory.roomFillJob = { labInEnergy: [lab.id], tower: [tower.id] };
    w.roles.filler({}).source(w.creep('filler', 'filler', 23, 25, 20));
    assert.equal(w.intents('transfer')[0].target, spawn.id);
});

test('development filler preserves the tower safety floor before feeding the controller', () => {
    const w = world(), tower = w.structure('tower', 'tower', 23, 24, 499, 1000), buffer = w.structure('buffer', 'container', 22, 25, 100), unit = w.creep('filler', 'filler');
    const behavior = w.roles.filler({}); behavior.target(unit);
    assert.equal(w.intents('transfer')[0].target, tower.id);
    tower.store.energy = 500; w.clear(); behavior.target(unit);
    assert.equal(w.intents('transfer')[0].target, buffer.id);
    buffer.store.energy = 1500; w.clear();
    assert.equal(behavior.target(unit), false, 'a 75% buffer needs no refill without other jobs');
    assert.equal(w.intents('transfer').length, 0);
});

test('development filler never drains the controller buffer as its own energy source', () => {
    const w = world(), buffer = w.structure('buffer', 'container', 22, 25, 1000), unit = w.creep('filler', 'filler', 23, 25, 0);
    const behavior = w.roles.filler({ sourceId: buffer.id });
    assert.equal(behavior.target(unit), false);
    assert.equal(w.intents('withdraw').length, 0);
    const sourceStore = w.structure('mine', 'container', 10, 11, 1000);
    behavior.target(unit);
    assert.equal(w.intents('withdraw')[0].target, sourceStore.id);
});

test('a Source.id filler only picks energy dropped at its own mine and retains that source assignment', () => {
    const w = world(1), source = w.source('source', 10, 10), unit = w.creep('filler', 'filler', 15, 10, 0);
    w.drop('wrong-source', 15, 10); w.drop('mineral', 10, 11, 100, 'H'); w.drop('empty', 10, 11, 0);
    const correct = w.drop('mine-drop', 10, 11), data = { sourceId: source.id }, behavior = w.roles.filler(data);
    behavior.source(unit);
    assert.equal(w.intents('pickup')[0].target, correct.id);
    assert.equal(data.sourceId, source.id);
    const stock = w.structure('stock', 'storage', 15, 11, 1000);
    w.clear(); behavior.source(unit);
    assert.equal(w.intents('withdraw').length, 0, 'another stock cannot draw a mine carrier away from its assigned drop');
    correct.amount = 0; w.clear(); behavior.source(unit);
    assert.equal(w.intents('withdraw').length, 0, 'an empty mine waits instead of stealing another hauling lane');
    assert.equal(data.sourceId, source.id);
    assert.equal(stock.store.energy, 1000);
});

test('a right-mine container filler ignores the nearer left-mine fragments and sees overflow across the room', () => {
    const w = world(2), right = w.source('right', 42, 32), left = w.source('left', 36, 34);
    const container = w.structure('right-container', 'container', 43, 33, 2000);
    w.structure('left-container', 'container', 37, 34, 2000);
    w.drop('near-fragment', 37, 34, 6);
    const overflow = w.drop('right-overflow', 43, 33, 5400);
    const unit = w.creep('right-hauler', 'filler', 18, 30, 0, 250), data = { sourceId: container.id, mineId: right.id };
    assert.equal(w.roles.filler(data).source(unit), true);
    assert.equal(w.intents('pickup')[0].target, overflow.id);
    assert.equal(w.intents('moveTo')[0].target, overflow.id);
    assert.equal(data.sourceId, container.id);
    assert.equal(data.mineId, right.id);
    assert.notEqual(data.mineId, left.id);
    assert.equal(unit.memory.working, false);
});

test('a tiny own-mine drop cannot outrank a container that can fill the hauler', () => {
    const w = world(2), source = w.source(), stock = w.structure('stock', 'container', 11, 10, 2000);
    w.drop('tiny', 9, 10, 6);
    const unit = w.creep('hauler', 'filler', 9, 10, 0, 250);
    w.roles.filler({ sourceId: stock.id, mineId: source.id }).source(unit);
    assert.equal(w.intents('pickup').length, 0);
    assert.equal(w.intents('withdraw')[0].target, stock.id);
    assert.equal(w.intents('withdraw')[0].amount, 250);
    assert.equal(unit.memory.working, false, 'an issued intent does not pretend Store changed');
});

test('a live tiny-load filler resumes filling and delivers only after the native Store is full', () => {
    const w = world(2), source = w.source(), stock = w.structure('stock', 'container', 11, 10, 2000);
    const spawn = w.structure('spawn', 'spawn', 18, 10, 0, 300);
    const unit = w.creep('hauler', 'filler', 12, 10, 6, 250), behavior = w.roles.filler({ sourceId: stock.id, mineId: source.id });
    unit.memory.working = true;
    behavior.target(unit);
    assert.equal(unit.memory.working, false);
    assert.equal(w.intents('transfer').length, 0);
    assert.equal(w.intents('withdraw')[0].amount, 244);
    unit.store.energy = 250; w.game.time++; w.clear(); behavior.source(unit);
    assert.equal(unit.memory.working, true);
    assert.equal(w.intents('transfer')[0].target, spawn.id);
    unit.store.energy = 30; w.game.time++; w.clear(); behavior.target(unit);
    assert.equal(w.intents('transfer')[0].target, spawn.id, 'partially emptied delivery stays in delivery until empty');
    assert.equal(w.intents('withdraw').length, 0);
    unit.store.energy = 0; w.game.time++; w.clear(); behavior.target(unit);
    assert.equal(unit.memory.working, false);
    assert.equal(w.intents('withdraw')[0].target, stock.id);
});

test('same-tick haulers reserve successful pickup amounts and split overflow/container batches', () => {
    const w = world(2), source = w.source(), stock = w.structure('stock', 'container', 11, 10, 2000);
    const overflow = w.drop('overflow', 11, 10, 250);
    const first = w.creep('first', 'filler', 12, 10, 0, 250), second = w.creep('second', 'filler', 12, 11, 0, 250);
    const behavior = w.roles.filler({ sourceId: stock.id, mineId: source.id });
    behavior.source(first); behavior.source(second);
    assert.deepEqual(w.intents('pickup').map(intent => [intent.name, intent.target]), [['first', overflow.id]]);
    assert.deepEqual(w.intents('withdraw').map(intent => [intent.name, intent.target]), [['second', stock.id]]);
    assert.equal(overflow.amount, 250, 'reservation only tracks native intents, without mutating live game data');
    assert.equal(first.store.energy, 0);
    w.game.time++; w.clear(); behavior.source(second);
    assert.equal(w.intents('pickup')[0].target, overflow.id, 'reservations expire each tick');
});

test('distant movement does not reserve a batch before an actual pickup intent succeeds', () => {
    const w = world(2), source = w.source(), overflow = w.drop('overflow', 11, 10, 250);
    const moving = w.creep('moving', 'filler', 18, 10, 0, 250), nearby = w.creep('nearby', 'filler', 12, 10, 0, 250);
    const behavior = w.roles.filler({ sourceId: source.id });
    behavior.source(moving); behavior.source(nearby);
    assert.deepEqual(w.intents('pickup').map(intent => intent.target), [overflow.id, overflow.id]);
});

test('planned mine identity repairs an old live container fallback assignment', () => {
    const w = world(2), source = w.source('right', 42, 32), wrong = w.structure('left-stock', 'container', 11, 10, 2000);
    const right = w.structure('right-stock', 'container', 43, 33, 2000), unit = w.creep('hauler', 'filler', 12, 10, 6, 250);
    const data = { sourceId: wrong.id };
    w.room.memory.creepConfig = { hauler: { role: 'filler', development: { carryParts: 5 }, data: { sourceId: right.id, mineId: source.id } } };
    w.roles.filler(data).target(unit);
    assert.equal(data.mineId, source.id);
    assert.equal(data.sourceId, right.id);
    assert.equal(w.intents('withdraw')[0].target, right.id);
});

test('legacy development demand names restore mine identity before the next population refresh', () => {
    const w = world(2), source = w.source('right', 42, 32), right = w.structure('right-stock', 'container', 43, 33, 2000);
    const wrong = w.structure('left-stock', 'container', 11, 10, 2000), unit = w.creep('hauler', 'filler', 12, 10, 0);
    unit.memory.name = `W1N1_DEVELOP_FILLER_${source.id}_1`;
    w.room.memory.creepConfig = { hauler: { role: 'filler', development: { carryParts: 2 }, data: { sourceId: right.id } } };
    const data = { sourceId: wrong.id }; w.roles.filler(data).source(unit);
    assert.equal(data.mineId, source.id);
    assert.equal(w.intents('withdraw')[0].target, right.id);
});

test('surviving fillers keep their original mine even after the population demand has been removed', () => {
    const w = world(2), source = w.source('right', 42, 32), right = w.structure('right-stock', 'container', 43, 33, 2000);
    const wrong = w.structure('left-stock', 'container', 11, 10, 2000), unit = w.creep('hauler', 'filler', 12, 10, 0);
    unit.memory.name = `W1N1_DEVELOP_FILLER_${source.id}_2`;
    const data = { sourceId: wrong.id }; w.roles.filler(data).source(unit);
    assert.equal(data.mineId, source.id);
    assert.equal(w.intents('withdraw')[0].target, right.id);
});

for (const type of ['storage', 'terminal']) test(`a ${type} next to a mine remains a stock carrier without mining identity`, () => {
    const w = world(4); w.source();
    const stock = w.structure('stock', type, 11, 10, 100000, 1000000), unit = w.creep('hauler', 'filler', 12, 10, 0, 250);
    const data = { sourceId: stock.id }; w.roles.filler(data).source(unit);
    assert.equal(data.mineId, undefined);
    assert.equal(w.intents('withdraw')[0].target, stock.id);
    assert.equal(w.intents('withdraw')[0].amount, 250);
});

test('a planned stock carrier clears stale inferred mine identity and restores its configured storage', () => {
    const w = world(4), source = w.source(), mine = w.structure('mine', 'container', 11, 10, 0);
    const stock = w.structure('stock', 'storage', 18, 10, 100000, 1000000), unit = w.creep('hauler', 'filler', 17, 10, 0, 250);
    w.room.memory.creepConfig = { hauler: { role: 'filler', name: 'W1N1_DEVELOP_FILLER_STORAGE_0',
        development: { carryParts: 5 }, data: { sourceId: stock.id } } };
    const data = { sourceId: mine.id, mineId: source.id }; w.roles.filler(data).source(unit);
    assert.equal(data.mineId, undefined);
    assert.equal(data.sourceId, stock.id);
    assert.equal(w.intents('withdraw')[0].target, stock.id);
});

test('a dry mine dispatches a partial load after a bounded idle wait without draining the controller', () => {
    const w = world(2), source = w.source(), stock = w.structure('stock', 'container', 11, 10, 0);
    const buffer = w.structure('buffer', 'container', 22, 25, 1000), unit = w.creep('hauler', 'filler', 12, 10, 20, 250);
    const behavior = w.roles.filler({ sourceId: stock.id, mineId: source.id });
    behavior.target(unit);
    assert.equal(unit.memory.working, false); assert.equal(w.calls.length, 0);
    w.game.time += w.policy.hauling.partialLoadIdleTicks - 1; behavior.source(unit);
    assert.equal(unit.memory.working, false);
    w.game.time++; behavior.source(unit);
    assert.equal(unit.memory.working, true);
    assert.equal(w.intents('transfer')[0].target, buffer.id);
    assert.equal(w.intents('withdraw').length, 0);
});

test('continued real energy gain keeps a partial hauler collecting instead of timing out', () => {
    const w = world(2), source = w.source(), unit = w.creep('hauler', 'filler', 11, 10, 1, 250);
    const behavior = w.roles.filler({ sourceId: source.id });
    for (let tick = 0; tick < 30; tick++) {
        behavior.source(unit);
        assert.equal(unit.memory.working, false);
        unit.store.energy++; w.game.time++;
    }
});

test('a near-spawn emergency delivers a useful partial batch to rescue production', () => {
    const w = world(2), source = w.source(), spawn = w.structure('spawn', 'spawn', 18, 10, 0, 300);
    w.room.energyAvailable = 0;
    const unit = w.creep('hauler', 'filler', 17, 10, 50, 250);
    w.roles.filler({ sourceId: source.id }).source(unit);
    assert.equal(unit.memory.working, true);
    assert.equal(w.intents('transfer')[0].target, spawn.id);
});

test('a mine does not lose its assignment when its container is temporarily empty or destroyed', () => {
    const w = world(2), source = w.source(), stock = w.structure('stock', 'container', 11, 10, 0);
    w.structure('other-stock', 'container', 12, 10, 2000);
    const unit = w.creep('hauler', 'filler', 13, 10, 0), data = { sourceId: stock.id, mineId: source.id };
    const behavior = w.roles.filler(data); behavior.source(unit);
    assert.equal(w.intents('withdraw').length, 0);
    w.objects.delete(stock.id); w.room.containers.splice(w.room.containers.indexOf(stock), 1); w.game.time++;
    const drop = w.drop('mine-drop', 11, 10, 250); w.clear(); behavior.source(unit);
    assert.equal(w.intents('pickup')[0].target, drop.id);
    assert.equal(data.sourceId, stock.id);
    assert.equal(data.mineId, source.id);
});

test('RCL8 filler uses the existing source behavior without reading development loading state', () => {
    const w = world(8), stock = w.structure('stock', 'container', 11, 10, 2000), unit = w.creep('hauler', 'filler', 12, 10, 6, 250);
    Object.defineProperty(unit.memory, 'developmentHauler', { get() { throw Error('mature hauling read development state'); } });
    w.roles.filler({ sourceId: stock.id }).source(unit);
    assert.deepEqual(w.intents('takeFromTarget').map(intent => intent.target), [stock.id]);
    assert.equal(w.intents('withdraw').length, 0);
});

test('a Source.id filler with no available drop waits outside the harvesting tile without reading Source.store', () => {
    const w = world(1), source = w.source(), unit = w.creep('filler', 'filler', 20, 20, 0);
    assert.equal(w.roles.filler({ sourceId: source.id }).target(unit), false);
    assert.equal(w.intents('moveTo')[0].target, source.id);
    assert.equal(w.intents('moveTo')[0].range, 2);
});

test('no-buffer bootstrap filler can feed an upgrader already in controller range', () => {
    const w = world(1), worker = w.creep('upgrader', 'upgrader', 23, 25, 0), filler = w.creep('filler', 'filler', 23, 24);
    w.roles.filler({}).target(filler);
    assert.equal(w.intents('transfer')[0].target, worker.id);
});

test('empty development fillers refill immediately despite the legacy working flag', () => {
    const w = world(), stock = w.structure('stock', 'container', 10, 11, 100), filler = w.creep('filler', 'filler', 10, 10, 0);
    filler.memory.working = true;
    w.roles.filler({ sourceId: stock.id }).target(filler);
    assert.deepEqual(w.calls.map(call => call.method), ['withdraw']);
    assert.equal(filler.memory.working, false);
});

for (const phase of ['source', 'target']) test(`stationary development harvester ${phase} unloads and harvests without a phase gap`, () => {
    const w = world(), source = w.source(), buffer = w.structure('mine', 'container', 11, 10), unit = w.creep('miner', 'harvester', 11, 10, 10, 50);
    const behavior = w.roles.harvester({ sourceId: source.id });
    assert.equal(behavior.prepare(unit), true);
    assert.equal(behavior[phase](unit), true);
    assert.deepEqual(w.calls.map(call => [call.method, call.target]), [['transfer', buffer.id], ['harvest', source.id]]);
    assert.equal(unit.memory.working, false);
});

test('development miner seats support source and link simultaneously and prefer source containers', () => {
    const w = world(), source = w.source(), container = w.structure('container', 'container', 11, 10), link = w.structure('link', 'link', 12, 10), unit = w.creep('miner', 'harvester', 8, 10, 0);
    const behavior = w.roles.harvester({ sourceId: source.id });
    assert.equal(behavior.prepare(unit), false);
    const move = w.intents('moveTo')[0];
    assert.equal(w.p(move.x, move.y).isNearTo(source), true);
    assert.equal(w.p(move.x, move.y).isNearTo(link), true);
    assert.equal(move.range, 0);
    const reserved = w.logistics.sourceHarvestPosition(unit, source, container);
    assert.ok(reserved.isNearTo(source) && reserved.isNearTo(container));
    unit.pos = w.p(11, 10); unit.store.energy = 10; w.clear(); behavior.source(unit);
    assert.equal(w.intents('transfer')[0].target, link.id);
});

test('seated development miners remain productive instead of chasing an empty preferred container tile', () => {
    const w = world(), source = w.source(), container = w.structure('container', 'container', 11, 10);
    const unit = w.creep('miner', 'harvester', 11, 11, 20);
    const behavior = w.roles.harvester({ sourceId: source.id });
    for (let tick = 0; tick < 5; tick++) {
        w.clear(); assert.equal(behavior.prepare(unit), true); behavior.source(unit);
        assert.equal(w.intents('moveTo').length, 0);
        assert.equal(w.intents('harvest')[0].target, source.id);
        assert.equal(w.intents('transfer')[0].target, container.id);
        w.game.time++;
    }
});

test('moving development miners reserve separate source/container workstations during one tick', () => {
    const w = world(), source = w.source(), container = w.structure('container', 'container', 11, 10);
    const first = w.creep('first', 'harvester', 8, 10, 0), second = w.creep('second', 'harvester', 8, 11, 0);
    const a = w.logistics.sourceHarvestPosition(first, source, container), b = w.logistics.sourceHarvestPosition(second, source, container);
    assert.equal(a.isEqualTo(b), false);
    assert.ok(a.isNearTo(source) && a.isNearTo(container) && b.isNearTo(source) && b.isNearTo(container));
    assert.equal(w.logistics.sourceHarvestPosition(first, source, container).isEqualTo(a), true);
});

test('development miners retain energy at a full real container instead of creating decaying ground piles', () => {
    const w = world(), source = w.source(), container = w.structure('container', 'container', 11, 10, 2000);
    const unit = w.creep('miner', 'harvester', 11, 10, 50, 50), behavior = w.roles.harvester({ sourceId: source.id });
    behavior.source(unit);
    assert.equal(w.intents('drop').length, 0);
    assert.equal(w.intents('harvest').length, 0);
    assert.equal(unit.store.energy, 50);
    container.store.energy = 1950; w.game.time++; w.clear(); behavior.source(unit);
    assert.equal(w.intents('transfer')[0].target, container.id);
    assert.equal(w.intents('drop').length, 0);
    unit.store.energy = 0; w.game.time++; w.clear(); behavior.source(unit);
    assert.equal(w.intents('harvest')[0].target, source.id);
});

test('development miner repairs a critically decayed container without competing harvest WORK intents', () => {
    const w = world(), source = w.source(), container = w.structure('container', 'container', 11, 10), unit = w.creep('miner', 'harvester', 11, 10, 10);
    container.hits = 5000;
    w.roles.harvester({ sourceId: source.id }).source(unit);
    assert.deepEqual(w.calls.map(call => call.method), ['repair']);
});

test('no-buffer development miner drops for its carrier while continuing to harvest', () => {
    const w = world(), source = w.source(), unit = w.creep('miner', 'harvester', 11, 10, 10);
    w.creep('carrier', 'filler', 13, 10, 0); w.room.energyAvailable = 0;
    w.roles.harvester({ sourceId: source.id }).target(unit);
    assert.deepEqual(w.calls.map(call => call.method), ['drop', 'harvest']);
    assert.equal(w.intents('createConstructionSite').length, 0);
});

test('development miner with no carrier rescues empty spawn production before returning to the mine', () => {
    const w = world(1), source = w.source(), spawn = w.structure('spawn', 'spawn', 20, 20, 0, 300), unit = w.creep('miner', 'harvester', 11, 10, 50, 50);
    w.room.energyAvailable = 0;
    const behavior = w.roles.harvester({ sourceId: source.id });
    assert.equal(behavior.prepare(unit), true, 'preparation allows the emergency delivery trip');
    behavior.source(unit);
    assert.equal(w.intents('transfer')[0].target, spawn.id);
    assert.equal(w.intents('moveTo')[0].target, spawn.id);
    assert.equal(w.intents('harvest').length, 0);
    unit.pos = w.p(19, 20); w.clear(); behavior.target(unit);
    assert.deepEqual(w.calls.map(call => call.method), ['transfer']);
    unit.store.energy = 0; w.clear();
    assert.equal(behavior.prepare(unit), false);
    assert.equal(w.intents('moveTo')[0].target, source.id);
});

test('no-carrier startup collects a full batch even when a source container exists', () => {
    const w = world(1), source = w.source(), container = w.structure('mine', 'container', 11, 10), unit = w.creep('miner', 'harvester', 11, 10, 4, 50);
    w.structure('spawn', 'spawn', 30, 10, 0, 300); w.room.energyAvailable = 0;
    w.roles.harvester({ sourceId: source.id }).source(unit);
    assert.deepEqual(w.calls.map(call => call.method), ['harvest']);
    assert.equal(container.store.energy, 0, 'the startup batch is retained for spawn instead of being trapped in a store without carriers');
    source.energy = 0; w.clear();
    w.roles.harvester({ sourceId: source.id }).source(unit);
    assert.equal(w.intents('transfer')[0].target, 'spawn', 'a depleted source can send a partial emergency batch');
});

test('a long-distance 300-capacity restart delivers six full batches within a miner lifetime', () => {
    const w = world(1), source = w.source(), spawn = w.structure('spawn', 'spawn', 30, 10, 0, 300), unit = w.creep('miner', 'harvester', 11, 10, 0, 50);
    w.room.energyAvailable = 0;
    const behavior = w.roles.harvester({ sourceId: source.id }), deliveries = [];
    let elapsed = 0;
    for (; elapsed < 500 && spawn.store.energy < 300; elapsed++) {
        w.clear();
        if (behavior.prepare(unit)) behavior[unit.memory.working ? 'target' : 'source'](unit);
        const transfer = w.intents('transfer').find(call => call.target === spawn.id);
        if (transfer && unit.pos.isNearTo(spawn)) {
            const amount = Math.min(unit.store.energy, spawn.store.getFreeCapacity('energy'));
            deliveries.push(amount); spawn.store.energy += amount; unit.store.energy -= amount;
        }
        const harvest = w.intents('harvest')[0];
        if (harvest && unit.pos.isNearTo(source)) {
            const amount = Math.min(4, source.energy, unit.store.getFreeCapacity('energy'));
            unit.store.energy += amount; source.energy -= amount;
        }
        const move = w.intents('moveTo').at(-1);
        if (move && unit.pos.getRangeTo(w.p(move.x, move.y)) > (move.range ?? 1)) unit.pos = w.p(
            unit.pos.x + Math.sign(move.x - unit.pos.x), unit.pos.y + Math.sign(move.y - unit.pos.y));
        w.room.energyAvailable = spawn.store.energy; w.game.time++;
    }
    assert.equal(spawn.store.energy, 300);
    assert.deepEqual(deliveries, [50, 50, 50, 50, 50, 50]);
    assert.ok(elapsed < 500, `two WORK miner supplies the next spawn in ${elapsed} local simulated ticks`);
});

test('a no-CARRY development miner continues harvesting for native dropped-energy logistics', () => {
    const w = world(1), source = w.source(), unit = w.creep('miner', 'harvester', 11, 10, 0, 0);
    w.structure('spawn', 'spawn', 30, 10, 0, 300); w.room.energyAvailable = 0;
    assert.equal(w.roles.harvester({ sourceId: source.id }).source(unit), true);
    assert.deepEqual(w.calls.map(call => call.method), ['harvest']);
});

test('a no-CARRY development miner uses the exact container tile despite an adjacent link', () => {
    const w = world(), source = w.source(), container = w.structure('mine', 'container', 11, 10);
    const link = w.structure('link', 'link', 12, 10), unit = w.creep('miner', 'harvester', 11, 11, 0, 0);
    const behavior = w.roles.harvester({ sourceId: source.id });
    assert.equal(w.logistics.sourceHarvestPosition(unit, source, link), undefined);
    assert.equal(behavior.prepare(unit), false);
    assert.equal(w.intents('moveTo')[0].x, container.pos.x);
    assert.equal(w.intents('moveTo')[0].y, container.pos.y);
    w.clear(); behavior.source(unit);
    assert.equal(w.intents('harvest').length, 0, 'a misplaced zero-CARRY miner cannot create ground overflow');
    unit.pos = w.p(11, 10); w.clear(); assert.equal(behavior.prepare(unit), true); behavior.source(unit);
    assert.equal(w.intents('harvest').length, 1);
    assert.equal(w.intents('transfer').length, 0);
});

test('a no-CARRY miner waits for an occupied container tile instead of mining next to it', () => {
    const w = world(), source = w.source(), container = w.structure('mine', 'container', 11, 10);
    w.creep('incumbent', 'harvester', 11, 10, 0, 50);
    const unit = w.creep('new', 'harvester', 11, 11, 0, 0), behavior = w.roles.harvester({ sourceId: source.id });
    assert.equal(w.logistics.sourceHarvestPosition(unit, source, container), undefined);
    assert.equal(behavior.prepare(unit), false);
    behavior.source(unit);
    assert.equal(w.intents('harvest').length, 0);
});

test('a no-CARRY miner pauses at a full container and resumes native direct storage when space appears', () => {
    const w = world(), source = w.source(), container = w.structure('mine', 'container', 11, 10, 2000);
    const unit = w.creep('miner', 'harvester', 11, 10, 0, 0), behavior = w.roles.harvester({ sourceId: source.id });
    behavior.source(unit); assert.equal(w.intents('harvest').length, 0);
    container.store.energy = 1990; w.game.time++; w.clear(); behavior.source(unit);
    assert.equal(w.intents('harvest')[0].target, source.id);
});

test('continuous controller supply lets a stationary upgrader refill and upgrade every tick', () => {
    const w = world(3), buffer = w.structure('buffer', 'container', 22, 25, 1000), unit = w.creep('upgrader', 'upgrader', 23, 25, 20, 50);
    const behavior = w.roles.upgrader({ sourceId: buffer.id });
    let upgraded = 0;
    for (let tick = 0; tick < 40; tick++) {
        w.clear(); const startEnergy = unit.store.energy, startFree = unit.store.getFreeCapacity('energy');
        behavior[unit.memory.working ? 'target' : 'source'](unit);
        const consumed = w.intents('upgradeController').length ? Math.min(20, startEnergy) : 0;
        const received = w.intents('withdraw').length ? Math.min(startFree, buffer.store.energy) : 0;
        unit.store.energy += received - consumed; buffer.store.energy += 20 - received;
        upgraded += consumed;
        assert.equal(w.intents('upgradeController').length, 1);
        assert.equal(w.intents('withdraw').length, 1);
        w.game.time++;
    }
    assert.equal(upgraded, 800, 'the simulated 20 WORK consumer has no source/target transition gap');
});

test('a living 20 WORK upgrader with quota one consumes at most forty upgrade energy across forty ticks while still refilling', () => {
    const w = world(), buffer = w.structure('buffer', 'container', 22, 25, 1000), unit = w.creep('upgrader', 'upgrader', 23, 25, 20, 50);
    unit.getActiveBodyparts = part => part === 'work' ? 20 : 0;
    w.room.memory.creepConfig = { upgrader: { development: { workParts: 1 } } };
    const behavior = w.roles.upgrader({ sourceId: buffer.id });
    let spent = 0, refills = 0;
    for (let tick = 0; tick < 40; tick++) {
        w.clear(); behavior[unit.memory.working ? 'target' : 'source'](unit);
        spent += w.intents('upgradeController').length * 20; refills += w.intents('withdraw').length;
        w.game.time++;
    }
    assert.equal(spent, 40);
    assert.equal(refills, 40, 'WORK throttling never gates Store logistics');
});

test('mobile upgrade WORK throttling does not stop movement or adjacent withdrawal', () => {
    const w = world(1), unit = w.creep('upgrader', 'upgrader', 10, 10, 20), stock = w.structure('mine', 'container', 10, 11, 1000);
    unit.getActiveBodyparts = part => part === 'work' ? 20 : 0;
    w.room.memory.creepConfig = { upgrader: { development: { workParts: 1 } } };
    const behavior = w.roles.upgrader({ sourceId: stock.id });
    w.game.time = 101; behavior.target(unit);
    assert.equal(w.intents('moveTo')[0].target, 'controller');
    assert.equal(w.intents('withdraw')[0].target, stock.id);
    assert.equal(w.intents('upgradeController').length, 0);
    unit.pos = w.p(23, 25); w.clear();
    let upgraded = 0;
    for (let tick = 0; tick < 40; tick++) { w.clear(); behavior.source(unit); upgraded += w.intents('upgradeController').length * 20; w.game.time++; }
    assert.equal(upgraded, 40);
});

test('RCL8 upgrade ignores development quotas and retains every-tick native behavior', () => {
    const w = world(8), unit = w.creep('upgrader', 'upgrader', 23, 25, 20);
    unit.getActiveBodyparts = () => { throw new Error('RCL8 read development WORK'); };
    w.room.memory.creepConfig = { upgrader: { development: { workParts: 1 } } };
    const behavior = w.roles.upgrader({});
    for (let tick = 0; tick < 40; tick++) { behavior.target(unit); w.game.time++; }
    assert.equal(w.intents('upgradeController').length, 40);
});

test('full development miners unload without an invalid full-store harvest and missing sources reset readiness', () => {
    const w = world(), source = w.source(), container = w.structure('mine', 'container', 11, 10), unit = w.creep('miner', 'harvester', 11, 10, 50, 50);
    const behavior = w.roles.harvester({ sourceId: source.id }); behavior.source(unit);
    assert.deepEqual(w.calls.map(call => [call.method, call.target]), [['transfer', container.id]]);
    unit.memory.ready = true; w.objects.delete(source.id); w.clear();
    assert.equal(behavior.prepare(unit), false);
    assert.equal(behavior.target(unit), false);
    assert.equal(unit.memory.ready, false);
});

for (const disabled of [false, true]) test(`${disabled ? 'opted-out RCL7' : 'RCL8'} preserves the original role phases and priorities`, () => {
    const w = world(disabled ? 7 : 8);
    if (disabled) w.room.memory.fastUpgrade = false;
    Object.defineProperty(w.room, 'controllerLink', { get() { throw new Error('legacy role accessed development buffer'); } });
    const source = w.source(), unit = w.creep('upgrader', 'upgrader', 23, 25, 20, 100), stock = w.structure('mine', 'container', 10, 11, 1000);
    w.roles.upgrader({ sourceId: stock.id }).source(unit);
    assert.equal(w.intents('upgradeController').length, 0, 'legacy upgrader still fills its batch first');
    assert.equal(w.intents('moveTo')[0].target, stock.id);
    w.clear(); const flag = { id: 'flag', pos: w.p(20, 20) }; w.game.flags.upgrader = flag;
    assert.equal(w.roles.upgrader({}).target(unit), false);
    assert.equal(w.intents('moveTo')[0].target, flag.id);
    w.clear(); const miner = w.creep('miner', 'harvester', 11, 10, 40, 50);
    assert.equal(w.roles.harvester({ sourceId: source.id }).source(miner), false);
    assert.equal(miner.memory.working, true);
    assert.equal(w.calls.length, 0);
    const spawn = w.structure('spawn', 'spawn', 23, 24, 0, 300), lab = w.structure('lab', 'lab', 24, 25, 0, 2000), filler = w.creep('filler', 'filler');
    w.room.memory.roomFillJob = { extension: true, labInEnergy: [lab.id] };
    w.roles.filler({}).target(filler);
    assert.equal(w.intents('transferToTarget')[0].target, lab.id, 'legacy lab-before-production priority stays unchanged');
    assert.notEqual(w.intents('transferToTarget')[0].target, spawn.id);
    filler.store.energy = 0; w.clear(); w.roles.filler({ sourceId: stock.id }).source(filler);
    assert.equal(w.calls[0].method, 'pickupDroppedResource');
    assert.equal(w.intents('takeFromTarget')[0].target, stock.id);
});
