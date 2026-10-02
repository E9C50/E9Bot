const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world(policyOverrides = {}, bucket = 10000) {
    const objects = new Map(), actions = [], rooms = new Map();
    let roadScans = 0, hitReads = 0, objectReads = 0, extensionReads = 0;
    const game = { time: 3, shard: { name: 'shard3' }, cpu: { bucket }, rooms: {}, creeps: {}, powerCreeps: {},
        getObjectById(id) { objectReads++; return objects.get(id) || null; } };
    const memory = { warMode: {} };
    const policy = { minimumRoadDamage: 200, minimumRoadDamageFraction: 0.05, criticalRoadHealthFraction: 0.5,
        batchRoadRepair: true, roadRepairPowerRatio: 1, lowBucketRoadInspectionInterval: 10,
        roadInspectionBucket: 1000, npcOwners: ['Invader', 'Source Keeper'], invaderOwner: 'Invader',
        enemyScanInterval: 1, notificationInterval: 10, ...policyOverrides };
    const loader = createSourceLoader({ globals: { Game: game, Memory: memory, OK: 0,
        RESOURCE_ENERGY: 'energy', TOWER_ENERGY_COST: 10, TOWER_POWER_REPAIR: 800,
        TOWER_OPTIMAL_RANGE: 5, TOWER_FALLOFF_RANGE: 20, TOWER_FALLOFF: 0.75, STRUCTURE_ROAD: 'road' },
        modules: { 'settings/roomPolicy': { roomPolicy: { defense: policy } } } });
    const api = loader.load('room/defense');
    function road(id, damage = 0, x = 11, hitsMax = 5000, roomName = 'W1N1') {
        let hits = hitsMax - damage;
        const value = { id, structureType: 'road', hitsMax, pos: { x, y: 10, roomName },
            get hits() { hitReads++; return hits; }, set hits(next) { hits = next; } };
        objects.set(id, value); return value;
    }
    function addRoom(name = 'W1N1', level = 8) {
        const data = { roads: [] };
        const tower = { id: `${name}:tower`, my: true, pos: { x: 10, y: 10, roomName: name }, hits: 3000, hitsMax: 3000,
            store: { energy: 1000 }, isActive: () => true,
            repair(target) { actions.push({ tick: game.time, room: name, target }); return 0; } };
        const room = { name, memory: {}, controller: { my: true, level }, enemies: [], towers: [tower],
            get roads() { roadScans++; return data.roads; },
            extensions: [{ get hits() { extensionReads++; return 1000; }, hitsMax: 1000 }],
            spawns: [], labs: [], containers: [], links: [] };
        rooms.set(name, data); game.rooms[name] = room; return room;
    }
    return { game, memory, actions, objects, policy, road, addRoom,
        setRoads(room, next) { rooms.get(room.name).roads = next; },
        repair: room => api.repairStructure(room), findEnemies: room => api.findTowerEnemy(room),
        tick: () => game.time++, reads: () => ({ roadScans, hitReads, objectReads, extensionReads }) };
}

test('native repair range batches near roads at 800, far roads at 200, and interpolates without changing tower zero', () => {
    for (const [x, threshold] of [[11, 800], [20, 600], [30, 200], [45, 200]]) {
        const w = world(), room = w.addRoom(), road = w.road('road', threshold - 1, x);
        room.towers.push({ hits: 3000, hitsMax: 3000, store: { energy: 1000 }, repair() { throw new Error('keep the original first tower'); } });
        w.setRoads(room, [road]); w.repair(room); assert.equal(w.actions.length, 0);
        w.tick(); road.hits--; w.repair(room);
        assert.equal(w.actions.length, 1, `range ${x - 10} repairs at ${threshold} damage`);
        assert.equal(w.actions[0].target, road);
    }
});

test('road batching retains the configured floor, optional ratio, disabled behavior, and critical small-road bypass', () => {
    for (const [overrides, hitsMax, before, at] of [
        [{ minimumRoadDamage: 1000, minimumRoadDamageFraction: 1 }, 5000, 999, 1000],
        [{ roadRepairPowerRatio: 0.5 }, 5000, 399, 400],
        [{ batchRoadRepair: false }, 5000, 199, 200],
        [{ roadRepairPowerRatio: 4000 }, 100, 49, 50],
    ]) {
        const w = world(overrides), room = w.addRoom(), road = w.road('road', before, 11, hitsMax);
        w.setRoads(room, [road]); w.repair(room); assert.equal(w.actions.length, 0);
        w.tick(); road.hits = hitsMax - at; w.repair(room); assert.equal(w.actions.length, 1);
    }
});

test('low-bucket eleven-room maintenance reads four full road snapshots over 31 ticks and checks core structures each tick', () => {
    const w = world({}, 1), rooms = Array.from({ length: 11 }, (_, index) => w.addRoom(`W${index + 1}N1`));
    for (const room of rooms) w.setRoads(room, Array.from({ length: 100 }, (_, index) => w.road(`${room.name}:${index}`, 0, 11, 5000, room.name)));
    for (let tick = 0; tick < 31; tick++) { for (const room of rooms) w.repair(room); w.tick(); }
    const reads = w.reads();
    assert.equal(reads.roadScans, 44);
    assert.equal(reads.hitReads, reads.roadScans * 100);
    assert.equal(reads.hitReads, 4400, 'previous per-tick scans read 34,100 road hit values');
    assert.equal(reads.extensionReads, 31 * 11, 'core structure health remains current every tick');
    assert.equal(reads.objectReads, 0, 'healthy roads do not become tracked ID lookups');
    assert.equal(w.actions.length, 0);
});

test('queued repair IDs use replacement native objects immediately and stop looking up healed or destroyed roads', () => {
    const w = world({}, 1), room = w.addRoom();
    w.setRoads(room, [w.road('healing', 800), w.road('destroyed', 800)]); w.repair(room);
    assert.equal(w.actions.length, 1);
    w.tick(); const fresh = w.road('healing', 900);
    w.objects.delete('destroyed'); w.repair(room);
    assert.equal(w.reads().roadScans, 1, 'tracked roads bypass the full road getter');
    assert.equal(w.actions.length, 2);
    assert.equal(w.actions[1].target, fresh, 'no previous-tick GameObject is retained');
    w.tick(); fresh.hits = fresh.hitsMax; w.repair(room);
    const afterRemoval = w.reads().objectReads;
    w.tick(); w.repair(room);
    assert.equal(w.reads().objectReads, afterRemoval, 'healed and vanished IDs are removed');
});

test('queued critical roads repair on the next tick while new peaceful damage is discovered within ten ticks', () => {
    const w = world({}, 1), room = w.addRoom(), known = w.road('known', 800);
    w.setRoads(room, [known]); w.repair(room);
    assert.equal(w.actions.length, 1);
    w.tick(); known.hits = 2500; w.repair(room); assert.equal(w.actions[1].tick, 4);
    known.hits = 5000;
    w.tick(); w.repair(room);
    const newRoad = w.road('new-road', 3000), appearedAt = w.game.time;
    w.setRoads(room, [known, newRoad]);
    for (let tick = 0; tick < 10 && w.actions.length === 2; tick++) { w.tick(); w.repair(room); }
    assert.equal(w.actions.length, 3);
    assert.equal(w.actions[2].target, newRoad);
    assert.ok(w.actions[2].tick - appearedAt <= 10, 'new damage waits only for the bounded peaceful inspection');
});

test('one hundred roads with minor damage perform no per-tick ID lookups and enter the live repair queue within ten ticks of the threshold', () => {
    const w = world({}, 1), room = w.addRoom();
    const roads = Array.from({ length: 100 }, (_, index) => w.road(`road:${index}`, 100));
    w.setRoads(room, roads);
    for (let tick = 0; tick < 31; tick++) { w.repair(room); w.tick(); }
    assert.equal(w.reads().roadScans, 4);
    assert.equal(w.reads().hitReads, 400, 'minor-damage roads only participate in full inspections');
    assert.equal(w.reads().objectReads, 0, 'minor damage does not retain one hundred per-tick lookup targets');
    assert.equal(w.actions.length, 0);
    const reachedAt = w.game.time;
    roads[0].hits = 4200;
    for (let tick = 0; tick < 10 && w.actions.length === 0; tick++) { w.repair(room); w.tick(); }
    assert.equal(w.actions.length, 1);
    assert.equal(w.actions[0].target, roads[0]);
    assert.ok(w.actions[0].tick - reachedAt <= 10);
    const scansBeforeQueuedRepair = w.reads().roadScans;
    roads[0].hits = 2500;
    w.repair(room);
    assert.equal(w.actions.length, 2, 'a queued road uses its current critical health on the next tick');
    assert.equal(w.reads().roadScans, scansBeforeQueuedRepair);
    assert.equal(w.reads().objectReads, 1, 'only the one eligible repair target becomes a live ID lookup');
});

test('non-road damage still repairs between inspections and insufficient energy or an accepted intent avoids all repair scans', () => {
    const w = world({}, 1), room = w.addRoom();
    w.repair(room); w.tick();
    room.extensions = [{ id: 'extension', hits: 999, hitsMax: 1000 }];
    w.repair(room); assert.equal(w.actions[0].target.id, 'extension');
    const afterIntent = w.reads().roadScans;
    room.extensions = [{ get hits() { throw new Error('accepted intent must not be overwritten'); } }];
    w.repair(room); assert.equal(w.actions.length, 1); assert.equal(w.reads().roadScans, afterIntent);
    w.tick(); room.towers[0].store.energy = 9;
    w.repair(room); assert.equal(w.actions.length, 1);
    w.memory.warMode[room.name] = true;
    Object.defineProperty(room, 'towers', { get() { throw new Error('war retains the original maintenance early exit'); } });
    w.repair(room);
});

test('enemy presence and ten ticks after disappearance restore complete road scans; war still reserves towers for defense', () => {
    const w = world({}, 1), room = w.addRoom(); w.repair(room); w.tick();
    room.enemies = [{}]; w.repair(room);
    assert.equal(w.reads().roadScans, 2, 'any detected enemy bypasses peaceful throttling');
    room.enemies = [];
    for (let tick = 0; tick < 10; tick++) { w.tick(); w.repair(room); }
    assert.equal(w.reads().roadScans, 12, 'every tick in the recent-enemy grace period scans fully');
    w.memory.warMode[room.name] = true;
    w.tick(); w.repair(room); assert.equal(w.reads().roadScans, 12);
    w.tick(); w.findEnemies(room); w.repair(room);
    assert.equal(w.memory.warMode[room.name], false);
    assert.equal(w.reads().roadScans, 13, 'cleared war mode retains the enemy grace period');
});

test('bucket recovery, missing mock CPU, RCL7, and non-owned rooms bypass road throttling', () => {
    for (const change of [w => { w.game.cpu.bucket = 1000; }, (w, room) => { room.controller.level = 7; },
        (w, room) => { room.controller.my = false; }, w => { delete w.game.cpu; }]) {
        const w = world({}, 1), room = w.addRoom(); w.repair(room); w.tick(); change(w, room);
        w.setRoads(room, [w.road('new-road', 900)]); w.repair(room);
        assert.equal(w.actions.length, 1); assert.equal(w.reads().roadScans, 2);
    }
});

test('shard changes and tick rollback invalidate pure-ID inspection state', () => {
    for (const change of [w => { w.game.shard.name = 'shard2'; }, w => { w.game.time = 1; }]) {
        const w = world({}, 1), room = w.addRoom(); w.repair(room); w.tick();
        const road = w.road('new-road', 900); w.setRoads(room, [road]); w.repair(room);
        assert.equal(w.actions.length, 0);
        change(w); w.repair(room);
        assert.equal(w.actions.length, 1); assert.equal(w.actions[0].target, road);
        assert.equal(w.reads().roadScans, 2);
    }
});
