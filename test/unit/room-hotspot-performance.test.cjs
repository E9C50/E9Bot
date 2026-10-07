const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const { world: resourceWorld } = require('../helpers/resource-world.cjs');

function roomLoader(globals = {}, modules = {}) {
    return createSourceLoader({ globals: { Game: { time: 1, shard: { name: 'shard3' }, rooms: {}, flags: {} }, Memory: { warMode: {} },
        RESOURCE_ENERGY: 'energy', RESOURCE_GHODIUM: 'G', TOWER_ENERGY_COST: 10, OK: 0,
        STRUCTURE_TOWER: 'tower', STRUCTURE_LAB: 'lab', STRUCTURE_STORAGE: 'storage', STRUCTURE_TERMINAL: 'terminal', LOOK_STRUCTURES: 'structures',
        console: { log() {} }, ...globals }, modules: {
        'settings/roomPolicy': { roomPolicy: { flags: { repairTower: 'repairTower' },
            defense: { minimumRoadDamage: 200, minimumRoadDamageFraction: 0.05, criticalRoadHealthFraction: 0.5 } } },
        'settings/room': { roomSignTextList: [] }, ...modules } });
}

test('eleven tower repairs inspect eleven first damaged roads instead of building eleven complete damaged lists', () => {
    const loader = roomLoader(), repair = loader.load('room/defense').repairStructure;
    let hitReads = 0, repairs = 0;
    const rooms = Array.from({ length: 11 }, (_, roomIndex) => {
        const roads = Array.from({ length: 300 }, (_, index) => ({ id: `${roomIndex}:${index}`, hitsMax: 100,
            get hits() { hitReads++; return index === 0 ? 90 : 100; } }));
        return { name: `W${roomIndex + 1}N1`, roads, towers: [{ store: { energy: 100 }, repair: target => { assert.equal(target, roads[0]); repairs++; } }],
            get extensions() { throw new Error('a road target already exists'); },
            get structuresNeedRepair() { throw new Error('a tower does not need the full list'); } };
    });
    for (const room of rooms) room.roads.filter(structure => structure.hits < structure.hitsMax);
    assert.equal(hitReads, 3300, 'previous full-list selection scans every road');
    hitReads = 0;
    for (const room of rooms) repair(room);
    assert.equal(hitReads, 11);
    assert.equal(repairs, 11, 'all existing repair intents are preserved');
});

test('tower selection preserves group priority and reads fresh hits while war and empty energy avoid scans', () => {
    const loader = roomLoader(), repair = loader.load('room/defense').repairStructure, selected = [];
    const road = { id: 'road', hits: 100, hitsMax: 100 }, extension = { id: 'extension', hits: 50, hitsMax: 100 };
    const tower = { id: 'tower', hits: 50, hitsMax: 100, store: { energy: 10 }, repair: target => selected.push(target.id) };
    const room = { name: 'W1N1', roads: [road], extensions: [extension], spawns: [], towers: [tower], labs: [], containers: [], links: [] };
    repair(room); road.hits = 20; loader.globals.Game.time++; repair(room);
    assert.deepEqual(selected, ['extension', 'road']);
    tower.store.energy = 9;
    Object.defineProperty(room, 'roads', { get() { throw new Error('cannot pay for an intent'); } });
    repair(room);
    loader.globals.Memory.warMode[room.name] = true;
    Object.defineProperty(room, 'towers', { get() { throw new Error('war exits before tower access'); } });
    repair(room);
    assert.equal(selected.length, 2);
});

function roadRepairWorld(overrides = {}) {
    const policy = { minimumRoadDamage: 200, minimumRoadDamageFraction: 0.05, criticalRoadHealthFraction: 0.5, ...overrides };
    const loader = roomLoader({}, { 'settings/roomPolicy': { roomPolicy: { defense: policy } } });
    const selected = [];
    const room = { name: 'W1N1', roads: [], extensions: [], spawns: [], labs: [], containers: [], links: [],
        towers: [{ id: 'tower', store: { energy: 100 }, hits: 3000, hitsMax: 3000, repair: target => selected.push(target.id) }] };
    return { room, selected, loader, repair: () => loader.load('room/defense').repairStructure(room),
        nextTick: () => loader.globals.Game.time++ };
}

test('plain road repairs batch one-HP and single-decay damage until the configured two-hundred-hit boundary', () => {
    const w = roadRepairWorld(), road = { id: 'road', hits: 5000, hitsMax: 5000 };
    w.room.roads = [road];
    for (const damage of [1, 100, 199]) {
        road.hits = road.hitsMax - damage; w.repair(); w.nextTick();
        assert.equal(w.selected.length, 0);
    }
    road.hits = 4800; w.repair();
    assert.deepEqual(w.selected, ['road']);
});

test('small road damage never blocks an immediately repairable extension and later eligible roads retain their order', () => {
    const w = roadRepairWorld();
    w.room.roads = [{ id: 'light-road', hits: 4999, hitsMax: 5000 }];
    w.room.extensions = [{ id: 'extension', hits: 999, hitsMax: 1000 }];
    w.repair(); assert.deepEqual(w.selected, ['extension']);
    w.nextTick();
    w.room.roads.push({ id: 'first-eligible', hits: 4800, hitsMax: 5000 }, { id: 'later-eligible', hits: 4000, hitsMax: 5000 });
    Object.defineProperty(w.room, 'extensions', { get() { throw new Error('an eligible road still has priority'); } });
    w.repair(); assert.deepEqual(w.selected, ['extension', 'first-eligible']);
});

test('road eligibility reads current hits every tick and resumes small-damage batching after a repair', () => {
    const w = roadRepairWorld(), road = { id: 'road', hits: 4900, hitsMax: 5000 };
    w.room.roads = [road];
    w.repair(); assert.equal(w.selected.length, 0);
    w.nextTick(); road.hits = 4800; w.repair(); assert.equal(w.selected.length, 1);
    w.nextTick(); road.hits = 4999; w.repair(); assert.equal(w.selected.length, 1);
    w.nextTick(); road.hits = 5000; w.repair(); assert.equal(w.selected.length, 1);
});

test('the fractional road threshold protects small-hit-capacity roads and both batching parameters are configurable', () => {
    const w = roadRepairWorld(), road = { id: 'small-road', hits: 96, hitsMax: 100 };
    w.room.roads = [road]; w.repair(); assert.equal(w.selected.length, 0);
    w.nextTick(); road.hits = 95; w.repair(); assert.deepEqual(w.selected, ['small-road']);
    const tuned = roadRepairWorld({ minimumRoadDamage: 50, minimumRoadDamageFraction: 0.02 });
    tuned.room.roads = [{ id: 'configured-road', hits: 4951, hitsMax: 5000 }];
    tuned.repair(); assert.equal(tuned.selected.length, 0);
    tuned.nextTick(); tuned.room.roads[0].hits = 4950; tuned.repair();
    assert.deepEqual(tuned.selected, ['configured-road']);
});

test('roads at or below fifty percent health bypass the batching threshold immediately', () => {
    const w = roadRepairWorld({ minimumRoadDamage: 10000, minimumRoadDamageFraction: 1 });
    const road = { id: 'critical-road', hits: 2501, hitsMax: 5000 };
    w.room.roads = [road]; w.repair(); assert.equal(w.selected.length, 0);
    w.nextTick(); road.hits = 2500; w.repair(); assert.equal(w.selected.length, 1);
    w.nextTick(); road.hits = 2499; w.repair(); assert.equal(w.selected.length, 2);
});

test('one-hit damage on containers and other structure groups remains immediately repairable', () => {
    for (const [key, hitsMax] of [['extensions', 1000], ['spawns', 5000], ['towers', 3000], ['labs', 500], ['containers', 250000], ['links', 1000],
        ['storage', 10000], ['terminal', 3000], ['factory', 1000], ['nuker', 1000], ['observer', 500], ['extractor', 500], ['powerSpawn', 5000]]) {
        const w = roadRepairWorld(), structure = { id: key, hits: hitsMax - 1, hitsMax };
        if (Array.isArray(w.room[key])) {
            if (key === 'towers') Object.assign(w.room.towers[0], structure);
            else w.room[key] = [structure];
        } else w.room[key] = structure;
        w.repair(); assert.deepEqual(w.selected, [key], `${key} retains immediate repair`);
    }
});

test('batching removes twenty-two tiny road intents across eleven peaceful rooms while retaining their later repairs', () => {
    const worlds = Array.from({ length: 11 }, () => roadRepairWorld());
    for (const w of worlds) w.room.roads = [{ id: 'road', hits: 4999, hitsMax: 5000 }];
    for (const w of worlds) { w.repair(); w.nextTick(); w.room.roads[0].hits = 4900; w.repair(); }
    assert.equal(worlds.reduce((count, w) => count + w.selected.length, 0), 0);
    for (const w of worlds) { w.nextTick(); w.room.roads[0].hits = 4800; w.repair(); }
    assert.equal(worlds.reduce((count, w) => count + w.selected.length, 0), 11);
});

test('structure initialization calls each hook once without duplicate tower getters or global flag intents', () => {
    const loader = roomLoader(), initialize = loader.load('room/initialization').initializeStructures;
    const calls = [], rooms = [];
    let towerReads = 0;
    for (let index = 0; index < 11; index++) {
        const tower = { id: `tower${index}`, init: () => calls.push(`tower${index}`) };
        const room = { name: `W${index + 1}N1`, memory: { roomStructure: index === 0 ? { towerAllowRepair: 'manual-old-id' } : {} },
            get towers() { towerReads++; return [tower]; },
            labs: [{ init: () => calls.push(`lab${index}`) }], spawns: [{ init: () => calls.push(`spawn${index}`) }], links: [],
            powerSpawn: { init: () => calls.push(`power${index}`) }, nuker: { init: () => calls.push(`nuker${index}`) },
            createFlag() { throw new Error('all rooms cannot share the automatic repairTower flag name'); } };
        rooms.push(room); initialize(room);
    }
    assert.equal(towerReads, 11);
    assert.equal(calls.length, 55);
    assert.deepEqual(calls.slice(0, 5), ['tower0', 'lab0', 'spawn0', 'power0', 'nuker0']);
    assert.equal(rooms[0].memory.roomStructure.towerAllowRepair, 'manual-old-id');
    for (let index = 1; index < 11; index++) assert.equal(rooms[index].memory.roomStructure.towerAllowRepair, `tower${index}`);
});

test('a later manual repairTower flag still overrides the automatic default tower', () => {
    const loader = roomLoader(), room = { name: 'W1N1', memory: { roomStructure: {}, roomPosition: {}, roomLabConfig: {} },
        towers: [{ id: 'first' }], labs: [], spawns: [], links: [] };
    loader.globals.Game.rooms[room.name] = room;
    loader.load('room/initialization').initializeStructures(room);
    assert.equal(room.memory.roomStructure.towerAllowRepair, 'first');
    let removed = 0;
    loader.globals.Game.flags.repairTower = { pos: { roomName: room.name, lookFor: () => [{ id: 'manual', structureType: 'tower' }] }, remove: () => removed++ };
    loader.load('room/flags').processRoomFlags();
    assert.equal(room.memory.roomStructure.towerAllowRepair, 'manual');
    assert.equal(removed, 1);
});

function wallsWorld() {
    let structures = [], finds = 0, looks = 0;
    class Room {
        constructor(name) { this.name = name; }
        get structures() { return this.structuresGetter(); }
        get ramparts() { return this.rampartsGetter(); }
        get walls() { return this.wallsGetter(); }
        find() { finds++; return structures; }
    }
    const loader = createSourceLoader({ globals: { Room, FIND_STRUCTURES: 'structures', STRUCTURE_ROAD: 'road', STRUCTURE_RAMPART: 'rampart', STRUCTURE_WALL: 'wall' }, modules: {
        'settings/structures': { structurePolicy: { defense: { wallTargetHits: 100 } } },
        'settings/settings': { STRUCTURE_PRIVATEKEY_PERFIX: '_', STRUCTURE_MEMORYKEY_PERFIX: 'IDOF_', creepWhiteList: [] },
        'settings/creep': { roleAdvEnum: { PROCESSER: 'processer' } }, 'utils/CostMatrix': { generateCostMatrix() {} }, utils: { getDistance() {} },
    } });
    loader.globals.W1N1 = { structureIdList: {} };
    const Extension = loader.load('mount/extension/RoomExtension').default;
    function structure(id, structureType, x, hits = 200) {
        return { id, structureType, hits, hitsMax: 1000, pos: { x, y: 10,
            lookFor() { looks++; return structures.filter(item => item.pos.x === x); } } };
    }
    return { structure, setStructures: next => { structures = next; }, createRoom: () => new Extension('W1N1'),
        finds: () => finds, looks: () => looks, resetLooks: () => { looks = 0; } };
}

test('wall repair eligibility preserves uncovered/covered rules and uses zero native position lookups', () => {
    const w = wallsWorld();
    const ramparts = [w.structure('covered', 'rampart', 10), w.structure('road-only', 'rampart', 11),
        w.structure('uncovered', 'rampart', 12), w.structure('low-covered', 'rampart', 10, 50), w.structure('full', 'rampart', 13, 1000)];
    const walls = [w.structure('low-wall', 'wall', 14, 50), w.structure('high-wall', 'wall', 15)];
    w.setStructures([...ramparts, ...walls, w.structure('storage', 'storage', 10), w.structure('road', 'road', 11)]);
    const previous = [...ramparts, ...walls].filter(item => {
        const wanted = item.structureType === 'rampart' ? item.hits < 100 || !item.pos.lookFor().some(cover => cover.structureType !== 'road' && cover.structureType !== 'rampart') : item.hits < 100;
        return item.hits < item.hitsMax && wanted;
    });
    assert.equal(w.looks(), 4, 'previous eligibility asks the engine about every high or full rampart');
    w.resetLooks();
    const room = w.createRoom(), selected = room.wallsNeedRepairGetter();
    assert.deepEqual(Array.from(selected, item => item.id), previous.map(item => item.id));
    assert.deepEqual(Array.from(selected, item => item.id), ['road-only', 'uncovered', 'low-covered', 'low-wall']);
    assert.equal(room.wallsNeedRepairGetter(), selected);
    assert.equal(w.looks(), 0); assert.equal(w.finds(), 1);
});

test('next-tick wall cover index sees destroyed cover and newly completed structures', () => {
    const w = wallsWorld(), rampart = w.structure('rampart', 'rampart', 10);
    w.setStructures([rampart, w.structure('storage', 'storage', 10)]);
    assert.deepEqual(Array.from(w.createRoom().wallsNeedRepairGetter()), []);
    w.setStructures([rampart]);
    assert.deepEqual(Array.from(w.createRoom().wallsNeedRepairGetter(), item => item.id), ['rampart']);
    w.setStructures([rampart, w.structure('spawn', 'spawn', 10)]);
    assert.deepEqual(Array.from(w.createRoom().wallsNeedRepairGetter()), []);
    assert.equal(w.finds(), 3); assert.equal(w.looks(), 0);
});

function terminalWorld(resources = { X: 100 }, overrides = {}) {
    const game = { time: 30, shard: { name: 'shard3' }, rooms: {}, flags: {} }, memory = { centerStorage: 'W0N0' };
    const queued = [], logs = [];
    const policy = { energyReserve: 50000, centerGhodiumReserve: 6000, maximumSendAmount: 100000,
        energyExportThreshold: 400000, energyImportThreshold: 300000, energyTransferAmount: 50000,
        distributionMinimumLevel: 8, distributionInterval: 30, staggerDistribution: false, logTransfers: false,
        mineralReserve: 10000, refillRatio: 0.8, surplusRatio: 1.2, ...overrides };
    const modules = { 'settings/roomPolicy': { roomPolicy: { terminal: policy } }, 'settings/room': { defaultAutoResource: resources } };
    const globals = { Game: game, Memory: memory, RESOURCE_ENERGY: 'energy', RESOURCE_GHODIUM: 'G', OK: 0, console: { log: line => logs.push(line) } };
    const load = () => createSourceLoader({ globals, modules }).load('room/terminal');
    let api = load();
    function addRoom(name, quantities = {}, options = {}) {
        const room = { name, my: true, level: 8, storage: { store: quantities },
            terminal: { store: { getFreeCapacity: () => 10000 }, cooldown: 1, send: () => -6 },
            memory: { terminalSendJob: {}, terminalAmount: {} },
            getResource() { throw new Error('balance only needs live storage/terminal stores'); },
            sendResource(targetRoom, resourceType, amount) {
                queued.push({ from: name, targetRoom, resourceType, amount });
                this.memory.terminalSendJob[`${name}_${targetRoom}_${resourceType}`] = { targetRoom, resourceType, amount }; return true;
            }, ...options };
        game.rooms[name] = room; return room;
    }
    return { game, memory, queued, logs, policy, addRoom, process: room => api.processTerminalResource(room), reload: () => { api = load(); } };
}

test('ten production recipients share one linear existing-job index and retain every resource promise quietly', () => {
    const resources = Array.from({ length: 40 }, (_, index) => `R${index}`), w = resourceWorld();
    const center = w.room('W0N0', Object.fromEntries(resources.map(resource => [resource, 1000])), { warehouse: true });
    const destinations = Array.from({ length: 10 }, (_, index) => w.room(`W${index + 1}N1`));
    let reads = 0;
    for (let index = 0; index < 100; index++) center.memory.terminalSendJob[`old${index}`] = { targetRoom: 'elsewhere', amount: 100,
        get resourceType() { reads++; return `oldResource${index}`; } };
    for (const room of destinations) Object.values(center.memory.terminalSendJob).map(job => `${job.targetRoom}:${job.resourceType}`);
    assert.equal(reads, 1000, 'the previous per-room center index rebuild reads every old job');
    reads = 0;
    w.planResourceDistribution();
    for (const room of destinations) {
        for (const resource of resources) w.requestRoomResource(room, resource, 100);
        w.processTerminalResource(room);
    }
    assert.ok(reads <= 500, 'existing jobs are read a bounded number of times for the entire empire');
    const jobs = w.jobs().filter(job => job.kind === 'production');
    assert.equal(jobs.length, 400); assert.equal(w.logs.length, 0);
    assert.ok(jobs.every(job => job.from === center.name && job.amount === 100));
});

test('terminal cooldown stages the next complete batch and its fee without attempting a native send', () => {
    const w = resourceWorld(), room = w.room('W1N1', { wire: 5000 }, { cooldown: 10 });
    const target = w.room('W2N2');
    room.terminal.send = () => { throw new Error('cooldown prevents a send'); };
    room.memory.terminalSendJob.wire = { targetRoom: target.name, resourceType: 'wire', amount: 5000 };
    w.processTerminalResource(room);
    assert.equal(room.memory.terminalAmount.energy, 50500);
    assert.equal(room.memory.terminalAmount.wire, 5000);
    assert.equal(room.memory.terminalSendJob.wire.amount, 5000);
    assert.equal(w.sends.length, 0);
});

test('resource suppliers share tick-local room membership while stock stays live and new rooms appear next tick', () => {
    const w = resourceWorld(), donors = Array.from({ length: 3 }, (_, index) => w.room(`W${index + 1}N1`, { energy: 500000 }));
    w.room('W4N1', { energy: 10 }); w.room('W5N1', { energy: 20 });
    let membershipReads = 0;
    for (const room of Object.values(w.game.rooms)) Object.defineProperty(room.controller, 'my', {
        get() { membershipReads++; return true; }
    });
    for (let index = 0; index < 10; index++) assert.equal(w.getResourceRooms().length, 5);
    assert.equal(w.getAvailableResource(donors[0], 'energy'), 500000);
    donors[0].storage.store.energy = 0;
    assert.equal(w.getAvailableResource(donors[0], 'energy'), 0, 'Store quantities are never part of the membership cache');
    assert.equal(membershipReads, 5);
    w.game.time++;
    const newest = w.room('W6N1', { energy: 5 });
    assert.ok(w.getResourceRooms().includes(newest), 'the next tick rebuilds membership');
    assert.equal(w.getResourceRooms().length, 6);
    assert.equal(membershipReads, 10, 'five existing room ownership checks run once again in the new tick');
});

test('successful sends replace pending promises with delivered stock without duplicating same-pair requests', () => {
    const w = resourceWorld(), center = w.room('W0N0', { wire: 0 }, {
        terminal: { energy: 60000, wire: 200 }, cooldown: 0
    }), room = w.room('W1N1');
    center.memory.terminalSendJob.first = { targetRoom: room.name, resourceType: 'wire', amount: 100 };
    center.memory.terminalSendJob.second = { targetRoom: room.name, resourceType: 'wire', amount: 100 };
    w.processTerminalResource(center);
    assert.equal(center.memory.terminalSendJob.first, undefined);
    assert.equal(w.getIncomingResourceAmount(room.name, 'wire'), 100);
    assert.equal(w.projectedResource(room, 'wire'), 200);
    w.requestRoomResource(room, 'wire', 200);
    w.processTerminalResource(center);
    assert.equal(w.sends.length, 1, 'only one native terminal intent is allowed per tick');
    assert.equal(Object.keys(center.memory.terminalSendJob).length, 1);
    w.game.time++;
    center.terminal.store.wire -= 100; center.terminal.store.energy -= 10;
    room.terminal.store.wire = 100;
    w.processTerminalResource(center);
    w.requestRoomResource(room, 'wire', 200);
    assert.equal(w.sends.length, 2);
    assert.equal(w.getIncomingResourceAmount(room.name, 'wire'), 0);
    assert.equal(Object.keys(center.memory.terminalSendJob).length, 0);
});

test('unavailable stock is never promised or logged and new live stock can satisfy the next request', () => {
    const w = resourceWorld(1), center = w.room('W0N0', { wire: 0 }, { warehouse: true }), room = w.room('W1N1');
    w.requestRoomResource(room, 'wire', 100); w.requestRoomResource(room, 'wire', 100);
    assert.equal(w.jobs().length, 0);
    assert.equal(w.getIncomingResourceAmount(room.name, 'wire'), 0);
    assert.equal(w.logs.length, 0);
    center.storage.store.wire = 100;
    w.requestRoomResource(room, 'wire', 100);
    assert.equal(w.getIncomingResourceAmount(room.name, 'wire'), 100);
    assert.equal(w.jobs().length, 1, 'the existing room index still reads current stock');
});

test('one global thirty-tick plan stays idempotent across eleven room calls and a module reload', () => {
    const w = resourceWorld(1), planningTicks = new Set();
    w.room('W0N0', { X: 200000 }, { warehouse: true });
    const rooms = Array.from({ length: 11 }, (_, index) => w.room(`W${index + 1}N1`));
    for (let tick = 1; tick <= 60; tick++) {
        w.game.time = tick; if (tick === 31) w.reload();
        for (const room of rooms) w.planResourceDistribution();
        const jobs = w.jobs().filter(job => job.resourceType === 'X');
        for (const job of jobs) planningTicks.add(job.createdAt);
        if (tick >= 30) {
            assert.equal(jobs.length, 11);
            for (const room of rooms) assert.equal(w.getIncomingResourceAmount(room.name, 'X'), 10000);
        } else assert.equal(jobs.length, 0);
    }
    assert.deepEqual([...planningTicks], [30, 60]);
    w.reload(); w.planResourceDistribution();
    assert.equal(w.jobs().filter(job => job.resourceType === 'X').length, 11,
        'reloading on a distribution tick rebuilds the same promises instead of adding duplicates');
});

test('energy promises preserve the terminal floor and native shipments also reserve their transaction fee', () => {
    const w = resourceWorld(1), donor = w.room('W1N1', { energy: 60000 });
    const first = w.room('W2N2', { energy: 0 }), second = w.room('W3N3', { energy: 0 });
    w.requestRoomResource(first, 'energy', 100000);
    w.requestRoomResource(second, 'energy', 100000);
    assert.ok(w.getOutgoingResourceAmount(donor.name, 'energy') <= 60000);
    assert.ok(w.projectedResource(donor, 'energy') >= 50000);
    const shipment = w.affordableSendAmount(donor, 'energy', first.name, 100000, 80000);
    const fee = w.resourceTransactionCost(donor, first.name, shipment);
    assert.equal(shipment, 27272);
    assert.equal(80000 - shipment - fee, 50000, 'cargo and native fees are both paid above the energy floor');
});
