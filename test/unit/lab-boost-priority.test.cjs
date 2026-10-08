const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const nativeBodies = require('../helpers/native-bodies.cjs');

function world() {
    const calls = [], intents = [], objects = new Map(), memory = { combatTasks: {}, warMode: {}, rooms: {} };
    const game = { time: 100, shard: { name: 'test' }, rooms: {}, creeps: {}, flags: {}, getObjectById: id => objects.get(id) || null };
    const p = (x, y) => ({ x, y, roomName: 'W1N1', getRangeTo(value) { const other = value.pos || value; return Math.max(Math.abs(x-other.x), Math.abs(y-other.y)); },
        inRangeTo(value, range) { return this.getRangeTo(value) <= range; }, isNearTo(value) { return this.getRangeTo(value) <= 1; } });
    function store(values = {}, capacity = 1000000, lab = false) {
        const result = { ...values };
        const used = resource => resource ? result[resource] || 0 : Object.values(result).reduce((sum, amount) => sum + amount, 0);
        Object.defineProperties(result, {
            getUsedCapacity: { value: used }, getCapacity: { value: resource => lab ? resource === 'energy' ? 2000 : 3000 : capacity },
            getFreeCapacity: { value: resource => lab ? resource === 'energy' ? 2000-used(resource) :
                3000-Object.entries(result).reduce((sum, [type, amount]) => sum + (type === 'energy' ? 0 : amount), 0) : capacity-used() },
        }); return result;
    }
    const room = { name: 'W1N1', my: true, level: 8, controller: { my: true, level: 8, isPowerEnabled: false },
        memory: { creepConfig: {}, roomFillJob: {}, roomStructure: {}, boostNeed: {}, roomLabConfig: {
            sourceLab1: 'source1', sourceLab2: 'source2', singleLabConfig: {}, labReactionConfig: 'XUH2O', reactionAmount: 1000,
            productionPlan: { target: 'XUH2O', targetAmount: 23000, local: false, remaining: 1000 } },
            productionReserve: { lab: { UH2O: 1000, X: 1000 } } }, labs: [], spawns: [], towers: [], links: [], containers: [], extensions: [], sources: [] };
    game.rooms[room.name] = room; memory.rooms[room.name] = room.memory;
    room.storage = { id: 'storage', structureType: 'storage', room, pos: p(10, 10), store: store({ energy: 250000, XUH2O: 20000 }) };
    room.terminal = { id: 'terminal', structureType: 'terminal', room, my: true, pos: p(11, 10), store: store({ energy: 50000 }, 300000), cooldown: 0 };
    objects.set('storage', room.storage); objects.set('terminal', room.terminal);
    const loader = createSourceLoader({ globals: { ...nativeBodies.globals, Game: game, Memory: memory,
        RESOURCE_ENERGY: 'energy', RESOURCE_GHODIUM: 'G', RESOURCE_POWER: 'power', LAB_BOOST_MINERAL: 30, LAB_BOOST_ENERGY: 20,
        LAB_REACTION_AMOUNT: 5, OK: 0, ERR_NOT_IN_RANGE: -9, StructureLab: class {},
        STRUCTURE_LINK: 'link', STRUCTURE_CONTAINER: 'container', FIND_MY_CREEPS: 'my',
        REACTIONS: { UH2O: { X: 'XUH2O' } }, PWR_OPERATE_LAB: 5, POWER_INFO: { 5: { effect: [2, 4, 6, 8, 10] } },
        console: { log() {} } }, modules: {
        'settings/boost': { boostConfig: { boostAttack: ['UH', 'UH2O', 'XUH2O'], boostUpgrade: ['GH', 'GH2O', 'XGH2O'] },
            boostBodyPart: { boostAttack: 'attack', boostUpgrade: 'work' }, roleBoostConfig: { integrate: ['boostAttack'] } },
        'settings/labs': { reactionSource: { XUH2O: ['UH2O', 'X'] } },
        'settings/room': { roomSignTextList: [] },
        'settings/roomPolicy': { roomPolicy: { labs: { updateInterval: 10, staggerUpdates: false } } },
        'settings/structures': { structurePolicy: { lab: { jobInterval: 10, outputMineralThreshold: 1000, sourceFreeCapacity: 1000 } } },
        'creep/haulerDelivery': { withHaulerTraffic: behavior => behavior, deliverHaulerEnergy: () => false },
        'room/factory': { runFactoryLogistics(creep) { calls.push(['factory', creep.name]); return true; } },
        utils: { getDistance: (a, b) => a.getRangeTo(b) },
    } });
    const Lab = loader.load('mount/structure/LabExtension').default;
    function lab(id, resource, amount = 0, energy = 0, x = 12, y = 10) {
        const object = new Lab();
        Object.assign(object, { id, room, my: true, cooldown: 0, pos: p(x, y), mineralType: resource,
            store: store({ energy, ...(resource ? { [resource]: amount } : {}) }, 3000, true), isActive: () => true,
            runReaction(first, second) { calls.push(['reaction', id]); intents.push(() => {
                first.store.UH2O -= 5; second.store.X -= 5; object.store.XUH2O = (object.store.XUH2O || 0) + 5; object.mineralType = 'XUH2O';
            }); return 0; } });
        room.labs.push(object); objects.set(id, object); return object;
    }
    const first = lab('source1', 'UH2O', 1000), second = lab('source2', 'X', 1000), output = lab('output');
    const plan = (resource = 'GH', parts = 2) => ({ tier: resource === 'GH' || resource === 'UH' ? 1 : resource === 'UH2O' ? 2 : 3,
        steps: [{ type: resource.includes('GH') ? 'boostUpgrade' : 'boostAttack', resource, parts }] });
    function unit(name, role = 'processer', values = {}, boostPlan = { tier: 0, steps: [], completed: true }) {
        const body = role === 'fighter' ? Array.from({ length: 2 }, () => ({ type: boostPlan.steps[0].type === 'boostUpgrade' ? 'work' : 'attack', hits: 100 })) :
            [...Array.from({ length: 33 }, () => ({ type: 'carry', hits: 100 })), ...Array.from({ length: 17 }, () => ({ type: 'move', hits: 100 }))];
        const creep = { name, room, pos: p(10, 10), body, spawning: false, store: store(values, 1650),
            memory: { name, role, spawnRoom: room.name, data: { sourceId: 'storage' }, working: Object.keys(values).length > 0, boostPlan },
            getActiveBodyparts: type => body.filter(part => part.type === type && part.hits > 0).length,
            moveTo(target) { calls.push(['move', name, target.id]); return 0; },
            transfer(target, resource, amount = Math.min(creep.store[resource] || 0, target.store.getFreeCapacity(resource))) {
                calls.push(['transfer', name, target.id, resource, amount]);
                if (!creep.pos.isNearTo(target)) return -9;
                if (amount > target.store.getFreeCapacity(resource) || amount > (creep.store[resource] || 0) || amount <= 0) return -8;
                intents.push(() => { creep.store[resource] -= amount; target.store[resource] = (target.store[resource] || 0) + amount;
                    if (room.labs.includes(target)) target.mineralType = resource; }); return 0;
            },
            withdraw(target, resource, amount = Math.min(target.store[resource] || 0, creep.store.getFreeCapacity())) {
                calls.push(['withdraw', name, target.id, resource, amount]);
                if (!creep.pos.isNearTo(target)) return -9;
                if (amount > creep.store.getFreeCapacity() || amount > (target.store[resource] || 0) || amount <= 0) return -8;
                intents.push(() => { creep.store[resource] = (creep.store[resource] || 0) + amount; target.store[resource] -= amount;
                    if (target.mineralType === resource && target.store[resource] === 0) target.mineralType = undefined; }); return 0;
            },
            transferToTarget(target, resource) { return creep.transfer(target, resource) === 0; },
            takeFromTarget(target, resource, amount) { return creep.withdraw(target, resource, amount) === 0; },
            say() {}, pickupDroppedResource: () => false,
        };
        game.creeps[name] = creep; objects.set(name, creep); return creep;
    }
    function task(members = [plan()], { names = [], id = 'raid' } = {}) {
        const result = { id, shard: game.shard.name, homeRoom: room.name, targetRoom: 'W1N2', mode: 'attack', phase: 'spawning',
            generation: 1, deadline: game.time + 1000, options: {}, spent: 0, memberNames: names, names,
            plan: { members: members.map(boostPlan => ({ boostPlan })) } };
        memory.combatTasks[id] = result; return result;
    }
    function configure(target, resource) { room.memory.roomLabConfig.singleLabConfig[target.id] = {
        boostMode: true, boostType: resource.includes('GH') ? 'boostUpgrade' : 'boostAttack', resourceType: resource,
    }; }
    return { loader, game, memory, room, first, second, output, calls, intents, p, store, unit, task, plan, lab, configure,
        ...loader.load('creep/boosting'), ...loader.load('room/labs'), ...loader.load('room/labBoostPriority'),
        processor: () => loader.load('role/adv/RoleAdvProcesser').default({}),
        filler: () => loader.load('role/base/RoleBaseFiller').default({ sourceId: 'storage' }),
        resolve() { while (intents.length) intents.shift()(); game.time++; },
    };
}

test('approved unspawned boosts pause planning, reaction and ordinary hauling without losing the saved batch', () => {
    const w = world(), task = w.task([w.plan('GH')]);
    w.room.memory.roomFillJob = { labOut: ['output'], labInMineral: [{ labId: 'source1', resourceType: 'UH2O' }], labInEnergy: ['source1'] };
    const before = JSON.stringify(w.room.memory.roomLabConfig), reserve = JSON.stringify(w.room.memory.productionReserve);
    w.updateLabReactionConfig(w.room); w.output.doWork(); w.first.init();
    assert.equal(w.calls.length, 0);
    assert.equal(JSON.stringify(w.room.memory.roomLabConfig), before);
    assert.equal(JSON.stringify(w.room.memory.productionReserve), reserve);
    assert.deepEqual({ ...w.room.memory.boostNeed }, { GH: 60 });
    assert.deepEqual(Array.from(w.room.memory.roomFillJob.labInMineral), []);
    assert.deepEqual(Array.from(w.room.memory.roomFillJob.labInEnergy), []);
    assert.deepEqual(Array.from(w.room.memory.roomFillJob.labOut), []);
    task.phase = 'cancelled';
    w.output.doWork();
    assert.equal(w.room.memory.roomLabConfig.productionPlan.remaining, 995);
    assert.equal(w.room.memory.roomLabConfig.reactionAmount, 995);
    assert.equal(w.room.memory.roomLabConfig.labReactionConfig, 'XUH2O');
});

test('same-tick accepted boosts invalidate an earlier idle decision and expire when no spawning body survives', () => {
    const w = world();
    assert.equal(w.hasActiveRoomBoost(w.room), false);
    w.reserveBoostPlan(w.room, 'accepted', w.plan());
    w.output.doWork();
    assert.equal(w.calls.length, 0);
    w.game.time++;
    w.output.doWork();
    assert.equal(w.calls.filter(c => c[0] === 'reaction').length, 1);
});

test('room Lab initialization and execution reconcile boost queues once per synchronous batch', () => {
    const w = world();
    for (let index = 0; index < 7; index++) w.lab('extra' + index);
    let reconciliations = 0;
    w.memory.combatTasks = new Proxy({}, { ownKeys(value) { reconciliations++; return Reflect.ownKeys(value); } });
    w.unit('waiting', 'fighter', {}, w.plan('GH'));
    w.configure(w.output, 'GH'); w.room.storage.store.GH = 60;
    w.room.memory.roomFillJob = { labOut: ['source2'], labInMineral: [{ labId: 'source1', resourceType: 'UH2O' }], labInEnergy: ['source1'] };
    w.loader.load('room/initialization').initializeStructures(w.room);
    assert.equal(reconciliations, 1, 'ten Lab init hooks share one fresh boost decision');
    assert.deepEqual(Array.from(w.room.memory.roomFillJob.labOut), []);
    assert.deepEqual(Array.from(w.room.memory.roomFillJob.labInMineral, job => [job.labId, job.resourceType]), [['output', 'GH']]);
    assert.deepEqual(Array.from(w.room.memory.roomFillJob.labInEnergy), ['output']);
    w.loader.load('module/StructureController').structureWorkController();
    assert.equal(reconciliations, 2, 'ten Lab work hooks use a new decision after creep execution');
    assert.equal(w.calls.filter(c => c[0] === 'reaction').length, 0);
});

test('idle Lab batches keep every output reaction and take fresh boost decisions on the next tick', () => {
    const w = world();
    w.game.time = 101;
    for (let index = 0; index < 7; index++) w.lab('extra' + index);
    let reconciliations = 0;
    w.memory.combatTasks = new Proxy({}, { ownKeys(value) { reconciliations++; return Reflect.ownKeys(value); } });
    const initialize = w.loader.load('room/initialization').initializeStructures;
    const work = w.loader.load('module/StructureController').structureWorkController;
    initialize(w.room); work();
    assert.equal(reconciliations, 2);
    assert.equal(w.calls.filter(c => c[0] === 'reaction').length, 8, 'batching does not reduce reaction throughput');
    w.game.time++;
    w.unit('waiting', 'fighter', {}, w.plan());
    initialize(w.room); work();
    assert.equal(reconciliations, 4);
    assert.equal(w.calls.filter(c => c[0] === 'reaction').length, 8, 'the next tick sees fresh live boost demand');
});

test('a boost accepted after room planning pauses the Lab execution batch in the same tick', () => {
    const w = world();
    w.game.time = 101;
    w.loader.load('room/initialization').initializeStructures(w.room);
    assert.equal(w.room.memory.labBoostPaused, undefined);
    w.reserveBoostPlan(w.room, 'accepted', w.plan());
    w.loader.load('module/StructureController').structureWorkController();
    assert.equal(w.room.memory.labBoostPaused, true);
    assert.equal(w.calls.filter(c => c[0] === 'reaction').length, 0);
});

test('a boost completed during creep execution releases the earlier initialization pause immediately', () => {
    const w = world(), waiting = w.unit('waiting', 'fighter', {}, w.plan());
    w.loader.load('room/initialization').initializeStructures(w.room);
    assert.equal(w.room.memory.labBoostPaused, true);
    waiting.memory.boostPlan.completed = true;
    w.loader.load('module/StructureController').structureWorkController();
    assert.equal(w.room.memory.labBoostPaused, undefined);
    assert.equal(w.calls.filter(c => c[0] === 'reaction').length, 1);
});

test('idle or cancelled yellow orders release strict Lab ownership and active orders reclaim it in the same tick', () => {
    for (const state of ['paused', 'cancelled']) {
        const w = world(), yellow = w.unit('yellow', 'fighter', {}, w.plan('GH'));
        yellow.memory.targetDismantle = { targetShard: 'test', targetRoom: 'W1N1', targets: [], flagName: 'yellow', controlState: 'active' };
        w.output.doWork();
        assert.equal(w.calls.filter(c => c[0] === 'reaction').length, 0);
        yellow.memory.targetDismantle.controlState = state; w.invalidateBoostRequestIndex();
        w.output.doWork();
        assert.equal(w.calls.filter(c => c[0] === 'reaction').length, 1, state);
        assert.equal(w.getRoomBoostRequests(w.room).length, 0, state);
        yellow.memory.targetDismantle.controlState = 'active'; w.invalidateBoostRequestIndex();
        w.output.doWork();
        assert.equal(w.calls.filter(c => c[0] === 'reaction').length, 1, state);
        assert.equal(w.hasActiveRoomBoost(w.room), true, state);
    }
});

test('accepted reservation ownership releases immediately after cancellation even after its catalog entry is removed', () => {
    const w = world(), task = w.task(); task.plan = undefined;
    w.room.memory.creepConfig.accepted = { combatTaskId: task.id, combatGeneration: 1, combatJob: 'fighter' };
    w.reserveBoostPlan(w.room, 'accepted', w.plan());
    assert.equal(w.hasActiveRoomBoost(w.room), true);
    delete w.room.memory.creepConfig.accepted;
    task.phase = 'cancelled';
    assert.equal(w.hasActiveRoomBoost(w.room), false);
    task.phase = 'spawning'; task.generation++;
    assert.equal(w.hasActiveRoomBoost(w.room), false);
});

test('a partial quad deduplicates live, accepted and approved members while preflight keeps live-only accounting', () => {
    const w = world(), names = ['first', 'accepted', 'third', 'fourth'], task = w.task(Array.from({ length: 4 }, () => w.plan('UH')), { names });
    const live = w.unit('first', 'fighter', {}, w.plan('UH'));
    Object.assign(live.memory, { combatTaskId: task.id, combatGeneration: 1, combatJob: 'fighter' });
    live.body[0].boost = 'UH';
    w.room.memory.creepConfig.accepted = { combatTaskId: task.id, combatGeneration: 1, combatJob: 'fighter' };
    w.reserveBoostPlan(w.room, 'accepted', w.plan('UH'));
    const parts = requests => requests.reduce((sum, request) => sum + request.parts, 0);
    assert.equal(parts(w.getActiveRoomBoostRequests(w.room)), 7);
    assert.equal(parts(w.getRoomBoostRequests(w.room)), 3, 'approved future parts do not double-count combat planning preflight');
});

test('failed, completed, timed-out and retired combat claims release Lab ownership', () => {
    for (const status of ['failed', 'completed', 'timeout', 'cancelled', 'returning', 'generation', 'protected', 'war']) {
        const w = world(), task = w.task([], { names: ['unit'] });
        const creep = w.unit('unit', 'fighter', {}, w.plan());
        Object.assign(creep.memory, { combatTaskId: task.id, combatGeneration: 1, combatJob: 'fighter' });
        if (status === 'failed' || status === 'completed') creep.memory.boostPlan[status] = true;
        if (status === 'timeout') creep.memory.boostPlan.startedAt = w.game.time - 300;
        if (status === 'cancelled' || status === 'returning') task.phase = status;
        if (status === 'generation') task.generation++;
        if (status === 'protected') task.intel = { safeModeUntil: w.game.time + 1 };
        if (status === 'war') w.memory.warMode.W1N1 = true;
        assert.equal(w.hasActiveRoomBoost(w.room), false, status);
        w.output.doWork();
        assert.equal(w.calls.filter(c => c[0] === 'reaction').length, 1, status);
    }
    const w = world(), retired = w.unit('flag', 'integrate', {}, w.plan()); delete retired.memory.boostPlan;
    assert.equal(w.hasActiveRoomBoost(w.room), false, 'retired old flag roles never run legacy boosting');
});

test('idle boost lab configurations do not pause a reaction without actual demand', () => {
    const w = world(); w.configure(w.output, 'GH');
    assert.equal(w.hasActiveRoomBoost(w.room), false);
    const other = w.lab('other'); other.doWork();
    assert.equal(w.calls.filter(c => c[0] === 'reaction').length, 1);
});

test('boost cleanup discards old output drains of correctly loaded drug and recovers needed T2 from a source Lab', () => {
    const w = world(); w.unit('boosted', 'fighter', {}, w.plan('UH2O')); w.configure(w.output, 'UH2O');
    w.room.memory.roomFillJob.labOut = ['output', 'source2'];
    const processor = w.unit('worker'); processor.pos = w.p(12, 10);
    w.processor().source(processor);
    assert.deepEqual(w.calls.find(c => c[0] === 'withdraw').slice(2), ['source1', 'UH2O', 60]);
    assert.deepEqual(Array.from(w.room.memory.roomFillJob.labOut), ['source1']);
    w.resolve(); processor.pos = w.p(12, 10);
    w.processor().target(processor);
    assert.deepEqual(w.calls.at(-1).slice(2), ['output', 'UH2O', 60]);
    w.resolve();
    w.room.memory.roomFillJob.labOut = ['output'];
    w.prioritizeLabBoostJobs(w.room);
    assert.deepEqual(Array.from(w.room.memory.roomFillJob.labOut), []);
    assert.equal(w.output.store.UH2O, 60);
});

test('boost mineral logistics preempts a persistent factory task and an in-flight ordinary reagent returns to inventory', () => {
    const w = world(); w.unit('waiting', 'fighter', {}, w.plan('GH')); w.configure(w.output, 'GH'); w.room.storage.store.GH = 60;
    const worker = w.unit('processor'); worker.memory.factoryLogistics = { phase: 'withdraw', resourceType: 'Z' };
    w.processor().source(worker);
    assert.deepEqual(w.calls.at(-1).slice(2), ['storage', 'GH', 60]);
    assert.equal(w.calls.some(c => c[0] === 'factory'), false);
    w.resolve();
    worker.store.GH = 0; worker.store.X = 100; worker.memory.working = true;
    w.processor().target(worker);
    assert.deepEqual(w.calls.at(-1).slice(2), ['storage', 'X', 100]);
    assert.equal(w.calls.some(c => c[0] === 'transfer' && c[2] === 'source2'), false);
    assert.equal(w.room.memory.roomLabConfig.productionPlan.remaining, 1000);
});

test('paused cargo uses terminal fallback with shared capacity and keeps working on a failed native transfer', () => {
    const w = world(); w.unit('waiting', 'fighter', {}, w.plan()); w.configure(w.output, 'GH');
    w.room.storage.store = w.store({ energy: 1000000 });
    w.room.terminal.store = w.store({ energy: 299950 }, 300000);
    const first = w.unit('first-cargo', 'processer', { X: 100 }), second = w.unit('second-cargo', 'processer', { X: 100 });
    w.processor().target(first); w.processor().target(second);
    const transfers = w.calls.filter(c => c[0] === 'transfer');
    assert.equal(transfers.length, 1); assert.deepEqual(transfers[0].slice(2), ['terminal', 'X', 50]);
    assert.equal(first.memory.working, true, 'a partial return still has cargo');
    assert.equal(second.memory.working, true, 'full shared capacity cannot be treated as success');
    w.game.time++; w.room.terminal.store = w.store({ energy: 50000 }, 300000);
    first.transfer = () => -8;
    w.processor().target(first);
    assert.equal(first.memory.working, true);
});

test('cancellation immediately releases boost-only queues and in-flight medicine uses safe inventory return across ticks', () => {
    const w = world(), task = w.task(); task.plan = undefined;
    w.room.memory.creepConfig.accepted = { combatTaskId: task.id, combatGeneration: 1, combatJob: 'fighter' };
    w.reserveBoostPlan(w.room, 'accepted', w.plan()); w.configure(w.output, 'GH');
    w.room.storage.store.GH = 60;
    w.prioritizeLabBoostJobs(w.room);
    assert.equal(w.room.memory.labBoostPaused, true);
    assert.equal(w.room.memory.roomFillJob.labInMineral.length, 1);
    assert.equal(w.room.memory.roomFillJob.labInEnergy.length, 1);
    const worker = w.unit('cargo', 'processer', { GH: 60 });
    w.room.storage.store = w.store({ energy: 1000000 });
    w.room.terminal.store = w.store({ energy: 299980 }, 300000);
    task.phase = 'cancelled'; delete w.room.memory.creepConfig.accepted;
    w.processor().target(worker);
    assert.deepEqual(w.calls.at(-1).slice(2), ['terminal', 'GH', 20]);
    assert.deepEqual({ ...w.room.memory.boostNeed }, {});
    assert.equal(w.room.memory.labBoostPaused, undefined);
    for (const job of ['labOut', 'labInMineral', 'labInEnergy']) assert.deepEqual(Array.from(w.room.memory.roomFillJob[job]), []);
    assert.equal(worker.memory.working, true);
    assert.equal(worker.memory.labBoostCargoReturn, true);
    w.resolve();
    assert.equal(worker.store.GH, 40);
    w.processor().target(worker);
    assert.equal(worker.memory.labBoostCargoReturn, true, 'full inventory retains cargo after cancellation');
    w.game.time++; w.room.terminal.store.energy -= 40;
    w.processor().target(worker); w.resolve();
    assert.equal(worker.store.GH, 0);
    assert.equal(worker.memory.labBoostCargoReturn, undefined);
    assert.equal(worker.memory.working, false);
    assert.equal(w.room.memory.roomLabConfig.productionPlan.remaining, 1000);
    assert.equal(w.calls.some(c => c[0] === 'transfer' && c[2] === 'output'), false);
});

test('filler selects only boost energy jobs and caps a 1650 load to real need across same-tick carriers', () => {
    const w = world(); w.unit('waiting', 'fighter', {}, w.plan()); w.configure(w.output, 'GH');
    w.output.pos = w.p(11, 10); w.first.pos = w.p(10, 10);
    w.room.memory.roomFillJob.labInEnergy = ['source1', 'output'];
    const first = w.unit('first-energy', 'filler', { energy: 1650 }), second = w.unit('second-energy', 'filler', { energy: 1650 });
    w.filler().target(first); w.filler().target(second);
    const transfers = w.calls.filter(c => c[0] === 'transfer');
    assert.equal(transfers.length, 1);
    assert.deepEqual(transfers[0].slice(2), ['output', 'energy', 40]);
    assert.deepEqual(Array.from(w.room.memory.roomFillJob.labInEnergy), []);
});

test('no available boost-energy deficit leaves extension filling running while nonboost Lab fuel stays paused', () => {
    const w = world(); w.unit('waiting', 'fighter', {}, w.plan()); w.configure(w.output, 'GH'); w.output.store.energy = 40;
    const extension = { id: 'extension', structureType: 'extension', my: true, pos: w.p(11, 10), store: w.store({}, 50) };
    w.room.extensions.push(extension); w.room.memory.roomFillJob.extension = true;
    w.room.memory.roomFillJob.labInEnergy = ['source1'];
    const filler = w.unit('energy', 'filler', { energy: 1650 });
    w.filler().target(filler);
    assert.deepEqual(w.calls.at(-1).slice(2), ['extension', 'energy', 50]);
    assert.deepEqual(Array.from(w.room.memory.roomFillJob.labInEnergy), []);
});
