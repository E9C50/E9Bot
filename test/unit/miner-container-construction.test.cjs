const assert = require('node:assert/strict');
const test = require('node:test');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world(level = 1) {
    const objects = new Map(), calls = [];
    const game = { time: 100, shard: { name: 'shard1' }, getObjectById: id => objects.get(id) || null };
    const pos = (x, y) => ({ x, y, roomName: 'E1S1',
        getRangeTo(target) { target = target.pos || target; return target.roomName === this.roomName ? Math.max(Math.abs(x - target.x), Math.abs(y - target.y)) : Infinity; },
        isNearTo(target) { return this.getRangeTo(target) <= 1; },
        inRangeTo(target, range) { return this.getRangeTo(target) <= range; },
        isEqualTo(target) { return this.getRangeTo(target) === 0; } });
    const store = (energy, capacity) => ({ energy, getCapacity: () => capacity, getFreeCapacity() { return capacity - this.energy; } });
    const room = { name: 'E1S1', level, controller: { level, my: true, pos: pos(25, 25) }, memory: {}, energyAvailable: 300,
        links: [], containers: [], spawns: [], extensions: [], structures: [], constructionSites: [], units: [], find: () => room.units,
        getTerrain: () => ({ get: () => 0 }), mineral: { pos: pos(35, 35) } };
    const source = { id: 'source', pos: pos(10, 10), energy: 3000 };
    room.sources = [source];
    objects.set(source.id, source);
    function site(id, type = 'container', x = 11, y = 10, my = true) {
        const target = { id, structureType: type, pos: pos(x, y), my, progress: 0, progressTotal: 80 };
        room.constructionSites.push(target); objects.set(id, target); return target;
    }
    function structure(id, type, x, y, energy = 0, capacity = 2000) {
        const target = { id, structureType: type, pos: pos(x, y), my: true, store: store(energy, capacity), hits: 250000, hitsMax: 250000,
            isActive: () => type !== 'link' || level >= 5 };
        room.structures.push(target);
        objects.set(id, target); room[{ link: 'links', container: 'containers', spawn: 'spawns' }[type]].push(target); return target;
    }
    function miner(energy = 10, capacity = 50, x = 11, y = 10) {
        const unit = { name: 'miner', room, pos: pos(x, y), memory: { role: 'harvester' }, store: store(energy, capacity), spawning: false };
        for (const method of ['build', 'harvest', 'transfer', 'repair']) unit[method] = target => {
            calls.push({ method, target: target.id }); return unit.pos.inRangeTo(target, method === 'build' || method === 'repair' ? 3 : 1) ? 0 : -9;
        };
        unit.drop = () => { calls.push({ method: 'drop' }); return 0; };
        unit.moveTo = target => { calls.push({ method: 'moveTo', target: target.id }); return 0; };
        room.units.push(unit); return unit;
    }
    const loader = createSourceLoader({ globals: { Game: game, RESOURCE_ENERGY: 'energy', STRUCTURE_CONTAINER: 'container',
        STRUCTURE_LINK: 'link', STRUCTURE_ROAD: 'road', STRUCTURE_RAMPART: 'rampart', TERRAIN_MASK_WALL: 1,
        FIND_MY_CREEPS: 'my', CONTAINER_DECAY: 5000, ERR_NOT_IN_RANGE: -9 },
        modules: { utils: { getDistance: (a, b) => a.getRangeTo(b) },
            'creep/developmentLogistics': { sourceHarvestPosition: (unit, mine, buffer) => unit.pos.isNearTo(mine) && unit.pos.isNearTo(buffer) ? unit.pos : undefined },
            'creep/stationaryMining': { prepareStationaryMining: () => undefined, runStationaryMining: () => false } } });
    return { room, game, source, calls, site, structure, miner, pos, clear: () => { calls.length = 0; },
        role: loader.load('role/base/RoleBaseHarvester').default({ sourceId: source.id }) };
}

for (const phase of ['source', 'target']) test(`RCL1 miner ${phase} prioritizes its Source container site over unloading and other nearby construction without leaving the mine`, () => {
    const w = world(), unit = w.miner(50), road = w.site('road', 'road'), container = w.site('source-container', 'container', 9, 9);
    w.structure('source-link', 'link', 12, 10);
    assert.equal(w.role.prepare(unit), true);
    assert.equal(w.role[phase](unit), true);
    assert.deepEqual(w.calls, [{ method: 'build', target: container.id }]);
    assert.equal(unit.memory.working, false);
    assert.equal(unit.pos.isNearTo(w.source), true);
    assert.notEqual(w.calls[0].target, road.id);
});

test('an empty miner repeatedly harvests its own build energy, completes the container and resumes normal station production', () => {
    const w = world(), unit = w.miner(0), site = w.site('source-container');
    let harvested = 0, built = 0;
    for (let tick = 0; tick < 50 && site.progress < site.progressTotal; tick++) {
        w.clear(); assert.equal(w.role.prepare(unit), true); w.role[tick % 2 ? 'source' : 'target'](unit);
        assert.equal(w.calls.length, 1, 'a mining tick has one native WORK intent');
        const action = w.calls[0];
        if (action.method === 'harvest') {
            const energy = Math.min(4, w.source.energy, unit.store.getFreeCapacity());
            w.source.energy -= energy; unit.store.energy += energy; harvested += energy;
        } else {
            assert.equal(action.method, 'build');
            const energy = Math.min(unit.store.energy, 10, site.progressTotal - site.progress);
            assert.ok(energy > 0, 'building uses existing cargo rather than a hypothetical same-tick harvest');
            unit.store.energy -= energy; site.progress += energy; built += energy;
        }
        assert.equal(unit.pos.isNearTo(w.source), true); w.game.time++;
    }
    assert.equal(site.progress, site.progressTotal); assert.equal(harvested, built);
    w.room.constructionSites.length = 0;
    const container = w.structure(site.id, 'container', site.pos.x, site.pos.y);
    unit.store.energy = 10; w.clear(); w.role.source(unit);
    assert.deepEqual(w.calls, [{ method: 'transfer', target: container.id }, { method: 'harvest', target: w.source.id }]);
});

test('foreign sites, other Sources containers and a miner away from its Source never divert mining into construction', () => {
    for (const kind of ['foreign', 'other-source', 'road', 'away']) {
        const w = world(), unit = w.miner(10);
        w.site('excluded', kind === 'road' ? 'road' : 'container', kind === 'other-source' ? 13 : 11, 10, kind !== 'foreign');
        if (kind === 'away') unit.pos = w.pos(13, 10);
        w.role.source(unit);
        assert.equal(w.calls.some(call => call.method === 'build'), false, kind);
        assert.equal(w.calls.some(call => call.method === 'moveTo'), false, 'construction never adds movement');
    }
});

test('a zero-CARRY miner keeps native mining and a depleted Source resumes construction after it can produce new cargo', () => {
    const w = world(), site = w.site('source-container'), unit = w.miner(0, 0);
    w.role.source(unit); assert.deepEqual(w.calls, [{ method: 'harvest', target: w.source.id }]);
    unit.store = { energy: 0, getCapacity: () => 50, getFreeCapacity() { return 50 - this.energy; } };
    w.source.energy = 0; w.clear(); w.role.target(unit); assert.deepEqual(w.calls, []);
    w.source.energy = 3000; w.clear(); w.role.source(unit); assert.deepEqual(w.calls, [{ method: 'harvest', target: w.source.id }]);
    unit.store.energy = 4; w.clear(); w.role.source(unit); assert.deepEqual(w.calls, [{ method: 'build', target: site.id }]);
});

test('source container construction preserves empty-Spawn rescue when no live carrier can deliver production energy', () => {
    const w = world(), unit = w.miner(50), spawn = w.structure('spawn', 'spawn', 20, 10, 0, 300);
    w.room.energyAvailable = 0; w.site('source-container');
    assert.equal(w.role.prepare(unit), true); w.role.source(unit);
    assert.deepEqual(w.calls, [{ method: 'transfer', target: spawn.id }, { method: 'moveTo', target: spawn.id }]);
    w.room.units.push({ spawning: false, memory: { role: 'filler' } }); w.game.time++; w.clear();
    w.role.source(unit); assert.deepEqual(w.calls, [{ method: 'build', target: 'source-container' }]);
});

test('RCL8 retains existing mature nearest-construction behavior and never reads development room policy', () => {
    const w = world(8), unit = w.miner(10), road = w.site('road', 'road'), container = w.site('source-container', 'container', 9, 9);
    Object.defineProperty(w.room.memory, 'fastUpgrade', { get() { throw Error('mature room read development policy'); } });
    w.role.target(unit);
    assert.deepEqual(w.calls, [{ method: 'build', target: road.id }]);
    assert.notEqual(w.calls[0].target, container.id, 'the mature branch keeps its original nearest-site selection');
});
