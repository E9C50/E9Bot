const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world({ manual = true, level = 3, phase = 'hauling', maintenance = false, sources = 1, incomplete = false } = {}) {
    const calls = { paths: [], sites: [], published: [] }, objects = new Map();
    class Position {
        constructor(x, y, roomName) { Object.assign(this, { x, y, roomName }); }
    }
    class Matrix {
        constructor() { this.data = new Map(); }
        set(x, y, value) { this.data.set(`${x}/${y}`, value); }
        get(x, y) { return this.data.get(`${x}/${y}`) || 0; }
    }
    const game = { time: 100, shard: { name: 'shard1' }, rooms: {}, creeps: {}, flags: {}, constructionSites: {},
        cpu: { bucket: 5000, tickLimit: 100, getUsed: () => 0 },
        map: { findRoute: (from, to) => [{ room: to, exit: 7 }] }, getObjectById: id => objects.get(id) || null };
    const memory = { warMode: {}, rooms: {} };
    function room(name, owned = false) {
        const created = { name, my: owned, level: owned ? level : 0, memory: { creepConfig: {} }, economy: true,
            energyCapacityAvailable: 800, controller: { my: owned, level: owned ? level : 0,
                owner: owned ? { username: 'me' } : undefined, pos: new Position(40, 40, name) },
            sources: [], minerals: [], structures: [], constructionSites: [], enemies: [], hostiles: [], terrain: new Map(), spawns: [],
            getTerrain() { return { get: (x, y) => this.terrain.get(`${x}/${y}`) || 0 }; },
            find(type) {
                return type === 'structures' ? this.structures : type === 'sites' ? this.constructionSites : type === 'sources' ? this.sources :
                    type === 'minerals' ? this.minerals : type === 'hostile-structures' ? this.hostiles : type === 'hostiles' ? this.enemies : [];
            },
            createConstructionSite(x, y, type) { calls.sites.push({ room: this.name, x, y, type }); return this.siteCode?.(x, y, type) ?? 0; } };
        if (owned) created.spawns.push({ id: `${name}-spawn`, my: true, owner: { username: 'me' }, pos: new Position(25, 25, name) });
        game.rooms[name] = created; memory.rooms[name] = created.memory;
        return created;
    }
    const home = room('W1N1', true), target = room('W2N1');
    function addRemote(owner = home, remote = target, options = {}) {
        const count = options.sources ?? sources, record = { kind: options.manual === false ? 'automatic' : 'manual',
            phase: options.phase || phase, maintenance: options.maintenance ?? maintenance, ready: phase === 'ready', admitted: true,
            sources: Object.fromEntries(Array.from({ length: count }, (_, i) => {
                const source = { id: `${remote.name}-source-${i}`, pos: new Position(10 + i * 10, 10, remote.name) };
                remote.sources.push(source); objects.set(source.id, source);
                return [source.id, { id: source.id, x: source.pos.x, y: source.pos.y, haulers: 1 }];
            })) };
        owner.memory.remoteCommissioning ||= { rooms: {} }; owner.memory.remoteCommissioning.rooms[remote.name] = record;
        owner.memory.developmentRemotes ||= { selectedRooms: [] };
        if (record.kind === 'manual') game.flags[`${owner.name}_OUT0`] = { pos: new Position(25, 25, remote.name) };
        else owner.memory.developmentRemotes.selectedRooms.push(remote.name);
        return record;
    }
    const record = addRemote(home, target, { manual });
    let path = [new Position(26, 25, home.name), ...Array.from({ length: 5 }, (_, i) => new Position(i + 2, 15, target.name))];
    const loader = createSourceLoader({ globals: { Game: game, Memory: memory, RoomPosition: Position,
        PathFinder: { CostMatrix: Matrix, search(origin, goal, options) {
            calls.paths.push({ origin, goal, options }); return { incomplete, path: path.map(pos => new Position(pos.x, pos.y,
                pos.roomName === home.name ? origin.roomName : pos.roomName === target.name ? goal.pos.roomName : pos.roomName)) };
        } },
        FIND_STRUCTURES: 'structures', FIND_CONSTRUCTION_SITES: 'sites', FIND_SOURCES: 'sources', FIND_MINERALS: 'minerals',
        FIND_HOSTILE_STRUCTURES: 'hostile-structures', FIND_HOSTILE_CREEPS: 'hostiles',
        STRUCTURE_ROAD: 'road', STRUCTURE_CONTAINER: 'container', STRUCTURE_RAMPART: 'rampart', STRUCTURE_WALL: 'constructedWall',
        STRUCTURE_INVADER_CORE: 'invaderCore', STRUCTURE_KEEPER_LAIR: 'keeperLair', STRUCTURE_TOWER: 'tower', STRUCTURE_EXTRACTOR: 'extractor',
        TERRAIN_MASK_WALL: 1, TERRAIN_MASK_SWAMP: 2, MAX_CONSTRUCTION_SITES: 100, OK: 0, ERR_FULL: -8,
        OBSTACLE_OBJECT_TYPES: ['spawn', 'extension', 'constructedWall', 'tower', 'storage', 'link'],
        CONTROLLER_STRUCTURES: { extension: { 3: 10 }, road: { 3: 2500 }, container: { 3: 5 } },
    }, modules: { './remoteHomeEconomy': { hasRemoteHomeEconomy: owner => owner.economy },
        'room/sourceLinks': { redundantSourceContainer: () => false } } });
    const api = loader.load('creep/remoteRoads'), policy = loader.load('settings/remoteRoads').remoteRoadPolicy;
    const construction = loader.load('planning/construction'), building = loader.load('settings/construction').constructionPolicy.building;
    function publish(owner, role, name, data) {
        calls.published.push({ owner: owner.name, role, name, data }); owner.memory.creepConfig[name] = { role, data }; return name;
    }
    function item(owner, type, x, y, { site = false, my = true, hits = 1000, hitsMax = 1000 } = {}) {
        const id = `${owner.name}-${type}-${x}-${y}`, value = { id, structureType: type, pos: new Position(x, y, owner.name), my, hits, hitsMax };
        if (site) { Object.assign(value, { progress: 0, progressTotal: 300 }); owner.constructionSites.push(value); game.constructionSites[id] = value; }
        else owner.structures.push(value);
        objects.set(id, value); return value;
    }
    function step(ticks = 1) { game.time += ticks; calls.published.length = 0; home.memory.creepConfig = {}; }
    return { api, loader, policy, construction, building, game, memory, calls, home, target, record, room, addRemote, item, Position,
        release: () => api.releaseRemoteRoadConfigs(publish), step, setPath: positions => { path = positions; } };
}

test('manual and automatic hauling mines plan compact source lanes and publish one affordable unboosted maintenance worker only for visible work', () => {
    for (const manual of [true, false]) {
        const w = world({ manual }); w.release();
        assert.equal(w.calls.paths.length, 1); assert.equal(w.calls.sites.length, w.policy.maximumNewSitesPerTick);
        assert.equal(w.calls.published.length, 0, 'construction intents are not real sites until the next tick');
        const route = w.home.memory.remoteRoads.routes[`${w.target.name}/${w.target.sources[0].id}`];
        assert.deepEqual(Array.from(route.rooms[w.target.name]), [115, 165, 215, 265, 315]);
        w.item(w.target, 'road', 2, 15, { site: true }); w.step(); w.release();
        assert.equal(w.calls.paths.length, 1, 'cached lane survives refresh');
        assert.equal(w.calls.published.length, 1);
        const demand = w.calls.published[0], config = w.home.memory.creepConfig[demand.name];
        assert.equal(demand.role, 'rBuilder'); assert.equal(demand.data.roadHome, w.home.name);
        assert.equal(demand.data.targetRoom, w.target.name); assert.equal(demand.data.sourceFlag, w.target.sources[0].id);
        assert.equal(config.spawnPriority, 4.5); assert.equal(config.bodyProfile.boostTier, 0); assert.equal(config.bodyProfile.maximumCost, 800);
        assert.equal(w.api.hasRemoteRoadRoom(w.home, w.target.name), true);
    }
});

test('new remotes wait for hauling while paid maintenance survives fleet recovery and denied admission never opens a new lane', () => {
    for (const phase of ['scouting', 'reserving', 'mining', 'waiting']) {
        const w = world({ phase }); w.item(w.target, 'container', 9, 10, { site: true }); w.release();
        assert.equal(w.calls.paths.length, 0, phase); assert.equal(w.calls.published.length, 0, phase);
    }
    const paid = world({ phase: 'mining', maintenance: true }); paid.item(paid.target, 'container', 9, 10, { site: true }); paid.release();
    assert.equal(paid.calls.paths.length, 1); assert.equal(paid.calls.published.length, 1);
    const denied = world(); denied.record.admitted = false; denied.item(denied.target, 'road', 2, 15, { site: true }); denied.release();
    assert.equal(denied.calls.paths.length, 0); assert.equal(denied.calls.published.length, 0);
});

test('home recovery, low RCL, missing spawn, war and evacuation suspend new road demand', () => {
    for (const change of [w => { w.home.economy = false; }, w => { w.home.level = 2; }, w => { w.home.spawns = []; },
        w => { w.memory.warMode[w.home.name] = true; }, w => { w.home.memory.evacuation = {}; }]) {
        const w = world(); change(w); w.item(w.target, 'road', 2, 15, { site: true }); w.release();
        assert.equal(w.calls.paths.length, 0); assert.equal(w.calls.sites.length, 0); assert.equal(w.calls.published.length, 0);
    }
    const mature = world({ level: 8 }); mature.release(); assert.equal(mature.calls.paths.length, 1, 'manual roads still work at RCL8');
    const automatic = world({ level: 8, manual: false }); automatic.release(); assert.equal(automatic.calls.paths.length, 0);
});

test('global route planning permits one source per tick and reuses durable lanes until origin changes or expiry', () => {
    const w = world({ sources: 2 }); const otherHome = w.room('W3N1', true), otherTarget = w.room('W4N1');
    w.addRemote(otherHome, otherTarget, { sources: 1 }); w.release();
    assert.equal(w.calls.paths.length, 1); assert.equal(Object.keys(w.home.memory.remoteRoads.routes).length, 1);
    w.step(); w.release(); assert.equal(w.calls.paths.length, 2);
    assert.equal(Object.keys(w.home.memory.remoteRoads.routes).length, 2);
    w.step(); w.release(); assert.equal(w.calls.paths.length, 3, 'second home waits its global planning turn');
    w.step(); w.release(); assert.equal(w.calls.paths.length, 3);
    w.home.storage = { pos: new w.Position(24, 24, w.home.name) }; w.step(); w.release();
    assert.equal(w.calls.paths.length, 4); assert.equal(w.calls.paths.at(-1).origin, w.home.storage.pos);
    assert.equal(w.calls.paths.at(-1).goal.range, 1); assert.equal(w.calls.paths.at(-1).options.maxOps, w.policy.maximumPathOps);
    w.step(w.policy.replanInterval); w.release(); assert.equal(w.calls.paths.length, 5);
});

test('low bucket and CPU headroom defer path searches while existing visible work remains eligible', () => {
    for (const cpu of [{ bucket: 999, used: 0 }, { bucket: 5000, used: 91 }]) {
        const w = world(); w.release(); w.calls.sites.length = 0; w.step();
        w.game.cpu.bucket = cpu.bucket; w.game.cpu.getUsed = () => cpu.used;
        w.item(w.target, 'container', 9, 10, { site: true }); w.release();
        assert.equal(w.calls.paths.length, 1); assert.equal(w.calls.sites.length, 0);
        assert.equal(w.calls.published.length, 1, 'no new path is needed to maintain an already visible remote site');
    }
    const unplanned = world(); unplanned.game.cpu.bucket = 999; unplanned.release();
    assert.equal(unplanned.calls.paths.length, 0); assert.equal(unplanned.calls.published.length, 0);
});

test('incomplete routes create no roads and back off until retry interval', () => {
    const w = world({ incomplete: true }); w.release(); assert.equal(w.calls.paths.length, 1); assert.equal(w.calls.sites.length, 0);
    w.step(); w.release(); assert.equal(w.calls.paths.length, 1);
    w.step(w.policy.retryInterval); w.release(); assert.equal(w.calls.paths.length, 2);
});

test('road sites skip borders, existing sites, buildings, walls, terrain and resources while sharing containers and ramparts', () => {
    const w = world(); w.setPath([0, 1, 2, 3, 4, 5, 6, 7, 12, 13, 14, 8, 49].map(x => new w.Position(x, 15, w.target.name)));
    w.item(w.target, 'road', 1, 15); w.item(w.target, 'container', 2, 15); w.item(w.target, 'rampart', 3, 15);
    w.item(w.target, 'spawn', 4, 15); w.item(w.target, 'constructedWall', 5, 15); w.item(w.target, 'container', 6, 15, { site: true });
    w.target.terrain.set('7/15', 1); w.target.sources[0].pos = new w.Position(12, 15, w.target.name);
    Object.assign(w.record.sources[w.target.sources[0].id], { x: 12, y: 15 });
    w.target.controller.pos = new w.Position(13, 15, w.target.name); w.target.minerals = [{ pos: new w.Position(14, 15, w.target.name) }];
    w.release(); assert.deepEqual(w.calls.sites.map(item => item.x), [2, 3, 8]);
    const matrix = w.calls.paths[0].options.roomCallback(w.target.name);
    assert.equal(matrix.get(1, 15), 1); assert.equal(matrix.get(4, 15), 255); assert.equal(matrix.get(12, 15), 255);
    assert.equal(matrix.get(13, 15), 255); assert.equal(matrix.get(14, 15), 255);
    assert.equal(w.calls.paths[0].options.roomCallback('W9N9'), false);
});

test('private hostile ramparts stay impassable regardless of coexisting road enumeration and never receive road sites', () => {
    for (const order of [['rampart', 'road'], ['road', 'rampart']]) {
        const w = world();
        for (const type of order) w.item(w.target, type, 2, 15, { my: false });
        w.item(w.target, 'rampart', 3, 15, { my: false });
        const publicRampart = w.item(w.target, 'rampart', 4, 15, { my: false }); publicRampart.isPublic = true;
        w.release();
        const matrix = w.calls.paths[0].options.roomCallback(w.target.name);
        assert.equal(matrix.get(2, 15), 255); assert.equal(matrix.get(3, 15), 255);
        assert.notEqual(matrix.get(4, 15), 255);
        assert.ok(w.calls.sites.every(site => site.room !== w.target.name || ![2, 3].includes(site.x)));
        assert.ok(w.calls.sites.some(site => site.room === w.target.name && site.x === 4));
    }
});

test('cached road construction defers under low CPU without postponing its recovery inspection or pausing existing maintenance', () => {
    for (const reduceCpu of [w => { w.game.cpu.bucket = 999; }, w => { w.game.cpu.getUsed = () => 91; }]) {
        const w = world(); w.release(); const previous = w.home.memory.remoteRoads.lastConstructionAt;
        w.item(w.target, 'road', 2, 15, { site: true }); w.step(w.policy.constructionInterval);
        w.calls.sites.length = 0; reduceCpu(w); w.release();
        assert.equal(w.calls.sites.length, 0); assert.equal(w.calls.paths.length, 1);
        assert.equal(w.home.memory.remoteRoads.lastConstructionAt, previous);
        assert.equal(w.calls.published.length, 1, 'a paid lane can still receive its maintenance worker');
        w.game.cpu.bucket = 5000; w.game.cpu.getUsed = () => 0; w.step(); w.release();
        assert.ok(w.calls.sites.length > 0); assert.equal(w.home.memory.remoteRoads.lastConstructionAt, w.game.time);
    }
});

test('active and successful-intent per-room limits stop extra sites and do not repeat same-tick road intents', () => {
    const w = world(); w.setPath(Array.from({ length: 20 }, (_, i) => new w.Position(i + 2, 15, w.target.name)));
    for (let i = 0; i < w.building.maximumActiveSitesPerRoom; i++) w.item(w.target, 'road', 2 + i, 25, { site: true });
    w.release(); assert.equal(w.calls.sites.length, 0);
    const fresh = world(); fresh.policy.constructionInterval = 0; fresh.release(); fresh.release();
    assert.equal(fresh.calls.sites.length, fresh.policy.maximumNewSitesPerTick);
    assert.equal(new Set(fresh.calls.sites.map(site => `${site.room}/${site.x}/${site.y}`)).size, fresh.calls.sites.length);
});

test('ERR_FULL stops all road construction immediately while another invalid tile can be skipped', () => {
    const full = world(); full.home.siteCode = () => -8; full.release();
    assert.equal(full.calls.sites.length, 1); assert.equal(full.construction.getConstructionBudget().remaining, 0);
    const invalid = world(); invalid.home.siteCode = () => -7; invalid.release();
    assert.equal(invalid.calls.sites.filter(site => site.room === invalid.target.name).length, invalid.policy.maximumNewSitesPerTick);
});

test('local layouts and remote roads share the native global site budget including successful invisible intents', () => {
    const w = world(); w.policy.freeSitesForLocalConstruction = 0;
    for (let i = 0; i < 98; i++) w.game.constructionSites[`other-${i}`] = {};
    const budget = w.construction.getConstructionBudget();
    assert.equal(w.construction.buildMissingStructures(w.home,
        { origin: 'manual', structures: { extension: [[22, 22]] } }, budget), 1);
    w.release(); assert.equal(w.calls.sites.length, 2); assert.equal(budget.remaining, 0);
    assert.equal(w.calls.sites[0].type, 'extension'); assert.equal(w.calls.sites[1].type, 'road');
    assert.equal(w.construction.getConstructionBudget(), budget);
    const exhausted = world(); for (let i = 0; i < 99; i++) exhausted.game.constructionSites[`other-${i}`] = {};
    exhausted.construction.buildMissingStructures(exhausted.home,
        { origin: 'manual', structures: { extension: [[22, 22]] } }, exhausted.construction.getConstructionBudget());
    exhausted.release(); assert.equal(exhausted.calls.sites.length, 1);
});

test('remote road intents leave global site slots for local economy construction including invisible local intents', () => {
    const w = world(); for (let i = 0; i < 79; i++) w.game.constructionSites[`other-${i}`] = {};
    w.release(); assert.equal(w.calls.sites.length, 1);
    assert.equal(w.construction.getConstructionBudget().remaining, w.policy.freeSitesForLocalConstruction);
    const local = world(); for (let i = 0; i < 79; i++) local.game.constructionSites[`other-${i}`] = {};
    local.construction.buildMissingStructures(local.home, { origin: 'manual', structures: { extension: [[22, 22]] } },
        local.construction.getConstructionBudget());
    local.release(); assert.equal(local.calls.sites.length, 1); assert.equal(local.calls.sites[0].type, 'extension');
});

test('maintenance resolves visible work and the most damaged road while excluding unrelated home roads', () => {
    const w = world(); w.release(); const site = w.item(w.target, 'container', 9, 10, { site: true });
    const unrelated = w.item(w.home, 'road', 30, 30, { hits: 10 });
    const first = w.item(w.target, 'road', 2, 15, { hits: 400 }), worst = w.item(w.target, 'road', 3, 15, { hits: 100 });
    w.step(); const repair = w.api.getRemoteRoadWork(w.home);
    assert.equal(repair.kind, 'repair'); assert.equal(repair.id, worst.id); assert.notEqual(repair.id, unrelated.id);
    worst.hits = 1000; first.hits = 1000; w.step(); const build = w.api.getRemoteRoadWork(w.home, w.target.name);
    assert.equal(build.kind, 'build'); assert.equal(build.id, site.id);
    assert.equal(w.api.getRemoteRoadWork(w.home, 'W9N9'), undefined);
});

test('hostiles, foreign controllers, foreign reservations, cores, keeper lairs, towers and evacuation pause work', () => {
    for (const change of [w => { w.target.enemies.push({}); }, w => { w.target.controller.owner = { username: 'enemy' }; },
        w => { w.target.controller.reservation = { username: 'enemy' }; }, w => { w.target.hostiles.push({ structureType: 'invaderCore' }); },
        w => { w.target.hostiles.push({ structureType: 'keeperLair' }); }, w => { w.target.hostiles.push({ structureType: 'tower' }); },
        w => { w.target.memory.evacuation = {}; }, w => { w.memory.warMode[w.target.name] = true; }]) {
        const w = world(); w.release(); w.item(w.target, 'road', 2, 15, { site: true }); change(w); w.step(); w.release();
        assert.equal(w.calls.paths.length, 1); assert.equal(w.calls.published.length, 0);
        assert.equal(w.api.getRemoteRoadWork(w.home), undefined); assert.equal(w.api.isRemoteRoadRoomSafe(w.target, w.home), false);
    }
});

test('removing manual flags or automatic selection retires cached road lanes and immediately invalidates worker room membership', () => {
    for (const manual of [true, false]) {
        const w = world({ manual }); w.release(); w.item(w.target, 'road', 2, 15, { site: true });
        if (manual) delete w.game.flags[`${w.home.name}_OUT0`]; else w.home.memory.developmentRemotes.selectedRooms = [];
        w.step(); assert.equal(w.api.hasRemoteRoadRoom(w.home, w.target.name), false); assert.equal(w.api.getRemoteRoadWork(w.home), undefined);
        w.release(); assert.equal(w.calls.published.length, 0); assert.equal(Object.keys(w.home.memory.remoteRoads.routes).length, 0);
    }
});

test('missing target or intermediate visibility defers route discovery without committing unusable lanes', () => {
    const unseen = world(); delete unseen.game.rooms[unseen.target.name]; unseen.release();
    assert.equal(unseen.calls.paths.length, 0); assert.equal(unseen.calls.sites.length, 0); assert.equal(unseen.calls.published.length, 0);
    assert.equal(unseen.api.getRemoteRoadWork(unseen.home), undefined);
    const middle = world(); middle.game.map.findRoute = () => [{ room: 'W3N1' }, { room: middle.target.name }]; middle.release();
    assert.equal(middle.calls.paths.length, 0); assert.equal(middle.calls.sites.length, 0);
    const pending = Object.values(middle.home.memory.remoteRoads.routes)[0];
    assert.equal(pending.plannedAt, undefined); assert.equal(Object.keys(pending.rooms).length, 0);
});

test('an unsafe intermediate room pauses the entire cached lane and worker deployment until it clears', () => {
    const w = world(), middle = w.room('W3N1');
    w.game.map.findRoute = () => [{ room: middle.name }, { room: w.target.name }];
    w.setPath([new w.Position(26, 25, w.home.name), new w.Position(20, 20, middle.name), new w.Position(2, 15, w.target.name)]);
    w.release(); assert.equal(w.calls.paths.length, 1); assert.equal(w.api.hasRemoteRoadRoom(w.home, middle.name), true);
    w.item(w.target, 'road', 2, 15, { site: true }); const originalSites = w.calls.sites.length;
    middle.enemies.push({}); w.step(w.policy.constructionInterval); w.release();
    assert.equal(w.calls.sites.length, originalSites); assert.equal(w.calls.published.length, 0);
    assert.equal(w.api.getRemoteRoadWork(w.home), undefined);
    middle.enemies = []; w.step(w.policy.constructionInterval); w.release();
    assert.equal(w.calls.published.length, 1);
});

test('source containers become exact lane endpoints and adding one invalidates the Source-adjacent route cache', () => {
    const w = world(); w.release(); const original = Object.values(w.home.memory.remoteRoads.routes)[0];
    assert.equal(w.calls.paths[0].goal.range, 1);
    const container = w.item(w.target, 'container', 9, 10); w.step(); w.release();
    assert.equal(w.calls.paths.length, 2); assert.equal(w.calls.paths[1].goal.range, 0);
    assert.equal(w.calls.paths[1].goal.pos.x, container.pos.x); assert.equal(w.calls.paths[1].goal.pos.y, container.pos.y);
    assert.notEqual(Object.values(w.home.memory.remoteRoads.routes)[0].signature, original.signature);
    w.step(); w.release(); assert.equal(w.calls.paths.length, 2);
});

test('future blueprint buildings block road routing and construction while planned shared road-container tiles remain walkable', () => {
    const w = world(); w.home.memory.roomBlueprint = { schemaVersion: 1, origin: 'planner63', createdAt: 0,
        structures: { extension: [[26, 25]], tower: [[27, 25]], storage: [[28, 25]],
            constructedWall: [[29, 25]], container: [[30, 25]], rampart: [[31, 25]], road: [[32, 25]] } };
    w.setPath(Array.from({ length: 7 }, (_, i) => new w.Position(26 + i, 25, w.home.name)));
    w.release(); const matrix = w.calls.paths[0].options.roomCallback(w.home.name);
    for (const x of [26, 27, 28, 29]) assert.equal(matrix.get(x, 25), 255, `future building at ${x}`);
    for (const x of [30, 31, 32]) assert.notEqual(matrix.get(x, 25), 255, `shareable tile at ${x}`);
    assert.deepEqual(w.calls.sites.map(site => site.x), [30, 31, 32], 'even a stale/mock route must not overwrite future buildings');
});

test('the real spawn guard rechecks stale road-worker queues against completed work, danger, deleted flags and home ownership', () => {
    for (const invalidate of [w => { w.target.constructionSites = []; }, w => { w.target.enemies.push({}); },
        w => { delete w.game.flags[`${w.home.name}_OUT0`]; }, (w, config) => { config.data.roadHome = 'W9N9'; }]) {
        const w = world({ maintenance: true }); w.release(); w.item(w.target, 'road', 2, 15, { site: true }); w.step();
        const guard = w.loader.load('creep/remoteCommissioning').remoteSpawnAllowed;
        const source = w.target.sources[0], config = { role: 'rBuilder', data: { roadHome: w.home.name,
            targetRoom: w.target.name, sourceFlag: source.id, targetFlag: source.id } };
        assert.equal(guard(w.home, config), true, 'a safe commissioned lane with visible work can spawn');
        invalidate(w, config); w.step(); assert.equal(guard(w.home, config), false, 'a stale queue must not spend energy after eligibility changes');
        assert.equal(guard(w.home, { role: 'rBuilder', data: { sourceFlag: `${w.home.name}_RB_S0`, targetFlag: `${w.home.name}_RB_T0` } }), true);
        assert.equal(guard(w.home, { role: 'rBuilder', data: { bootstrap: true, sourceFlag: source.id, targetRoom: w.target.name } }), true);
    }
});
