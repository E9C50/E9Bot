const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const nativeBodies = require('../helpers/native-bodies.cjs');

function world({ level = 3, capacity = 1300, visible = true } = {}) {
    const objects = new Map(), calls = [];
    const game = { time: 100, shard: { name: 'shard2' }, rooms: {}, creeps: {}, flags: {},
        cpu: { bucket: 5000, tickLimit: 500, getUsed: () => 0 }, getObjectById: id => objects.get(id) || null,
        map: { getRoomLinearDistance: () => 1, describeExits: () => ({}), findRoute: (_from, to) => [{ room: to, exit: 3 }],
            getRoomTerrain: () => ({ get: () => 0 }), getRoomStatus: () => ({ status: 'normal' }) } };
    const memory = { warMode: {}, creeps: {}, rooms: {}, combatTasks: {} };
    class Position {
        constructor(x, y, roomName) { Object.assign(this, { x, y, roomName }); }
        getRangeTo(value) { const pos = value.pos || value; return pos.roomName === this.roomName ? Math.max(Math.abs(this.x-pos.x), Math.abs(this.y-pos.y)) : Infinity; }
        inRangeTo(value, range) { return this.getRangeTo(value) <= range; }
        isNearTo(value) { return this.getRangeTo(value) <= 1; }
        isEqualTo(value) { return this.getRangeTo(value) === 0; }
    }
    const position = (x, y, roomName) => new Position(x, y, roomName);
    function store(energy = 0, storeCapacity = 1000) {
        return { energy, getUsedCapacity: () => energy, getCapacity: () => storeCapacity, getFreeCapacity: () => storeCapacity-energy };
    }
    function makeRoom(name, owned = false) {
        const room = { name, my: owned, level: owned ? level : 0, memory: { creepConfig: {}, roomFillJob: {} },
            controller: { my: owned, level: owned ? level : 0, ...(owned ? { owner: { username: 'me' } } : {}),
                pos: position(20, 20, name) }, sources: [], spawns: [], extensions: [], containers: [], links: [],
            constructionSites: [], roads: [], labs: [], structures: [], enemies: [],
            energyCapacityAvailable: owned ? capacity : 0, energyAvailable: owned ? capacity : 0,
            getTerrain: () => ({ get: () => 0 }), lookForAt: () => [],
            find(type) { return type === 'sources' ? this.sources : type === 'spawns' ? this.spawns :
                type === 'structures' || type === 'hostile-structures' ? this.structures : type === 'hostiles' ? this.enemies : []; } };
        game.rooms[name] = room; memory.rooms[name] = room.memory; return room;
    }
    function source(room, id) {
        const object = { id, pos: position(10, 10, room.name), room, energy: 3000, energyCapacity: 3000 };
        room.sources.push(object); objects.set(id, object); return object;
    }
    const home = makeRoom('E41N6', true), homeSource = source(home, 'home-source');
    const target = makeRoom('E41N5'), mine = source(target, 'remote-source');
    const other = makeRoom('E42N6'); source(other, 'other-source');
    if (!visible) { delete game.rooms[target.name]; delete game.rooms[other.name]; }
    function flag(slot, room = target, kind = 'RESERVE') {
        const name = `${home.name}_${kind}${slot}`, item = { name, pos: position(25, 25, typeof room === 'string' ? room : room.name) };
        Object.defineProperty(item, 'room', { get() { throw Error('reserve flags must use Game.rooms rather than Flag.room'); } });
        game.flags[name] = item; return item;
    }
    const roles = ['harvester', 'filler', 'builder', 'upgrader', 'scout', 'reserver', 'rHarvester', 'rFiller', 'rBuilder', 'rdefender', 'claimer', 'sBuilder'];
    const factories = Object.fromEntries(roles.map(role => [role, () => ({ isNeed: () => true, prepare: () => true, source: () => true, target: () => true })]));
    factories.isRoleSupported = role => roles.includes(role);
    factories.createRoleBehavior = role => factories[role]?.();
    const loader = createSourceLoader({ globals: { ...nativeBodies.globals, Game: game, Memory: memory, RoomPosition: Position,
        StructureSpawn: class {}, BODYPART_COST: { work:100, carry:50, move:50, claim:600, tough:10, attack:80, ranged_attack:150, heal:250 },
        RESOURCE_ENERGY: 'energy', SOURCE_ENERGY_NEUTRAL_CAPACITY: 1500, CREEP_SPAWN_TIME: 3,
        STRUCTURE_LINK: 'link', STRUCTURE_CONTAINER: 'container', STRUCTURE_ROAD: 'road', STRUCTURE_RAMPART: 'rampart',
        STRUCTURE_INVADER_CORE: 'invaderCore', STRUCTURE_KEEPER_LAIR: 'keeperLair', STRUCTURE_TOWER: 'tower', STRUCTURE_SPAWN: 'spawn',
        FIND_MY_SPAWNS: 'spawns', FIND_MY_CREEPS: 'my-creeps', FIND_SOURCES: 'sources', FIND_STRUCTURES: 'structures',
        FIND_HOSTILE_STRUCTURES: 'hostile-structures', FIND_HOSTILE_CREEPS: 'hostiles', LOOK_STRUCTURES: 'structures', LOOK_CREEPS: 'creeps',
        TERRAIN_MASK_WALL: 1, OK: 0, HEAL_POWER: 12, RANGED_ATTACK_POWER: 10, TOWER_ENERGY_COST: 10,
        BOOSTS: { heal: {}, ranged_attack: {}, tough: {} },
    }, modules: { ...nativeBodies.modules, role: factories,
        'shard/targetDismantleControl': { isTargetDismantleSpawnReserved: () => false },
        utils: { sha1String: value => crypto.createHash('sha1').update(value).digest('hex').slice(0, 10), getDistance: (a,b) => a.getRangeTo(b) },
    } });
    const Spawn = loader.load('mount/structure/SpawnExtension').default;
    const spawn = new Spawn();
    Object.assign(spawn, { id: 'home-spawn', my: true, room: home, pos: position(25, 25, home.name), owner: { username: 'me' },
        spawning: null, store: store(0), spawnCreep(body, name, options) { calls.push({ body, name, memory: options.memory }); return 0; } });
    home.spawns.push(spawn); objects.set(spawn.id, spawn);
    const demand = loader.load('creep/demand'), queue = loader.load('creep/spawnQueue');
    const publisher = loader.load('creep/remotePopulation'), commissioning = loader.load('creep/remoteCommissioning');
    const api = loader.load('creep/reserveFlags');
    function unit(name, role, data, room = home, x = 10, y = 10, parts) {
        const body = (parts || (role === 'reserver' ? ['claim','claim','move','move'] : role === 'filler' ? ['carry','carry','move','move'] : ['work','carry','move']))
            .map(type => ({ type, hits: 100 }));
        const creep = { name, id: name, room, pos: position(x,y,room.name), body, spawning: false, ticksToLive: 600,
            store: store(0,100), owner: { username: 'me' }, memory: { name, role, spawnRoom: home.name, data,
                ready: true, working: false, boostPlan: { tier: 0, steps: [], completed: true } },
            getActiveBodyparts: part => body.filter(value => value.type === part && value.hits > 0).length };
        game.creeps[name] = creep; return creep;
    }
    unit('local-miner', 'harvester', { sourceId: homeSource.id }, home, 11, 10);
    unit('local-filler', 'filler', { sourceId: homeSource.id }, home, 25, 25);
    const configs = role => Object.values(home.memory.creepConfig).filter(config => !role || config.role === role);
    const published = (room = target) => Object.entries(home.memory.creepConfig).find(([, config]) => config.role === 'reserver' && config.data.targetRoom === room.name);
    return { game, memory, home, target, other, mine, spawn, calls, loader, api, commissioning, demand, flag, unit, configs, published,
        release({ automatic = false } = {}) {
            game.time++; home.memory.creepConfig = {};
            publisher.releaseJobsCreepConfig();
            if (automatic) loader.load('creep/developmentRemotes').releaseDevelopmentRemoteConfigs(demand.addCreepConfig);
            home.memory.creepSpawnQueue = queue.buildSpawnQueue(home);
        },
        prepareAutomatic(room = target) {
            home.memory.developmentRemotes = { candidates: [room.name], selectedRooms: [room.name], lastScanTick: game.time,
                intel: { [room.name]: { seenAt: game.time, status: 'safe', planningComplete: true,
                    sources: room.sources.map(source => ({ id: source.id, x: source.pos.x, y: source.pos.y, travelTicks: 20, energyPerTick: 5 })) } } };
        },
    };
}

test('standalone RESERVE flag publishes an unboosted continuous reserver without requiring OUT or Source vision', () => {
    for (const visible of [true, false]) {
        const w = world({ visible }); const flag = w.flag(0); w.release();
        assert.equal(w.configs('reserver').length, 1);
        assert.equal(w.configs().length, 1, 'a reserve-only flag does not create miners, carriers or a scout');
        const [name, config] = w.published();
        assert.equal(config.name, `${w.home.name}_FLAG_RESERVER_${flag.name}_0`);
        assert.equal(config.data.reserveSlot, 0);
        assert.equal(config.data.reserveFlag, flag.name); assert.equal(config.data.targetRoom, w.target.name);
        assert.equal(config.spawnPriority, 2.7); assert.equal(config.bodyProfile.boostTier, 0);
        assert.equal(config.bodyProfile.terrain, 'plain'); assert.equal(config.bodyProfile.maximumCost, 1300);
        assert.equal(w.commissioning.remoteSpawnAllowed(w.home, config), true);
        assert.ok(w.home.memory.creepSpawnQueue.includes(name));
        assert.equal(w.home.memory.remoteCommissioning?.current, undefined);
    }
});

test('RESERVE flags accept every slot 0 through 19 and deduplicate the same target deterministically', () => {
    const w = world(); for (let index = 19; index >= 0; index--) w.flag(index);
    w.release(); assert.equal(w.configs('reserver').length, 1);
    assert.equal(w.configs('reserver')[0].data.reserveFlag, `${w.home.name}_RESERVE0`);
    assert.equal(w.api.getReserveFlagForRoom(w.home, w.target.name).name, `${w.home.name}_RESERVE0`);
    for (let index = 0; index < 19; index++) delete w.game.flags[`${w.home.name}_RESERVE${index}`];
    w.release(); assert.equal(w.configs('reserver')[0].data.reserveFlag, `${w.home.name}_RESERVE19`);
});

test('foreign names, invalid slots, malformed room names, highways and keeper rooms do not publish reservation demand', () => {
    for (const suffix of ['RESERVE-1','RESERVE20','RESERVE01','RESERVE','RESERVE0-extra']) {
        const w = world(), name = `${w.home.name}_${suffix}`;
        w.game.flags[name] = { name, pos: new w.loader.globals.RoomPosition(25,25,w.target.name) };
        assert.equal(w.api.resolveReserveFlag(w.home, name), undefined); w.release(); assert.equal(w.configs().length, 0);
    }
    const w = world();
    const foreign = 'E42N6_RESERVE0'; w.game.flags[foreign] = { name: foreign, pos: { roomName: w.target.name } };
    assert.equal(w.api.resolveReserveFlag(w.home, foreign), undefined);
    for (const target of [w.home.name, 'sim', 'invalid', 'E40N5', 'E41N0', 'E44N4', 'E45N5', 'W6S6']) {
        const flag = w.flag(0, target); assert.equal(w.api.resolveReserveFlag(w.home, flag.name), undefined, target);
        w.release(); assert.equal(w.configs().length, 0, target);
    }
});

test('known owned and controllerless targets are rejected but a foreign reservation can be contested', () => {
    for (const invalid of [room => { room.controller.owner = { username: 'other' }; },
        room => { room.my = true; room.controller.my = true; room.controller.owner = { username: 'me' }; },
        room => { delete room.controller; }]) {
        const w = world(); const flag = w.flag(0); invalid(w.target);
        assert.equal(w.api.resolveReserveFlag(w.home, flag.name), undefined); w.release(); assert.equal(w.configs('reserver').length, 0);
    }
    const w = world(); w.target.controller.reservation = { username: 'other', ticksToEnd: 4000 }; w.flag(0); w.release();
    assert.equal(w.configs('reserver').length, 1);
    assert.equal(w.commissioning.remoteSpawnAllowed(w.home, w.published()[1]), true);
});

test('home capacity, working local economy, ownership, Spawn, war and evacuation gate independent reservation births', () => {
    for (const invalidate of [w => { w.home.energyCapacityAvailable = 550; },
        w => { w.home.spawns = []; }, w => { w.home.my = false; w.home.controller.my = false; },
        w => { w.game.creeps['local-miner'].spawning = true; },
        w => { delete w.game.creeps['local-filler']; },
        w => { w.memory.warMode[w.home.name] = true; },
        w => { w.home.memory.evacuation = { status: 'draining' }; }]) {
        const w = world(); w.flag(0); invalidate(w); w.release();
        assert.equal(w.configs('reserver').length, 0, invalidate.toString());
    }
});

test('stale RESERVE queues cannot spawn after their flag is deleted or moved to another room', () => {
    for (const invalidate of [w => { delete w.game.flags[`${w.home.name}_RESERVE0`]; },
        w => { w.game.flags[`${w.home.name}_RESERVE0`].pos.roomName = w.other.name; }]) {
        const w = world(); w.flag(0); w.release(); const [name, config] = w.published();
        invalidate(w); assert.equal(w.commissioning.remoteSpawnAllowed(w.home, config), false);
        w.home.memory.creepSpawnQueue = [name]; w.spawn.doWork(); assert.equal(w.calls.length, 0);
        w.release(); assert.equal(w.published(), undefined);
        if (w.game.flags[`${w.home.name}_RESERVE0`]) {
            assert.equal(w.published(w.other)[1].data.targetRoom, w.other.name);
            assert.equal(w.published(w.other)[0], name, 'the flag keeps a stable population slot when moved');
        }
    }
});

test('stale RESERVE queues stop immediately when their target becomes owned or local hauling coverage dies', () => {
    for (const invalidate of [w => { w.target.controller.owner = { username: 'other' }; },
        w => { delete w.target.controller; }, w => { delete w.game.creeps['local-filler']; }]) {
        const w = world(); w.flag(0); w.release(); const [name, config] = w.published();
        invalidate(w); assert.equal(w.commissioning.remoteSpawnAllowed(w.home, config), false);
        w.home.memory.creepSpawnQueue = [name]; w.spawn.doWork(); assert.equal(w.calls.length, 0);
    }
});

test('a newly preferred duplicate flag invalidates an older queued reserve slot for that same target', () => {
    const w = world(); w.flag(1); w.release(); const [oldName, oldConfig] = w.published();
    w.flag(0); assert.equal(w.api.getReserveFlagForRoom(w.home, w.target.name).name, `${w.home.name}_RESERVE0`);
    assert.equal(w.commissioning.remoteSpawnAllowed(w.home, oldConfig), false);
    w.home.memory.creepSpawnQueue = [oldName]; w.spawn.doWork(); assert.equal(w.calls.length, 0);
    w.release(); assert.equal(w.configs('reserver').length, 1);
    assert.equal(w.published()[1].data.reserveFlag, `${w.home.name}_RESERVE0`);
});

test('visible Invaders and Invader Cores pause standalone reservation demand and recover after clearing', () => {
    for (const threaten of [w => { w.target.enemies.push({ owner: { username: 'Invader' }, getActiveBodyparts: part => part === 'attack' ? 1 : 0 }); },
        w => { w.target.structures.push({ structureType: 'invaderCore', pos: new w.loader.globals.RoomPosition(12,12,w.target.name) }); }]) {
        const w = world(); w.flag(0); w.release(); const [name, config] = w.published(); threaten(w);
        assert.equal(w.commissioning.remoteSpawnAllowed(w.home, config), false);
        w.home.memory.creepSpawnQueue = [name]; w.spawn.doWork(); assert.equal(w.calls.length, 0);
        w.release(); assert.equal(w.configs('reserver').length, 0);
        w.target.enemies = []; w.target.structures = []; w.release(); assert.equal(w.configs('reserver').length, 1);
    }
});

test('standalone reservation of a later OUT room can run while the first OUT is still commissioning', () => {
    const w = world(); w.flag(0, w.target, 'OUT'); w.flag(1, w.other, 'OUT'); const reserve = w.flag(0, w.other); w.release();
    assert.equal(w.home.memory.remoteCommissioning.current, w.target.name);
    assert.equal(w.configs('reserver').length, 2);
    const [name, config] = w.published(w.other); assert.equal(config.data.reserveFlag, reserve.name);
    assert.equal(w.commissioning.remoteSpawnAllowed(w.home, config), true);
    assert.equal(w.configs('rHarvester').length, 0, 'the independent flag does not unlock later OUT mining');
    w.home.memory.creepSpawnQueue = [name]; w.spawn.doWork(); assert.equal(w.calls.length, 1);
    assert.equal(w.calls[0].memory.data.targetRoom, w.other.name);
});

test('RESERVE replaces manual OUT reserver publishing with one independent flag slot and its full body profile', () => {
    const w = world(); w.flag(0, w.target, 'OUT'); const reserve = w.flag(0); w.release();
    assert.equal(w.configs('reserver').length, 1); const [name, config] = w.published();
    assert.equal(config.name, `${w.home.name}_FLAG_RESERVER_${reserve.name}_0`);
    assert.equal(config.data.reserveFlag, reserve.name); assert.equal(config.bodyProfile.maximumCost, 1300);
    assert.equal(w.commissioning.remoteSpawnAllowed(w.home, config), true);
    w.unit(name, 'reserver', structuredClone(config.data), w.target, 21, 20); w.release();
    assert.equal(w.configs('reserver').length, 1); assert.ok(!w.home.memory.creepSpawnQueue.includes(name));
});

test('RESERVE and automatic OUT share one reserver instead of publishing independent replacement units', () => {
    const w = world(); const reserve = w.flag(0); w.prepareAutomatic(); w.release({ automatic: true });
    assert.equal(w.configs('reserver').length, 1); const [name, config] = w.published();
    assert.equal(config.data.reserveFlag, reserve.name); assert.equal(config.bodyProfile.maximumCost, 1300);
    assert.equal(w.commissioning.remoteSpawnAllowed(w.home, config), true);
    w.unit(name, 'reserver', structuredClone(config.data), w.target, 21, 20);
    w.target.controller.reservation = { username: 'me', ticksToEnd: 100 }; w.release({ automatic: true });
    assert.equal(w.configs('reserver').length, 1);
    assert.ok(!w.home.memory.creepSpawnQueue.includes(name));
    assert.ok(w.configs('rHarvester').length > 0, 'shared reserver coverage can commission the automatic mine');
});

test('an unseen reserve flag waits for its complete two CLAIM body at 1300 capacity instead of spawning a smaller body', () => {
    const w = world({ visible: false }); w.flag(0); w.release(); const [name] = w.published();
    w.home.memory.creepSpawnQueue = [name]; w.home.energyAvailable = 650; w.spawn.doWork(); assert.equal(w.calls.length, 0);
    w.home.energyAvailable = 1299; w.spawn.doWork(); assert.equal(w.calls.length, 0);
    w.home.energyAvailable = 1300; w.spawn.doWork(); assert.equal(w.calls.length, 1);
    assert.deepEqual(Array.from(w.calls[0].body).sort(), ['claim','claim','move','move']);
    assert.equal(w.calls[0].memory.boostPlan.tier, 0);
});

test('a 650 to 1299 capacity room uses one complete native CLAIM MOVE pair and waits until 650 current energy', () => {
    for (const capacity of [650, 800, 1299]) {
        const w = world({ capacity, visible: false }); w.flag(0); w.release(); const [name] = w.published();
        w.home.memory.creepSpawnQueue = [name]; w.home.energyAvailable = 649; w.spawn.doWork(); assert.equal(w.calls.length, 0, `${capacity}`);
        w.home.energyAvailable = 650; w.spawn.doWork(); assert.equal(w.calls.length, 1, `${capacity}`);
        assert.deepEqual(Array.from(w.calls[0].body).sort(), ['claim','move']);
    }
});

test('a flag keeps one live reserver slot and replenishes the same task after its unit dies', () => {
    const w = world(); w.flag(0); w.release(); const [name, config] = w.published();
    w.unit(name, 'reserver', structuredClone(config.data), w.target, 21,20); w.release();
    assert.equal(w.configs('reserver').length, 1); assert.ok(!w.home.memory.creepSpawnQueue.includes(name));
    w.target.controller.reservation = { username: 'me', ticksToEnd: 4500 }; w.release();
    assert.equal(w.configs('reserver').length, 1);
    delete w.game.creeps[name]; w.release(); assert.equal(w.published()[0], name);
    assert.ok(w.home.memory.creepSpawnQueue.includes(name)); w.spawn.doWork(); assert.equal(w.calls.length, 1);
    assert.deepEqual(Array.from(w.calls[0].body).sort(), ['claim','claim','move','move']);
});

test('a moved flag retargets its living stable slot without spawning an extra unit', () => {
    const w = world(); const flag = w.flag(0); w.release(); const [name, config] = w.published();
    w.unit(name, 'reserver', structuredClone(config.data), w.target, 21,20);
    flag.pos.roomName = w.other.name; w.release();
    assert.equal(w.configs('reserver').length, 1); const [movedName, moved] = w.published(w.other);
    assert.equal(movedName, name); assert.equal(moved.data.reserveFlag, flag.name);
    assert.ok(!w.home.memory.creepSpawnQueue.includes(name));
});

test('a reserver close to death publishes only its alternate slot to arrive before reservation expires', () => {
    const w = world(); const flag = w.flag(0); w.release(); const [name, config] = w.published();
    const retiring = w.unit(name, 'reserver', structuredClone(config.data), w.target, 21,20);
    retiring.ticksToLive = 1; w.target.controller.reservation = { username: 'me', ticksToEnd: 10 }; w.release();
    const handover = w.configs('reserver').find(entry => entry.data.reserveSlot === 1);
    assert.ok(handover, 'spawn lead time admits the other stable slot before death');
    assert.equal(handover.name, `${w.home.name}_FLAG_RESERVER_${flag.name}_1`);
    const nextName = Object.keys(w.home.memory.creepConfig).find(key => w.home.memory.creepConfig[key] === handover);
    assert.ok(w.home.memory.creepSpawnQueue.includes(nextName));
    w.spawn.doWork(); assert.equal(w.calls.length, 1);
    const next = w.unit(nextName, 'reserver', structuredClone(handover.data), w.home, 25,25); next.spawning = true;
    w.release(); assert.equal(w.home.memory.creepSpawnQueue.filter(key => w.home.memory.creepConfig[key].role === 'reserver').length, 0);
    delete w.game.creeps[name]; next.spawning = false; next.ticksToLive = 600; w.release();
    assert.equal(w.home.memory.creepSpawnQueue.filter(key => w.home.memory.creepConfig[key].role === 'reserver').length, 0,
        'a healthy successor does not immediately refill its vacated alternate slot');
});

test('a new RESERVE flag reuses a healthy existing OUT reserver and admits a successor only near its end of life', () => {
    for (const automatic of [false, true]) {
        const w = world();
        if (automatic) w.prepareAutomatic(); else w.flag(0, w.target, 'OUT');
        w.release({ automatic }); const [legacyName, legacyConfig] = w.published();
        assert.equal(legacyConfig.data.reserveFlag, undefined);
        const legacy = w.unit(legacyName, 'reserver', structuredClone(legacyConfig.data), w.target, 21,20);
        w.flag(0); w.release({ automatic });
        assert.equal(w.configs('reserver').filter(config => config.data.reserveFlag).length, 0,
            'healthy paid controller coverage does not need another flag reserver');
        assert.equal(legacy.memory.data.reserveFlag, undefined);
        assert.equal(w.home.memory.creepSpawnQueue.filter(key => w.home.memory.creepConfig[key].role === 'reserver').length, 0);
        legacy.ticksToLive = 1; w.release({ automatic });
        const next = w.configs('reserver').filter(config => config.data.reserveFlag);
        assert.equal(next.length, 1); assert.equal(next[0].data.reserveSlot, 0);
        assert.equal(next[0].bodyProfile.maximumCost, 1300);
    }
});

test('inactive automatic reservers cannot suppress a flag successor despite their long remaining lifespan', () => {
    const cases = [
        ['retiring', (_w, legacy) => { legacy.memory.data.developmentRemote.retiring = true; }],
        ['automatic room disabled', w => { w.home.memory.developmentRemotes.enabled = false; }],
        ['room growth disabled', w => { w.home.memory.fastUpgrade = false; }],
        ['automatic policy disabled', w => { w.loader.load('settings/developmentRemotes').developmentRemotePolicy.enabled = false; }],
        ['no longer selected', w => { w.home.memory.developmentRemotes.selectedRooms = []; }],
        ['unsafe intel', w => { w.home.memory.developmentRemotes.intel[w.target.name].status = 'blocked'; }],
        ['temporarily blocked intel', w => { w.home.memory.developmentRemotes.intel[w.target.name].blockedUntil = w.game.time + 1000; }],
        ['stale intel', w => { w.home.memory.developmentRemotes.intel[w.target.name].seenAt = -100000; }],
        ['manual OUT takeover', w => { w.flag(0, w.target, 'OUT'); }],
        ['foreign reservation', w => { w.target.controller.reservation = { username: 'other', ticksToEnd: 4000 }; }],
    ];
    for (const [description, invalidate] of cases) {
        const w = world(); w.prepareAutomatic(); w.release({ automatic: true });
        const [legacyName, legacyConfig] = w.published();
        const legacy = w.unit(legacyName, 'reserver', structuredClone(legacyConfig.data), w.target, 21,20);
        assert.equal(legacy.ticksToLive, 600); invalidate(w, legacy);
        const flag = w.flag(0); w.release();
        const config = w.configs('reserver').find(config => config.data.reserveFlag === flag.name);
        assert.ok(config, `${description}: the flag immediately fills coverage vacated by inactive automatic work`);
        assert.equal(config.data.reserveSlot, 0, description);
        const name = Object.keys(w.home.memory.creepConfig).find(key => w.home.memory.creepConfig[key] === config);
        assert.ok(w.home.memory.creepSpawnQueue.includes(name), description);
        assert.equal(w.commissioning.remoteSpawnAllowed(w.home, config), true, description);
        w.home.memory.creepSpawnQueue = [name]; w.spawn.doWork(); assert.equal(w.calls.length, 1, description);
        assert.equal(w.calls[0].memory.data.reserveFlag, flag.name, description);
        assert.deepEqual(Array.from(w.calls[0].body).sort(), ['claim','claim','move','move'], description);
    }
});
