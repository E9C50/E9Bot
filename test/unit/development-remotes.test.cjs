const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world({ level = 3, capacity = 800, visible = true, unsafe, incomplete = false, pathLength = 10, swamp = false, road = false } = {}) {
    const calls = { routes: 0, paths: 0, published: [], moves: [], actions: [], delegated: 0, recycling: 0, sites: [] }, objects = new Map();
    class Position {
        constructor(x, y, roomName) { Object.assign(this, { x, y, roomName }); }
        isNearTo(object) { const pos = object.pos || object; return this.roomName === pos.roomName && Math.max(Math.abs(this.x - pos.x), Math.abs(this.y - pos.y)) <= 1; }
        isEqualTo(object) { const pos = object.pos || object; return this.roomName === pos.roomName && this.x === pos.x && this.y === pos.y; }
        inRangeTo(object, range) { const pos = object.pos || object; return this.roomName === pos.roomName && Math.max(Math.abs(this.x - pos.x), Math.abs(this.y - pos.y)) <= range; }
    }
    class Matrix { data = new Map(); set(x, y, value) { this.data.set(`${x}/${y}`, value); } get(x, y) { return this.data.get(`${x}/${y}`) || 0; } }
    const store = (energy, capacity = 1000) => ({ energy, getFreeCapacity: () => capacity - energy, getCapacity: () => capacity, getUsedCapacity: () => energy });
    const source = (id, x, roomName) => { const item = { id, pos: new Position(x, 25, roomName), energy: 3000 }; objects.set(id, item); return item; };
    const homeSource = source('home-source', 10, 'E39N5');
    const home = { name: 'E39N5', memory: { creepConfig: {} }, controller: { my: true, level, owner: { username: 'me' }, pos: new Position(20, 20, 'E39N5') },
        energyCapacityAvailable: capacity, sources: [homeSource], spawns: [], extensions: [], containers: [], links: [], constructionSites: [],
        getTerrain: () => ({ get: () => 0 }), lookForAt: () => [],
        find(type) { return type === 'sources' ? this.sources : []; } };
    const spawn = { id: 'spawn', my: true, room: home, owner: { username: 'me' }, pos: new Position(25, 25, home.name), store: store(0), recycleCreep: () => { calls.recycling++; return 0; } };
    home.spawns.push(spawn); objects.set(spawn.id, spawn);
    const target = { name: 'E38N5', memory: {}, controller: { my: false, pos: new Position(20, 20, 'E38N5') },
        sources: [source('remote-one', 10, 'E38N5'), source('remote-two', 40, 'E38N5')], structures: [], hostiles: [], containers: [], constructionSites: [], dropped: [],
        createConstructionSite(x, y, type) { calls.sites.push({ x, y, type }); return 0; },
        find(type) { return type === 'sources' ? this.sources : type === 'structures' || type === 'hostile-structures' ? this.structures : type === 'hostiles' ? this.hostiles : type === 'dropped' ? this.dropped : []; } };
    const path = Array.from({ length: pathLength }, (_, index) => new Position(index % 45 + 2, 15, index < pathLength / 2 ? home.name : target.name));
    if (road) for (const position of path) (position.roomName === home.name ? home : target).structures?.push({ structureType: 'road', pos: position });
    if (unsafe === 'owner') target.controller.owner = { username: 'other' };
    if (unsafe === 'reservation') target.controller.reservation = { username: 'other', ticksToEnd: 4000 };
    if (unsafe === 'core') target.structures.push({ structureType: 'invaderCore', pos: new Position(12, 12, target.name), ticksToDeploy: 100 });
    if (unsafe === 'tower') target.structures.push({ structureType: 'tower', pos: new Position(12, 12, target.name), isActive: () => true, store: store(100) });
    if (unsafe === 'hostile') target.hostiles.push({ getActiveBodyparts: part => part === 'work' ? 1 : 0 });
    home.structures = road ? path.filter(position => position.roomName === home.name).map(pos => ({ structureType: 'road', pos })) : [];
    home.find = function (type) { return type === 'sources' ? this.sources : type === 'structures' ? this.structures : []; };
    const harvester = { spawning: false, room: home, pos: new Position(10, 24, home.name), memory: { role: 'harvester', spawnRoom: home.name, data: { sourceId: homeSource.id } }, getActiveBodyparts: () => 2 };
    const filler = { spawning: false, room: home, pos: spawn.pos, memory: { role: 'filler', spawnRoom: home.name, data: {} }, getActiveBodyparts: () => 2 };
    const game = { time: 100, shard: { name: 'shard1' }, rooms: { [home.name]: home }, creeps: { harvester, filler }, flags: {},
        getObjectById: id => objects.get(id), cpu: { bucket: 5000, tickLimit: 500, getUsed: () => 0 },
        map: { describeExits: () => ({ 7: target.name }), getRoomStatus: () => ({ status: 'normal' }), getRoomTerrain: () => ({ get: () => swamp ? 2 : 0 }),
            findRoute(from, to) { calls.routes++; return [{ room: to, exit: 7 }]; } } };
    if (visible) game.rooms[target.name] = target;
    const memory = { warMode: {} };
    function addDemand(room, role, name, data) {
        calls.published.push({ role, name, data }); room.memory.creepConfig[name] = { role, data }; return name;
    }
    const loader = createSourceLoader({ globals: { Game: game, Memory: memory, RoomPosition: Position,
        PathFinder: { CostMatrix: Matrix, search(from, goal, options) { calls.paths++; assert.equal(options.maxRooms, 2); return { incomplete,
            path: path.map(position => new Position(position.x, position.y, position.roomName === target.name ? goal.pos.roomName : position.roomName)) }; } },
        FIND_SOURCES: 'sources', FIND_MINERALS: 'minerals', FIND_STRUCTURES: 'structures', FIND_HOSTILE_STRUCTURES: 'hostile-structures', FIND_HOSTILE_CREEPS: 'hostiles',
        FIND_DROPPED_RESOURCES: 'dropped', LOOK_STRUCTURES: 'look-structures', LOOK_CREEPS: 'look-creeps',
        STRUCTURE_INVADER_CORE: 'invaderCore', STRUCTURE_TOWER: 'tower', STRUCTURE_ROAD: 'road', STRUCTURE_RAMPART: 'rampart', STRUCTURE_CONTAINER: 'container', STRUCTURE_LINK: 'link',
        OBSTACLE_OBJECT_TYPES: ['spawn', 'tower', 'constructedWall'], ATTACK: 'attack', RANGED_ATTACK: 'ranged_attack', WORK: 'work', HEAL: 'heal',
        CARRY: 'carry', MOVE: 'move', BODYPART_COST: { carry: 50, move: 50 }, TERRAIN_MASK_WALL: 1, TERRAIN_MASK_SWAMP: 2,
        SOURCE_ENERGY_CAPACITY: 3000, SOURCE_ENERGY_NEUTRAL_CAPACITY: 1500, ENERGY_REGEN_TIME: 300, CONTAINER_DECAY: 5000, CONTROLLER_RESERVE_MAX: 5000,
        RESOURCE_ENERGY: 'energy', HARVEST_POWER: 2, CARRY_CAPACITY: 50, TOWER_ENERGY_COST: 10, ERR_NO_PATH: -2, ERR_NOT_IN_RANGE: -9, OK: 0, FIND_MY_CREEPS: 'my-creeps',
    }, modules: { 'settings/runtime': { runtimePolicy: { warModeScope: 'empire' } } } });
    const api = loader.load('creep/developmentRemotes');
    const policy = loader.load('settings/developmentRemotes').developmentRemotePolicy;
    function unit(data, room = home, { working = false, energy = 0, storeCapacity = 1000, x = 25, y = 25 } = {}) {
        return { name: 'automatic-unit', room, memory: { role: data.developmentRemote.kind === 'hauler' ? 'rFiller' : 'rHarvester', data, working },
            pos: new Position(x, y, room.name), store: store(energy, storeCapacity), moveTo(pos, options) { calls.moves.push({ pos: { ...(pos.pos || pos) }, options }); return 0; },
            transfer(target, resource) { calls.actions.push({ type: 'transfer', target, resource }); return 0; },
            harvest(target) { calls.actions.push({ type: 'harvest', target }); return 0; },
            withdraw(target, resource) { calls.actions.push({ type: 'withdraw', target, resource }); return 0; },
            pickup(target) { calls.actions.push({ type: 'pickup', target }); return 0; },
            drop(resource) { calls.actions.push({ type: 'drop', resource }); return 0; },
            build(target) { calls.actions.push({ type: 'build', target }); return 0; },
            repair(target) { calls.actions.push({ type: 'repair', target }); return 0; },
            reserveController(target) { calls.actions.push({ type: 'reserve', target }); return 0; },
            goBoost() { throw Error('Automatic workers must not wait for labs'); }, say() {} };
    }
    const behavior = { isNeed: () => true, prepare: () => { calls.delegated++; return true; }, source: () => { calls.delegated++; return true; }, target: () => { calls.delegated++; return true; } };
    return { api, loader, policy, game, memory, calls, home, target, objects, unit, behavior, Position, store,
        release() { api.releaseDevelopmentRemoteConfigs(addDemand); }, task(kind) { return calls.published.find(call => call.data.developmentRemote.kind === kind)?.data; } };
}

test('RCL8 preserves existing manual demand and does not create Memory, scan, profile, or publish automatic workers', () => {
    const w = world({ level: 8 }); const manual = { role: 'rHarvester', data: { sourceId: 'manual-source' } };
    w.home.memory.creepConfig.manual = manual;
    Object.defineProperty(w.game, 'cpu', { get() { throw new Error('RCL8 must not spend automatic remote CPU'); } });
    w.release(); assert.equal(w.home.memory.developmentRemotes, undefined);
    assert.equal(w.home.memory.creepConfig.manual, manual); assert.equal(w.calls.routes, 0); assert.equal(w.calls.paths, 0); assert.deepEqual(w.calls.published, []);
});

test('automatic mining respects both development switches and the per-room remote switch', () => {
    for (const disable of [w => { w.home.memory.fastUpgrade = false; },
        w => { w.loader.load('settings/development').developmentPolicy.enabled = false; },
        w => { w.policy.enabled = false; },
        w => { w.home.memory.developmentRemotes = { enabled: false }; }]) {
        const w = world(); disable(w);
        Object.defineProperty(w.game, 'cpu', { get() { throw Error('disabled growth must not plan'); } });
        w.release(); assert.equal(w.calls.published.length, 0); assert.equal(w.calls.paths, 0);
    }
});

test('mining waits for a productive local miner and a local filler rather than just published population', () => {
    for (const breakEconomy of [w => { delete w.game.creeps.filler; },
        w => { w.game.creeps.harvester.pos = new w.Position(25, 25, w.home.name); },
        w => { w.game.creeps.filler.spawning = true; },
        w => { w.game.creeps.filler.memory.spawnRoom = 'E41N5'; }]) {
        const w = world(); breakEconomy(w); w.release();
        assert.equal(w.calls.published.length, 0);
        assert.equal(w.home.memory.developmentRemotes.intel[w.target.name].status, 'safe', 'scouting intel can be kept while local economy recovers');
    }
});

test('route travel is persisted as round-trip ticks with swamp fatigue and roads overriding swamp', () => {
    for (const [options, expected] of [[{}, 20], [{ swamp: true }, 60], [{ swamp: true, road: true }, 20]]) {
        const w = world(options); w.release(); const source = w.home.memory.developmentRemotes.intel[w.target.name].sources[0];
        assert.equal(source.travelTicks, expected); assert.equal(source.energyPerTick, 5);
        assert.equal(w.home.memory.creepConfig[w.calls.published.find(call => call.role === 'rFiller').name].development.travelTicks, expected);
        w.game.time++; w.calls.published.length = 0; w.target.controller.reservation = { username: 'me', ticksToEnd: 1000 }; w.release();
        assert.equal(w.calls.paths, 2, 'a reservation change adjusts output without searching the same route again');
        assert.equal(source.energyPerTick, 10);
        assert.equal(w.home.memory.creepConfig[w.calls.published.find(call => call.role === 'reserver').name].development.maximumCost, 650);
    }
});

test('hauling demand splits measured source output into affordable bodies and bounds it to three carriers', () => {
    const w = world({ pathLength: 40, capacity: 800 }); w.release();
    const haulers = w.calls.published.filter(call => call.role === 'rFiller' && call.data.sourceFlag === 'remote-one');
    assert.equal(haulers.length, 2);
    for (const call of haulers) assert.equal(w.home.memory.creepConfig[call.name].development.carryParts, 6);
    w.game.time++; w.target.controller.reservation = { username: 'me', ticksToEnd: 1000 }; w.calls.published.length = 0; w.release();
    const reserved = w.calls.published.filter(call => call.role === 'rFiller' && call.data.sourceFlag === 'remote-one');
    assert.equal(reserved.length, 3); assert.equal(new Set(reserved.map(call => call.name)).size, 3);
    const distant = world({ pathLength: 200, capacity: 550 }); distant.release();
    const bounded = distant.calls.published.filter(call => call.role === 'rFiller' && call.data.sourceFlag === 'remote-one');
    assert.equal(bounded.length, 3);
    for (const call of bounded) assert.equal(distant.home.memory.creepConfig[call.name].development.carryParts, 5);
});

test('stationary automatic miners transfer and harvest in the same tick without waiting for old phase or lab logic', () => {
    const w = world(); w.release(); const data = w.task('harvester');
    const container = { id: 'source-container', structureType: 'container', pos: new w.Position(11, 25, w.target.name), store: w.store(0), hits: 200000, hitsMax: 250000 };
    w.target.containers.push(container); w.objects.set(container.id, container);
    const creep = w.unit(data, w.target, { x: 11, energy: 10, storeCapacity: 50, working: true });
    const behavior = w.api.withDevelopmentRemoteRole(data, w.behavior);
    assert.equal(behavior.prepare(creep), true); behavior.target(creep);
    assert.deepEqual(w.calls.actions.map(action => action.type), ['transfer', 'harvest']);
    assert.equal(w.calls.actions[0].target, container); assert.equal(creep.memory.working, false); assert.equal(w.calls.delegated, 0);
    assert.equal(creep.store.energy, 10, 'intent mocks preserve beginning-of-tick Store');
    w.calls.actions.length = 0; creep.store = w.store(50, 50); behavior.source(creep);
    assert.deepEqual(w.calls.actions.map(action => action.type), ['transfer'], 'a transfer intent has not already freed Store this tick');
});

test('automatic miners bootstrap and maintain their source container with one WORK action per tick', () => {
    const w = world(); w.release(); const data = w.task('harvester'), creep = w.unit(data, w.target, { x: 11, storeCapacity: 50 });
    const behavior = w.api.withDevelopmentRemoteRole(data, w.behavior); assert.equal(behavior.prepare(creep), true);
    behavior.source(creep); assert.deepEqual(w.calls.sites, [{ x: 11, y: 25, type: 'container' }]);
    assert.deepEqual(w.calls.actions.map(action => action.type), ['harvest']);
    w.calls.actions.length = 0; behavior.source(creep); assert.equal(w.calls.sites.length, 1, 'failed site placement is bounded by a retry interval');
    const site = { my: true, structureType: 'container', pos: creep.pos }; w.target.constructionSites.push(site); creep.store = w.store(10, 50);
    w.calls.actions.length = 0; behavior.source(creep); assert.deepEqual(w.calls.actions.map(action => action.type), ['build']);
    w.target.constructionSites.length = 0;
    const container = { structureType: 'container', pos: creep.pos, store: w.store(0), hits: 5000 }; w.target.containers.push(container);
    w.calls.actions.length = 0; behavior.source(creep); assert.deepEqual(w.calls.actions.map(action => action.type), ['repair']);
});

test('automatic carriers take only their source energy, retain valid container IDs, and ignore minerals and unrelated drops', () => {
    const w = world(); w.release(); const data = w.task('hauler'), creep = w.unit(data, w.target, { x: 11 });
    const container = { id: 'remote-buffer', structureType: 'container', pos: new w.Position(11, 25, w.target.name), store: { ...w.store(200), H: 500 } };
    w.target.containers.push(container); w.objects.set(container.id, container);
    w.target.dropped.push({ resourceType: 'H', amount: 100, pos: creep.pos }, { resourceType: 'energy', amount: 100, pos: w.target.sources[1].pos });
    const behavior = w.api.withDevelopmentRemoteRole(data, w.behavior); assert.equal(behavior.prepare(creep), true); behavior.source(creep);
    assert.deepEqual(w.calls.actions.map(action => [action.type, action.resource]), [['withdraw', 'energy']]);
    assert.equal(data.withdrawTarget, container.id); assert.equal(w.calls.delegated, 0);
    Object.defineProperty(w.target, 'containers', { get() { throw Error('valid withdrawal cache must avoid scanning containers'); } });
    w.calls.actions.length = 0; behavior.source(creep); assert.equal(w.calls.actions[0].target, container);
    w.target.dropped.push({ resourceType: 'energy', amount: 50, pos: creep.pos });
    w.calls.actions.length = 0; behavior.source(creep); assert.equal(w.calls.actions[0].type, 'pickup');
});

test('returning automatic carriers finish at adjacent Storage and keep controller delivery with local distributors', () => {
    const w = world(); w.release(); const data = w.task('hauler'), creep = w.unit(data, w.home, { working: true, energy: 200 });
    const controllerBuffer = { id: 'controller-buffer', structureType: 'container', pos: new w.Position(19, 20, w.home.name), store: w.store(0) };
    w.home.containers.push(controllerBuffer); w.home.storage = { id: 'storage', store: w.store(0), pos: creep.pos };
    const behavior = w.api.withDevelopmentRemoteRole(data, w.behavior); assert.equal(behavior.prepare(creep), true); behavior.target(creep);
    assert.equal(w.calls.actions[0].target, w.home.storage);
    w.home.spawns[0].store = w.store(1000); w.calls.actions.length = 0; behavior.target(creep);
    assert.equal(w.calls.actions[0].target, w.home.storage);
    controllerBuffer.store = w.store(1000); w.calls.actions.length = 0; behavior.target(creep);
    assert.equal(w.calls.actions[0].target, w.home.storage); assert.equal(w.calls.delegated, 0);
});

test('automatic reservers reserve safe controllers directly and inactive demand cannot respawn', () => {
    const w = world(); w.release(); const data = w.task('reserver'), creep = w.unit(data, w.target, { x: 20, y: 19 });
    const behavior = w.api.withDevelopmentRemoteRole(data, w.behavior); assert.equal(behavior.isNeed(w.home), true);
    assert.equal(behavior.prepare(creep), true); behavior.source(creep);
    assert.deepEqual(w.calls.actions.map(action => action.type), ['reserve']); assert.equal(w.calls.delegated, 0);
    w.home.memory.fastUpgrade = false; assert.equal(behavior.isNeed(w.home), false);
    assert.equal(behavior.prepare(creep), false); assert.equal(data.developmentRemote.retiring, true);
});

test('stale queued automatic tasks require the currently published matching config', () => {
    const w = world(); w.release(); const published = w.calls.published.find(call => call.role === 'rFiller');
    const behavior = w.api.withDevelopmentRemoteRole(published.data, w.behavior);
    assert.equal(behavior.isNeed(w.home, published.name), true);
    delete w.home.memory.creepConfig[published.name]; assert.equal(behavior.isNeed(w.home, published.name), false);
    w.home.memory.creepConfig[published.name] = { data: { ...published.data, developmentRemote: { ...published.data.developmentRemote, targetRoom: 'E39N4' } } };
    assert.equal(behavior.isNeed(w.home, published.name), false);
    w.home.memory.creepConfig[published.name].data = published.data;
    w.home.memory.developmentRemotes.intel[w.target.name].sources = [];
    assert.equal(behavior.isNeed(w.home, published.name), false, 'a selected room does not prove a Source omitted by a partial scan');
});

test('war-paused loaded automatic carriers unload safely after reaching their home room', () => {
    const w = world(); w.release(); const data = w.task('hauler'); w.game.time++; w.memory.warMode[w.home.name] = true;
    const remote = w.unit(data, w.target, { working: true, energy: 200 });
    const behavior = w.api.withDevelopmentRemoteRole(data, w.behavior); assert.equal(behavior.prepare(remote), false);
    assert.equal(w.calls.moves.at(-1).pos.roomName, w.home.name); assert.equal(w.calls.actions.length, 0);
    const home = w.unit(data, w.home, { working: true, energy: 200 }); assert.equal(behavior.prepare(home), false);
    assert.equal(w.calls.actions[0].type, 'transfer'); assert.equal(w.calls.actions[0].target, w.home.spawns[0]);
    assert.equal(w.calls.delegated, 0);
});

test('an inactive empty hauler already near home releases its old position lock without repeated movement', () => {
    const w = world(); w.release(); const data = w.task('hauler');
    w.target.controller.reservation = { username: 'other', ticksToEnd: 1000 };
    const creep = w.unit(data, w.home, { x: 24, y: 25 });
    creep.memory.dontPullMe = true;
    const behavior = w.api.withDevelopmentRemoteRole(data, w.behavior);
    for (let tick = 0; tick < 6; tick++) {
        w.game.time++;
        assert.equal(behavior.prepare(creep), false);
        assert.equal(creep.memory.dontPullMe, false);
    }
    assert.equal(w.calls.moves.length, 0);
    assert.equal(w.calls.actions.length, 0);
    assert.equal(w.calls.recycling, 0);
    assert.equal(w.calls.delegated, 0);
    assert.equal(data.developmentRemote.retiring, undefined, 'a temporary safety pause must not retire the carrier');
});

test('paused empty carriers already in home interior yield far from the Spawn without competing movement intents', () => {
    const w = world(); w.release(); const data = w.task('hauler');
    w.target.controller.reservation = { username: 'other', ticksToEnd: 1000 };
    const creep = w.unit(data, w.home, { x: 17, y: 29 }); creep.memory.dontPullMe = true;
    w.home.storage = { id: 'storage', pos: new w.Position(18, 30, w.home.name), store: w.store(0, 10000) };
    creep.moveTo = () => { throw Error('A paused empty carrier inside home must not reserve a BetterMove movement intent'); };
    const behavior = w.api.withDevelopmentRemoteRole(data, w.behavior);
    for (let tick = 0; tick < 20; tick++) {
        w.game.time++;
        assert.equal(behavior.prepare(creep), false);
        assert.equal(creep.memory.dontPullMe, false);
    }
    assert.equal(w.calls.moves.length, 0); assert.equal(w.calls.actions.length, 0);
    assert.equal(w.calls.recycling, 0); assert.equal(w.calls.delegated, 0);
    assert.equal(data.developmentRemote.retiring, undefined);
    assert.equal(w.home.memory.developmentRemotes.intel[w.target.name].status, 'blocked');
});

test('paused empty carriers on any home edge continue inward withdrawal and remain swappable', () => {
    for (const [x, y] of [[0, 25], [49, 25], [25, 0], [25, 49]]) {
        const w = world(); w.release(); const data = w.task('hauler'); w.game.time++;
        w.target.controller.reservation = { username: 'other', ticksToEnd: 1000 };
        const creep = w.unit(data, w.home, { x, y }), originalMove = creep.moveTo;
        creep.moveTo = function (...args) { originalMove.apply(this, args); this.memory.dontPullMe = true; return 0; };
        assert.equal(w.api.withDevelopmentRemoteRole(data, w.behavior).prepare(creep), false);
        assert.equal(w.calls.moves.length, 1);
        assert.deepEqual(w.calls.moves[0].pos, { x: 25, y: 25, roomName: w.home.name });
        assert.equal(creep.memory.dontPullMe, false);
        assert.equal(w.calls.delegated, 0);
    }
});

test('home war keeps the existing withdrawal movement even for a paused empty interior carrier', () => {
    const w = world(); w.release(); const data = w.task('hauler'); w.game.time++;
    w.memory.warMode[w.home.name] = true;
    const creep = w.unit(data, w.home, { x: 17, y: 29 });
    assert.equal(w.api.withDevelopmentRemoteRole(data, w.behavior).prepare(creep), false);
    assert.equal(w.calls.moves.length, 1);
    assert.deepEqual(w.calls.moves[0].pos, { x: 25, y: 25, roomName: w.home.name });
    assert.equal(creep.memory.dontPullMe, false);
});

test('homeward movement clears a lock set inside the BetterMove wrapper and preserves no-path feedback', () => {
    for (const code of [0, -2]) {
        const w = world(); w.release(); const data = w.task('hauler'); w.game.time++;
        w.target.controller.reservation = { username: 'other', ticksToEnd: 1000 };
        const creep = w.unit(data, w.target), originalMove = creep.moveTo, messages = [];
        creep.moveTo = function (...args) { originalMove.apply(this, args); this.memory.dontPullMe = true; return code; };
        creep.say = message => messages.push(message);
        const behavior = w.api.withDevelopmentRemoteRole(data, w.behavior);
        assert.equal(behavior.prepare(creep), false);
        assert.equal(creep.memory.dontPullMe, false);
        assert.equal(w.calls.moves.length, 1);
        assert.equal(w.calls.moves[0].pos.roomName, w.home.name);
        assert.equal(w.calls.moves[0].options.range, 1);
        assert.deepEqual(messages, code === -2 ? ['撤离无路'] : []);
        assert.equal(w.calls.delegated, 0);
    }
});

test('a blocked loaded hauler at home still deposits its cargo into Storage without early retirement', () => {
    const w = world(); w.release(); const data = w.task('hauler'); w.game.time++;
    w.target.controller.reservation = { username: 'other', ticksToEnd: 1000 };
    const creep = w.unit(data, w.home, { energy: 550, working: true });
    w.home.storage = { id: 'storage', pos: new w.Position(24, 25, w.home.name), store: w.store(0, 10000) };
    assert.equal(w.api.withDevelopmentRemoteRole(data, w.behavior).prepare(creep), false);
    assert.equal(w.calls.actions.length, 1);
    assert.equal(w.calls.actions[0].type, 'transfer');
    assert.equal(w.calls.actions[0].target, w.home.storage);
    assert.equal(creep.store.energy, 550, 'issuing the transfer must not predict this tick Store changes');
    assert.equal(w.calls.moves.length, 0);
    assert.equal(w.calls.recycling, 0);
    assert.equal(data.developmentRemote.retiring, undefined);
    assert.equal(w.calls.delegated, 0);
});

test('a low-level room scouts without flags but waits for capacity and a real local harvester before mining', () => {
    const w = world({ level: 2, capacity: 300, visible: false }); w.release();
    assert.deepEqual(w.calls.published.map(call => call.role), ['scout']); assert.deepEqual(w.game.flags, {});
    assert.equal(w.home.memory.creepConfig[w.calls.published[0].name].development.maximumCost, 50);
    const data = w.task('scout'), creep = w.unit(data); w.api.withDevelopmentRemoteRole(data, w.behavior).prepare(creep);
    assert.equal(w.calls.moves.at(-1).pos.roomName, w.target.name); assert.equal(w.calls.delegated, 0);
    const noHarvester = world(); delete noHarvester.game.creeps.harvester; noHarvester.release();
    assert.deepEqual(noHarvester.calls.published, [], 'a visible safe neighbor cannot bypass local economy recovery');
});

test('safe adjacent sources publish separate采运 demand and RCL3 reserver with body profile metadata', () => {
    const w = world(); w.release();
    assert.deepEqual(w.calls.published.map(call => call.role), ['rHarvester', 'rFiller', 'rHarvester', 'rFiller', 'reserver']);
    assert.equal(w.calls.paths, 2); assert.deepEqual(Array.from(w.home.memory.developmentRemotes.selectedRooms), [w.target.name]);
    for (const call of w.calls.published) {
        assert.equal(call.data.developmentRemote.homePosition.x, 25);
        if (call.role === 'rHarvester') assert.equal(w.home.memory.creepConfig[call.name].development.workParts, 5);
        if (call.role === 'rFiller') assert.equal(w.home.memory.creepConfig[call.name].development.maximumCost, 800);
    }
    assert.deepEqual(w.game.flags, {});
    const low = world({ level: 2, capacity: 550 }); low.release(); assert.ok(!low.calls.published.some(call => call.role === 'reserver'));
});

test('foreign owner, reservation, invading core, active tower and hostile miners never receive automatic mining or controller attacks', () => {
    for (const unsafe of ['owner', 'reservation', 'core', 'tower', 'hostile']) {
        const w = world({ unsafe }); w.release();
        assert.deepEqual(w.calls.published, [], unsafe); assert.equal(w.calls.paths, 0, unsafe);
        assert.equal(w.home.memory.developmentRemotes.intel[w.target.name].status, 'blocked', unsafe);
    }
});

test('manual OUT flags reserve targets globally and take precedence without modification', () => {
    const w = world(); w.game.flags.E41N5_OUT0 = { pos: { roomName: w.target.name } };
    const before = JSON.stringify(w.game.flags); w.release();
    assert.deepEqual(w.calls.published, []); assert.equal(w.calls.paths, 0); assert.equal(JSON.stringify(w.game.flags), before);
    const manual = { sourceId: 'manual' }; assert.equal(w.api.withDevelopmentRemoteRole(manual, w.behavior), w.behavior);
});

test('unreachable Source routes are bounded to two rooms and never activate a remote mine', () => {
    const w = world({ incomplete: true }); w.release();
    assert.deepEqual(w.calls.published, []); assert.equal(w.home.memory.developmentRemotes.intel[w.target.name].status, 'unreachable');
    const unavailable = world(); unavailable.game.map.findRoute = () => -2; unavailable.release();
    assert.deepEqual(unavailable.calls.published, []); assert.equal(unavailable.calls.paths, 0);
});

test('scanning respects bucket budget, while already validated demand and live movement continue', () => {
    const w = world(); w.release(); const data = w.task('harvester'), paths = w.calls.paths, routes = w.calls.routes;
    w.game.time++; w.game.cpu.bucket = 0; w.calls.published.length = 0; w.release();
    assert.equal(w.calls.paths, paths); assert.equal(w.calls.routes, routes); assert.ok(w.calls.published.some(call => call.role === 'rHarvester'));
    const creep = w.unit(data); assert.equal(w.api.withDevelopmentRemoteRole(data, w.behavior).prepare(creep), false);
    assert.equal(w.calls.moves.at(-1).pos.roomName, w.target.name);
});

test('source IDs without current vision use persistent coordinates and full haulers return to the persistent home position', () => {
    const w = world(); w.release(); const data = w.task('hauler'); delete w.game.rooms[w.target.name];
    w.objects.delete(data.sourceFlag);
    const empty = w.unit(data); w.api.withDevelopmentRemoteRole(data, w.behavior).prepare(empty);
    assert.deepEqual(w.calls.moves.at(-1).pos, { x: 10, y: 25, roomName: w.target.name }); assert.equal(w.calls.delegated, 0);
    const loaded = w.unit(data, { name: 'E39N4' }, { working: true, energy: 200 });
    w.api.withDevelopmentRemoteRole(data, w.behavior).prepare(loaded);
    assert.deepEqual(w.calls.moves.at(-1).pos, { x: 25, y: 25, roomName: w.home.name });
});

test('a new hostile reservation immediately withdraws workers before their original role can attack or harvest', () => {
    const w = world(); w.release(); const data = w.task('reserver'); w.game.time++;
    w.target.controller.reservation = { username: 'other', ticksToEnd: 1000 };
    const creep = w.unit(data, w.target); w.api.withDevelopmentRemoteRole(data, w.behavior).prepare(creep);
    assert.equal(w.calls.delegated, 0); assert.equal(w.calls.moves.at(-1).pos.roomName, w.home.name);
    assert.equal(w.home.memory.developmentRemotes.selectedRooms.length, 0);
});

test('automatic units retire at RCL8 while original manual roles retain their behavior', () => {
    const w = world(); w.release(); const data = w.task('harvester'); w.home.controller.level = 8;
    const remote = w.unit(data, w.target); w.api.withDevelopmentRemoteRole(data, w.behavior).prepare(remote);
    assert.equal(data.developmentRemote.retiring, true); assert.equal(w.calls.moves.at(-1).pos.roomName, w.home.name); assert.equal(w.calls.delegated, 0);
    const arrived = w.unit(data); w.api.withDevelopmentRemoteRole(data, w.behavior).prepare(arrived); assert.equal(w.calls.recycling, 1);
    assert.equal(w.api.withDevelopmentRemoteRole({ targetRoom: w.target.name }, w.behavior), w.behavior);
});

test('war scope pauses automatic demand and permits only homeward safety movement', () => {
    const w = world(); w.release(); const data = w.task('harvester'); w.game.time++;
    w.memory.warMode.E41N5 = true; w.calls.published.length = 0; w.release(); assert.deepEqual(w.calls.published, []);
    const creep = w.unit(data, w.target); w.api.withDevelopmentRemoteRole(data, w.behavior).prepare(creep);
    assert.equal(w.calls.delegated, 0); assert.equal(w.calls.moves.at(-1).pos.roomName, w.home.name);
});

test('invalid automatic metadata is ignored without breaking original role factories', () => {
    const w = world();
    for (const data of [null, {}, { developmentRemote: {} }, { developmentRemote: { homeRoom: 'E39N5', targetRoom: 'E38N5', kind: 'hauler', homePosition: null } }])
        assert.equal(w.api.isDevelopmentRemoteData(data), false);
});

test('a partially completed route budget can activate the proved Source without rescanning unproved Sources', () => {
    const w = world(); w.policy.maximumRouteChecksPerTick = 1; w.release();
    assert.equal(w.calls.paths, 1);
    assert.equal(w.home.memory.developmentRemotes.intel[w.target.name].sources.length, 1);
    assert.equal(w.calls.published.filter(call => call.role === 'rHarvester').length, 1);
    assert.equal(w.calls.published.filter(call => call.role === 'rFiller').length, 1);
});

test('per-home quotas select at most two neighbors and manual slots reduce the automatic allowance', () => {
    const w = world();
    const third = { ...w.target, name: 'E39N4', sources: [] }, fourth = { ...w.target, name: 'E39N6', sources: [] };
    for (const room of [third, fourth]) {
        room.sources = [{ id: `${room.name}-source`, pos: new w.Position(15, 20, room.name) }];
        w.objects.set(room.sources[0].id, room.sources[0]); w.game.rooms[room.name] = room;
    }
    w.game.map.describeExits = () => ({ 7: w.target.name, 1: third.name, 5: fourth.name });
    w.release(); assert.equal(w.home.memory.developmentRemotes.selectedRooms.length, 2); assert.equal(w.calls.paths, 4);
    const manual = world(); manual.game.flags.E39N5_OUT0 = { pos: { roomName: 'E41N5' } }; manual.release();
    assert.equal(manual.home.memory.developmentRemotes.selectedRooms.length, 1);
    manual.game.flags.E39N5_OUT1 = { pos: { roomName: 'E41N6' } }; manual.game.time++; manual.calls.published.length = 0; manual.release();
    assert.deepEqual(manual.calls.published, []); assert.equal(manual.home.memory.developmentRemotes.selectedRooms.length, 0);
});

test('expired unseen intel resumes scouting and removes mining demand until a new observation proves safety', () => {
    const w = world(); w.release(); delete w.game.rooms[w.target.name];
    w.game.time += w.policy.intelMaxAge; w.calls.published.length = 0; w.release();
    assert.deepEqual(w.calls.published.map(call => call.role), ['scout']);
    const data = w.task('scout'), creep = w.unit(data, w.target); w.game.rooms[w.target.name] = w.target;
    w.api.withDevelopmentRemoteRole(data, w.behavior).prepare(creep);
    assert.equal(w.home.memory.developmentRemotes.intel[w.target.name].status, 'safe');
});

test('new Spawn identities update live automatic hauler destinations while preserving their withdrawal cache', () => {
    const w = world(); w.release(); const call = w.calls.published.find(call => call.role === 'rFiller');
    const creep = w.unit(call.data); creep.memory.data.withdrawTarget = 'remember-container'; w.game.creeps[call.name] = creep;
    w.home.spawns[0] = { ...w.home.spawns[0], id: 'new-spawn', pos: new w.Position(26, 24, w.home.name) };
    w.game.time++; w.release();
    assert.equal(creep.memory.data.targetFlag, 'new-spawn'); assert.equal(creep.memory.data.developmentRemote.homePosition.x, 26);
    assert.equal(creep.memory.data.withdrawTarget, 'remember-container');
    const reached = w.unit(creep.memory.data, w.target); w.api.withDevelopmentRemoteRole(reached.memory.data, w.behavior).prepare(reached);
    assert.equal(reached.memory.data.withdrawTarget, undefined, 'an actually destroyed store ID is cleared before automatic logistics runs');
});
