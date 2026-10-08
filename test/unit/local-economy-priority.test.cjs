const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

const costs = { work: 100, carry: 50, move: 50, claim: 600, tough: 10, attack: 80, ranged_attack: 150, heal: 250 };
function position(x, y, roomName = 'W1N1') {
    return { x, y, roomName, getFreeSpace: () => Array(8).fill({ x, y, roomName }),
        inRangeTo(other, radius) { const pos = other.pos || other; return Math.max(Math.abs(x - pos.x), Math.abs(y - pos.y)) <= radius; } };
}
function store(energy = 0, capacity = 2000) {
    return { energy, getCapacity: () => capacity, getFreeCapacity: () => capacity - energy, getUsedCapacity: () => energy };
}
function world({ capacity = 700, available = capacity, sources = 2, downgrade = 100000, buffer = false } = {}) {
    const home = { name: 'W1N1', my: true, level: 4, memory: { creepConfig: {} },
        energyCapacityAvailable: capacity, energyAvailable: available,
        controller: { my: true, level: 4, pos: position(40, 40), ticksToDowngrade: downgrade },
        spawns: [{ id: 'spawn', pos: position(20, 20) }], containers: [], links: [], labs: [],
        constructionSites: [], getTerrain: () => ({ get: () => 0 }), lookForAt: () => [], find: () => [] };
    home.sources = Array.from({ length: sources }, (_, index) => ({ id: `source${index}`, energyCapacity: 3000,
        energy: 3000, pos: position(10 + index * 20, 10), room: home }));
    if (buffer) home.containers.push({ id: 'controller-buffer', structureType: 'container', pos: position(39, 39), store: store(500) });
    const objects = new Map([...home.sources, ...home.containers].map(object => [object.id, object]));
    const game = { time: 100, shard: { name: 'shard1' }, rooms: { [home.name]: home }, creeps: {}, getObjectById: id => objects.get(id) || null };
    let loader;
    const demand = { createCreepName: (role, name) => `${role.toUpperCase()}_${name}`,
        addCreepConfig(room, role, name, data) {
            const key = demand.createCreepName(role, name);
            room.memory.creepConfig[key] = { name, role, spawnRoom: room.name, data,
                spawnPriority: loader.load('settings/creep').spawnPriority[role] };
            return key;
        } };
    loader = createSourceLoader({ globals: { Game: game, RESOURCE_ENERGY: 'energy', BODYPART_COST: costs,
        WORK: 'work', CARRY: 'carry', MOVE: 'move', CLAIM: 'claim', TOUGH: 'tough', ATTACK: 'attack',
        RANGED_ATTACK: 'ranged_attack', HEAL: 'heal', CARRY_CAPACITY: 50, HARVEST_POWER: 2,
        ENERGY_REGEN_TIME: 300, CREEP_SPAWN_TIME: 3, MAX_CREEP_SIZE: 50, BUILD_POWER: 5,
        STRUCTURE_LINK: 'link', STRUCTURE_CONTAINER: 'container', STRUCTURE_ROAD: 'road', STRUCTURE_RAMPART: 'rampart',
        TERRAIN_MASK_WALL: 1, LOOK_STRUCTURES: 'structures', LOOK_CREEPS: 'creeps', FIND_STRUCTURES: 'structures',
    }, modules: { './demand': demand, './repairerPopulation': { releaseRepairerCreepConfigs() {} },
        'role': { isRoleSupported: () => true },
        'room/sourceLinks': { sourceLinkWithCenter: room => room.centerLink, hasSourceLinkTransport: room => !!room.centerLink },
        'settings/boost': { boostTypeEnum: { BoostTypeMove: 'boostMove', BoostTypeCarry: 'boostCarry', BoostTypeBuild: 'boostBuild' },
            boostBodyPart: {}, boostConfig: {}, roleBoostConfig: {} },
        'creep/boosting': { canPrepareBoosts() { throw Error('recovery must not wait for boost stock'); } },
    } });
    const population = loader.load('creep/developmentPopulation');
    return { home, game, loader, demand,
        publish() { home.memory.creepConfig = {}; population.releaseDevelopmentBaseConfig(home); return Object.values(home.memory.creepConfig); },
        queue() { return Array.from(loader.load('creep/spawnQueue').buildSpawnQueue(home)).map(key => home.memory.creepConfig[key]); } };
}
function inhabit(state, { role = 'harvester', source = state.home.sources[0], work = 4, carry = 1,
    ttl = 1000, x = source.pos.x + 1, y = source.pos.y, spawning = false, name = `live-${role}-${source.id}`, boostPlan } = {}) {
    const unit = { name: state.demand.createCreepName(role, name), spawning, ticksToLive: ttl,
        room: state.home, pos: position(x, y), memory: { role, name, spawnRoom: state.home.name, data: { sourceId: source.id }, boostPlan },
        body: [...Array(work).fill({ type: 'work', hits: 100 }), ...Array(carry).fill({ type: 'carry', hits: 100 }), { type: 'move', hits: 100 }],
        store: store(0, carry * 50), getActiveBodyparts: part => part === 'work' ? work : part === 'carry' ? carry : part === 'move' ? 1 : 0 };
    state.game.creeps[unit.name] = unit;
    return unit;
}
const configsForSource = (configs, role, source) => configs.filter(config => config.role === role &&
    (role === 'filler' ? config.data.mineId : config.data.sourceId) === source.id);

test('an empty second Source precedes the full-body replacement of a working small miner', () => {
    const state = world({ available: 550 });
    inhabit(state); inhabit(state, { role: 'filler', work: 0, carry: 5 });
    const configs = state.publish();
    const replacement = configsForSource(configs, 'harvester', state.home.sources[0])[0];
    const recovery = configsForSource(configs, 'harvester', state.home.sources[1])[0];
    assert.equal(replacement.development.workParts, 5, 'retain the full-source mining quota');
    assert.equal(replacement.spawnPriority, 3.1);
    assert.equal(recovery.spawnPriority, 1);
    assert.equal(state.queue()[0], recovery, 'do not wait for the first Source\'s 700-energy improvement');
});

test('healthy production improvements follow remote commissioning and keep ordinary upgrades last', () => {
    const state = world({ sources: 1 });
    inhabit(state); inhabit(state, { role: 'filler', work: 0, carry: 2 });
    const configs = state.publish();
    const miners = configs.filter(config => config.role === 'harvester');
    const carriers = configs.filter(config => config.role === 'filler');
    const upgrader = configs.find(config => config.role === 'upgrader');
    assert.ok(miners.every(config => config.spawnPriority === 3.1));
    assert.ok(carriers.every(config => config.spawnPriority === 3.2));
    assert.equal(upgrader.spawnPriority, 5);
    state.home.memory.creepConfig.remote = { role: 'reserver', spawnPriority: 2.6, data: {} };
    assert.equal(state.queue()[0].role, 'reserver');
});

test('an unserved Source keeps its first hauling demand ahead of remote expansion', () => {
    const state = world();
    inhabit(state); inhabit(state, { source: state.home.sources[1], work: 5 });
    inhabit(state, { role: 'filler', work: 0, carry: 5 });
    const configs = state.publish();
    assert.ok(configsForSource(configs, 'filler', state.home.sources[0]).every(config => config.spawnPriority === 3.2));
    assert.ok(configsForSource(configs, 'filler', state.home.sources[1]).every(config => config.spawnPriority === 2));
});

test('a carrier with no active MOVE cannot demote Source hauling recovery', () => {
    const state = world({ sources: 1 });
    inhabit(state);
    const carrier = inhabit(state, { role: 'filler', work: 0, carry: 5 });
    const activeParts = carrier.getActiveBodyparts;
    carrier.getActiveBodyparts = part => part === 'move' ? 0 : activeParts(part);
    carrier.body.find(part => part.type === 'move').hits = 0;
    const configs = state.publish();
    assert.ok(configsForSource(configs, 'filler', state.home.sources[0]).every(config => config.spawnPriority === 2));
    assert.equal(state.queue()[0].role, 'filler', 'restore carrying before expanding the already operating mine');
});

test('a carrier still preparing boosts cannot demote Source hauling recovery', () => {
    const state = world({ sources: 1 });
    inhabit(state);
    inhabit(state, { role: 'filler', work: 0, carry: 5,
        boostPlan: { completed: false, failed: false, steps: [{ resource: 'XKH2O', parts: 5 }] } });
    const configs = state.publish();
    assert.ok(configsForSource(configs, 'filler', state.home.sources[0]).every(config => config.spawnPriority === 2));
    assert.equal(state.queue()[0].role, 'filler', 'restore carrying while the pending boosted carrier is unavailable');
});

test('dying, travelling, spawning or boost-preparing miners cannot demote recovery births', () => {
    for (const options of [{ ttl: 1 }, { x: 20, y: 20 }, { spawning: true },
        { boostPlan: { completed: false, failed: false, steps: [{ resource: 'XUHO2', parts: 4 }] } }]) {
        const state = world({ sources: 1 });
        inhabit(state, options);
        const miners = configsForSource(state.publish(), 'harvester', state.home.sources[0]);
        assert.ok(miners.length > 0);
        assert.ok(miners.every(config => config.spawnPriority === 1), JSON.stringify(options));
    }
});

test('miner improvements lose expansion priority exactly at the spawn-and-travel handover boundary', () => {
    for (const ttl of [58, 59]) {
        const state = world({ sources: 1 });
        inhabit(state, { ttl });
        const miner = configsForSource(state.publish(), 'harvester', state.home.sources[0])[0];
        // Six paid-for parts need 18 spawn ticks, ten tiles need 20 travel ticks, plus the 20-tick margin.
        assert.equal(miner.spawnPriority, ttl === 58 ? 1 : 3.1);
    }
});

test('a linked miner without CARRY cannot postpone the replacement that restores Link production', () => {
    const state = world({ sources: 1 });
    state.home.links = [{ id: 'source-link', pos: position(11, 11) }];
    state.home.centerLink = { id: 'center-link' };
    inhabit(state, { carry: 0 });
    const miners = configsForSource(state.publish(), 'harvester', state.home.sources[0]);
    assert.ok(miners.every(config => config.spawnPriority === 1));
});

test('a healthy controller keeps the ordinary upgrader body and reserve at the downgrade boundary', () => {
    const state = world({ sources: 1, downgrade: 2001 });
    const config = state.publish().find(config => config.role === 'upgrader');
    assert.equal(config.spawnPriority, 5);
    assert.equal(config.development.maximumCost, undefined);
    assert.equal(config.bodyProfile, undefined);
    assert.equal(state.loader.load('creep/developmentEconomy').getDevelopmentSpawnReserve(state.home, 'upgrader'), 200);
});

test('controller downgrade recovery can spawn a native 200-energy body without extra stock', () => {
    for (const buffer of [false, true]) for (const downgrade of [2000, 1]) {
        const state = world({ capacity: 1300, available: 200, sources: 1, buffer, downgrade });
        const config = state.publish().find(config => config.role === 'upgrader');
        assert.equal(config.spawnPriority, 1.5);
        assert.equal(config.development.workParts, 1);
        assert.equal(config.development.maximumCost, 200);
        assert.equal(state.loader.load('creep/developmentEconomy').getDevelopmentSpawnReserve(state.home, 'upgrader'), 0);
        const selected = state.loader.load('creep/bodySelection').selectCreepBody(state.home, config, false);
        assert.deepEqual(Array.from(selected.body), ['work', 'carry', 'move']);
        assert.equal(selected.boostPlan.tier, 0);
        state.home.energyAvailable = 199;
        assert.deepEqual(Array.from(state.loader.load('creep/bodySelection').selectCreepBody(state.home, config, false).body), []);
    }
});

test('custom high-WORK and boost profiles remain bounded by the emergency recovery body', () => {
    for (const preference of ['global', 'room']) for (const terrain of ['plain', 'swamp']) {
        const state = world({ capacity: 1300, available: 200, sources: 1, downgrade: 100 });
        const profile = { workParts: 20, carryParts: 25, maximumCost: 12900, boostTier: 3, boostFallback: 'wait', terrain };
        if (preference === 'global') state.loader.load('settings/bodyPolicy').bodyPolicy.profiles.upgrader = profile;
        else state.home.memory.bodyProfiles = { upgrader: profile };
        const config = state.publish().find(config => config.role === 'upgrader');
        const selected = state.loader.load('creep/bodySelection').selectCreepBody(state.home, config, false);
        assert.deepEqual(Array.from(selected.body), ['work', 'carry', 'move']);
        assert.equal(selected.boostPlan.tier, 0); assert.equal(selected.boostPlan.steps.length, 0);
    }
});

test('a paid-for ordinary upgrader retains its WORK quota instead of receiving a new emergency slot', () => {
    const state = world({ sources: 1, downgrade: 1 });
    const existing = inhabit(state, { role: 'upgrader', work: 4, name: 'paid-upgrader' });
    const configs = state.publish().filter(config => config.role === 'upgrader');
    assert.equal(configs.length, 1);
    assert.equal(configs[0].name, existing.memory.name);
    assert.equal(configs[0].development.workParts, 4);
    assert.equal(configs[0].development.maximumCost, undefined);
    assert.equal(configs[0].spawnPriority, 5);
});
