const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const nativeBodies = require('../helpers/native-bodies.cjs');

const bodyCosts = { work: 100, carry: 50, move: 50 };
const roles = {
    roleBaseEnum: { HARVESTER: 'harvester', FILLER: 'filler', BUILDER: 'builder', UPGRADER: 'upgrader', REPAIRER: 'repairer', MINER: 'miner', SCOUT: 'scout' },
    roleAdvEnum: { MANAGER: 'manager', PROCESSER: 'processer', RBUILDER: 'rBuilder', CLAIMER: 'claimer', RESERVER: 'reserver', RHARVESTER: 'rHarvester', RFILLER: 'rFiller' },
    roleWarEnum: { ATTACKER: 'attacker', INTEGRATE: 'integrate', CONTROLLER_ATTACKER: 'cAttacker' },
    bodyConfigs: {
        builder: [{ work: 1, carry: 1, move: 1 }, { work: 2, carry: 2, move: 2 }],
        rBuilder: [{ work: 39, carry: 1, move: 10 }],
    },
};

function distance(first, second) {
    const target = second.pos || second;
    return Math.max(Math.abs(first.x - target.x), Math.abs(first.y - target.y));
}

function position(x, y, roomName = 'newRoom') {
    return {
        x, y, roomName,
        getFreeSpace: () => [{}],
        inRangeTo: (target, range) => distance({ x, y }, target) <= range,
        getRangeTo: target => distance({ x, y }, target),
    };
}

function room(name, { spawn = true, capacity = 300, owned = true } = {}) {
    const result = {
        name, my: owned, level: 1, energyCapacityAvailable: capacity,
        memory: { creepConfig: {} }, mineral: { id: `${name}-mineral` },
        spawns: spawn ? [{ id: `${name}-spawn` }] : [],
        sources: [], containers: [], links: [], roads: [], ramparts: [], portals: [], droppedResource: [],
        constructionSites: [{ id: `${name}-spawn-site`, structureType: 'spawn', pos: position(20, 20, name) }],
        find(type) {
            if (type === 'dropped') return this.droppedResource;
            if (type === 'sources') return this.sources;
            if (type === 'structures') return [this.storage, this.terminal, ...this.spawns, ...this.containers].filter(Boolean);
            return [];
        },
    };
    result.sources = [{ id: `${name}-source`, energy: 3000, room: result, pos: position(10, 10, name) }];
    return result;
}

function populationWorld(rooms, { warMode = {}, distances = {} } = {}) {
    const demands = [];
    const game = {
        rooms: Object.fromEntries(rooms.map(item => [item.name, item])), flags: {}, creeps: {},
        map: { getRoomLinearDistance: (home, target) => distances[`${home}:${target}`] ?? 1 },
    };
    const roleFactories = Object.fromEntries(Object.values({ ...roles.roleBaseEnum, ...roles.roleAdvEnum }).map(role => [role,
        () => ({ isNeed: room => role === 'builder' && room.constructionSites.length > 0 })]));
    const loader = createSourceLoader({
        globals: { ...nativeBodies.globals, Game: game, Memory: { warMode }, RESOURCE_ENERGY: 'energy', BODYPART_COST: bodyCosts },
        modules: {
            ...nativeBodies.modules,
            'settings/creep': roles,
            role: roleFactories,
            './demand': {
                createCreepName: (role, name) => `${role.toUpperCase()}_${name}`,
                addCreepConfig: (home, role, name, data) => demands.push({ home: home.name, role, name, data }),
            },
            utils: { sha1String: text => text },
        },
    });
    return { loader, game, demands, policy: loader.load('settings/population').populationPolicy };
}

test('a room with a Spawn and construction but no logistics publishes one Source-fed builder', () => {
    const newRoom = room('newRoom');
    const { loader, demands } = populationWorld([newRoom]);
    loader.load('creep/basePopulation').releaseBaseCreepConfig();
    const builders = demands.filter(item => item.role === 'builder');
    assert.equal(builders.length, 1);
    assert.match(builders[0].name, /BUILDER_BOOTSTRAP/);
    assert.equal(builders[0].data.sourceId, newRoom.sources[0].id);
});

test('mature one-miner-per-source publication skips discarded walkability and creep-occupancy scans', () => {
    const mature = room('mature');
    mature.level = 8;
    mature.sources[0].pos.getFreeSpace = () => { throw new Error('mature miner quota does not depend on temporary occupancy'); };
    const { loader, demands } = populationWorld([mature]);
    loader.load('creep/basePopulation').releaseBaseCreepConfig();
    const miners = demands.filter(item => item.role === 'harvester');
    assert.equal(miners.length, 1);
    assert.equal(miners[0].data.sourceId, mature.sources[0].id);
});

test('normal Container and Storage builder demands do not gain bootstrap duplicates', () => {
    for (const type of ['container', 'storage']) {
        const mature = room('mature');
        const logistics = { id: type, pos: position(10, 11), store: { energy: 1000 } };
        if (type === 'storage') mature.storage = logistics;
        else mature.containers.push(logistics);
        const { loader, demands } = populationWorld([mature]);
        loader.load('creep/basePopulation').releaseBaseCreepConfig();
        const builders = demands.filter(item => item.role === 'builder');
        assert.equal(builders.length, 1, type);
        assert.doesNotMatch(builders[0].name, /BOOTSTRAP/, type);
        assert.equal(builders[0].data.sourceId, logistics.id);
    }
});

test('bootstrap demand waits for construction and respects its enable switch', () => {
    const newRoom = room('newRoom');
    const { loader, demands, policy } = populationWorld([newRoom]);
    newRoom.constructionSites = [];
    loader.load('creep/basePopulation').releaseBaseCreepConfig();
    assert.equal(demands.filter(item => item.role === 'builder').length, 0);
    newRoom.constructionSites.push({ id: 'site' });
    policy.bootstrap.enabled = false;
    loader.load('creep/basePopulation').releaseBaseCreepConfig();
    assert.equal(demands.filter(item => item.role === 'builder').length, 0);
});

test('a room without a Spawn gets support from the nearest peaceful affordable home', () => {
    const target = room('target', { spawn: false });
    const distant = room('distant'), near = room('near'), atWar = room('atWar'), poor = room('poor', { capacity: 150 });
    const { loader, demands } = populationWorld([target, distant, atWar, poor, near], {
        warMode: { atWar: true },
        distances: { 'distant:target': 4, 'near:target': 2, 'atWar:target': 1, 'poor:target': 1 },
    });
    const api = loader.load('creep/remotePopulation');
    api.releaseBootstrapBuilderConfig();
    assert.equal(demands.length, 1);
    assert.equal(demands[0].home, 'near');
    assert.equal(demands[0].role, 'rBuilder');
    assert.equal(demands[0].data.sourceFlag, target.sources[0].id);
    assert.equal(demands[0].data.targetFlag, target.sources[0].id);
    assert.equal(demands[0].data.bootstrap, true);
    demands.length = 0;
    target.spawns.push({ id: 'finished-spawn' });
    api.releaseBootstrapBuilderConfig();
    assert.equal(demands.length, 0, 'support is no longer renewed once the Spawn is complete');
});

test('support is bounded by distance and configurable worker counts', () => {
    const target = room('target', { spawn: false }), home = room('home');
    const { loader, demands, policy } = populationWorld([target, home], { distances: { 'home:target': 6 } });
    const api = loader.load('creep/remotePopulation');
    api.releaseBootstrapBuilderConfig();
    assert.equal(demands.length, 0);
    policy.bootstrap.maxHomeDistance = 6;
    policy.bootstrap.remoteBuilderCount = 2;
    api.releaseBootstrapBuilderConfig();
    assert.equal(demands.length, 2);
    assert.notEqual(demands[0].name, demands[1].name);
});

function workerWorld(workRoom, data, options = {}) {
    const calls = [];
    const objects = Object.fromEntries(workRoom.sources.map(source => [source.id, source]));
    if (workRoom.storage) objects[workRoom.storage.id] = workRoom.storage;
    const game = { time: 10, shard: { name: 'shard3' }, rooms: { [workRoom.name]: workRoom }, flags: {}, creeps: {},
        getObjectById: id => objects[id] || [workRoom.storage, workRoom.terminal, ...workRoom.sources, ...workRoom.containers,
            ...workRoom.droppedResource, ...workRoom.constructionSites].find(item => item?.id === id) };
    const loader = createSourceLoader({
        globals: { Game: game, Memory: { warMode: {}, creeps: {} }, RESOURCE_ENERGY: 'energy', STRUCTURE_SPAWN: 'spawn',
            FIND_DROPPED_RESOURCES: 'dropped', FIND_SOURCES: 'sources', FIND_STRUCTURES: 'structures',
            WORK: 'work', CARRY: 'carry', MOVE: 'move', ERR_NO_PATH: -2, ERR_NOT_ENOUGH_RESOURCES: -6,
            ERR_INVALID_TARGET: -7, ERR_NOT_IN_RANGE: -9, OK: 0 },
        modules: { utils: {
            getDistance: distance,
            getClosestTarget: (pos, targets) => [...targets].sort((first, second) => distance(pos, first) - distance(pos, second))[0],
        } },
    });
    const capacity = options.capacity ?? 50;
    const store = { energy: options.energy ?? 0, getCapacity: () => capacity, getUsedCapacity: () => store.energy,
        getFreeCapacity: () => capacity - store.energy };
    const creep = {
        name: 'remote-bootstrap-worker', id: 'remote-bootstrap-worker', my: true,
        pos: position(10, 9, workRoom.name), room: workRoom, store,
        memory: { data, working: false }, spawning: false,
        goBoost: () => { calls.push('boost'); return false; },
        harvest: target => { calls.push(`harvest:${target.id}`); return 0; },
        pickup: target => { calls.push(`pickup:${target.id}`); return 0; },
        withdraw: target => { calls.push(`withdraw:${target.id}`); return 0; },
        build: target => { calls.push(`build:${target.id}`); return 0; },
        moveTo: target => { calls.push(`move:${target.id || target.name}`); return 0; },
        say: text => calls.push(`say:${text}`),
        getActiveBodyparts: part => part === 'work' || part === 'move' ? 1 : Math.ceil(capacity / 50),
    };
    game.creeps[creep.name] = creep;
    return { loader, creep, calls, game };
}

test('the local bootstrap builder harvests the nearest Source and eventually builds with carried energy', () => {
    const newRoom = room('newRoom');
    newRoom.sources.unshift({ id: 'far', energy: 3000, pos: position(40, 40) });
    const data = { sourceId: 'far' };
    const { loader, creep, calls } = workerWorld(newRoom, data);
    const behavior = loader.load('role/base/RoleBaseBuilder').default(data);
    assert.equal(behavior.source(creep), true);
    assert.equal(data.sourceId, 'newRoom-source');
    assert.deepEqual(calls, ['harvest:newRoom-source']);
    creep.store.energy = 50;
    assert.equal(behavior.source(creep), false);
    assert.equal(creep.memory.working, true);
    assert.equal(behavior.target(creep), true);
    assert.deepEqual(calls, ['harvest:newRoom-source', 'build:newRoom-spawn-site']);
});

test('ordinary mature builders keep withdrawing from their configured Storage', () => {
    const mature = room('mature');
    mature.storage = { id: 'storage', store: { energy: 1000 }, pos: position(10, 10) };
    const data = { sourceId: 'storage' };
    const { loader, creep, calls } = workerWorld(mature, data);
    loader.load('role/base/RoleBaseBuilder').default(data).source(creep);
    assert.deepEqual(calls, ['withdraw:storage']);
});

test('remote bootstrap workers travel by Source ID, skip boosts, harvest and prioritize the first Spawn', () => {
    const target = room('target', { spawn: false });
    target.constructionSites.unshift({ id: 'near-road', structureType: 'road', pos: position(10, 10) });
    const data = { sourceFlag: target.sources[0].id, targetFlag: target.sources[0].id, bootstrap: true };
    const { loader, creep, calls } = workerWorld(target, data);
    const behavior = loader.load('role/adv/RoleAdvRemoteBuilder').default(data);
    assert.equal(behavior.prepare(creep), true);
    assert.deepEqual(calls, [], 'bootstrap is independent of the home lab state');
    creep.room = room('home');
    assert.equal(behavior.source(creep), false);
    assert.deepEqual(calls, ['move:target-source']);
    creep.room = target;
    assert.equal(behavior.source(creep), true);
    assert.deepEqual(calls, ['move:target-source', 'harvest:target-source']);
    creep.store.energy = 50;
    creep.memory.working = true;
    assert.equal(behavior.target(creep), true);
    assert.deepEqual(calls, ['move:target-source', 'harvest:target-source', 'build:target-spawn-site']);
    assert.equal(loader.load('role/adv/RoleAdvRemoteBuilder').default({ sourceFlag: 'a', targetFlag: 'b' }).prepare(creep), false);
    assert.equal(calls.at(-1), 'boost', 'ordinary remote builder preparation stays unchanged');
});

test('bootstrap and ordinary remote builders both have affordable mobile native bodies at a low-level home', () => {
    const spawned = [];
    const loader = createSourceLoader({
        globals: { ...nativeBodies.globals, StructureSpawn: class {}, Game: { creeps: {}, getObjectById: () => null }, BODYPART_COST: bodyCosts, OK: 0 },
        modules: {
            ...nativeBodies.modules,
            'settings/creep': roles,
            role: { isRoleSupported: () => true },
            jssha: class {}, 'settings/settings': { colorEnum: {} },
        },
    });
    const Spawn = loader.load('mount/structure/SpawnExtension').default;
    const spawn = new Spawn();
    spawn.room = { energyAvailable: 300, energyCapacityAvailable: 300,
        memory: { creepConfig: { bootstrap: { role: 'rBuilder', data: { bootstrap: true } } }, creepSpawnQueue: ['bootstrap'] } };
    spawn.spawnCreep = (body, name) => { spawned.push({ body: Array.from(body), name }); return 0; };
    spawn.doWork();
    assert.equal(spawned.length, 1);
    assert.ok(spawned[0].body.reduce((cost, part) => cost + bodyCosts[part], 0) <= 300);
    assert.deepEqual([...new Set(spawned[0].body)].sort(), ['carry', 'move', 'work']);
    spawn.room.memory = { creepConfig: { ordinary: { role: 'rBuilder', data: {} } }, creepSpawnQueue: ['ordinary'] };
    spawn.doWork();
    assert.equal(spawned.length, 2, 'ordinary assistance can start before the home reaches 4450 capacity');
    assert.ok(spawned[1].body.includes('work') && spawned[1].body.includes('carry') && spawned[1].body.includes('move'));
    assert.deepEqual(spawn.room.memory.creepSpawnQueue, []);
});

test('claim flags are kept after success without renewing or repeating own-room claims', () => {
    const target = room('target', { spawn: false });
    const home = room('home');
    const { loader, game, demands } = populationWorld([home, target]);
    game.flags.home_CLAIM = { name: 'home_CLAIM', pos: position(10, 10, target.name) };
    loader.load('creep/remotePopulation').releaseJobsCreepConfig();
    assert.equal(demands.filter(item => item.role === 'claimer').length, 0);
    assert.ok(game.flags.home_CLAIM);

    const calls = [];
    const controller = { my: true, pos: position(10, 10, target.name), owner: { username: 'me' } };
    target.controller = controller;
    const claimLoader = createSourceLoader({
        globals: { Game: game, COLOR_PURPLE: 2, OK: 0 },
        modules: { 'settings/room': { roomSignTextList: ['sign'] }, utils: { getDistance: distance } },
    });
    const behavior = claimLoader.load('role/adv/RoleAdvClaimer').default({ targetFlag: 'home_CLAIM' });
    assert.equal(behavior.isNeed(home, ''), false);
    behavior.target({ room: target, pos: position(10, 9, target.name), owner: { username: 'me' }, claimController: () => calls.push('claim') });
    assert.deepEqual(calls, []);
    assert.ok(game.flags.home_CLAIM);
    target.my = false;
    assert.equal(behavior.isNeed(home, ''), true, 'the same human flag can be used after ownership is lost');
});


test('remote aid builders recycle loose energy and containers before nearby main storage or harvesting', () => {
    const target = room('target', { spawn: false });
    target.storage = { id: 'storage', my: true, store: { energy: 1000 }, pos: position(10, 10, target.name) };
    target.containers.push({ id: 'empty', store: { energy: 0 }, pos: position(10, 9, target.name) },
        { id: 'far-buffer', store: { energy: 1000 }, pos: position(40, 40, target.name) },
        { id: 'buffer', store: { energy: 1000 }, pos: position(12, 9, target.name) });
    target.droppedResource.push({ id: 'mineral', resourceType: 'power', amount: 50, pos: position(10, 9, target.name) },
        { id: 'empty-drop', resourceType: 'energy', amount: 0, pos: position(10, 9, target.name) },
        { id: 'energy', resourceType: 'energy', amount: 50, pos: position(13, 9, target.name) });
    const data = { sourceFlag: target.sources[0].id, targetFlag: target.sources[0].id, bootstrap: true };
    const { loader, creep, calls } = workerWorld(target, data);
    const behavior = loader.load('role/adv/RoleAdvRemoteBuilder').default(data);
    behavior.source(creep); assert.deepEqual(calls.splice(0), ['pickup:energy']);
    target.droppedResource = [];
    behavior.source(creep); assert.deepEqual(calls.splice(0), ['withdraw:buffer']);
    target.containers.forEach(container => container.store.energy = 0);
    behavior.source(creep); assert.deepEqual(calls.splice(0), ['withdraw:storage']);
    target.storage.store.energy = 0;
    behavior.source(creep); assert.deepEqual(calls, ['harvest:target-source']);
});

test('remote aid builders turn existing partial cargo into construction when a store or Source fails', () => {
    for (const mode of ['store', 'source']) {
        const target = room('target', { spawn: false });
        const data = { sourceFlag: target.sources[0].id, targetFlag: target.sources[0].id, bootstrap: true };
        if (mode === 'store') {
            target.sources[0].energy = 0;
            target.storage = { id: 'rejected-storage', my: true, store: { energy: 2000 }, pos: position(11, 9, target.name) };
        }
        const { loader, creep, calls } = workerWorld(target, data, { capacity: 800, energy: 80 });
        creep.withdraw = source => { calls.push(`withdraw:${source.id}`); return -7; };
        creep.harvest = source => { calls.push(`harvest:${source.id}`); return -6; };
        const behavior = loader.load('role/adv/RoleAdvRemoteBuilder').default(data);
        assert.equal(behavior.source(creep), false);
        assert.equal(creep.memory.working, true, mode);
        assert.equal(behavior.target(creep), true);
        assert.deepEqual(calls, [mode === 'store' ? 'withdraw:rejected-storage' : 'harvest:target-source', 'build:target-spawn-site']);
        assert.equal(creep.store.energy, 80, 'neither failed acquisition nor build intents fabricate a Store update');
    }
});

test('remote aid builders replace an out-of-range target whose movement fails with the next reachable candidate', () => {
    for (const mode of ['container', 'source']) {
        const target = room('target', { spawn: false });
        const first = mode === 'source' ? target.sources[0] : { id: 'blocked-container', store: { energy: 2000 }, pos: position(12, 9, target.name) };
        first.pos = position(12, 9, target.name);
        const next = mode === 'source' ? { id: 'reachable-source', energy: 3000, room: target, pos: position(14, 9, target.name) } :
            { id: 'reachable-container', store: { energy: 2000 }, pos: position(15, 9, target.name) };
        if (mode === 'source') target.sources.push(next);
        else target.containers.push(first, next);
        const data = { sourceFlag: target.sources[0].id, targetFlag: target.sources[0].id, bootstrap: true };
        const { loader, creep, calls } = workerWorld(target, data, { capacity: 800 });
        creep.withdraw = source => { calls.push(`withdraw:${source.id}`); return -9; };
        creep.harvest = source => { calls.push(`harvest:${source.id}`); return -9; };
        creep.moveTo = source => { calls.push(`move:${source.id}`); return source.id === first.id ? -2 : 0; };
        const behavior = loader.load('role/adv/RoleAdvRemoteBuilder').default(data);
        assert.equal(behavior.source(creep), true);
        const action = mode === 'source' ? 'harvest' : 'withdraw';
        assert.deepEqual(calls, [`${action}:${first.id}`, `move:${first.id}`, `${action}:${next.id}`, `move:${next.id}`]);
        assert.equal(creep.memory.working, false);
    }
});
