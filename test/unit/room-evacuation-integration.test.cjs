const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function closingRoom(name = 'W1N1') {
    return { name, my: true, memory: { evacuation: { targetRoom: 'W2N1', status: 'draining' }, roomStructure: { towerAllowRepair: 'tower' } } };
}

test('closing rooms keep initialization and defense while bypassing construction, repair, production and balancing', () => {
    const source = closingRoom(), target = { name: 'W2N1', my: true, memory: {} }, calls = [];
    const task = name => room => calls.push(`${room.name}:${name}`);
    const loader = createSourceLoader({ globals: { Game: { rooms: { W1N1: source, W2N1: target }, shard: { name: 'shard3' } } }, modules: {
        'room/defense': { autoEnableSafeMode: task('safe'), findTowerEnemy: task('enemy'), repairStructure: task('repair') },
        'room/flags': { processRoomFlags: () => calls.push('flags') },
        'room/initialization': { initializeRooms: () => calls.push('initialize'), initializeStructures: task('structures'), updateRoomSign: task('sign') },
        'room/labs': { updateLabBoostConfig: task('boost'), updateLabReactionConfig: task('reaction') },
        'room/layout': { autoComputeCenterPos: task('center'), releaseConstructionSite: task('construction') },
        'room/market': { processRoomMarket: task('market') }, 'room/terminal': { processTerminalResource: task('terminal') },
        'room/evacuation': { processRoomEvacuation: task('evacuation') },
        'settings/roomPolicy': { roomPolicy: { profiling: { enabled: false } } },
        'runtime/profiling': { isCpuProfilingEnabled: () => false },
    } });
    const run = loader.load('module/RoomController').roomController;
    run();
    assert.deepEqual(calls.filter(call => call.startsWith('W1N1:')), ['W1N1:safe', 'W1N1:enemy', 'W1N1:evacuation']);
    assert.equal(calls[0], 'initialize'); assert.equal(source.memory.roomStructure.towerAllowRepair, undefined);
    assert.ok(calls.includes('W2N1:construction')); assert.ok(calls.includes('W2N1:repair'));
    source.memory.evacuation.status = 'complete'; calls.length = 0; run();
    assert.ok(calls.includes('W1N1:evacuation')); assert.ok(!calls.includes('W1N1:construction'));
    delete source.memory.evacuation; calls.length = 0; run();
    assert.ok(calls.includes('W1N1:construction')); assert.ok(calls.includes('W1N1:terminal')); assert.ok(calls.includes('W1N1:repair'));
});

test('closing structures run only towers and spawns, and cancellation restores the ordinary production loop', () => {
    const room = closingRoom(), calls = [], unit = name => ({ doWork: () => calls.push(name) });
    Object.assign(room, { towers: [unit('tower')], spawns: [unit('spawn')], labs: [unit('lab')], links: [unit('link')], powerSpawn: unit('power'), factory: unit('factory') });
    const run = createSourceLoader({ globals: { Game: { rooms: { W1N1: room } } }, modules: {
        'room/labBoostPriority': { prioritizeLabBoostJobs: () => false },
        'runtime/cpuRecovery': { isCpuRecoveryActive: () => false, cpuRecoveryWorkDue: () => true },
    } }).load('module/StructureController').structureWorkController;
    run(); assert.deepEqual(calls, ['tower', 'spawn']);
    delete room.memory.evacuation; calls.length = 0; run();
    assert.deepEqual(calls, ['tower', 'lab', 'spawn', 'link', 'power', 'factory']);
});

test('closing population publishes only cargo helpers and defenders without erasing combat or shard mission state', () => {
    const room = closingRoom(), other = { name: 'W2N1', my: true, memory: {} }, calls = [];
    const mission = { id: 'mission', status: 'active' }, memory = { creeps: {}, shardMissions: { mission } };
    const publish = (target, role, name, data = {}) => { target.memory.creepConfig[name] = { role, data }; return name; };
    const loader = createSourceLoader({ globals: { Game: { time: 5, creeps: {}, rooms: { W1N1: room, W2N1: other } }, Memory: memory }, modules: {
        'settings/population': { populationPolicy: { refreshInterval: 5 } },
        './basePopulation': { releaseBaseCreepConfig() { publish(room, 'harvester', 'mine'); publish(other, 'harvester', 'otherMine'); } },
        './remotePopulation': { releaseJobsCreepConfig: () => publish(room, 'rBuilder', 'aid') },
        './developmentRemotes': { releaseDevelopmentRemoteConfigs: () => publish(room, 'rFiller', 'remote') },
        'shard/controller': { releaseShardCreepConfig: () => publish(room, 'sScout', 'scout') },
        './warPopulation': { releaseWarCreepConfig() { publish(room, 'defender', 'defender'); publish(room, 'rdefender', 'rdefender'); } },
        'combat/missions': { releaseCombatCreepConfigs: () => publish(room, 'attacker', 'attack') },
        './demand': { addCreepConfig: publish },
        'room/evacuation': { releaseRoomEvacuationConfigs(target, add) { calls.push(target.name); add(target, 'filler', 'cargo', { evacuationRoom: target.name }); } },
        './spawnQueue': { orderCreepSpawnQueue() { for (const target of [room, other]) target.memory.creepSpawnQueue = Object.keys(target.memory.creepConfig); } },
    } });
    loader.load('creep/population').creepNumberController();
    assert.deepEqual(room.memory.creepSpawnQueue, ['defender', 'rdefender', 'cargo']);
    assert.deepEqual(other.memory.creepSpawnQueue, ['otherMine']); assert.deepEqual(calls, ['W1N1']);
    assert.equal(memory.shardMissions.mission, mission); assert.equal(mission.status, 'active');
});

test('closing creeps enter cargo handling before retirement, boost and ordinary role work, while active squads remain excluded', () => {
    const calls = [], source = closingRoom();
    const unit = (name, extra = {}) => ({ name, room: source, spawning: false, memory: { role: 'upgrader', data: {}, spawnRoom: source.name, ...extra } });
    const game = { creeps: { local: unit('local', { boostPlan: { steps: [{}], completed: false } }), team: unit('team', { isTeam: true }), combat: unit('combat', { combatTaskId: 'attack' }) } };
    const run = createSourceLoader({ globals: { Game: game, Memory: { warMode: { W1N1: true } } }, modules: {
        role: { createRoleBehavior: () => { throw Error('ordinary role should not run'); } }, squard: {},
        'settings/creep': { warModeRole: [] }, 'settings/runtime': { runtimePolicy: { warModeScope: 'room', profiling: {} } },
        'runtime/profiling': { isCpuProfilingEnabled: () => false },
        './developmentRemotes': { isDevelopmentRemoteData: () => false },
        './developmentRetirement': { retireDevelopmentCreep: () => { throw Error('retirement should not run'); } },
        'combat/missions': { runCombatUnits() {} }, 'combat/defense': { requestTowerSupport() {} },
        './haulerRelay': { runHaulerRelays() {}, haulerRelayHandled: () => false },
        'role/support/builderMaintenance': { idleBuilderIfNoWork: () => { throw Error('maintenance should not run'); } },
        'room/evacuation': { runRoomEvacuationCreep(creep) { calls.push(creep.name); return true; } },
    } }).load('creep/execution').creepWorkController;
    run(); assert.deepEqual(calls, ['local']);
});

function terminalWorld() {
    const memory = { rooms: { W1N1: closingRoom().memory }, centerStorage: 'W1N1' }, sends = [], queues = [];
    const store = (energy, mineral = 0) => ({ energy, H: mineral, getCapacity: () => 300000, getFreeCapacity: () => 100000 });
    const room = { name: 'W2N1', my: true, level: 8, memory: { terminalSendJob: { old: { targetRoom: 'W1N1', resourceType: 'H', amount: 100 }, normal: { targetRoom: 'W3N1', resourceType: 'H', amount: 100 } } },
        storage: { store: store(20000, 20000) }, terminal: { cooldown: 0, store: store(60000, 1000), send(resource, amount, target) { sends.push({ resource, amount, target }); return 0; } },
        sendResource(target, resource, amount) { queues.push({ target, resource, amount }); return true; } };
    const source = { ...closingRoom(), storage: { store: store(0) }, terminal: { cooldown: 0, store: store(0) }, level: 8 };
    source.memory.terminalSendJob = {};
    memory.rooms.W1N1 = source.memory;
    const game = { time: 1, shard: { name: 'shard3' }, rooms: { W1N1: source, W2N1: room }, market: { calcTransactionCost: amount => Math.ceil(amount / 10) } };
    const loader = createSourceLoader({ globals: { Game: game, Memory: memory, RESOURCE_ENERGY: 'energy', RESOURCE_GHODIUM: 'G', OK: 0 }, modules: {
        'settings/room': { defaultAutoResource: { H: 1000 } },
        'settings/roomPolicy': { roomPolicy: { terminal: { energyReserve: 100, maximumSendAmount: 1000, energyExportThreshold: 10000, energyImportThreshold: 5000,
            energyTransferAmount: 1000, distributionMinimumLevel: 6, mineralReserve: 100, refillRatio: 0.8, surplusRatio: 2 } } },
        'runtime/roomSchedule': { roomWorkDue: () => true },
    } });
    return { room, source, memory, game, sends, queues, loader, process: loader.load('room/terminal').processTerminalResource };
}

test('terminal balancing and old queued jobs never replenish a closing destination, even during cooldown', () => {
    const w = terminalWorld(); w.process(w.room);
    assert.deepEqual(w.sends, [{ resource: 'H', amount: 100, target: 'W3N1' }]);
    assert.deepEqual(w.queues, []); assert.equal(w.room.memory.terminalAmount.H, undefined);
    assert.equal(w.room.memory.terminalSendJob.old.amount, 100, 'cancel may resume the explicit pending delivery');
    w.room.terminal.cooldown = 1; w.process(w.room); assert.equal(w.room.memory.terminalAmount.H, undefined);
    w.process(w.source); assert.equal(w.sends.length, 1, 'normal source pipeline is bypassed');
    delete w.source.memory.evacuation; w.room.terminal.cooldown = 0; w.game.time++; w.process(w.room);
    assert.equal(w.sends[1].target, 'W1N1');
});

test('sendResource refuses closing source or invisible closing destination without replacing pending jobs', () => {
    class Room {}
    const memory = { rooms: { W1N1: { evacuation: {} } } };
    const loader = createSourceLoader({ globals: { Room, Memory: memory, Game: { time: 1, rooms: {} } }, modules: {
        'settings/structures': {}, 'settings/settings': {}, 'utils/CostMatrix': {}, utils: {}, 'runtime/creepIndex': {},
    } });
    const room = new (loader.load('mount/extension/RoomExtension').default)(); room.name = 'W2N1'; room.memory = { terminalSendJob: {} };
    assert.equal(room.sendResource('W1N1', 'H', 100), false); assert.deepEqual(room.memory.terminalSendJob, {});
    assert.equal(room.sendResource('W3N1', 'H', 100), true); assert.equal(Object.values(room.memory.terminalSendJob).length, 1);
    room.memory.evacuation = {}; assert.equal(room.sendResource('W3N1', 'H', 200), false);
    assert.equal(Object.values(room.memory.terminalSendJob)[0].amount, 100);
});

test('ordinary terminal shipments share evacuation capacity reservations without suspending other-room supplies', () => {
    const w = terminalWorld(), receivingRoom = { name: 'W3N1', controller: { my: true }, terminal: { my: true, store: { getFreeCapacity: () => 80 } } };
    w.game.rooms.W3N1 = receivingRoom;
    const shared = w.loader.load('room/evacuation');
    shared.reserveEvacuationIncoming(receivingRoom, 30);
    w.process(w.room);
    assert.deepEqual(w.sends, [{ resource: 'H', amount: 50, target: 'W3N1' }]);
    assert.equal(w.room.memory.terminalSendJob.normal.amount, 50);
    assert.equal(shared.getEvacuationIncomingCapacity(receivingRoom), 0);
    const second = { name: 'W4N1', my: true, level: 1, memory: { terminalSendJob: { pending: { targetRoom: 'W3N1', resourceType: 'H', amount: 100 } } },
        storage: { store: { energy: 10000, H: 20000 } },
        terminal: { cooldown: 0, store: { energy: 60000, H: 100, getCapacity: () => 300000, getFreeCapacity: () => 1000 }, send(resource, amount, target) { w.sends.push({ resource, amount, target }); return 0; } } };
    w.process(second); assert.equal(w.sends.length, 1); assert.equal(second.memory.terminalSendJob.pending.amount, 100);
    w.game.time++; w.process(second);
    assert.deepEqual(w.sends[1], { resource: 'H', amount: 80, target: 'W3N1' });
    assert.equal(second.memory.terminalSendJob.pending.amount, 20);
});

test('without an evacuation ordinary owned-room sends retain throughput and keep unsent cargo in the queue when capacity is short', () => {
    for (const capacity of [1000, 0, 35]) {
        const w = terminalWorld(); delete w.source.memory.evacuation; delete w.room.memory.terminalSendJob.old;
        w.memory.centerStorage = 'W9N9'; w.room.storage.store.energy = 0;
        w.game.rooms.W3N1 = { name: 'W3N1', controller: { my: true }, terminal: { my: true, store: { getFreeCapacity: () => capacity } } };
        w.process(w.room);
        const submitted = Math.min(capacity, 100);
        assert.deepEqual(w.sends, submitted > 0 ? [{ resource: 'H', amount: submitted, target: 'W3N1' }] : []);
        if (submitted === 100) assert.equal(w.room.memory.terminalSendJob.normal, undefined);
        else assert.equal(w.room.memory.terminalSendJob.normal.amount, 100 - submitted);
        assert.deepEqual(w.queues, []);
    }
});

function powerWorld({ adjacent = true, cargo = true, full = false } = {}) {
    const source = closingRoom(), calls = [], store = { energy: cargo ? 10 : 0, ops: cargo ? 50 : 0 };
    source.terminal = { store: { getFreeCapacity: () => full ? 0 : 1000 } };
    const pc = { name: 'operator', room: source, store, pos: { isNearTo: () => adjacent },
        transfer: (target, resource) => { calls.push(`transfer:${resource}`); return 0; }, moveTo: () => calls.push('move'),
        usePower: () => calls.push('power'), isPowerAvailable: () => true };
    const game = { time: 1, shard: { name: 'shard3' }, powerCreeps: { operator: pc }, rooms: { W1N1: source }, flags: {} };
    const loader = createSourceLoader({ globals: { Game: game, Memory: { rooms: { W1N1: source.memory } }, PWR_GENERATE_OPS: 1, OK: 0 },
        modules: { utils: { getDistance: () => 0 } } });
    return { source, pc, game, calls, loader, run: loader.load('role/pc/PowerCreep').powerSpawnController };
}

test('PowerCreep unloads every cargo kind before flag checks or OPS generation', () => {
    const w = powerWorld(); w.run(); assert.deepEqual(w.calls, ['transfer:energy']);
    w.pc.store.energy = 0; w.run(); assert.deepEqual(w.calls, ['transfer:energy', 'transfer:ops']);
    w.pc.store.ops = 0; w.run(); assert.equal(w.calls.length, 2);
    const distant = powerWorld({ adjacent: false }); distant.run(); assert.deepEqual(distant.calls, ['move']);
    const full = powerWorld({ full: true }); full.run(); assert.deepEqual(full.calls, []);
});

test('PowerCreep never spawns into a closing flag room and ordinary behavior resumes after cancellation', () => {
    const w = powerWorld({ cargo: false }); w.pc.room = undefined; w.pc.spawn = () => w.calls.push('spawn');
    w.source.powerSpawn = {}; w.game.flags.PC_operator = { pos: { roomName: 'W1N1' } };
    w.run(); assert.deepEqual(w.calls, []);
    delete w.source.memory.evacuation; w.run(); assert.deepEqual(w.calls, ['spawn', 'power']);
});

test('PowerCreep deposits respect capacity already reserved by evacuation carriers', () => {
    const w = powerWorld(), amounts = [];
    w.pc.transfer = (target, resource, amount) => { amounts.push(amount); return 0; };
    const shared = w.loader.load('room/evacuation');
    shared.reserveEvacuationIncoming(w.source, 995); w.run();
    assert.deepEqual(amounts, [5]); assert.equal(shared.getEvacuationIncomingCapacity(w.source), 0);
    w.run(); assert.deepEqual(amounts, [5]);
});

test('spawn rejects stale economy or shard births immediately between population refreshes but permits evacuation helpers', () => {
    const calls = [], room = closingRoom(); room.energyAvailable = 100;
    room.memory.creepSpawnQueue = ['mining', 'shard', 'cargo']; room.memory.creepConfig = {
        mining: { role: 'harvester', data: {} }, shard: { role: 'sScout', data: {} }, cargo: { role: 'filler', data: { evacuationRoom: room.name } },
    };
    const loader = createSourceLoader({ globals: { StructureSpawn: class {}, Game: { creeps: {} }, OK: 0, BODYPART_COST: { move: 50 } }, modules: {
        'settings/creep': { roleAdvEnum: { MANAGER: 'manager' }, roleBaseEnum: { FILLER: 'filler', HARVESTER: 'harvester' } },
        role: { isRoleSupported: () => true }, 'creep/bodySelection': { selectCreepBody: () => ({ body: ['move'], boostPlan: { steps: [] } }) },
        'creep/boosting': { reserveBoostPlan() {} }, 'creep/development': { isDevelopingRoom: () => false },
        'shard/targetDismantleControl': { isTargetDismantleSpawnReserved: () => false },
        'creep/developmentRemotes': {}, 'combat/spawning': { combatSpawnAllowed: () => true, recordCombatSpawn() {} },
    } });
    const spawn = new (loader.load('mount/structure/SpawnExtension').default)(); spawn.room = room;
    spawn.spawnCreep = (body, name) => { calls.push(name); return 0; }; spawn.doWork();
    assert.deepEqual(calls, ['cargo']); assert.deepEqual(room.memory.creepSpawnQueue, []);
});
