const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

const copy = value => JSON.parse(JSON.stringify(value));
function position(x, y, roomName) {
    return { x, y, roomName, getRangeTo(target) {
        const pos = target.pos || target;
        return Math.max(Math.abs(this.x - pos.x), Math.abs(this.y - pos.y));
    } };
}
function coordinates(roomName) {
    const match = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);
    return [match[1] === 'E' ? Number(match[2]) : -Number(match[2]) - 1,
        match[3] === 'S' ? Number(match[4]) : -Number(match[4]) - 1];
}
function distance(first, second) {
    const a = coordinates(first), b = coordinates(second);
    return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
}

/** Actual modules switch between three shard worlds and a shared bus; unowned rooms need a native move before becoming visible. */
function world(roundTrip, options = {}) {
    const bus = new Map(), calls = [], frames = {};
    const clock = { now: 1000000 };
    const hops = options.hops || [
        { shard: 'shard3', roomName: 'W0N0', x: 12, y: 13, destinationShard: 'shard2', destinationRoom: 'W1N1' },
        { shard: 'shard2', roomName: 'W0N0', x: 20, y: 20, destinationShard: 'shard1', destinationRoom: 'W1N1' },
        ...(roundTrip ? [
            { shard: 'shard1', roomName: 'W0N0', x: 12, y: 13, destinationShard: 'shard2', destinationRoom: 'W1N1' },
            { shard: 'shard2', roomName: 'W0N0', x: 10, y: 10, destinationShard: 'shard3', destinationRoom: 'W1N1' },
        ] : []),
    ];
    function room(shard, name, owned = false, controllerPresent = false) {
        const portals = hops.filter(hop => hop.shard === shard && hop.roomName === name).map((hop, i) => ({
            id: `${shard}-${name}-${i}`, structureType: 'portal', pos: position(hop.x, hop.y, name),
            destination: { shard: hop.destinationShard, room: hop.destinationRoom },
        }));
        return {
            name, my: owned, level: owned ? 8 : 1, memory: { creepConfig: {}, creepSpawnQueue: [] }, energyAvailable: 3000, energyCapacityAvailable: 3000,
            ...(controllerPresent ? { controller: { my: owned, level: owned ? 8 : 1, pos: position(25, 25, name), ticksToDowngrade: 10000,
                ...(owned ? { owner: { username: 'me' } } : {}) } } : {}),
            spawns: [], extensions: [], containers: [], sources: [], constructionSites: [], structuresNeedRepair: [], portals,
            find(type) {
                if (type === 'my-spawns') return this.spawns;
                if (type === 'structures' || type === 'my-structures') return [...this.spawns, ...(this.observer ? [this.observer] : []), ...this.portals];
                return [];
            },
            lookForAt(type, x, y) { return this.portals.filter(portal => portal.pos.x === x && portal.pos.y === y); },
        };
    }
    for (const [shard, time] of [['shard3', 100000], ['shard2', 7], ['shard1', 4000]]) {
        frames[shard] = { time, creeps: {}, allRooms: {}, visible: {}, structures: {}, memory: { creeps: {}, rooms: {}, warMode: {} } };
        frames[shard].allRooms.W1N1 = room(shard, 'W1N1', shard === 'shard3', shard !== 'shard2');
        frames[shard].allRooms.W0N0 = room(shard, 'W0N0');
    }
    for (const hop of hops) {
        frames[hop.shard].allRooms[hop.roomName] ||= room(hop.shard, hop.roomName);
        frames[hop.destinationShard].allRooms[hop.destinationRoom] ||= room(hop.destinationShard, hop.destinationRoom);
    }
    const home = frames.shard3.allRooms.W1N1;
    home.spawns.push({ id: 'source-spawn', my: true, structureType: 'spawn', pos: position(11, 10, home.name) });
    const observer = { id: 'source-observer', my: true, structureType: 'observer', room: home, pos: position(25, 25, home.name), isActive: () => true,
        observeRoom: roomName => { calls.push({ type: 'observe', shard: 'shard3', roomName }); return 0; } };
    home.observer = observer;
    frames.shard3.structures[observer.id] = observer;
    frames.shard3.visible = { W1N1: home, W0N0: frames.shard3.allRooms.W0N0 };
    for (const [shard, names] of Object.entries(options.visible || {})) {
        frames[shard].visible = Object.fromEntries(names.map(name => [name, frames[shard].allRooms[name]]));
    }
    const game = { shard: { name: 'shard3' }, cpu: { limit: 100, tickLimit: 500, bucket: 10000, getUsed: () => 0 },
        map: { getRoomStatus: () => ({ status: 'normal', timestamp: null }), getRoomLinearDistance: distance,
            findRoute: (from, to) => Array.from({ length: distance(from, to) }, () => ({ exit: 1, room: to })) },
        getObjectById: id => frames[game.shard.name].structures[id],
    };
    const loader = createSourceLoader({ globals: {
        Game: game, Memory: frames.shard3.memory, Date: class extends Date { static now() { return clock.now; } },
        InterShardMemory: { getLocal: () => bus.get(game.shard.name) || '', getRemote: shard => bus.get(shard) || '', setLocal: value => bus.set(game.shard.name, value) },
        RoomPosition: class { constructor(x, y, roomName) { Object.assign(this, position(x, y, roomName)); } },
        RESOURCE_ENERGY: 'energy', WORK: 'work', CARRY: 'carry', MOVE: 'move', CLAIM: 'claim', ATTACK: 'attack', RANGED_ATTACK: 'ranged_attack', HEAL: 'heal', TOUGH: 'tough',
        BODYPART_COST: { work: 100, carry: 50, move: 50, claim: 600, attack: 80, ranged_attack: 150, heal: 250, tough: 10 },
        FIND_MY_SPAWNS: 'my-spawns', FIND_STRUCTURES: 'structures', FIND_MY_STRUCTURES: 'my-structures', FIND_SOURCES: 'sources', FIND_MY_CONSTRUCTION_SITES: 'my-sites', FIND_DROPPED_RESOURCES: 'dropped',
        FIND_HOSTILE_CREEPS: 'hostile-creeps', FIND_HOSTILE_STRUCTURES: 'hostile-structures',
        STRUCTURE_PORTAL: 'portal', STRUCTURE_OBSERVER: 'observer', STRUCTURE_TOWER: 'tower', STRUCTURE_SPAWN: 'spawn', STRUCTURE_EXTENSION: 'extension', STRUCTURE_CONTAINER: 'container',
        STRUCTURE_STORAGE: 'storage', STRUCTURE_TERMINAL: 'terminal', STRUCTURE_RAMPART: 'rampart', STRUCTURE_WALL: 'constructedWall',
        TOWER_ENERGY_COST: 10, OBSERVER_RANGE: 10, LOOK_STRUCTURES: 'structures', OK: 0, ERR_NO_PATH: -2, ERR_TIRED: -11, ERR_NOT_IN_RANGE: -9,
    }, modules: { utils: { sha1String: value => createHash('sha1').update(value).digest('hex') }, role: { isRoleSupported: () => true } } });
    const policy = loader.load('settings/interShard').interShardPolicy;
    policy.peers = ['shard3', 'shard2', 'shard1'];
    policy.reportInterval = 1;
    const controller = loader.load('shard/controller'), transport = loader.load('shard/transport');
    const scouting = loader.load('shard/scouting'), intel = loader.load('shard/portalIntel');
    function select(shard, advance = false) {
        const frame = frames[shard];
        if (advance) { frame.time++; clock.now += 1000; }
        game.shard.name = shard;
        game.time = frame.time;
        game.creeps = frame.creeps;
        game.structures = frame.structures;
        game.rooms = { ...frame.visible };
        for (const creep of Object.values(frame.creeps)) game.rooms[creep.room.name] = creep.room;
        loader.globals.Memory = frame.memory;
    }
    const report = () => { controller.runShardController(); transport.flushInterShardMemory(); };
    const state = shard => JSON.parse(bus.get(shard) || '{}').ecbotShard;
    function unit(name, shard, activeRoom, initialMemory = {}, pos = position(9, 10, activeRoom.name)) {
        const frame = frames[shard];
        frame.memory.creeps[name] = copy(initialMemory);
        const creep = { name, id: `${shard}:${name}`, shard, my: true, spawning: false, owner: { username: 'me' },
            room: activeRoom, pos, hits: 100, hitsMax: 100, ticksToLive: 1400, fatigue: 0,
            store: { energy: 0, getCapacity: () => 0, getFreeCapacity: () => 0 }, getActiveBodyparts: () => 0,
            moveTo: (target, options) => { creep.intent = { target, options }; calls.push({ type: 'move', shard: game.shard.name, name, target, options }); return 0; },
        };
        for (const action of ['harvest', 'build', 'upgradeController', 'claimController', 'withdraw', 'transfer', 'drop']) {
            creep[action] = () => { calls.push({ type: action, shard: game.shard.name, name }); return 0; };
        }
        Object.defineProperty(creep, 'memory', { get: () => frame.memory.creeps[name], set: value => { frame.memory.creeps[name] = value; } });
        frame.creeps[name] = creep;
        return creep;
    }
    function step(creep) {
        select(creep.shard, true); report();
        const behavior = scouting.createShardScoutRole(creep.memory.data);
        delete creep.intent;
        if (behavior.prepare(creep)) behavior.target(creep);
        report();
        const target = creep.intent?.target;
        if (target === undefined) return creep;
        const frame = frames[creep.shard];
        const nextRoom = frame.allRooms[target.roomName] || (frame.allRooms[target.roomName] = room(creep.shard, target.roomName));
        const portal = nextRoom.portals.find(entry => entry.pos.x === target.x && entry.pos.y === target.y);
        if (portal !== undefined && creep.pos.roomName === target.roomName && creep.pos.getRangeTo(target) <= 1 &&
            creep.memory.data.transferPreparedAt !== undefined && creep.memory.data.transferPreparedAt < game.time) {
            const destination = portal.destination;
            delete frame.creeps[creep.name]; delete frame.memory.creeps[creep.name];
            select(creep.shard, true); report();
            select(destination.shard, true);
            const landing = frames[destination.shard].allRooms[destination.room];
            const arriving = unit(creep.name, destination.shard, landing, {}, position(25, 25, landing.name));
            select(destination.shard); report();
            assert.equal(arriving.memory.role, 'sScout');
            assert.equal(arriving.memory.data.transferPreparedAt, undefined);
            return arriving;
        }
        // Native moves are modeled at room granularity; an entrance always needs a later adjacent publication tick.
        creep.room = nextRoom;
        creep.pos = position(portal ? target.x - 1 : target.x, target.y, nextRoom.name);
        return creep;
    }
    function sourceMaintenance() {
        select('shard3', true); report();
        home.memory.creepConfig = {};
        controller.releaseShardCreepConfig();
        transport.flushInterShardMemory();
    }
    let missionKey;
    const mission = () => {
        const tasks = frames.shard3.memory.shardMissions || {};
        missionKey ||= Object.values(tasks).find(task => task.task.id === 'explore-settle')?.task.key;
        return tasks[missionKey];
    };
    select('shard3');
    return { frames, calls, clock, game, policy, home, loader, controller, intel, select, report, state, unit, step, sourceMaintenance,
        mission };
}

for (const roundTrip of [false, true]) test(`real three-shard ${roundTrip ? 'outward and return' : 'one-way'} exploration discovers unowned-shard doors, then a fresh scout gates work`, () => {
    const w = world(roundTrip);
    for (const shard of ['shard2', 'shard1']) {
        w.select(shard); w.report();
        assert.equal(Object.keys(w.game.rooms).length, 0);
        assert.equal(w.intel.getPortalIntelStatus().observers, 0);
        assert.equal(w.intel.getPortalIntelStatus().portals, 0);
    }
    w.select('shard3'); w.report();
    assert.equal(w.intel.getKnownPortals().length, 1, 'only 3 -> 2 is initially observed');
    assert.match(w.controller.createShardTask('W1N1', 'shard1/W1N1', { id: 'explore-settle', builders: 1, haulers: roundTrip ? 1 : 0 }), /已创建/);
    w.controller.releaseShardCreepConfig();
    const mission = w.mission();
    assert.equal(mission.routing.status, 'waiting');
    assert.equal(mission.task.explorePortals, true);
    const [explorerName, initial] = Object.entries(w.home.memory.creepConfig)[0];
    assert.deepEqual(Object.values(w.home.memory.creepConfig).map(config => config.role), ['sScout']);
    assert.ok(initial.data.exploration);
    assert.equal(initial.data.scouting, undefined);
    assert.equal(mission.leases['explorer:0'].name, explorerName);
    assert.deepEqual(copy(initial.data.route).map(hop => hop.destinationShard), ['shard2']);
    let explorer = w.unit(explorerName, 'shard3', w.home, initial);
    let middleCrawled = false, returnCrawled = false;
    for (let tick = 0; tick < 200 && mission.routing.status !== 'ready'; tick++) {
        explorer = w.step(explorer);
        if (explorer.shard === 'shard2' && explorer.room.name === 'W0N0') middleCrawled = true;
        if (explorer.shard === 'shard1' && explorer.room.name === 'W0N0') returnCrawled = true;
        w.sourceMaintenance();
        assert.equal(Object.values(w.home.memory.creepConfig).some(config => config.role !== 'sScout'), false);
    }
    assert.equal(middleCrawled, true, 'the 2 -> 1 portal is discovered by reaching its previously invisible room');
    assert.equal(mission.routing.status, 'ready', mission.lastError || mission.routing.message);
    assert.deepEqual(copy(mission.task.route).map(hop => `${hop.shard}->${hop.destinationShard}`), ['shard3->shard2', 'shard2->shard1']);
    assert.equal(w.state('shard2').portalIntel.portals.some(portal => portal.destinationShard === 'shard1'), true);
    assert.ok(w.state('shard2').explorationReports?.[mission.task.key], 'progress uses the independent exploration namespace');
    assert.equal(w.state('shard1').scoutProofs?.[`${mission.task.key}:outbound`], undefined, 'an explorer cannot produce a verification proof');
    if (roundTrip) {
        assert.equal(returnCrawled, true, 'the missing 1 -> 2 door is discovered on foot');
        assert.deepEqual(copy(mission.task.returnRoute).map(hop => `${hop.shard}->${hop.destinationShard}`), ['shard1->shard2', 'shard2->shard3']);
    }
    const [scoutName, scoutConfig] = Object.entries(w.home.memory.creepConfig).find(([, config]) => config.data.scouting !== undefined);
    assert.notEqual(scoutName, explorerName);
    assert.equal(scoutConfig.data.exploration, undefined);
    assert.equal(mission.scouting.status, 'scouting');
    assert.equal(Object.values(w.home.memory.creepConfig).some(config => config.role !== 'sScout'), false);
    let scout = w.unit(scoutName, 'shard3', w.home, scoutConfig);
    for (let tick = 0; tick < 200 && mission.scouting.status !== 'verified'; tick++) {
        scout = w.step(scout);
        w.sourceMaintenance();
        if (mission.scouting.status !== 'verified') assert.equal(Object.values(w.home.memory.creepConfig).some(config => config.role !== 'sScout'), false);
    }
    assert.equal(mission.scouting.status, 'verified', mission.scouting.lastError || mission.lastError);
    const outbound = w.state('shard1').scoutProofs[`${mission.task.key}:outbound`];
    assert.equal(outbound.scoutName, scoutName);
    assert.equal(outbound.roomName, 'W1N1');
    assert.equal(outbound.revision, mission.scouting.revision);
    if (roundTrip) {
        const returning = w.state('shard3').scoutProofs[`${mission.task.key}:return`];
        assert.equal(returning.scoutName, scoutName);
        assert.equal(returning.revision, outbound.revision);
        assert.equal(returning.roomName, w.home.name);
    }
    assert.deepEqual(Object.values(w.home.memory.creepConfig).map(config => config.role).sort(),
        roundTrip ? ['sBuilder', 'sClaimer', 'sHauler'] : ['sBuilder', 'sClaimer']);
    assert.equal(w.calls.some(call => !['move', 'observe'].includes(call.type)), false);
    assert.equal(w.calls.some(call => call.type === 'observe' && call.shard !== 'shard3'), false);
});

function nearestPortalHops() {
    return [
        { shard: 'shard3', roomName: 'W0N0', x: 12, y: 13, destinationShard: 'shard2', destinationRoom: 'W40N40' },
        { shard: 'shard3', roomName: 'W10N0', x: 12, y: 13, destinationShard: 'shard2', destinationRoom: 'W0N0' },
        { shard: 'shard2', roomName: 'W40N40', x: 20, y: 20, destinationShard: 'shard1', destinationRoom: 'W90N90' },
        { shard: 'shard2', roomName: 'W0N0', x: 20, y: 20, destinationShard: 'shard1', destinationRoom: 'W1N1' },
    ];
}

function verifyNearestRouteAndRelease(w, expected, explorerName) {
    const mission = w.mission();
    const [scoutName, scoutConfig] = Object.entries(w.home.memory.creepConfig).find(([, config]) => config.data.scouting !== undefined);
    assert.deepEqual(copy(scoutConfig.data.route), expected);
    assert.equal(scoutConfig.data.exploration, undefined);
    assert.equal(mission.scouting.status, 'scouting');
    assert.deepEqual(Object.values(w.home.memory.creepConfig).map(config => config.role), ['sScout']);
    const proof = { missionId: mission.task.key, sourceShard: 'shard3', scoutName, revision: mission.scouting.revision,
        leg: 'outbound', result: 'verified', shard: 'shard1', roomName: 'W1N1', updatedAt: w.clock.now,
        elapsedTicks: 1, route: copy(expected) };
    const verification = w.loader.load('shard/verification');
    assert.equal(verification.acceptScoutProof(mission, { ...proof, scoutName: explorerName || 'another-scout' }, 'shard1'), false,
        'an explorer or another scout identity cannot certify this verifier lease');
    const alternatives = nearestPortalHops();
    assert.equal(verification.acceptScoutProof(mission, { ...proof, route: [alternatives[1], alternatives[3]] }, 'shard1'), false,
        'a different complete route cannot certify the nearest candidate route');
    assert.equal(mission.scouting.status, 'scouting');
    let scout = w.unit(scoutName, 'shard3', w.home, scoutConfig);
    for (let tick = 0; tick < 200 && mission.scouting.status !== 'verified'; tick++) {
        scout = w.step(scout); w.sourceMaintenance();
        if (mission.scouting.status !== 'verified') assert.equal(Object.values(w.home.memory.creepConfig).some(config => config.role !== 'sScout'), false);
    }
    assert.equal(mission.scouting.status, 'verified', mission.scouting.lastError || mission.lastError);
    const actual = w.state('shard1').scoutProofs[`${mission.task.key}:outbound`];
    assert.equal(actual.scoutName, scoutName);
    assert.deepEqual(copy(actual.route), expected);
    assert.deepEqual(Object.values(w.home.memory.creepConfig).map(config => config.role).sort(), ['sBuilder', 'sClaimer']);
    for (const config of Object.values(w.home.memory.creepConfig)) assert.deepEqual(copy(config.data.route), expected);
    assert.equal(w.calls.some(call => call.type === 'move' && call.shard === 'shard3' && call.target.roomName === 'W10N0'), false,
        'the exact scout route and worker configs must not revert to the globally shorter far entrance');
}

test('real explorer crosses only the nearest 3-to-2 entrance, then chooses the nearest 2-to-1 entrance from its landing room', () => {
    const hops = nearestPortalHops(), expected = [hops[0], hops[2]];
    const w = world(false, { hops, visible: { shard3: ['W1N1', 'W0N0', 'W10N0'] } });
    w.report();
    assert.equal(w.intel.getKnownPortals().length, 2);
    assert.match(w.controller.createShardTask('W1N1', 'shard1/W1N1', { id: 'explore-settle', builders: 1, haulers: 0 }), /已创建/);
    w.controller.releaseShardCreepConfig();
    const mission = w.mission();
    assert.equal(mission.routing.status, 'waiting');
    const [explorerName, initial] = Object.entries(w.home.memory.creepConfig)[0];
    assert.deepEqual(copy(initial.data.route), [hops[0]], 'source exploration publishes exactly the locally nearest first hop');
    assert.ok(initial.data.exploration);
    // Earlier visits on shard2 supply both real next doors after this explorer has already been assigned its first crossing.
    w.frames.shard2.visible = Object.fromEntries(['W0N0', 'W40N40'].map(name => [name, w.frames.shard2.allRooms[name]]));
    w.select('shard2', true); w.report();
    let explorer = w.unit(explorerName, 'shard3', w.home, initial);
    for (let tick = 0; tick < 20 && explorer.shard !== 'shard2'; tick++) explorer = w.step(explorer);
    assert.equal(explorer.shard, 'shard2');
    assert.equal(explorer.room.name, 'W40N40');
    assert.deepEqual(copy(explorer.memory.data.route), [hops[0]]);
    explorer = w.step(explorer);
    assert.deepEqual(copy(explorer.memory.data.route), expected,
        'the nearer current-shard entrance wins even though its shard1 landing is much farther from the target');
    assert.equal(w.state('shard1')?.scoutProofs?.[`${mission.task.key}:outbound`], undefined);
    assert.equal(mission.scouting.status === 'verified', false);
    for (let tick = 0; tick <= w.policy.portalRouting.retryInterval && mission.routing.status !== 'ready'; tick++) w.sourceMaintenance();
    assert.equal(mission.routing.status, 'ready');
    assert.deepEqual(copy(mission.task.route), expected, 'source full planning preserves the explorer nearest-hop policy');
    verifyNearestRouteAndRelease(w, expected, explorerName);
});

test('real ready-intel automatic task dispatches its verifier and workers through nearest shard entrances even when the far route has lower total cost', () => {
    const hops = nearestPortalHops(), expected = [hops[0], hops[2]];
    const w = world(false, { hops, visible: { shard3: ['W1N1', 'W0N0', 'W10N0'], shard2: ['W0N0', 'W40N40'] } });
    w.select('shard2'); w.report(); w.select('shard3'); w.report();
    assert.equal(w.intel.getKnownPortals().length, 4);
    const localFirstCost = distance('W1N1', 'W0N0') + distance('W40N40', 'W40N40') + distance('W90N90', 'W1N1');
    const globalAlternativeCost = distance('W1N1', 'W10N0') + distance('W0N0', 'W0N0') + distance('W1N1', 'W1N1');
    assert.ok(localFirstCost > globalAlternativeCost, 'the fixture deliberately makes the far source entrance globally cheaper');
    assert.match(w.controller.createShardTask('W1N1', 'shard1/W1N1', { id: 'explore-settle', builders: 1, haulers: 0 }), /已创建/);
    w.controller.releaseShardCreepConfig();
    assert.equal(w.mission().routing.status, 'ready');
    assert.deepEqual(copy(w.mission().task.route), expected);
    assert.equal(w.mission().leases['explorer:0'], undefined, 'complete intel needs verification instead of a new exploration unit');
    verifyNearestRouteAndRelease(w, expected);
});
