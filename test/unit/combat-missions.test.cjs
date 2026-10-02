const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world() {
    const actions = [], memory = { warMode: {}, combatTasks: {} };
    const store = value => ({ energy: value, getUsedCapacity: () => value });
    const home = { name: 'W1N1', my: true, controller: { my: true, level: 8, owner: { username: 'me' } },
        spawns: [{ id: 'spawn', pos: { x: 20, y: 20, roomName: 'W1N1' } }], storage: { store: store(300000) },
        memory: { creepConfig: {}, creepSpawnQueue: [], teamConfig: {} }, energyCapacityAvailable: 12900 };
    const target = { name: 'W2N1', controller: { owner: { username: 'enemy' }, level: 8, ticksToDowngrade: 200000, upgradeBlocked: 0 },
        structures: [{ id: 'enemy-spawn', structureType: 'spawn', owner: { username: 'enemy' }, effects: [] }],
        enemies: [], ruins: [], tombstones: [], droppedResource: [], find: () => [] };
    const game = { time: 100, shard: { name: 'shard3' }, rooms: { W1N1: home, W2N1: target }, creeps: {}, structures: {},
        map: { findRoute: () => [{}], getRoomLinearDistance: () => 1 } };
    const member = { role: 'integrate', profile: { boostTier: 0, boostFallback: 'wait' }, body: ['move', 'ranged_attack', 'heal'],
        boostPlan: { tier: 0, steps: [] }, energy: 450 };
    let plan = { formation: 'duo', members: [member, member], energy: 900 };
    const loader = createSourceLoader({ globals: { Game: game, Memory: memory, console: { log: value => actions.push(['log', value]) },
        STRUCTURE_OBSERVER: 'observer', STRUCTURE_INVADER_CORE: 'core', STRUCTURE_TOWER: 'tower', STRUCTURE_SPAWN: 'spawn',
        STRUCTURE_RAMPART: 'rampart', STRUCTURE_CONTAINER: 'container', STRUCTURE_STORAGE: 'storage', STRUCTURE_TERMINAL: 'terminal',
        EFFECT_INVULNERABILITY: 1001, RESOURCE_ENERGY: 'energy', TOWER_POWER_ATTACK: 600,
        OBSERVER_RANGE: 10, OK: 0, FIND_MY_SPAWNS: 'spawns', CREEP_LIFE_TIME: 1500, CREEP_CLAIM_LIFE_TIME: 600,
        BODYPART_COST: { move: 50, ranged_attack: 150, heal: 250, claim: 600 } }, modules: {
        'creep/demand': { addCreepConfig(room, role, name, data, team) {
            room.memory.creepConfig[name] = { name, role, data, isTeam: team, spawnRoom: room.name }; return name;
        } },
        './intelligence': { combatSnapshot: room => ({ enemies: room.enemies, structures: room.structures, towers: [], friendlies: [] }),
            combatPower: enemy => ({ attack: enemy.attack || 0, ranged: 0, heal: 0, dismantle: 0 }),
            towerDamage: () => 600, isCombatHostile: object => object.owner?.username === 'enemy' || object.structureType === 'rampart' },
        './tactics': { executeCombatSquad: members => actions.push(['fight', members.map(member => member.name)]) },
        './planning': { planCombatForce: () => plan },
        './support': { runCombatScout: creep => actions.push(['scout', creep.name]),
            runControllerAttack: creep => { actions.push(['controller', creep.name]); return creep.controllerOK !== false; },
            runCombatLoot: creep => actions.push(['loot', creep.name]), returnCombatUnit: creep => actions.push(['return', creep.name]),
            countCombatLoot: room => room.lootAmount || 0 },
        'runtime/observerScheduling': { scheduleObservation: observer => observer.result ?? 0 },
        'runtime/profiling': { isCpuProfilingEnabled: () => false },
    } });
    const api = loader.load('combat/missions');
    function create(options = {}) { const result = JSON.parse(api.createCombatTask(home.name, target.name, options)); return memory.combatTasks[result.id]; }
    function publish() { home.memory.creepConfig = {}; api.releaseCombatCreepConfigs(); }
    function spawn(name, ready = true) {
        const config = home.memory.creepConfig[name];
        const creep = { name, memory: { ...config, boostPlan: { tier: 0, steps: [], completed: true } }, room: home,
            pos: { inRangeTo: () => true }, store: store(0), spawning: false, goBoost: () => ready, moveTo: () => actions.push(['rally', name]) };
        game.creeps[name] = creep; return creep;
    }
    function tick(amount = 5) { game.time += amount; api.runCombatTasks(); }
    return { ...api, home, target, game, memory, actions, create, publish, spawn, tick, loader, setPlan: value => plan = value };
}

test('console creates two explicit modes and rejects invalid/friendly attack commands without creating demand', () => {
    const w = world(), task = w.create();
    assert.equal(task.phase, 'recon'); assert.deepEqual(Object.keys(w.home.memory.creepConfig), []);
    assert.match(w.createCombatTask('W1N1', 'W2N1', { mode: 'garbage' }), /mode/);
    w.target.controller.my = true;
    assert.match(w.createCombatTask('W1N1', 'W2N1', { id: 'bad' }), /自己/);
    assert.equal(w.create({ id: 'guard', mode: 'hold' }).mode, 'hold');
});

test('observer submits next-tick reconnaissance before any fighter is published', () => {
    const w = world(); delete w.game.rooms.W2N1;
    w.game.structures.observer = { id: 'observer', structureType: 'observer', my: true, pos: { roomName: 'W1N1' } };
    const task = w.create(); w.runCombatTasks(); w.publish();
    assert.equal(task.phase, 'recon'); assert.equal(task.observedAt, 100);
    assert.deepEqual(Object.keys(w.home.memory.creepConfig), []);
});

test('out-of-range scout demand survives population reset until spawning, then remains assigned while alive', () => {
    const w = world(); delete w.game.rooms.W2N1;
    const task = w.create(); w.runCombatTasks(); w.publish();
    const [name] = Object.keys(w.home.memory.creepConfig); assert.equal(w.home.memory.creepConfig[name].combatJob, 'scout');
    w.game.time += 5; w.publish(); assert.ok(w.home.memory.creepConfig[name]);
    w.spawn(name); w.tick(); w.publish(); w.runCombatUnits();
    assert.ok(w.actions.some(action => action[0] === 'scout')); assert.equal(task.scoutPending, false);
});

test('dead scouts wait the configured retry interval instead of being published every refresh', () => {
    const w = world(); delete w.game.rooms.W2N1;
    const task = w.create(); w.runCombatTasks(); w.publish(); const [name] = Object.keys(w.home.memory.creepConfig);
    w.spawn(name); w.tick(); delete w.game.creeps[name]; w.tick(); w.publish();
    assert.deepEqual(Object.keys(w.home.memory.creepConfig), []);
    w.tick(50); w.publish(); assert.ok(w.home.memory.creepConfig[name]); assert.equal(task.scoutPending, true);
});

test('force selection publishes exact-tier team configurations and waits for every boost plan', () => {
    const w = world(), task = w.create(); w.runCombatTasks(); w.publish();
    assert.equal(task.phase, 'spawning'); assert.equal(task.spent, 0, 'planned costs are not actual spawn expenses');
    const names = task.memberNames; w.spawn(names[0]); w.spawn(names[1], false); w.tick(); w.publish(); w.runCombatUnits();
    assert.ok(!w.actions.some(action => action[0] === 'fight' || action[0] === 'return'));
    w.game.creeps[names[1]].goBoost = () => true; w.runCombatUnits();
    assert.equal(w.actions.filter(action => action[0] === 'fight').length, 1);
});

test('a lost member invalidates the whole wave without silently refilling the same team forever', () => {
    const w = world(), task = w.create(); w.runCombatTasks(); w.publish(); const names = task.memberNames;
    w.spawn(names[0]); w.spawn(names[1]); w.tick(); delete w.game.creeps[names[1]]; w.tick();
    assert.equal(task.phase, 'planning'); assert.deepEqual(Object.keys(w.home.memory.creepConfig), []);
    w.runCombatUnits(); assert.ok(w.actions.some(action => action[0] === 'return' && action[1] === names[0]));
    w.tick(30); w.publish(); assert.equal(task.wave, 2); assert.notEqual(task.memberNames[0], names[0]);
});

test('failed boost plans actively return units and invalidate the wave rather than freezing them', () => {
    const w = world(), task = w.create(); w.runCombatTasks(); w.publish(); const names = task.memberNames;
    const first = w.spawn(names[0]); w.spawn(names[1]); first.memory.boostPlan.failed = true;
    w.runCombatUnits(); assert.equal(task.phase, 'planning'); assert.ok(w.actions.some(action => action[0] === 'return'));
});

test('safe mode removes queued fighters before they can spawn and never spends an extra wave', () => {
    const w = world(), task = w.create(); w.runCombatTasks(); w.publish();
    w.target.controller.safeMode = 100; w.tick(); w.publish();
    assert.deepEqual(Object.keys(w.home.memory.creepConfig), []); assert.equal(task.wave, 1); assert.match(task.reason, /安全模式/);
});

test('hold tasks persist after an empty-room snapshot until their duration or cancellation', () => {
    const w = world(); w.target.structures = [];
    const task = w.create({ mode: 'hold', holdTicks: 100 }); w.runCombatTasks(); w.tick(20);
    assert.ok(!['controller', 'loot', 'returning', 'completed'].includes(task.phase));
    w.publish(); for (const name of task.memberNames) w.spawn(name).room = w.target;
    w.tick(); assert.equal(task.holdStartedAt, 125);
    w.tick(100); assert.equal(task.phase, 'returning'); assert.match(task.reason, /驻守时间/);
});

test('player cleanup dispatches CLAIM and confirms a later native result before releasing its task', () => {
    const w = world(); w.target.structures = [];
    const task = w.create(); w.runCombatTasks(); w.tick(10); assert.equal(task.phase, 'controller'); w.publish();
    const [name] = Object.keys(w.home.memory.creepConfig), unit = w.spawn(name); unit.room = w.target;
    w.runCombatUnits(); assert.equal(task.phase, 'controller'); assert.equal(task.controllerSentAt, 110);
    w.target.controller.upgradeBlocked = 1000; w.tick(1);
    assert.equal(task.phase, 'returning'); assert.equal(task.controllerConfirmed, true); assert.deepEqual(Object.keys(w.home.memory.creepConfig), []);
});

test('a rejected CLAIM intent cannot be misreported as our controller suppression', () => {
    const w = world(); w.target.structures = [];
    const task = w.create(); w.runCombatTasks(); w.tick(10); w.publish();
    const [name] = Object.keys(w.home.memory.creepConfig), unit = w.spawn(name); unit.room = w.target; unit.controllerOK = false;
    w.runCombatUnits(); assert.equal(task.controllerSentAt, undefined);
    w.target.controller.upgradeBlocked = 1000; w.tick(); assert.equal(task.controllerConfirmed, undefined); assert.equal(task.phase, 'controller');
});

test('cancellation immediately withdraws queues and keeps living cargo units on the return path', () => {
    const w = world(), task = w.create(); w.runCombatTasks(); w.publish(); const name = task.memberNames[0]; w.spawn(name);
    w.home.memory.creepSpawnQueue = [...task.memberNames]; w.cancelCombatTask(task.id);
    assert.equal(task.phase, 'cancelled'); assert.deepEqual(w.home.memory.creepSpawnQueue, []);
    w.runCombatUnits(); assert.ok(w.actions.some(action => action[0] === 'return' && action[1] === name));
});

test('post-raid NPC treasure ramparts stay combat objectives until the cargo is accessible', () => {
    const w = world(); delete w.target.controller.owner;
    w.target.structures = [{ structureType: 'rampart', hits: 50000, my: false, isPublic: false, effects: [] }];
    assert.equal(w.readCombatIntel(w.target).objectives, 1);
});

test('the native spawn boundary rejects stale generations and records only accepted spawn costs', () => {
    const w = world(), task = w.create(); w.runCombatTasks(); w.publish();
    const config = w.home.memory.creepConfig[task.memberNames[0]], api = w.loader.load('combat/spawning');
    const plan = { body: ['move', 'ranged_attack', 'heal'] };
    assert.equal(api.combatSpawnAllowed(config, plan), true); api.recordCombatSpawn(config, plan); assert.equal(task.spent, 450);
    task.generation++; assert.equal(api.combatSpawnAllowed(config), false);
    task.generation--; task.options.maxEnergy = 500; assert.equal(api.combatSpawnAllowed(config, plan), false); assert.equal(task.phase, 'returning');
});

test('reinforcements invalidate a weaker plan and withdraw its queued demand before another wave is computed', () => {
    const w = world(), task = w.create(); w.runCombatTasks(); w.publish();
    w.target.enemies.push({ attack: 1000, owner: { username: 'enemy' } }); w.tick();
    assert.equal(task.phase, 'planning'); assert.match(task.reason, /敌情升级/);
    assert.deepEqual(Object.keys(w.home.memory.creepConfig), []);
});

test('home defense preempts an expedition without publishing more offensive demand', () => {
    const w = world(), task = w.create(); w.runCombatTasks(); w.publish();
    w.memory.warMode.W1N1 = true; w.tick(); w.publish();
    assert.equal(task.phase, 'planning'); assert.match(task.reason, /起点房间防御/);
    assert.deepEqual(Object.keys(w.home.memory.creepConfig), []);
});

test('NPC cleanup transitions into hauling and waits for all cargo to arrive before completing', () => {
    const w = world(); delete w.target.controller.owner;
    w.target.structures = [{ id: 'core', structureType: 'core', owner: { username: 'enemy' }, effects: [] }];
    const task = w.create(); w.runCombatTasks(); w.publish();
    assert.equal(task.category, 'npc');
    w.target.structures = []; w.target.lootAmount = 2600; w.tick(); w.tick(10); w.publish();
    assert.equal(task.phase, 'loot');
    const names = Object.keys(w.home.memory.creepConfig); assert.ok(names.length >= 1 && names.length <= 4);
    const hauler = w.spawn(names[0]); assert.equal(hauler.memory.combatJob, 'loot');
    w.runCombatUnits(); assert.ok(w.actions.some(action => action[0] === 'loot'));
    w.target.lootAmount = 0; hauler.store = { getUsedCapacity: () => 50 }; w.tick(10);
    assert.equal(task.phase, 'loot', 'no empty-room false completion while minerals remain in transit');
    hauler.store = { getUsedCapacity: () => 0 }; w.tick(); w.tick(10);
    assert.equal(task.phase, 'returning'); assert.match(task.reason, /搬运完毕/);
});

test('unreachable NPC cargo exits with an incomplete reason after bounded lack of progress', () => {
    const w = world(); delete w.target.controller.owner; w.target.structures = []; w.target.lootAmount = 1000;
    const task = w.create(); task.category = 'npc'; w.runCombatTasks(); w.tick(10); w.tick(1);
    assert.equal(task.phase, 'loot'); w.tick(500);
    assert.equal(task.phase, 'returning'); assert.match(task.reason, /无进展/);
});


test('low bucket or exhausted tick budget defers planning without delaying cancellation or the next healthy tick', () => {
    const w = world(), task = w.create();
    w.game.cpu = { bucket: 1000, tickLimit: 500, getUsed: () => 10 };
    w.runCombatTasks(); assert.equal(task.phase, 'planning'); assert.equal(task.wave, 0);
    assert.match(task.reason, /CPU/); assert.equal(task.lastPlanAt, undefined); w.publish();
    assert.deepEqual(Object.keys(w.home.memory.creepConfig), []);
    w.game.cpu.bucket = 10000; w.game.cpu.tickLimit = 30;
    w.tick(1); assert.equal(task.wave, 0); assert.equal(task.lastPlanAt, undefined);
    w.game.cpu.tickLimit = 500; w.tick(1); assert.equal(task.phase, 'spawning'); assert.equal(task.wave, 1);
    w.cancelCombatTask(task.id); assert.equal(task.phase, 'cancelled');
});

test('home defense stops pending reconnaissance and support demands at the spawn boundary too', () => {
    const w = world(); delete w.game.rooms.W2N1; const task = w.create();
    w.runCombatTasks(); w.publish(); const [name] = Object.keys(w.home.memory.creepConfig);
    const config = w.home.memory.creepConfig[name];
    w.memory.warMode.W1N1 = true;
    assert.equal(w.loader.load('combat/spawning').combatSpawnAllowed(config), false);
    w.tick(); w.publish(); assert.deepEqual(Object.keys(w.home.memory.creepConfig), []);
    assert.equal(task.scoutPending, true, 'the stable request can resume without multiplying scouts');
});
