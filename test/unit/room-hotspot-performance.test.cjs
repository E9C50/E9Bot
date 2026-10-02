const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

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

test('ten destination rooms index one hundred center jobs once, preserve every transfer, and avoid per-transfer logs', () => {
    const resources = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`R${index}`, 100])), w = terminalWorld(resources);
    const center = w.addRoom('W0N0', Object.fromEntries(Object.keys(resources).map(resource => [resource, 1000])));
    const destinations = Array.from({ length: 10 }, (_, index) => w.addRoom(`W${index + 1}N1`));
    let reads = 0;
    for (let index = 0; index < 100; index++) center.memory.terminalSendJob[`old${index}`] = { targetRoom: 'elsewhere', amount: 100,
        get resourceType() { reads++; return `oldResource${index}`; } };
    for (const room of destinations) Object.values(center.memory.terminalSendJob).map(job => `${job.targetRoom}:${job.resourceType}`);
    assert.equal(reads, 1000, 'the previous per-room center index rebuild reads every old job');
    reads = 0;
    for (const room of destinations) w.process(room);
    assert.equal(reads, 100); assert.equal(w.queued.length, 400); assert.equal(w.logs.length, 0);
    assert.ok(w.queued.every(job => job.from === center.name && job.amount === 100));
});

test('terminal cooldown preserves job reserves without querying capacity or attempting native sends', () => {
    const w = terminalWorld(), room = w.addRoom('W1N1');
    room.terminal.store.getFreeCapacity = () => { throw new Error('cooldown prevents a send'); };
    room.terminal.send = () => { throw new Error('cooldown prevents a send'); };
    room.memory.terminalSendJob.energy = { targetRoom: 'W2N2', resourceType: 'energy', amount: 123 };
    room.memory.terminalSendJob.X = { targetRoom: 'W2N2', resourceType: 'X', amount: 234 };
    w.process(room);
    assert.equal(room.memory.terminalAmount.energy, 50123); assert.equal(room.memory.terminalAmount.X, 234);
});

test('energy exporters share tick-local room membership but re-read live candidate stores and new rooms next tick', () => {
    const w = terminalWorld(), donors = Array.from({ length: 3 }, (_, index) => w.addRoom(`W${index + 1}N1`, { energy: 500000 }));
    const first = w.addRoom('W4N1', { energy: 10 }), second = w.addRoom('W5N1', { energy: 20 });
    let membershipReads = 0;
    for (const room of Object.values(w.game.rooms)) Object.defineProperty(room, 'my', { get() { membershipReads++; return true; } });
    w.process(donors[0]);
    assert.equal(w.queued[0].targetRoom, first.name);
    first.storage.store.energy = 400000;
    w.process(donors[1]); w.process(donors[2]);
    assert.equal(membershipReads, 5, 'three donors use one empire membership index instead of fifteen room ownership reads');
    assert.deepEqual(w.queued.map(job => job.targetRoom), [first.name, second.name, second.name]);
    w.game.time++;
    const newest = w.addRoom('W6N1', { energy: 5 });
    w.process(donors[0]);
    assert.equal(w.queued.at(-1).targetRoom, newest.name, 'the next tick cannot retain a stale room list');
});

test('shared terminal pair counts observe successful job removal and do not duplicate a still-pending pair', () => {
    const w = terminalWorld(), center = w.addRoom('W0N0', { X: 1000 }), room = w.addRoom('W1N1');
    center.terminal.cooldown = 0; center.terminal.store.X = 1000; center.terminal.send = () => 0;
    center.memory.terminalSendJob.first = { targetRoom: room.name, resourceType: 'X', amount: 100 };
    center.memory.terminalSendJob.second = { targetRoom: room.name, resourceType: 'X', amount: 100 };
    w.process(room); assert.equal(w.queued.length, 0);
    w.process(center); w.process(room); assert.equal(w.queued.length, 0, 'one same-pair job remains');
    w.process(center); w.process(room); assert.equal(w.queued.length, 1, 'deleting the last pair allows its next real request');
});

test('failed queue writes are neither logged nor marked pending, and latest Store values are read on the next call', () => {
    const w = terminalWorld({ X: 100 }, { logTransfers: true }), center = w.addRoom('W0N0', { X: 1000 }), room = w.addRoom('W1N1');
    let attempts = 0;
    center.sendResource = () => { attempts++; return false; };
    w.process(room); w.process(room);
    assert.equal(attempts, 2); assert.equal(w.logs.length, 0);
    center.storage.store.X = 0; w.process(room);
    assert.equal(attempts, 2, 'current center resources are not a cached quantity');
    w.game.time++; center.storage.store.X = 1000; w.game.time = 60; w.process(room);
    assert.equal(attempts, 3);
});

test('stable stagger gives each of eleven rooms one distribution every thirty ticks across a module reload', () => {
    const w = terminalWorld({ X: 100 }, { staggerDistribution: true }), schedules = new Map();
    w.addRoom('W0N0', { X: 1000 });
    const rooms = Array.from({ length: 11 }, (_, index) => {
        const name = `W${index + 1}N1`, schedule = []; schedules.set(name, schedule);
        return w.addRoom(name, { get X() { schedule.push(w.game.time); return 0; } });
    });
    for (let tick = 1; tick <= 60; tick++) {
        w.game.time = tick; if (tick === 31) w.reload();
        for (const room of rooms) w.process(room);
    }
    for (const schedule of schedules.values()) { assert.equal(schedule.length, 2); assert.equal(schedule[1] - schedule[0], 30); }
    assert.ok(new Set(Array.from(schedules.values(), schedule => schedule[0])).size > 1, 'distribution no longer runs every room on the same global tick');
});

test('an invalid distribution interval does not delay immediate energy-balancing jobs', () => {
    const w = terminalWorld({ X: 100 }, { distributionInterval: 0, staggerDistribution: true });
    const donor = w.addRoom('W1N1', { energy: 500000 }), recipient = w.addRoom('W2N2', { energy: 10 });
    w.process(donor);
    assert.deepEqual(w.queued, [{ from: donor.name, targetRoom: recipient.name, resourceType: 'energy', amount: 50000 }]);
});
