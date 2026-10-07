const assert = require('node:assert/strict');
const test = require('node:test');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

const reactions = {
    XUH2O: ['UH2O', 'X'], UH2O: ['UH', 'OH'], UH: ['U', 'H'],
    XLHO2: ['LHO2', 'X'], LHO2: ['LO', 'OH'], LO: ['L', 'O'], OH: ['H', 'O'],
};

function store(values = {}, capacity = 1000000) {
    const result = { ...values };
    Object.defineProperties(result, {
        getCapacity: { value: () => capacity },
        getUsedCapacity: { value: resource => resource ? result[resource] || 0 : Object.values(result).reduce((sum, x) => sum + x, 0) },
        getFreeCapacity: { value: () => capacity - Object.values(result).reduce((sum, x) => sum + x, 0) },
    });
    return result;
}

function world() {
    const game = { time: 10, shard: { name: 'test' }, rooms: {}, creeps: {} }, objects = {};
    game.getObjectById = id => objects[id] || null;
    const loader = createSourceLoader({
        globals: { Game: game, LAB_BOOST_MINERAL: 30, LAB_REACTION_AMOUNT: 5, PWR_OPERATE_LAB: 5, OK: 0, ERR_NOT_IN_RANGE: -9,
            POWER_INFO: { 5: { effect: [2, 4, 6, 8, 10] } }, console: { log() {} } },
        modules: {
            'settings/labs': { reactionSource: reactions }, 'settings/boost': { boostConfig: {} },
            'settings/resourcePolicy': {
                ...createSourceLoader().load('settings/resourcePolicy'), t3Resources: ['XUH2O', 'XLHO2'],
            },
            'settings/roomPolicy': { roomPolicy: { labs: { updateInterval: 10, staggerUpdates: false } } },
            'runtime/cpuRecovery': { cpuRecoveryInterval: (_, normal) => normal, hasPendingRoomBoost: () => false },
            'runtime/creepIndex': { getRoomProcessors: () => [] },
            'creep/boosting': { getRoomBoostRequests: () => [], usableBoostLabs: () => [] },
            'room/factory': { runFactoryLogistics: () => false },
        },
    });
    function addRoom(name, values = {}, warehouse = false) {
        const resources = { ...values };
        if (!warehouse) for (const resource of ['H', 'O', 'U', 'L', 'K', 'Z', 'X', 'G'])
            resources[resource] = 10000 + (values[resource] || 0);
        const room = {
            name, my: true, controller: { my: true, level: 8, isPowerEnabled: warehouse },
            storage: { store: store(resources, warehouse ? 8000000 : 1000000) },
            terminal: { my: true, cooldown: 0, store: store({}, 300000) },
            memory: { boostNeed: {}, terminalSendJob: {}, roomFillJob: {}, roomLabConfig: {
                sourceLab1: `${name}-one`, sourceLab2: `${name}-two`, singleLabConfig: {},
            } },
            labs: ['one', 'two', 'output'].map(suffix => ({ id: `${name}-${suffix}`, store: store({}, 3000) })),
        };
        for (const lab of room.labs) objects[lab.id] = lab;
        game.rooms[name] = room;
        return room;
    }
    const labs = loader.load('room/labs');
    return { game, addRoom, update: room => labs.updateLabReactionConfig(room), loader };
}

test('ordinary labs replenish a local T3 shortage before a globally scarcer full local compound', () => {
    const w = world(), room = w.addRoom('W1N1', { XUH2O: 19000, XLHO2: 20000, UH2O: 3000, LHO2: 3000, X: 6000 });
    w.addRoom('W2N2', { XUH2O: 50000 }, true);
    w.update(room);
    assert.equal(room.memory.roomLabConfig.labReactionConfig, 'XUH2O');
    assert.equal(room.memory.roomLabConfig.productionPlan.targetAmount, 20000);
    assert.equal(room.memory.roomLabConfig.reactionAmount, 1000);
    assert.equal(room.memory.productionReserve.lab.UH2O, 1000);
});

test('full ordinary rooms and warehouse rooms select the globally least stocked T3', () => {
    const w = world(), room = w.addRoom('W1N1', { XUH2O: 20000, XLHO2: 20000, UH2O: 3000, LHO2: 3000, X: 6000 });
    const warehouse = w.addRoom('W2N2', { XUH2O: 10000, LHO2: 3000, X: 3000 }, true);
    w.update(room);
    assert.equal(room.memory.roomLabConfig.productionPlan.target, 'XLHO2');
    assert.equal(room.memory.roomLabConfig.productionPlan.local, false);
    w.update(warehouse);
    assert.equal(warehouse.memory.roomLabConfig.productionPlan.target, 'XLHO2', 'warehouse own zero T3 stock does not create a local reserve target');
});

test('ready warehouse T2 is imported directly once while a terminal is cooling', () => {
    const w = world(), room = w.addRoom('W1N1', { XLHO2: 20000, X: 3000 });
    const warehouse = w.addRoom('W2N2', { UH2O: 3000 }, true);
    warehouse.terminal.cooldown = 9;
    for (let tick = 10; tick <= 40; tick += 10) { w.game.time = tick; w.update(room); }
    assert.equal(room.memory.roomLabConfig.labReactionConfig, 'XUH2O');
    assert.deepEqual(Object.values(warehouse.memory.terminalSendJob).map(job => ({ resource: job.resourceType, amount: job.amount })),
        [{ resource: 'UH2O', amount: 3000 }]);
    assert.equal(room.memory.productionReserve.lab.UH2O, 3000);
    assert.equal(room.memory.productionReserve.lab.H, undefined, 'existing T2 avoids redoing its base recipe');
});

test('warehouse T1 skips base synthesis and the final plan advances through T2 to T3', () => {
    const w = world(), room = w.addRoom('W1N1', { XLHO2: 20000, OH: 3000, X: 3000 });
    const warehouse = w.addRoom('W2N2', { UH: 3000 }, true);
    w.update(room);
    assert.equal(room.memory.roomLabConfig.labReactionConfig, 'UH2O');
    assert.equal(Object.values(warehouse.memory.terminalSendJob)[0].resourceType, 'UH');
    assert.equal(room.memory.productionReserve.lab.U, undefined);
    warehouse.memory.terminalSendJob = {};
    delete room.storage.store.OH;
    room.storage.store.UH2O = 3000;
    w.game.time += 10;
    w.update(room);
    assert.equal(room.memory.roomLabConfig.labReactionConfig, 'XUH2O');
    assert.equal(room.memory.roomLabConfig.productionPlan.targetAmount, 3000);
});

test('recursive recipes allocate repeated H requirements once and refuse an impossible complete chain', () => {
    const w = world(), room = w.addRoom('W1N1', { XLHO2: 20000, U: 3000, H: 6000, O: 3000, X: 3000 });
    w.update(room);
    assert.equal(room.memory.roomLabConfig.labReactionConfig, 'UH');
    assert.equal(room.memory.productionReserve.lab.H, 6000, 'UH and OH both consume H');
    room.storage.store.H = 13999;
    w.game.time += 10;
    w.update(room);
    assert.equal(room.memory.roomLabConfig.labReactionConfig, undefined);
    assert.equal(room.memory.productionReserve.lab, undefined);
});

test('other rooms committed raw materials and pending outgoing stock cannot be reused for production', () => {
    const w = world(), room = w.addRoom('W1N1', { XLHO2: 20000, X: 3000 });
    const warehouse = w.addRoom('W2N2', { UH2O: 3000 }, true);
    warehouse.memory.productionReserve = { lab: { UH2O: 3000 } };
    w.update(room);
    assert.equal(room.memory.roomLabConfig.labReactionConfig, undefined);
    warehouse.memory.productionReserve = {};
    room.storage.store.UH2O = 3000;
    room.memory.terminalSendJob.old = { targetRoom: warehouse.name, resourceType: 'UH2O', amount: 3000 };
    warehouse.storage.store.UH2O = 0;
    w.game.time += 10;
    w.update(room);
    assert.equal(room.memory.roomLabConfig.labReactionConfig, undefined);
});

test('Lab imports an extra 3000 raw mineral instead of consuming an ordinary rooms 10000 reserve', () => {
    const w = world(), room = w.addRoom('W1N1', { XLHO2: 20000, UH2O: 3000 });
    const warehouse = w.addRoom('W2N2', { X: 3000 }, true);
    w.update(room);
    assert.equal(room.storage.store.X, 10000);
    assert.equal(room.memory.roomLabConfig.labReactionConfig, 'XUH2O');
    assert.deepEqual(Object.values(warehouse.memory.terminalSendJob).map(job => ({ resource: job.resourceType, amount: job.amount })),
        [{ resource: 'X', amount: 3000 }]);
    w.game.time += 10;
    w.update(room);
    assert.equal(Object.values(warehouse.memory.terminalSendJob)[0].amount, 3000);
    warehouse.memory.terminalSendJob = {};
    warehouse.storage.store.X = 0;
    w.game.time += 10;
    w.update(room);
    assert.equal(room.memory.roomLabConfig.labReactionConfig, undefined, 'without extra mineral the 10000 floor remains protected');
});

test('multiple full rooms include cooking batches when selecting the least stocked global T3', () => {
    const w = world(), values = { XUH2O: 20000, XLHO2: 20000, UH2O: 3000, LHO2: 3000, X: 6000 };
    const first = w.addRoom('W1N1', values), second = w.addRoom('W2N2', values);
    w.update(first); w.update(second);
    assert.equal(first.memory.roomLabConfig.productionPlan.target, 'XUH2O');
    assert.equal(second.memory.roomLabConfig.productionPlan.target, 'XLHO2');
});

test('legacy global batches inflated by exports migrate to at most 3000 remaining output', () => {
    const w = world(), room = w.addRoom('W1N1', { XUH2O: 20000, XLHO2: 20000, UH2O: 7000, X: 7000 });
    room.memory.roomLabConfig.productionPlan = { target: 'XUH2O', targetAmount: 26055, local: false };
    w.update(room);
    assert.equal(room.memory.roomLabConfig.productionPlan.remaining, 3000);
    assert.equal(room.memory.roomLabConfig.productionPlan.targetAmount, 23000);
    assert.equal(room.memory.roomLabConfig.reactionAmount, 3000);
});

test('local batches stop at their stored reserve target if imported final product closes part of the shortage', () => {
    const w = world(), room = w.addRoom('W1N1', { XUH2O: 17000, XLHO2: 20000, UH2O: 3000, X: 3000 });
    w.update(room);
    assert.equal(room.memory.roomLabConfig.productionPlan.targetAmount, 20000);
    assert.equal(room.memory.roomLabConfig.productionPlan.remaining, 3000);
    room.storage.store.XUH2O = 19500;
    w.game.time += 10;
    w.update(room);
    assert.equal(room.memory.roomLabConfig.productionPlan.local, true);
    assert.equal(room.memory.roomLabConfig.productionPlan.targetAmount, 20000);
    assert.equal(room.memory.roomLabConfig.productionPlan.remaining, 500);
    assert.equal(room.memory.roomLabConfig.reactionAmount, 500);
});

test('a global batch completes while every produced unit is exported and then selects the next least stocked T3', () => {
    const w = world(), room = w.addRoom('W1N1', { XUH2O: 20000, XLHO2: 20000, UH2O: 6000, LHO2: 6000, X: 6000 });
    const warehouse = w.addRoom('W2N2', {}, true);
    w.loader.globals.StructureLab = class {};
    w.loader.globals.REACTIONS = { UH2O: { X: 'XUH2O' } };
    const LabExtension = w.loader.load('mount/structure/LabExtension').default;
    const [first, second, output] = room.labs;
    first.mineralType = 'UH2O'; first.store.UH2O = 3000;
    second.mineralType = 'X'; second.store.X = 3000;
    Object.setPrototypeOf(output, LabExtension.prototype);
    output.room = room; output.cooldown = 0;
    const intents = [];
    output.runReaction = () => {
        intents.push(() => {
            first.store.UH2O -= 5; second.store.X -= 5;
            warehouse.storage.store.XUH2O = (warehouse.storage.store.XUH2O || 0) + 5;
        });
        return 0;
    };
    w.update(room);
    assert.equal(room.memory.roomLabConfig.productionPlan.target, 'XUH2O');
    for (let tick = 10; tick < 610; tick++) {
        w.game.time = tick;
        w.update(room);
        output.doWork();
        while (intents.length) intents.shift()();
        assert.equal(room.storage.store.XUH2O, 20000, 'exports keep local stock below the old 23000 completion test');
    }
    assert.equal(warehouse.storage.store.XUH2O, 3000);
    assert.equal(room.memory.roomLabConfig.productionPlan.remaining, 0);
    assert.equal(room.memory.productionReserve.lab, undefined);
    w.game.time = 610;
    w.update(room);
    assert.equal(room.memory.roomLabConfig.productionPlan.target, 'XLHO2');
    assert.equal(room.memory.roomLabConfig.productionPlan.remaining, 3000);
});

test('a one-unit T3 deficit plans a complete native five-unit reaction batch', () => {
    const w = world(), room = w.addRoom('W1N1', { XUH2O: 19999, XLHO2: 20000, UH2O: 5, X: 5 });
    w.update(room);
    assert.equal(room.memory.roomLabConfig.reactionAmount, 5);
    assert.equal(room.memory.roomLabConfig.productionPlan.targetAmount, 20004);
});

test('small deficits respect the larger native batch of an operated output Lab', () => {
    const w = world(), room = w.addRoom('W1N1', { XUH2O: 19999, XLHO2: 20000, UH2O: 15, X: 15 });
    room.labs[2].effects = [{ effect: 5, ticksRemaining: 100, level: 5 }];
    w.update(room);
    assert.equal(room.memory.roomLabConfig.reactionAmount, 15);
    assert.equal(room.memory.roomLabConfig.productionPlan.targetAmount, 20014);
});

test('local factory ingredient reservations are unavailable to Lab production', () => {
    const w = world(), room = w.addRoom('W1N1', { XLHO2: 20000, UH2O: 3000, X: 3000 });
    room.memory.productionReserve = { factory: { UH2O: 3000 } };
    w.update(room);
    assert.equal(room.memory.roomLabConfig.labReactionConfig, undefined);
    assert.equal(room.memory.productionReserve.factory.UH2O, 3000);
});

test('incoming factory and boost ingredients remain reserved instead of satisfying a Lab recipe twice', () => {
    const w = world(), room = w.addRoom('W1N1', { XLHO2: 20000, X: 3000 });
    const warehouse = w.addRoom('W2N2', { UH2O: 6000 }, true);
    room.memory.productionReserve = { factory: { UH2O: 3000 } };
    warehouse.memory.terminalSendJob.existing = { targetRoom: room.name, resourceType: 'UH2O', amount: 3000, kind: 'production' };
    w.update(room);
    assert.equal(room.memory.roomLabConfig.labReactionConfig, 'XUH2O');
    assert.equal(Object.values(warehouse.memory.terminalSendJob).reduce((sum, job) => sum + job.amount, 0), 6000,
        'the factory and lab each require their own 3000-unit batch');
    w.game.time += 10;
    w.update(room);
    assert.equal(Object.values(warehouse.memory.terminalSendJob).reduce((sum, job) => sum + job.amount, 0), 6000,
        'both incoming claims are counted on the next plan instead of requested again');
});

test('recipe changes discard obsolete reagent fill jobs while keeping explicit boosts', () => {
    const w = world(), room = w.addRoom('W1N1', { XLHO2: 20000, UH2O: 3000, X: 3000 });
    room.memory.roomLabConfig.labReactionConfig = 'UH';
    room.memory.roomLabConfig.singleLabConfig.boost = { boostMode: true, resourceType: 'XLHO2' };
    room.memory.roomFillJob.labInMineral = [
        { labId: 'W1N1-one', resourceType: 'U' }, { labId: 'W1N1-two', resourceType: 'X' },
        { labId: 'boost', resourceType: 'XLHO2' },
    ];
    w.update(room);
    assert.deepEqual(Array.from(room.memory.roomFillJob.labInMineral, job => job.resourceType), ['X', 'XLHO2']);
});

test('removed Labs release their recipe and resource reservations without clearing factory needs', () => {
    const w = world(), room = w.addRoom('W1N1', { XLHO2: 20000, UH2O: 3000, X: 3000 });
    w.update(room);
    room.memory.productionReserve.factory = { H: 1000 };
    room.labs = [];
    w.game.time += 10;
    w.update(room);
    assert.equal(room.memory.roomLabConfig.productionPlan, undefined);
    assert.equal(room.memory.roomLabConfig.labReactionConfig, undefined);
    assert.equal(room.memory.productionReserve.lab, undefined);
    assert.equal(room.memory.productionReserve.factory.H, 1000);
});

test('processor fills only the planned reagent batch and retains minerals reserved for boosts', () => {
    const w = world(), room = w.addRoom('W1N1', { UH2O: 1400 });
    room.memory.roomLabConfig.reactionAmount = 1000;
    room.memory.boostNeed.UH2O = 1000;
    room.memory.roomFillJob.labInMineral = [{ labId: 'W1N1-one', resourceType: 'UH2O' }];
    const amounts = [], creep = {
        room, store: store({}), memory: {},
        withdraw: (_, resource, amount) => { amounts.push({ resource, amount }); return 0; },
    };
    w.loader.load('role/adv/RoleAdvProcesser').default({}).source(creep);
    assert.deepEqual(amounts, [{ resource: 'UH2O', amount: 400 }]);
});

test('processor does not reserve boost and factory ingredients again after they reach their structures', () => {
    const w = world(), room = w.addRoom('W1N1', { UH2O: 400 });
    room.memory.roomLabConfig.reactionAmount = 1000;
    room.memory.roomLabConfig.singleLabConfig['W1N1-output'] = { boostMode: true, resourceType: 'UH2O' };
    room.labs[2].store.UH2O = 1000;
    room.factory = { store: store({ UH2O: 1000 }) };
    room.memory.productionReserve = { factory: { UH2O: 1000 } };
    room.memory.boostNeed.UH2O = 1000;
    room.memory.roomFillJob.labInMineral = [{ labId: 'W1N1-one', resourceType: 'UH2O' }];
    const amounts = [], creep = {
        room, store: store({}), memory: {},
        withdraw: (_, resource, amount) => { amounts.push({ resource, amount }); return 0; },
    };
    w.loader.load('role/adv/RoleAdvProcesser').default({}).source(creep);
    assert.deepEqual(amounts, [{ resource: 'UH2O', amount: 400 }]);
});

test('processor retains the 10000 base mineral and G floor while filling a reaction', () => {
    for (const resource of ['H', 'G']) {
        const w = world(), room = w.addRoom('W1N1', { [resource]: 1000 });
        room.memory.roomLabConfig.reactionAmount = 3000;
        room.memory.roomFillJob.labInMineral = [{ labId: 'W1N1-one', resourceType: resource }];
        const amounts = [], creep = {
            room, store: store({}), memory: {},
            withdraw: (_, type, amount) => { amounts.push({ resource: type, amount }); return 0; },
        };
        w.loader.load('role/adv/RoleAdvProcesser').default({}).source(creep);
        assert.deepEqual(amounts, [{ resource, amount: 1000 }]);
    }
});

test('successful terminal withdrawals use effective inventory and cannot consume the 10000 floor twice in one tick', () => {
    const w = world(), room = w.addRoom('W1N1');
    room.storage.store.H = 0;
    room.terminal.store.H = 13000;
    room.memory.roomLabConfig.reactionAmount = 3000;
    room.memory.roomFillJob.labInMineral = [{ labId: 'W1N1-one', resourceType: 'H' }];
    const amounts = [], creep = {
        room, store: store({}), memory: {},
        withdraw: (_, resource, amount) => { amounts.push({ resource, amount }); return 0; },
    };
    const role = w.loader.load('role/adv/RoleAdvProcesser').default({});
    role.source(creep);
    assert.equal(w.loader.load('room/resourceNetwork').getTerminalResourceAmount(room, 'H'), 10000);
    role.source({ ...creep, memory: {} });
    assert.deepEqual(amounts, [{ resource: 'H', amount: 3000 }]);
});

test('failed terminal withdrawal intents do not debit resource availability', () => {
    const w = world(), room = w.addRoom('W1N1');
    room.storage.store.H = 0;
    room.terminal.store.H = 13000;
    room.memory.roomLabConfig.reactionAmount = 3000;
    room.memory.roomFillJob.labInMineral = [{ labId: 'W1N1-one', resourceType: 'H' }];
    const creep = { room, store: store({}), memory: {}, withdraw: () => -6 };
    w.loader.load('role/adv/RoleAdvProcesser').default({}).source(creep);
    assert.equal(w.loader.load('room/resourceNetwork').getTerminalResourceAmount(room, 'H'), 13000);
    assert.equal(creep.memory.working, undefined);
});

test('storage Lab withdrawals fit a 1650-capacity worker and only deliver after native success', () => {
    const w = world(), room = w.addRoom('W1N1', { UH2O: 3000 });
    room.memory.roomLabConfig.reactionAmount = 3000;
    room.memory.roomFillJob.labInMineral = [{ labId: 'W1N1-one', resourceType: 'UH2O' }];
    const calls = [], creep = {
        room, store: store({}, 1650), memory: {},
        withdraw: (_, resource, amount) => {
            calls.push({ resource, amount });
            return amount > creep.store.getFreeCapacity() ? -8 : 0;
        },
        takeFromTarget(target, resource, amount) { creep.withdraw(target, resource, amount); return true; },
    };
    const role = w.loader.load('role/adv/RoleAdvProcesser').default({});
    role.source(creep);
    assert.deepEqual(calls, [{ resource: 'UH2O', amount: 1650 }]);
    assert.equal(creep.memory.working, true);
    creep.memory.working = false;
    creep.withdraw = () => -6;
    role.source(creep);
    assert.equal(creep.memory.working, false, 'failed native intents leave the worker collecting');
});

test('storage Lab withdrawals move into range and cap a boost request by available stock', () => {
    const w = world(), room = w.addRoom('W1N1', { UH2O: 40 });
    room.memory.roomLabConfig.singleLabConfig['W1N1-one'] = { boostMode: true, resourceType: 'UH2O' };
    room.memory.boostNeed.UH2O = 300;
    room.memory.roomFillJob.labInMineral = [{ labId: 'W1N1-one', resourceType: 'UH2O' }];
    const calls = [], creep = {
        room, store: store({}, 1650), memory: {},
        withdraw: (target, resource, amount) => { calls.push(['withdraw', resource, amount]); return -9; },
        moveTo: target => calls.push(['move', target]),
    };
    w.loader.load('role/adv/RoleAdvProcesser').default({}).source(creep);
    assert.deepEqual(calls, [['withdraw', 'UH2O', 40], ['move', room.storage]]);
    assert.equal(creep.memory.working, undefined);
});

test('an empty processor recovers from a legacy failed withdrawal without dropping pending Lab jobs', () => {
    const w = world(), room = w.addRoom('W1N1', { UH2O: 3000 });
    room.memory.roomFillJob.labInMineral = [{ labId: 'W1N1-one', resourceType: 'UH2O' }];
    const creep = { room, store: store({}, 1650), memory: { working: true }, transferToTarget: () => assert.fail('empty delivery') };
    w.loader.load('role/adv/RoleAdvProcesser').default({}).target(creep);
    assert.equal(creep.memory.working, false);
    assert.equal(room.memory.roomFillJob.labInMineral.length, 1);
});

test('a small worker fills both reagent Labs and finishes a 3000-unit batch with deferred native intents', () => {
    const w = world(), room = w.addRoom('W1N1', { UH2O: 3000, X: 3000 });
    w.loader.globals.StructureLab = class {};
    w.loader.globals.RESOURCE_ENERGY = 'energy';
    w.loader.globals.REACTIONS = { UH2O: { X: 'XUH2O' }, X: { UH2O: 'XUH2O' } };
    const LabExtension = w.loader.load('mount/structure/LabExtension').default;
    const intents = [], withdrawals = [];
    for (const lab of room.labs) {
        Object.setPrototypeOf(lab, LabExtension.prototype);
        lab.room = room; lab.cooldown = 0;
        lab.runReaction = (first, second) => {
            if (!(first.store.UH2O >= 5) || !(second.store.X >= 5)) return -6;
            intents.push(() => {
                first.store.UH2O -= 5; second.store.X -= 5;
                lab.store.XUH2O = (lab.store.XUH2O || 0) + 5; lab.mineralType = 'XUH2O';
            });
            return 0;
        };
    }
    room.getResource = resource => [room.storage, room.terminal, ...room.labs, creep]
        .reduce((total, holder) => total + (holder.store[resource] || 0), 0);
    const creep = {
        room, store: store({}, 100), memory: {},
        withdraw(target, resource, amount = Math.min(creep.store.getFreeCapacity(), target.store[resource] || 0)) {
            withdrawals.push(amount);
            if (amount > creep.store.getFreeCapacity()) return -8;
            if (!(amount > 0) || amount > (target.store[resource] || 0)) return -6;
            intents.push(() => {
                target.store[resource] -= amount; creep.store[resource] = (creep.store[resource] || 0) + amount;
                if (target.mineralType === resource && target.store[resource] === 0) target.mineralType = undefined;
            });
            return 0;
        },
        takeFromTarget(target, resource, amount) { creep.withdraw(target, resource, amount); return true; },
        transferToTarget(target, resource) {
            const amount = Math.min(creep.store[resource] || 0, target.store.getFreeCapacity(resource));
            if (!(amount > 0)) return false;
            intents.push(() => {
                creep.store[resource] -= amount; target.store[resource] = (target.store[resource] || 0) + amount;
                if (room.labs.includes(target)) target.mineralType = resource;
            });
            return true;
        },
    };
    w.update(room);
    const role = w.loader.load('role/adv/RoleAdvProcesser').default({});
    for (let tick = 10; tick < 1010 && room.memory.roomLabConfig.reactionAmount > 0; tick++) {
        w.game.time = tick;
        room.labs.forEach(lab => lab.init());
        role[creep.memory.working ? 'target' : 'source'](creep);
        room.labs[2].doWork();
        while (intents.length) intents.shift()();
    }
    assert.equal(room.memory.roomLabConfig.reactionAmount, 0, 'both reagents arrive and native reactions exhaust the planned batch');
    assert.equal(room.memory.roomLabConfig.productionPlan.remaining, 0);
    assert.equal(room.getResource('XUH2O'), 3000);
    assert.equal(room.storage.store.X, 10000, 'ordinary base mineral remains protected');
    assert.equal(withdrawals.every(amount => amount > 0 && amount <= 100), true);
});
