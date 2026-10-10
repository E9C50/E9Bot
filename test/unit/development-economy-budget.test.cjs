const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world() {
    const room = { name: 'W1N1', energyCapacityAvailable: 2200, memory: { creepConfig: {} } };
    const game = { creeps: {} };
    const loader = createSourceLoader({ globals: { Game: game, WORK: 'work', BUILD_POWER: 5, CREEP_LIFE_TIME: 1500 } });
    const budget = loader.load('creep/developmentEconomyBudget').applyDevelopmentEconomyBudget;
    const add = (role, workParts, priority = 5) => {
        const key = `${role}_native`, config = { role, name: key, displayName: key, spawnPriority: priority,
            development: { fullBody: true, workParts } };
        room.memory.creepConfig[key] = config;
        return config;
    };
    return { room, game, add, budget: (...args) => budget(room, ...args) };
}

const spending = result => result.upkeep + result.maintenance + result.repairing + result.building + result.upgrading;

test('two 10-energy mines reserve complete mining, haul and hub births before their consumers', () => {
    const w = world();
    const repairer = w.add('repairer', 1), builder = w.add('builder', 1, 4);
    w.add('upgrader', 13);
    const essential = (2 * 2100 + 3 * 2200 + 2200) / 1500;
    const result = w.budget(20, 20, essential, 0);
    assert.ok(spending(result) <= 20);
    assert.equal(builder.development.workParts, 1, 'one complete construction intent is affordable');
    assert.equal(repairer.development.workParts, 1);
    assert.equal(w.room.memory.creepConfig.upgrader_native, undefined, 'another full body would make its first WORK unaffordable');
});

test('a single mine pays the permanent repair fleet without inventing another consumer budget', () => {
    const w = world();
    const repairer = w.add('repairer', 1); w.add('builder', 1, 4); w.add('upgrader', 8);
    const result = w.budget(10, 10, (2100 + 2 * 2200 + 2200) / 1500, 0);
    assert.ok(spending(result) <= 10);
    assert.equal(repairer.development.workParts, 1);
    assert.equal(w.room.memory.creepConfig.builder_native, undefined);
    assert.equal(w.room.memory.creepConfig.upgrader_native, undefined);
});

test('no arrived income keeps the repair floor idle and suppresses new complete consumer bodies', () => {
    const w = world();
    const repairer = w.add('repairer', 1); w.add('builder', 1, 4); w.add('upgrader', 1);
    w.budget(0, 0, 7.2, 0);
    assert.equal(repairer.development.workParts, 0);
    assert.equal(repairer.development.fullBody, true);
    assert.equal(w.room.memory.creepConfig.builder_native, undefined);
    assert.equal(w.room.memory.creepConfig.upgrader_native, undefined);
});

test('unfunded living full bodies retain their jobs with zero actions until income arrives', () => {
    const w = world();
    const builder = w.add('builder', 4, 4), upgrader = w.add('upgrader', 13);
    for (const config of [builder, upgrader]) w.game.creeps[config.name] = {
        memory: { development: { fullBody: true } }, getActiveBodyparts: () => 13,
    };
    w.budget(0, 0, 7.2, 0);
    assert.equal(builder.development.workParts, 0);
    assert.equal(upgrader.development.workParts, 0);
    assert.equal(Object.keys(w.room.memory.creepConfig).length, 2);
});

test('legacy resident upgrade consumption is charged before granting any new full-body work', () => {
    const w = world();
    const old = w.add('upgrader', 8);
    w.game.creeps[old.name] = { memory: { development: {} }, getActiveBodyparts: () => 8 };
    w.room.memory.creepConfig.next = { role: 'upgrader', name: 'next', displayName: 'next',
        spawnPriority: 5, development: { fullBody: true, workParts: 8 } };
    const repairer = w.add('repairer', 1);
    const result = w.budget(10, 10, 2, 0);
    assert.equal(old.development.workParts, 8);
    assert.equal(result.upgrading, 8);
    assert.equal(w.room.memory.creepConfig.next, undefined);
    assert.equal(repairer.development.workParts, 0, 'repair actions cannot ignore the fixed legacy spending');
});

test('necessary bootstrap construction and urgent downgrade work retain their complete-body exception', () => {
    const w = world();
    const builder = w.add('builder', 1, 0.75), upgrader = w.add('upgrader', 1, 1.5);
    w.budget(0, 0, 7.2, 0);
    assert.equal(builder.development.workParts, 1);
    assert.equal(upgrader.development.workParts, 1);
    assert.equal(builder.development.fullBody, true);
    assert.equal(upgrader.development.fullBody, true);
});
