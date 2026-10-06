const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const nativeBodies = require('../helpers/native-bodies.cjs');

class Position {
    constructor(x, y, roomName) { Object.assign(this, { x, y, roomName }); }
    inRangeTo(target, range) {
        const other = target.pos || target;
        return this.roomName === other.roomName && Math.max(Math.abs(this.x - other.x), Math.abs(this.y - other.y)) <= range;
    }
    isNearTo(target) { return this.inRangeTo(target, 1); }
}

function store(energy, capacity = 800) {
    const value = { energy, getCapacity: () => capacity, getUsedCapacity: () => value.energy,
        getFreeCapacity: () => capacity - value.energy };
    return value;
}

function transitionWorld({ level = 8 } = {}) {
    const calls = [], created = new Map(), objects = new Map();
    const home = { name: 'E39N5', my: true, level, memory: { creepConfig: {} }, energyCapacityAvailable: 800, energyAvailable: 800,
        controller: { my: true, level, owner: { username: 'me' }, pos: new Position(20, 20, 'E39N5') },
        spawns: [], extensions: [], containers: [], links: [], towers: [], sources: [],
        getTerrain: () => ({ get: () => 0 }), lookForAt: () => [], find: () => [] };
    function structure(id, type, x, y, energy = 0, capacity = 800) {
        const value = { id, my: true, structureType: type, room: home, pos: new Position(x, y, home.name),
            store: store(energy, capacity), isActive: () => true };
        objects.set(id, value);
        return value;
    }
    const spawn = structure('spawn', 'spawn', 25, 25, 0, 300);
    spawn.recycleCreep = creep => { calls.push({ kind: 'recycle', name: creep.name }); return 0; };
    home.spawns.push(spawn);
    const source = { id: 'source', energy: 3000, energyCapacity: 3000, pos: new Position(10, 20, home.name) };
    home.sources.push(source); objects.set(source.id, source);
    const remoteSource = { id: 'remote-source', energy: 1500, pos: new Position(10, 20, 'E38N5') };
    objects.set(remoteSource.id, remoteSource);
    const remote = { name: 'E38N5', my: false, controller: { pos: new Position(20, 20, 'E38N5') }, sources: [remoteSource], find: () => [] };
    const memory = { warMode: {} };
    const game = { time: 100, shard: { name: 'shard1' }, rooms: { [home.name]: home, [remote.name]: remote }, creeps: {}, flags: {},
        getObjectById: id => objects.get(id) || null, cpu: { bucket: 5000, tickLimit: 100, getUsed: () => 0 } };
    home.memory.developmentRemotes = { candidates: [remote.name], selectedRooms: [remote.name],
        intel: { [remote.name]: { seenAt: game.time, status: 'safe', sources: [{ id: remoteSource.id, x: 10, y: 20 }] } } };

    function factory(role) {
        return data => {
            const behavior = { isNeed: () => true,
                prepare(creep) { calls.push({ kind: 'prepare', role, name: creep.name }); return true; },
                source(creep) { calls.push({ kind: 'source', role, name: creep.name }); return true; },
                target(creep) { calls.push({ kind: 'target', role, name: creep.name }); return true; } };
            created.set(role, behavior);
            return behavior;
        };
    }
    const modules = {
        ...nativeBodies.modules,
        'combat/missions': { runCombatUnits() {} },
        'combat/defense': { requestTowerSupport() {} },
        squard: {}, 'runtime/profiling': { isCpuProfilingEnabled: () => false, recordCpuSample() {} },
        'shard/workers': { createShardRole: kind => factory(`s${kind}`) },
        'shard/scouting': { createShardScoutRole: factory('sScout') },
        './demand': { addCreepConfig() { throw new Error('transition tests must not publish demand'); } },
    };
    const factories = {
        './adv/RoleAdvClaimer': 'claimer', './adv/RoleAdvManager': 'manager', './adv/RoleAdvProcesser': 'processer',
        './adv/RoleAdvRemoteBuilder': 'rBuilder', './adv/RoleAdvRemoteFiller': 'rFiller', './adv/RoleAdvRemoteHarvester': 'rHarvester',
        './adv/RoleAdvReserver': 'reserver', './base/RoleBaseBuilder': 'builder', './base/RoleBaseFiller': 'filler',
        './base/RoleBaseHarvester': 'harvester', './base/RoleBaseMiner': 'miner', './base/RoleBaseRepairer': 'repairer',
        './base/RoleBaseScout': 'scout', './base/RoleBaseUpgrader': 'upgrader', './war/RoleWarAttacker': 'attacker',
        './war/RoleWarControllerAttacker': 'cAttacker', './war/RoleWarDefender': 'defender',
        './war/RoleWarDefenderRanged': 'rdefender', './war/RoleWarDismantle': 'dismantler',
        './war/RoleWarHealer': 'healer', './war/RoleWarIntegrate': 'integrate',
    };
    for (const [path, role] of Object.entries(factories)) modules[path] = factory(role);
    const loader = createSourceLoader({ globals: {
        ...nativeBodies.globals,
        Game: game, Memory: memory, RoomPosition: Position, StructureLink: class {}, StructureSpawn: class {},
        RESOURCE_ENERGY: 'energy', WORK: 'work', CARRY: 'carry', MOVE: 'move', CLAIM: 'claim', TOUGH: 'tough',
        ATTACK: 'attack', RANGED_ATTACK: 'ranged_attack', HEAL: 'heal',
        STRUCTURE_LINK: 'link', STRUCTURE_ROAD: 'road', STRUCTURE_CONTAINER: 'container', STRUCTURE_RAMPART: 'rampart',
        STRUCTURE_INVADER_CORE: 'invaderCore', STRUCTURE_TOWER: 'tower',
        FIND_HOSTILE_STRUCTURES: 'hostile-structures', FIND_HOSTILE_CREEPS: 'hostiles',
        TERRAIN_MASK_WALL: 1, LOOK_STRUCTURES: 'structures', LOOK_CREEPS: 'creeps',
        TOWER_ENERGY_COST: 10, ERR_NOT_IN_RANGE: -9, ERR_NO_PATH: -2, OK: 0,
        BODYPART_COST: { work: 100, carry: 50, move: 50, claim: 600, tough: 10, attack: 80, ranged_attack: 150, heal: 250 },
        MAX_CREEP_SIZE: 50, CARRY_CAPACITY: 50, HARVEST_POWER: 2,
    }, modules });
    function unit(name, role, { room = home, work = 1, carry = 1, energy = 0, development = true,
        data = { sourceId: source.id }, x = 25, y = 25, spawning = false } = {}) {
        const creep = { name, room, pos: new Position(x, y, room.name), memory: { role, name, spawnRoom: home.name, working: false, data },
            spawning, hits: 100, hitsMax: 100, store: store(energy, 100), work, carry, transferCode: 0,
            getActiveBodyparts: part => part === 'work' ? creep.work : part === 'carry' ? creep.carry : 1,
            transfer(target) { calls.push({ kind: 'transfer', name, id: target.id }); return creep.transferCode; },
            moveTo(target, options) { calls.push({ kind: 'move', name, id: target.id, pos: { ...(target.pos || target) }, options }); return 0; },
            say() {} };
        if (development) creep.memory.development = { workParts: work };
        game.creeps[name] = creep;
        return creep;
    }
    function autoData(kind = 'harvester') {
        return { sourceId: remoteSource.id, targetRoom: remote.name,
            developmentRemote: { homeRoom: home.name, targetRoom: remote.name, kind, homePosition: { x: 25, y: 25 },
                source: { id: remoteSource.id, x: 10, y: 20 } } };
    }
    function link(id, x, y, energy = 800) {
        const Link = loader.load('mount/structure/LinkExtension').default;
        const value = Object.assign(new Link(), structure(id, 'link', x, y, energy));
        value.cooldown = 0;
        value.transferEnergy = target => { calls.push({ kind: 'link', from: id, to: target.id }); return 0; };
        home.links.push(value);
        return value;
    }
    return { home, remote, source, spawn, game, memory, calls, objects, loader, created, structure, unit, autoData, link,
        retire: loader.load('creep/developmentRetirement').retireDevelopmentCreep };
}

test('ordinary units do not read development state, while retained same-name legacy jobs keep running', () => {
    const w = transitionWorld();
    const ordinary = w.unit('ordinary', 'upgrader', { development: false });
    Object.defineProperty(w.game.rooms, ordinary.memory.spawnRoom, { get() { throw new Error('untagged creeps exit first'); }, configurable: true });
    assert.equal(w.retire(ordinary), false);
    Object.defineProperty(w.game.rooms, ordinary.memory.spawnRoom, { value: w.home, configurable: true });
    const continued = w.unit('legacy-name', 'harvester');
    w.home.memory.creepConfig[continued.name] = { role: 'harvester', data: continued.memory.data };
    assert.equal(w.retire(continued), false);
    assert.deepEqual(w.calls, []);
});

test('living builders survive missing catalogs, active demand and finished construction', () => {
    const w = transitionWorld({ level: 4 });
    const unit = w.unit('surplus-builder', 'builder');
    delete w.home.memory.creepConfig;
    assert.equal(w.retire(unit), false, 'a first population refresh has not happened');
    w.home.memory.creepConfig = { [unit.name]: { development: { workParts: 1 } } };
    assert.equal(w.retire(unit), false, 'the growth quota still needs this unit');
    w.home.memory.creepConfig = {};
    assert.equal(w.retire(unit), false);
    assert.deepEqual(w.calls, []);
});

test('a surplus development miner waits for a selected full-production successor to arrive before yielding its station', () => {
    const w = transitionWorld({ level: 3 });
    const old = w.unit('small-miner', 'harvester', { work: 2, x: 11, y: 20 });
    const replacement = w.unit('full-miner', 'harvester', { work: 5, x: 25, y: 25 });
    w.home.memory.creepConfig[replacement.name] = { role: 'harvester', data: replacement.memory.data, development: { workParts: 5 } };
    assert.equal(w.retire(old), false);
    replacement.pos = new Position(12, 20, w.home.name); replacement.spawning = true;
    assert.equal(w.retire(old), false);
    replacement.spawning = false; replacement.work = 4;
    assert.equal(w.retire(old), false);
    replacement.work = 5;
    replacement.memory.boostPlan = { steps: [{ resource: 'UO', parts: 5 }] };
    assert.equal(w.retire(old), false, 'a worker still waiting for its boost cannot take over actual production');
    replacement.memory.boostPlan.completed = true; old.memory.dontPullMe = true;
    assert.equal(w.retire(old), true, 'range-two physical arrival permits handover at a single occupied mining seat');
    assert.equal(old.memory.dontPullMe, false);
    assert.equal(w.calls.at(-1).id, w.spawn.id);
});

test('selected 4+1 effective WORK retires old 2-WORK miners without removing the one-WORK tail slot', () => {
    const w = transitionWorld({ level: 2 });
    const old = w.unit('old-two', 'harvester', { work: 2, x: 11, y: 20 });
    const main = w.unit('new-four', 'harvester', { work: 4, x: 12, y: 20 });
    const tail = w.unit('tail-one', 'harvester', { work: 1, x: 11, y: 21 });
    for (const unit of [main, tail]) w.home.memory.creepConfig[unit.name] = { role: 'harvester', data: { ...unit.memory.data }, development: { workParts: unit.work } };
    assert.equal(w.retire(old), true);
    assert.equal(w.retire(tail), false);
    main.memory.data.sourceId = 'other-mine'; w.calls.length = 0;
    assert.equal(w.retire(old), false, 'production at another Source cannot authorize retirement');
});

test('development retirement credits completed harvest boosts and regeneration capacity, never depleted energy', () => {
    const w = transitionWorld({ level: 4 });
    w.loader.globals.BOOSTS = { work: { XUHO2: { harvest: 7 } } };
    const old = w.unit('small', 'harvester', { work: 2, x: 11, y: 20 });
    const next = w.unit('boosted', 'harvester', { work: 1, x: 12, y: 20 });
    w.home.memory.creepConfig[next.name] = { role: 'harvester', data: next.memory.data, development: { workParts: 5 } };
    next.body = [{ type: 'work', hits: 100 }]; w.source.energy = 0;
    assert.equal(w.retire(old), false);
    next.body[0].boost = 'XUHO2'; assert.equal(w.retire(old), true);
    next.body[0].boost = undefined; next.work = 3; next.body = undefined;
    w.source.energyCapacity = 1500;
    assert.equal(w.retire(old), true, 'a smaller regeneration capacity needs only its sustainable WORK');
});

test('unselected development miners cannot retire each other and essential fillers keep working during growth', () => {
    const w = transitionWorld({ level: 4 });
    const a = w.unit('a', 'harvester', { work: 5, x: 11, y: 20 });
    const b = w.unit('b', 'harvester', { work: 5, x: 11, y: 21 });
    assert.equal(w.retire(a), false); assert.equal(w.retire(b), false);
    const filler = w.unit('filler', 'filler'); assert.equal(w.retire(filler), false);
});

test('one mining seat safely hands over to its affordable published quota without waiting for an impossible fifth WORK', () => {
    const w = transitionWorld({ level: 2 });
    w.home.energyCapacityAvailable = 550;
    const old = w.unit('old-two', 'harvester', { work: 2, x: 11, y: 20 });
    const next = w.unit('new-four', 'harvester', { work: 4, x: 13, y: 20 });
    w.home.memory.creepConfig[next.name] = { role: 'harvester', data: next.memory.data, development: { workParts: 4 } };
    assert.equal(w.retire(old), false, 'distant queued production must not remove live production');
    next.pos = new Position(12, 20, w.home.name);
    assert.equal(w.retire(old), true, 'the arrived four-WORK replacement covers the only published slot');
    assert.equal(w.calls.at(-1).id, w.spawn.id);
});

test('RCL8 mining continuity requires a full-WORK legacy successor physically at the same Source', () => {
    const w = transitionWorld();
    const retiring = w.unit('growth-miner', 'harvester', { work: 5, x: 11, y: 20 });
    assert.equal(w.retire(retiring), false);
    const successor = w.unit('legacy-miner', 'harvester', { work: 5, development: false, x: 11, y: 20 });
    w.home.memory.creepConfig[successor.name] = { role: 'harvester', data: successor.memory.data };
    successor.spawning = true;
    assert.equal(w.retire(retiring), false);
    successor.spawning = false; successor.work = 4;
    assert.equal(w.retire(retiring), false);
    successor.work = 5; successor.pos = new Position(25, 25, w.home.name);
    assert.equal(w.retire(retiring), false);
    successor.pos = new Position(11, 20, w.home.name); successor.memory.data = { sourceId: 'different-source' };
    assert.equal(w.retire(retiring), false);
    successor.memory.data = { sourceId: w.source.id };
    assert.equal(w.retire(retiring), true);
    assert.equal(w.calls.at(-1).kind, 'move');
    assert.equal(w.calls.at(-1).id, w.spawn.id);
});

test('a completed one-WORK T3 successor safely replaces a five-WORK growth miner at RCL8', () => {
    const w = transitionWorld();
    w.loader.globals.BOOSTS = { work: { XUHO2: { harvest: 7 } } };
    const retiring = w.unit('growth-miner', 'harvester', { work: 5, x: 11, y: 20 });
    const successor = w.unit('boosted-miner', 'harvester', { work: 1, development: false, x: 11, y: 20 });
    w.home.memory.creepConfig[successor.name] = { role: 'harvester', data: successor.memory.data };
    successor.body = [{ type: 'work', hits: 100 }];
    assert.equal(w.retire(retiring), false, 'pending one-WORK body does not yet cover production');
    successor.body[0].boost = 'XUHO2';
    assert.equal(w.retire(retiring), true, 'native boost effect counts toward actual source production');
});

test('RCL8 filling continuity waits for a living legacy hauler with active CARRY', () => {
    const w = transitionWorld();
    const retiring = w.unit('growth-filler', 'filler');
    const successor = w.unit('legacy-filler', 'filler', { development: false, carry: 0 });
    w.home.memory.creepConfig[successor.name] = { role: 'filler', data: successor.memory.data };
    assert.equal(w.retire(retiring), false);
    successor.carry = 2; successor.spawning = true;
    assert.equal(w.retire(retiring), false);
    successor.spawning = false; successor.room = w.remote;
    assert.equal(w.retire(retiring), false);
    successor.room = w.home;
    assert.equal(w.retire(retiring), true);
    assert.deepEqual(w.calls, [{ kind: 'recycle', name: retiring.name }]);
});

test('retiring nonessential growth workers return carried energy before recycling', () => {
    const w = transitionWorld();
    w.home.storage = w.structure('storage', 'storage', 15, 15, 500, 1000);
    const unit = w.unit('old-processer', 'processer', { energy: 50 });
    unit.transferCode = -9;
    assert.equal(w.retire(unit), true);
    assert.deepEqual(w.calls.map(call => call.kind), ['transfer', 'move']);
    assert.equal(w.calls[0].id, w.home.storage.id);
    unit.store.energy = 0; w.calls.length = 0;
    assert.equal(w.retire(unit), true);
    assert.deepEqual(w.calls, [{ kind: 'recycle', name: unit.name }]);
});

test('an unavailable or lost home does not claim a normal role has retired', () => {
    const w = transitionWorld();
    const unit = w.unit('growth-builder', 'builder');
    w.home.controller.my = false;
    assert.equal(w.retire(unit), false);
    delete w.game.rooms[w.home.name];
    assert.equal(w.retire(unit), false);
    assert.deepEqual(w.calls, []);
});

test('living development upgraders never return energy or recycle when budgets, catalogs or room stages change', () => {
    for (const level of [4, 8]) for (const energy of [0, 50]) {
        const w = transitionWorld({ level });
        const unit = w.unit('existing-upgrader', 'upgrader', { work: 20, energy });
        unit.memory.dontPullMe = true;
        for (const catalog of [undefined, {}, { [unit.name]: { role: 'upgrader', development: { workParts: 1 } } }]) {
            w.home.memory.creepConfig = catalog;
            assert.equal(w.retire(unit), false);
        }
        w.home.memory.fastUpgrade = false;
        w.home.memory.creepConfig = {};
        assert.equal(w.retire(unit), false);
        assert.equal(unit.memory.dontPullMe, true);
        assert.deepEqual(w.calls, []);
        Object.defineProperty(w.game.rooms, w.home.name, { get() { throw new Error('already-born upgraders do not consult retirement catalogs'); } });
        assert.equal(w.retire(unit), false);
    }
});

test('living local builders never return energy or recycle when catalogs or room stages change', () => {
    for (const level of [1, 4, 8]) for (const energy of [0, 50]) {
        const w = transitionWorld({ level });
        const unit = w.unit('existing-builder', 'builder', { work: 4, energy });
        unit.memory.dontPullMe = true;
        for (const catalog of [undefined, {}, { [unit.name]: { role: 'builder', development: { workParts: 1 } } }]) {
            w.home.memory.creepConfig = catalog;
            assert.equal(w.retire(unit), false);
        }
        w.home.memory.fastUpgrade = false;
        assert.equal(w.retire(unit), false);
        assert.equal(unit.memory.dontPullMe, true);
        assert.equal(unit.store.energy, energy);
        assert.deepEqual(w.calls, []);
        Object.defineProperty(w.game.rooms, w.home.name, { get() { throw new Error('paid-for builders must not consult retirement catalogs'); } });
        assert.equal(w.retire(unit), false);
    }
});

function controllerLinks(w) {
    w.home.centerLink = w.link('center', 12, 20, 0);
    w.home.controllerLink = w.link('controller', 18, 20, 0);
    return w.link('source-link', 10, 21);
}

test('development Links feed a real controller Link before the central storage Link', () => {
    const w = transitionWorld({ level: 6 });
    const source = controllerLinks(w);
    source.doWork();
    assert.deepEqual(w.calls, [{ kind: 'link', from: source.id, to: w.home.controllerLink.id }]);
    w.calls.length = 0;
    w.home.centerLink.store.energy = 700;
    w.home.centerLink.doWork();
    assert.deepEqual(w.calls, [{ kind: 'link', from: w.home.centerLink.id, to: w.home.controllerLink.id }]);
});

test('controller Link supply yields to emergency Spawn energy and never transfers to itself', () => {
    const w = transitionWorld({ level: 6 });
    const source = controllerLinks(w);
    w.home.energyAvailable = 299;
    source.doWork();
    assert.deepEqual(w.calls, [{ kind: 'link', from: source.id, to: w.home.centerLink.id }]);
    w.calls.length = 0; w.home.energyAvailable = 300;
    w.home.controllerLink.store.energy = 800;
    w.home.controllerLink.doWork();
    assert.deepEqual(w.calls, []);
});

test('full controller Links and inactive cooldowns preserve the original central dispatch fallback', () => {
    const w = transitionWorld({ level: 6 });
    const source = controllerLinks(w);
    w.home.controllerLink.store.energy = 800;
    source.doWork();
    assert.deepEqual(w.calls, [{ kind: 'link', from: source.id, to: w.home.centerLink.id }]);
    w.calls.length = 0; w.home.controllerLink.store.energy = 0; source.cooldown = 1;
    source.doWork();
    assert.deepEqual(w.calls, [{ kind: 'link', from: source.id, to: w.home.centerLink.id }]);
});

test('RCL8 Link dispatch keeps the legacy source-to-center route and never reads growth state', () => {
    const w = transitionWorld();
    const source = controllerLinks(w);
    Object.defineProperty(w.home.memory, 'fastUpgrade', { get() { throw new Error('RCL8 skips development state'); } });
    source.doWork();
    assert.deepEqual(w.calls, [{ kind: 'link', from: source.id, to: w.home.centerLink.id }]);
    w.calls.length = 0; source.store.energy = 500;
    source.doWork();
    assert.deepEqual(w.calls, [], 'legacy non-edge Links still wait until full');
    source.pos = new Position(1, 20, w.home.name);
    source.doWork();
    assert.deepEqual(w.calls, [{ kind: 'link', from: source.id, to: w.home.centerLink.id }]);
});

test('the real role registry wraps only valid automatic metadata and returns original manual behaviors', () => {
    const w = transitionWorld({ level: 4 });
    const registry = w.loader.load('role');
    const manual = registry.createRoleBehavior('rHarvester', { sourceId: w.source.id, targetRoom: w.remote.name });
    assert.equal(manual, w.created.get('rHarvester'));
    const invalid = registry.createRoleBehavior('rHarvester', { developmentRemote: { targetRoom: w.remote.name } });
    assert.equal(invalid, w.created.get('rHarvester'));
    const data = w.autoData();
    const automatic = registry.createRoleBehavior('rHarvester', data);
    assert.notEqual(automatic, w.created.get('rHarvester'));
    assert.notEqual(automatic.source, w.created.get('rHarvester').source, 'automatic mining executes its own continuous production phase');
    const unit = w.unit('automatic', 'rHarvester', { data });
    assert.equal(automatic.prepare(unit), false);
    assert.equal(w.calls.at(-1).kind, 'move');
    assert.equal(w.calls.at(-1).pos.roomName, w.remote.name);
    assert.equal(registry.createRoleBehavior('rAttacker', {}), undefined);
    assert.equal(registry.createRoleBehavior('missing', {}), undefined);
});

test('execution permits automatic remote safety preparation during war while manual remotes stay paused', () => {
    const w = transitionWorld({ level: 4 });
    const data = w.autoData();
    w.unit('automatic', 'rHarvester', { room: w.remote, data, x: 11, y: 20 });
    w.unit('manual', 'rHarvester', { room: w.remote, development: false });
    w.unit('filler', 'filler', { development: false });
    w.memory.warMode.E41N5 = true;
    w.loader.load('creep/execution').creepWorkController();
    assert.equal(w.calls.filter(call => call.kind === 'move' && call.name === 'automatic').length, 1);
    assert.equal(w.calls.find(call => call.kind === 'move' && call.name === 'automatic').pos.roomName, w.home.name);
    assert.ok(w.calls.every(call => call.name !== 'manual'));
    assert.ok(w.calls.some(call => call.kind === 'source' && call.name === 'filler'));
    assert.ok(w.calls.every(call => call.kind !== 'source' || call.name !== 'automatic'));
});

test('execution reuses surviving local builders through their ordinary role when construction resumes', () => {
    const w = transitionWorld();
    const builder = w.unit('surviving-builder', 'builder');
    w.home.constructionSites = [{ id: 'new-site', structureType: 'extension' }];
    w.unit('ordinary-filler', 'filler', { development: false });
    w.loader.load('creep/execution').creepWorkController();
    assert.ok(w.calls.some(call => call.kind === 'prepare' && call.name === builder.name));
    assert.ok(w.calls.some(call => call.kind === 'source' && call.name === builder.name));
    assert.ok(w.calls.every(call => !['recycle', 'transfer', 'move'].includes(call.kind) || call.name !== builder.name));
    assert.ok(w.calls.some(call => call.kind === 'source' && call.name === 'ordinary-filler'));
});

test('execution leaves finished builders at their current position without consuming or returning carried energy', () => {
    for (const level of [4, 8]) for (const energy of [0, 50]) {
        const w = transitionWorld({ level });
        const builder = w.unit('idle-builder', 'builder', { energy });
        builder.memory.working = true;
        builder.memory.dontPullMe = true;
        w.loader.load('creep/execution').creepWorkController();
        assert.deepEqual(w.calls, [], 'idle units must not prepare boosts, collect, move, transfer or recycle');
        assert.equal(builder.store.energy, energy);
        assert.equal(builder.pos.x, 25); assert.equal(builder.pos.y, 25);
        assert.equal(builder.memory.dontPullMe, false);
    }
});

test('RCL8 execution continues old development upgraders with carried energy through the mature role', () => {
    const w = transitionWorld();
    const unit = w.unit('surviving-upgrader', 'upgrader', { energy: 50 });
    unit.memory.working = true;
    w.loader.load('creep/execution').creepWorkController();
    assert.ok(w.calls.some(call => call.kind === 'prepare' && call.name === unit.name));
    assert.ok(w.calls.some(call => call.kind === 'target' && call.name === unit.name));
    assert.ok(w.calls.every(call => !['recycle', 'transfer', 'move'].includes(call.kind) || call.name !== unit.name));
    assert.equal(unit.store.energy, 50);
});

function recoveryQueue(w, sourceId = w.source.id) {
    w.home.memory.creepConfig = {
        extraMiner: { role: 'harvester', spawnPriority: 1, data: { sourceId: w.source.id } },
        firstUpgrader: { role: 'upgrader', spawnPriority: 1.5, data: { sourceId: w.source.id } },
        firstCarrier: { role: 'filler', spawnPriority: 2, data: { sourceId } },
    };
    return w.loader.load('creep/spawnQueue').buildSpawnQueue(w.home);
}

test('the first development carrier precedes added miners before a Source Container exists', () => {
    const w = transitionWorld({ level: 1 });
    w.unit('working-miner', 'harvester', { x: 11, y: 20 });
    assert.deepEqual(Array.from(recoveryQueue(w)), ['firstCarrier', 'extraMiner', 'firstUpgrader']);
    w.unit('working-filler', 'filler');
    assert.deepEqual(Array.from(recoveryQueue(w)), ['extraMiner', 'firstUpgrader', 'firstCarrier'],
        'an existing carrier stops the one-time recovery reorder');
});

test('the first development carrier also recognizes the mining Source own Container', () => {
    const w = transitionWorld({ level: 4 });
    w.unit('working-miner', 'harvester', { x: 11, y: 20 });
    const container = w.structure('source-container', 'container', 11, 20, 0, 2000);
    w.home.containers.push(container);
    assert.deepEqual(Array.from(recoveryQueue(w, container.id)), ['firstCarrier', 'extraMiner', 'firstUpgrader']);
    delete w.game.creeps['working-miner'];
    assert.equal(recoveryQueue(w, container.id)[0], 'extraMiner', 'without a miner, production recovery still wins');
});

test('RCL8 and disabled growth retain legacy carrier priority, including the old stocked-Container recovery', () => {
    const w = transitionWorld();
    w.unit('working-miner', 'harvester', { x: 11, y: 20 });
    Object.defineProperty(w.home.memory, 'fastUpgrade', { get() { throw new Error('RCL8 exits before growth Memory'); }, configurable: true });
    assert.deepEqual(Array.from(recoveryQueue(w)), ['extraMiner', 'firstUpgrader', 'firstCarrier']);
    const container = w.structure('source-container', 'container', 11, 20, 100, 2000);
    w.home.containers.push(container);
    assert.equal(recoveryQueue(w, container.id)[0], 'firstCarrier', 'the original stocked-container exception remains');
    Object.defineProperty(w.home.memory, 'fastUpgrade', { value: false, configurable: true });
    w.home.controller.level = 4; w.home.level = 4; w.home.containers = [];
    assert.deepEqual(Array.from(recoveryQueue(w)), ['extraMiner', 'firstUpgrader', 'firstCarrier']);
});

function queuedSpawn(w, configs) {
    const Spawn = w.loader.load('mount/structure/SpawnExtension').default;
    const spawn = new Spawn();
    spawn.room = w.home;
    spawn.spawnCreep = (body, name) => { w.calls.push({ kind: 'spawn', name, body: Array.from(body) }); return 0; };
    w.home.memory.creepConfig = configs;
    w.home.memory.creepSpawnQueue = Object.keys(configs);
    return spawn;
}

test('turning fastUpgrade off discards the stale growth queue before spawning an unmarked legacy job', () => {
    const w = transitionWorld({ level: 4 });
    w.home.memory.fastUpgrade = false;
    const spawn = queuedSpawn(w, {
        stale: { role: 'upgrader', name: `${w.home.name}_DEVELOP_UPGRADER_0`, data: { sourceId: w.source.id },
            development: { workParts: 4, stationary: true } },
        legacy: { role: 'filler', name: `${w.home.name}_FILLER_STORAGE_0`, data: { sourceId: w.source.id } },
    });
    spawn.doWork();
    assert.deepEqual(w.calls.filter(call => call.kind === 'spawn').map(call => call.name), ['legacy']);
    assert.deepEqual(w.home.memory.creepSpawnQueue, []);
});

test('a stale automatic remote queue consults the real role isNeed and cannot block a manual job', () => {
    for (const reason of ['deselected', 'retiring', 'malformed']) {
        const w = transitionWorld({ level: 4 });
        const data = w.autoData();
        if (reason === 'deselected') w.home.memory.developmentRemotes.selectedRooms = [];
        else if (reason === 'retiring') data.developmentRemote.retiring = true;
        else data.developmentRemote.kind = 'unknown';
        const spawn = queuedSpawn(w, {
            staleAutomatic: { role: 'rHarvester', name: 'automatic', data, development: { workParts: 5, stationary: true } },
            manual: { role: 'scout', name: 'manual-scout', data: { targetFlag: 'human-scout' } },
        });
        spawn.doWork();
        assert.deepEqual(w.calls.filter(call => call.kind === 'spawn').map(call => call.name), ['manual'], reason);
        assert.deepEqual(w.home.memory.creepSpawnQueue, [], reason);
    }
});

test('a still-selected automatic remote demand can spawn its explicitly affordable development body', () => {
    const w = transitionWorld({ level: 4 });
    const spawn = queuedSpawn(w, { automatic: { role: 'rHarvester', name: 'automatic', data: w.autoData(),
        development: { workParts: 5, stationary: true, maximumCost: 700 } } });
    spawn.doWork();
    const result = w.calls.find(call => call.kind === 'spawn');
    assert.equal(result.name, 'automatic');
    assert.equal(result.body.filter(part => part === 'work').length, 5);
    assert.equal(result.body.filter(part => part === 'move').length, 3);
    assert.deepEqual(w.home.memory.creepSpawnQueue, []);
});

test('population rebuilds manual tasks before automatic remotes and orders the combined queue once', () => {
    const calls = [], home = { my: true, memory: { creepConfig: { stale: {} } } };
    const addDemand = () => {};
    const memory = { creeps: { alive: {}, dead: {} } }, game = { time: 100, creeps: { alive: {} }, rooms: { home } };
    const loader = createSourceLoader({ globals: { Game: game, Memory: memory }, modules: {
        './basePopulation': { releaseBaseCreepConfig() { calls.push('base'); assert.deepEqual(Object.keys(home.memory.creepConfig), []); home.memory.creepConfig.base = {}; } },
        './remotePopulation': { releaseJobsCreepConfig() { calls.push('manual'); home.memory.creepConfig.manual = {}; } },
        './demand': { addCreepConfig: addDemand },
        './developmentRemotes': { releaseDevelopmentRemoteConfigs(publisher) { assert.equal(publisher, addDemand); calls.push('automatic'); assert.ok(home.memory.creepConfig.manual); home.memory.creepConfig.automatic = {}; } },
        'shard/controller': { releaseShardCreepConfig() { calls.push('shard'); } },
        './warPopulation': { releaseWarCreepConfig() { calls.push('war'); } },
        'combat/missions': { releaseCombatCreepConfigs() { calls.push('combat'); } },
        './spawnQueue': { orderCreepSpawnQueue() { calls.push('queue'); assert.ok(home.memory.creepConfig.automatic); } },
    } });
    loader.load('creep/population').creepNumberController();
    assert.deepEqual(calls, ['base', 'manual', 'automatic', 'shard', 'war', 'combat', 'queue']);
    assert.deepEqual(Object.keys(memory.creeps), ['alive']);
    game.time++;
    loader.load('creep/population').creepNumberController();
    assert.equal(calls.length, 7, 'growth integration keeps the original refresh interval');
});

test('healthy growth repairers remain alive for owned Ramparts across missing catalogs and RCL8', () => {
    for (const level of [4, 8]) for (const energy of [0, 50]) {
        const w = transitionWorld({ level });
        w.home.ramparts = [{ my: true, hits: 300000000, hitsMax: 300000000 }];
        const resident = w.unit('permanent-repairer', 'repairer', { energy });
        for (const catalog of [undefined, {}, { unrelated: { role: 'filler' } }]) {
            w.home.memory.creepConfig = catalog;
            assert.equal(w.retire(resident), false, `RCL${level}/energy=${energy}`);
        }
        assert.deepEqual(w.calls, [], 'no recycle, move or unload is issued to the retained worker');
    }
});

test('removed or foreign-only Ramparts restore ordinary growth repairer retirement', () => {
    for (const ramparts of [[], [{ my: false }]]) {
        const w = transitionWorld(); w.home.ramparts = [{ my: true }];
        const resident = w.unit('permanent-repairer', 'repairer');
        assert.equal(w.retire(resident), false);
        w.home.ramparts = ramparts;
        assert.equal(w.retire(resident), true);
        assert.equal(w.calls.filter(call => call.kind === 'recycle').length, 1);
    }
});

test('a permanently damaged growth repairer does not retain the Rampart worker slot', () => {
    for (const damage of ['work', 'carry']) {
        const w = transitionWorld(); w.home.ramparts = [{ my: true }];
        const resident = w.unit('damaged-repairer', 'repairer', { [damage]: 0 });
        assert.equal(w.retire(resident), true);
        assert.equal(w.calls.filter(call => call.kind === 'recycle').length, 1);
    }
});
