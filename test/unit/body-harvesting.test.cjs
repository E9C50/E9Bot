const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world({ remote = false, level = 8, marked = true, x = 10, y = 11, energy = 10, work = 5, carry = 1, workBoost, name = 'miner' } = {}) {
    const objects = new Map(), actions = [], walls = new Set(), occupants = [];
    class Position {
        constructor(x, y, roomName = 'W1N1') { Object.assign(this, { x, y, roomName }); }
        getRangeTo(value) { const pos = value.pos || value; return this.roomName === pos.roomName ? Math.max(Math.abs(this.x - pos.x), Math.abs(this.y - pos.y)) : Infinity; }
        isNearTo(value) { return this.getRangeTo(value) <= 1; }
        inRangeTo(value, range) { return this.getRangeTo(value) <= range; }
        isEqualTo(value) { return this.getRangeTo(value) === 0; }
    }
    const p = (x, y, roomName) => new Position(x, y, roomName);
    function store(energy, capacity) {
        const result = { energy };
        Object.defineProperties(result, { getFreeCapacity: { value: () => capacity - result.energy },
            getCapacity: { value: () => capacity }, getUsedCapacity: { value: () => result.energy } });
        return result;
    }
    const source = { id: 'source', pos: p(10, 10), energy: 3000 };
    objects.set(source.id, source);
    const room = { name: 'W1N1', level, memory: {}, sources: [source], links: [], containers: [], structures: [],
        constructionSites: [], spawns: [], extensions: [], energyAvailable: 0,
        controller: { my: !remote, level, pos: p(25, 25) },
        getTerrain: () => ({ get: (x, y) => walls.has(`${x},${y}`) ? 1 : 0 }),
        lookForAt(type, x, y) { return (type === 'structures' ? room.structures : occupants).filter(value => value.pos.x === x && value.pos.y === y); },
        find(type) { if (type === 'minerals') return []; throw new Error('Mature/new remote miners must not scan local fillers or seek emergency spawn delivery'); },
        createConstructionSite(x, y, type) { actions.push({ type: 'create', x, y, structureType: type }); return 0; }
    };
    const boosts = { work: { XUHO2: { harvest: 7 }, UO: { harvest: 3 } } };
    const body = [...Array(work).fill('work'), ...Array(carry).fill('carry'), ...Array(Math.ceil(work / 2)).fill('move')]
        .map(type => ({ type, hits: 100, ...(type === 'work' && workBoost ? { boost: workBoost } : {}) }));
    const creep = { id: 'miner-original', name, room, pos: p(x, y), store: store(energy, carry * 50), body,
        get hits() { return body.reduce((sum, part) => sum + part.hits, 0); },
        hitsMax: body.length * 100,
        getActiveBodyparts: part => body.filter(value => value.type === part && value.hits > 0).length,
        memory: { ready: true, working: false, role: remote ? 'rHarvester' : 'harvester', data: { sourceId: source.id, targetRoom: room.name } },
        moveTo(target, options) { const pos = target.pos || target; actions.push({ type: 'move', x: pos.x, y: pos.y, roomName: pos.roomName, range: options?.range }); return 0; },
        transfer(target, resource) { actions.push({ type: 'transfer', target, resource }); return creep.pos.isNearTo(target) ? 0 : -9; },
        withdraw(target, resource) { actions.push({ type: 'withdraw', target, resource }); return creep.pos.isNearTo(target) ? 0 : -9; },
        harvest(target) { actions.push({ type: 'harvest', target }); return creep.pos.isNearTo(target) ? 0 : -9; },
        repair(target) { actions.push({ type: 'repair', target }); return 0; },
        build(target) { actions.push({ type: 'build', target }); return 0; },
        drop() { throw new Error('A full mining buffer must preserve cargo rather than dropping energy'); }
    };
    if (marked) creep.memory.boostPlan = { tier: 0, steps: [] };
    occupants.push(creep);
    source.room = room;
    const game = { time: 1, shard: { name: 'shard3' }, rooms: { [room.name]: room }, creeps: { [creep.name]: creep }, getObjectById: id => objects.get(id) || null };
    const loader = createSourceLoader({ globals: { Game: game, RoomPosition: Position, RESOURCE_ENERGY: 'energy', WORK: 'work',
        LOOK_STRUCTURES: 'structures', LOOK_CREEPS: 'creeps', TERRAIN_MASK_WALL: 1, CONTAINER_DECAY: 5000,
        STRUCTURE_ROAD: 'road', STRUCTURE_LINK: 'link', STRUCTURE_CONTAINER: 'container', STRUCTURE_RAMPART: 'rampart', ERR_NOT_IN_RANGE: -9, OK: 0,
        FIND_MY_CREEPS: 'my-creeps', FIND_MINERALS: 'minerals', HARVEST_POWER: 2, CREEP_LIFE_TIME: 1500, BOOSTS: boosts }, modules: { utils: { getDistance: (a, b) => a.getRangeTo(b),
            getClosestTarget: (pos, values) => values.reduce((best, value) => !best || pos.getRangeTo(value) < pos.getRangeTo(best) ? value : best, undefined) } } });
    const behavior = loader.load(remote ? 'role/adv/RoleAdvRemoteHarvester' : 'role/base/RoleBaseHarvester').default(creep.memory.data);
    function structure(id, type, x, y, { energy = 0, capacity = type === 'link' ? 800 : 2000, hits = 250000, my = true, active = true } = {}) {
        const value = { id, structureType: type, pos: p(x, y), store: store(energy, capacity), hits, hitsMax: 250000, my,
            activeChecks: 0, isActive() { value.activeChecks++; return active; } };
        objects.set(id, value); room.structures.push(value);
        if (type === 'link') room.links.push(value);
        if (type === 'container') room.containers.push(value);
        return value;
    }
    // Resolve native intents from the tick's initial Store; issuing an intent never mutates it.
    function tick() {
        actions.length = 0;
        assert.equal(behavior.prepare(creep), true);
        behavior[creep.memory.working ? 'target' : 'source'](creep);
        const initial = creep.store.energy;
        const harvest = actions.find(action => action.type === 'harvest');
        const power = body.reduce((sum, part) => sum + (part.type === 'work' && part.hits > 0 ? 2 * (boosts.work[part.boost]?.harvest || 1) : 0), 0);
        const amount = harvest ? Math.min(power, source.energy, creep.store.getFreeCapacity()) : 0;
        const transfer = actions.find(action => action.type === 'transfer');
        const sent = transfer ? Math.min(initial, transfer.target.store.getFreeCapacity()) : 0;
        const repair = actions.find(action => action.type === 'repair');
        const spent = repair ? Math.min(creep.getActiveBodyparts('work'), initial) : 0;
        const withdraw = actions.find(action => action.type === 'withdraw');
        const taken = withdraw ? Math.min(creep.store.getFreeCapacity(), withdraw.target.store.energy) : 0;
        creep.store.energy = initial + amount + taken - sent - spent;
        source.energy -= amount;
        if (transfer) transfer.target.store.energy += sent;
        if (repair) repair.target.hits += spent * 100;
        if (withdraw) withdraw.target.store.energy -= taken;
        game.time++;
        return { amount, sent };
    }
    return { game, room, source, creep, behavior, objects, actions, walls, occupants, p, structure, tick, loader };
}

for (const remote of [false, true]) for (const bufferType of ['link', 'container']) {
    test(`${remote ? 'remote' : 'RCL8'} new 5WORK miner harvests continuously and batches 40 energy every four ticks to a ${bufferType}`, () => {
        const w = world({ remote }); const buffer = w.structure('buffer', bufferType, 11, 11);
        // RCL8 has no filler and zero spawn energy; that must not disturb this workstation.
        const spawn = w.structure('spawn', 'spawn', 30, 30, { capacity: 300 }); w.room.spawns.push(spawn);
        w.creep.memory.working = true;
        for (let index = 0; index < 20; index++) {
            const result = w.tick(); assert.deepEqual(result, { amount: 10, sent: index % 4 === 3 ? 40 : 0 });
            assert.deepEqual(w.actions.map(action => action.type), index % 4 === 3 ? ['transfer', 'harvest'] : ['harvest']);
            assert.equal(w.creep.store.energy, [20, 30, 40, 10][index % 4]);
            assert.equal(w.creep.memory.working, false);
        }
        assert.equal(buffer.store.energy, 200); assert.equal(w.source.energy, 2800); assert.equal(spawn.store.energy, 0);
    });
}

for (const { work, carry, batch, interval } of [
    { work: 14, carry: 2, batch: 28, interval: 2 },
    { work: 12, carry: 1, batch: 24, interval: 1 },
    { work: 10, carry: 1, batch: 20, interval: 1 },
    { work: 2, carry: 1, batch: 4, interval: 11 },
]) test(`${work}WORK/${carry}CARRY batches without clipping harvest to the snapshot free capacity`, () => {
    const w = world({ work, carry, energy: batch }); const container = w.structure('container', 'container', 10, 11);
    for (let index = 0; index < interval; index++) w.tick();
    const initialEnergy = w.creep.store.energy, initialBuffer = container.store.energy;
    const ticks = interval * 4;
    let transfers = 0;
    for (let index = 0; index < ticks; index++) {
        const result = w.tick();
        assert.equal(result.amount, batch, 'every productive tick must fit the complete native harvest batch');
        if (result.sent > 0) { transfers++; assert.equal(result.sent, batch * interval); }
    }
    assert.equal(transfers, 4);
    assert.equal(container.store.energy - initialBuffer, batch * ticks);
    assert.equal(w.creep.store.energy, initialEnergy);
});

test('boosted WORK batches use actual harvest power, and damage invalidates the cached rate', () => {
    const w = world({ work: 1, workBoost: 'XUHO2', energy: 14 });
    const container = w.structure('container', 'container', 10, 11);
    assert.deepEqual(w.tick(), { amount: 14, sent: 0 });
    assert.deepEqual(w.tick(), { amount: 14, sent: 28 });
    w.creep.body[0].hits = 0;
    assert.deepEqual(w.tick(), { amount: 0, sent: 14 });
    assert.deepEqual(w.actions.map(action => action.type), ['transfer']);
    assert.equal(container.store.energy, 42);
    w.creep.body[0].hits = 100;
    assert.deepEqual(w.tick(), { amount: 14, sent: 0 });
});

test('mixed damaged WORK recomputes the unload threshold while healthy miners reuse their boost analysis', () => {
    const w = world({ energy: 40 }); w.structure('container', 'container', 10, 11);
    const api = w.loader.load('creep/stationaryMining');
    let boostReads = 0;
    Object.defineProperty(w.creep.body[0], 'boost', { get() { boostReads++; return undefined; } });
    for (let index = 0; index < 4; index++) { api.runStationaryMining(w.creep, w.source); w.game.time++; }
    assert.equal(boostReads, 1, 'stable bodies are not reanalysed every tick');
    w.creep.body[3].hits = 0; w.creep.body[4].hits = 0;
    w.creep.store.energy = 30;
    w.actions.length = 0;
    assert.deepEqual(w.tick(), { amount: 6, sent: 0 });
    assert.equal(boostReads, 3, 'damage causes one fresh analysis; native intent resolution reads the boost once more');
    assert.equal(w.creep.store.energy, 36);
});

test('mixed boosted and unboosted active WORK contributes its exact combined harvest batch', () => {
    const w = world({ work: 3, energy: 18 }); w.structure('container', 'container', 10, 11);
    w.creep.body[0].boost = 'XUHO2';
    assert.deepEqual(w.tick(), { amount: 18, sent: 18 });
    w.creep.body[0].hits = 0;
    assert.deepEqual(w.tick(), { amount: 4, sent: 0 });
    assert.equal(w.creep.store.energy, 22);
});

test('stable-name phases spread sixteen miners across four ticks without extra steady transfers or lost production', () => {
    const worlds = Array.from({ length: 16 }, (_, index) => {
        const w = world({ name: `miner-${String.fromCharCode(97 + index)}` });
        w.buffer = w.structure('container', 'container', 10, 11);
        for (let tick = 0; tick < 4; tick++) assert.equal(w.tick().amount, 10);
        w.initialBuffer = w.buffer.store.energy; w.initialCargo = w.creep.store.energy;
        w.harvests = 0; w.transfers = 0;
        return w;
    });
    const transfersPerTick = [];
    for (let tick = 0; tick < 120; tick++) {
        let transfers = 0;
        for (const w of worlds) {
            const result = w.tick(); assert.equal(result.amount, 10);
            w.harvests++;
            if (result.sent) { assert.equal(result.sent, 40); transfers++; w.transfers++; }
        }
        transfersPerTick.push(transfers);
    }
    assert.equal(Math.max(...transfersPerTick), 4, 'the old synchronized batch peak was sixteen transfers');
    assert.equal(Math.min(...transfersPerTick), 4);
    for (const w of worlds) {
        assert.equal(w.harvests, 120); assert.equal(w.transfers, 30);
        assert.equal(w.buffer.store.energy - w.initialBuffer, 1200);
        assert.equal(w.creep.store.energy, w.initialCargo);
    }
});

test('capacity safety overrides a later name phase, then realigns once without recurring extra transfer intents', () => {
    const w = world({ name: 'miner-b', energy: 40 }); w.structure('container', 'container', 10, 11);
    assert.deepEqual(w.tick(), { amount: 10, sent: 40 }, 'phase three must not delay a necessary phase-one transfer');
    assert.deepEqual(w.tick(), { amount: 10, sent: 0 });
    assert.deepEqual(w.tick(), { amount: 10, sent: 20 }, 'one initial short batch aligns the miner to its stable phase');
    const initialCargo = w.creep.store.energy;
    let transfers = 0;
    for (let tick = 0; tick < 20; tick++) {
        const result = w.tick(); assert.equal(result.amount, 10);
        if (result.sent) { assert.equal(result.sent, 40); transfers++; }
    }
    assert.equal(transfers, 5); assert.equal(w.creep.store.energy, initialCargo);
});

test('a transfer does not create snapshot capacity for an oversized harvest; a final partial source batch still fits', () => {
    const w = world({ energy: 45 }); const container = w.structure('container', 'container', 10, 11);
    assert.deepEqual(w.tick(), { amount: 0, sent: 45 });
    assert.deepEqual(w.actions.map(action => action.type), ['transfer']);
    w.creep.store.energy = 45; w.source.energy = 5;
    assert.deepEqual(w.tick(), { amount: 5, sent: 45 });
    assert.deepEqual(w.actions.map(action => action.type), ['transfer', 'harvest']);
    assert.equal(w.creep.store.energy, 5);
    assert.deepEqual(w.tick(), { amount: 0, sent: 5 });
    assert.equal(container.store.energy, 95);
});

test('a new miner moves to the source/buffer intersection even when its old ready flag is true', () => {
    const w = world({ x: 9, y: 10 }); const link = w.structure('link', 'link', 12, 10);
    assert.equal(w.behavior.prepare(w.creep), false);
    const move = w.actions[0];
    assert.equal(move.type, 'move'); assert.equal(move.range, 0);
    const seat = w.p(move.x, move.y);
    assert.equal(seat.isNearTo(w.source), true); assert.equal(seat.isNearTo(link), true);
    assert.equal(w.creep.memory.ready, false);
    w.creep.pos = seat; w.actions.length = 0;
    assert.equal(w.behavior.prepare(w.creep), true); w.behavior.source(w.creep);
    assert.deepEqual(w.actions.map(action => action.type), ['harvest']);
});

test('station resolution shares the room index and prepare/run lookup', () => {
    const w = world();
    for (let index = 0; index < 5; index++) w.structure(`distant-${index}`, 'link', 30 + index, 30);
    const link = w.structure('source-link', 'link', 11, 11);
    for (let index = 0; index < 19; index++) w.tick();
    assert.equal(w.room.links.reduce((sum, value) => sum + value.activeChecks, 0), 19 * 6);
    assert.equal(link.activeChecks, 19);
});

test('Link station caches observe live Store and discard obsolete Container duties while positions move', () => {
    const w = world({ energy: 40 }); const link = w.structure('link', 'link', 11, 11);
    const container = w.structure('container', 'container', 10, 11);
    assert.equal(w.behavior.prepare(w.creep), true);
    link.store.energy = 800;
    w.behavior.source(w.creep);
    assert.deepEqual(w.actions.map(action => action.type), ['harvest']);
    assert.equal(container.store.energy, 0);
    assert.equal(link.activeChecks, 1);
    w.actions.length = 0; container.hits = 5000;
    w.behavior.source(w.creep);
    assert.deepEqual(w.actions.map(action => action.type), ['harvest']);
    assert.equal(link.activeChecks, 1, 'live Store/hits do not rebuild geometry');
    link.store.energy = 700; w.actions.length = 0;
    w.behavior.source(w.creep);
    assert.equal(w.actions.find(action => action.type === 'transfer').target, link);
    w.actions.length = 0; w.creep.pos.x = 15;
    assert.equal(w.behavior.prepare(w.creep), false); assert.equal(w.actions[0].type, 'move');
    assert.equal(link.activeChecks, 1, 'position changes reuse the room Link index');
    w.creep.pos = w.p(10, 11); w.actions.length = 0;
    assert.equal(w.behavior.prepare(w.creep), true); assert.equal(link.activeChecks, 1);
});

test('station caches never retain old source/room objects or inactive links across ticks and shards', () => {
    const w = world(); const oldLink = w.structure('link', 'link', 11, 11);
    assert.equal(w.behavior.prepare(w.creep), true);
    const replacement = { ...oldLink, activeChecks: 0, isActive() { this.activeChecks++; return false; } };
    w.room.links = [replacement]; w.room.structures = [replacement];
    const container = w.structure('container', 'container', 10, 11);
    const source = { ...w.source }; w.room.sources = [source]; w.objects.set(source.id, source);
    const room = { ...w.room }; w.creep.room = room;
    w.game.time++; w.creep.store.energy = 40; w.actions.length = 0;
    assert.equal(w.behavior.prepare(w.creep), true); w.behavior.source(w.creep);
    assert.equal(w.actions.find(action => action.type === 'transfer').target, container);
    assert.equal(oldLink.activeChecks, 1); assert.equal(replacement.activeChecks, 1);
    w.game.shard.name = 'shard2'; w.actions.length = 0;
    assert.equal(w.behavior.prepare(w.creep), true); w.behavior.source(w.creep);
    assert.equal(replacement.activeChecks, 2, 'same-tick shard switches discard the old station cache');
});

test('a replacement creep with the same name and a new native ID cannot reuse the previous harvest rate', () => {
    const w = world({ energy: 40 }); w.structure('container', 'container', 10, 11);
    const api = w.loader.load('creep/stationaryMining');
    api.runStationaryMining(w.creep, w.source);
    const body = w.creep.body.map(part => ({ ...part })); body[0].boost = 'UO';
    const replacement = { ...w.creep, id: 'miner-newborn', body,
        getActiveBodyparts: type => body.filter(part => part.type === type && part.hits > 0).length };
    w.actions.length = 0;
    api.runStationaryMining(replacement, w.source);
    assert.deepEqual(w.actions.map(action => action.type), ['transfer'], '14 harvest power cannot fit the initial 10 free capacity');
});

test('station selection avoids occupied, natural, wall and blocking structure tiles', () => {
    const w = world({ x: 15, y: 10 }); const link = w.structure('link', 'link', 12, 10);
    w.occupants.push({ name: 'other', pos: w.p(11, 9) }); w.walls.add('11,10');
    assert.equal(w.behavior.prepare(w.creep), false);
    assert.deepEqual(w.actions[0], { type: 'move', x: 11, y: 11, roomName: w.room.name, range: 0 });
    w.actions.length = 0; w.structure('blocking', 'spawn', 11, 11);
    w.walls.add('11,9');
    w.game.time++; assert.equal(w.behavior.prepare(w.creep), false);
    assert.equal(w.actions[0].range, undefined, 'no shared seat falls back to ordinary source approach');
    assert.equal(w.actions[0].x, w.source.pos.x); assert.equal(w.actions[0].y, w.source.pos.y);
    assert.equal(link.store.energy, 0);
});

test('moving miners reserve different still-empty seats in the same tick', () => {
    const w = world({ x: 15, y: 10 }); w.structure('link', 'link', 12, 10);
    assert.equal(w.behavior.prepare(w.creep), false); const first = w.actions[0];
    const second = { ...w.creep, name: 'second', memory: { ...w.creep.memory }, pos: w.p(15, 10),
        moveTo(target, options) { w.actions.push({ type: 'second-move', x: target.x, y: target.y, range: options.range }); return 0; } };
    w.occupants.push(second); assert.equal(w.behavior.prepare(second), false);
    const next = w.actions[1]; assert.notDeepEqual([next.x, next.y], [first.x, first.y]);
});

test('temporarily occupied source/buffer seats wait instead of creating a second container or stealing a seat', () => {
    const w = world({ remote: true, x: 9, y: 10, energy: 50 }); w.structure('link', 'link', 12, 10);
    for (const y of [9, 10, 11]) w.occupants.push({ name: `occupant-${y}`, pos: w.p(11, y) });
    assert.equal(w.behavior.prepare(w.creep), false); assert.equal(w.creep.memory.ready, false);
    w.creep.memory.working = true; assert.equal(w.behavior.target(w.creep), true);
    assert.deepEqual(w.actions, []);
    w.occupants.pop(); w.game.time++;
    assert.equal(w.behavior.prepare(w.creep), false);
    assert.deepEqual(w.actions[0], { type: 'move', x: 11, y: 11, roomName: w.room.name, range: 0 });
});

test('a full source Link keeps cargo and pauses instead of feeding its obsolete Container or dropping', () => {
    const w = world({ energy: 40 }); const link = w.structure('link', 'link', 11, 11, { energy: 800 });
    const container = w.structure('container', 'container', 10, 11);
    assert.deepEqual(w.tick(), { amount: 10, sent: 0 }); assert.equal(container.store.energy, 0);
    for (let index = 0; index < 4; index++) assert.deepEqual(w.tick(), { amount: 0, sent: 0 });
    assert.equal(w.creep.store.energy, 50); assert.deepEqual(w.actions, []);
    container.store.energy = 1950; assert.deepEqual(w.tick(), { amount: 0, sent: 0 });
    link.store.energy = 750; assert.deepEqual(w.tick(), { amount: 0, sent: 50 });
    assert.equal(w.creep.store.energy, 0, 'transfer creates capacity only when native intents resolve');
    assert.equal(container.store.energy, 1950);
    link.store.energy = 700; assert.deepEqual(w.tick(), { amount: 10, sent: 0 });
});

test('container decay prevention occupies the WORK tick; ordinary minor damage does not interrupt harvesting', () => {
    const w = world(); const container = w.structure('container', 'container', 10, 11, { hits: 5000 });
    assert.deepEqual(w.tick(), { amount: 0, sent: 0 });
    assert.deepEqual(w.actions.map(action => action.type), ['repair']); assert.equal(container.hits, 5500);
    assert.deepEqual(w.tick(), { amount: 10, sent: 0 });
    assert.deepEqual(w.actions.map(action => action.type), ['harvest']);
});

test('an empty remote miner refills from a critically decayed container while its source regenerates, then repairs', () => {
    const w = world({ remote: true, energy: 0 }); w.source.energy = 0;
    const container = w.structure('container', 'container', 10, 11, { hits: 5000, energy: 100 });
    assert.deepEqual(w.tick(), { amount: 0, sent: 0 });
    assert.deepEqual(w.actions.map(action => action.type), ['withdraw']); assert.equal(w.creep.store.energy, 50);
    assert.deepEqual(w.tick(), { amount: 0, sent: 0 });
    assert.deepEqual(w.actions.map(action => action.type), ['repair']); assert.equal(container.hits, 5500);
});

test('a depleted source still deposits its last carried batch without an invalid harvest', () => {
    const w = world(); const container = w.structure('container', 'container', 10, 11); w.source.energy = 0;
    assert.deepEqual(w.tick(), { amount: 0, sent: 10 }); assert.equal(container.store.energy, 10);
    assert.deepEqual(w.actions.map(action => action.type), ['transfer']);
});

for (const remote of [false, true]) test(`${remote ? 'remote' : 'local'} new miner without a buffer retains bootstrap build and container creation`, () => {
    const w = world({ remote, level: remote ? 1 : 6, energy: 50 });
    // Disable development for the local bootstrap regression, rather than changing its own behavior.
    w.room.memory.fastUpgrade = false;
    const site = { id: 'site', my: true, pos: w.p(10, 11) }; w.objects.set(site.id, site); w.room.constructionSites.push(site);
    w.creep.memory.working = true; assert.equal(w.behavior.prepare(w.creep), true); w.behavior.target(w.creep);
    assert.deepEqual(w.actions.map(action => action.type), ['build']);
    w.room.constructionSites.length = 0; w.objects.delete(site.id); w.actions.length = 0;
    w.behavior.target(w.creep);
    assert.equal(w.actions[0].type, 'create'); assert.equal(w.actions[0].structureType, 'container');
    assert.equal(w.room.memory.needUpdateCache, true);
});

for (const remote of [false, true]) test(`${remote ? 'remote' : 'RCL8'} legacy miner keeps its existing fill/target phase behavior`, () => {
    const w = world({ remote, marked: false, energy: 50 }); w.structure('container', 'container', 10, 11);
    assert.equal(w.behavior.source(w.creep), false); assert.equal(w.creep.memory.working, true); assert.deepEqual(w.actions, []);
    assert.equal(w.behavior.target(w.creep), true); assert.deepEqual(w.actions.map(action => action.type), ['transfer']);
    w.creep.store.energy = 0; w.actions.length = 0;
    assert.equal(w.behavior.target(w.creep), false); assert.equal(w.creep.memory.working, false); assert.deepEqual(w.actions, []);
});

test('remote source disappearance safely returns to preparation in both marker modes', () => {
    for (const marked of [false, true]) {
        const w = world({ remote: true, marked }); w.objects.delete(w.source.id);
        assert.equal(w.behavior.prepare(w.creep), false); assert.equal(w.creep.memory.ready, false);
        w.creep.memory.ready = true; assert.equal(w.behavior.source(w.creep), false); assert.equal(w.creep.memory.ready, false);
        if (marked) assert.equal(w.behavior.target(w.creep), false);
        assert.deepEqual(w.actions, []);
    }
});

test('development emergency recovery remains ahead of the new workstation branch', () => {
    const w = world({ level: 3, energy: 50 }); w.room.find = () => [];
    const spawn = w.structure('spawn', 'spawn', 15, 15, { capacity: 300 }); w.room.spawns.push(spawn);
    w.structure('container', 'container', 10, 11);
    assert.equal(w.behavior.prepare(w.creep), true); w.behavior.source(w.creep);
    assert.deepEqual(w.actions.map(action => action.type), ['transfer', 'move']);
    assert.equal(w.actions[0].target, spawn);
});

test('stationary mining imports before Game is installed', () => {
    const loader = createSourceLoader(); const api = loader.load('creep/stationaryMining');
    assert.equal(typeof api.prepareStationaryMining, 'function'); assert.equal(typeof api.runStationaryMining, 'function');
});

for (const remote of [false, true]) for (const marked of [false, true]) test(
    (remote ? 'manual remote' : 'local') + ' ' + (marked ? 'new' : 'legacy') + ' Link miner releases an incompatible zero-CARRY body before a replacement arrives', () => {
        const w=world({remote, marked, x:11, y:11, carry:0, energy:0});
        w.structure('link','link',12,12);
        w.structure('old-container','container',11,11,{hits:100,energy:200});
        w.room.constructionSites.push({id:'site', my:true, structureType:'container', pos:w.p(11,11)});
        const homeName=remote?'W2N1':w.room.name;
        const spawn={pos:w.p(20,20,homeName),recycleCreep(creep){w.actions.push({type:'recycle',name:creep.name});return 0;}};
        const home=remote?{name:homeName,spawns:[spawn]}:w.room; home.spawns=[spawn]; w.game.rooms[homeName]=home;
        w.creep.memory.spawnRoom=homeName; w.creep.memory.dontPullMe=true;
        assert.equal(w.behavior.prepare(w.creep),false);
        assert.equal(w.creep.memory.ready,false); assert.equal(w.creep.memory.working,false); assert.equal(w.creep.memory.dontPullMe,false);
        assert.deepEqual(w.actions.map(action=>action.type),['move']); assert.equal(w.actions[0].roomName,homeName);
        assert.equal(w.actions[0].x,20); assert.equal(w.actions[0].range,1);
        w.objects.delete(w.source.id); w.creep.room=home; w.creep.pos=w.p(19,20,homeName); w.actions.length=0; w.game.time++;
        assert.equal(w.behavior.prepare(w.creep),false);
        assert.deepEqual(w.actions,[{type:'recycle',name:w.creep.name}],'persistent retirement survives loss of Source vision');
    });

for (const remote of [false,true]) test((remote?'manual remote':'legacy local')+' unmarked CARRY Link miner uses its Source/Link intersection without repairing, building or recreating a Container',()=>{
    const w=world({remote,marked:false,x:9,y:10,energy:40}); const link=w.structure('link','link',12,12);
    const container=w.structure('old-container','container',10,11,{hits:100});
    w.room.constructionSites.push({id:'site',my:true,structureType:'container',pos:w.p(10,11)});
    assert.equal(w.behavior.prepare(w.creep),false); assert.deepEqual(w.actions,[{type:'move',x:11,y:11,roomName:w.room.name,range:0}]);
    w.creep.pos=w.p(11,11); w.actions.length=0; w.game.time++; w.creep.memory.working=true;
    assert.equal(w.behavior.prepare(w.creep),true); assert.equal(w.behavior.target(w.creep),true);
    assert.deepEqual(w.actions.map(action=>action.type),['transfer','harvest']); assert.equal(w.actions[0].target,link); assert.equal(container.hits,100);
    link.store.energy=800; w.creep.store.energy=50; w.actions.length=0; w.game.time++;
    assert.equal(w.behavior.source(w.creep),true); assert.deepEqual(w.actions,[]);
    w.room.containers.length=0; w.room.constructionSites.length=0; w.game.time++;
    assert.equal(w.behavior.target(w.creep),true); assert.deepEqual(w.actions,[]);
});

test('developing unmarked CARRY miner follows its usable Link without an emergency-carrier scan',()=>{
    const w=world({level:6,marked:false,energy:40}); const link=w.structure('link','link',11,11);
    const container=w.structure('old-container','container',10,11,{hits:100});
    w.room.constructionSites.push({id:'site',my:true,structureType:'container',pos:w.p(10,11)});
    assert.equal(w.behavior.prepare(w.creep),true); assert.equal(w.behavior.source(w.creep),true);
    assert.deepEqual(w.actions.map(action=>action.type),['transfer','harvest']); assert.equal(w.actions[0].target,link); assert.equal(container.hits,100);
});

test('zero-CARRY miner yields its unique Link seat while its home Spawn is busy',()=>{
    const w=world({carry:0,energy:0,x:11,y:11}); w.structure('link','link',12,12);
    const spawn={pos:w.p(12,11),recycleCreep(){w.actions.push({type:'recycle-busy'});return -4;}}; w.room.spawns=[spawn];
    assert.equal(w.behavior.prepare(w.creep),false);
    assert.deepEqual(w.actions.map(action=>action.type),['recycle-busy','move']);
    const destination=w.p(w.actions[1].x,w.actions[1].y); assert.equal(destination.isNearTo(w.source),false); assert.equal(w.actions[1].range,0);
});

test('zero-CARRY miner yields the Link workstation even when no home Spawn exists',()=>{
    const w=world({carry:0,energy:0,x:11,y:11}); w.structure('link','link',12,12);
    assert.equal(w.behavior.prepare(w.creep),false);
    assert.deepEqual(w.actions.map(action=>action.type),['move']);
    assert.equal(w.p(w.actions[0].x,w.actions[0].y).isNearTo(w.source),false);
});

for (const invalid of ['enemy','inactive','distant','blocked']) test('zero-CARRY miner retains Container mining when the candidate Link is '+invalid,()=>{
    const w=world({carry:0,energy:0,x:10,y:11});
    w.structure('container','container',10,11); w.structure('link','link',invalid==='distant'?13:12,invalid==='blocked'?12:10,
        {my:invalid!=='enemy',active:invalid!=='inactive'});
    if(invalid==='blocked') w.walls.add('11,11');
    const api=w.loader.load('creep/sourceLinkMining'); assert.equal(api.sourceLinkMinerIncompatible(w.creep,w.source),false);
    assert.equal(w.behavior.prepare(w.creep),true); assert.equal(w.behavior.source(w.creep),true);
    assert.deepEqual(w.actions.map(action=>action.type),['harvest']); assert.equal(w.creep.memory.sourceLinkRetiring,undefined);
});

test('compatible CARRY miners do not scan Link geometry in the incompatibility predicate',()=>{
    let reads=0;
    const loader=createSourceLoader({globals:{RESOURCE_ENERGY:'energy'},modules:{'room/sourceLinks':{sourceLink(){reads++;throw new Error('unexpected scan');}}}});
    assert.equal(loader.load('creep/sourceLinkMining').sourceLinkMinerIncompatible({store:{getCapacity:()=>50}},{}),false);
    assert.equal(reads,0);
});
