const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world({ work = 5, carry = 1, energy = 0, sourceEnergy = 3000, boost, result = 0, stats = {} } = {}) {
    const game = { time: 1, shard: { name: 'shard3' }, getObjectById: () => null };
    const memory = { stats: { rooms: { W1N1: stats } } };
    const parts = [...Array(work).fill('work'), ...Array(carry).fill('carry'), 'move']
        .map(type => ({ type, hits: 100, ...(type === 'work' && boost ? { boost } : {}) }));
    let bodyReads = 0, nativeCalls = 0;
    class Creep {
        moveTo() { return 0; } move() { return 0; } build() { return 0; }
        repair() { return 0; } dismantle() { return 0; }
        harvest() { nativeCalls++; return result; }
    }
    class PowerCreep { moveTo() { return 0; } }
    class RoomPosition {}
    const creep = new Creep();
    Object.assign(creep, { id: 'creep-original', name: 'miner', memory: { boostPlan: { tier: 0, steps: [] } },
        hitsMax: parts.length * 100, ticksToLive: 1499,
        store: { getCapacity: () => carry * 50, getFreeCapacity: () => carry * 50 - energy } });
    Object.defineProperties(creep, {
        body: { get() { bodyReads++; return parts; } },
        hits: { get: () => parts.reduce((sum, part) => sum + part.hits, 0) },
    });
    creep.getActiveBodyparts = () => { throw new Error('harvest power cache must not call a native body traversal'); };
    const source = { energy: sourceEnergy, energyCapacity: 3000, pos: { roomName: 'W1N1' },
        get room() { throw new Error('the statistics wrapper must use Source.pos.roomName'); } };
    const loader = createSourceLoader({ globals: { Game: game, Memory: memory, Creep, PowerCreep, RoomPosition,
        PathFinder: { CostMatrix: class {} }, OBSTACLE_OBJECT_TYPES: [], WORK: 'work', RESOURCE_ENERGY: 'energy',
        HARVEST_POWER: 2, CREEP_LIFE_TIME: 1500, BOOSTS: { work: { XUHO2: { harvest: 7 } } }, OK: 0 },
        modules: { 'settings/settings': { findPathAvoidRooms: [], observersFindPathIdList: [] },
            'runtime/observerScheduling': { scheduleObservation: () => 0 } } });
    loader.load('utils/BetterMove');
    const helper = loader.load('runtime/harvestPower');
    return { game, memory, creep, source, parts, stats, helper, bodyReads: () => bodyReads, nativeCalls: () => nativeCalls };
}

test('BetterMove native harvest statistics start at zero and reuse the same scalar power cache as mining', () => {
    const w = world();
    assert.equal(w.helper.getHarvestPower(w.creep), 10);
    for (let tick = 0; tick < 20; tick++) {
        assert.equal(w.creep.harvest(w.source), 0);
        w.game.time++; w.creep.ticksToLive--;
    }
    assert.equal(w.stats.energyHarvested, 200); assert.equal(w.nativeCalls(), 20);
    assert.equal(w.bodyReads(), 1, 'healthy stable miners do not re-read their native body for statistics');
    assert.equal(w.creep.memory.dontPullMe, true);
});

test('successful energy statistics honor active boosts, remaining source energy and initial Store free capacity', () => {
    const cases = [
        [{ work: 1, boost: 'XUHO2' }, 14],
        [{ work: 1, boost: 'XUHO2', sourceEnergy: 5 }, 5],
        [{ work: 1, boost: 'XUHO2', energy: 48 }, 2],
        [{ work: 1, boost: 'XUHO2', carry: 0 }, 14],
    ];
    for (const [options, expected] of cases) {
        const w = world(options); w.creep.harvest(w.source);
        assert.equal(w.stats.energyHarvested, expected);
    }
    const w = world({ work: 3 }); w.parts[0].hits = 0;
    w.creep.harvest(w.source); assert.equal(w.stats.energyHarvested, 4);
});

test('failed/mineral/deposit harvests and absent room statistics never analyse the body', () => {
    const failed = world({ result: -9 }); failed.creep.harvest(failed.source);
    assert.equal(failed.stats.energyHarvested, undefined); assert.equal(failed.bodyReads(), 0);
    const mineral = world(); mineral.creep.harvest({ mineralAmount: 1000, pos: { roomName: 'W1N1' } });
    mineral.creep.harvest({ depositType: 'metal', pos: { roomName: 'W1N1' } });
    assert.equal(mineral.stats.energyHarvested, undefined); assert.equal(mineral.bodyReads(), 0);
    const missing = world(); delete missing.memory.stats;
    assert.equal(missing.creep.harvest(missing.source), 0); assert.equal(missing.bodyReads(), 0);
});

test('legacy statistic room aliases and non-finite counters remain safe', () => {
    const w = world({ stats: { energyHarvested: NaN } });
    w.memory.stats.rooms.W2N2 = w.stats; delete w.memory.stats.rooms.W1N1;
    w.creep.memory.room = 'W2N2'; w.creep.harvest(w.source);
    assert.equal(w.stats.energyHarvested, 10);
});

test('power cache refreshes for damage distribution, healing, completed boosts, renewal and same-name newborn IDs', () => {
    const w = world({ work: 2 });
    w.parts[0].boost = 'XUHO2'; w.parts[0].hits = 0;
    assert.equal(w.helper.getHarvestPower(w.creep), 2);
    assert.equal(w.helper.getHarvestPower(w.creep), 2); assert.equal(w.bodyReads(), 1);
    w.game.time++; w.creep.ticksToLive--; w.parts[0].hits = 100; w.parts[1].hits = 0;
    assert.equal(w.helper.getHarvestPower(w.creep), 14, 'equal total health can conceal a different active boosted part');
    assert.equal(w.bodyReads(), 2);
    w.parts[1].hits = 100;
    assert.equal(w.helper.getHarvestPower(w.creep), 16);
    w.game.time++; w.creep.ticksToLive--;
    assert.equal(w.helper.getHarvestPower(w.creep), 16); assert.equal(w.bodyReads(), 3);
    w.parts[0].boost = undefined; w.creep.memory.boostPlan.completed = true;
    assert.equal(w.helper.getHarvestPower(w.creep), 4); assert.equal(w.bodyReads(), 4);
    w.creep.ticksToLive += 10;
    assert.equal(w.helper.getHarvestPower(w.creep), 4); assert.equal(w.bodyReads(), 5);
    w.creep.id = 'creep-newborn'; w.parts[0].boost = 'XUHO2';
    assert.equal(w.helper.getHarvestPower(w.creep), 16); assert.equal(w.bodyReads(), 6);
});

test('harvest power helper imports before installing Game or any native constants', () => {
    const loader = createSourceLoader();
    assert.equal(typeof loader.load('runtime/harvestPower').getHarvestPower, 'function');
});
