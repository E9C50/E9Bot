const assert = require('node:assert/strict');
const test = require('node:test');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function resourceStore(values = {}) {
    return new Proxy(values, { get(target, key) { return target[key] ?? 0; } });
}

function reagent(mineralType, amount = 100) {
    return { mineralType, store: resourceStore({ A: amount, B: amount }) };
}

function world() {
    const members = {};
    let enumerations = 0;
    const game = {
        time: 100, shard: { name: 'first' },
        creeps: new Proxy(members, { ownKeys(target) { enumerations++; return Reflect.ownKeys(target); } })
    };
    class Room { constructor(name) { this.name = name; } }
    const loader = createSourceLoader({
        globals: { Room, StructureLab: class {}, Game: game, RESOURCE_ENERGY: 'energy', OK: 0,
            REACTIONS: { A: { B: 'product' }, B: { A: 'product' } }, LAB_REACTION_AMOUNT: 5,
            PWR_OPERATE_LAB: 5, POWER_INFO: { 5: { effect: [2, 4, 6, 8, 10] } } },
        modules: {
            'settings/creep': { roleAdvEnum: { PROCESSER: 'processer' } },
            'settings/settings': { STRUCTURE_PRIVATEKEY_PERFIX: '_', STRUCTURE_MEMORYKEY_PERFIX: 'IDOF_', creepWhiteList: [] },
            'settings/labs': { reactionSource: { product: ['A', 'B'] } },
            'settings/structures': { structurePolicy: { lab: { jobInterval: 10, outputMineralThreshold: 1000, sourceFreeCapacity: 1000 } } },
            'utils/CostMatrix': { generateCostMatrix() {} }, utils: { getDistance() {} }
        }
    });
    const RoomExtension = loader.load('mount/extension/RoomExtension').default;
    const LabExtension = loader.load('mount/structure/LabExtension').default;
    function createRoom(name) {
        const room = new RoomExtension(name);
        room.storage = { store: resourceStore({ A: 10, B: 20 }) };
        room.terminal = { store: resourceStore({ A: 1, B: 2 }) };
        room.labs = [{ id: 'existing', store: resourceStore({ A: 3, B: 4 }) }];
        room.memory = {
            roomLabConfig: { sourceLab1: 'lab0', sourceLab2: 'lab1', labReactionConfig: 'product', singleLabConfig: {} },
            roomFillJob: {}, boostNeed: {}
        };
        return room;
    }
    function addCreep(name, room, amounts, role = 'processer') {
        const creep = { room, memory: { role }, store: resourceStore(amounts) };
        members[name] = creep;
        return creep;
    }
    function createLab(room, id) {
        const lab = new LabExtension();
        Object.assign(lab, {
            id, room, store: resourceStore({ getFreeCapacity: resource => resource === 'product' ? 3000 : 0 }), mineralType: undefined
        });
        return lab;
    }
    return { game, members, createRoom, addCreep, createLab, enumerations: () => enumerations };
}

test('processor indexing imports without reading Game', () => {
    const loader = createSourceLoader({ modules: { 'settings/creep': { roleAdvEnum: { PROCESSER: 'processer' } } } });
    assert.equal(typeof loader.load('runtime/creepIndex').getRoomProcessors, 'function');
    assert.equal(loader.globals.Game, undefined);
});

test('a destroyed reagent Lab pauses reactions until fresh configured IDs resolve', () => {
    const state = world(), room = state.createRoom('W1N1'), lab = state.createLab(room, 'output');
    lab.cooldown = 0;
    let reactions = 0;
    lab.runReaction = () => reactions++;
    let source = null;
    state.game.getObjectById = id => id === 'lab0' ? source : reagent('B');
    assert.doesNotThrow(() => lab.doWork()); assert.equal(reactions, 0);
    source = reagent('A'); state.game.time++;
    lab.doWork(); assert.equal(reactions, 1);
    state.game.time++;
    state.game.getObjectById = id => id === 'lab1' ? null : source;
    assert.doesNotThrow(() => lab.doWork()); assert.equal(reactions, 1);
});

test('cleared, retasked or boost-occupied source labs do not continue an obsolete reaction', () => {
    const state = world(), room = state.createRoom('W1N1'), lab = state.createLab(room, 'output');
    const first = reagent('A'), second = reagent('B');
    state.game.getObjectById = id => id === 'lab0' ? first : second;
    let reactions = 0;
    lab.cooldown = 0; lab.runReaction = () => reactions++;
    room.memory.roomLabConfig.labReactionConfig = undefined;
    lab.doWork(); assert.equal(reactions, 0);
    room.memory.roomLabConfig.labReactionConfig = 'other';
    lab.doWork(); assert.equal(reactions, 0);
    room.memory.roomLabConfig.labReactionConfig = 'product';
    room.memory.roomLabConfig.singleLabConfig.lab0 = { boostMode: true, resourceType: 'A' };
    lab.doWork(); assert.equal(reactions, 0);
    delete room.memory.roomLabConfig.singleLabConfig.lab0;
    lab.doWork(); assert.equal(reactions, 1);
});

test('successful output intents debit one shared batch quota before the native reagent stores change', () => {
    const state = world(), room = state.createRoom('W1N1');
    state.game.getObjectById = id => id === 'lab0' ? reagent('A') : reagent('B');
    room.memory.roomLabConfig.reactionAmount = 10;
    let reactions = 0;
    for (let index = 0; index < 8; index++) {
        const lab = state.createLab(room, `output-${index}`);
        lab.cooldown = 0; lab.runReaction = () => { reactions++; return 0; };
        lab.doWork();
    }
    assert.equal(reactions, 2, 'the remaining six labs cannot spend the same pre-intent batch');
    assert.equal(room.memory.roomLabConfig.reactionAmount, 0);
});

test('batch quotas debit operated Lab consumption only on successful reactions', () => {
    const state = world(), room = state.createRoom('W1N1'), lab = state.createLab(room, 'output');
    state.game.getObjectById = id => id === 'lab0' ? reagent('A') : reagent('B');
    room.memory.roomLabConfig.reactionAmount = 20;
    lab.cooldown = 0; lab.effects = [{ effect: 5, level: 5, ticksRemaining: 100 }];
    let result = -6, reactions = 0;
    lab.runReaction = () => { reactions++; return result; };
    lab.doWork(); assert.equal(room.memory.roomLabConfig.reactionAmount, 20);
    result = 0;
    lab.doWork(); assert.equal(room.memory.roomLabConfig.reactionAmount, 5);
    lab.doWork(); assert.equal(reactions, 2, 'a remaining five units cannot fund another operated 15-unit reaction');
});

test('final batch remaining only counts successful target output and bounds pending intents across Labs', () => {
    const state = world(), room = state.createRoom('W1N1');
    state.game.getObjectById = id => id === 'lab0' ? reagent('A') : reagent('B');
    room.memory.productionReserve = { lab: { A: 100 }, factory: { B: 20 } };
    room.memory.roomLabConfig.productionPlan = { target: 'other', targetAmount: 20, local: false, remaining: 20 };
    room.memory.roomLabConfig.reactionAmount = 100;
    const output = state.createLab(room, 'output'); output.cooldown = 0;
    output.runReaction = () => 0;
    output.doWork();
    assert.equal(room.memory.roomLabConfig.productionPlan.remaining, 20, 'intermediate reactions do not debit the final batch');
    room.memory.roomLabConfig.productionPlan.target = 'product';
    output.effects = [{ effect: 5, level: 5, ticksRemaining: 100 }];
    output.runReaction = () => -6;
    output.doWork();
    assert.equal(room.memory.roomLabConfig.productionPlan.remaining, 20);
    output.runReaction = () => 0;
    output.doWork();
    assert.equal(room.memory.roomLabConfig.productionPlan.remaining, 5, 'native operated amount is 15');
    let reactions = 0;
    for (let index = 0; index < 8; index++) {
        const lab = state.createLab(room, `final-${index}`); lab.cooldown = 0;
        lab.runReaction = () => { reactions++; return 0; };
        lab.doWork();
    }
    assert.equal(reactions, 1, 'another output cannot spend already accepted final-product intents');
    assert.equal(room.memory.roomLabConfig.productionPlan.remaining, 0);
    assert.equal(room.memory.roomLabConfig.labReactionConfig, undefined);
    assert.equal(room.memory.productionReserve.lab, undefined);
    assert.equal(room.memory.productionReserve.factory.B, 20);
});

test('eleven ten-lab rooms resolve each reaction pair once while preserving all output intents', () => {
    const state = world(), objects = {}, outputs = [];
    let lookups = 0, reactions = 0;
    state.game.getObjectById = id => { lookups++; return objects[id] || null; };
    for (let index = 0; index < 11; index++) {
        const room = state.createRoom(`W${index + 1}N1`);
        const config = room.memory.roomLabConfig;
        config.sourceLab1 = `${room.name}-source1`; config.sourceLab2 = `${room.name}-source2`;
        objects[config.sourceLab1] = reagent('A'); objects[config.sourceLab2] = reagent('B');
        for (let output = 0; output < 8; output++) {
            const lab = state.createLab(room, `${room.name}-${output}`);
            lab.cooldown = 0;
            lab.runReaction = (first, second) => {
                assert.equal(first, objects[config.sourceLab1]); assert.equal(second, objects[config.sourceLab2]);
                reactions++;
            };
            outputs.push(lab);
        }
    }
    for (const output of outputs) output.doWork();
    assert.equal(lookups, 22, 'eight outputs share two resolutions rather than doing 176 lookups');
    assert.equal(reactions, 88, 'only redundant object lookup is eliminated');
    state.game.time++;
    for (const output of outputs) output.doWork();
    assert.equal(lookups, 44, 'native object references never survive into another tick');
    assert.equal(reactions, 176);
});

test('reaction pairs refresh changed IDs immediately and keep reagent values live in the current tick', () => {
    const state = world(), room = state.createRoom('W1N1'), lab = state.createLab(room, 'output');
    const first = reagent(undefined), second = reagent('B'), replacement = reagent('A');
    const objects = { lab0: first, lab1: second, replacement };
    let lookups = 0;
    const reactions = [];
    state.game.getObjectById = id => { lookups++; return objects[id] || null; };
    lab.cooldown = 0; lab.runReaction = (source1, source2) => reactions.push([source1, source2]);
    lab.doWork(); assert.equal(reactions.length, 0); assert.equal(lookups, 2);
    first.mineralType = 'A'; lab.doWork();
    assert.equal(reactions.length, 1); assert.equal(lookups, 2, 'resolution is reused without caching mineralType');
    room.memory.roomLabConfig.sourceLab1 = 'replacement'; lab.doWork();
    assert.equal(lookups, 4); assert.equal(reactions[1][0], replacement);
    room.memory.roomLabConfig.sourceLab2 = 'missing'; lab.doWork(); lab.doWork();
    assert.equal(lookups, 6); assert.equal(reactions.length, 2, 'a missing configured reagent is safe and resolved only once this tick');
    objects.missing = reagent('B'); state.game.time++; lab.doWork();
    assert.equal(lookups, 8); assert.equal(reactions[2][1], objects.missing, 'the next tick sees a replacement at the previously missing ID');
    state.game.shard.name = 'second'; lab.doWork();
    assert.equal(lookups, 10, 'same-tick shard changes cannot reuse another shard snapshot');
});

test('reaction guards avoid native calls for shortages and full output, then resume from live stores', () => {
    const state = world(), room = state.createRoom('W1N1'), lab = state.createLab(room, 'output');
    const first = reagent('A', 4), second = reagent('B', 5);
    state.game.getObjectById = id => id === 'lab0' ? first : second;
    let reactions = 0, free = 5;
    lab.cooldown = 0; lab.store.getFreeCapacity = () => free;
    lab.runReaction = () => reactions++;
    lab.doWork(); assert.equal(reactions, 0);
    first.store.A = 5; second.store.B = 4;
    lab.doWork(); assert.equal(reactions, 0);
    second.store.B = 5; free = 4;
    lab.doWork(); assert.equal(reactions, 0);
    free = null; lab.doWork(); assert.equal(reactions, 0);
    free = 5; lab.doWork(); assert.equal(reactions, 1, 'exact native batch succeeds without a new tick');
});

test('reaction compatibility rejects one mismatched reagent and accepts reverse reagent ordering', () => {
    const state = world(), room = state.createRoom('W1N1'), lab = state.createLab(room, 'output');
    const first = reagent('A'), second = reagent('invalid');
    state.game.getObjectById = id => id === 'lab0' ? first : second;
    let reactions = 0;
    lab.cooldown = 0; lab.runReaction = () => reactions++;
    lab.mineralType = 'product';
    lab.doWork(); assert.equal(reactions, 0, 'one matching reagent is insufficient');
    first.mineralType = 'B'; second.mineralType = 'A';
    lab.doWork(); assert.equal(reactions, 1);
    lab.mineralType = 'other'; lab.doWork(); assert.equal(reactions, 1, 'an incompatible output cannot receive product');
});

test('operated Labs check the larger native batch and ignore expired effects', () => {
    const state = world(), room = state.createRoom('W1N1'), lab = state.createLab(room, 'output');
    const first = reagent('A', 14), second = reagent('B', 15);
    state.game.getObjectById = id => id === 'lab0' ? first : second;
    let reactions = 0, free = 15;
    lab.cooldown = 0; lab.store.getFreeCapacity = () => free; lab.runReaction = () => reactions++;
    lab.effects = [{ effect: 5, level: 5, ticksRemaining: 1 }];
    lab.doWork(); assert.equal(reactions, 0);
    first.store.A = 15; free = 14; lab.doWork(); assert.equal(reactions, 0);
    free = 15; lab.doWork(); assert.equal(reactions, 1);
    first.store.A = 5; second.store.B = 5; free = 5;
    lab.effects[0].ticksRemaining = 0; lab.doWork(); assert.equal(reactions, 2);
});

test('two rooms and multiple resource queries enumerate processors once per tick and read live stores', () => {
    const state = world();
    const first = state.createRoom('W1N1');
    const second = state.createRoom('W2N2');
    const processor = state.addCreep('first', first, { A: 100, B: 200 });
    state.addCreep('second', second, { A: 50, B: 80 });
    state.addCreep('ignored', first, { A: 99999, B: 99999 }, 'filler');
    assert.equal(first.getResource('A', true, true, true, true), 114);
    assert.equal(first.getResource('B', true, true, true, true), 226);
    assert.equal(second.getResource('A', true, true, true, true), 64);
    assert.equal(second.getResource('B', true, true, true, true), 106);
    assert.equal(state.enumerations(), 1);
    processor.store.A = 250;
    assert.equal(first.getResource('A', true, true, true, true), 264, 'only membership is cached');
    assert.equal(state.enumerations(), 1);
    state.addCreep('newcomer', first, { A: 7, B: 9 });
    state.game.time++;
    assert.equal(first.getResource('A', true, true, true, true), 271);
    assert.equal(second.getResource('B', true, true, true, true), 106);
    assert.equal(state.enumerations(), 2, 'the next tick must include new members');
    delete state.members.second;
    state.game.shard.name = 'second';
    assert.equal(second.getResource('A', true, true, true, true), 14);
    assert.equal(state.enumerations(), 3, 'the same tick number on another shard must rebuild membership');
});

test('ordinary storage, terminal, and lab queries keep their flags and do not enumerate creeps', () => {
    const state = world();
    const room = state.createRoom('W1N1');
    state.addCreep('processor', room, { A: 100 });
    assert.equal(room.getResource('A'), 10);
    assert.equal(room.getResource('A', false, true), 1);
    assert.equal(room.getResource('A', false, false, true), 3);
    assert.equal(room.getResource('A', false, false, false), 0);
    assert.equal(state.enumerations(), 0);
    assert.equal(room.getResource('A', false, false, false, true), 100);
    assert.equal(state.enumerations(), 1);
});

test('a ten-lab reaction initializes its two source jobs with two queries instead of twenty', () => {
    const state = world();
    const room = state.createRoom('W1N1');
    state.addCreep('processor', room, { A: 100, B: 200 });
    room.labs = Array.from({ length: 10 }, (_, index) => state.createLab(room, `lab${index}`));
    const originalGetResource = room.getResource.bind(room);
    const calls = [];
    room.getResource = (...args) => { calls.push(args); return originalGetResource(...args); };
    // Measure the previous nonboost-lab workload on the same ten-lab snapshot.
    for (const lab of room.labs) {
        room.getResource('A', true, false, true, true);
        room.getResource('B', true, false, true, true);
    }
    assert.equal(calls.length, 20);
    calls.length = 0;
    state.game.time += 10;
    for (const lab of room.labs) lab.init();
    assert.deepEqual(calls, [['A', true, true, true, true], ['B', true, true, true, true]]);
    assert.deepEqual(JSON.parse(JSON.stringify(room.memory.roomFillJob.labInMineral)), [
        { labId: 'lab0', resourceType: 'A' }, { labId: 'lab1', resourceType: 'B' }
    ]);
    assert.equal(state.enumerations(), 2, 'one processor enumeration in each measured tick');
    for (const lab of room.labs) lab.init();
    assert.equal(room.memory.roomFillJob.labInMineral.length, 2, 'existing source jobs remain deduplicated');
    assert.equal(state.enumerations(), 2);
});

test('boost labs can source exact compounds from storage, terminal and processors without reaction queries', () => {
    const state = world();
    const room = state.createRoom('W1N1');
    const lab = state.createLab(room, 'boost');
    room.labs = [lab];
    room.terminal.store.BOOST = 50;
    room.memory.boostNeed.BOOST = 60;
    room.memory.roomLabConfig.singleLabConfig.boost = { boostMode: true, boostType: 'boostBuild', resourceType: 'BOOST' };
    const originalGetResource = room.getResource.bind(room);
    const calls = [];
    room.getResource = (...args) => { calls.push(args); return originalGetResource(...args); };
    lab.init();
    assert.deepEqual(calls, [['BOOST', true, true, false, true]]);
    assert.deepEqual(JSON.parse(JSON.stringify(room.memory.roomFillJob.labInMineral)), [{ labId: 'boost', resourceType: 'BOOST' }]);
});

test('a ten-lab energy shortage keeps ten pending jobs across a thousand unsupplied ticks', () => {
    const state = world();
    const room = state.createRoom('W1N1');
    room.memory.roomLabConfig.labReactionConfig = undefined;
    room.labs = Array.from({ length: 10 }, (_, index) => state.createLab(room, `lab${index}`));
    for (const lab of room.labs) lab.store.getFreeCapacity = () => 2000;
    for (let tick = 0; tick < 1000; tick += 10) {
        state.game.time = 100 + tick;
        for (const lab of room.labs) lab.init();
    }
    assert.equal(room.memory.roomFillJob.labInEnergy.length, 10,
        'one request per lab, even without any filler serving the queue');
    assert.deepEqual(Array.from(room.memory.roomFillJob.labInEnergy), room.labs.map(lab => lab.id));
});

test('legacy duplicate energy jobs compact in place without changing existing pending order', () => {
    const state = world(), room = state.createRoom('W1N1');
    room.memory.roomLabConfig.labReactionConfig = undefined;
    const queue = ['later', 'first', 'later', 'gone', 'first', 'gone'];
    room.memory.roomFillJob.labInEnergy = queue;
    const lab = state.createLab(room, 'new');
    lab.store.getFreeCapacity = () => 2000;
    lab.init(); lab.init();
    assert.equal(room.memory.roomFillJob.labInEnergy, queue, 'fillers holding the array still see the compacted queue');
    assert.deepEqual(queue, ['later', 'first', 'gone', 'new']);
    assert.deepEqual(Array.from(room.memory.roomFillJob.labOut), []);
    assert.deepEqual(Array.from(room.memory.roomFillJob.labInMineral), []);
});

test('ten lab initializers scan the old energy queue once per job tick rather than ten times', () => {
    const state = world(), room = state.createRoom('W1N1');
    room.memory.roomLabConfig.labReactionConfig = undefined;
    let entriesRead = 0;
    const legacy = Array.from({ length: 1000 }, (_, index) => `lab${index % 10}`);
    room.memory.roomFillJob.labInEnergy = new Proxy(legacy, {
        get(target, key, receiver) {
            if (typeof key === 'string' && /^\d+$/.test(key)) entriesRead++;
            return Reflect.get(target, key, receiver);
        }
    });
    room.labs = Array.from({ length: 10 }, (_, index) => state.createLab(room, `lab${index}`));
    for (const lab of room.labs) lab.init();
    assert.equal(entriesRead, 1000, 'full labs do not enqueue and legacy compaction only visits the initial queue once');
    assert.equal(legacy.length, 10);
    state.game.time += 10;
    for (const lab of room.labs) lab.init();
    assert.equal(entriesRead, 1010, 'only the ten surviving entries are inspected on the next job tick');
});

test('full labs do not enqueue but later shortages resume after the consumer clears jobs, independently per room', () => {
    const state = world(), first = state.createRoom('W1N1'), second = state.createRoom('W2N2');
    for (const room of [first, second]) room.memory.roomLabConfig.labReactionConfig = undefined;
    const firstLab = state.createLab(first, 'first'), secondLab = state.createLab(second, 'second');
    firstLab.init();
    assert.equal(first.memory.roomFillJob.labInEnergy.length, 0);
    secondLab.store.getFreeCapacity = () => 2000;
    secondLab.init();
    assert.deepEqual(Array.from(second.memory.roomFillJob.labInEnergy), ['second']);
    firstLab.store.getFreeCapacity = () => 2000;
    firstLab.init();
    assert.deepEqual(Array.from(first.memory.roomFillJob.labInEnergy), ['first']);
    first.memory.roomFillJob.labInEnergy.length = 0;
    state.game.time += 10;
    firstLab.init();
    assert.deepEqual(Array.from(first.memory.roomFillJob.labInEnergy), ['first']);
    state.game.time++;
    secondLab.init();
    assert.deepEqual(Array.from(second.memory.roomFillJob.labInEnergy), ['second'], 'non-job ticks preserve the queue');
});
