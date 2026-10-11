const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world({ stored = 300000, ready = true, developing = true } = {}) {
    const room = { name: 'W1N1', energyCapacityAvailable: 1600, storage: { store: { energy: stored } }, memory: { creepConfig: {} } };
    const game = { creeps: {} };
    const loader = createSourceLoader({ globals: { Game: game, WORK: 'work', CARRY: 'carry', RESOURCE_ENERGY: 'energy' },
        modules: { './development': { isDevelopingRoom: () => developing },
            './remoteHomeEconomy': { hasRemoteHomeEconomy: () => ready },
            './developmentEconomyBudget': { developmentBodyCostCeiling: () => 1600 } } });
    const order = loader.load('creep/developmentConsumerPriority').prioritizeDevelopmentConsumers;
    const add = (name, role, priority, work = 1) => {
        room.memory.creepConfig[name] = { name, role, spawnRoom: room.name, spawnPriority: priority, development: { fullBody: true, workParts: work } };
        return name;
    };
    const resident = (name, role, spawning = false) => { game.creeps[name] = { memory: { role, spawnRoom: room.name }, spawning,
        getActiveBodyparts: () => 1 }; };
    return { room, game, add, resident, order: queue => Array.from(order(room, queue, game.creeps)) };
}

test('funded missing jobs follow local recovery and NPC defence, before remote and hauling expansion', () => {
    const w = world();
    const queue = [w.add('miner', 'harvester', 1), w.add('firstFiller', 'filler', 2), w.add('defender', 'rAttacker', 2.5),
        w.add('remote', 'rFiller', 2.6), w.add('extraFiller', 'filler', 3.2), w.add('builder', 'builder', 4),
        w.add('upgrader', 'upgrader', 5), w.add('repairer', 'repairer', 6)];
    assert.deepEqual(w.order(queue), ['miner', 'firstFiller', 'defender', 'builder', 'upgrader', 'repairer', 'remote', 'extraFiller']);
    assert.equal(w.room.memory.creepConfig.upgrader.spawnPriority, 5, 'queue policy does not rewrite catalog or body policy');
    assert.equal(w.room.memory.creepConfig.upgrader.development.fullBody, true);
});

test('only one missing slot per role is promoted', () => {
    const w = world();
    const queue = [w.add('remote', 'rFiller', 2.6), w.add('upgradeA', 'upgrader', 5), w.add('upgradeB', 'upgrader', 5)];
    assert.deepEqual(w.order(queue), ['upgradeA', 'remote', 'upgradeB']);
});

for (const spawning of [false, true]) test(`an existing ${spawning ? 'spawning' : 'living'} worker keeps further expansion at normal priority`, () => {
    const w = world(); w.resident('paidWorker', 'upgrader', spawning);
    const queue = [w.add('remote', 'rFiller', 2.6), w.add('upgrade', 'upgrader', 5)];
    assert.deepEqual(w.order(queue), queue);
});

for (const options of [{ stored: 11599 }, { ready: false }, { developing: false }]) test(`missing jobs preserve recovery reserve and local economy: ${JSON.stringify(options)}`, () => {
    const w = world(options);
    const queue = [w.add('remote', 'rFiller', 2.6), w.add('upgrade', 'upgrader', 5)];
    assert.deepEqual(w.order(queue), queue);
});

test('an unfunded zero action quota is not promoted over essential remote income', () => {
    const w = world();
    const queue = [w.add('remote', 'rFiller', 2.6), w.add('upgrade', 'upgrader', 5, 0)];
    assert.deepEqual(w.order(queue), queue);
});

test('a crippled worker cannot conceal a missing useful role', () => {
    const w = world(); w.resident('broken', 'upgrader');
    w.game.creeps.broken.getActiveBodyparts = part => part === 'work' ? 0 : 1;
    const queue = [w.add('remote', 'rFiller', 2.6), w.add('upgrade', 'upgrader', 5)];
    assert.deepEqual(w.order(queue), ['upgrade', 'remote']);
});
