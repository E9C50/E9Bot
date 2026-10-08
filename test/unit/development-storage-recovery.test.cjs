const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const nativeBodies = require('../helpers/native-bodies.cjs');

const costs = { work: 100, carry: 50, move: 50, claim: 600, tough: 10, attack: 80, ranged_attack: 150, heal: 250 };
function world({ available = 500, stock = 5545 } = {}) {
    const p = (x, y) => ({ x, y, roomName: 'E39N5' });
    const room = { name: 'E39N5', my: true, level: 6,
        controller: { my: true, level: 6, ticksToDowngrade: 116373, pos: p(9, 29) },
        energyCapacityAvailable: 2150, energyAvailable: available,
        storage: { id: 'storage', store: { energy: stock }, pos: p(18, 29) },
        sources: [{ id: 'source1', pos: p(42, 32) }, { id: 'source2', pos: p(36, 34) }],
        containers: [{ id: 'source-container', pos: p(43, 33) }], links: [], spawns: [],
        memory: { creepConfig: {}, creepSpawnQueue: [] } };
    const game = { time: 100, creeps: {}, rooms: { E39N5: room } }, births = [];
    const demand = (role, priority, sourceId, development) => ({ role, name: `${role}-${sourceId}`,
        spawnRoom: room.name, data: { sourceId }, spawnPriority: priority, development });
    room.memory.creepConfig = {
        missingMine: demand('harvester', 1, 'source2', { workParts: 5, stationary: true }),
        missingHaul: demand('filler', 2, 'source2', { carryParts: 11 }),
        storageHaul: demand('filler', 2, 'storage', { carryParts: 4 }),
        reserver: demand('reserver', 2.7, undefined, undefined),
        largerMine: demand('harvester', 3.1, 'source1', { workParts: 5, stationary: true }),
        largerHaul: demand('filler', 3.2, 'source-container', { carryParts: 14 }),
        builder: demand('builder', 4, 'storage', { workParts: 1 }),
        upgrader: demand('upgrader', 5, 'storage', { workParts: 1 }),
    };
    function unit(name, role, data, parts, spawning = false) {
        const creep = { name, room, spawning, pos: p(43, 33), ticksToLive: 1000,
            memory: { role, spawnRoom: room.name, data },
            getActiveBodyparts: part => parts.filter(type => type === part).length };
        game.creeps[name] = creep;
        return creep;
    }
    const miner = unit('liveMiner', 'harvester', { sourceId: 'source1' }, ['work', 'work', 'work', 'work', 'carry', 'move']);
    const carrier = unit('liveCarrier', 'filler', { sourceId: 'source-container', mineId: 'source1' }, ['carry', 'move']);
    class NativeSpawn {
        spawnCreep(body, name, { memory }) {
            const cost = body.reduce((total, part) => total + costs[part], 0);
            if (cost > room.energyAvailable) return -6;
            room.energyAvailable -= cost;
            births.push({ body: Array.from(body), name, cost });
            const born = unit(name, memory.role, memory.data, Array.from(body), true);
            born.memory = { ...memory };
            return 0;
        }
    }
    const loader = createSourceLoader({ globals: { ...nativeBodies.globals, Game: game, Memory: {},
        RESOURCE_ENERGY: 'energy', BODYPART_COST: costs, StructureSpawn: NativeSpawn, OK: 0 },
        modules: { ...nativeBodies.modules, role: { isRoleSupported: () => true, createRoleBehavior: () => ({ isNeed: () => true }) },
            utils: { sha1String: name => name },
            'creep/developmentRemotes': { isDevelopmentRemoteData: () => false },
            'creep/remoteCommissioning': { remoteSpawnAllowed: () => true },
            'combat/spawning': { combatSpawnAllowed: () => true, recordCombatSpawn() {} },
            'shard/targetDismantleControl': { isTargetDismantleSpawnReserved: () => false },
        } });
    const spawn = new (loader.load('mount/structure/SpawnExtension').default)();
    spawn.room = room; room.spawns.push(spawn);
    const queue = () => Array.from(loader.load('creep/spawnQueue').buildSpawnQueue(room));
    return { room, game, miner, carrier, unit, loader, births, spawn, queue };
}

test('a funded Storage carrier breaks the live shard1 stall before unaffordable mining and remote bodies', () => {
    const w = world();
    w.room.memory.creepSpawnQueue = w.queue();
    assert.equal(w.room.memory.creepSpawnQueue[0], 'storageHaul');
    w.spawn.doWork();
    assert.deepEqual(w.births, [{ name: 'storageHaul', cost: 400,
        body: ['carry', 'carry', 'carry', 'carry', 'move', 'move', 'move', 'move'] }]);
    assert.equal(w.room.energyAvailable, 100);
    assert.equal(w.queue()[0], 'missingMine', 'once recovery has begun, restoring the empty Source is first again');
});

test('Storage recovery never displaces the first Source carrier before a local production pair works', () => {
    for (const change of [w => { w.carrier.spawning = true; },
        w => { w.carrier.memory.data = { sourceId: 'unrelated' }; },
        w => { w.miner.pos = { x: 20, y: 20, roomName: 'E39N5' }; }]) {
        const w = world(); change(w);
        assert.equal(w.queue()[0], 'missingMine');
    }
});

test('an existing usable or spawning Storage carrier keeps expansion demands at their ordinary priorities', () => {
    for (const spawning of [false, true]) {
        const w = world(); w.unit('storageResident', 'filler', { sourceId: 'storage' }, ['carry', 'move'], spawning);
        assert.equal(w.queue()[0], 'missingMine');
    }
    const w = world();
    w.room.memory.creepConfig.secondStorage = { ...w.room.memory.creepConfig.storageHaul };
    w.room.memory.creepSpawnQueue = w.queue(); w.spawn.doWork();
    w.room.energyAvailable = 500;
    assert.equal(w.queue()[0], 'missingMine', 'a second pending Storage filler must not preempt restored mining');
});

test('foreign-home, disabled, or waiting-for-boost carriers cannot disguise absent Storage transport', () => {
    for (const change of [unit => { unit.memory.spawnRoom = 'E39N4'; },
        unit => { unit.getActiveBodyparts = () => 0; },
        unit => { unit.memory.boostPlan = { steps: [{ resource: 'XKH2O' }] }; },
        unit => { unit.memory.data.mineId = 'source1'; }]) {
        const w = world(), unit = w.unit('invalidStorage', 'filler', { sourceId: 'storage' }, ['carry', 'move']);
        change(unit); assert.equal(w.queue()[0], 'storageHaul');
    }
});

test('no promotion spends nonexistent recovery stock or blocks a full spawn pool', () => {
    for (const options of [{ stock: 0 }, { stock: 399 }, { available: 300 }, { available: 2150 }]) {
        const w = world(options);
        assert.equal(w.queue()[0], 'missingMine');
    }
});

test('recovery uses the actual custom body cost rather than assuming a four-CARRY carrier', () => {
    const w = world({ available: 300, stock: 350 });
    w.room.memory.bodyProfiles = { filler: { boostTier: 0, maximumCost: 300 } };
    w.room.memory.creepSpawnQueue = w.queue();
    assert.equal(w.room.memory.creepSpawnQueue[0], 'storageHaul');
    w.spawn.doWork(); assert.equal(w.births[0].cost, 300);
});

test('an affordable downgrade rescue spawns before a second Source miner while local production is already working', () => {
    const w = world({ available: 200 });
    w.room.controller.ticksToDowngrade = 100;
    Object.assign(w.room.memory.creepConfig.upgrader, { spawnPriority: 1.5,
        development: { workParts: 1, carryParts: 1, maximumCost: 200 }, bodyProfile: { boostTier: 0 } });
    w.room.memory.creepSpawnQueue = w.queue();
    assert.equal(w.room.memory.creepSpawnQueue[0], 'upgrader');
    w.spawn.doWork();
    assert.deepEqual(w.births, [{ name: 'upgrader', cost: 200, body: ['work', 'carry', 'move'] }]);
});

test('downgrade rescue never bypasses restoring the first working mine and source carrier', () => {
    const w = world({ available: 200 });
    w.room.controller.ticksToDowngrade = 100;
    Object.assign(w.room.memory.creepConfig.upgrader, { spawnPriority: 1.5,
        development: { workParts: 1, carryParts: 1, maximumCost: 200 }, bodyProfile: { boostTier: 0 } });
    w.carrier.spawning = true;
    assert.equal(w.queue()[0], 'missingMine');
    w.carrier.spawning = false; w.room.energyAvailable = 199;
    assert.equal(w.queue()[0], 'missingMine', 'rescue promotion must not publish an unpaid birth ahead of recovery');
});
