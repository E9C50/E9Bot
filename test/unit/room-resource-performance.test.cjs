const assert = require('node:assert/strict');
const test = require('node:test');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

const policy = {
    labs: { updateInterval: 10, minimumReactionReagent: 1000 },
    terminal: {
        energyReserve: 50000, centerGhodiumReserve: 6000, maximumSendAmount: 100000,
        energyExportThreshold: 400000, energyImportThreshold: 300000, energyTransferAmount: 50000,
        distributionMinimumLevel: 8, distributionInterval: 30, mineralReserve: 10,
        refillRatio: 0.8, surplusRatio: 1.2
    }
};

function labWorld({ reactionConfig = {}, reactionSource = {}, boostConfig = {}, boostBodyPart = {}, roleBoostConfig = {} } = {}) {
    const game = { time: 10, shard: { name: 'test' }, creeps: {} };
    const logs = [];
    const loader = createSourceLoader({
        globals: { Game: game, LAB_BOOST_MINERAL: 30, MAX_CREEP_SIZE: 50, console: { log: value => logs.push(value) } },
        modules: {
            'settings/labs': { reactionConfig, reactionSource },
            'settings/resourcePolicy': { t3Resources: Object.keys(reactionConfig), basicMinerals: [], ordinaryResourceTarget: () => 0, resourcePolicy: { t3Reserve: 10000 } },
            'room/resourceNetwork': {
                getResourceRooms: () => [room], isWarehouseRoom: () => false,
                getRoomResourceAmount: (room, resource) => {
                    let amount = (room.storage.store[resource] || 0) + (room.terminal.store[resource] || 0);
                    for (const lab of room.labs) amount += lab.store[resource] || 0;
                    for (const creep of loader.load('runtime/creepIndex').getRoomProcessors(room.name)) amount += creep.store[resource] || 0;
                    return amount;
                },
                getAvailableResource: () => 0, getGlobalResourceAmount: () => 0,
                getIncomingResourceAmount: () => 0, getOutgoingResourceAmount: () => 0, requestRoomResource: () => 0,
            },
            'settings/boost': { boostConfig, boostBodyPart, roleBoostConfig },
            'settings/creep': { roleAdvEnum: { PROCESSER: 'processer' } },
            'settings/roomPolicy': { roomPolicy: policy }
        }
    });
    const room = {
        name: 'W1N1', labs: [], storage: { store: {} }, terminal: { store: {} },
        memory: { boostNeed: {}, roomLabConfig: { sourceLab1: 'source1', sourceLab2: 'source2', singleLabConfig: {} } },
        getResource(resource, storage = true, terminal = false, labs = false, processor = false) {
            let amount = storage ? this.storage.store[resource] || 0 : 0;
            if (terminal) amount += this.terminal.store[resource] || 0;
            if (labs) for (const lab of this.labs) amount += lab.store[resource] || 0;
            if (processor) for (const creep of Object.values(game.creeps)) {
                if (creep.room.name === this.name && creep.memory.role === 'processer') amount += creep.store[resource] || 0;
            }
            return amount;
        }
    };
    return { game, room, logs, ...loader.load('room/labs') };
}

test('lab configuration refreshes each room once per period while daily boost demand is still fresh', () => {
    const w = labWorld({ reactionConfig: { product: 10000 } });
    const names = ['E31N2', 'E34N3', 'E35N1', 'E35N3', 'E36N2', 'E37N7', 'E38N5', 'E38N6', 'E41N7', 'E41N8', 'E37N5'];
    const updates = new Map(names.map(name => [name, 0])), perTick = [];
    let current;
    const rooms = names.map(name => ({ ...w.room, name, labs: [{ store: {} }],
        storage: { store: store({}, () => { updates.set(name, updates.get(name) + 1); current++; }) },
        memory: { boostNeed: { stale: 100 }, roomLabConfig: { sourceLab1: 'source1', sourceLab2: 'source2', singleLabConfig: {} } },
    }));
    policy.labs.staggerUpdates = true;
    try {
        for (let tick = 1; tick <= 10; tick++) {
            w.game.time = tick; current = 0;
            for (const room of rooms) {
                room.memory.boostNeed.stale = 100;
                w.updateLabBoostConfig(room); w.updateLabReactionConfig(room);
                assert.deepEqual({ ...room.memory.boostNeed }, {});
            }
            perTick.push(current);
        }
        assert.deepEqual([...updates.values()], Array(names.length).fill(1));
        assert.ok(Math.max(...perTick) < names.length / 2, 'eleven rooms no longer perform the costly refresh on the same tick');
    } finally { delete policy.labs.staggerUpdates; }
});

function store(values = {}, onRead = () => {}) {
    return new Proxy(values, { get: (target, resource) => {
        onRead(resource);
        return target[resource] || 0;
    } });
}

test('reaction checks scan the empire once and reuse repeated reagents within one update', () => {
    const reactionConfig = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`product${index}`, 10000]));
    const reactionSource = Object.fromEntries(Object.keys(reactionConfig).map(resource => [resource, ['shared', 'other']]));
    const world = labWorld({ reactionConfig, reactionSource });
    let creepEnumerations = 0;
    world.game.creeps = new Proxy(world.game.creeps, {
        ownKeys(target) { creepEnumerations++; return Reflect.ownKeys(target); }
    });
    let creepRoomReads = 0;
    let sharedLabReads = 0;
    world.room.labs = [{ id: 'source1', store: store({}, resource => { if (resource === 'shared') sharedLabReads++; }) }];
    world.room.storage.store = store();
    for (let index = 0; index < 200; index++) {
        world.game.creeps[`unit${index}`] = {
            get room() { creepRoomReads++; return { name: index < 100 ? world.room.name : 'W9N9' }; },
            memory: { role: index < 3 ? 'processer' : 'filler' }, store: store()
        };
    }
    // Measure the previous query workload against exactly the same mocked game snapshot.
    for (const resource of Object.keys(reactionConfig)) {
        if (world.room.getResource(resource, true, false, true, true) >= reactionConfig[resource]) continue;
        world.room.getResource('shared', true, false, true, true);
    }
    assert.equal(creepRoomReads, 3200);
    assert.equal(creepEnumerations, 16);
    assert.equal(sharedLabReads, 8);
    creepRoomReads = 0;
    creepEnumerations = 0;
    sharedLabReads = 0;
    world.updateLabReactionConfig(world.room);
    assert.equal(world.room.memory.roomLabConfig.labReactionConfig, undefined);
    assert.equal(creepRoomReads, 3, 'only processor memberships need their room read after one empire enumeration');
    assert.equal(creepEnumerations, 1);
    assert.equal(sharedLabReads, 1);
    assert.equal(world.logs.length, 0);
    world.game.time += 10;
    world.room.storage.store.shared = 3000;
    world.room.storage.store.other = 3000;
    world.updateLabReactionConfig(world.room);
    assert.equal(world.room.memory.roomLabConfig.labReactionConfig, 'product0', 'a later tick must read fresh stores');
    assert.equal(creepRoomReads, 6);
    assert.equal(creepEnumerations, 2);
});

test('reaction retention counts product and reagents in storage, terminal, labs and local processors', () => {
    const world = labWorld({ reactionConfig: { product: 10000 }, reactionSource: { product: ['first', 'second'] } });
    world.room.memory.roomLabConfig.labReactionConfig = 'product';
    world.room.storage.store = store({ first: 500 });
    world.room.terminal.store = store({ second: 99999 });
    world.room.labs = [{ id: 'source1', store: store({ product: 9000, first: 501, second: 700 }) }];
    world.game.creeps.processor = { room: { name: world.room.name }, memory: { role: 'processer' }, store: store({ second: 301 }) };
    world.game.creeps.filler = { room: { name: world.room.name }, memory: { role: 'filler' }, store: store({ second: 99999 }) };
    world.game.creeps.remote = { room: { name: 'W9N9' }, memory: { role: 'processer' }, store: store({ second: 99999 }) };
    world.updateLabReactionConfig(world.room);
    assert.equal(world.room.memory.roomLabConfig.labReactionConfig, 'product');
    assert.equal(world.logs.length, 0);
    world.game.time += 10;
    world.game.creeps.processor.store.second = 300;
    world.updateLabReactionConfig(world.room);
    assert.equal(world.room.memory.roomLabConfig.labReactionConfig, 'product', 'terminal stock remains usable when a processor unloads');
    world.game.time += 10;
    world.room.labs[0].store.first = 499;
    world.updateLabReactionConfig(world.room);
    assert.equal(world.room.memory.roomLabConfig.labReactionConfig, undefined, 'an unavailable base reagent cannot support the pending batch');
});

test('boost updates count each unboosted body part once and track lab reassignment accurately', () => {
    const boostConfig = { boostBuild: ['B1', 'B2', 'B3'], boostUpgrade: ['U1', 'U2', 'U3'], boostMove: ['M1', 'M2', 'M3'] };
    const world = labWorld({
        boostConfig, boostBodyPart: { boostBuild: 'work', boostUpgrade: 'work', boostMove: 'move' },
        roleBoostConfig: { attacker: ['boostBuild', 'boostUpgrade', 'boostMove'] }
    });
    let partReads = 0;
    const body = ['work', 'work', 'move', 'work', 'carry'].map((type, index) => ({
        get type() { partReads++; return type; }, boost: index === 3 ? 'alreadyBoosted' : undefined,
        hits: index === 1 ? 0 : 100
    }));
    world.game.creeps.unit = { room: { name: world.room.name }, memory: { role: 'attacker' }, body };
    world.room.storage.store = store({ B3: 1000, U3: 1000, M3: 1000 });
    world.room.labs = ['source1', 'source2', 'first', 'second', 'third'].map(id => ({ id, store: store() }));
    world.room.memory.roomLabConfig.singleLabConfig.first = { boostMode: false, boostType: 'boostUpgrade', resourceType: 'U3' };
    for (const type of ['work', 'work', 'move']) body.filter(part => part.type === type && !part.boost);
    assert.equal(partReads, 15, 'measure the previous one-filter-per-boost-type workload');
    partReads = 0;
    world.updateLabBoostConfig(world.room);
    assert.equal(partReads, 3, 'boosted and destroyed parts need no type reads; old three filters read 15 types');
    assert.deepEqual({ ...world.room.memory.boostNeed }, { B3: 30, M3: 30 }, 'one live WORK gets one selected action boost');
    const assigned = world.room.memory.roomLabConfig.singleLabConfig;
    assert.equal(assigned.first.boostType, 'boostBuild');
    assert.equal(assigned.second.boostType, 'boostMove', 'the second lab serves a distinct body type instead of counting WORK again');
    assert.equal(assigned.third, undefined);
    assert.equal(assigned.source1, undefined);
    assert.equal(assigned.source2, undefined);
});

function terminalWorld() {
    const game = { time: 30, shard: { name: 'shard3' }, rooms: {}, creeps: {}, market: { calcTransactionCost: amount => Math.ceil(amount / 10) } };
    const memory = { centerStorage: 'W0N0' };
    const queued = [];
    const loader = createSourceLoader({
        globals: { Game: game, Memory: memory, RESOURCE_ENERGY: 'energy', RESOURCE_GHODIUM: 'G', OK: 0, console: { log() {} } },
        modules: { 'settings/room': { defaultAutoResource: {} }, 'settings/roomPolicy': { roomPolicy: policy } }
    });
    function addRoom(name, resources = {}, overrides = {}) {
        const room = {
            name, my: true, level: 8, controller: { my: true, isPowerEnabled: name === 'W0N0' },
            storage: { store: { ...resources, getCapacity: () => name === 'W0N0' ? 8000000 : 1000000, getFreeCapacity: () => 1000000 } },
            terminal: { cooldown: 1, store: { energy: 50000, getCapacity: () => 300000, getFreeCapacity: () => 250000 }, send: () => -6 },
            memory: { terminalSendJob: {}, terminalAmount: {} },
            getResource: resource => resources[resource] || 0,
            sendResource(targetRoom, resourceType, amount) {
                queued.push({ from: name, targetRoom, resourceType, amount });
                this.memory.terminalSendJob[`${name}_${targetRoom}_${resourceType}`] = { targetRoom, resourceType, amount };
                return true;
            }, ...overrides
        };
        game.rooms[name] = room;
        return room;
    }
    return { game, memory, queued, addRoom, ...loader.load('room/terminal'), ...loader.load('room/resourceNetwork') };
}

test('energy balancing cannot overcommit donor stock across several low-energy rooms', () => {
    const world = terminalWorld();
    const donor = world.addRoom('W1N1', { energy: 550000 });
    const reads = {};
    for (const [name, energy] of [['first', 10], ['second', 10], ['third', 100], ['full', 350000]]) {
        reads[name] = 0;
        world.addRoom(name, { energy });
    }
    const unowned = world.addRoom('unowned', {}, { my: false, controller: { my: false } });
    Object.defineProperty(unowned, 'storage', { get() { throw new Error('must skip unowned room'); } });
    world.processTerminalResource(donor);
    assert.ok(world.getOutgoingResourceAmount(donor.name, 'energy') <= 150000);
    for (const name of ['first', 'second', 'third']) assert.ok(world.getIncomingResourceAmount(name, 'energy') <= 50000);
});

test('resource requests index existing queues once instead of rescanning for every resource', () => {
    const resources = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`resource${index}`, 100]));
    const world = terminalWorld();
    const room = world.addRoom('W1N1');
    const center = world.addRoom('W0N0', Object.fromEntries(Object.keys(resources).map(resource => [resource, 1000])));
    let resourceReads = 0;
    for (let index = 0; index < 100; index++) {
        center.memory.terminalSendJob[`existing${index}`] = {
            targetRoom: 'elsewhere', amount: 100,
            get resourceType() { resourceReads++; return `existingResource${index}`; }
        };
    }
    for (const resource of Object.keys(resources)) {
        Object.values(center.memory.terminalSendJob).some(job => job.resourceType === resource && job.targetRoom === room.name);
    }
    assert.equal(resourceReads, 4000, 'measure the previous queue scan for each resource');
    resourceReads = 0;
    for (const resource of Object.keys(resources)) world.requestRoomResource(room, resource, 100);
    assert.equal(Object.keys(center.memory.terminalSendJob).length, 140);
    assert.equal(resourceReads, 100);
    assert(Object.values(center.memory.terminalSendJob).filter(job => job.kind === 'production').every(job => job.targetRoom === room.name && job.amount === 100));
});

test('distribution subtracts existing commitments and preserves manual target/resource jobs', () => {
    const world = terminalWorld();
    const room = world.addRoom('W1N1', { X: 15000, B: 200 }, { mineral: { mineralType: 'X' } });
    const center = world.addRoom('W0N0', { H: 100000 });
    center.memory.terminalSendJob.existing = { targetRoom: room.name, resourceType: 'H', amount: 50 };
    room.memory.terminalSendJob.otherTarget = { targetRoom: 'elsewhere', resourceType: 'B', amount: 50 };
    world.planResourceDistribution();
    assert.equal(world.getIncomingResourceAmount(center.name, 'X'), 5000);
    assert.equal(world.getIncomingResourceAmount(center.name, 'B'), 150);
    assert.equal(world.getIncomingResourceAmount(room.name, 'H'), 10000);
    assert.equal(center.memory.terminalSendJob.existing.amount, 50);
});
