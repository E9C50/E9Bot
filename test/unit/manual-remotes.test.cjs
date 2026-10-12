const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const nativeBodies = require('../helpers/native-bodies.cjs');

function world({ level = 3, capacity = 800, visible = true, second = true } = {}) {
    const objects = new Map(), calls = [], game = { time: 100, shard: { name: 'shard2' }, rooms: {}, creeps: {}, flags: {},
        cpu: { bucket: 5000, tickLimit: 500, getUsed: () => 0 }, getObjectById: id => objects.get(id) || null,
        map: { getRoomLinearDistance: () => 1, findRoute: (_from, to) => [{ room: to, exit: 3 }],
            getRoomTerrain: () => ({ get: () => 0 }), getRoomStatus: () => ({ status: 'normal' }) } };
    const memory = { warMode: {}, creeps: {}, rooms: {}, combatTasks: {} };
    class Position {
        constructor(x, y, roomName) { Object.assign(this, { x, y, roomName }); }
        getRangeTo(value) { const pos = value.pos || value; return pos.roomName === this.roomName ? Math.max(Math.abs(this.x-pos.x), Math.abs(this.y-pos.y)) : Infinity; }
        inRangeTo(value, range) { return this.getRangeTo(value) <= range; }
        isNearTo(value) { return this.getRangeTo(value) <= 1; }
        isEqualTo(value) { return this.getRangeTo(value) === 0; }
    }
    const position = (x, y, roomName) => new Position(x, y, roomName);
    function store(energy = 0, capacity = 1000) {
        return { energy, getUsedCapacity: () => energy, getCapacity: () => capacity, getFreeCapacity: () => capacity-energy };
    }
    function makeRoom(name, owned = false) {
        const room = { name, my: owned, level: owned ? level : 0, memory: { creepConfig: {}, roomFillJob: {} },
            controller: { my: owned, level: owned ? level : 0, ...(owned ? { owner: { username: 'me' } } : {}),
                pos: position(20, 20, name) }, sources: [], spawns: [], extensions: [], containers: [], links: [],
            constructionSites: [], roads: [], labs: [], structures: [], enemies: [],
            energyCapacityAvailable: owned ? capacity : 0, energyAvailable: owned ? capacity : 0,
            getTerrain: () => ({ get: () => 0 }), lookForAt: () => [],
            find(type) { return type === 'sources' ? this.sources : type === 'spawns' ? this.spawns :
                type === 'structures' ? this.structures : type === 'hostiles' ? this.enemies : []; } };
        game.rooms[name] = room; memory.rooms[name] = room.memory; return room;
    }
    function source(room, id, x = 10, y = 10) {
        const object = { id, pos: position(x, y, room.name), room, energy: 3000, energyCapacity: 3000 };
        room.sources.push(object); objects.set(id, object); return object;
    }
    const home = makeRoom('E41N6', true), homeSource = source(home, 'home-source');
    const target = makeRoom('E41N5'), mine = source(target, 'remote-source');
    const other = makeRoom('E42N6'), otherMine = source(other, 'other-source');
    const flag = (slot, room) => {
        const name = `${home.name}_OUT${slot}`;
        game.flags[name] = { name, pos: position(25, 25, room.name) };
        Object.defineProperty(game.flags[name], 'room', { get() { throw Error('manual remotes must use Game.rooms, not Flag.room'); } });
        return game.flags[name];
    };
    flag(0, target); if (second) flag(1, other);
    if (!visible) { delete game.rooms[target.name]; delete game.rooms[other.name]; }
    const roles = ['harvester', 'filler', 'builder', 'upgrader', 'scout', 'reserver', 'rHarvester', 'rFiller', 'rBuilder', 'rdefender', 'claimer', 'sBuilder'];
    const factories = Object.fromEntries(roles.map(role => [role, () => ({ isNeed: () => true, prepare: () => true, source: () => true, target: () => true })]));
    factories.isRoleSupported = role => roles.includes(role);
    factories.createRoleBehavior = role => factories[role]?.();
    const loader = createSourceLoader({ globals: { ...nativeBodies.globals, Game: game, Memory: memory, RoomPosition: Position,
        StructureSpawn: class {}, BODYPART_COST: { work:100, carry:50, move:50, claim:600, tough:10, attack:80, ranged_attack:150, heal:250 },
        RESOURCE_ENERGY: 'energy', SOURCE_ENERGY_NEUTRAL_CAPACITY: 1500, CREEP_SPAWN_TIME: 3,
        STRUCTURE_LINK: 'link', STRUCTURE_CONTAINER: 'container', STRUCTURE_ROAD: 'road', STRUCTURE_RAMPART: 'rampart',
        STRUCTURE_INVADER_CORE: 'invaderCore', STRUCTURE_TOWER: 'tower', STRUCTURE_SPAWN: 'spawn',
        FIND_MY_SPAWNS: 'spawns', FIND_MY_CREEPS: 'my-creeps', FIND_SOURCES: 'sources', FIND_STRUCTURES: 'structures',
        FIND_HOSTILE_STRUCTURES: 'structures', FIND_HOSTILE_CREEPS: 'hostiles', LOOK_STRUCTURES: 'structures', LOOK_CREEPS: 'creeps',
        TERRAIN_MASK_WALL: 1, OK: 0, HEAL_POWER: 12, RANGED_ATTACK_POWER: 10, BOOSTS: { heal: {}, ranged_attack: {}, tough: {} },
    }, modules: { ...nativeBodies.modules, role: factories,
        'shard/targetDismantleControl': { isTargetDismantleSpawnReserved: () => false },
        utils: { sha1String: value => crypto.createHash('sha1').update(value).digest('hex').slice(0, 10), getDistance: (a,b) => a.getRangeTo(b) },
    } });
    const Spawn = loader.load('mount/structure/SpawnExtension').default;
    const spawn = new Spawn();
    Object.assign(spawn, { id: 'home-spawn', my: true, room: home, pos: position(25, 25, home.name), owner: { username: 'me' },
        spawning: null, store: store(0), spawnCreep(body, name, options) { calls.push({ body, name, memory: options.memory }); return 0; } });
    home.spawns.push(spawn); objects.set(spawn.id, spawn);
    const demand = loader.load('creep/demand'), publisher = loader.load('creep/remotePopulation'), queue = loader.load('creep/spawnQueue');
    const commissioning = loader.load('creep/remoteCommissioning');
    function unit(name, role, data, room = home, x = 10, y = 10, parts) {
        const body = (parts || (role === 'reserver' ? ['claim','move'] : role === 'rFiller' || role === 'filler' ? ['carry','carry','move','move'] : ['work','carry','move']))
            .map(type => ({ type, hits: 100 }));
        const creep = { name, id: name, room, pos: position(x,y,room.name), body, spawning: false, ticksToLive: 1200,
            store: store(0,100), owner: { username: 'me' }, memory: { name, role, spawnRoom: home.name, data,
                ready: true, working: false, boostPlan: { tier: 0, steps: [], completed: true } },
            getActiveBodyparts: part => body.filter(value => value.type === part && value.hits > 0).length };
        game.creeps[name] = creep; return creep;
    }
    unit('local-miner', 'harvester', { sourceId: homeSource.id }, home, 11, 10);
    unit('local-filler', 'filler', { sourceId: homeSource.id }, home, 25, 25);
    const configs = role => Object.values(home.memory.creepConfig).filter(config => !role || config.role === role);
    function published(role, room = target) {
        return Object.entries(home.memory.creepConfig).find(([, config]) => config.role === role &&
            (config.data.targetRoom === room.name || room.sources.some(source => [config.data.sourceId, config.data.sourceFlag].includes(source.id))));
    }
    function born(role, room = target) {
        const [name, config] = published(role, room) || [];
        assert.ok(config, `missing ${role} demand for ${room.name}`);
        const sourceObject = room.sources.find(source => [config.data.sourceId, config.data.sourceFlag].includes(source.id));
        const pos = role === 'reserver' ? room.controller.pos : sourceObject?.pos || home.spawns[0].pos;
        return unit(name, role, structuredClone(config.data), role === 'rFiller' ? home : room, pos.x + 1, pos.y);
    }
    return { game, memory, loader, home, target, other, mine, otherMine, flag, calls, configs, published, born, unit, demand, commissioning, spawn,
        release() { game.time++; home.memory.creepConfig = {}; publisher.releaseJobsCreepConfig(); home.memory.creepSpawnQueue = queue.buildSpawnQueue(home); },
        queuedRoles() { return Array.from(home.memory.creepSpawnQueue || [], name => home.memory.creepConfig[name]?.role); },
    };
}

function maintainedMiner(w) {
    w.release();
    w.home.memory.remoteCommissioning.rooms[w.target.name].maintenance = true;
    w.release();
    return w.published('rHarvester');
}

test('manual OUT fixed-source miners retain their full mining body before construction and after losing vision', () => {
    for (const [capacity, work, carry, move] of [[1800, 11, 2, 11], [2300, 14, 3, 14]]) {
        const w = world({ level: 5, capacity, second: false });
        const [, config] = maintainedMiner(w);
        assert.equal(config.bodyProfile?.stationary, true);
        assert.equal(config.development, undefined, 'manual work must stay eligible at RCL8');
        const selection = w.loader.load('creep/bodySelection');
        const before = Array.from(selection.previewBodySelection(w.home, config, 0).body);
        assert.equal(before.filter(part => part === 'work').length, work);
        assert.equal(before.filter(part => part === 'carry').length, carry, 'unbuilt stations retain energy for bootstrap construction');
        assert.equal(before.filter(part => part === 'move').length, move);
        w.target.containers.push({ id: 'source-container', pos: new w.loader.globals.RoomPosition(w.mine.pos.x + 1, w.mine.pos.y, w.target.name) });
        assert.deepEqual(Array.from(selection.previewBodySelection(w.home, config, 0).body), before);
        delete w.game.rooms[w.target.name];
        // getObjectById cannot return native Sources outside visible rooms.
        w.game.getObjectById = () => null;
        w.release();
        assert.deepEqual(Array.from(selection.previewBodySelection(w.home, w.published('rHarvester')[1], 0).body), before,
            'cached manual Source demand must not regress to a moving builder body');
    }
});

test('manual OUT station defaults preserve explicit global and room stationary preferences', () => {
    for (const [global, room, expectedWork] of [[false, undefined, 5], [true, false, 5], [false, true, 11]]) {
        const w = world({ level: 5, capacity: 1800, second: false });
        w.loader.load('settings/bodyPolicy').bodyPolicy.profiles.rHarvester = { stationary: global, boostTier: 0 };
        if (room !== undefined) w.home.memory.bodyProfiles = { rHarvester: { stationary: room } };
        const [, config] = maintainedMiner(w);
        assert.equal(config.bodyProfile?.stationary, undefined, 'an explicit preference stays authoritative in the native planner');
        const plan = w.loader.load('creep/bodySelection').previewBodySelection(w.home, config, 0);
        assert.equal(plan.body.filter(part => part === 'work').length, expectedWork);
    }
});

test('manual OUT station defaults retain unrelated user body constraints', () => {
    const w = world({ level: 5, capacity: 1800, second: false });
    w.loader.load('settings/bodyPolicy').bodyPolicy.profiles.rHarvester = { workParts: 3, terrain: 'road', boostTier: 0 };
    w.home.memory.bodyProfiles = { rHarvester: { maximumCost: 1000 } };
    const [, config] = maintainedMiner(w);
    const plan = w.loader.load('creep/bodySelection').previewBodySelection(w.home, config, 0);
    assert.deepEqual(Array.from(plan.body), ['work', 'work', 'work', 'carry', 'move', 'move']);
});

test('mature manual OUT fixed-source miners wait for their full native body and remain spawnable', () => {
    const w = world({ level: 8, capacity: 12900, second: false });
    const [name, config] = maintainedMiner(w);
    assert.equal(config.development, undefined);
    const plan = w.loader.load('creep/bodySelection').previewBodySelection(w.home, config, 0);
    const cost = plan.body.reduce((total, part) => total + w.loader.globals.BODYPART_COST[part], 0);
    assert.equal(plan.body.length, 50);
    assert.ok(plan.body.filter(part => part === 'carry').length > 0);
    w.home.memory.creepSpawnQueue = [name];
    w.home.energyAvailable = cost - 1; w.spawn.doWork(); assert.equal(w.calls.length, 0);
    w.home.energyAvailable = cost; w.spawn.doWork(); assert.equal(w.calls.length, 1);
    assert.deepEqual(Array.from(w.calls[0].body), Array.from(plan.body));
});

test('maintained productive OUT rooms restore reservation and only the serving Source haul ahead of generic maintenance', () => {
    const w = world({ capacity: 1800, second: false });
    const idle = { id: 'idle-source', pos: new w.loader.globals.RoomPosition(35, 35, w.target.name), room: w.target, energyCapacity: 1500 };
    w.target.sources.push(idle);
    maintainedMiner(w); w.born('rHarvester'); w.release();
    const [reserver] = w.published('reserver'), [hauler] = w.published('rFiller');
    const priorities = w.loader.load('settings/population').populationPolicy.remote;
    assert.equal(w.home.memory.creepConfig[reserver].spawnPriority, priorities.pipelinePriorities.reserver);
    assert.equal(w.home.memory.creepConfig[hauler].spawnPriority, priorities.pipelinePriorities.hauler);
    assert.equal(w.configs('rFiller').find(config => config.data.sourceFlag === idle.id).spawnPriority, priorities.startupPriorities.maintenance);
    assert.equal(w.configs('rHarvester').find(config => config.data.sourceId === idle.id).spawnPriority, priorities.startupPriorities.maintenance);
    const names = [];
    for (const [label, role, priority] of [['rescue','harvester',1], ['consumer','builder',2.55],
        ['road','rBuilder',2.58], ['stock','upgrader',2.59]]) {
        const name = w.demand.addCreepConfig(w.home, role, label, {});
        w.home.memory.creepConfig[name].spawnPriority = priority; names.push(name);
    }
    const queue = Array.from(w.loader.load('creep/spawnQueue').buildSpawnQueue(w.home));
    const order = [names[0], names[1], reserver, hauler, names[2], names[3]];
    for (let index = 1; index < order.length; index++) assert.ok(queue.indexOf(order[index-1]) < queue.indexOf(order[index]));
});

test('productive maintenance priority requires an arrived live WORK miner assigned to a visible Source', () => {
    const invalid = [
        ['spawning', (_w, miner) => { miner.spawning = true; }],
        ['dead', (_w, miner) => { miner.ticksToLive = 0; }],
        ['no active WORK', (_w, miner) => { miner.body.find(part => part.type === 'work').hits = 0; }],
        ['builder', (_w, miner) => { miner.memory.role = 'rBuilder'; }],
        ['another home', (_w, miner) => { miner.memory.spawnRoom = 'E42N6'; }],
        ['another Source', (_w, miner) => { miner.memory.data.sourceId = 'unrelated-source'; }],
        ['travelling', (w, miner) => { miner.room = w.home; miner.pos = w.home.spawns[0].pos; }],
        ['not at Source', (w, miner) => { miner.pos = new w.loader.globals.RoomPosition(25, 25, w.target.name); }],
        ['no vision', (w) => { delete w.game.rooms[w.target.name]; }],
        ['boosting', (_w, miner) => { miner.memory.boostPlan = { tier: 1, steps: [{ resource: 'UO', parts: 1 }], completed: false }; }],
        ['retiring', (_w, miner) => { miner.memory.data.developmentRemote = { retiring: true }; }],
        ['disabled miner retiring after healing', (_w, miner) => { miner.memory.data.disabledMinerRetiring = true; }],
    ];
    for (const [label, invalidate] of invalid) {
        const w = world({ second: false }); maintainedMiner(w);
        const miner = w.born('rHarvester'); invalidate(w, miner); w.release();
        assert.equal(w.published('reserver')[1].spawnPriority, 2.6, label);
        assert.equal(w.published('rFiller')[1].spawnPriority, 2.6, label);
    }
});

test('productive pipeline priority promotes only missing slots and does not produce duplicate paid workers', () => {
    const w = world({ second: false }); maintainedMiner(w); w.born('rHarvester'); w.release();
    const reserver = w.born('reserver'), hauler = w.born('rFiller'); w.release();
    assert.equal(w.published('reserver')[1].spawnPriority, 2.6);
    assert.equal(w.published('rFiller')[1].spawnPriority, 2.6);
    assert.ok(!w.home.memory.creepSpawnQueue.includes(reserver.name));
    assert.ok(!w.home.memory.creepSpawnQueue.includes(hauler.name));
});

test('an arrived miner in a new OUT still follows sequential reserver-miner-hauler startup priorities', () => {
    const w = world(); w.release();
    w.born('reserver'); w.target.controller.reservation = { username: 'me', ticksToEnd: 100 }; w.release();
    w.born('rHarvester'); w.release();
    assert.equal(w.published('reserver')[1].spawnPriority, 2.7);
    assert.equal(w.published('rFiller')[1].spawnPriority, 2.9);
    assert.equal(w.published('reserver', w.other), undefined, 'the first mine still owes its first real energy delivery');
});

test('productive promotions preserve pending age for generic maintenance in other OUT rooms', () => {
    const w = world(); w.release();
    for (const record of Object.values(w.home.memory.remoteCommissioning.rooms)) record.maintenance = true;
    w.release();
    const [otherReserver] = w.published('reserver', w.other), [otherHauler] = w.published('rFiller', w.other);
    const since = w.home.memory.creepSpawnWaitingSince[otherHauler];
    const miner = w.born('rHarvester'); w.release();
    assert.equal(w.published('rFiller')[1].spawnPriority, 2.575);
    assert.equal(w.home.memory.creepSpawnWaitingSince[otherHauler], since);
    assert.equal(w.home.memory.creepSpawnWaitingSince[otherReserver], since);
    delete w.game.creeps[miner.name]; w.release();
    const [reserver] = w.published('reserver'), [hauler] = w.published('rFiller');
    assert.equal(w.home.memory.creepConfig[hauler].spawnPriority, 2.6);
    assert.equal(w.home.memory.creepSpawnWaitingSince[otherHauler], since);
    assert.ok(w.home.memory.creepSpawnQueue.indexOf(otherReserver) < w.home.memory.creepSpawnQueue.indexOf(reserver));
    assert.ok(w.home.memory.creepSpawnQueue.indexOf(otherHauler) < w.home.memory.creepSpawnQueue.indexOf(hauler));
});

function arriveRemoteHauler(w) {
    const hauler = w.born('rFiller');
    hauler.room = w.target;
    hauler.pos = new w.loader.globals.RoomPosition(w.mine.pos.x + 3, w.mine.pos.y, w.target.name);
    return hauler;
}

test('an arrived empty manual hauler restores its missing Source miner ahead of roads without expanding the fleet', () => {
    const w = world({ second: false });
    const idle = { id: 'idle-source', pos: new w.loader.globals.RoomPosition(35, 35, w.target.name), room: w.target, energyCapacity: 1500 };
    w.target.sources.push(idle); maintainedMiner(w);
    arriveRemoteHauler(w);
    w.unit('other-source-miner', 'rHarvester', { sourceId: idle.id, targetRoom: w.target.name }, w.target, 36, 35);
    w.release();
    const [miner, config] = w.published('rHarvester'), [reserver] = w.published('reserver');
    const hauler = Object.entries(w.home.memory.creepConfig).find(([, config]) => config.role === 'rFiller' && config.data.sourceFlag === idle.id)[0];
    assert.equal(config.spawnPriority, 2.576);
    assert.equal(w.configs('rHarvester').find(config => config.data.sourceId === idle.id).spawnPriority, 2.6,
        'transport capacity is bound to its assigned Source');
    assert.equal(w.configs('rHarvester').length, 2);
    assert.equal(w.configs('rFiller').length, 2);
    const road = w.demand.addCreepConfig(w.home, 'rBuilder', 'repair-road', {});
    w.home.memory.creepConfig[road].spawnPriority = 2.58;
    const queue = Array.from(w.loader.load('creep/spawnQueue').buildSpawnQueue(w.home));
    assert.ok(queue.indexOf(reserver) < queue.indexOf(hauler));
    assert.ok(queue.indexOf(hauler) < queue.indexOf(miner));
    assert.ok(queue.indexOf(miner) < queue.indexOf(road));
});

test('a loaded hauler restores its missing miner only while actually at that Source', () => {
    const w = world({ second: false }); maintainedMiner(w);
    const hauler = arriveRemoteHauler(w);
    hauler.store.energy = 900; hauler.memory.working = true;
    w.release(); assert.equal(w.published('rHarvester')[1].spawnPriority, 2.576);
    hauler.room = w.home; hauler.pos = w.home.spawns[0].pos;
    w.release(); assert.equal(w.published('rHarvester')[1].spawnPriority, 2.6,
        'return cargo and an earlier arrival do not promise current transport at the mine');
    hauler.store.energy = 0; hauler.memory.working = false;
    hauler.room = w.target; hauler.pos = new w.loader.globals.RoomPosition(w.mine.pos.x + 1, w.mine.pos.y, w.target.name);
    w.release(); assert.equal(w.published('rHarvester')[1].spawnPriority, 2.576);
});

test('missing-miner recovery requires a live mobile manual hauler at its visible assigned Source', () => {
    const invalid = [
        ['spawning', (_w, hauler) => { hauler.spawning = true; }],
        ['dead', (_w, hauler) => { hauler.ticksToLive = 0; }],
        ['no active CARRY', (_w, hauler) => { hauler.body.filter(part => part.type === 'carry').forEach(part => { part.hits = 0; }); }],
        ['no active MOVE', (_w, hauler) => { hauler.body.filter(part => part.type === 'move').forEach(part => { part.hits = 0; }); }],
        ['builder', (_w, hauler) => { hauler.memory.role = 'rBuilder'; }],
        ['another home', (_w, hauler) => { hauler.memory.spawnRoom = 'E42N6'; }],
        ['another Source', (_w, hauler) => { hauler.memory.data.sourceFlag = 'unrelated-source'; }],
        ['wrong destination', (_w, hauler) => { hauler.memory.data.targetFlag = 'another-home-spawn'; }],
        ['travelling', (w, hauler) => { hauler.room = w.home; hauler.pos = w.home.spawns[0].pos; }],
        ['outside Source range', (w, hauler) => { hauler.pos = new w.loader.globals.RoomPosition(w.mine.pos.x + 4, w.mine.pos.y, w.target.name); }],
        ['position in another room', (w, hauler) => { hauler.pos = new w.loader.globals.RoomPosition(w.mine.pos.x, w.mine.pos.y, w.home.name); }],
        ['no vision', (w) => { delete w.game.rooms[w.target.name]; }],
        ['boosting', (_w, hauler) => { hauler.memory.boostPlan = { tier: 1, steps: [{ resource: 'KH', parts: 1 }], completed: false }; }],
        ['retiring', (_w, hauler) => { hauler.memory.data.developmentRemote = { retiring: true }; }],
        ['ordinary source flag', (w, hauler) => { w.game.flags[hauler.memory.data.sourceFlag] = { name: hauler.memory.data.sourceFlag, pos: w.mine.pos }; }],
        ['ordinary target flag', (w, hauler) => { w.game.flags[hauler.memory.data.targetFlag] = { name: hauler.memory.data.targetFlag, pos: w.home.spawns[0].pos }; }],
    ];
    for (const [label, invalidate] of invalid) {
        const w = world({ second: false }); maintainedMiner(w);
        const hauler = arriveRemoteHauler(w); invalidate(w, hauler); w.release();
        assert.equal(w.published('rHarvester')[1].spawnPriority, 2.6, label);
    }
});

test('arrived haul capacity never bypasses a new manual mine startup or admits the next mine', () => {
    const w = world(); w.release();
    w.born('reserver'); w.target.controller.reservation = { username: 'me', ticksToEnd: 100 }; w.release();
    const miner = w.born('rHarvester'); w.release();
    arriveRemoteHauler(w); delete w.game.creeps[miner.name]; w.release();
    assert.equal(w.home.memory.remoteCommissioning.rooms[w.target.name].maintenance, false);
    assert.equal(w.published('rHarvester')[1].spawnPriority, 2.8);
    assert.equal(w.published('reserver', w.other), undefined, 'the first mine still needs real production and delivery');
});

test('arrived haul capacity cannot add or promote a miner while its paid slot is alive or spawning', () => {
    for (const state of ['working', 'spawning', 'travelling']) {
        const w = world({ second: false }); maintainedMiner(w);
        const miner = w.born('rHarvester'); arriveRemoteHauler(w);
        if (state === 'spawning') miner.spawning = true;
        if (state === 'travelling') { miner.room = w.home; miner.pos = w.home.spawns[0].pos; }
        w.release();
        assert.equal(w.published('rHarvester')[1].spawnPriority, 2.6, state);
        assert.equal(w.configs('rHarvester').length, 1, state);
        assert.ok(!w.home.memory.creepSpawnQueue.includes(miner.name), state);
    }
});

test('missing-miner recovery keeps generic maintenance waiting ages in other manual mines', () => {
    const w = world(); w.release();
    for (const record of Object.values(w.home.memory.remoteCommissioning.rooms)) record.maintenance = true;
    w.release();
    const [otherMiner] = w.published('rHarvester', w.other);
    const since = w.home.memory.creepSpawnWaitingSince[otherMiner];
    arriveRemoteHauler(w); w.release();
    const [miner, config] = w.published('rHarvester');
    assert.equal(config.spawnPriority, 2.576);
    assert.equal(w.home.memory.creepSpawnWaitingSince[otherMiner], since);
    assert.ok(w.home.memory.creepSpawnQueue.indexOf(miner) < w.home.memory.creepSpawnQueue.indexOf(otherMiner));
});

test('two manual OUT mines commission one at a time; published configs and incomplete births cannot unlock the second', () => {
    const w = world(); w.release();
    assert.deepEqual(w.queuedRoles(), ['reserver']);
    assert.equal(w.published('reserver', w.other), undefined);
    w.release(); assert.equal(w.configs('rHarvester').length, 0);
    const reserver = w.born('reserver'); reserver.spawning = true;
    w.release(); assert.equal(w.configs('rHarvester').length, 0);
    reserver.spawning = false; w.target.controller.reservation = { username: 'me', ticksToEnd: 100 };
    w.release(); assert.equal(w.configs('rHarvester').length, 1); assert.equal(w.configs('rFiller').length, 0);
    const miner = w.born('rHarvester'); miner.spawning = true;
    w.release(); assert.equal(w.configs('rFiller').length, 0);
    miner.spawning = false; w.release(); assert.equal(w.configs('rFiller').length, 1);
    const hauler = w.born('rFiller'); w.release();
    assert.equal(w.published('reserver', w.other), undefined, 'a born hauler has not yet delivered energy');
    w.commissioning.recordRemoteEnergyDelivery(hauler, 0); w.release();
    assert.equal(w.published('reserver', w.other), undefined);
    w.commissioning.recordRemoteEnergyDelivery(hauler, 100); w.release();
    assert.ok(w.published('reserver', w.other));
    assert.equal(w.configs('rHarvester').length, 1, 'the first mine stays maintained');
    assert.equal(w.configs('rFiller').length, 1);
});

test('an unseen admitted OUT keeps a complete native reserver and an independent scout targeting the actual flag', () => {
    const w = world({ visible: false });
    w.game.flags[`${w.home.name}_SCOUT`] = { name: `${w.home.name}_SCOUT`, pos: new w.loader.globals.RoomPosition(25,25,'E40N6') };
    w.release();
    assert.equal(w.configs('reserver').length, 1);
    assert.equal(w.configs('reserver')[0].data.targetRoom, w.target.name);
    assert.equal(w.configs('reserver')[0].bodyProfile.boostTier, 0);
    const scouts = w.configs('scout');
    assert.equal(scouts.length, 2);
    assert.ok(scouts.some(config => config.name === `${w.home.name}_OUT_SCOUT` && config.data.targetFlag === `${w.home.name}_OUT0`));
    assert.ok(scouts.some(config => config.name === `${w.home.name}_SCOUT` && config.data.targetFlag === `${w.home.name}_SCOUT`));
    assert.equal(w.published('reserver', w.other), undefined);
    // Isolate the native reserver intent from the deliberately cheaper scout.
    w.home.memory.creepSpawnQueue = [w.published('reserver')[0]];
    w.home.energyAvailable = 300; w.spawn.doWork(); assert.equal(w.calls.length, 0);
    w.home.energyAvailable = 650; w.spawn.doWork();
    assert.equal(w.calls.length, 1);
    assert.deepEqual(Array.from(w.calls[0].body).sort(), ['claim','move']);
    assert.equal(w.calls[0].memory.boostPlan.tier, 0);
});

test('a successful remote birth immediately clears its old waiting age', () => {
    const w = world(); w.release();
    const [name] = w.published('reserver');
    w.home.memory.creepSpawnQueue = [name];
    w.home.memory.creepSpawnWaitingSince = { [name]: 50 };
    w.home.energyAvailable = 650;
    w.spawn.doWork();
    assert.equal(w.calls.length, 1);
    assert.equal(w.home.memory.creepSpawnWaitingSince, undefined,
        'spawnCreep OK precedes Game.creeps visibility of the new unit');
});

test('a room below reserver capacity keeps room growth unblocked instead of queueing an impossible 650 body', () => {
    const w = world({ capacity: 550 }); w.release();
    assert.equal(w.configs('reserver').length, 0);
    assert.equal(w.configs('rHarvester').length, 0);
    w.demand.addCreepConfig(w.home, 'builder', 'extend-capacity', {});
    const queue = w.loader.load('creep/spawnQueue');
    assert.deepEqual(Array.from(queue.buildSpawnQueue(w.home), name => w.home.memory.creepConfig[name].role), ['builder']);
});

test('duplicate OUT flags share the same mine and a live OUT scout follows a moved flag', () => {
    const w = world({ visible: false, second: false }); w.flag(1, w.target); w.release();
    assert.equal(w.configs('reserver').length, 1);
    assert.equal(w.configs('scout').length, 1);
    const scoutConfig = w.configs('scout')[0], scoutName = Object.keys(w.home.memory.creepConfig).find(name => w.home.memory.creepConfig[name] === scoutConfig);
    const scout = w.unit(scoutName, 'scout', { targetFlag: `${w.home.name}_OUT1` });
    delete w.game.flags[`${w.home.name}_OUT1`]; w.game.flags[`${w.home.name}_OUT0`].pos.roomName = w.other.name;
    w.release();
    assert.equal(scout.memory.data.targetFlag, `${w.home.name}_OUT0`);
    assert.equal(w.configs('reserver')[0].data.targetRoom, w.other.name);
});

test('known occupied or empty OUT rooms never consume the startup slot ahead of a valid manual mine', () => {
    for (const problem of ['occupied','empty','no-controller']) {
        const w = world();
        if (problem === 'occupied') w.target.controller.owner = { username:'other' };
        if (problem === 'empty') w.target.sources = [];
        if (problem === 'no-controller') delete w.target.controller;
        w.release();
        assert.equal(w.configs('reserver').length, 1, problem);
        assert.equal(w.configs('reserver')[0].data.targetRoom, w.other.name, problem);
        assert.equal(w.home.memory.remoteCommissioning.current, w.other.name, problem);
    }
});

test('manual core demand priorities follow local rescue and Invader guard before nonessential births', () => {
    const w = world(); w.release();
    const local = w.demand.addCreepConfig(w.home,'harvester','rescue',{sourceId:w.home.sources[0].id});
    const filler = w.demand.addCreepConfig(w.home,'filler','fuel',{sourceId:w.home.sources[0].id});
    const invader = w.demand.addCreepConfig(w.home,'rdefender','invader',{}); w.home.memory.creepConfig[invader].spawnPriority = 2.5;
    const fighter = w.demand.addCreepConfig(w.home,'sBuilder','combat',{}); w.home.memory.creepConfig[fighter].spawnPriority = 3.5;
    const queue = w.loader.load('creep/spawnQueue');
    assert.deepEqual(Array.from(queue.buildSpawnQueue(w.home)).slice(0,3), [local,filler,invader]);
    assert.ok(queue.buildSpawnQueue(w.home).indexOf(w.published('reserver')[0]) < queue.buildSpawnQueue(w.home).indexOf(fighter));
    assert.equal(w.configs('reserver')[0].spawnPriority, 2.7);
    w.born('reserver'); w.target.controller.reservation = { username:'me',ticksToEnd:100 }; w.release();
    assert.equal(w.configs('rHarvester')[0].spawnPriority, 2.8);
    w.born('rHarvester'); w.release(); assert.equal(w.configs('rFiller')[0].spawnPriority, 2.9);
});

test('commissioned mine replacement precedes a new mine and keeps cached sources when vision is lost', () => {
    const w = world(); w.release();
    w.born('reserver'); w.target.controller.reservation = { username:'me',ticksToEnd:100 }; w.release();
    const miner = w.born('rHarvester'); w.release(); const hauler = w.born('rFiller');
    w.commissioning.recordRemoteEnergyDelivery(hauler, 100); w.release();
    assert.ok(w.published('reserver',w.other));
    delete w.game.creeps[miner.name]; delete w.game.rooms[w.target.name]; w.release();
    const replacement = w.published('rHarvester'); assert.ok(replacement);
    assert.equal(replacement[1].spawnPriority, 2.6);
    assert.equal(w.published('rFiller')[1].spawnPriority, 2.6);
    assert.equal(w.published('reserver')[1].spawnPriority, 2.6);
    assert.equal(w.published('reserver',w.other)[1].spawnPriority, 2.7);
    assert.ok(w.home.memory.creepSpawnQueue.indexOf(replacement[0]) <
        w.home.memory.creepSpawnQueue.indexOf(w.published('reserver',w.other)[0]));
});

test('independent manual RF, RB and CLAIM instructions continue to publish while the OUT mine is reserving', () => {
    const w = world();
    for (const suffix of ['RF_S0','RF_T0','RB_S0','RB_T0','CLAIM']) {
        const name = `${w.home.name}_${suffix}`; w.game.flags[name] = { name, pos: { roomName: w.other.name } };
    }
    w.release();
    assert.equal(w.configs('reserver').length, 1);
    assert.ok(w.configs('rFiller').some(config => config.data.sourceFlag === `${w.home.name}_RF_S0`));
    assert.ok(w.configs('rBuilder').some(config => config.data.sourceFlag === `${w.home.name}_RB_S0`));
    assert.equal(w.configs('claimer').length, 1);
});

test('manual OUT reserver and scout births wait for real local mining and source hauling rather than published or spawning bodies', () => {
    for (const invalidate of [w => { w.game.creeps['local-miner'].spawning = true; },
        w => { w.game.creeps['local-filler'].spawning = true; },
        w => { w.game.creeps['local-miner'].pos = new w.loader.globals.RoomPosition(25, 25, w.home.name); },
        w => { w.game.creeps['local-filler'].memory.data.sourceId = 'unrelated'; }]) {
        const w = world({ visible: false }); invalidate(w); w.release();
        assert.deepEqual(w.configs(), [], invalidate.toString());
        assert.equal(w.home.memory.remoteCommissioning?.current, undefined);
    }
    const w = world(); w.home.energyAvailable = 0; w.release();
    assert.equal(w.configs('reserver').length, 1, 'only productive local coverage is required, not a full energy pool');
});

test('a stale OUT queue cannot spend another Spawn on remote maintenance after its local carrier dies', () => {
    const w = world(); w.release();
    const reserver = w.born('reserver'); w.target.controller.reservation = { username: 'me', ticksToEnd: 100 };
    w.release(); const miner = w.born('rHarvester'); w.release();
    const haulerConfig = w.published('rFiller');
    assert.equal(w.commissioning.remoteSpawnAllowed(w.home, haulerConfig[1]), true);
    delete w.game.creeps['local-filler'];
    assert.equal(w.commissioning.remoteSpawnAllowed(w.home, haulerConfig[1]), false);
    w.home.memory.creepSpawnQueue = [haulerConfig[0]]; w.spawn.doWork(); assert.equal(w.calls.length, 0);
    w.release(); assert.equal(w.configs('reserver').length, 0);
    assert.ok(w.game.creeps[reserver.name]); assert.ok(w.game.creeps[miner.name]);
    assert.equal(miner.memory.data.developmentRemote?.retiring, undefined);
});

test('mature manual OUT tasks keep their previous local-economy admission behavior', () => {
    const w = world({ level: 8 }); w.game.creeps = {}; w.release();
    assert.equal(w.configs('reserver').length, 1);
    assert.equal(w.commissioning.remoteSpawnAllowed(w.home, w.published('reserver')[1]), true);
});
