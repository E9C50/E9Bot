const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const nativeBodies = require('../helpers/native-bodies.cjs');

const costs = { work: 100, carry: 50, move: 50, claim: 600, tough: 10, attack: 80, ranged_attack: 150, heal: 250 };
function world({ available = 500, stock = 5545 } = {}) {
    const p = (x, y) => ({ x, y, roomName: 'E39N5', inRangeTo(other, radius) {
        const position = other.pos || other;
        return position.roomName === 'E39N5' && Math.max(Math.abs(x - position.x), Math.abs(y - position.y)) <= radius;
    } });
    const room = { name: 'E39N5', my: true, level: 6,
        controller: { my: true, level: 6, ticksToDowngrade: 116373, pos: p(9, 29) },
        energyCapacityAvailable: 2150, energyAvailable: available,
        storage: { id: 'storage', store: { energy: stock }, pos: p(18, 29) },
        sources: [{ id: 'source1', pos: p(42, 32) }, { id: 'source2', pos: p(36, 34) }],
        containers: [{ id: 'source-container', pos: p(43, 33) }], links: [], spawns: [],
        memory: { creepConfig: {}, creepSpawnQueue: [] } };
    const game = { time: 100, creeps: {}, rooms: { E39N5: room }, getObjectById: () => null }, births = [];
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

test('the last small miner funds a complete Storage distributor first while the Spawn pool is still below its body cost', () => {
    const w = world({ available: 550, stock: 5045 });
    delete w.game.creeps[w.carrier.name];
    w.miner.getActiveBodyparts = part => part === 'work' || part === 'move' ? 2 : part === 'carry' ? 1 : 0;
    for (const config of Object.values(w.room.memory.creepConfig)) if (config.development) config.development.fullBody = true;
    for (const energy of [550, 2099]) {
        w.room.energyAvailable = energy;
        w.room.memory.creepSpawnQueue = w.queue();
        assert.equal(w.room.memory.creepSpawnQueue[0], 'storageHaul');
        w.spawn.doWork();
        assert.equal(w.births.length, 0, 'one surviving miner must not permit a partial-energy body');
    }
    w.room.energyAvailable = 2100;
    w.spawn.doWork();
    assert.equal(w.births.length, 1);
    assert.equal(w.births[0].name, 'storageHaul');
    assert.equal(w.births[0].cost, 2100);
    assert.equal(w.births[0].body.length, 42);
    assert.equal(w.births[0].body.filter(part => part === 'carry').length, 21);
    assert.equal(w.births[0].body.filter(part => part === 'move').length, 21);
    assert.equal(w.queue()[0], 'missingMine', 'the committed distributor frees the normal mining queue');
});

test('unpaid distribution priority reads live full-body funding and body profiles without waiting for a new tick', () => {
    const w = world({ available: 550, stock: 1549 });
    delete w.game.creeps[w.carrier.name];
    for (const config of Object.values(w.room.memory.creepConfig)) if (config.development) config.development.fullBody = true;
    assert.notEqual(w.queue()[0], 'storageHaul', 'insufficient combined depot and Spawn energy cannot fund the complete distributor');
    w.room.storage.store.energy = 1550;
    assert.equal(w.queue()[0], 'storageHaul');
    w.room.storage.store.energy = 500;
    assert.notEqual(w.queue()[0], 'storageHaul');
    w.room.memory.bodyProfiles = { filler: { maximumCost: 500, boostTier: 0 } };
    assert.equal(w.queue()[0], 'storageHaul', 'an explicit smaller complete profile has its actual cost');
    delete w.room.memory.bodyProfiles;
    assert.notEqual(w.queue()[0], 'storageHaul');
    w.room.storage.store.energy = 5045;
    w.room.energyAvailable = w.room.energyCapacityAvailable;
    assert.equal(w.queue()[0], 'storageHaul', 'a funded full Spawn pool still starts its missing distributor first');
});

test('exactly funded recovery retains its Storage-first birth while energy moves through the last miner', () => {
    const w = world({ available: 650, stock: 1450 });
    delete w.game.creeps[w.carrier.name];
    for (const config of Object.values(w.room.memory.creepConfig)) if (config.development) config.development.fullBody = true;
    w.miner.store = { energy: 0 };
    assert.equal(w.queue()[0], 'storageHaul');
    w.room.storage.store.energy = 1400;
    w.miner.store.energy = 50;
    assert.equal(w.queue()[0], 'storageHaul', '50 in transit still belongs to the same 2100-energy birth');
    w.miner.memory.spawnRoom = 'E39N4';
    assert.notEqual(w.queue()[0], 'storageHaul', 'foreign cargo cannot pay a home recovery birth');
    w.miner.memory.spawnRoom = w.room.name;
    w.miner.store.energy = 0;
    w.room.energyAvailable = 700;
    assert.equal(w.queue()[0], 'storageHaul');
    w.room.storage.store.energy = 0;
    w.room.energyAvailable = 2100;
    assert.equal(w.queue()[0], 'storageHaul', 'fully delivered funding remains available after Storage empties');
    w.room.memory.creepSpawnQueue = w.queue();
    w.spawn.doWork();
    assert.equal(w.births[0].name, 'storageHaul');
    assert.equal(w.births[0].cost, 2100);
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

test('missing distribution waits on combined funding rather than two independently full energy pools', () => {
    for (const options of [{ stock: 0, available: 399 }, { stock: 100, available: 299 }]) {
        const w = world(options);
        assert.equal(w.queue()[0], 'missingMine');
    }
    for (const options of [{ stock: 0 }, { stock: 399 }, { available: 300 }, { available: 2150 }]) {
        const w = world(options);
        assert.equal(w.queue()[0], 'storageHaul');
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
    assert.equal(w.queue()[0], 'storageHaul', 'an unpaid controller rescue does not displace funded Spawn distribution');
});

function fullRecovery(w) {
    w.room.energyCapacityAvailable = 2200;
    for (const config of Object.values(w.room.memory.creepConfig)) if (config.development) config.development.fullBody = true;
    w.room.memory.creepConfig.manager = { role: 'manager', spawnRoom: w.room.name, data: {}, spawnPriority: 0,
        development: { fullBody: true, stationary: true } };
}

test('a live mine carrier cannot hide a missing complete distributor while split funding moves into Spawn', () => {
    const w = world({ available: 2000, stock: 200 }); fullRecovery(w);
    w.room.memory.creepSpawnQueue = w.queue();
    assert.equal(w.room.memory.creepSpawnQueue[0], 'storageHaul');
    w.spawn.doWork(); assert.equal(w.births.length, 0, '2000 cannot shrink the complete 2200-energy distributor');
    w.room.energyAvailable = 2200; w.room.storage.store.energy = 0;
    assert.equal(w.queue()[0], 'storageHaul');
    w.spawn.doWork(); assert.deepEqual(w.births.map(({ name, cost, body }) => ({ name, cost, parts: body.length })),
        [{ name: 'storageHaul', cost: 2200, parts: 44 }]);
});

test('missing production and its full-body successor precede a payable Manager even in a stale queue', () => {
    for (const replacement of [false, true]) {
        const w = world({ available: 2200, stock: 0 }); fullRecovery(w);
        w.unit('storageResident', 'filler', { sourceId: 'storage' }, ['carry', 'move']);
        if (replacement) w.room.memory.creepConfig.missingMine.development.replacement = { predecessor: 'liveMiner', deadline: 250 };
        assert.equal(w.queue()[0], 'missingMine');
        w.room.memory.creepSpawnQueue = ['manager', 'missingMine'];
        w.spawn.doWork();
        assert.equal(w.births[0].name, 'missingMine'); assert.equal(w.births[0].cost, 2100);
        assert.equal(w.births[0].body.length, 29);
        assert.deepEqual(Array.from(w.room.memory.creepSpawnQueue), ['manager']);
    }
});

test('healthy expansion retains Manager priority and published handovers are ordered by deadline', () => {
    const w = world({ available: 2200, stock: 0 }); fullRecovery(w);
    w.unit('storageResident', 'filler', { sourceId: 'storage' }, ['carry', 'move']);
    delete w.room.memory.creepConfig.missingMine;
    assert.equal(w.queue()[0], 'manager', 'healthy mining expansion keeps its existing 3.1 priority');
    w.room.memory.creepConfig.largerMine.development.replacement = { predecessor: 'liveMiner', deadline: 250 };
    w.room.memory.creepConfig.largerHaul.development.replacement = { predecessor: 'liveCarrier', deadline: 200 };
    assert.deepEqual(w.queue().slice(0, 3), ['largerHaul', 'largerMine', 'manager']);
});

test('Spawn fallback distinguishes mine imports from complete Storage distribution', () => {
    const w = world({ available: 2200, stock: 0 }); fullRecovery(w);
    assert.equal(w.spawn.affordableRecovery(['manager', 'storageHaul']).memory,
        w.room.memory.creepConfig.storageHaul);
    w.unit('storageResident', 'filler', { sourceId: 'storage' }, ['carry', 'move']);
    assert.equal(w.spawn.affordableRecovery(['manager', 'storageHaul']), undefined);
    w.room.memory.creepConfig.storageHaul.development.replacement = { predecessor: 'storageResident', deadline: 200 };
    assert.equal(w.spawn.affordableRecovery(['manager', 'storageHaul']).memory,
        w.room.memory.creepConfig.storageHaul, 'a living predecessor cannot mask its published handover');
});

test('a fresh temporary Spawn provider keeps the dedicated complete distributor before optional births', () => {
    const w = world({ available: 300, stock: 0 }); fullRecovery(w);
    w.carrier.memory.productionRecoverySpawn = { roomName: w.room.name, tick: w.game.time };
    assert.equal(w.queue()[0], 'storageHaul');
    w.room.memory.creepSpawnQueue = w.queue(); w.spawn.doWork();
    assert.equal(w.births.length, 0, 'temporary production cannot authorize a partial body');
    w.carrier.memory.productionRecoverySpawn.tick = w.game.time - 2;
    assert.equal(w.queue()[0], 'missingMine', 'expired recovery work no longer reserves the distributor birth');
});


test('one restored mine keeps its expiring carrier handover before spending a birth on the second empty Source', () => {
    const w = world({ available: 2200, stock: 0 }); fullRecovery(w);
    w.unit('storageResident', 'filler', { sourceId: 'storage' }, ['carry', 'move']);
    w.carrier.ticksToLive = 250;
    w.room.memory.creepConfig.largerHaul.development.replacement = { predecessor: w.carrier.name, deadline: 350 };
    assert.deepEqual(w.queue().slice(0, 3), ['largerHaul', 'missingMine', 'manager']);
    w.room.memory.creepSpawnQueue = ['manager', 'missingMine', 'largerHaul'];
    w.spawn.doWork();
    assert.equal(w.births[0].name, 'largerHaul', 'the stale Manager head cannot bring second-mine expansion ahead of handover');
    assert.equal(w.births[0].cost, 2200);
});

test('complete loss of usable local miners still restores mining before a published carrier handover', () => {
    for (const disable of [w => { delete w.game.creeps[w.miner.name]; },
        w => { w.miner.getActiveBodyparts = () => 0; },
        w => { w.miner.memory.spawnRoom = 'E39N4'; }]) {
        const w = world({ available: 2200, stock: 0 }); fullRecovery(w);
        w.unit('storageResident', 'filler', { sourceId: 'storage' }, ['carry', 'move']);
        w.room.memory.creepConfig.largerHaul.development.replacement = { predecessor: w.carrier.name, deadline: 350 };
        disable(w);
        assert.equal(w.queue()[0], 'missingMine');
    }
});
