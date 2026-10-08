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

test('manual core demand priorities preserve local rescue, Invader guard and combat precedence', () => {
    const w = world(); w.release();
    const local = w.demand.addCreepConfig(w.home,'harvester','rescue',{sourceId:w.home.sources[0].id});
    const filler = w.demand.addCreepConfig(w.home,'filler','fuel',{sourceId:w.home.sources[0].id});
    const invader = w.demand.addCreepConfig(w.home,'rdefender','invader',{}); w.home.memory.creepConfig[invader].spawnPriority = 2.5;
    const fighter = w.demand.addCreepConfig(w.home,'sBuilder','combat',{}); w.home.memory.creepConfig[fighter].spawnPriority = 3.5;
    const queue = w.loader.load('creep/spawnQueue');
    assert.deepEqual(Array.from(queue.buildSpawnQueue(w.home)).slice(0,4), [local,filler,invader,fighter]);
    assert.equal(w.configs('reserver')[0].spawnPriority, 3.75);
    w.born('reserver'); w.target.controller.reservation = { username:'me',ticksToEnd:100 }; w.release();
    assert.equal(w.configs('rHarvester')[0].spawnPriority, 4.25);
    w.born('rHarvester'); w.release(); assert.equal(w.configs('rFiller')[0].spawnPriority, 4.5);
});

test('commissioned mine replacement precedes a new mine and keeps cached sources when vision is lost', () => {
    const w = world(); w.release();
    w.born('reserver'); w.target.controller.reservation = { username:'me',ticksToEnd:100 }; w.release();
    const miner = w.born('rHarvester'); w.release(); const hauler = w.born('rFiller');
    w.commissioning.recordRemoteEnergyDelivery(hauler, 100); w.release();
    assert.ok(w.published('reserver',w.other));
    delete w.game.creeps[miner.name]; delete w.game.rooms[w.target.name]; w.release();
    const replacement = w.published('rHarvester'); assert.ok(replacement);
    assert.equal(replacement[1].spawnPriority, 3.6);
    assert.equal(w.published('rFiller')[1].spawnPriority, 3.6);
    assert.equal(w.published('reserver')[1].spawnPriority, 3.6);
    assert.equal(w.published('reserver',w.other)[1].spawnPriority, 3.75);
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
