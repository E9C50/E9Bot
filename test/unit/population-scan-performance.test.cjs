const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const nativeBodies = require('../helpers/native-bodies.cjs');

function fixture() {
    const counts = { catalogs: 0, roomReads: 0, memoryReads: 0 };
    const catalog = {}, creeps = new Proxy(catalog, {
        ownKeys(target) { counts.catalogs++; return Reflect.ownKeys(target); },
    });
    const rooms = {};
    for (let index = 0; index < 10; index++) {
        const name = `W${index + 1}N1`;
        rooms[name] = { name, my: true, level: 8, controller: { my: true, level: 8 },
            memory: { creepConfig: {} }, links: [{}], containers: [], spawns: [],
            constructionSites: [], mineral: { id: `${name}-mineral` },
            sources: [0, 1].map(slot => ({ id: `${name}-source${slot}` })) };
    }
    const roles = Object.fromEntries(['manager', 'processer', 'miner', 'builder'].map(role =>
        [role, () => ({ isNeed: () => false })]));
    roles.isRoleSupported = () => true;
    const loader = createSourceLoader({ globals: { ...nativeBodies.globals,
        Game: { rooms, creeps, time: 100 }, Memory: {}, RESOURCE_ENERGY: 'energy' }, modules: {
        ...nativeBodies.modules, role: roles, utils: { sha1String: value => value },
        './development': { isDevelopingRoom: () => false },
        './repairerPopulation': { releaseRepairerCreepConfigs() {} },
        './storageFillerPopulation': { releaseStorageFillerConfig() {} },
        './storageFillerLifecycle': { hasUsableStorageFiller: () => true },
        './remoteHomeEconomy': { hasRemoteHomeEconomy: () => true },
        './bodySelection': { selectCreepBody: () => ({ body: [], boostPlan: { tier: 0, steps: [] } }) },
        'room/sourceLinks': { sourceLinkWithCenter: () => ({}), hasSourceLinkTransport: () => true },
        'room/evacuationState': { isRoomEvacuating: () => false },
    } });
    const demand = loader.load('creep/demand');
    function add(role, home, logicalName, sourceId, carry = 1) {
        const name = demand.createCreepName(role, logicalName);
        const memory = { role, name: logicalName, spawnRoom: home.name, data: { sourceId } };
        const creep = { name, getActiveBodyparts: part => part === 'carry' ? carry : part === 'work' ? 1 : 0 };
        Object.defineProperty(creep, 'memory', { get() { counts.memoryReads++; return memory; } });
        Object.defineProperty(creep, 'room', { get() { counts.roomReads++; return home; } });
        catalog[name] = creep;
        return { creep, memory, name };
    }
    function publish() {
        for (const home of Object.values(rooms)) home.memory.creepConfig = {};
        loader.load('creep/basePopulation').releaseBaseCreepConfig();
    }
    return { counts, catalog, creeps, rooms, loader, add, publish };
}

test('ten pending spawn queues inspect only mining and hauling roles in one catalog pass each', () => {
    const w = fixture(), homes = Object.values(w.rooms);
    for (let index = 0; index < 65; index++) {
        const role = index < 17 ? 'harvester' : index < 28 ? 'filler' : 'manager';
        w.add(role, homes[index % homes.length], `resident${index}`, `source${index}`);
    }
    const queue = w.loader.load('creep/spawnQueue');
    for (const home of homes) {
        home.memory.creepConfig.pending = { role: 'miner', spawnPriority: 7, data: {} };
        assert.deepEqual(Array.from(queue.buildSpawnQueue(home)), ['pending']);
    }
    assert.equal(w.counts.catalogs, 10, 'one catalog enumeration per pending room, previously two');
    assert.equal(w.counts.roomReads, 280, '28 relevant roles × 10 rooms; previously all 65 roles × 2 × 10');
    const before = { ...w.counts };
    homes[0].memory.creepConfig = {};
    assert.deepEqual(Array.from(queue.buildSpawnQueue(homes[0])), []);
    assert.deepEqual(w.counts, before, 'an empty demand queue requires no live directory');
});

test('twenty absent linked miners share one lazy resident directory during publication', () => {
    const w = fixture(), homes = Object.values(w.rooms);
    for (let index = 0; index < 65; index++) w.add('manager', homes[index % 10], `unrelated${index}`);
    w.publish();
    assert.equal(w.counts.catalogs, 1, 'twenty Source slots formerly enumerated the directory twenty times');
    assert.equal(w.counts.memoryReads, 65, 'each unrelated role is rejected once, formerly 1300 predicate reads');
    assert.equal(w.counts.roomReads, 0, 'replacement grouping depends on the birth room, not native current room');
    for (const home of homes) assert.equal(Object.keys(home.memory.creepConfig).length, 2);
});

test('an absent base slot retains its living link replacement and a later publication sees changed residents', () => {
    const w = fixture(), home = Object.values(w.rooms)[0], source = home.sources[0];
    const base = `${home.name}_HARVESTER_${source.id}_0`;
    const first = w.add('harvester', home, `${base}_LINK_CARRY_0`, source.id);
    w.publish();
    assert.ok(home.memory.creepConfig[first.name], 'the missing base name must not replace a paid-for alternate miner');
    assert.equal(Object.values(home.memory.creepConfig).some(config => config.name === base), false);
    delete w.catalog[first.name];
    const second = w.add('harvester', home, `${base}_LINK_CARRY_1`, source.id);
    w.publish();
    assert.ok(home.memory.creepConfig[second.name]);
    assert.equal(home.memory.creepConfig[first.name], undefined);
    assert.equal(w.counts.catalogs, 2, 'each synchronous publication builds a fresh directory');
});

test('healthy named link miners avoid the directory while zero-CARRY predecessors retain one successor slot', () => {
    const w = fixture();
    for (const home of Object.values(w.rooms)) for (const source of home.sources)
        w.add('harvester', home, `${home.name}_HARVESTER_${source.id}_0`, source.id);
    w.publish();
    assert.equal(w.counts.catalogs, 0, 'healthy current miners need no replacement snapshot');
    const home = Object.values(w.rooms)[0], source = home.sources[0], base = `${home.name}_HARVESTER_${source.id}_0`;
    w.add('harvester', home, base, source.id, 0);
    const successor = w.add('harvester', home, `${base}_LINK_CARRY_0`, source.id);
    w.publish();
    assert.ok(home.memory.creepConfig[successor.name]);
    assert.equal(Object.values(home.memory.creepConfig).filter(config => config.data.sourceId === source.id).length, 1);
    assert.equal(w.counts.catalogs, 1);
});

test('a rampart repairer floor at the surplus ceiling skips every wall-health list read', () => {
    const w = fixture(), publish = w.loader.load('creep/repairerPopulation').releaseRepairerCreepConfigs;
    for (const home of Object.values(w.rooms)) {
        home.ramparts = [{ my: true }];
        home.storage = { id: `${home.name}-storage`, store: { energy: 300000 } };
        Object.defineProperty(home, 'wallsNeedRepair', { get() { throw new Error('irrelevant wall scan'); } });
        publish(home, false);
        const configs = Object.values(home.memory.creepConfig);
        assert.equal(configs.length, 1);
        assert.equal(configs[0].role, 'repairer');
        assert.equal(configs[0].spawnPriority, 3.5, 'the unoccupied permanent floor retains its recovery priority');
    }
});

test('surplus repair scanning responds to live ceiling, floor, rampart and wall changes within one tick', () => {
    const w = fixture(), home = Object.values(w.rooms)[0];
    const publish = w.loader.load('creep/repairerPopulation').releaseRepairerCreepConfigs;
    const population = w.loader.load('settings/population').populationPolicy;
    const role = w.loader.load('settings/rolePolicy').rolePolicy;
    let reads = 0, damaged = true;
    home.ramparts = [{ my: true }];
    home.storage = { id: 'storage', store: { energy: 300000 } };
    Object.defineProperty(home, 'wallsNeedRepair', { get() { reads++; return damaged ? [{}] : []; } });
    const release = () => {
        home.memory.creepConfig = {};
        publish(home, false);
        return Object.values(home.memory.creepConfig);
    };
    assert.equal(release().length, 1);
    assert.equal(reads, 0);
    population.base.maximumRepairers = 2;
    assert.equal(release().length, 2, 'a raised surplus ceiling immediately admits another worker');
    assert.equal(reads, 1);
    damaged = false;
    assert.equal(release().length, 1, 'undamaged walls leave the rampart floor');
    assert.equal(reads, 2);
    role.repairer.minimumRampartWorkers = 2;
    assert.equal(release().length, 2, 'raising the permanent floor at the current ceiling skips surplus again');
    assert.equal(reads, 2);
    role.repairer.minimumRampartWorkers = 1;
    population.base.maximumRepairers = 1;
    home.ramparts = [];
    damaged = true;
    const surplus = release();
    assert.equal(surplus.length, 1, 'non-rampart wall repair demand still uses the existing surplus path');
    assert.equal(surplus[0].spawnPriority, 6);
    assert.equal(reads, 3);
    damaged = false;
    assert.equal(release().length, 0);
    assert.equal(reads, 4);
});
