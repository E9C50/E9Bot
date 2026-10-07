const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function consoleWorld() {
    const previews = [], room = { name: 'W1N1', controller: { my: true }, memory: { creepConfig: {} }, sources: [] };
    const loader = createSourceLoader({ globals: {
        Game: { rooms: { W1N1: room } }, MAX_CREEP_SIZE: 50, LAB_BOOST_MINERAL: 30, LAB_BOOST_ENERGY: 20,
        BODYPART_COST: { work: 100, move: 50 },
    }, modules: {
        'settings/creep': { spawnPriority: { builder: 4, rAttacker: 16 } },
        './bodySelection': { previewBodySelection(room, config, tier) {
            previews.push({ config, tier }); return { body: ['work', 'move'], boostPlan: { tier,
                steps: tier ? [{ type: 'boostBuild', resource: `T${tier}`, parts: 1 }] : [] } };
        } },
        './boosting': { canPrepareBoosts: (_room, plan) => plan.tier <= 1 },
    } });
    return { room, previews, ...loader.load('creep/bodyConsole') };
}

test('console settings persist separately from refreshed demands and can merge or reset a role', () => {
    const w = consoleWorld();
    w.configureBody('W1N1', 'builder', { boostTier: 2, terrain: 'plain' });
    w.room.memory.creepConfig = { fresh: { role: 'builder', data: {} } };
    w.configureBody('W1N1', 'builder', { maximumCost: 900 });
    assert.deepEqual(JSON.parse(JSON.stringify(w.room.memory.bodyProfiles.builder)), { boostTier: 2, terrain: 'plain', maximumCost: 900 });
    w.configureBody('W1N1', 'builder', null);
    assert.equal(w.room.memory.bodyProfiles.builder, undefined);
});

test('invalid console input never partially changes persistent body settings', () => {
    const w = consoleWorld();
    for (const profile of [{ boostTier: 4 }, { terrain: 'lava' }, { carryParts: Infinity }, { workParts: 0 },
        { maximumCost: -1 }, { boostFallback: 'pretend' }, { unknown: true }, { boostTier: 1, carryParts: 51 }]) {
        assert.match(w.configureBody('W1N1', 'builder', profile), /Error/);
        assert.equal(w.room.memory.bodyProfiles, undefined);
    }
    for (const role of ['rAttacker', 'constructor', '__proto__']) assert.match(w.configureBody('W1N1', role, { boostTier: 1 }), /不支持/);
    assert.match(w.configureBody('missing', 'builder', {}), /不可见/);
});

test('preview lists all four tiers and exact per-part lab costs without writing memory', () => {
    const w = consoleWorld(), before = JSON.stringify(w.room.memory);
    const result = JSON.parse(w.previewBodies('W1N1', 'builder'));
    assert.deepEqual(result.profiles.map(profile => profile.tier), [0, 1, 2, 3]);
    assert.deepEqual(result.profiles.map(profile => profile.canPrepare), [true, true, false, false]);
    assert.equal(result.profiles[2].minerals[0].mineral, 30);
    assert.equal(result.profiles[2].minerals[0].energy, 20);
    assert.equal(JSON.stringify(w.room.memory), before);
});

test('harvest income accounts for living harvest boosts while upgrade energy budgets use physical WORK', () => {
    const loader = createSourceLoader({ globals: { WORK: 'work', CARRY: 'carry', RESOURCE_ENERGY: 'energy', CARRY_CAPACITY: 50,
        BOOSTS: { work: { XUHO2: { harvest: 7 }, XGH2O: { upgradeController: 2 } } } } });
    const api = loader.load('creep/bodyEffectiveness');
    const creep = { getActiveBodyparts: part => part === 'work' ? 2 : 3,
        body: [{ type: 'work', hits: 100, boost: 'XUHO2' }, { type: 'work', hits: 100, boost: 'XGH2O' },
            { type: 'work', hits: 0, boost: 'XUHO2' }], store: { getCapacity: () => 600 } };
    assert.equal(api.harvestWorkParts(creep), 8);
    assert.equal(api.energyCarryCapacity(creep), 600);
});

function processorWorld({ missingLab = false } = {}) {
    const calls = [], terminal = { id: 'terminal', store: { KH2O: 500 } };
    const lab = { id: 'lab', mineralType: undefined, store: { KH2O: 0, getFreeCapacity: () => 3000 } };
    const room = { terminal, memory: { boostNeed: { KH2O: 300 }, roomFillJob: { labInMineral: [{ labId: lab.id, resourceType: 'KH2O' }] },
        roomLabConfig: { singleLabConfig: { [lab.id]: { boostMode: true } } } } };
    const held = { KH2O: 0 };
    Object.defineProperty(held, 'getUsedCapacity', { value: () => held.KH2O });
    Object.defineProperty(held, 'getFreeCapacity', { value: () => 500 - held.KH2O });
    const creep = { room, memory: {}, store: held,
        takeFromTarget(target, resource, amount) { calls.push(['take', target.id, resource, amount]); return true; },
        withdraw(target, resource, amount) { calls.push(['withdraw', target.id, resource, amount]); return 0; },
        transferToTarget(target, resource) { calls.push(['put', target.id, resource]); return true; } };
    let withdrawn = 0;
    const behavior = createSourceLoader({ globals: { OK: 0, ERR_NOT_IN_RANGE: -9, Game: { getObjectById: () => missingLab ? null : lab } },
        modules: {
            'creep/boosting': { getActiveRoomBoostRequests: () => [] },
            'runtime/creepIndex': { getRoomProcessors: () => [] },
            'room/resourceNetwork': {
            getTerminalResourceAmount: (_, resource) => (terminal.store[resource] || 0) - withdrawn,
            recordTerminalWithdrawal: (_, resource, amount) => { if (resource === 'KH2O') withdrawn += amount; },
            isWarehouseRoom: () => false,
        } } })
        .load('role/adv/RoleAdvProcesser').default({});
    return { calls, room, lab, creep, behavior };
}

test('lab mineral movers obtain the exact requested boost amount directly from terminal stock', () => {
    const w = processorWorld();
    w.behavior.source(w.creep);
    assert.deepEqual(w.calls, [['withdraw', 'terminal', 'KH2O', 300]]);
    assert.equal(w.creep.memory.working, true);
});

test('lab mineral movers safely remove destroyed or satisfied targets rather than withdrawing a zero batch', () => {
    const missing = processorWorld({ missingLab: true });
    assert.doesNotThrow(() => missing.behavior.source(missing.creep));
    assert.deepEqual(Array.from(missing.room.memory.roomFillJob.labInMineral), []);
    const satisfied = processorWorld(); satisfied.lab.store.KH2O = 300;
    satisfied.behavior.source(satisfied.creep);
    assert.deepEqual(satisfied.calls, []);
    assert.deepEqual(Array.from(satisfied.room.memory.roomFillJob.labInMineral), []);
});

test('lab mineral movers never deliver the new compound into a lab containing the previous tier', () => {
    const w = processorWorld(); w.lab.mineralType = 'KH'; w.creep.store.KH2O = 100;
    w.behavior.target(w.creep);
    assert.deepEqual(w.calls, [['put', 'terminal', 'KH2O']], 'retain useful carried mineral in a real stock building');
    assert.equal(w.creep.memory.working, false);
});
