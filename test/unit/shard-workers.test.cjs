const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function position(x, y, roomName) {
    return { x, y, roomName, getRangeTo(target) {
        const pos = target.pos || target;
        return Math.max(Math.abs(x - pos.x), Math.abs(y - pos.y));
    } };
}

function task(overrides = {}) {
    return {
        id: 'mission', key: 'shard0:mission', sourceShard: 'shard0', sourceRoom: 'W1N1', targetShard: 'shard1', targetRoom: 'W2N2',
        route: [{ shard: 'shard0', roomName: 'W1N1', x: 10, y: 10, destinationShard: 'shard1', destinationRoom: 'W2N2' }],
        returnRoute: [{ shard: 'shard1', roomName: 'W2N2', x: 20, y: 20, destinationShard: 'shard0', destinationRoom: 'W1N1' }],
        claim: true, builders: 2, haulers: 0, targetLevel: 4, energyAmount: 0, homeEnergyReserve: 10000,
        ...overrides,
    };
}

function world(kind, options = {}) {
    const calls = [];
    const spec = task(options.task);
    const data = { missionId: spec.key, originShard: spec.sourceShard, route: spec.route, hopIndex: spec.route.length, task: spec, unitKind: kind, phase: 'work' };
    const room = {
        name: spec.targetRoom, my: true, level: 1, memory: {},
        sources: [], constructionSites: [], spawns: [], extensions: [], containers: [], links: [], ramparts: [], structuresNeedRepair: [], droppedResources: [],
        controller: { my: true, level: 1, ticksToDowngrade: 10000, pos: position(10, 10, spec.targetRoom) },
        getTerrain: () => ({ get: () => 0 }),
        lookForAt(type, x, y) {
            const values = type === 'look-structures' ? this.find('structures') : type === 'look-power' ? Object.values(game.powerCreeps) : this.find('creeps');
            return values.filter(value => value.pos.x === x && value.pos.y === y);
        },
        find(type) {
            if (type === 'sources') return this.sources;
            if (type === 'dropped') return this.droppedResources;
            if (type === 'my-sites' || type === 'sites') return this.constructionSites;
            if (type === 'my-spawns') return this.spawns;
            if (type === 'creeps' || type === 'my-creeps') return Object.values(game.creeps).filter(unit => unit.room.name === this.name && (type !== 'my-creeps' || unit.my));
            if (type === 'power-creeps') return Object.values(game.powerCreeps).filter(unit => unit.room.name === this.name);
            if (type === 'structures' || type === 'my-structures') return [this.storage, this.terminal, ...this.spawns, ...this.extensions, ...this.containers].filter(Boolean);
            return [];
        },
    };
    const source = { id: 'source', energy: 3000, pos: position(10, 11, room.name), room };
    room.sources.push(source);
    const objects = { source };
    const game = {
        time: 10, shard: { name: spec.targetShard }, rooms: { [room.name]: room }, creeps: {}, powerCreeps: {}, structures: {}, gcl: { level: 10 }, cpu: { bucket: 10000, getUsed: () => 0 },
        map: { getRoomStatus: () => ({ status: 'normal' }), getRoomLinearDistance: () => 1, findRoute: () => [] },
        getObjectById: id => objects[id] || [room.storage, room.terminal, ...room.sources, ...room.containers,
            ...room.droppedResources, ...room.constructionSites].find(item => item?.id === id),
    };
    const local = { version: 1, transfers: {}, acks: {}, reports: {} };
    const peers = {};
    const memory = { warMode: {}, creeps: {} };
    const transport = { getLocalShardState: () => local, readRemoteShardState: shard => peers[shard], markShardStateDirty() {}, flushInterShardMemory: () => true };
    const loader = createSourceLoader({
        globals: {
            Game: game, Memory: memory, RESOURCE_ENERGY: 'energy',
            WORK: 'work', CARRY: 'carry', MOVE: 'move', CLAIM: 'claim', ATTACK: 'attack', HEAL: 'heal', TOUGH: 'tough', RANGED_ATTACK: 'ranged_attack',
            FIND_SOURCES: 'sources', FIND_DROPPED_RESOURCES: 'dropped', FIND_MY_CONSTRUCTION_SITES: 'my-sites', FIND_CONSTRUCTION_SITES: 'sites',
            FIND_STRUCTURES: 'structures', FIND_MY_STRUCTURES: 'my-structures', FIND_MY_SPAWNS: 'my-spawns',
            FIND_CREEPS: 'creeps', FIND_MY_CREEPS: 'my-creeps', FIND_POWER_CREEPS: 'power-creeps',
            TERRAIN_MASK_WALL: 1, LOOK_STRUCTURES: 'look-structures', LOOK_CREEPS: 'look-creeps', LOOK_POWER_CREEPS: 'look-power',
            STRUCTURE_SPAWN: 'spawn', STRUCTURE_EXTENSION: 'extension', STRUCTURE_LINK: 'link', STRUCTURE_STORAGE: 'storage', STRUCTURE_CONTAINER: 'container', STRUCTURE_TERMINAL: 'terminal', STRUCTURE_RAMPART: 'rampart', STRUCTURE_WALL: 'constructedWall', STRUCTURE_OBSERVER: 'observer', STRUCTURE_PORTAL: 'portal',
            OBSERVER_RANGE: 10, OK: 0, ERR_NO_PATH: -2, ERR_NOT_ENOUGH_RESOURCES: -6, ERR_INVALID_TARGET: -7,
            ERR_NOT_IN_RANGE: -9, ERR_GCL_NOT_ENOUGH: -15, RoomPosition: class { constructor(x, y, roomName) { Object.assign(this, position(x, y, roomName)); } },
        },
        modules: {
            utils: {
                getDistance: (first, second) => Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y)),
                getClosestTarget: (pos, targets) => [...targets].sort((first, second) => pos.getRangeTo(first) - pos.getRangeTo(second))[0],
            },
            './travel': { travelPortalRoute: () => ({ status: 'arrived' }) },
            'shard/travel': { travelPortalRoute: () => ({ status: 'arrived' }) },
            './transport': transport, 'shard/transport': transport,
            role: { isRoleSupported: () => true },
        },
    });
    const capacity = options.capacity ?? 100;
    const store = {
        energy: options.energy ?? 0,
        getCapacity: () => capacity, getUsedCapacity: () => store.energy, getFreeCapacity: () => capacity - store.energy,
    };
    const creep = {
        name: 'mission-unit', id: 'unit-id', my: true, spawning: false, room, pos: position(10, 10, room.name), store,
        memory: { role: { claimer: 'sClaimer', builder: 'sBuilder', hauler: 'sHauler' }[kind], data, working: false },
        owner: { username: 'me' }, ticksToLive: 1400,
        moveTo: (target, options) => { calls.push({ type: 'move', target, options }); return 0; },
        harvest: target => { calls.push({ type: 'harvest', target }); return 0; },
        pickup: target => { calls.push({ type: 'pickup', target }); return 0; },
        build: target => { calls.push({ type: 'build', target }); return 0; },
        repair: target => { calls.push({ type: 'repair', target }); return 0; },
        upgradeController: target => { calls.push({ type: 'upgrade', target }); return 0; },
        claimController: target => { calls.push({ type: 'claim', target }); return options.claimResult ?? 0; },
        attackController: target => { calls.push({ type: 'attack', target }); return 0; },
        transfer: (target, resource, amount) => { calls.push({ type: 'transfer', target, resource, amount }); return options.transferResult ?? 0; },
        withdraw: (target, resource, amount) => { calls.push({ type: 'withdraw', target, resource, amount }); return 0; },
        drop: resource => { calls.push({ type: 'drop', resource }); return 0; },
        say: text => calls.push({ type: 'say', text }),
        getActiveBodyparts: part => kind === 'builder' && part === 'work' ? 1 : 0,
    };
    game.creeps[creep.name] = creep;
    return { loader, game, room, creep, data, objects, memory, local, peers, calls,
        behavior: loader.load('shard/workers').createShardRole(kind)(data) };
}

test('settlement builders gather directly from a Source without Storage or boost dependencies', () => {
    const w = world('builder');
    assert.equal(w.behavior.prepare(w.creep), true);
    w.behavior.source(w.creep);
    assert.equal(w.calls.some(call => call.type === 'harvest' && call.target.id === 'source'), true);
});

test('settlement builders prioritize the first Spawn over nearer secondary construction', () => {
    const w = world('builder', { energy: 100 });
    const road = { id: 'road', structureType: 'road', pos: position(10, 11, w.room.name) };
    const spawn = { id: 'spawn-site', structureType: 'spawn', pos: position(12, 12, w.room.name) };
    w.room.constructionSites.push(road, spawn);
    w.creep.memory.working = true;
    w.behavior.target(w.creep);
    assert.equal(w.calls.find(call => call.type === 'build').target.id, 'spawn-site');
});

test('claimers skip already-owned controllers and never attack enemy controllers', () => {
    const owned = world('claimer');
    owned.behavior.target(owned.creep);
    assert.equal(owned.calls.some(call => call.type === 'claim' || call.type === 'attack'), false);
    const enemy = world('claimer');
    enemy.room.my = false;
    enemy.room.controller.my = false;
    enemy.room.controller.owner = { username: 'someone-else' };
    enemy.behavior.target(enemy.creep);
    assert.equal(enemy.calls.some(call => call.type === 'claim' || call.type === 'attack'), false);
    assert.ok(enemy.data.lastError);
});

test('claim failure due to GCL is retained as an actionable mission error', () => {
    const w = world('claimer', { claimResult: -15 });
    w.room.my = false;
    w.room.controller.my = false;
    w.behavior.target(w.creep);
    assert.equal(w.calls.some(call => call.type === 'claim'), true);
    assert.match(w.data.lastError, /GCL/i);
    assert.notEqual(w.data.done, true);
});

test('hauler loading leaves the configured home reserve and does not mutate real stores for an intent', () => {
    const w = world('hauler', { task: { claim: false, builders: 0, haulers: 1, energyAmount: 1000, sourceEnergyId: 'home-storage' } });
    w.game.shard.name = 'shard0';
    w.data.hopIndex = 0;
    w.data.phase = 'load';
    w.room.name = w.data.task.sourceRoom;
    w.creep.pos = position(10, 10, w.room.name);
    const storage = { id: 'home-storage', my: true, structureType: 'storage', pos: position(10, 11, w.room.name), store: { energy: 10040 } };
    w.room.storage = storage;
    w.objects[storage.id] = storage;
    w.game.rooms = { [w.room.name]: w.room };
    w.behavior.source(w.creep);
    const withdrawal = w.calls.find(call => call.type === 'withdraw');
    assert.ok(withdrawal);
    assert.equal(withdrawal.target.id, storage.id);
    assert.equal(withdrawal.amount, 40);
    assert.equal(storage.store.energy, 10040);
    assert.equal(w.creep.store.energy, 0, 'withdraw is an engine intent; store updates happen on the following tick');
});

test('haulers retain cargo when a target has no receiver and never drop energy', () => {
    const w = world('hauler', { energy: 100, task: { claim: false, builders: 0, haulers: 1, energyAmount: 1000 } });
    w.behavior.target(w.creep);
    assert.equal(w.calls.some(call => call.type === 'drop' || call.type === 'transfer'), false);
    assert.equal(w.creep.store.energy, 100);
    assert.notEqual(w.data.done, true);
});

test('haulers bypass a configured Link receiver and deliver to Storage instead', () => {
    const w = world('hauler', { energy: 100, task: { claim: false, builders: 0, haulers: 1, targetEnergyId: 'controller-link' } });
    const link = { id: 'controller-link', my: true, structureType: 'link', pos: position(10, 11, w.room.name), store: { energy: 0, getFreeCapacity: () => 800 } };
    const storage = { id: 'target-storage', my: true, structureType: 'storage', pos: position(10, 12, w.room.name), store: { energy: 0, getFreeCapacity: () => 10000 } };
    w.room.storage = storage;
    w.objects[link.id] = link;
    w.objects[storage.id] = storage;
    w.behavior.target(w.creep);
    assert.equal(w.calls.find(call => call.type === 'transfer')?.target.id, storage.id);
    assert.equal(w.calls.some(call => call.type === 'transfer' && call.target.id === link.id), false);
    assert.ok(w.data.pendingDelivery, 'normal mission delivery confirmation remains enabled');
});

test('energy delivery is counted only after a later tick confirms cargo loss and return travel resets its route origin', () => {
    const w = world('hauler', { energy: 100, task: { claim: false, builders: 0, haulers: 1, energyAmount: 1000 } });
    const receiver = {
        id: 'target-spawn', my: true, structureType: 'spawn', pos: position(10, 11, w.room.name),
        store: { energy: 0, getFreeCapacity: () => 300 },
    };
    w.room.spawns.push(receiver);
    w.objects[receiver.id] = receiver;
    w.behavior.target(w.creep);
    assert.equal(w.calls.some(call => call.type === 'transfer'), true);
    assert.equal(w.creep.store.energy, 100);
    assert.ok(w.data.pendingDelivery);
    assert.equal(w.memory.shardArrivals?.[w.data.missionId]?.energyDelivered || 0, 0);
    w.behavior.target(w.creep);
    assert.equal(w.memory.shardArrivals?.[w.data.missionId]?.energyDelivered || 0, 0, 'the same tick cannot confirm its own intent');
    w.game.time++;
    w.creep.store.energy = 0;
    w.behavior.target(w.creep);
    assert.equal(w.memory.shardArrivals[w.data.missionId].energyDelivered, 100);
    assert.equal(w.data.pendingDelivery, undefined);
    assert.equal(w.data.phase, 'return');
    assert.equal(w.data.originShard, 'shard1');
    assert.equal(w.data.hopIndex, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(w.data.route)), w.data.task.returnRoute);
    w.behavior.target(w.creep);
    assert.equal(w.memory.shardArrivals[w.data.missionId].energyDelivered, 100, 'confirmed intent is accounted for exactly once');
});

test('a successful transfer intent with unchanged next-tick cargo does not count delivery', () => {
    const w = world('hauler', { energy: 100, task: { claim: false, builders: 0, haulers: 1, energyAmount: 1000 } });
    const receiver = { id: 'receiver', my: true, structureType: 'spawn', pos: position(10, 11, w.room.name), store: { energy: 0, getFreeCapacity: () => 300 } };
    w.room.spawns.push(receiver);
    w.objects[receiver.id] = receiver;
    w.behavior.target(w.creep);
    w.game.time++;
    w.behavior.target(w.creep);
    assert.equal(w.memory.shardArrivals?.[w.data.missionId]?.energyDelivered || 0, 0);
    assert.equal(w.creep.store.energy, 100);
});

test('builders keep a newly claimed controller alive before constructing and upgrade when no sites exist', () => {
    const urgent = world('builder', { energy: 100 });
    urgent.room.controller.ticksToDowngrade = 1;
    urgent.room.constructionSites.push({ id: 'spawn-site', structureType: 'spawn', pos: position(11, 11, urgent.room.name) });
    urgent.behavior.target(urgent.creep);
    assert.equal(urgent.calls.some(call => call.type === 'upgrade'), true);
    assert.equal(urgent.calls.some(call => call.type === 'build'), false);

    const idle = world('builder', { energy: 100 });
    idle.behavior.target(idle.creep);
    assert.equal(idle.calls.some(call => call.type === 'upgrade'), true);
});

test('builders collect available dropped energy before withdrawing or harvesting', () => {
    const w = world('builder');
    w.room.constructionSites.push({ id: 'construction-site', structureType: 'spawn', pos: position(20, 20, w.room.name) });
    const dropped = { id: 'dropped-energy', resourceType: 'energy', amount: 100, pos: position(18, 10, w.room.name) };
    w.room.droppedResources.push(dropped);
    w.room.containers.push({ id: 'container', store: { energy: 1000 }, pos: position(11, 10, w.room.name) });
    w.room.storage = { id: 'storage', store: { energy: 1000 }, pos: position(10, 10, w.room.name) };
    w.behavior.source(w.creep);
    assert.equal(w.calls.find(call => call.type === 'pickup').target.id, dropped.id);
    assert.equal(w.calls.some(call => call.type === 'withdraw' || call.type === 'harvest'), false);
    assert.equal(w.creep.store.energy, 0, 'pickup is an intent and does not fill the Store immediately');
    assert.equal(w.creep.memory.working, false);
});

test('builders pick the nearest useful energy drop and ignore tiny, empty or mineral drops when larger ones exist', () => {
    const w = world('builder');
    w.room.droppedResources.push(
        { id: 'empty-energy', resourceType: 'energy', amount: 0, pos: position(10, 10, w.room.name) },
        { id: 'mineral', resourceType: 'H', amount: 100, pos: position(10, 10, w.room.name) },
        { id: 'far-energy', resourceType: 'energy', amount: 1000, pos: position(15, 10, w.room.name) },
        { id: 'near-energy', resourceType: 'energy', amount: 20, pos: position(11, 10, w.room.name) },
        { id: 'equal-distance-energy', resourceType: 'energy', amount: 1000, pos: position(10, 11, w.room.name) },
    );
    w.behavior.source(w.creep);
    assert.deepEqual(w.calls.map(call => [call.type, call.target?.id]), [['pickup', 'equal-distance-energy']]);
});

test('builders withdraw from the nearest energy container before closer main stores or Sources', () => {
    const w = world('builder');
    w.room.containers.push(
        { id: 'empty-container', store: { energy: 0 }, pos: position(10, 10, w.room.name) },
        { id: 'mineral-container', store: { H: 1000 }, pos: position(10, 10, w.room.name) },
        { id: 'far-container', store: { energy: 1000 }, pos: position(18, 10, w.room.name) },
        { id: 'near-container', store: { energy: 20 }, pos: position(14, 10, w.room.name) },
        { id: 'equal-distance-container', store: { energy: 1000 }, pos: position(10, 14, w.room.name) },
    );
    w.room.storage = { id: 'storage', store: { energy: 1000 }, pos: position(10, 10, w.room.name) };
    w.room.terminal = { id: 'terminal', store: { energy: 1000 }, pos: position(11, 10, w.room.name) };
    w.behavior.source(w.creep);
    assert.deepEqual(w.calls.map(call => [call.type, call.target?.id, call.resource]), [['withdraw', 'near-container', 'energy']]);
    assert.equal(w.creep.store.energy, 0, 'withdraw does not update the real Store in this tick');
});

test('builders fall back to main stores and then harvesting when loose and container energy is unavailable', () => {
    for (const hasStorage of [true, false]) {
        const w = world('builder');
        w.room.droppedResources.push(
            { id: 'empty-energy', resourceType: 'energy', amount: 0, pos: position(10, 10, w.room.name) },
            { id: 'mineral', resourceType: 'H', amount: 100, pos: position(10, 10, w.room.name) },
        );
        w.room.containers.push({ id: 'empty-container', store: { energy: 0, H: 1000 }, pos: position(10, 10, w.room.name) });
        if (hasStorage) w.room.storage = { id: 'storage', store: { energy: 1000 }, pos: position(11, 10, w.room.name) };
        w.behavior.source(w.creep);
        assert.deepEqual(w.calls.map(call => [call.type, call.target?.id]), [hasStorage ? ['withdraw', 'storage'] : ['harvest', 'source']]);
    }
});

test('builders move toward out-of-range loose or container energy without taking a lower-priority energy action', () => {
    for (const looseEnergy of [true, false]) {
        const w = world('builder');
        const container = { id: 'container', store: { energy: 1000 }, pos: position(17, 10, w.room.name) };
        const dropped = { id: 'dropped-energy', resourceType: 'energy', amount: 100, pos: position(18, 10, w.room.name) };
        w.room.containers.push(container);
        if (looseEnergy) w.room.droppedResources.push(dropped);
        w.room.storage = { id: 'storage', store: { energy: 1000 }, pos: position(10, 10, w.room.name) };
        w.creep.pickup = target => { w.calls.push({ type: 'pickup', target }); return -9; };
        w.creep.withdraw = (target, resource) => { w.calls.push({ type: 'withdraw', target, resource }); return -9; };
        w.behavior.source(w.creep);
        const expectedTarget = looseEnergy ? dropped : container;
        assert.deepEqual(w.calls.map(call => [call.type, call.target?.id]), [
            [looseEnergy ? 'pickup' : 'withdraw', expectedTarget.id], ['move', expectedTarget.id],
        ]);
        assert.equal(w.calls[1].options.range, 1);
        assert.equal(w.creep.store.energy, 0);
        assert.equal(w.creep.memory.working, false);
    }
});

test('an 800-capacity settlement builder favors stocked containers over tiny drops, useful drops first, and retains tiny fallback', () => {
    for (const mode of ['stocked', 'useful-drop', 'tiny-only']) {
        const w = world('builder', { capacity: 800 });
        w.room.constructionSites.push({ id: 'construction-site', structureType: 'spawn', pos: position(20, 20, w.room.name) });
        const tiny = { id: 'tiny', resourceType: 'energy', amount: 6, pos: position(10, 11, w.room.name) };
        w.room.droppedResources.push(tiny);
        if (mode !== 'tiny-only') w.room.containers.push({ id: 'stocked', store: { energy: 2000 }, pos: position(11, 10, w.room.name) });
        if (mode === 'useful-drop') w.room.droppedResources.push({ id: 'useful', resourceType: 'energy', amount: 50, pos: position(12, 10, w.room.name) });
        w.behavior.source(w.creep);
        assert.deepEqual(w.calls.map(call => [call.type, call.target?.id]), [
            mode === 'stocked' ? ['withdraw', 'stocked'] : ['pickup', mode === 'useful-drop' ? 'useful' : 'tiny'],
        ], mode);
        assert.equal(w.creep.store.energy, 0, 'an accepted acquisition intent does not immediately update cargo');
        assert.equal(w.creep.memory.working, false);
    }
});

test('settlement builders work at 80 percent or after 25 ticks of partial loading, including continuous tiny income', () => {
    for (const mode of ['fraction', 'waiting', 'tiny-income']) {
        const w = world('builder', { capacity: 800, energy: mode === 'fraction' ? 640 : mode === 'waiting' ? 80 : 0 });
        w.room.constructionSites.push({ id: 'first-spawn', structureType: 'spawn', pos: position(13, 12, w.room.name) });
        if (mode === 'waiting') w.room.containers.push({ id: 'stocked', store: { energy: 2000 }, pos: position(12, 11, w.room.name) });
        let firstBuildTick;
        for (let tick = 0; tick <= 26; tick++) {
            w.game.time = 10 + tick;
            w.creep.pos = position(11 + tick % 2, 12, w.room.name);
            if (mode === 'tiny-income') w.room.droppedResources = [{ id: `tiny-${tick}`, resourceType: 'energy', amount: tick % 6 + 1, pos: position(11, 11, w.room.name) }];
            const start = w.calls.length;
            w.behavior.source(w.creep);
            const current = w.calls.slice(start);
            if (current.some(call => call.type === 'build')) { firstBuildTick = w.game.time; break; }
            if (mode === 'tiny-income') {
                const pickup = current.find(call => call.type === 'pickup');
                if (pickup) w.creep.store.energy += pickup.target.amount; // Apply the engine's next-tick cargo result explicitly.
            }
        }
        assert.equal(firstBuildTick, mode === 'fraction' ? 10 : mode === 'waiting' ? 35 : 36, mode);
        assert.equal(w.creep.memory.working, true);
        if (mode !== 'fraction') assert.ok(w.creep.store.energy > 0 && w.creep.store.energy < 640);
        w.game.time++;
        w.creep.store.energy = 1;
        const before = w.calls.length;
        w.behavior.target(w.creep);
        assert.deepEqual(w.calls.slice(before).map(call => [call.type, call.target?.id]), [['build', 'first-spawn']], 'working continues with partial cargo until empty');
    }
});

test('settlement builders cool a target after five ticks without real progress and retry it after 25 ticks', () => {
    const w = world('builder', { capacity: 800 });
    w.room.sources = [];
    w.room.containers.push({ id: 'unreached', store: { energy: 2000 }, pos: position(20, 10, w.room.name) });
    w.creep.withdraw = target => { w.calls.push({ type: 'withdraw', target, tick: w.game.time }); return -9; };
    for (let tick = 10; tick <= 15; tick++) { w.game.time = tick; w.behavior.source(w.creep); }
    assert.deepEqual(w.calls.filter(call => call.type === 'withdraw').map(call => call.tick), [10, 11, 12, 13, 14]);
    for (let tick = 16; tick < 40; tick++) { w.game.time = tick; w.behavior.source(w.creep); }
    assert.equal(w.calls.filter(call => call.type === 'withdraw').length, 5, 'OK movement intents without position/cargo changes do not extend the attempt forever');
    w.game.time = 40; w.behavior.source(w.creep);
    assert.equal(w.calls.filter(call => call.type === 'withdraw').at(-1).tick, 40);
    assert.equal(w.creep.store.energy, 0);
});

test('settlement acquisition tries at most four failed candidates per tick and can use a later stock next tick', () => {
    const w = world('builder', { capacity: 800 });
    w.room.constructionSites.push({ id: 'construction-site', structureType: 'spawn', pos: position(20, 20, w.room.name) });
    for (let index = 0; index < 5; index++) w.room.containers.push({ id: `stock-${index}`, store: { energy: 2000 }, pos: position(11 + index, 10, w.room.name) });
    w.creep.withdraw = target => { w.calls.push({ type: 'withdraw', target }); return target.id === 'stock-4' ? 0 : -7; };
    w.behavior.source(w.creep);
    assert.deepEqual(w.calls.map(call => [call.type, call.target?.id]), [0, 1, 2, 3].map(index => ['withdraw', `stock-${index}`]));
    w.game.time++;
    const before = w.calls.length;
    w.behavior.source(w.creep);
    assert.deepEqual(w.calls.slice(before).map(call => [call.type, call.target?.id]), [['withdraw', 'stock-4']]);
    assert.equal(w.creep.store.energy, 0);
});

test('claimers respect foreign reservations while allowing their own reservation', () => {
    const enemy = world('claimer');
    enemy.room.controller.my = false;
    enemy.room.controller.reservation = { username: 'other-player' };
    enemy.behavior.target(enemy.creep);
    assert.equal(enemy.calls.some(call => call.type === 'claim' || call.type === 'attack'), false);
    assert.ok(enemy.data.lastError);

    const own = world('claimer');
    own.room.controller.my = false;
    own.room.controller.reservation = { username: 'me' };
    own.behavior.target(own.creep);
    assert.equal(own.calls.some(call => call.type === 'claim'), true);
    assert.equal(own.calls.some(call => call.type === 'attack'), false);
    assert.notEqual(own.data.done, true, 'a claim intent is not yet confirmed ownership');
});

test('haulers wait for target ownership before transferring to even a configured receiver', () => {
    const w = world('hauler', { energy: 100, task: { targetEnergyId: 'enemy-storage' } });
    w.room.controller.my = false;
    w.objects['enemy-storage'] = {
        id: 'enemy-storage', my: true, structureType: 'storage', pos: position(10, 11, w.room.name),
        store: { energy: 0, getFreeCapacity: () => 1000 },
    };
    w.behavior.target(w.creep);
    assert.equal(w.calls.some(call => call.type === 'transfer' || call.type === 'drop'), false);
    assert.equal(w.data.pendingDelivery, undefined);
    assert.equal(w.creep.store.energy, 100);
});

function home(w, energy = 20000) {
    w.game.shard.name = w.data.task.sourceShard;
    w.room.name = w.data.task.sourceRoom;
    w.creep.pos = position(10, 10, w.room.name);
    w.room.storage = { id: 'home-storage', my: true, structureType: 'storage', pos: position(10, 11, w.room.name), store: { energy } };
    w.objects['home-storage'] = w.room.storage;
    w.game.rooms = { [w.room.name]: w.room };
}

test('pausing a mission stops further source loading until it is resumed', () => {
    const w = world('hauler');
    home(w);
    w.data.phase = 'load';
    w.memory.shardMissions = { [w.data.missionId]: { state: 'paused' } };
    w.behavior.source(w.creep);
    assert.equal(w.calls.some(call => call.type === 'withdraw'), false);
    assert.equal(w.data.loadStarted, undefined);
    assert.notEqual(w.data.done, true);
    w.memory.shardMissions[w.data.missionId].state = 'active';
    w.game.time++;
    w.behavior.source(w.creep);
    assert.equal(w.calls.some(call => call.type === 'withdraw'), true);
});

test('returned haulers stop loading after source mission completion or cancellation', () => {
    for (const state of ['complete', 'cancelled']) {
        const w = world('hauler');
        home(w);
        Object.assign(w.data, { phase: 'return', originShard: w.data.task.targetShard, route: w.data.task.returnRoute, hopIndex: w.data.task.returnRoute.length });
        w.memory.shardMissions = { [w.data.missionId]: { state } };
        w.behavior.source(w.creep);
        assert.equal(w.data.phase, 'load');
        w.game.time++;
        w.behavior.source(w.creep);
        assert.equal(w.data.phase, 'done');
        assert.equal(w.data.done, true);
        assert.equal(w.calls.some(call => call.type === 'withdraw' || call.type === 'drop'), false);
    }
});

test('haulers confirm only the cargo actually accepted and count it once', () => {
    const w = world('hauler', { energy: 100 });
    w.room.spawns.push({ id: 'receiver', my: true, structureType: 'spawn', pos: position(11, 10, w.room.name), store: { getFreeCapacity: () => 100 } });
    w.behavior.target(w.creep);
    w.room.spawns.length = 0;
    w.game.time++;
    w.creep.store.energy = 70;
    w.behavior.target(w.creep);
    assert.equal(w.memory.shardArrivals[w.data.missionId].energyDelivered, 30);
    assert.equal(w.data.pendingDelivery, undefined);
    w.behavior.target(w.creep);
    assert.equal(w.memory.shardArrivals[w.data.missionId].energyDelivered, 30);
    assert.equal(w.creep.store.energy, 70);
});

test('a rejected transfer intent never credits delivery', () => {
    const w = world('hauler', { energy: 100, transferResult: -9 });
    w.room.spawns.push({ id: 'receiver', my: true, structureType: 'spawn', pos: position(11, 10, w.room.name), store: { getFreeCapacity: () => 100 } });
    w.behavior.target(w.creep);
    assert.equal(w.data.pendingDelivery, undefined);
    assert.equal(w.calls.some(call => call.type === 'move'), true);
    w.game.time++;
    w.creep.store.energy = 0;
    w.behavior.target(w.creep);
    assert.equal(w.memory.shardArrivals?.[w.data.missionId]?.energyDelivered || 0, 0);
});

test('multiple haulers share same-tick withdrawal reservations and preserve the home reserve', () => {
    const w = world('hauler', { task: { claim: false, builders: 0, haulers: 2 } });
    home(w, 10040);
    w.data.phase = 'load';
    const secondStore = { energy: 0, getCapacity: () => 100, getFreeCapacity: () => 100 };
    const second = { ...w.creep, name: 'second-hauler', id: 'second-id', store: secondStore,
        memory: { ...w.creep.memory, data: JSON.parse(JSON.stringify(w.data)) } };
    w.game.creeps[second.name] = second;
    const secondBehavior = w.loader.load('shard/workers').createShardRole('hauler')(second.memory.data);
    w.behavior.source(w.creep);
    secondBehavior.source(second);
    assert.equal(w.calls.filter(call => call.type === 'withdraw').reduce((total, call) => total + call.amount, 0), 40);
    assert.equal(w.room.storage.store.energy, 10040, 'reservation does not edit the engine store');
    w.game.time++;
    w.behavior.source(w.creep);
    secondBehavior.source(second);
    assert.equal(w.calls.filter(call => call.type === 'withdraw').reduce((total, call) => total + call.amount, 0), 80, 'reservations clear on the next tick');
});

test('same-tick haulers cannot overdraw a configured source store even when other stores hold energy', () => {
    const w = world('hauler', { task: { claim: false, builders: 0, haulers: 2, homeEnergyReserve: 0, sourceEnergyId: 'home-storage' } });
    home(w, 40);
    w.room.containers.push({ id: 'container', pos: position(12, 10, w.room.name), store: { energy: 200 } });
    w.data.phase = 'load';
    const second = { ...w.creep, name: 'second-hauler', id: 'second-id',
        store: { energy: 0, getCapacity: () => 100, getFreeCapacity: () => 100 },
        memory: { ...w.creep.memory, data: JSON.parse(JSON.stringify(w.data)) } };
    w.game.creeps[second.name] = second;
    const secondBehavior = w.loader.load('shard/workers').createShardRole('hauler')(second.memory.data);
    w.behavior.source(w.creep);
    secondBehavior.source(second);
    assert.equal(w.calls.filter(call => call.type === 'withdraw').reduce((total, call) => total + call.amount, 0), 40);
});

test('target haulers skip enemy Spawn and Storage and can deliver to a neutral Container', () => {
    const w = world('hauler', { energy: 100, task: { targetEnergyId: 'enemy-spawn' } });
    const enemySpawn = { id: 'enemy-spawn', my: false, structureType: 'spawn', pos: position(10, 10, w.room.name), store: { getFreeCapacity: () => 300 } };
    const enemyStorage = { id: 'enemy-storage', my: false, structureType: 'storage', pos: position(10, 11, w.room.name), store: { getFreeCapacity: () => 1000 } };
    const neutralContainer = { id: 'neutral-container', structureType: 'container', pos: position(11, 11, w.room.name), store: { getFreeCapacity: () => 1000 } };
    w.objects[enemySpawn.id] = enemySpawn;
    w.room.spawns.push(enemySpawn);
    w.room.storage = enemyStorage;
    w.room.containers.push(neutralContainer);
    w.behavior.target(w.creep);
    assert.equal(w.calls.find(call => call.type === 'transfer').target.id, neutralContainer.id);
});

test('builders gather from a Source instead of withdrawing enemy Storage', () => {
    const w = world('builder');
    w.room.storage = { id: 'enemy-storage', my: false, structureType: 'storage', pos: position(10, 10, w.room.name), store: { energy: 1000 } };
    w.behavior.source(w.creep);
    assert.equal(w.calls.some(call => call.type === 'withdraw'), false);
    assert.equal(w.calls.some(call => call.type === 'harvest'), true);
});

test('builders fill an owned Extension instead of a nearer enemy Spawn after reaching the target level', () => {
    const w = world('builder', { energy: 100 });
    w.room.controller.level = w.data.task.targetLevel;
    w.room.spawns.push({ id: 'enemy-spawn', my: false, structureType: 'spawn', pos: position(10, 10, w.room.name), store: { getFreeCapacity: () => 300 } });
    w.room.extensions.push({ id: 'owned-extension', my: true, structureType: 'extension', pos: position(11, 11, w.room.name), store: { getFreeCapacity: () => 50 } });
    w.behavior.target(w.creep);
    assert.equal(w.calls.find(call => call.type === 'transfer').target.id, 'owned-extension');
});

test('a source-shard pause or cancellation command prevents an arrived claimer from claiming', () => {
    for (const state of ['paused', 'cancelled']) {
        const w = world('claimer');
        w.room.controller.my = false;
        w.peers.shard0 = { version: 1, transfers: {}, acks: {}, reports: { [w.data.missionId]: { type: 'command', state, task: w.data.task, updatedAt: Date.now() } } };
        w.behavior.target(w.creep);
        assert.equal(w.calls.some(call => call.type === 'claim' || call.type === 'attack'), false);
        assert.ok(w.data.lastError);
    }
});

test('malformed mission data and mismatched worker kinds produce no engine actions', () => {
    const malformed = [
        data => { data.missionId = 'unrelated'; },
        data => { delete data.task.targetRoom; },
        data => { data.task.homeEnergyReserve = '10000'; },
        data => { data.unitKind = 'claimer'; },
    ];
    for (const mutate of malformed) {
        const w = world('builder');
        mutate(w.data);
        assert.equal(w.behavior.prepare(w.creep), false);
        assert.equal(w.behavior.source(w.creep), false);
        assert.deepEqual(w.calls, []);
    }
});

/** One isolated runtime switches between independent shard clocks and Memory. Only engine intents are simulated. */
function integratedWorld() {
    const bus = new Map();
    const clock = { now: 1000000 };
    const calls = [];
    const frames = {};
    const route = task().route;
    const returnRoute = task().returnRoute;

    function room(name, owned, level) {
        return {
            name, my: owned, level, memory: { creepConfig: {} }, energyCapacityAvailable: 3000, energyAvailable: 3000,
            sources: [], constructionSites: [], spawns: [], extensions: [], containers: [], structuresNeedRepair: [],
            controller: { my: owned, level, ticksToDowngrade: 10000, pos: position(10, 10, name) },
            find(type) {
                if (type === 'my-spawns') return this.spawns;
                if (type === 'sources') return this.sources;
                if (type === 'my-sites') return this.constructionSites;
                return [];
            },
            lookForAt(type, x, y) {
                return [...route, ...returnRoute].filter(hop => hop.roomName === name && hop.x === x && hop.y === y)
                    .map(hop => ({ structureType: 'portal', destination: { shard: hop.destinationShard, room: hop.destinationRoom } }));
            },
        };
    }
    const sourceRoom = room('W1N1', true, 8);
    const targetRoom = room('W2N2', false, 1);
    const sourceSpawn = { id: 'source-spawn', my: true, structureType: 'spawn', pos: position(11, 10, sourceRoom.name), store: { getFreeCapacity: () => 0 } };
    const storage = { id: 'source-storage', my: true, structureType: 'storage', pos: position(9, 11, sourceRoom.name), store: { energy: 20000, getFreeCapacity: () => 10000 } };
    sourceRoom.spawns.push(sourceSpawn);
    sourceRoom.storage = storage;
    const targetSource = { id: 'target-source', energy: 3000, pos: position(10, 11, targetRoom.name) };
    targetRoom.sources.push(targetSource);
    for (const [name, activeRoom, time] of [['shard0', sourceRoom, 100000], ['shard1', targetRoom, 7]]) {
        frames[name] = { time, rooms: { [activeRoom.name]: activeRoom }, creeps: {}, memory: { warMode: {}, creeps: {} }, objects: {} };
    }
    Object.assign(frames.shard0.objects, { [storage.id]: storage, [sourceSpawn.id]: sourceSpawn });
    frames.shard1.objects[targetSource.id] = targetSource;
    const game = { shard: { name: 'shard0' }, structures: {}, cpu: { bucket: 10000, getUsed: () => 0 }, gcl: { level: 10 },
        map: { getRoomStatus: () => ({ status: 'normal' }), getRoomLinearDistance: () => 1, findRoute: () => [] },
        getObjectById: id => frames[game.shard.name].objects[id] };
    class TestDate extends Date { static now() { return clock.now; } }
    const loader = createSourceLoader({
        globals: {
            Game: game, Memory: frames.shard0.memory, Date: TestDate,
            InterShardMemory: {
                getLocal: () => bus.get(game.shard.name) || '',
                getRemote: shard => bus.get(shard) || '',
                setLocal: value => bus.set(game.shard.name, value),
            },
            RoomPosition: class { constructor(x, y, roomName) { Object.assign(this, position(x, y, roomName)); } },
            RESOURCE_ENERGY: 'energy', WORK: 'work', CARRY: 'carry', MOVE: 'move', CLAIM: 'claim', ATTACK: 'attack', HEAL: 'heal', TOUGH: 'tough', RANGED_ATTACK: 'ranged_attack',
            BODYPART_COST: { work: 100, carry: 50, move: 50, claim: 600, attack: 80, heal: 250, tough: 10, ranged_attack: 150 },
            FIND_MY_SPAWNS: 'my-spawns', FIND_SOURCES: 'sources', FIND_DROPPED_RESOURCES: 'dropped', FIND_MY_CONSTRUCTION_SITES: 'my-sites', FIND_STRUCTURES: 'structures', STRUCTURE_OBSERVER: 'observer',
            LOOK_STRUCTURES: 'structures', STRUCTURE_PORTAL: 'portal', STRUCTURE_SPAWN: 'spawn', STRUCTURE_EXTENSION: 'extension', STRUCTURE_LINK: 'link', STRUCTURE_STORAGE: 'storage', STRUCTURE_CONTAINER: 'container', STRUCTURE_TERMINAL: 'terminal', STRUCTURE_RAMPART: 'rampart', STRUCTURE_WALL: 'constructedWall',
            OBSERVER_RANGE: 10, OK: 0, ERR_NOT_IN_RANGE: -9, ERR_GCL_NOT_ENOUGH: -15, ERR_NO_PATH: -2, ERR_TIRED: -11,
        },
        modules: {
            utils: { sha1String: value => createHash('sha1').update(value).digest('hex') },
            role: { isRoleSupported: () => true },
        },
    });
    const policy = loader.load('settings/interShard').interShardPolicy;
    policy.peers = ['shard0', 'shard1'];
    policy.reportInterval = 1;
    const controller = loader.load('shard/controller');
    const transport = loader.load('shard/transport');
    const workers = loader.load('shard/workers');

    function select(shard, advance = false) {
        const frame = frames[shard];
        if (advance) { frame.time++; clock.now += 1000; }
        game.shard.name = shard;
        game.time = frame.time;
        game.rooms = frame.rooms;
        game.creeps = frame.creeps;
        loader.globals.Memory = frame.memory;
        return frame;
    }
    select('shard0');

    function unit(name, activeRoom, initialMemory = {}, energy = 0, pos = position(9, 10, activeRoom.name)) {
        const frame = frames[game.shard.name];
        frame.memory.creeps[name] = JSON.parse(JSON.stringify(initialMemory));
        const store = { energy, getCapacity: () => 100, getUsedCapacity: () => store.energy, getFreeCapacity: () => 100 - store.energy };
        function action(type, target, resource, amount) {
            calls.push({ type, shard: game.shard.name, tick: game.time, name, target, resource, amount });
            return 0;
        }
        const creep = {
            name, id: `${game.shard.name}:${name}`, my: true, spawning: false, ticksToLive: 1400, owner: { username: 'me' }, room: activeRoom, pos, store,
            moveTo: (target, options) => { calls.push({ type: 'move', shard: game.shard.name, tick: game.time, name, target, options }); return 0; },
            harvest: target => action('harvest', target), build: target => action('build', target), upgradeController: target => action('upgrade', target),
            repair: target => action('repair', target), pickup: target => action('pickup', target), claimController: target => action('claim', target),
            attackController: target => action('attack', target), withdraw: (target, resource, amount) => action('withdraw', target, resource, amount),
            transfer: (target, resource, amount) => action('transfer', target, resource, amount), drop: resource => action('drop', undefined, resource),
            getActiveBodyparts: part => part === 'work' && creep.memory.data?.unitKind === 'builder' ? 1 : 0,
        };
        Object.defineProperty(creep, 'memory', { get: () => frame.memory.creeps[name], set: value => { frame.memory.creeps[name] = value; } });
        frame.creeps[name] = creep;
        return creep;
    }
    const behavior = creep => workers.createShardRole(creep.memory.data.unitKind)(creep.memory.data);
    const report = () => { controller.runShardController(); transport.flushInterShardMemory(); };
    function cross(creep, destination, activeRoom, pos = position(10, 10, activeRoom.name)) {
        const from = game.shard.name;
        const role = creep.memory.role;
        const previousMoves = calls.filter(call => call.type === 'move' && call.name === creep.name).length;
        behavior(creep).source(creep);
        assert.ok(creep.memory.data.transferPreparedAt);
        assert.equal(calls.filter(call => call.type === 'move' && call.name === creep.name).length, previousMoves, 'publication happens before stepping into the portal');
        select(from, true);
        report();
        behavior(creep).source(creep);
        assert.equal(calls.filter(call => call.type === 'move' && call.name === creep.name).at(-1).options.range, 0);
        report();
        const energy = creep.store.energy;
        delete frames[from].creeps[creep.name];
        delete frames[from].memory.creeps[creep.name];
        select(from, true);
        report();
        select(destination, true);
        const arriving = unit(creep.name, activeRoom, {}, energy, pos);
        report();
        assert.equal(arriving.memory.role, role);
        assert.equal(arriving.memory.data.hopIndex, 1);
        assert.equal(arriving.memory.data.transferPreparedAt, undefined);
        return arriving;
    }
    function spawnDemand(role) {
        const [name, config] = Object.entries(sourceRoom.memory.creepConfig).find(([, entry]) => entry.role === role);
        return unit(name, sourceRoom, config);
    }
    return { bus, calls, frames, game, clock, loader, controller, transport, select, unit, behavior, report, cross, spawnDemand, sourceRoom, targetRoom, storage, route, returnRoute };
}

test('real two-shard settlement restores claim and builder Memory, builds the first Spawn, and stops dispatch at its goal', () => {
    const w = integratedWorld();
    const message = w.controller.createShardTask({ id: 'settle', sourceRoom: 'W1N1', targetShard: 'shard1', targetRoom: 'W2N2', route: w.route, builders: 1, targetLevel: 1 });
    assert.match(message, /已创建/);
    w.controller.releaseShardCreepConfig();
    const sourceClaimer = w.spawnDemand('sClaimer');
    const sourceBuilder = w.spawnDemand('sBuilder');
    const claimer = w.cross(sourceClaimer, 'shard1', w.targetRoom);
    assert.equal(w.behavior(claimer).prepare(claimer), true);
    w.behavior(claimer).target(claimer);
    assert.equal(w.calls.some(call => call.type === 'claim' && call.shard === 'shard1'), true);
    assert.notEqual(claimer.memory.data.done, true);
    w.targetRoom.controller.my = true;
    w.targetRoom.my = true;
    w.select('shard1', true);
    w.behavior(claimer).target(claimer);
    assert.equal(claimer.memory.data.done, true);
    w.report();

    w.select('shard0', true);
    w.report();
    const mission = w.frames.shard0.memory.shardMissions['shard0:settle'];
    assert.equal(mission.targetOwned, true);
    w.sourceRoom.memory.creepConfig = {};
    w.controller.releaseShardCreepConfig();
    assert.equal(Object.values(w.sourceRoom.memory.creepConfig).some(config => config.role === 'sClaimer'), false);
    const builder = w.cross(sourceBuilder, 'shard1', w.targetRoom);
    w.behavior(builder).source(builder);
    assert.equal(w.calls.some(call => call.type === 'harvest' && call.name === builder.name && call.target.id === 'target-source'), true);
    builder.store.energy = 100;
    const spawnSite = { id: 'first-spawn-site', structureType: 'spawn', pos: position(11, 10, w.targetRoom.name) };
    w.targetRoom.constructionSites.push(spawnSite, { id: 'road-site', structureType: 'road', pos: position(10, 10, w.targetRoom.name) });
    w.select('shard1', true);
    w.behavior(builder).target(builder);
    assert.equal(w.calls.filter(call => call.type === 'build').at(-1).target.id, spawnSite.id);
    w.targetRoom.constructionSites.length = 0;
    w.targetRoom.spawns.push({ id: 'first-spawn', my: true, structureType: 'spawn', pos: spawnSite.pos, store: { getFreeCapacity: () => 0 } });
    w.select('shard1', true);
    w.report();
    w.select('shard0', true);
    w.report();
    assert.equal(mission.state, 'complete');
    w.sourceRoom.memory.creepConfig = {};
    w.controller.releaseShardCreepConfig();
    assert.equal(Object.keys(w.sourceRoom.memory.creepConfig).length, 0);
    assert.equal(w.calls.some(call => call.type === 'attack'), false);
});

test('real two-shard hauling confirms delivery, completes from its report, restores return Memory, and stops loading at home', () => {
    const w = integratedWorld();
    w.targetRoom.controller.my = true;
    w.targetRoom.my = true;
    const targetSpawn = { id: 'target-spawn', my: true, structureType: 'spawn', pos: position(11, 10, w.targetRoom.name), store: { energy: 0, getFreeCapacity: () => 300 } };
    w.targetRoom.spawns.push(targetSpawn);
    w.frames.shard1.objects[targetSpawn.id] = targetSpawn;
    assert.match(w.controller.createShardTask({ id: 'haul', sourceRoom: 'W1N1', targetShard: 'shard1', targetRoom: 'W2N2', route: w.route, returnRoute: w.returnRoute, claim: false, builders: 0, haulers: 1, energyAmount: 100 }), /已创建/);
    w.controller.releaseShardCreepConfig();
    const outbound = w.spawnDemand('sHauler');
    w.behavior(outbound).source(outbound);
    assert.equal(w.calls.filter(call => call.type === 'withdraw').at(-1).amount, 100);
    assert.equal(w.storage.store.energy, 20000);
    assert.equal(outbound.store.energy, 0);
    w.select('shard0', true);
    outbound.store.energy = 100;
    w.storage.store.energy -= 100;
    w.behavior(outbound).source(outbound);
    assert.equal(outbound.memory.data.phase, 'outbound');
    const hauling = w.cross(outbound, 'shard1', w.targetRoom);
    w.behavior(hauling).target(hauling);
    assert.equal(w.calls.filter(call => call.type === 'transfer').at(-1).amount, 100);
    assert.equal(w.frames.shard1.memory.shardArrivals['shard0:haul'].energyDelivered, 0);
    w.select('shard1', true);
    hauling.store.energy = 0;
    targetSpawn.store.energy = 100;
    w.behavior(hauling).target(hauling);
    assert.equal(w.frames.shard1.memory.shardArrivals['shard0:haul'].energyDelivered, 100);
    assert.equal(hauling.memory.data.phase, 'return');
    w.report();
    w.select('shard0', true);
    w.report();
    const mission = w.frames.shard0.memory.shardMissions['shard0:haul'];
    assert.equal(mission.energyDelivered, 100);
    assert.equal(mission.state, 'complete');
    w.sourceRoom.memory.creepConfig = {};
    w.controller.releaseShardCreepConfig();
    assert.equal(Object.keys(w.sourceRoom.memory.creepConfig).length, 0);
    w.select('shard1', true);
    hauling.pos = position(19, 20, w.targetRoom.name);
    const returned = w.cross(hauling, 'shard0', w.sourceRoom);
    assert.equal(returned.memory.data.originShard, 'shard1');
    assert.equal(returned.memory.data.phase, 'return');
    const withdrawalCount = w.calls.filter(call => call.type === 'withdraw').length;
    w.behavior(returned).source(returned);
    assert.equal(returned.memory.data.phase, 'load');
    w.select('shard0', true);
    w.behavior(returned).source(returned);
    assert.equal(returned.memory.data.phase, 'done');
    assert.equal(returned.memory.data.done, true);
    assert.equal(w.calls.filter(call => call.type === 'withdraw').length, withdrawalCount);
    assert.equal(w.calls.some(call => call.type === 'drop'), false);
});
