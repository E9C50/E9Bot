const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const nativeBodies = require('../helpers/native-bodies.cjs');

function world({ level = 6, capacity = 2150 } = {}) {
    const position = (x, y, roomName = 'E39N5') => ({ x, y, roomName });
    const source = { id: 'home-source', pos: position(10, 10) };
    const home = { name: 'E39N5', my: true, controller: { my: true, level, pos: position(20, 20), owner: { username: 'me' } },
        energyCapacityAvailable: capacity, energyAvailable: 0, memory: { creepConfig: {}, roomFillJob: {} },
        sources: [source, { id: 'unstaffed-source', pos: position(40, 40) }], links: [], containers: [],
        getTerrain: () => ({ get: () => 0 }), lookForAt: () => [], find: () => [] };
    const game = { time: 100, shard: { name: 'shard1' }, rooms: { [home.name]: home }, creeps: {}, flags: {} };
    function creep(name, role, data, parts, x = 11, y = 10) {
        const body = parts.map(type => ({ type, hits: 100 }));
        const unit = { name, body, room: home, pos: position(x, y), spawning: false, ticksToLive: 1200,
            memory: { role, spawnRoom: home.name, data },
            getActiveBodyparts: type => body.filter(part => part.type === type && part.hits > 0).length };
        game.creeps[name] = unit; return unit;
    }
    const miner = creep('local-miner', 'harvester', { sourceId: source.id }, ['work', 'work', 'work', 'work', 'carry', 'move']);
    const carrier = creep('local-carrier', 'filler', { sourceId: source.id }, ['carry', 'carry', 'carry', 'carry', 'carry', 'move'], 25, 25);
    const loader = createSourceLoader({ globals: { ...nativeBodies.globals, Game: game, Memory: {},
        STRUCTURE_LINK: 'link', STRUCTURE_CONTAINER: 'container', STRUCTURE_ROAD: 'road', STRUCTURE_RAMPART: 'rampart',
        LOOK_STRUCTURES: 'structures', TERRAIN_MASK_WALL: 1, FIND_MINERALS: 'minerals', FIND_SOURCES: 'sources', FIND_STRUCTURES: 'structures' } });
    const ready = loader.load('creep/remoteHomeEconomy').hasRemoteHomeEconomy;
    return { home, source, game, miner, carrier, position, creep, loader, ready };
}

test('one working local mine and its carrier unlock remotes without full quotas, stored energy or full spawn stock', () => {
    const w = world();
    assert.equal(w.ready(w.home), true);
    assert.equal(w.home.energyAvailable, 0);
    assert.equal(w.miner.getActiveBodyparts('work'), 4);
    assert.equal(Object.values(w.game.creeps).length, 2);
});

test('unborn, misplaced, foreign-home or inactive local mining and transport cannot admit remote births', () => {
    const invalid = [
        w => { w.miner.spawning = true; },
        w => { w.carrier.spawning = true; },
        w => { delete w.game.creeps['local-miner']; },
        w => { delete w.game.creeps['local-carrier']; },
        w => { w.miner.pos = w.position(25, 25); },
        w => { w.miner.memory.data.sourceId = 'unrelated'; },
        w => { w.miner.memory.spawnRoom = 'E39N4'; },
        w => { w.carrier.room = { name: 'E39N4' }; },
        w => { w.carrier.memory.spawnRoom = 'E39N4'; },
        w => { w.carrier.memory.data.sourceId = 'unrelated'; },
        w => { w.miner.body.forEach(part => { if (part.type === 'work') part.hits = 0; }); },
        w => { w.carrier.body.forEach(part => { if (part.type === 'carry') part.hits = 0; }); },
        w => { w.carrier.body.find(part => part.type === 'move').hits = 0; },
        w => { w.miner.memory.boostPlan = { steps: [{ resource: 'XUHO2' }] }; },
    ];
    for (const invalidate of invalid) {
        const w = world(); invalidate(w); assert.equal(w.ready(w.home), false, invalidate.toString());
    }
});

test('source and adjacent container IDs or retained mine metadata identify real local transport', () => {
    for (const mode of ['container', 'mineId', 'retained']) {
        const w = world();
        const container = { id: 'mine-container', pos: w.position(11, 10) }; w.home.containers.push(container);
        w.carrier.memory.data.sourceId = mode === 'container' ? container.id : 'temporarily-cached-withdraw-target';
        if (mode === 'mineId') w.carrier.memory.data.mineId = w.source.id;
        if (mode === 'retained') w.carrier.memory.developmentHauler = { mineId: w.source.id };
        assert.equal(w.ready(w.home), true, mode);
    }
    const w = world();
    w.home.containers.push({ id: 'controller-container', pos: w.position(20, 20) });
    w.carrier.memory.data.sourceId = 'controller-container';
    assert.equal(w.ready(w.home), false);
    w.carrier.memory.data.sourceId = w.source.id; w.carrier.memory.data.mineId = 'other-mine';
    assert.equal(w.ready(w.home), false, 'dedicated mine identity takes precedence over a mutable Source target');
});

test('a local carrier waiting for its boost cannot open remote births until the preparation completes or fails', () => {
    for (const outcome of ['completed', 'failed']) {
        const w = world();
        w.carrier.memory.boostPlan = { steps: [{ resource: 'XKH2O', parts: 5 }] };
        assert.ok(w.carrier.getActiveBodyparts('carry') > 0 && w.carrier.getActiveBodyparts('move') > 0);
        assert.equal(w.ready(w.home), false, 'native parts exist but this carrier is still assigned to boost preparation');
        w.carrier.memory.boostPlan[outcome] = true;
        assert.equal(w.ready(w.home), true, outcome);
    }
});

function addStorageLinks(w, includeCenter = true) {
    w.home.storage = { id: 'storage', my: true, pos: w.position(25, 25), store: { energy: 0 }, isActive: () => true };
    w.carrier.memory.data.sourceId = 'storage';
    const origin = { id: 'source-link', structureType: 'link', my: true, pos: w.position(12, 10), isActive: () => true };
    const center = { id: 'center-link', structureType: 'link', my: true, pos: w.position(24, 25), isActive: () => true };
    w.home.links.push(origin);
    if (includeCenter) { w.home.links.push(center); w.home.centerLink = center; }
    return { origin, center };
}

test('storage-only transport requires an operating Source to central Link chain and a carry-capable miner at its joint seat', () => {
    const w = world(); addStorageLinks(w);
    assert.equal(w.ready(w.home), true);
    for (const invalid of ['missing-center', 'inactive-center', 'site-center', 'inactive-origin', 'wrong-seat', 'no-carry']) {
        const q = world(); const { origin, center } = addStorageLinks(q, invalid !== 'missing-center');
        if (invalid === 'inactive-center') center.isActive = () => false;
        if (invalid === 'site-center') center.progressTotal = 5000;
        if (invalid === 'inactive-origin') origin.isActive = () => false;
        if (invalid === 'wrong-seat') q.miner.pos = q.position(9, 10);
        if (invalid === 'no-carry') q.miner.body.find(part => part.type === 'carry').hits = 0;
        assert.equal(q.ready(q.home), false, invalid);
    }
    const noLinks = world(); noLinks.home.storage = { id: 'storage' }; noLinks.carrier.memory.data.sourceId = 'storage';
    assert.equal(noLinks.ready(noLinks.home), false);
});

test('development gate preserves the 550 capacity floor and RCL8 or opted-out manual OUT behavior', () => {
    const insufficient = world({ capacity: 549 }); assert.equal(insufficient.ready(insufficient.home), false);
    const low = world({ capacity: 550, level: 2 }); assert.equal(low.ready(low.home), true);
    for (const bypass of ['mature', 'opted-out']) {
        const w = world({ level: bypass === 'mature' ? 8 : 6, capacity: 0 });
        w.game.creeps = {}; if (bypass === 'opted-out') w.home.memory.fastUpgrade = false;
        assert.equal(w.ready(w.home), true, bypass);
    }
});

test('remote core birth priorities follow local mining and hauling and immediate Invader defense, before construction and upgrading', () => {
    const w = world();
    const priorities = w.loader.load('settings/population').populationPolicy.remote.startupPriorities;
    assert.deepEqual({ ...priorities }, { maintenance: 2.6, reserver: 2.7, harvester: 2.8, hauler: 2.9, scout: 2.95 });
    const local = w.loader.load('settings/creep').spawnPriority;
    for (const priority of Object.values(priorities)) {
        assert.ok(priority > local.harvester && priority > local.filler && priority > 2.5);
        assert.ok(priority < local.builder && priority < local.upgrader);
    }
});
