const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

const costs = { work: 100, carry: 50, move: 50, claim: 600, tough: 10, attack: 80, ranged_attack: 150, heal: 250 };

function position(x, y, roomName = 'W1N1', freeSpaces = 8) {
    return { x, y, roomName,
        getFreeSpace: () => Array.from({ length: freeSpaces }, (_, index) => ({ x: x + index, y, roomName })),
        inRangeTo(target, range) { const other = target.pos || target; return Math.max(Math.abs(x - other.x), Math.abs(y - other.y)) <= range; },
    };
}

function store(energy = 0, capacity = 2000) {
    return { energy, getCapacity: () => capacity, getUsedCapacity: () => energy,
        getFreeCapacity: () => capacity - energy };
}

function structure(id, type, x, y, energy = 0, roomName = 'W1N1') {
    return { id, structureType: type, pos: position(x, y, roomName), store: store(energy), my: true, isActive: () => true };
}

function room({ level = 1, capacity = 300, sources = [[10, 10]], spawn = [20, 20] } = {}) {
    const result = { name: 'W1N1', my: true, level, energyCapacityAvailable: capacity, energyAvailable: capacity,
        memory: { creepConfig: {} }, controller: { my: true, level, pos: position(40, 40), ticksToDowngrade: 200000 },
        spawns: [structure('spawn', 'spawn', ...spawn)], containers: [], links: [], constructionSites: [], labs: [],
        wallsNeedRepair: [], mineral: { id: 'mineral', mineralAmount: 10000, pos: position(8, 8) },
        getTerrain: () => ({ get: () => 0 }), lookForAt: () => [],
    };
    result.sources = sources.map(([x, y], index) => ({ id: `source${index}`, energy: 3000, energyCapacity: 3000,
        pos: position(x, y), room: result }));
    return result;
}

function makeWorld(home, { creeps = {}, visibleSources = [], automaticHauling = true } = {}) {
    const objects = new Map([...home.sources, ...home.spawns, ...home.containers, ...home.links,
        home.storage, home.terminal, ...visibleSources].filter(Boolean).map(object => [object.id, object]));
    const game = { time: 100, shard: { name: 'shard1' }, rooms: { [home.name]: home }, creeps,
        getObjectById: id => objects.get(id) || null };
    const calls = [];
    let loader;
    const factory = role => data => ({ isNeed(target) {
        calls.push(role);
        if (role === 'manager') return target.storage !== undefined && (target.centerLink !== undefined || target.terminal !== undefined);
        if (role === 'processer') return target.level >= 7 && target.labs.length > 0;
        if (role === 'miner') return target.extractor !== undefined && target.mineral.mineralAmount > 0;
        if (role === 'builder') return target.constructionSites.length > 0;
        if (role === 'repairer') return target.storage !== undefined && target.storage.store.energy > 10000 && target.wallsNeedRepair.length > 0;
        return true;
    } });
    const factories = Object.fromEntries(['manager', 'processer', 'miner', 'harvester', 'filler', 'builder', 'upgrader', 'repairer'].map(role => [role, factory(role)]));
    const demand = {
        createCreepName: (role, name) => `${role.toUpperCase()}_${name}`,
        addCreepConfig(target, role, name, data) {
            const key = demand.createCreepName(role, name);
            target.memory.creepConfig[key] = { role, name, data, spawnRoom: target.name,
                spawnPriority: loader.load('settings/creep').spawnPriority[role] };
            return key;
        },
    };
    loader = createSourceLoader({ globals: {
        Game: game, Memory: { warMode: {} }, RESOURCE_ENERGY: 'energy', BODYPART_COST: costs,
        WORK: 'work', CARRY: 'carry', MOVE: 'move', CLAIM: 'claim', TOUGH: 'tough', ATTACK: 'attack',
        RANGED_ATTACK: 'ranged_attack', HEAL: 'heal', CARRY_CAPACITY: 50, HARVEST_POWER: 2,
        ENERGY_REGEN_TIME: 300, CREEP_SPAWN_TIME: 3, MAX_CREEP_SIZE: 50, BUILD_POWER: 5,
        STRUCTURE_ROAD: 'road', STRUCTURE_RAMPART: 'rampart', STRUCTURE_CONTAINER: 'container', STRUCTURE_LINK: 'link',
        TERRAIN_MASK_WALL: 1, LOOK_STRUCTURES: 'structures', LOOK_CREEPS: 'creeps',
    }, modules: { role: factories, './demand': demand } });
    if (automaticHauling) for (const source of home.sources) {
        if (!Object.values(creeps).some(creep => !creep.spawning && creep.memory.role === 'harvester' &&
            creep.room.name === home.name && creep.memory.data.sourceId === source.id &&
            Math.max(Math.abs(creep.pos.x - source.pos.x), Math.abs(creep.pos.y - source.pos.y)) <= 1)) continue;
        const distance = (first, second) => Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y));
        const buffer = [...home.links, ...home.containers].find(target => distance(target.pos, home.controller.pos) <= 3);
        const destination = buffer?.pos || home.storage?.pos || home.spawns[0].pos;
        const trip = Math.ceil((Math.max(distance(source.pos, home.spawns[0].pos), distance(source.pos, destination)) * 2 + 2) *
            loader.load('settings/development').developmentPolicy.hauling.travelMargin);
        const capacity = trip * source.energyCapacity / 300;
        const name = `fixture-hauler-${source.id}`;
        game.creeps[name] = { name, spawning: false, room: home, pos: source.pos,
            memory: { role: 'filler', name, spawnRoom: home.name, data: { sourceId: source.id, mineId: source.id } },
            store: store(0, capacity), getActiveBodyparts: part => part === 'carry' ? Math.ceil(capacity / 50) : 0 };
    }
    const api = loader.load('creep/basePopulation');
    return { loader, game, home, objects, calls, demand,
        policy: loader.load('settings/development').developmentPolicy,
        release() { home.memory.creepConfig = {}; api.releaseBaseCreepConfig(); return Object.values(home.memory.creepConfig); },
    };
}

function worker(home, { work = 5, role = 'harvester', source = home.sources[0], spawning = false,
    x = source.pos.x + 1, y = source.pos.y, ttl = 1000, name = 'legacyMiner', data } = {}) {
    return { name, memory: { role, name, spawnRoom: home.name, data: data || { sourceId: source.id } },
        room: home, pos: position(x, y), spawning, ticksToLive: ttl,
        body: [...Array(work).fill({ type: 'work', hits: 100 }), { type: 'carry', hits: 100 }, { type: 'move', hits: 100 }],
        getActiveBodyparts: part => part === 'work' ? work : part === 'carry' || part === 'move' ? 1 : 0 };
}

const byRole = (configs, role) => configs.filter(config => config.role === role);
const requestedWork = configs => configs.reduce((total, config) => total + config.development.workParts, 0);
const summary = configs => JSON.parse(JSON.stringify(configs.map(({ role, name, data }) => ({ role, name, data })).sort((a, b) => a.name.localeCompare(b.name))));

test('RCL1 with a Spawn publishes a Source-fed upgrader before any Container exists', () => {
    const home = room();
    const state = makeWorld(home);
    const configs = state.release();
    const upgraders = byRole(configs, 'upgrader');
    assert.equal(upgraders.length, 1);
    assert.equal(upgraders[0].data.sourceId, home.sources[0].id);
    assert.equal(upgraders[0].development.stationary, false);
    assert.equal(upgraders[0].development.workParts, 1);
    assert.equal(upgraders[0].spawnPriority, state.policy.upgrading.firstCreepPriority);
    assert.ok(byRole(configs, 'harvester').length > 0);
    assert.ok(byRole(configs, 'filler').length > 0);
    assert.deepEqual(state.calls, [], 'the real developing-room branch bypasses legacy factories');
});

test('empty regenerating Sources retain the same development mining demand', () => {
    const home = room({ capacity: 700 });
    const state = makeWorld(home);
    const active = summary(byRole(state.release(), 'harvester'));
    home.sources[0].energy = 0;
    home.sources[0].ticksToRegeneration = 100;
    assert.deepEqual(summary(byRole(state.release(), 'harvester')), active);
});

test('RCL6 custom boosts publish one native mineral mover before selecting boosted economy bodies', () => {
    const home = room({ level: 6, capacity: 2300 });
    home.storage = structure('storage', 'storage', 20, 20, 20000);
    home.labs = [structure('lab', 'lab', 24, 24)];
    const state = makeWorld(home);
    assert.equal(byRole(state.release(), 'processer').length, 0, 'ordinary growth does not add a lab mover');
    home.memory.bodyProfiles = { upgrader: { boostTier: 2 } };
    const processors = byRole(state.release(), 'processer');
    assert.equal(processors.length, 1);
    assert.equal(processors[0].name, 'W1N1_PROCESSER');
    assert.equal(processors[0].bodyProfile.boostTier, 0, 'the only mineral mover must not depend on its own delivery');
    home.memory.bodyProfiles = {}; state.loader.load('settings/bodyPolicy').bodyPolicy.profiles.upgrader = { boostTier: 3 };
    assert.equal(byRole(state.release(), 'processer').length, 1, 'global role policy also prepares RCL6 logistics');
});

test('550 and 700 capacity split the 5-WORK mining quota into affordable bodies', () => {
    for (const [capacity, expected] of [[300, [2, 2, 1]], [550, [4, 1]], [700, [5]]]) {
        const home = room({ capacity });
        const state = makeWorld(home);
        const miners = byRole(state.release(), 'harvester');
        assert.deepEqual(miners.map(config => config.development.workParts), expected);
        for (const config of miners) {
            const body = state.loader.load('creep/developmentBodies').getDevelopmentBody(home, config);
            assert.equal(body.filter(part => part === 'work').length, config.development.workParts);
            assert.ok(body.reduce((sum, part) => sum + costs[part], 0) <= capacity);
        }
    }
});

test('small old miners yield their demand to a newly affordable full-source body', () => {
    const home = room({ capacity: 700 });
    const incumbent = worker(home, { work: 2 });
    const state = makeWorld(home, { creeps: { incumbent } });
    let miners = byRole(state.release(), 'harvester');
    assert.equal(miners.filter(config => config.name === incumbent.memory.name).length, 0);
    assert.deepEqual(miners.map(config => config.development.workParts), [5]);
    assert.deepEqual(Object.keys(incumbent.memory.development), [], 'old local miners now accept protected retirement');
    assert.deepEqual(summary(byRole(state.release(), 'harvester')), summary(miners));
    incumbent.getActiveBodyparts = part => part === 'work' ? 5 : 1;
    miners = byRole(state.release(), 'harvester');
    assert.equal(miners.length, 1);
    assert.equal(miners[0].name, incumbent.memory.name);
});

test('550-capacity mining consolidates old 2+2+1 workers into 4+1 and keeps the real one-WORK tail', () => {
    const home = room({ capacity: 550 });
    const first = worker(home, { work: 2, name: 'old-two-a' });
    const second = worker(home, { work: 2, name: 'old-two-b' });
    const tail = worker(home, { work: 1, name: 'old-one' });
    const state = makeWorld(home, { creeps: { first, second, tail } });
    const miners = byRole(state.release(), 'harvester');
    assert.deepEqual(miners.map(config => config.development.workParts), [4, 1]);
    assert.equal(miners[1].name, tail.memory.name);
    assert.ok(miners.every(config => config.name !== first.memory.name && config.name !== second.memory.name));
    assert.equal(state.game.creeps.first, first, 'publication does not stop or remove current production');
});

test('RCL3 full mining capacity replaces 4+1 with one five-WORK demand', () => {
    const home = room({ capacity: 800, level: 3 });
    const state = makeWorld(home, { creeps: {
        four: worker(home, { work: 4, name: 'old-four' }),
        one: worker(home, { work: 1, name: 'old-one' }),
    } });
    const miners = byRole(state.release(), 'harvester');
    assert.equal(miners.length, 1);
    assert.equal(miners[0].development.workParts, 5);
    assert.ok(miners[0].name.startsWith(`${home.name}_DEVELOP_HARVESTER_`));
});

test('one actually boosted WORK covers a Source and removes every smaller mining demand', () => {
    const home = room({ capacity: 550 });
    const boosted = worker(home, { work: 1, name: 'boosted' });
    boosted.body[0].boost = 'XUHO2';
    const state = makeWorld(home, { creeps: { boosted,
        redundant: worker(home, { work: 2, name: 'old-two' }) } });
    state.loader.globals.BOOSTS = { work: { XUHO2: { harvest: 7 } } };
    const miners = byRole(state.release(), 'harvester');
    assert.equal(miners.length, 1);
    assert.equal(miners[0].name, boosted.memory.name);
});

test('committed spawning harvest boosts prevent redundant future miners but do not create current income', () => {
    const home = room({ capacity: 550 });
    const pending = worker(home, { work: 1, name: 'pending', spawning: true });
    pending.memory.boostPlan = { tier: 3, steps: [{ resource: 'XUHO2', parts: 1 }] };
    const state = makeWorld(home, { creeps: { pending } });
    state.loader.globals.BOOSTS = { work: { XUHO2: { harvest: 7 } } };
    let configs = state.release();
    assert.equal(byRole(configs, 'harvester').length, 1);
    assert.equal(byRole(configs, 'harvester')[0].name, pending.memory.name);
    assert.equal(requestedWork(byRole(configs, 'upgrader')), state.policy.upgrading.minimumWorkParts);
    pending.memory.boostPlan.failed = true;
    configs = state.release();
    assert.equal(byRole(configs, 'harvester')[0].development.workParts, 4,
        'a failed compound plan cannot claim the missing mining capacity');
});

test('visible Source regeneration capacity sets the mining quota independently of current energy', () => {
    const home = room({ capacity: 800 });
    home.sources[0].energyCapacity = 1500; home.sources[0].energy = 0;
    const state = makeWorld(home);
    assert.deepEqual(byRole(state.release(), 'harvester').map(config => config.development.workParts), [3]);
});

test('spawning miners count toward future production but not current upgrade income', () => {
    const home = room({ capacity: 700 });
    const miner = worker(home, { spawning: true });
    const state = makeWorld(home, { creeps: { miner } });
    const configs = state.release();
    assert.equal(byRole(configs, 'harvester').length, 1);
    assert.equal(byRole(configs, 'harvester')[0].name, miner.memory.name);
    assert.equal(requestedWork(byRole(configs, 'upgrader')), 1);
});

test('a miner below the spawn-and-travel lead gets a replacement instead of reusing a dying name', () => {
    const home = room({ capacity: 700 });
    const dying = worker(home, { ttl: 5 });
    const state = makeWorld(home, { creeps: { dying } });
    const miners = byRole(state.release(), 'harvester');
    assert.equal(miners.length, 1);
    assert.notEqual(miners[0].name, dying.memory.name);
    assert.equal(miners[0].development.workParts, 5);
});

test('Source transport grows with the complete trip and remains bounded per Source and per body', () => {
    const close = makeWorld(room({ capacity: 700, sources: [[18, 18]] }));
    const far = makeWorld(room({ capacity: 700, sources: [[1, 1]], spawn: [48, 48] }));
    const nearFillers = byRole(close.release(), 'filler');
    const farFillers = byRole(far.release(), 'filler');
    assert.ok(farFillers[0].development.travelTicks > nearFillers[0].development.travelTicks);
    assert.ok(farFillers.reduce((sum, config) => sum + config.development.carryParts, 0) >
        nearFillers.reduce((sum, config) => sum + config.development.carryParts, 0));
    assert.equal(farFillers.length, far.policy.hauling.maximumCreepsPerSource);
    for (const config of farFillers) {
        assert.ok(config.development.carryParts <= far.policy.hauling.maximumCarryPartsPerCreep);
        assert.ok(config.development.carryParts * (costs.carry + costs.move) <= far.home.energyCapacityAvailable);
    }
});

test('built Source and controller Containers become the real hauling and stationary upgrade endpoints', () => {
    const home = room({ capacity: 1300, level: 4 });
    const sourceContainer = structure('source-container', 'container', 11, 10, 1500);
    const controllerContainer = structure('controller-container', 'container', 38, 40, 500);
    home.containers = [sourceContainer, controllerContainer];
    const miner = worker(home, { work: 5 });
    const state = makeWorld(home, { creeps: { miner } });
    const configs = state.release();
    for (const filler of byRole(configs, 'filler')) assert.equal(filler.data.sourceId, sourceContainer.id);
    const upgraders = byRole(configs, 'upgrader');
    assert.equal(requestedWork(upgraders), Math.floor(10 * state.policy.upgrading.incomeShare));
    assert.ok(upgraders.every(config => config.data.sourceId === controllerContainer.id && config.development.stationary));
    assert.equal(Object.hasOwn(home.memory, 'developmentRemotes'), false);
});

test('each local hauling fleet retains its mine identity beside the current Source or Container endpoint', () => {
    const home = room({ capacity: 1300, level: 4, sources: [[10, 10], [40, 10]] });
    const firstContainer = structure('left-container', 'container', 11, 10, 1500);
    const controllerContainer = structure('controller-container', 'container', 38, 40, 500);
    home.containers = [firstContainer, controllerContainer];
    const state = makeWorld(home);
    let configs = byRole(state.release(), 'filler');
    for (const source of home.sources) {
        const fleet = configs.filter(config => config.data.mineId === source.id);
        assert.ok(fleet.length > 0, 'both mines have an independent fleet');
        assert.ok(fleet.every(config => config.data.sourceId ===
            (source === home.sources[0] ? firstContainer.id : source.id)));
    }
    const rightContainer = structure('right-container', 'container', 39, 10, 2000);
    home.containers.push(rightContainer);
    configs = byRole(state.release(), 'filler');
    assert.ok(configs.filter(config => config.data.mineId === home.sources[1].id)
        .every(config => config.data.sourceId === rightContainer.id),
    'building a mine Container changes its endpoint without changing its assigned mine');
    home.storage = structure('storage', 'storage', 24, 24, 20000);
    configs = byRole(state.release(), 'filler');
    assert.ok(configs.filter(config => config.data.sourceId === home.storage.id)
        .every(config => config.data.mineId === undefined), 'Storage distribution is not assigned to a mine');
});

test('in-transit local miners and stored remote plans cannot inflate live controller input', () => {
    const home = room({ capacity: 1300, level: 4 });
    home.containers = [structure('controller-container', 'container', 38, 40, 500)];
    home.memory.developmentRemotes = { selectedRooms: ['W1N2'], intel: { W1N2: { sources: [{ id: 'remote-source' }] } } };
    const traveling = worker(home, { x: 20, y: 20 });
    const state = makeWorld(home, { creeps: { traveling } });
    assert.equal(requestedWork(byRole(state.release(), 'upgrader')), state.policy.upgrading.minimumWorkParts);
});

test('local upgrade income requires real serving carry capacity instead of an unspawned fleet', () => {
    const home = room({ capacity: 1300, level: 4 });
    home.containers = [structure('controller-container', 'container', 38, 40, 300)];
    const state = makeWorld(home, { creeps: { miner: worker(home) }, automaticHauling: false });
    let configs = state.release();
    assert.ok(byRole(configs, 'filler').length > 0);
    assert.equal(requestedWork(byRole(configs, 'upgrader')), 1);
    const trip = byRole(configs, 'filler')[0].development.travelTicks;
    const hauler = worker(home, { role: 'filler', work: 0, name: 'real-hauler', data: { sourceId: home.sources[0].id, mineId: home.sources[0].id } });
    hauler.store = store(0, trip * 4); state.game.creeps.hauler = hauler;
    assert.equal(requestedWork(byRole(state.release(), 'upgrader')), Math.floor(4 * state.policy.upgrading.incomeShare));
    hauler.store = store(0, trip * 10);
    assert.equal(requestedWork(byRole(state.release(), 'upgrader')), Math.floor(10 * state.policy.upgrading.incomeShare));
    hauler.spawning = true;
    assert.equal(requestedWork(byRole(state.release(), 'upgrader')), 1);
});

test('controller backlog increases WORK while source overflow is bounded by real spare transport', () => {
    const home = room({ capacity: 2300, level: 4 });
    const buffer = structure('controller-container', 'container', 38, 40, 300);
    const sourceContainer = structure('source-container', 'container', 11, 10, 0);
    home.containers = [buffer, sourceContainer];
    const state = makeWorld(home, { creeps: { miner: worker(home) } });
    const baseline = requestedWork(byRole(state.release(), 'upgrader'));
    buffer.store.energy = 2000;
    assert.equal(requestedWork(byRole(state.release(), 'upgrader')), baseline + 1);
    buffer.store.energy = 300;
    home.droppedResource = [{ id: 'overflow', pos: position(11, 10), amount: 6000, resourceType: 'energy' }];
    assert.equal(requestedWork(byRole(state.release(), 'upgrader')), baseline,
        'a pile cannot finance consumption beyond the fleet that can deliver it');
    const hauler = state.game.creeps['fixture-hauler-source0'];
    hauler.store = store(0, hauler.store.getCapacity() * 2);
    assert.equal(requestedWork(byRole(state.release(), 'upgrader')), baseline + 6);
    home.droppedResource[0].amount = 100000;
    assert.equal(requestedWork(byRole(state.release(), 'upgrader')), baseline + state.policy.upgrading.maximumBacklogWorkParts);
});

test('stable mine identity prevents one old fallback endpoint from financing both Source fleets', () => {
    const home = room({ capacity: 1300, level: 4, sources: [[10, 10], [40, 10]] });
    const leftContainer = structure('left-container', 'container', 11, 10, 1500);
    home.containers = [leftContainer, structure('controller-container', 'container', 38, 40, 300)];
    const hauler = worker(home, { role: 'filler', work: 0, name: 'right-hauler', data: {
        sourceId: leftContainer.id, mineId: home.sources[1].id,
    } });
    hauler.store = store(0, 400);
    hauler.memory.developmentHauler = { mineId: home.sources[0].id };
    const state = makeWorld(home, { automaticHauling: false, creeps: { hauler,
        first: worker(home, { source: home.sources[0], name: 'first' }),
        second: worker(home, { source: home.sources[1], name: 'second' }),
    } });
    const configs = state.release();
    const trip = byRole(configs, 'filler').find(config => config.data.mineId === home.sources[1].id).development.travelTicks;
    assert.equal(requestedWork(byRole(configs, 'upgrader')), Math.floor(400 / trip * state.policy.upgrading.incomeShare));
});

test('an active Source Link can fund a controller Link without pretending a local hauler exists', () => {
    const home = room({ capacity: 1300, level: 6 });
    const origin = structure('source-link', 'link', 11, 10, 0);
    const destination = structure('controller-link', 'link', 38, 40, 300);
    home.links = [origin, destination]; home.controllerLink = destination;
    const state = makeWorld(home, { creeps: { miner: worker(home) }, automaticHauling: false });
    assert.equal(requestedWork(byRole(state.release(), 'upgrader')), 8);
    origin.isActive = () => false;
    assert.equal(requestedWork(byRole(state.release(), 'upgrader')), 1);
});

test('remote upgrade income requires an arrived miner, a visible Source and a live serving hauler', () => {
    const home = room({ capacity: 1300, level: 4 });
    home.containers = [structure('controller-container', 'container', 38, 40, 500)];
    const remoteSource = { id: 'remote-source', pos: position(10, 10, 'W1N2'), energyCapacity: 1500 };
    const metadata = { homeRoom: home.name, targetRoom: 'W1N2', source: { id: remoteSource.id, x: 10, y: 10, travelTicks: 100 } };
    const miner = worker(home, { role: 'rHarvester', data: { developmentRemote: { ...metadata, kind: 'harvester' } } });
    miner.room = { name: 'W1N2' };
    miner.pos = position(11, 10, 'W1N2');
    const hauler = worker(home, { role: 'rFiller', work: 0, data: { developmentRemote: { ...metadata, kind: 'hauler' } } });
    hauler.getActiveBodyparts = part => part === 'carry' || part === 'move' ? 10 : 0;
    const state = makeWorld(home, { creeps: { miner }, visibleSources: [remoteSource] });
    home.memory.developmentRemotes = { selectedRooms: ['W1N2'], intel: {
        W1N2: { seenAt: 100, status: 'safe', sources: [metadata.source] },
    } };
    assert.equal(requestedWork(byRole(state.release(), 'upgrader')), 1, 'no hauler means no remote energy credit');
    state.game.creeps.hauler = hauler;
    assert.equal(requestedWork(byRole(state.release(), 'upgrader')), Math.floor(5 * state.policy.upgrading.incomeShare));
    home.memory.developmentRemotes.intel.W1N2.status = 'blocked';
    assert.equal(requestedWork(byRole(state.release(), 'upgrader')), 1, 'old living remote units cannot credit a blocked mine');
    home.memory.developmentRemotes.intel.W1N2.status = 'safe';
    hauler.spawning = true;
    assert.equal(requestedWork(byRole(state.release(), 'upgrader')), 1);
    hauler.spawning = false;
    hauler.getActiveBodyparts = part => part === 'carry' || part === 'move' ? 1 : 0;
    assert.equal(requestedWork(byRole(state.release(), 'upgrader')), 1, 'undersized real transport caps remote income');
    hauler.getActiveBodyparts = part => part === 'carry' || part === 'move' ? 10 : 0;
    state.objects.delete(remoteSource.id);
    assert.equal(requestedWork(byRole(state.release(), 'upgrader')), 1);
});

test('construction budgets lower sustainable upgrade WORK and use one worker for road-only jobs', () => {
    const home = room({ capacity: 1300, level: 4 });
    home.containers = [structure('controller-container', 'container', 38, 40, 500)];
    const state = makeWorld(home, { creeps: { miner: worker(home) } });
    const peaceful = requestedWork(byRole(state.release(), 'upgrader'));
    home.constructionSites = [{ id: 'extension-site', structureType: 'extension' }];
    let configs = state.release();
    assert.equal(byRole(configs, 'builder').length, 1);
    assert.equal(requestedWork(byRole(configs, 'builder')), 1, '10 energy per tick cannot sustain two 4-WORK builders');
    assert.equal(requestedWork(byRole(configs, 'upgrader')), Math.floor(10 * state.policy.upgrading.incomeShareWhileBuilding));
    assert.ok(requestedWork(byRole(configs, 'upgrader')) < peaceful);
    home.constructionSites = [{ id: 'road-site', structureType: 'road' }];
    configs = state.release();
    assert.equal(byRole(configs, 'builder').length, 1);
    assert.equal(byRole(configs, 'builder')[0].development.workParts, state.policy.building.roadOnlyWorkParts);
});

test('20 real energy per tick funds at most one construction WORK until Storage exceeds its reserve', () => {
    const home = room({ capacity: 2300, level: 4, sources: [[10, 10], [40, 10]] });
    home.containers = [structure('controller-container', 'container', 38, 40, 1000)];
    home.constructionSites = [{ id: 'extension-site', structureType: 'extension' }];
    const state = makeWorld(home, { creeps: {
        firstMiner: worker(home, { source: home.sources[0], name: 'firstMiner' }),
        secondMiner: worker(home, { source: home.sources[1], name: 'secondMiner' }),
    } });
    let builders = byRole(state.release(), 'builder');
    assert.equal(requestedWork(builders), 1);
    home.storage = structure('storage', 'storage', 24, 24, state.policy.upgrading.storageReserve);
    builders = byRole(state.release(), 'builder');
    assert.equal(requestedWork(builders), 1, 'the operational reserve cannot be allocated to construction');
    home.storage.store.energy = state.policy.upgrading.storageReserve + 1;
    builders = byRole(state.release(), 'builder');
    assert.equal(requestedWork(builders), 8);
    assert.ok(builders.length <= 2);
    home.constructionSites = [{ id: 'road-site', structureType: 'road' }];
    builders = byRole(state.release(), 'builder');
    assert.ok(builders.length > 0 && builders.length <= 2);
    assert.ok(builders.every(config => config.development.workParts === 1));
    assert.ok(requestedWork(builders) <= 2);
});

test('high-stock Storage transport covers its bonus upgrade rate or stops at the configured fleet capacity', () => {
    for (const capacity of [2300, 300]) {
        const home = room({ capacity, level: 4 });
        home.storage = structure('storage', 'storage', 1, 1, 100000);
        home.containers = [structure('controller-container', 'container', 38, 40, 1000)];
        const state = makeWorld(home);
        const carriers = byRole(state.release(), 'filler').filter(config => config.data.sourceId === home.storage.id);
        const trip = carriers[0].development.travelTicks;
        const burst = state.policy.upgrading.maximumBonusWorkParts;
        const wanted = Math.ceil(trip * burst / 50);
        const bodyLimit = Math.min(state.policy.hauling.maximumCarryPartsPerCreep, Math.floor(capacity / 100));
        const fleetLimit = bodyLimit * state.policy.hauling.maximumCreepsPerSource;
        const carry = carriers.reduce((sum, config) => sum + config.development.carryParts, 0);
        assert.equal(carry, Math.min(wanted, fleetLimit));
        assert.ok(carriers.length <= state.policy.hauling.maximumCreepsPerSource);
        assert.ok(carriers.every(config => config.development.carryParts <= bodyLimit));
        if (wanted <= fleetLimit) assert.ok(carry * 50 / trip >= burst);
    }
});

test('development Storage hubs publish one legacy-name manager for either a center Link or Terminal', () => {
    for (const infrastructure of ['center', 'terminal', 'both', 'none']) {
        const home = room({ capacity: 1300, level: 5 });
        home.storage = structure('storage', 'storage', 24, 24, 100000);
        if (infrastructure === 'center' || infrastructure === 'both') home.centerLink = structure('center-link', 'link', 24, 25);
        if (infrastructure === 'terminal' || infrastructure === 'both') home.terminal = structure('terminal', 'terminal', 25, 24);
        const state = makeWorld(home);
        const managers = byRole(state.release(), 'manager');
        assert.equal(managers.length, infrastructure === 'none' ? 0 : 1);
        if (managers.length) {
            assert.equal(managers[0].name, `${home.name}_MANAGER`);
            assert.equal(managers[0].development.carryParts, 4);
            assert.equal(managers[0].development.stationary, true);
        }
    }
});

test('development adopts old local consumers and assigns retained upgraders their actual current quota', () => {
    const home = room({ capacity: 1300, level: 4 });
    home.containers = [structure('controller-container', 'container', 38, 40, 1000)];
    const oldBuilder = worker(home, { role: 'builder', name: 'oldBuilder', work: 4 });
    const oldUpgrader = worker(home, { role: 'upgrader', name: 'oldUpgrader', work: 20 });
    oldUpgrader.name = 'UPGRADER_oldUpgrader';
    const visitor = worker(home, { role: 'builder', name: 'visitor', work: 4 });
    visitor.memory.spawnRoom = 'W2N1';
    const state = makeWorld(home, { creeps: { oldBuilder, [oldUpgrader.name]: oldUpgrader, visitor } });
    const configs = state.release();
    assert.deepEqual(Object.keys(oldBuilder.memory.development), []);
    assert.deepEqual(Object.keys(oldUpgrader.memory.development), []);
    assert.equal(visitor.memory.development, undefined);
    assert.ok(configs.every(config => config.name !== oldBuilder.memory.name), 'unselected adopted builders can retire');
    assert.equal(byRole(configs, 'upgrader').find(config => config.name === oldUpgrader.memory.name).development.workParts, 1);
});

test('development duty-cycle limits an existing 4-WORK builder and 20-WORK upgrader to their new quotas', () => {
    const home = room({ level: 4 });
    const state = makeWorld(home);
    const allowed = state.loader.load('creep/development').developmentWorkAllowed;
    for (const [role, work, quota] of [['builder', 4, 1], ['upgrader', 20, 1], ['upgrader', 20, 6]]) {
        const unit = worker(home, { role, work, name: `${role}-${quota}` });
        home.memory.creepConfig[unit.name] = { development: { workParts: quota } };
        const before = JSON.stringify(home.memory);
        let actions = 0;
        for (let tick = 0; tick < work * 2; tick++) { state.game.time = tick; if (allowed(unit)) actions++; }
        assert.equal(actions, quota * 2);
        assert.equal(JSON.stringify(home.memory), before, 'budget scheduling does not persist timing credits');
    }
});

test('development duty-cycle floors fractional quotas and safely handles unavailable catalogs', () => {
    const home = room({ level: 4 });
    const state = makeWorld(home);
    const allowed = state.loader.load('creep/development').developmentWorkAllowed;
    const unit = worker(home, { role: 'builder', work: 4 });
    home.memory.creepConfig[unit.name] = { development: { workParts: 1.9 } };
    let actions = 0;
    for (let tick = 0; tick < 4; tick++) { state.game.time = tick; if (allowed(unit)) actions++; }
    assert.equal(actions, 1);
    home.memory.creepConfig[unit.name].development.workParts = NaN;
    assert.equal(allowed(unit), true);
    delete home.memory.creepConfig;
    assert.equal(allowed(unit), true);
});

test('development duty-cycle exits for RCL8 and disabled growth before reading catalog or active parts', () => {
    for (const level of [8, 4]) {
        const home = room({ level });
        if (level === 4) home.memory.fastUpgrade = false;
        const state = makeWorld(home);
        const unit = worker(home, { role: 'builder', work: 4 });
        const allowed = state.loader.load('creep/development').developmentWorkAllowed;
        Object.defineProperty(home.memory, 'creepConfig', { get() { throw new Error('legacy catalog must not be inspected'); } });
        unit.getActiveBodyparts = () => { throw new Error('legacy bodies must not be inspected'); };
        assert.equal(allowed(unit), true);
    }
});

function growingUpgradeWorld({ ttl = 1000 } = {}) {
    const home = room({ capacity: 2300, level: 4, sources: [[10, 10], [40, 10]] });
    home.containers = [structure('controller-container', 'container', 38, 40, 1000)];
    const upgradeName = `${home.name}_DEVELOP_UPGRADER_0`;
    const upgrader = worker(home, { role: 'upgrader', work: 1, x: 39, y: 40, ttl, name: upgradeName,
        data: { sourceId: 'controller-container' } });
    upgrader.memory.development = { workParts: 1, stationary: true };
    const state = makeWorld(home, { creeps: {
        firstMiner: worker(home, { source: home.sources[0], name: 'firstMiner' }),
        secondMiner: worker(home, { source: home.sources[1], name: 'secondMiner' }),
        [`UPGRADER_${upgradeName}`]: upgrader,
    } });
    return { state, upgrader };
}

test('a surviving 1-WORK bootstrap upgrader does not occupy a newly affordable 16-WORK quota', () => {
    const { state, upgrader } = growingUpgradeWorld();
    const upgraders = byRole(state.release(), 'upgrader');
    assert.equal(upgraders.filter(config => config.name === upgrader.memory.name).length, 1);
    const additional = upgraders.filter(config => !state.game.creeps[state.demand.createCreepName(config.role, config.name)]);
    assert.equal(additional.reduce((total, config) => total + config.development.workParts, 0), 16,
        'the two arrived Sources supply 17 upgrade WORK including the real existing 1-WORK unit');
    assert.ok(upgraders.length <= state.policy.upgrading.maximumCreeps);
});

test('a bootstrap upgrader inside its replacement lead cannot block the new 17-WORK upgrade budget', () => {
    const { state, upgrader } = growingUpgradeWorld({ ttl: 1 });
    const upgraders = byRole(state.release(), 'upgrader');
    assert.ok(upgraders.every(config => config.name !== upgrader.memory.name));
    const replacement = upgraders.filter(config => !state.game.creeps[state.demand.createCreepName(config.role, config.name)]);
    assert.equal(replacement.reduce((total, config) => total + config.development.workParts, 0), 17);
    assert.ok(upgraders.length <= state.policy.upgrading.maximumCreeps);
});

test('four old two-WORK upgraders leave an expansion slot for a genuinely larger affordable body', () => {
    const home = room({ capacity: 550, level: 2, sources: [[10, 10], [40, 10]] });
    home.containers = [structure('controller-container', 'container', 38, 40, 1000)];
    home.getTerrain = () => ({ get: (x, y) => x === 39 && y >= 39 && y <= 41 || x === 38 && y === 40 ? 0 : 1 });
    const creeps = { firstMiner: worker(home, { source: home.sources[0], name: 'first-miner' }),
        secondMiner: worker(home, { source: home.sources[1], name: 'second-miner' }) };
    for (let index = 0; index < 4; index++) {
        const name = `${home.name}_DEVELOP_UPGRADER_${index}`;
        const old = worker(home, { role: 'upgrader', work: 2, name, x: 39, y: 40 });
        old.name = `UPGRADER_${name}`; creeps[old.name] = old;
    }
    const state = makeWorld(home, { creeps });
    const upgrades = byRole(state.release(), 'upgrader');
    assert.equal(upgrades.length, 4, 'the actual four-seat geometry is full');
    const additions = upgrades.filter(config => !state.game.creeps[state.demand.createCreepName(config.role, config.name)]);
    assert.equal(additions.length, 1);
    assert.equal(additions[0].development.workParts, 4);
    assert.equal(requestedWork(upgrades), 10);
    const body = state.loader.load('creep/developmentBodies').getDevelopmentBody(home, additions[0]);
    assert.equal(body.filter(part => part === 'work').length, 4);
    assert.ok(body.reduce((sum, part) => sum + costs[part], 0) <= home.energyCapacityAvailable);
});

test('successive small-upgrader replacements reach the full four-body throughput instead of oscillating', () => {
    const home = room({ capacity: 550, level: 2, sources: [[10, 10], [40, 10]] });
    const buffer = structure('controller-container', 'container', 38, 40, 1000);
    home.containers = [buffer];
    home.getTerrain = () => ({ get: (x, y) => x === 39 && y >= 39 && y <= 41 || x === 38 && y === 40 ? 0 : 1 });
    const creeps = { first: worker(home, { source: home.sources[0], name: 'first' }),
        second: worker(home, { source: home.sources[1], name: 'second' }) };
    for (let index = 0; index < 4; index++) {
        const name = `${home.name}_DEVELOP_UPGRADER_${index}`;
        const old = worker(home, { role: 'upgrader', work: 2, name, x: 39, y: 40 });
        old.name = `UPGRADER_${name}`; creeps[old.name] = old;
    }
    const state = makeWorld(home, { creeps });
    for (const expected of [10, 12, 14, 16]) {
        const configs = byRole(state.release(), 'upgrader');
        assert.equal(requestedWork(configs), expected);
        const names = new Set(configs.map(config => state.demand.createCreepName(config.role, config.name)));
        for (const [name, creep] of Object.entries(state.game.creeps)) if (creep.memory.role === 'upgrader' && !names.has(name)) delete state.game.creeps[name];
        for (const config of configs) {
            const key = state.demand.createCreepName(config.role, config.name);
            if (!state.game.creeps[key]) {
                const replacement = worker(home, { role: 'upgrader', work: config.development.workParts,
                    name: config.name, x: 39, y: 40, data: { sourceId: buffer.id } });
                replacement.name = key; state.game.creeps[key] = replacement;
            }
        }
    }
    const settled = byRole(state.release(), 'upgrader');
    assert.equal(requestedWork(settled), 16);
    assert.ok(settled.every(config => state.game.creeps[state.demand.createCreepName(config.role, config.name)]));
});

test('default development demand can exceed four upgraders while respecting six real controller seats', () => {
    const home = room({ capacity: 550, level: 2, sources: [[10, 10], [40, 10]] });
    const buffer = structure('controller-container', 'container', 40, 43, 1000);
    home.containers = [buffer];
    const state = makeWorld(home, { creeps: {
        first: worker(home, { source: home.sources[0], name: 'first' }),
        second: worker(home, { source: home.sources[1], name: 'second' }),
    } });
    const seats = state.loader.load('creep/developmentLogistics').controllerUpgradeSeatCount(home, buffer);
    assert.equal(seats, 6);
    const upgrades = byRole(state.release(), 'upgrader');
    assert.equal(upgrades.length, 5);
    assert.equal(requestedWork(upgrades), 17);
    assert.ok(upgrades.length <= seats && upgrades.length <= state.policy.upgrading.maximumCreeps);
    for (const [index, name] of ['first-aid', 'second-aid'].entries()) {
        const aid = worker(home, { role: 'sBuilder', work: 8, name, x: 39 + index, y: 42,
            data: { unitKind: 'builder', phase: 'work', task: { targetRoom: home.name, targetShard: 'shard1', targetLevel: 4 } } });
        aid.store = store(50, 800); state.game.creeps[name] = aid;
    }
    const supported = byRole(state.release(), 'upgrader');
    assert.equal(requestedWork(supported), 1, 'sixteen aid WORK already consume most of the budget');
    assert.ok(supported.length <= seats - 2);
});

test('a retained large upgrader receives its real consumption quota instead of a smaller future body cap', () => {
    const home = room({ capacity: 550, level: 2, sources: [[10, 10], [40, 10]] });
    home.containers = [structure('controller-container', 'container', 38, 40, 1000)];
    const big = worker(home, { role: 'upgrader', work: 20, name: 'large-existing', x: 39, y: 40 });
    const state = makeWorld(home, { creeps: { big,
        first: worker(home, { source: home.sources[0], name: 'first' }),
        second: worker(home, { source: home.sources[1], name: 'second' }),
    } });
    const upgrades = byRole(state.release(), 'upgrader');
    assert.equal(upgrades.length, 1);
    assert.equal(upgrades[0].development.workParts, 17);
});

test('active stable aid WORK and its occupied controller seat reduce new upgrader demand', () => {
    const home = room({ capacity: 1300, level: 4 });
    home.containers = [structure('controller-container', 'container', 38, 40, 1000)];
    home.getTerrain = () => ({ get: (x, y) => x === 39 && (y === 39 || y === 40) ? 0 : 1 });
    const aid = worker(home, { role: 'sBuilder', work: 5, name: 'aid', x: 39, y: 40,
        data: { unitKind: 'builder', phase: 'work', task: { targetRoom: home.name, targetShard: 'shard1', targetLevel: 6 } } });
    aid.store = store(0, 100);
    const state = makeWorld(home, { creeps: { miner: worker(home), aid } });
    let upgrades = byRole(state.release(), 'upgrader');
    assert.equal(upgrades.length, 1);
    assert.equal(requestedWork(upgrades), 3, 'one remaining seat takes the budget after five real aid WORK');
    aid.memory.data.task.targetLevel = home.controller.level;
    upgrades = byRole(state.release(), 'upgrader');
    assert.equal(requestedWork(upgrades), 8, 'completed aid no longer reduces the automatic upgrade budget');
    aid.memory.data.task.targetLevel = 6; aid.memory.data.phase = 'done';
    assert.equal(requestedWork(byRole(state.release(), 'upgrader')), 8, 'inactive task beside the controller is not continuous spending');
});

test('manual aid only consumes the controller budget while its target and level actually permit upgrading', () => {
    const home = room({ capacity: 1300, level: 4 });
    home.containers = [structure('controller-container', 'container', 38, 40, 1000)];
    const aid = worker(home, { role: 'rBuilder', work: 5, name: 'manual-aid', x: 39, y: 40,
        data: { sourceFlag: home.sources[0].id, targetFlag: home.sources[0].id } });
    aid.store = store(20, 100);
    const state = makeWorld(home, { creeps: { miner: worker(home), aid } });
    assert.equal(requestedWork(byRole(state.release(), 'upgrader')), 3);
    aid.memory.data.targetFlag = 'missing-target';
    assert.equal(requestedWork(byRole(state.release(), 'upgrader')), 8);
    aid.memory.data.targetFlag = home.sources[0].id;
    state.loader.load('settings/rolePolicy').rolePolicy.remoteBuilder.stopUpgradingAtLevel = home.controller.level;
    assert.equal(requestedWork(byRole(state.release(), 'upgrader')), 8);
});

function legacyRoom(level = 8) {
    const home = room({ capacity: 5600, level, sources: [[10, 10], [40, 10]] });
    home.storage = structure('storage', 'storage', 24, 24, 500000);
    home.terminal = structure('terminal', 'terminal', 25, 24);
    home.centerLink = structure('center-link', 'link', 24, 25);
    home.containers = [structure('source-container-a', 'container', 11, 10, 1501),
        structure('source-container-b', 'container', 39, 10, 2000),
        structure('controller-container', 'container', 38, 40, 2000)];
    home.labs = [{ id: 'lab' }];
    home.extractor = { id: 'extractor' };
    home.wallsNeedRepair = [{ id: 'wall' }];
    home.constructionSites = [{ id: 'site', structureType: 'road' }];
    return home;
}

function expectedLegacy(home, upgraderCount) {
    const expected = [
        ['manager', `${home.name}_MANAGER`, {}], ['processer', `${home.name}_PROCESSER`, {}],
        ['miner', `${home.name}_MINER`, { sourceId: 'mineral' }],
        ['harvester', `${home.name}_HARVESTER_source0_0`, { sourceId: 'source0' }],
        ['harvester', `${home.name}_HARVESTER_source1_0`, { sourceId: 'source1' }],
        ['filler', `${home.name}_FILLER_STORAGE_0`, { sourceId: 'storage' }],
        ['builder', `${home.name}_BUILDER_STORAGE_0`, { sourceId: 'storage', buildTarget: '' }],
        ['repairer', `${home.name}_REPAIRER_STORAGE0`, { sourceId: 'storage', repairTarget: '' }],
    ];
    for (const id of ['source-container-a', 'source-container-b']) for (let index = 0; index < 2; index++) {
        expected.push(['filler', `${home.name}_FILLER_CONTAINER_${id}_${index}`, { sourceId: id }]);
    }
    for (let index = 0; index < upgraderCount; index++) expected.push(['upgrader', `${home.name}_UPGRADER_STORAGE_${index}`, { sourceId: 'storage' }]);
    return summary(expected.map(([role, name, data]) => ({ role, name, data })));
}

function blockDevelopmentReads(state) {
    const forbidden = () => { throw new Error('legacy population must not inspect development state or logistics'); };
    Object.defineProperty(state.home.memory, 'developmentRemotes', { get: forbidden });
    Object.defineProperty(state.home, 'controllerLink', { get: forbidden });
    Object.defineProperty(state.home, 'links', { get: forbidden });
    Object.defineProperty(state.policy, 'bodies', { get: forbidden });
    Object.defineProperty(state.game, 'creeps', { get: forbidden });
}

test('RCL8 demand stays identical to legacy manager, mineral, hauling, building and repair needs', () => {
    const home = legacyRoom();
    const oldBuilder = worker(home, { role: 'builder', work: 4, name: 'oldBuilder' });
    const oldUpgrader = worker(home, { role: 'upgrader', work: 20, name: 'oldUpgrader' });
    const before = JSON.stringify([oldBuilder.memory, oldUpgrader.memory]);
    const state = makeWorld(home, { creeps: { oldBuilder, oldUpgrader } });
    blockDevelopmentReads(state);
    const keys = Object.keys(home.memory);
    const configs = state.release();
    assert.deepEqual(summary(configs), expectedLegacy(home, 0));
    assert.ok(configs.every(config => !Object.hasOwn(config, 'development')));
    assert.deepEqual(Object.keys(home.memory), keys, 'RCL8 does not initialize development state');
    assert.equal(JSON.stringify([oldBuilder.memory, oldUpgrader.memory]), before, 'RCL8 does not adopt old consumers');
});

test('RCL8 downgrade maintenance publishes exactly one legacy upgrader even with a full Storage', () => {
    const home = legacyRoom();
    home.controller.ticksToDowngrade = 149999;
    const state = makeWorld(home);
    blockDevelopmentReads(state);
    const configs = state.release();
    assert.deepEqual(summary(configs), expectedLegacy(home, 1));
    assert.equal(byRole(configs, 'upgrader').length, 1);
    assert.ok(configs.every(config => !Object.hasOwn(config, 'development')));
});

test('fastUpgrade=false preserves the entire RCL7 legacy population and never reads development logistics', () => {
    const home = legacyRoom(7);
    home.memory.fastUpgrade = false;
    const state = makeWorld(home);
    blockDevelopmentReads(state);
    const configs = state.release();
    assert.deepEqual(summary(configs), expectedLegacy(home, 4));
    assert.ok(configs.every(config => !Object.hasOwn(config, 'development')));
    assert.deepEqual(Object.keys(home.memory).sort(), ['creepConfig', 'fastUpgrade']);
});
