const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

const structureTypes = ['spawn', 'extension', 'road', 'constructedWall', 'rampart', 'link', 'storage', 'tower', 'observer', 'powerSpawn', 'extractor', 'lab', 'terminal', 'container', 'nuker', 'factory'];

/** Creation stays an intent until advanceTick(), as it does in Screeps. */
function createLayoutWorld({ planner = () => undefined, policy = {} } = {}) {
    const calls = [];
    const plannedRooms = [];
    const pending = [];
    const logs = [];
    const constructionPolicy = {
        enabled: true,
        planning: { minimumBucket: 2000, minimumCpuHeadroom: 150, cpuReserve: 50, maximumCpu: 300, maximumRoomsPerTick: 1, retryInterval: 100, minimumPlaneCount: 140, ...policy.planning },
        building: { interval: 10, maximumNewSitesPerRoom: 5, maximumActiveSitesPerRoom: 10, roadMinimumLevel: 3, rampartMinimumLevel: 4, mineralContainerMinimumLevel: 6, ...policy.building },
        structurePriority: ['spawn', 'tower', 'extension', 'container', 'storage', 'link', 'terminal', 'lab', 'extractor', 'factory', 'powerSpawn', 'observer', 'nuker', 'road', 'rampart', 'constructedWall'],
        ...Object.fromEntries(Object.entries(policy).filter(([key]) => !['planning', 'building'].includes(key)))
    };
    const constants = {
        OK: 0, ERR_INVALID_TARGET: -7, ERR_FULL: -8, ERR_RCL_NOT_ENOUGH: -14,
        FIND_STRUCTURES: 107, FIND_MY_STRUCTURES: 108, FIND_MY_SPAWNS: 112, FIND_CONSTRUCTION_SITES: 111, FIND_MY_CONSTRUCTION_SITES: 114,
        FIND_SOURCES: 105, FIND_MINERALS: 116, LOOK_STRUCTURES: 'structure', LOOK_CONSTRUCTION_SITES: 'constructionSite',
        TERRAIN_MASK_WALL: 1, TERRAIN_MASK_SWAMP: 2, MAX_CONSTRUCTION_SITES: 100, LAB_REACTION_RANGE: 2
    };
    for (const type of structureTypes) {
        const key = type === 'constructedWall' ? 'WALL' : type.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
        constants[`STRUCTURE_${key}`] = type;
    }
    const limits = Object.fromEntries(structureTypes.map(type => [type, { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 }]));
    limits.spawn = { 0: 0, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 2, 8: 3 };
    limits.extension = { 0: 0, 1: 0, 2: 5, 3: 10, 4: 20, 5: 30, 6: 40, 7: 50, 8: 60 };
    for (const type of ['road', 'container']) limits[type] = Object.fromEntries(Array.from({ length: 9 }, (_, level) => [level, level ? (type === 'road' ? 2500 : 5) : 0]));
    for (const type of ['rampart', 'constructedWall']) limits[type] = Object.fromEntries(Array.from({ length: 9 }, (_, level) => [level, level >= 2 ? 2500 : 0]));
    limits.tower = { 0: 0, 1: 0, 2: 0, 3: 1, 4: 1, 5: 2, 6: 2, 7: 3, 8: 6 };
    limits.storage = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1 };
    limits.extractor = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 1, 7: 1, 8: 1 };
    limits.lab = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 3, 7: 6, 8: 10 };
    const game = { time: 1, rooms: {}, flags: {}, constructionSites: {}, cpu: { bucket: 10000, tickLimit: 500, limit: 20, getUsed: () => 0 } };

    class RoomPosition {
        constructor(x, y, roomName) { this.x = x; this.y = y; this.roomName = roomName; }
        lookFor(type) { return game.rooms[this.roomName].lookForAt(type, this.x, this.y); }
        createConstructionSite(type) { return game.rooms[this.roomName].createConstructionSite(this.x, this.y, type); }
        getRangeTo(target) { const pos = target.pos || target; return Math.max(Math.abs(this.x - pos.x), Math.abs(this.y - pos.y)); }
    }

    function item(type, x, y, roomName = 'W1N1', id = `${type}:${x}:${y}`) {
        return { id, structureType: type, my: true, pos: new RoomPosition(x, y, roomName), destroy() { throw new Error('Existing structure must not be destroyed'); }, remove() { throw new Error('Existing site must not be removed'); } };
    }

    function addRoom({ name = 'W1N1', level = 8, structures = [], sites = [], memory = {}, walls = [], result = 0 } = {}) {
        const terrainWalls = new Set(walls.map(([x, y]) => `${x}:${y}`));
        for (const site of sites) site.progressTotal = 500;
        const room = {
            name, my: true, memory: { roomPosition: {}, roomLabConfig: { singleLabConfig: {} }, ...memory }, structures, sites,
            controller: { level, my: true, pos: new RoomPosition(25, 10, name) },
            sources: [{ id: 'sourceA', pos: new RoomPosition(10, 15, name) }, { id: 'sourceB', pos: new RoomPosition(40, 35, name) }],
            mineral: { id: 'mineral', pos: new RoomPosition(35, 40, name) },
            get level() { return this.controller.level; },
            get spawns() { return this.structures.filter(item => item.structureType === 'spawn'); },
            find(type) {
                if (type === constants.FIND_STRUCTURES) return this.structures;
                if (type === constants.FIND_MY_STRUCTURES) return this.structures.filter(item => item.my);
                if (type === constants.FIND_MY_SPAWNS) return this.spawns.filter(item => item.my);
                if (type === constants.FIND_MY_CONSTRUCTION_SITES) return this.sites.filter(site => site.my);
                if (type === constants.FIND_CONSTRUCTION_SITES) return this.sites;
                if (type === constants.FIND_SOURCES) return this.sources;
                if (type === constants.FIND_MINERALS) return [this.mineral];
                return [];
            },
            lookForAt(type, x, y) {
                const items = type === constants.LOOK_STRUCTURES ? this.structures : this.sites;
                return items.filter(item => item.pos.x === x && item.pos.y === y);
            },
            getTerrain() { return { get: (x, y) => terrainWalls.has(`${x}:${y}`) ? 1 : 0 }; },
            createConstructionSite(x, y, type) {
                calls.push({ room: name, x, y, type });
                const code = typeof result === 'function' ? result(x, y, type) : result;
                if (code === 0) pending.push({ room: this, site: { ...item(type, x, y, name, `pending:${pending.length}`), progressTotal: 500 } });
                return code;
            }
        };
        game.rooms[name] = room;
        for (const site of sites) if (site.my) game.constructionSites[site.id] = site;
        return room;
    }

    function advanceTick(time = game.time + 1) {
        for (const { room, site } of pending.splice(0)) {
            room.sites.push(site);
            game.constructionSites[site.id] = site;
        }
        game.time = time;
    }

    return {
        game, constants, limits, calls, plannedRooms, pending, logs, item, addRoom, advanceTick,
        planner(room, options) { plannedRooms.push(room.name); return planner(room, options); }, policy: constructionPolicy,
        load(modules = {}, globals = {}) {
            const loader = createSourceLoader({
                globals: { ...constants, Game: game, Memory: {}, CONTROLLER_STRUCTURES: limits, RoomPosition, console: { log: message => logs.push(message) }, ...globals },
                modules: {
                    'settings/construction': { constructionPolicy },
                    'settings/roomPolicy': { roomPolicy: { flags: { planStructures: 'planRoomStructure' } } },
                    'planning/planner63': { computeRoomBlueprint: (room, options) => { plannedRooms.push(room.name); return planner(room, options); } },
                    ...modules
                }
            });
            return { loader, api: loader.load('planning/automaticLayout') };
        }
    };
}

function blueprint(structures, origin = 'planner63') {
    return { schemaVersion: 1, origin, createdAt: 0, structures, center: [25, 25] };
}

function plannerResult(room, structMap = { spawn: [[20, 20]], storage: [[24, 25]], lab: [[28, 25], [29, 25]] }) {
    return { roomName: room.name, storagePos: { x: 25, y: 25 }, labPos: { x: 28, y: 25 }, structMap };
}

test('stable mature-room inspections skip metadata scans until due and a destroyed Spawn bypasses the interval', () => {
    const world = createLayoutWorld(), spawn = world.item('spawn', 10, 10);
    const room = world.addRoom({ structures: [spawn] }), api = world.load().api;
    api.runAutomaticLayout(room);
    let scans = 0;
    const find = room.find;
    room.find = function(type) { scans++; return find.call(this, type); };
    for (let tick = 2; tick < 11; tick++) { world.advanceTick(tick); api.runAutomaticLayout(room); }
    assert.equal(scans, 0, 'mature metadata and native spawn scans no longer repeat every tick');
    room.structures.length = 0;
    api.runAutomaticLayout(room);
    assert.equal(world.calls.filter(call => call.type === 'spawn').length, 1, 'first-spawn reconstruction starts immediately');
});

test('low-bucket mature inspections spread across rooms and bound reconstruction to 100 ticks', () => {
    const world = createLayoutWorld({ policy: { building: { staggerMatureInspections: true,
        lowBucketInspection: { minimumBucket: 1000, interval: 100 } } } });
    world.game.cpu.bucket = 50;
    const names = ['E31N2', 'E32N2', 'E33N2', 'E34N3', 'E35N3', 'E36N3', 'E37N5', 'E38N5', 'E39N5', 'E41N7', 'E41N8'];
    const rooms = names.map(name => world.addRoom({ name, structures: [world.item('spawn', 10, 10, name)] }));
    const api = world.load().api;
    for (const room of rooms) api.runAutomaticLayout(room);
    const inspections = new Map(names.map(name => [name, []]));
    for (let tick = 2; tick <= 301; tick++) {
        world.advanceTick(tick);
        for (const room of rooms) {
            const previous = room.memory.roomBlueprintState.lastBuildTick;
            api.runAutomaticLayout(room);
            if (room.memory.roomBlueprintState.lastBuildTick !== previous) inspections.get(room.name).push(tick);
        }
    }
    for (const ticks of inspections.values()) {
        assert.ok(ticks.length >= 3 && ticks.length <= 4);
        assert.ok(ticks[0] <= 101);
        for (let index = 1; index < ticks.length; index++) assert.equal(ticks[index] - ticks[index - 1], 100);
    }
    const perTick = new Map();
    for (const ticks of inspections.values()) for (const tick of ticks) perTick.set(tick, (perTick.get(tick) || 0) + 1);
    assert.ok(Math.max(...perTick.values()) < rooms.length, 'mature rooms no longer all inspect on the same tick');
    const room = rooms[0];
    room.memory.roomBlueprint.structures.road = [[11, 10]];
    const last = room.memory.roomBlueprintState.lastBuildTick;
    world.advanceTick(last + 100);
    api.runAutomaticLayout(room);
    assert.equal(world.calls.filter(call => call.room === room.name && call.type === 'road').length, 1);
});

test('normal-bucket mature inspections align room phases without the legacy guard resynchronizing them', () => {
    const world = createLayoutWorld({ policy: { building: { staggerMatureInspections: true } } });
    const names = ['E31N2', 'E34N3', 'E35N1', 'E35N3', 'E36N2', 'E37N7', 'E38N5', 'E38N6', 'E39N6', 'E41N7', 'E41N8'];
    const rooms = names.map(name => world.addRoom({ name, structures: [world.item('spawn', 10, 10, name)] }));
    const api = world.load().api, inspections = new Map(names.map(name => [name, []]));
    for (const room of rooms) api.runAutomaticLayout(room);
    for (let tick = 2; tick <= 41; tick++) {
        world.advanceTick(tick);
        for (const room of rooms) {
            const before = room.memory.roomBlueprintState.lastBuildTick;
            api.runAutomaticLayout(room);
            if (room.memory.roomBlueprintState.lastBuildTick !== before) inspections.get(room.name).push(tick);
        }
    }
    const phases = new Set();
    for (const ticks of inspections.values()) {
        assert.ok(ticks.length >= 4 && ticks.length <= 5);
        phases.add(ticks[0] % 10);
        for (let index = 1; index < ticks.length; index++) assert.equal(ticks[index] - ticks[index - 1], 10);
    }
    assert.ok(phases.size > 1, 'healthy mature rooms must inspect on different phases after warmup');
});

test('mature inspection throttling releases on bucket recovery, enemies, flags, level change and last Spawn loss', () => {
    for (const reason of ['bucket', 'enemy', 'flag', 'level', 'spawn']) {
        const world = createLayoutWorld({ policy: { building: { lowBucketInspection: { minimumBucket: 1000, interval: 100 } } } });
        world.game.cpu.bucket = 20;
        const room = world.addRoom({ structures: [world.item('spawn', 10, 10)] });
        const api = world.load().api; api.runAutomaticLayout(room);
        room.memory.roomBlueprint.structures.road = [[11, 10]];
        world.advanceTick(reason === 'flag' || reason === 'level' || reason === 'spawn' ? 2 : 11);
        if (reason === 'bucket') world.game.cpu.bucket = 1000;
        if (reason === 'enemy') room.enemies = [{}];
        if (reason === 'flag') world.game.flags.planRoomStructure = { pos: { roomName: room.name } };
        if (reason === 'level') room.memory.roomBlueprintState.lastLevel = 7;
        if (reason === 'spawn') room.structures.length = 0;
        api.runAutomaticLayout(room);
        assert.equal(world.calls.some(call => call.type === 'road'), true, reason);
        if (reason === 'spawn') assert.equal(world.calls.some(call => call.type === 'spawn'), true);
    }
});

test('an existing RCL8 room snapshots current structures and own sites without invoking the planner', () => {
    const world = createLayoutWorld({ planner() { throw new Error('Do not replan an existing RCL8 room'); } });
    const spawn = world.item('spawn', 15, 20);
    const road = world.item('road', 16, 20); delete road.my;
    const extensionSite = world.item('extension', 17, 20);
    const duplicateSite = world.item('spawn', 15, 20, 'W1N1', 'duplicate');
    const foreignSite = world.item('extension', 18, 20); foreignSite.my = false;
    const room = world.addRoom({ structures: [spawn, road], sites: [extensionSite, duplicateSite, foreignSite], memory: { customState: { keep: true } } });
    world.game.cpu.bucket = 0;
    const { api } = world.load();
    api.runAutomaticLayout(room);
    assert.equal(room.memory.roomBlueprint.origin, 'snapshot');
    assert.deepEqual(Array.from(room.memory.roomBlueprint.structures.spawn, pair => Array.from(pair)), [[15, 20]]);
    assert.deepEqual(Array.from(room.memory.roomBlueprint.structures.road, pair => Array.from(pair)), [[16, 20]]);
    assert.deepEqual(Array.from(room.memory.roomBlueprint.structures.extension, pair => Array.from(pair)), [[17, 20]]);
    assert.equal(room.memory.customState.keep, true);
    assert.deepEqual(world.plannedRooms, []);
    assert.deepEqual(world.calls, []);
});

test('a saved snapshot remains stable and rebuilds a missing structure at its recorded position', () => {
    const saved = blueprint({ spawn: [[15, 20]], road: [[16, 20]] }, 'snapshot');
    const world = createLayoutWorld();
    const room = world.addRoom({ structures: [world.item('spawn', 15, 20)], memory: { roomBlueprint: saved } });
    const { api } = world.load();
    api.runAutomaticLayout(room);
    assert.equal(room.memory.roomBlueprint, saved);
    assert.deepEqual(world.calls, [{ room: 'W1N1', x: 16, y: 20, type: 'road' }]);
    assert.deepEqual(world.plannedRooms, []);
    world.advanceTick(11);
    api.runAutomaticLayout(room);
    assert.equal(world.calls.length, 1, 'the scheduled site prevents duplicate rebuilding');
});

test('a newly owned room plans once, persists the blueprint, and keeps unrelated room configuration', () => {
    const world = createLayoutWorld({ planner: room => plannerResult(room) });
    const configuredPosition = { x: 6, y: 7, roomName: 'W1N1' };
    const room = world.addRoom({ level: 1, memory: { roomPosition: { managerPos: configuredPosition }, existingJob: { keep: true } } });
    const { api } = world.load();
    api.runAutomaticLayout(room);
    const saved = room.memory.roomBlueprint;
    assert.equal(saved.origin, 'planner63');
    assert.equal(saved.schemaVersion, 1);
    assert.deepEqual(Array.from(saved.center), [25, 25]);
    assert.equal(room.memory.roomPosition.managerPos, configuredPosition);
    assert.equal(room.memory.existingJob.keep, true);
    assert.deepEqual(world.calls, [{ room: 'W1N1', x: 20, y: 20, type: 'spawn' }]);
    world.advanceTick(11);
    api.runAutomaticLayout(room);
    assert.equal(room.memory.roomBlueprint, saved);
    assert.deepEqual(world.plannedRooms, ['W1N1']);
});

test('planning waits for CPU bucket and remaining tick headroom without losing room state', () => {
    for (const capacity of ['bucket', 'headroom']) {
        const world = createLayoutWorld({ planner: room => plannerResult(room) });
        const room = world.addRoom({ level: 1 });
        if (capacity === 'bucket') world.game.cpu.bucket = 1999;
        else world.game.cpu.tickLimit = 149;
        const { api } = world.load();
        api.runAutomaticLayout(room);
        assert.equal(room.memory.roomBlueprint, undefined, capacity);
        assert.deepEqual(world.plannedRooms, [], capacity);
        world.game.cpu.bucket = 10000;
        world.game.cpu.tickLimit = 500;
        world.advanceTick(101);
        api.runAutomaticLayout(room);
        assert.equal(room.memory.roomBlueprint.origin, 'planner63', capacity);
    }
});

test('only one new room is planned per tick and a failed plan is retried after the cooldown', () => {
    const world = createLayoutWorld({ planner: room => plannerResult(room) });
    const first = world.addRoom({ name: 'W1N1', level: 1 });
    const second = world.addRoom({ name: 'W2N2', level: 1 });
    const { api } = world.load();
    api.runAutomaticLayout(first);
    api.runAutomaticLayout(second);
    assert.deepEqual(world.plannedRooms, ['W1N1']);
    assert.equal(second.memory.roomBlueprint, undefined);
    world.advanceTick(2);
    api.runAutomaticLayout(second);
    assert.deepEqual(world.plannedRooms, ['W1N1', 'W2N2']);

    let attempts = 0;
    const failureWorld = createLayoutWorld({ planner(room) { attempts++; if (attempts === 1) throw new Error('planning budget exceeded'); return plannerResult(room); } });
    const recovering = failureWorld.addRoom({ level: 1 });
    const { api: recoveryApi } = failureWorld.load();
    assert.doesNotThrow(() => recoveryApi.runAutomaticLayout(recovering));
    assert.equal(recovering.memory.roomBlueprint, undefined);
    assert.match(recovering.memory.roomBlueprintState.lastError, /planning budget exceeded/);
    failureWorld.advanceTick(2);
    recoveryApi.runAutomaticLayout(recovering);
    assert.equal(attempts, 1);
    failureWorld.advanceTick(101);
    recoveryApi.runAutomaticLayout(recovering);
    assert.equal(attempts, 2);
    assert.equal(recovering.memory.roomBlueprint.origin, 'planner63');
});

test('RCL quotas count existing structures, existing sites, and newly scheduled sites', () => {
    const world = createLayoutWorld({ policy: { building: { maximumNewSitesPerRoom: 20, maximumActiveSitesPerRoom: 20 } } });
    const structures = [world.item('extension', 10, 10), world.item('extension', 11, 10)];
    const sites = [world.item('extension', 12, 10)];
    const room = world.addRoom({ level: 2, structures, sites, memory: { roomBlueprint: blueprint({ extension: [[13, 10], [14, 10], [15, 10], [16, 10]] }) } });
    const { api } = world.load();
    api.runAutomaticLayout(room);
    assert.deepEqual(world.calls.map(call => call.x), [13, 14]);
    world.advanceTick(2);
    room.controller.level = 3;
    api.runAutomaticLayout(room);
    assert.deepEqual(world.calls.map(call => call.x), [13, 14, 15, 16], 'level upgrade releases newly allowed demand');
    world.advanceTick(3);
    room.controller.level = 1;
    api.runAutomaticLayout(room);
    assert.equal(world.calls.length, 4, 'downgrade preserves existing assets and avoids unavailable demand');
});

test('the global site budget counts successful intents across rooms even before Game updates', () => {
    const world = createLayoutWorld();
    for (let index = 0; index < 99; index++) world.game.constructionSites[`existing:${index}`] = {};
    const first = world.addRoom({ name: 'W1N1', level: 3, memory: { roomBlueprint: blueprint({ road: [[10, 10], [11, 10]] }) } });
    const second = world.addRoom({ name: 'W2N2', level: 3, memory: { roomBlueprint: blueprint({ road: [[20, 20]] }) } });
    const { api } = world.load();
    api.runAutomaticLayout(first);
    api.runAutomaticLayout(second);
    assert.deepEqual(world.calls, [{ room: 'W1N1', x: 10, y: 10, type: 'road' }]);
    assert.equal(Object.keys(world.game.constructionSites).length, 99, 'mock preserves scheduled intent timing');
});

test('ERR_FULL stops creation immediately and failed placements do not spend success budgets', () => {
    const fullWorld = createLayoutWorld();
    const fullRoom = fullWorld.addRoom({ level: 3, result: -8, memory: { roomBlueprint: blueprint({ road: [[10, 10], [11, 10], [12, 10]] }) } });
    fullWorld.load().api.runAutomaticLayout(fullRoom);
    assert.equal(fullWorld.calls.length, 1);

    const world = createLayoutWorld({ policy: { building: { maximumNewSitesPerRoom: 1 } } });
    const room = world.addRoom({ level: 3, result: x => x === 10 ? -7 : 0, memory: { roomBlueprint: blueprint({ road: [[10, 10], [11, 10], [12, 10]] }) } });
    world.load().api.runAutomaticLayout(room);
    assert.deepEqual(world.calls.map(call => call.x), [10, 11]);
    assert.equal(world.pending.length, 1);
});

test('compatible overlays build while incompatible structures and occupied site tiles are deferred', () => {
    const world = createLayoutWorld({ policy: { building: { maximumNewSitesPerRoom: 20 } } });
    const structures = [world.item('road', 10, 10), world.item('container', 11, 10), world.item('spawn', 12, 10), world.item('constructedWall', 13, 10)];
    const sites = [world.item('road', 14, 10)];
    const room = world.addRoom({ structures, sites, memory: { roomBlueprint: blueprint({
        container: [[10, 10]], road: [[11, 10]], rampart: [[12, 10], [13, 10], [14, 10]], extension: [[12, 10]]
    }) } });
    world.load().api.runAutomaticLayout(room);
    assert.deepEqual(world.calls.map(call => `${call.type}:${call.x}`).sort(), ['container:10', 'rampart:12', 'road:11']);
});

test('recorded roads can rebuild on terrain walls, while other structures avoid walls and invalid positions', () => {
    const world = createLayoutWorld();
    const room = world.addRoom({ walls: [[10, 10], [11, 10]], memory: { roomBlueprint: blueprint({
        road: [[10, 10]], extension: [[11, 10], [-1, 12], [50, 12], [12.5, 12]]
    }, 'snapshot') } });
    world.load().api.runAutomaticLayout(room);
    assert.deepEqual(world.calls, [{ room: 'W1N1', x: 10, y: 10, type: 'road' }]);
});

test('extractor on the real wall-terrain mineral is released at RCL6 while other wall placements stay blocked', () => {
    const world = createLayoutWorld();
    const room = world.addRoom({ level: 5, walls: [[35, 40], [36, 40], [37, 40]], memory: { roomBlueprint: blueprint({
        extension: [[36, 40]], spawn: [[37, 40]], extractor: [[36, 40], [35, 40]]
    }) } });
    const { api } = world.load();
    api.runAutomaticLayout(room); assert.deepEqual(world.calls, [], 'extractor quota is zero before level six');
    world.advanceTick(); room.controller.level = 6; api.runAutomaticLayout(room);
    assert.deepEqual(world.calls, [{ room: 'W1N1', x: 35, y: 40, type: 'extractor' }]);
});

test('destroyed wall-mineral extractor is rebuilt from its existing blueprint without another plan', () => {
    const world = createLayoutWorld({ planner() { throw new Error('Existing blueprint must stay fixed'); } });
    const extractor = world.item('extractor', 35, 40);
    const room = world.addRoom({ level: 6, structures: [extractor], walls: [[35, 40]], memory: { roomBlueprint: blueprint({ extractor: [[35, 40]] }) } });
    const { api } = world.load(); const saved = room.memory.roomBlueprint;
    api.runAutomaticLayout(room); assert.deepEqual(world.calls, []);
    room.structures.length = 0; world.advanceTick(); api.runAutomaticLayout(room);
    assert.deepEqual(world.calls, [{ room: 'W1N1', x: 35, y: 40, type: 'extractor' }]);
    assert.equal(room.memory.roomBlueprint, saved); assert.deepEqual(world.plannedRooms, []);
});

test('automatic layouts can be disabled globally or per room and never run in an unowned room', () => {
    for (const setting of ['global', 'room', 'unowned']) {
        const world = createLayoutWorld({ planner: room => plannerResult(room) });
        const room = world.addRoom({ level: 1 });
        if (setting === 'global') world.policy.enabled = false;
        else if (setting === 'room') room.memory.autoLaylout = false;
        else { room.my = false; room.controller.my = false; }
        world.load().api.runAutomaticLayout(room);
        assert.equal(room.memory.roomBlueprint, undefined, setting);
        assert.deepEqual(world.plannedRooms, [], setting);
        assert.deepEqual(world.calls, [], setting);
    }
});

test('room construction budgets include active sites and repeated calls in the same tick', () => {
    const activeWorld = createLayoutWorld();
    const existingSites = Array.from({ length: 8 }, (_, index) => activeWorld.item('road', index + 1, 5));
    const room = activeWorld.addRoom({ level: 3, sites: existingSites, memory: { roomBlueprint: blueprint({ road: [[20, 20], [21, 20], [22, 20], [23, 20]] }) } });
    activeWorld.load().api.runAutomaticLayout(room);
    assert.equal(activeWorld.calls.length, 2, 'active sites plus successful intents stay within the room cap');

    const repeatedWorld = createLayoutWorld();
    const repeatedRoom = repeatedWorld.addRoom({ level: 3, memory: { roomBlueprint: blueprint({ road: Array.from({ length: 8 }, (_, index) => [index + 20, 20]) }) } });
    const { api } = repeatedWorld.load();
    api.runAutomaticLayout(repeatedRoom);
    api.runAutomaticLayout(repeatedRoom);
    assert.equal(repeatedWorld.calls.length, 5, 'per-room new-site limit applies to the whole tick');
});

test('planned roads, ramparts, and mineral infrastructure release only at their configured levels', () => {
    const world = createLayoutWorld();
    const room = world.addRoom({ level: 2, memory: { roomBlueprint: blueprint({
        road: [[10, 10]], rampart: [[11, 10]], container: [[34, 40]], extractor: [[36, 40], [35, 40]]
    }) } });
    const { api } = world.load();
    api.runAutomaticLayout(room);
    assert.deepEqual(world.calls, []);
    world.advanceTick(2); room.controller.level = 3;
    api.runAutomaticLayout(room);
    assert.deepEqual(world.calls.map(call => call.type), ['road']);
    world.advanceTick(3); room.controller.level = 4;
    api.runAutomaticLayout(room);
    assert.deepEqual(world.calls.map(call => call.type), ['road', 'rampart']);
    world.advanceTick(4); room.controller.level = 6;
    api.runAutomaticLayout(room);
    assert.deepEqual(world.calls.map(call => call.type), ['road', 'rampart', 'container', 'extractor']);
    const extractor = world.calls.find(call => call.type === 'extractor');
    assert.deepEqual([extractor.x, extractor.y], [35, 40], 'extractor requires the actual mineral tile');
});

test('a planner returning no viable layout leaves Memory intact and observes the retry interval', () => {
    const world = createLayoutWorld();
    const room = world.addRoom({ level: 1, memory: { playerSettings: { keep: true } } });
    const { api } = world.load();
    api.runAutomaticLayout(room);
    assert.equal(room.memory.roomBlueprint, undefined);
    assert.equal(room.memory.playerSettings.keep, true);
    assert.match(room.memory.roomBlueprintState.lastError, /no viable layout/);
    world.advanceTick(2);
    api.runAutomaticLayout(room);
    assert.deepEqual(world.plannedRooms, ['W1N1']);
    world.advanceTick(101);
    api.runAutomaticLayout(room);
    assert.deepEqual(world.plannedRooms, ['W1N1', 'W1N1']);
    assert.deepEqual(world.calls, []);
});

test('blueprint lab metadata fills only a complete reachable pair and preserves valid manual choices', () => {
    const saved = blueprint({ lab: [[28, 25], [29, 25], [30, 25]] });
    saved.sourceLabs = [[28, 25], [29, 25]];
    const world = createLayoutWorld();
    const first = world.item('lab', 28, 25, 'W1N1', 'firstLab');
    const second = world.item('lab', 29, 25, 'W1N1', 'secondLab');
    const third = world.item('lab', 30, 25, 'W1N1', 'thirdLab');
    const room = world.addRoom({ structures: [first], memory: { roomBlueprint: saved } });
    const { api } = world.load();
    api.runAutomaticLayout(room);
    assert.equal(room.memory.roomLabConfig.sourceLab1, undefined);
    assert.equal(room.memory.roomLabConfig.sourceLab2, undefined);
    room.structures = [first, second, third];
    world.game.time = 2;
    api.runAutomaticLayout(room);
    assert.equal(room.memory.roomLabConfig.sourceLab1, 'firstLab');
    assert.equal(room.memory.roomLabConfig.sourceLab2, 'secondLab');
    room.memory.roomLabConfig.sourceLab1 = 'secondLab';
    room.memory.roomLabConfig.sourceLab2 = 'thirdLab';
    world.game.time = 3;
    api.runAutomaticLayout(room);
    assert.equal(room.memory.roomLabConfig.sourceLab1, 'secondLab');
    assert.equal(room.memory.roomLabConfig.sourceLab2, 'thirdLab');
});

test('an individual manual Lab slot stays valid while only the missing slot is filled', () => {
    const saved = blueprint({ lab: [[28, 25], [29, 25], [30, 25]] });
    saved.sourceLabs = [[28, 25], [29, 25]];
    const world = createLayoutWorld();
    const labs = [
        world.item('lab', 28, 25, 'W1N1', 'firstLab'),
        world.item('lab', 29, 25, 'W1N1', 'secondLab'),
        world.item('lab', 30, 25, 'W1N1', 'manualLab')
    ];
    const manualBoost = { boostMode: true };
    const unrelatedBoost = { boostMode: true };
    const config = { sourceLab1: 'manualLab', singleLabConfig: { manualLab: manualBoost, firstLab: { boostMode: true }, secondLab: unrelatedBoost } };
    const room = world.addRoom({ structures: labs, memory: { roomBlueprint: saved, roomLabConfig: config } });
    world.load().api.runAutomaticLayout(room);
    assert.equal(config.sourceLab1, 'manualLab');
    assert.equal(config.sourceLab2, 'firstLab');
    assert.notEqual(config.sourceLab1, config.sourceLab2);
    assert.equal(config.singleLabConfig.manualLab, manualBoost, 'existing manual Lab configuration is retained');
    assert.equal(config.singleLabConfig.secondLab, unrelatedBoost, 'unselected boost configuration is retained');
    assert.equal(config.singleLabConfig.firstLab, undefined, 'only the newly selected source Lab leaves boost mode');
});

test('snapshot Lab positions restore a rebuilt ID while retaining the surviving source slot', () => {
    const world = createLayoutWorld();
    const first = world.item('lab', 28, 25, 'W1N1', 'oldFirstLab');
    const survivor = world.item('lab', 29, 25, 'W1N1', 'survivingLab');
    const survivorConfig = { boostMode: false };
    const config = { sourceLab1: first.id, sourceLab2: survivor.id, singleLabConfig: { survivingLab: survivorConfig } };
    const room = world.addRoom({ structures: [first, survivor], memory: { roomLabConfig: config } });
    const { api } = world.load();
    api.runAutomaticLayout(room);
    const saved = room.memory.roomBlueprint;
    assert.equal(saved.origin, 'snapshot');
    assert.deepEqual(Array.from(saved.sourceLabs, pair => Array.from(pair)), [[28, 25], [29, 25]]);

    room.structures = [survivor];
    world.advanceTick(11);
    api.runAutomaticLayout(room);
    assert.deepEqual(world.calls, [{ room: 'W1N1', x: 28, y: 25, type: 'lab' }]);
    assert.equal(config.sourceLab1, 'oldFirstLab', 'a missing Lab waits until its replacement is actually built');
    assert.equal(config.sourceLab2, 'survivingLab');

    world.advanceTick(12);
    for (const site of room.sites) delete world.game.constructionSites[site.id];
    room.sites = [];
    const rebuilt = world.item('lab', 28, 25, 'W1N1', 'newFirstLab');
    room.structures = [rebuilt, survivor];
    config.singleLabConfig.newFirstLab = { boostMode: true };
    api.runAutomaticLayout(room);
    assert.equal(room.memory.roomBlueprint, saved);
    assert.equal(config.sourceLab1, 'newFirstLab');
    assert.equal(config.sourceLab2, 'survivingLab');
    assert.equal(config.singleLabConfig.survivingLab, survivorConfig);
    assert.equal(config.singleLabConfig.newFirstLab, undefined);
    assert.equal(world.calls.length, 1, 'completed replacement is not rebuilt again');
});

test('incumbent storage anchors the planner and remains in the persisted blueprint', () => {
    let receivedOptions;
    const world = createLayoutWorld({ planner(room, options) {
        receivedOptions = options;
        return { roomName: room.name, storagePos: options.storagePosition, labPos: { x: 28, y: 25 }, structMap: { spawn: [[20, 20]], storage: [[18, 21]], road: [[19, 22]] } };
    } });
    const existingStorage = world.item('storage', 18, 21, 'W1N1', 'existingStorage');
    const existingSpawn = world.item('spawn', 17, 21, 'W1N1', 'existingSpawn');
    const room = world.addRoom({ level: 4, structures: [existingStorage, existingSpawn] });
    world.load().api.runAutomaticLayout(room);
    assert.deepEqual({ x: receivedOptions.storagePosition.x, y: receivedOptions.storagePosition.y }, { x: 19, y: 21 });
    const saved = room.memory.roomBlueprint;
    assert.equal(saved.origin, 'planner63');
    assert.deepEqual(Array.from(saved.center), [19, 21]);
    assert.deepEqual(Array.from(saved.structures.storage, pair => Array.from(pair)), [[18, 21]], 'planned duplicate storage coordinate is deduplicated');
    assert.deepEqual(Array.from(saved.structures.spawn, pair => Array.from(pair)), [[17, 21], [20, 20]], 'incumbent Spawn stays first in the blueprint');
    assert.ok(world.calls.every(call => call.type !== 'storage' && call.type !== 'spawn'), 'existing structures satisfy the current RCL quotas');
});
/** Real eight-direction reachability for migration safety checks. */
function migrationPathFinder(world) {
    class CostMatrix {
        constructor() { this.costs = new Map(); }
        set(x, y, cost) { this.costs.set(`${x},${y}`, cost); }
        get(x, y) { return this.costs.get(`${x},${y}`) || 0; }
    }
    return {
        CostMatrix,
        search(origin, goals, options) {
            const room = world.game.rooms[origin.roomName], terrain = room.getTerrain();
            const matrix = options.roomCallback(room.name), targets = Array.isArray(goals) ? goals : [goals];
            const queue = [{ x: origin.x, y: origin.y, path: [] }], seen = new Set([`${origin.x},${origin.y}`]);
            for (let index = 0; index < queue.length && index < options.maxOps; index++) {
                const point = queue[index];
                if (targets.some(goal => Math.max(Math.abs(point.x - goal.pos.x), Math.abs(point.y - goal.pos.y)) <= goal.range))
                    return { incomplete: false, path: point.path };
                for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
                    const x = point.x + dx, y = point.y + dy, key = `${x},${y}`;
                    if (!(dx || dy) || x <= 0 || y <= 0 || x >= 49 || y >= 49 || seen.has(key) || terrain.get(x, y) === 1 || matrix.get(x, y) === 255) continue;
                    seen.add(key); queue.push({ x, y, path: [...point.path, { x, y }] });
                }
            }
            return { incomplete: true, path: [] };
        }
    };
}

function rangeToController(room, position) {
    return Math.max(Math.abs(position[0] - room.controller.pos.x), Math.abs(position[1] - room.controller.pos.y));
}

test('saved low-level controller station migrates to range three and replaces only an unstarted own site', () => {
    const world = createLayoutWorld();
    const oldSite = world.item('container', 24, 10); oldSite.progress = 0;
    const sourceContainer = [10, 14], mineralContainer = [34, 40];
    const saved = blueprint({ container: [[24, 10], sourceContainer, mineralContainer], link: [[23, 10]], spawn: [[25, 25]] });
    const room = world.addRoom({ level: 2, structures: [world.item('spawn', 25, 25)], sites: [oldSite], memory: { roomBlueprint: saved } });
    let removed = 0; oldSite.remove = () => { removed++; return 0; };
    const { api } = world.load({}, { PathFinder: migrationPathFinder(world) });
    api.runAutomaticLayout(room);
    assert.equal(removed, 1);
    assert.equal(rangeToController(room, saved.controllerContainer), 3);
    assert.deepEqual(Array.from(saved.structures.container, p => Array.from(p)), [Array.from(saved.controllerContainer), sourceContainer, mineralContainer]);
    assert.deepEqual(saved.structures.link, [[23, 10]], 'controller link keeps its existing range-two coordinate');
    assert.ok(saved.structures.road.length > 0, 'delivery approach is persisted');
    assert.ok(world.calls.some(call => call.type === 'container' && call.x === saved.controllerContainer[0] && call.y === saved.controllerContainer[1]));
    assert.ok(world.calls.every(call => !(call.type === 'container' && call.x === 24 && call.y === 10)));
    world.advanceTick(101); api.runAutomaticLayout(room);
    assert.equal(removed, 1, 'migration is one-time even after cooldown expires');
    assert.deepEqual(world.plannedRooms, []);
});

test('controller migration preserves built containers and sites with invested construction work', () => {
    for (const existing of ['built', 'partial']) {
        const world = createLayoutWorld(), old = world.item('container', 24, 10);
        old.progress = 20;
        const saved = blueprint({ container: [[24, 10]], spawn: [[25, 25]] });
        const room = world.addRoom({ level: 3, structures: [world.item('spawn', 25, 25), ...(existing === 'built' ? [old] : [])], sites: existing === 'partial' ? [old] : [], memory: { roomBlueprint: saved } });
        world.load({}, { PathFinder: migrationPathFinder(world) }).api.runAutomaticLayout(room);
        assert.equal(rangeToController(room, saved.controllerContainer), 3, existing);
        assert.ok((existing === 'built' ? room.structures : room.sites).includes(old), existing);
        assert.ok(world.calls.some(call => call.type === 'container' && rangeToController(room, [call.x, call.y]) === 3), existing);
    }
});

test('range-three controller metadata is copied from new plans and existing valid stations are reused', () => {
    const world = createLayoutWorld({ planner: room => ({ ...plannerResult(room, { spawn: [[20, 20]], container: [[25, 13]] }), controllerContainer: [25, 13] }) });
    const room = world.addRoom({ level: 1 });
    world.load().api.runAutomaticLayout(room);
    assert.deepEqual(Array.from(room.memory.roomBlueprint.controllerContainer), [25, 13]);
    assert.equal(room.memory.roomBlueprintState.lastControllerContainerAttempt, undefined, 'fresh valid geometry skips migration work');

    const reused = createLayoutWorld(), saved = blueprint({ container: [[25, 13]] });
    const legacy = reused.addRoom({ level: 2, memory: { roomBlueprint: saved } });
    reused.load().api.runAutomaticLayout(legacy);
    assert.deepEqual(Array.from(saved.controllerContainer), [25, 13], 'old exact-range-three plans acquire metadata without moving');
});

test('RCL8 plans and snapshot layouts keep and rebuild their original controller containers', () => {
    for (const [level, origin] of [[8, 'planner63'], [3, 'snapshot']]) {
        const world = createLayoutWorld(), saved = blueprint({ container: [[24, 10]] }, origin);
        const room = world.addRoom({ level, memory: { roomBlueprint: saved } });
        world.load().api.runAutomaticLayout(room);
        assert.equal(saved.controllerContainer, undefined);
        assert.deepEqual(saved.structures.container, [[24, 10]]);
        assert.ok(world.calls.some(call => call.type === 'container' && call.x === 24 && call.y === 10));
    }
});

test('deferred migration does not create a controller container at the obsolete near-controller coordinate', () => {
    for (const reason of ['bucket', 'ring', 'path', 'exception', 'remove']) {
        const world = createLayoutWorld(), saved = blueprint({ container: [[24, 10]], extension: [[30, 30]], spawn: [[25, 25]] });
        const walls = [];
        if (reason === 'ring') for (let x = 22; x <= 28; x++) for (let y = 7; y <= 13; y++)
            if (Math.max(Math.abs(x - 25), Math.abs(y - 10)) === 3) walls.push([x, y]);
        if (reason === 'path') for (let x = 1; x < 49; x++) walls.push([x, 19]);
        const oldSite = world.item('container', 24, 10); oldSite.progress = 0;
        oldSite.remove = () => -7;
        const room = world.addRoom({ level: 2, walls, structures: [world.item('spawn', 25, 25)], sites: reason === 'remove' ? [oldSite] : [], memory: { roomBlueprint: saved } });
        if (reason === 'bucket') world.game.cpu.bucket = 1999;
        const pathFinder = migrationPathFinder(world);
        if (reason === 'exception') pathFinder.search = () => { throw new Error('search failed'); };
        const { api } = world.load({}, { PathFinder: pathFinder });
        assert.doesNotThrow(() => api.runAutomaticLayout(room), reason);
        assert.equal(saved.controllerContainer, undefined, reason);
        assert.deepEqual(saved.structures.container, [[24, 10]], reason);
        assert.ok(world.calls.every(call => call.type !== 'container'), reason);
        assert.ok(world.calls.some(call => call.type === 'extension'), `${reason}: other construction continues`);
        if (reason === 'exception') assert.match(room.memory.roomBlueprintState.lastError, /search failed/);
        world.advanceTick(2); api.runAutomaticLayout(room);
        assert.deepEqual(saved.structures.container, [[24, 10]], 'failed attempts retain the retry cooldown');
    }
});

test('near-controller source containers remain harvest infrastructure even when migration is deferred', () => {
    const world = createLayoutWorld(), saved = blueprint({ container: [[24, 10]] });
    const room = world.addRoom({ level: 2, memory: { roomBlueprint: saved } });
    room.sources[0].pos.x = 24; room.sources[0].pos.y = 9;
    world.game.cpu.bucket = 0;
    world.load().api.runAutomaticLayout(room);
    assert.deepEqual(saved.structures.container, [[24, 10]]);
    assert.ok(world.calls.some(call => call.type === 'container' && call.x === 24 && call.y === 10));
});
