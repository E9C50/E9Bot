const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const nativeBodies = require('../helpers/native-bodies.cjs');

function world() {
    const actions = [], memory = { warMode: {}, combatTasks: {} };
    const store = value => ({ energy: value, getUsedCapacity: () => value });
    const home = { name: 'W1N1', my: true, controller: { my: true, level: 8, owner: { username: 'me' } },
        spawns: [{ id: 'spawn', pos: { x: 20, y: 20, roomName: 'W1N1' } }], storage: { store: store(300000) },
        memory: { creepConfig: {}, creepSpawnQueue: [], teamConfig: {} }, energyCapacityAvailable: 12900 };
    const target = { name: 'W2N1', controller: { owner: { username: 'enemy' }, level: 8, ticksToDowngrade: 200000, upgradeBlocked: 0 },
        structures: [{ id: 'enemy-spawn', structureType: 'spawn', hits: 5000, owner: { username: 'enemy' }, effects: [] }],
        enemies: [], ruins: [], tombstones: [], droppedResource: [], find: () => [] };
    const game = { time: 100, shard: { name: 'shard3' }, rooms: { W1N1: home, W2N1: target }, creeps: {}, structures: {},
        map: { findRoute: () => [{}], getRoomLinearDistance: () => 1 } };
    const member = { role: 'integrate', profile: { boostTier: 0, boostFallback: 'wait' }, body: ['move', 'ranged_attack', 'heal'],
        boostPlan: { tier: 0, steps: [] }, energy: 450 };
    let plan = { formation: 'duo', members: [member, member], energy: 900 };
    const loader = createSourceLoader({ globals: { Game: game, Memory: memory, console: { log: value => actions.push(['log', value]) },
        STRUCTURE_OBSERVER: 'observer', STRUCTURE_INVADER_CORE: 'core', STRUCTURE_TOWER: 'tower', STRUCTURE_SPAWN: 'spawn',
        STRUCTURE_RAMPART: 'rampart', STRUCTURE_WALL: 'constructedWall', STRUCTURE_CONTROLLER: 'controller',
        STRUCTURE_CONTAINER: 'container', STRUCTURE_STORAGE: 'storage', STRUCTURE_TERMINAL: 'terminal',
        EFFECT_INVULNERABILITY: 1001, RESOURCE_ENERGY: 'energy', TOWER_POWER_ATTACK: 600,
        OBSERVER_RANGE: 10, OK: 0, FIND_MY_SPAWNS: 'spawns', CREEP_LIFE_TIME: 1500, CREEP_CLAIM_LIFE_TIME: 600,
        BODYPART_COST: { move: 50, ranged_attack: 150, heal: 250, claim: 600 } }, modules: {
        'creep/demand': { addCreepConfig(room, role, name, data, team) {
            room.memory.creepConfig[name] = { name, role, data, isTeam: team, spawnRoom: room.name }; return name;
        } },
        'role': { isRoleSupported: role => ['integrate', 'repairer', 'scout', 'cAttacker', 'filler'].includes(role) },
        './intelligence': { combatSnapshot: room => ({ enemies: room.enemies, structures: room.structures, towers: [], friendlies: [] }),
            combatPower: enemy => ({ attack: enemy.attack || 0, ranged: 0, heal: 0, dismantle: 0 }),
            towerDamage: () => 600, isCombatHostile: object => !object.my && object.owner?.username !== 'friend' &&
                (object.owner !== undefined || ['rampart', 'constructedWall'].includes(object.structureType)) },
        'settings/settings': { creepWhiteList: ['friend'] },
        './tactics': { executeCombatSquad: members => actions.push(['fight', members.map(member => member.name)]) },
        './rally': { parkReadyCombatMembers: (task, members) => members.forEach(member => actions.push(['rally', member.name])) },
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

function taskQueue(w) {
    const loader = createSourceLoader({ globals: { ...nativeBodies.globals, Game: w.game, Memory: w.memory, RESOURCE_ENERGY: 'energy' },
        modules: { role: { isRoleSupported: () => true },
            './bodySelection': { selectCreepBody() { throw Error('mature combat priority tests never plan a development recovery body'); } } } });
    w.home.containers = [];
    w.home.storage.id = 'stock';
    w.game.creeps.residentFiller = { room: w.home, getActiveBodyparts: () => 1,
        memory: { role: 'filler', spawnRoom: w.home.name, data: { sourceId: 'stock' } } };
    w.game.creeps.residentHarvester = { room: w.home, memory: { role: 'harvester' } };
    const priorities = loader.load('settings/creep').spawnPriority;
    return { priorities, build: () => Array.from(loader.load('creep/spawnQueue').buildSpawnQueue(w.home)) };
}

test('all mission fighters and the pending fourth spawn before repairs while essential logistics stay ahead', () => {
    const w = world(), template = { role: 'integrate', profile: { boostTier: 0 }, body: ['move'],
        boostPlan: { tier: 0, steps: [] }, energy: 50 };
    w.setPlan({ formation: 'quad', members: Array(4).fill(template), energy: 200 });
    const task = w.create(); w.runCombatTasks(); w.publish();
    const queue = taskQueue(w);
    for (const role of ['manager', 'harvester', 'filler', 'processer', 'builder', 'upgrader', 'repairer', 'miner'])
        w.home.memory.creepConfig[role] = { role, spawnPriority: queue.priorities[role], data: { sourceId: 'stock' } };
    let names = queue.build();
    assert.deepEqual(names.slice(0, 4), ['manager', 'harvester', 'filler', 'processer']);
    for (const name of task.memberNames) {
        assert.ok(names.indexOf(name) < names.indexOf('builder'));
        assert.ok(names.indexOf(name) < names.indexOf('repairer'));
    }
    for (const name of task.memberNames.slice(0, 3)) w.spawn(name);
    names = queue.build();
    assert.ok(names.indexOf(task.memberNames[3]) < names.indexOf('repairer'));
    assert.equal(task.spent, 0); assert.equal(task.wave, 1); assert.equal(task.plan.energy, 200);
    assert.equal(queue.priorities.integrate, 3, 'the ordinary role policy remains intact');
    assert.equal(queue.priorities.attacker, 14);
});

test('mission scout, controller attack and loot demand use elevated task priorities', () => {
    for (const [phase, job, expected] of [['recon', 'scout', 3.5], ['controller', 'controller', 3.5], ['loot', 'loot', 5.5]]) {
        const w = world(); if (phase === 'recon') delete w.game.rooms.W2N1;
        const task = w.create(); w.runCombatTasks();
        task.phase = phase; delete task.reason;
        if (phase === 'loot') task.intel.loot = 1000;
        w.publish();
        const configs = Object.values(w.home.memory.creepConfig);
        assert.ok(configs.length > 0);
        for (const config of configs) { assert.equal(config.combatJob, job); assert.equal(config.spawnPriority, expected); }
        const queue = taskQueue(w);
        w.home.memory.creepConfig.repairer = { role: 'repairer', spawnPriority: queue.priorities.repairer, data: {} };
        assert.ok(queue.build().indexOf(configs[0].name) < queue.build().indexOf('repairer'));
    }
});

test('ready fighters park while a missing teammate or another native boost intent is still pending', () => {
    const w = world(), task = w.create(); w.runCombatTasks(); w.publish();
    const [first, second] = task.memberNames;
    w.spawn(first); w.runCombatUnits();
    assert.deepEqual(w.actions.filter(action => action[0] === 'rally'), [['rally', first]]);
    const boosting = w.spawn(second, false);
    boosting.goBoost = () => { w.actions.push(['boost-move', second]); return false; };
    w.actions.length = 0;
    w.runCombatUnits();
    assert.deepEqual(w.actions.filter(action => action[0] === 'rally'), [['rally', first]]);
    assert.deepEqual(w.actions.filter(action => action[0] === 'boost-move'), [['boost-move', second]]);
    assert.equal(w.actions.some(action => action[0] === 'fight' || action[0] === 'return'), false);
});

test('a spawning prepared squad with a fatigued member parks healthy fighters before departure', () => {
    const w = world(), task = w.create(); w.runCombatTasks(); w.publish();
    const [first, second] = task.memberNames;
    w.spawn(first).fatigue = 1; w.spawn(second); w.runCombatUnits();
    assert.equal(task.phase, 'spawning');
    assert.equal(w.actions.some(action => action[0] === 'fight'), false);
    assert.deepEqual(w.actions.filter(action => action[0] === 'rally'), [['rally', first], ['rally', second]]);
    w.game.creeps[first].fatigue = 0;
    w.tick(); w.publish();
    w.runCombatUnits();
    assert.equal(w.actions.filter(action => action[0] === 'fight').length, 1);
});

test('a deployed complete combat squad keeps tactical fatigue handling without receiving home parking intents', () => {
    const w = world(), task = w.create(); w.runCombatTasks(); w.publish();
    for (const name of task.memberNames) { const member = w.spawn(name); member.room = w.target; member.fatigue = 1; }
    w.tick(); w.publish(); w.runCombatUnits();
    assert.equal(task.phase, 'combat');
    assert.equal(w.actions.filter(action => action[0] === 'fight').length, 1);
    assert.equal(w.actions.some(action => action[0] === 'rally' || action[0] === 'return'), false);
});

test('three fully boosted legacy fighters with ready false still park while the fourth is spawning', () => {
    const w = world(), template = { role: 'integrate', profile: { boostTier: 3 }, body: ['move'], boostPlan: { tier: 3, steps: [] }, energy: 50 };
    w.setPlan({ formation: 'quad', members: Array(4).fill(template), energy: 200 });
    const task = w.create(); w.runCombatTasks(); w.publish();
    for (const name of task.memberNames.slice(0, 3)) {
        const member = w.spawn(name); member.memory.ready = false;
        member.memory.boostPlan = { tier: 3, completed: true, steps: [{ resource: 'XLHO2', type: 'boostHeal', parts: 18 }] };
    }
    w.runCombatUnits();
    assert.deepEqual(w.actions.filter(action => action[0] === 'rally').map(action => action[1]), Array.from(task.memberNames.slice(0, 3)));
    assert.equal(w.actions.some(action => action[0] === 'fight' || action[0] === 'return'), false);
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
    const task = w.create({ controllerAttack: true }); w.runCombatTasks(); w.tick(10); assert.equal(task.phase, 'controller'); w.publish();
    const [name] = Object.keys(w.home.memory.creepConfig), unit = w.spawn(name); unit.room = w.target;
    w.runCombatUnits(); assert.equal(task.phase, 'controller'); assert.equal(task.controllerSentAt, 110);
    w.target.controller.upgradeBlocked = 1000; w.tick(1);
    assert.equal(task.phase, 'returning'); assert.equal(task.controllerConfirmed, true); assert.deepEqual(Object.keys(w.home.memory.creepConfig), []);
});

test('a rejected CLAIM intent cannot be misreported as our controller suppression', () => {
    const w = world(); w.target.structures = [];
    const task = w.create({ controllerAttack: true }); w.runCombatTasks(); w.tick(10); w.publish();
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

test('remaining walls and ramparts do not keep a cleared NPC room alive', () => {
    const w = world(); delete w.target.controller.owner;
    w.target.structures = [
        { structureType: 'rampart', hits: 50000, my: false, isPublic: false, effects: [{ effect: 1001, ticksRemaining: 200 }] },
        { structureType: 'constructedWall', hits: 50000, effects: [] },
    ];
    const intel = w.readCombatIntel(w.target);
    assert.equal(intel.objectives, 0); assert.equal(intel.protectedUntil, 0);
    const task = w.create(); w.runCombatTasks(); w.tick(10); w.runCombatUnits();
    assert.equal(task.phase, 'completed'); assert.match(task.reason, /目标已清场/);
});

test('room intel counts every destructible non-barrier building, including neutral roads and containers', () => {
    const w = world();
    const ownedTypes = ['spawn', 'tower', 'extension', 'storage', 'terminal', 'lab', 'factory', 'link',
        'extractor', 'observer', 'powerSpawn', 'nuker', 'core'];
    w.target.structures = ownedTypes.map(structureType => ({ structureType, hits: 1000, owner: { username: 'enemy' }, pos: { x: 20, y: 20 } }));
    w.target.structures.push(...['road', 'container'].map(structureType => ({ structureType, hits: 1000 })));
    w.target.structures.push(
        { structureType: 'controller', hits: 1000, owner: { username: 'enemy' } },
        { structureType: 'rampart', hits: 1000, owner: { username: 'enemy' } },
        { structureType: 'constructedWall', hits: 1000 },
        { structureType: 'lab', hits: 1000, my: true, owner: { username: 'me' } },
        { structureType: 'terminal', hits: 1000, owner: { username: 'friend' } },
        { structureType: 'storage', hits: 0, owner: { username: 'enemy' } },
        { structureType: 'portal' },
        { structureType: 'keeperLair', owner: { username: 'Source Keeper' } },
    );
    assert.equal(w.readCombatIntel(w.target).objectives, ownedTypes.length + 2);
    w.target.controller.owner.username = 'friend';
    assert.equal(w.readCombatIntel(w.target).objectives, 0);
    w.target.controller.owner.username = 'me'; w.target.controller.my = true;
    assert.equal(w.readCombatIntel(w.target).objectives, 0);
});

test('economic buildings block completion after military structures die, while leftover barriers do not', () => {
    const w = world(), task = w.create(); w.runCombatTasks(); w.publish();
    const unit = w.spawn(task.memberNames[0]);
    const wall = { structureType: 'constructedWall', hits: 1000000 };
    const rampart = { structureType: 'rampart', hits: 1000000, owner: { username: 'enemy' } };
    w.target.structures = [wall, rampart, ...['storage', 'lab', 'factory', 'road', 'container'].map(structureType =>
        ({ structureType, hits: 1000, ...(structureType === 'road' || structureType === 'container' ? {} : { owner: { username: 'enemy' } }) }))];
    w.tick(10);
    assert.equal(task.intel.objectives, 5); assert.equal(task.clearSince, undefined);
    assert.ok(!['returning', 'completed', 'controller', 'loot'].includes(task.phase));
    w.target.structures = [wall, rampart];
    w.tick(); w.tick(10);
    assert.equal(task.phase, 'returning'); assert.equal(task.intel.objectives, 0);
    assert.deepEqual(Object.keys(w.home.memory.creepConfig), []);
    w.runCombatUnits(); assert.ok(w.actions.some(action => action[0] === 'return' && action[1] === unit.name));
    delete w.game.creeps[unit.name]; w.runCombatUnits();
    assert.equal(task.phase, 'completed'); assert.equal(w.target.controller.owner.username, 'enemy');
});

test('civilian creeps and PowerCreeps prevent completion even with no military buildings', () => {
    const w = world(); w.target.structures = [];
    w.target.enemies = [{ id: 'worker', hits: 100, body: [], owner: { username: 'enemy' } },
        { id: 'power', hits: 1000, owner: { username: 'enemy' } }];
    const task = w.create(); w.runCombatTasks(); w.tick(10);
    assert.equal(task.intel.hostileCount, 2); assert.equal(task.intel.armedCount, 0); assert.equal(task.clearSince, undefined);
    w.target.enemies.shift(); w.tick(); assert.equal(task.intel.hostileCount, 1);
    assert.ok(!['returning', 'completed'].includes(task.phase));
    w.target.enemies = []; w.tick(); w.tick(10); w.runCombatUnits();
    assert.equal(task.phase, 'completed');
});

test('invulnerable hostile creeps remain visible to completion and trigger a bounded protection wait', () => {
    const w = world(); w.target.structures = [];
    const protectedWorker = { hits: 100, body: [], owner: { username: 'enemy' }, effects: [{ effect: 1001, ticksRemaining: 20 }] };
    w.target.enemies = [protectedWorker,
        { hits: 100, body: [], my: true, owner: { username: 'me' }, effects: [{ effect: 1001, ticksRemaining: 200 }] },
        { hits: 100, body: [], owner: { username: 'friend' } }];
    const intel = w.readCombatIntel(w.target);
    assert.equal(intel.hostileCount, 1); assert.equal(intel.protectedUntil, 120);
    const task = w.create(); w.runCombatTasks(); w.publish();
    assert.match(task.reason, /无敌效果/); assert.equal(task.clearSince, undefined);
    assert.deepEqual(Object.keys(w.home.memory.creepConfig), []);
    protectedWorker.effects = []; w.tick(20);
    assert.equal(task.intel.hostileCount, 1); assert.equal(task.phase, 'spawning');
});

test('default player and NPC attacks finish at room clearance without implicit controller or loot phases', () => {
    for (const category of ['player', 'npc']) {
        const w = world(); if (category === 'npc') delete w.target.controller.owner;
        w.target.structures = []; w.target.lootAmount = 5000;
        const task = w.create(); task.category = category;
        w.runCombatTasks(); w.tick(10); w.publish(); w.runCombatUnits();
        assert.equal(task.phase, 'completed'); assert.match(task.reason, /目标已清场/);
        assert.deepEqual(Object.keys(w.home.memory.creepConfig), []);
        assert.equal(w.actions.some(action => action[0] === 'controller' || action[0] === 'loot'), false);
    }
});

test('the final clearance confirmation refreshes same-tick cached intel before accepting completion', () => {
    for (const threat of ['creep', 'building']) {
        const w = world(); w.target.structures = [];
        const task = w.create(); w.runCombatTasks();
        assert.equal(task.clearSince, 100);
        w.game.time = 110;
        task.intel = w.readCombatIntel(w.target);
        assert.equal(task.intel.seenAt, w.game.time);
        if (threat === 'creep') w.target.enemies = [{ hits: 100, body: [], owner: { username: 'enemy' } }];
        else w.target.structures = [{ structureType: 'storage', hits: 1000, owner: { username: 'enemy' } }];
        w.runCombatTasks();
        assert.equal(task.clearSince, undefined); assert.equal(task.phase, 'spawning');
        assert.equal(threat === 'creep' ? task.intel.hostileCount : task.intel.objectives, 1);
    }
});

test('persisted implicit support stages refresh stale intel and return once the full room is clear', () => {
    for (const phase of ['controller', 'loot']) {
        const w = world(); w.target.structures = [];
        const task = w.create(); task.phase = phase; task.category = phase === 'controller' ? 'player' : 'npc';
        task.intel = { ...w.readCombatIntel(w.target), objectives: 1 };
        w.home.memory.creepConfig.legacy = { combatTaskId: task.id };
        w.home.memory.creepSpawnQueue = ['legacy'];
        w.runCombatTasks(); w.runCombatUnits();
        assert.equal(task.phase, 'completed'); assert.equal(task.intel.objectives, 0);
        assert.deepEqual(Object.keys(w.home.memory.creepConfig), []); assert.deepEqual(w.home.memory.creepSpawnQueue, []);
    }
});

test('persisted implicit support stages resume clearing surviving buildings rather than finishing on old intel', () => {
    for (const phase of ['controller', 'loot']) {
        const w = world();
        const task = w.create(); task.phase = phase; task.category = phase === 'controller' ? 'player' : 'npc';
        task.intel = { ...w.readCombatIntel(w.target), objectives: 0 };
        w.target.structures = [{ structureType: 'road', hits: 5000 }];
        w.runCombatTasks(); w.publish();
        assert.equal(task.intel.objectives, 1); assert.equal(task.phase, 'spawning');
        assert.ok(Object.values(w.home.memory.creepConfig).every(config => config.combatJob === 'fighter'));
        assert.equal(task.clearSince, undefined);
    }
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
    w.target.structures = [{ id: 'core', structureType: 'core', hits: 5000, owner: { username: 'enemy' }, effects: [] }];
    const task = w.create({ loot: true }); w.runCombatTasks(); w.publish();
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
    const task = w.create({ loot: true }); task.category = 'npc'; w.runCombatTasks(); w.tick(10); w.tick(1);
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

test('spawning diagnostics distinguish three ready fighters from the fourth behind an economic queue head', () => {
    const w = world(), template = { role: 'integrate', profile: { boostTier: 3 }, body: ['move', 'ranged_attack', 'heal'],
        boostPlan: { tier: 3, steps: [{ type: 'boostHeal', resource: 'XLHO2', parts: 1 }] }, energy: 450 };
    w.setPlan({ formation: 'quad', members: Array(4).fill(template), energy: 1800 });
    w.home.energyAvailable = 200;
    const task = w.create(); w.runCombatTasks(); w.publish();
    for (const name of task.memberNames.slice(0, 3)) {
        const member = w.spawn(name); member.memory.ready = false;
        member.memory.boostPlan = { tier: 3, steps: template.boostPlan.steps, completed: true };
    }
    w.home.memory.creepConfig.repairer = { role: 'repairer', spawnPriority: 6 };
    w.home.memory.creepSpawnQueue = ['repairer', task.memberNames[3]];
    w.tick();
    const summary = JSON.parse(w.listCombatTasks())[0], details = JSON.parse(w.listCombatTasks(task.id));
    assert.equal(task.phase, 'spawning'); assert.equal(task.spent, 0); assert.equal(task.wave, 1);
    assert.equal(summary.spawnStatus.planned, 4); assert.equal(summary.spawnStatus.born, 3);
    assert.equal(summary.spawnStatus.pending, 1); assert.equal(summary.spawnStatus.spawning, 0);
    assert.equal(summary.spawnStatus.boosting, 0); assert.equal(summary.spawnStatus.ready, 3);
    assert.deepEqual(summary.spawnStatus.nextFighter, { name: task.memberNames[3], energy: 450 });
    assert.deepEqual(summary.spawnStatus.queueHead, { name: 'repairer', role: 'repairer' });
    assert.equal(summary.spawnStatus.energyAvailable, 200); assert.equal(summary.spawnStatus.energyCapacity, 12900);
    assert.deepEqual(details.spawnStatus, summary.spawnStatus);
    assert.match(summary.reason, /已出生 3\/4/); assert.match(summary.reason, /200\/12900/);
    assert.match(summary.reason, /下一名需 450/); assert.match(summary.reason, /队首 repairer/);
});

test('native incubation and incomplete boosts have distinct wait states and readiness clears the reason immediately in console', () => {
    const w = world(), task = w.create(); w.runCombatTasks(); w.publish();
    const [first, second] = task.memberNames, incubating = w.spawn(first), ready = w.spawn(second);
    incubating.spawning = true;
    w.tick();
    let summary = JSON.parse(w.listCombatTasks())[0];
    assert.equal(summary.spawnStatus.born, 1); assert.equal(summary.spawnStatus.spawning, 1);
    assert.equal(summary.spawnStatus.pending, 0); assert.equal(summary.spawnStatus.nextFighter, undefined);
    assert.match(task.reason, /孵化中 1/);
    incubating.spawning = false;
    incubating.memory.boostPlan = { tier: 3, steps: [{ type: 'boostHeal', resource: 'XLHO2', parts: 1 }] };
    const duringBoost = JSON.stringify(w.memory), live = JSON.parse(w.listCombatTasks(task.id));
    assert.equal(live.spawnStatus.born, 2); assert.equal(live.spawnStatus.spawning, 0);
    assert.match(live.reason, /孵化中 0/); assert.match(live.reason, /待强化 1/);
    assert.equal(JSON.stringify(w.memory), duringBoost, 'live reasons do not rewrite stored task state');
    w.tick();
    summary = JSON.parse(w.listCombatTasks())[0];
    assert.equal(task.phase, 'combat'); assert.equal(summary.spawnStatus.born, 2);
    assert.equal(summary.spawnStatus.boosting, 1); assert.equal(summary.spawnStatus.ready, 1);
    assert.match(task.reason, /待强化 1/);
    incubating.memory.boostPlan.completed = true;
    const before = JSON.stringify(w.memory);
    assert.equal(JSON.parse(w.listCombatTasks(task.id)).reason, undefined);
    assert.equal(JSON.parse(w.listCombatTasks())[0].spawnStatus.ready, 2);
    assert.equal(JSON.stringify(w.memory), before, 'console diagnostics remain read-only');
    w.tick();
    assert.equal(task.reason, undefined); assert.equal(ready.memory.boostPlan.completed, true);
});

test('current generation spawn diagnostics ignore returning fighters and stale queue entries', () => {
    const w = world(), task = w.create(); w.runCombatTasks(); w.publish();
    const first = w.spawn(task.memberNames[0]); first.memory.combatGeneration--;
    w.home.memory.creepSpawnQueue = ['gone', first.name, task.memberNames[1]];
    const summary = JSON.parse(w.listCombatTasks())[0];
    assert.equal(summary.spawnStatus.born, 0); assert.equal(summary.spawnStatus.pending, 2);
    assert.equal(summary.spawnStatus.ready, 0);
    assert.equal(summary.spawnStatus.queueHead.name, task.memberNames[1]);
});

test('spawn diagnostics skip old combat generations and unsupported roles at the queue head without editing it', () => {
    const w = world(), task = w.create(); w.runCombatTasks(); w.publish();
    const fighter = w.home.memory.creepConfig[task.memberNames[0]];
    w.home.memory.creepConfig.oldFighter = { ...fighter, combatGeneration: task.generation - 1 };
    w.home.memory.creepConfig.oldScout = { ...fighter, role: 'scout', combatJob: 'scout' };
    w.home.memory.creepConfig.unsupported = { role: 'rAttacker' };
    w.home.memory.creepSpawnQueue = ['oldFighter', 'oldScout', 'unsupported', task.memberNames[0]];
    const before = JSON.stringify(w.memory), summary = JSON.parse(w.listCombatTasks())[0];
    assert.equal(summary.spawnStatus.queueHead.name, task.memberNames[0]);
    assert.equal(summary.spawnStatus.queueHead.role, 'integrate');
    assert.equal(JSON.stringify(w.memory), before);
});

test('failed boosts are visibly different from normal boost preparation before the unit stage withdraws them', () => {
    const w = world(), task = w.create(); w.runCombatTasks(); w.publish();
    const failed = w.spawn(task.memberNames[0]); w.spawn(task.memberNames[1]);
    failed.memory.boostPlan = { tier: 3, failed: true, steps: [{ type: 'boostHeal', resource: 'XLHO2', parts: 1 }] };
    w.tick();
    const summary = JSON.parse(w.listCombatTasks())[0];
    assert.equal(summary.spawnStatus.boostFailed, 1); assert.equal(summary.spawnStatus.ready, 1);
    assert.match(summary.reason, /强化失败 1，等待撤回\/回收/);
    assert.equal(task.phase, 'combat', 'diagnostics do not change boost handling or task transitions');
});

test('planning, cancellation and timeout remove obsolete birth diagnostics while preserving their own reasons', () => {
    const w = world(), task = w.create(); w.runCombatTasks(); w.publish();
    assert.match(task.reason, /^编队准备：/);
    task.phase = 'planning';
    w.game.cpu = { bucket: 1000, tickLimit: 500, getUsed: () => 10 };
    w.tick(30);
    assert.match(task.reason, /CPU/); assert.equal(JSON.parse(w.listCombatTasks(task.id)).spawnStatus, undefined);
    w.cancelCombatTask(task.id);
    assert.equal(task.reason, '用户取消'); assert.equal(JSON.parse(w.listCombatTasks())[0].spawnStatus, undefined);
    const timeout = w.create({ id: 'timeout', timeoutTicks: 1 });
    timeout.phase = 'spawning'; timeout.plan = task.plan; timeout.reason = '编队准备：旧等待';
    w.tick(1);
    assert.equal(timeout.phase, 'returning'); assert.equal(timeout.reason, '任务超时');
    assert.equal(JSON.parse(w.listCombatTasks(timeout.id)).spawnStatus, undefined);
});

test('protection and threat-upgrade reasons replace birth waiting without being overwritten by diagnostics', () => {
    const w = world(), task = w.create(); w.runCombatTasks(); w.publish();
    w.target.controller.safeMode = 100;
    w.tick();
    assert.match(task.reason, /安全模式/); assert.match(JSON.parse(w.listCombatTasks(task.id)).reason, /安全模式/);
    w.target.controller.safeMode = 0;
    w.target.enemies.push({ attack: 1000, owner: { username: 'enemy' } });
    w.tick();
    assert.equal(task.phase, 'planning'); assert.match(task.reason, /敌情升级/);
    assert.equal(JSON.parse(w.listCombatTasks(task.id)).spawnStatus, undefined);
});

test('expired protection reasons clear once a complete boosted squad can resume combat', () => {
    const w = world(), task = w.create(); w.runCombatTasks(); w.publish();
    task.memberNames.forEach(name => w.spawn(name)); w.tick();
    w.target.controller.safeMode = 100; w.tick();
    assert.match(task.reason, /安全模式/);
    assert.equal(JSON.parse(w.listCombatTasks(task.id)).spawnStatus.ready, 2);
    w.target.controller.safeMode = 0; w.tick(); w.publish();
    const summary = JSON.parse(w.listCombatTasks(task.id));
    assert.equal(task.phase, 'combat'); assert.equal(summary.reason, undefined);
    assert.equal(summary.spawnStatus.ready, 2); assert.equal(summary.spawnStatus.pending, 0);
    assert.equal(task.wave, 1); assert.equal(task.spent, 0);
});
