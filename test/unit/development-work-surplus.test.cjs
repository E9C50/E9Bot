const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world({ role = 'upgrader', work = 13, quota = 5, energy = 72000, level = 6, fullBody = true } = {}) {
    const game = { time: 1 };
    const home = { controller: { my: true, level }, memory: { creepConfig: {} } };
    if (energy !== undefined) home.storage = { store: { energy } };
    const unit = { name: `${role}-surplus`, room: home, memory: { role, development: { fullBody } },
        store: { energy: 500 }, getActiveBodyparts: type => type === 'work' ? work : 1 };
    home.memory.creepConfig[unit.name] = { development: { workParts: quota, fullBody: true } };
    const loader = createSourceLoader({ globals: { Game: game, WORK: 'work', RESOURCE_ENERGY: 'energy' } });
    const policy = loader.load('settings/development').developmentPolicy;
    const allowed = loader.load('creep/development').developmentWorkAllowed;
    function actions(ticks) {
        let count = 0;
        for (let tick = 0; tick < ticks; tick++, game.time++) if (allowed(unit)) count++;
        return count;
    }
    return { game, home, unit, policy, allowed, actions, work };
}

for (const [role, work, quota] of [['repairer', 6, 1], ['upgrader', 13, 5], ['builder', 6, 2]]) {
    test(`a paid ${role} uses its complete WORK body every tick while Storage has surplus energy`, () => {
        const state = world({ role, work, quota });
        const before = JSON.stringify({ room: state.home.memory, creep: state.unit.memory });
        const actions = state.actions(work * 2);
        assert.equal(actions, work * 2, 'real Storage stock funds continuous action instead of an income duty cycle');
        assert.equal(actions * work, work * work * 2, 'every permitted native intent uses all active WORK');
        assert.equal(JSON.stringify({ room: state.home.memory, creep: state.unit.memory }), before);
    });
}

test('a funded living body may spend Storage surplus even when its newly published income allowance is zero', () => {
    for (const role of ['repairer', 'upgrader', 'builder']) {
        const state = world({ role, work: 10, quota: 0 });
        assert.equal(state.actions(20), 20, role);
        assert.equal(state.home.memory.creepConfig[state.unit.name].development.workParts, 0,
            'using paid-for capacity does not raise population or birth demand');
    }
});

test('Terminal energy does not authorize spending past the Storage recovery reserve', () => {
    for (const supply of ['absent', 'empty', 'reserve']) {
        const state = world({ work: 13, quota: 5, energy: 0 });
        if (supply === 'absent') delete state.home.storage;
        if (supply === 'reserve') state.home.storage.store.energy = state.policy.upgrading.storageReserve;
        state.home.terminal = { store: { energy: 50000 } };
        assert.equal(state.actions(26), 10, supply);
        assert.equal(state.home.terminal.store.energy, 50000);
    }
});

test('the exact Storage reserve keeps the income budget and one energy above it permits immediate work', () => {
    const state = world({ role: 'repairer', work: 6, quota: 0 });
    state.home.storage.store.energy = state.policy.upgrading.storageReserve;
    assert.equal(state.actions(12), 0);
    state.home.storage.store.energy++;
    assert.equal(state.actions(12), 12);
});

test('falling back to the reserve restores the published income allowance without resetting Memory', () => {
    const state = world({ role: 'upgrader', work: 13, quota: 5 });
    const before = JSON.stringify({ room: state.home.memory, creep: state.unit.memory });
    assert.equal(state.actions(26), 26);
    state.home.storage.store.energy = state.policy.upgrading.storageReserve;
    assert.equal(state.actions(26), 10);
    state.home.storage.store.energy--;
    assert.equal(state.actions(26), 10);
    state.home.storage.store.energy = state.policy.upgrading.storageReserve + 1;
    assert.equal(state.actions(26), 26);
    assert.equal(JSON.stringify({ room: state.home.memory, creep: state.unit.memory }), before);
});

test('low stock retains exact and fractional income budgets without persisting timing credits', () => {
    for (const [role, work, quota, expected] of [['repairer', 6, 1, 2], ['upgrader', 13, 5, 10],
        ['builder', 6, 2, 4], ['builder', 6, 1.9, 2], ['repairer', 6, 0, 0]]) {
        const state = world({ role, work, quota, energy: 0 });
        const before = JSON.stringify({ room: state.home.memory, creep: state.unit.memory });
        assert.equal(state.actions(work * 2), expected, `${role}: ${quota}/${work}`);
        assert.equal(JSON.stringify({ room: state.home.memory, creep: state.unit.memory }), before);
    }
});

test('RCL8 and disabled development still exit before accessing growth stores, catalogs or active parts', () => {
    for (const disabled of ['level8', 'fastUpgrade']) {
        const state = world({ level: disabled === 'level8' ? 8 : 6 });
        if (disabled === 'fastUpgrade') state.home.memory.fastUpgrade = false;
        Object.defineProperty(state.home, 'storage', { get() { throw new Error('growth Storage must not be read'); } });
        Object.defineProperty(state.home.memory, 'creepConfig', { get() { throw new Error('growth catalog must not be read'); } });
        state.unit.getActiveBodyparts = () => { throw new Error('growth WORK must not be read'); };
        assert.equal(state.allowed(state.unit), true);
    }
});

test('legacy upgraders keep their paid-for behavior even below the Storage reserve', () => {
    const state = world({ role: 'upgrader', work: 13, quota: 0, energy: 0, fullBody: false });
    assert.equal(state.actions(26), 26);
});
