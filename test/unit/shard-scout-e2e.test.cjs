const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function position(x, y, roomName) {
    return { x, y, roomName, getRangeTo(target) {
        const pos = target.pos || target;
        return Math.max(Math.abs(this.x - pos.x), Math.abs(this.y - pos.y));
    } };
}

/** Actual discovery, planning, controller, scout, travel and transport; only native intents are simulated. */
function world() {
    const bus = new Map();
    const clock = { now: 1000000 };
    const calls = [];
    const outward = { shard: 'shard0', roomName: 'W1N1', x: 10, y: 10, destinationShard: 'shard1', destinationRoom: 'W3N3' };
    const returning = { shard: 'shard1', roomName: 'W3N3', x: 20, y: 20, destinationShard: 'shard0', destinationRoom: 'W1N1' };
    function room(name, level, hop) {
        const portal = { id: `${hop.shard}-portal`, structureType: 'portal', pos: position(hop.x, hop.y, name), destination: { shard: hop.destinationShard, room: hop.destinationRoom } };
        return {
            name, my: true, level, memory: { creepConfig: {}, creepSpawnQueue: [] }, energyAvailable: 3000, energyCapacityAvailable: 3000,
            controller: { my: true, level, owner: { username: 'me' }, pos: position(25, 25, name), ticksToDowngrade: 10000 },
            spawns: [], extensions: [], containers: [], sources: [], constructionSites: [], structuresNeedRepair: [], portals: [portal],
            find(type) {
                if (type === 'my-spawns') return this.spawns;
                if (type === 'structures') return [...this.spawns, ...this.portals];
                return [];
            },
            lookForAt(type, x, y) { return this.portals.filter(entry => entry.pos.x === x && entry.pos.y === y); },
        };
    }
    const sourceRoom = room('W1N1', 8, outward);
    const targetRoom = room('W3N3', 1, returning);
    sourceRoom.spawns.push({ id: 'source-spawn', my: true, structureType: 'spawn', pos: position(11, 10, sourceRoom.name) });
    const frames = {};
    for (const [shard, activeRoom, tick] of [['shard0', sourceRoom, 100000], ['shard1', targetRoom, 7]]) {
        frames[shard] = { time: tick, rooms: { [activeRoom.name]: activeRoom }, creeps: {}, memory: { creeps: {}, warMode: {}, rooms: { [activeRoom.name]: activeRoom.memory } } };
    }
    const game = { shard: { name: 'shard0' }, structures: {}, cpu: { bucket: 10000, getUsed: () => 0 },
        map: { getRoomStatus: () => ({ status: 'normal', timestamp: null }), getRoomLinearDistance: () => 1,
            findRoute: (from, to) => from === to ? [] : [{ exit: 1, room: to }] },
        getObjectById: () => undefined,
    };
    const loader = createSourceLoader({ globals: {
        Game: game, Memory: frames.shard0.memory, Date: class extends Date { static now() { return clock.now; } },
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
    policy.peers = ['shard0', 'shard1'];
    policy.reportInterval = 1;
    const controller = loader.load('shard/controller');
    const transport = loader.load('shard/transport');
    const scouting = loader.load('shard/scouting');
    function select(shard, advance = false) {
        const frame = frames[shard];
        if (advance) { frame.time++; clock.now += 1000; }
        game.shard.name = shard;
        game.time = frame.time;
        game.rooms = frame.rooms;
        game.creeps = frame.creeps;
        loader.globals.Memory = frame.memory;
    }
    const report = () => { controller.runShardController(); transport.flushInterShardMemory(); };
    const state = shard => JSON.parse(bus.get(shard)).ecbotShard;
    function unit(name, activeRoom, initialMemory = {}, pos = position(9, 10, activeRoom.name)) {
        const frame = frames[game.shard.name];
        frame.memory.creeps[name] = JSON.parse(JSON.stringify(initialMemory));
        const creep = { name, id: `${game.shard.name}:${name}`, my: true, spawning: false, owner: { username: 'me' },
            room: activeRoom, pos, hits: 100, hitsMax: 100, ticksToLive: 1400, fatigue: 0,
            store: { energy: 0, getCapacity: () => 0, getFreeCapacity: () => 0 }, getActiveBodyparts: () => 0,
            moveTo: (target, options) => { calls.push({ type: 'move', shard: game.shard.name, name, target, options }); return 0; },
        };
        for (const action of ['harvest', 'build', 'upgradeController', 'claimController', 'withdraw', 'transfer', 'drop']) {
            creep[action] = () => { calls.push({ type: action, shard: game.shard.name, name }); return 0; };
        }
        Object.defineProperty(creep, 'memory', { get: () => frame.memory.creeps[name], set: value => { frame.memory.creeps[name] = value; } });
        frame.creeps[name] = creep;
        return creep;
    }
    const behavior = creep => scouting.createShardScoutRole(creep.memory.data);
    function cross(creep, destination, activeRoom, arrivalPos) {
        const from = game.shard.name;
        const previousMoves = calls.length;
        assert.equal(behavior(creep).prepare(creep), true);
        behavior(creep).source(creep);
        assert.equal(creep.memory.data.transferPreparedAt, game.time);
        assert.equal(calls.length, previousMoves, 'persist first, then wait one local source tick');
        select(from, true); report();
        behavior(creep).source(creep);
        assert.equal(calls.at(-1).options.range, 0);
        report();
        delete frames[from].creeps[creep.name];
        delete frames[from].memory.creeps[creep.name];
        select(from, true); report();
        select(destination, true);
        const arriving = unit(creep.name, activeRoom, {}, arrivalPos);
        report();
        assert.equal(arriving.memory.role, 'sScout');
        assert.equal(arriving.memory.data.hopIndex, 1);
        assert.equal(arriving.memory.data.transferPreparedAt, undefined);
        return arriving;
    }
    select('shard0');
    return { frames, game, clock, calls, controller, policy, loader, select, report, state, unit, behavior, cross, sourceRoom, targetRoom };
}

test('real two-shard scout restores its candidate, persists both actual endpoint proofs, and only then releases a hauler', () => {
    const w = world();
    w.select('shard1'); w.report();
    w.select('shard0'); w.report();
    assert.match(w.controller.createShardTask('W1N1', 'shard1/W3N3', { id: 'verified-haul', claim: false, builders: 0, haulers: 1 }), /已创建/);
    w.controller.releaseShardCreepConfig();
    const mission = Object.values(w.frames.shard0.memory.shardMissions)[0];
    assert.equal(mission.routing.status, 'ready');
    assert.equal(mission.task.verifyRoute, true);
    assert.deepEqual(Object.values(w.sourceRoom.memory.creepConfig).map(config => config.role), ['sScout']);
    const [name, config] = Object.entries(w.sourceRoom.memory.creepConfig)[0];
    const body = w.loader.load('settings/creep').bodyConfigs.sScout;
    assert.deepEqual(JSON.parse(JSON.stringify(body)), [{ move: 1 }]);
    const revision = mission.scouting.revision;
    const sourceScout = w.unit(name, w.sourceRoom, config);
    const outbound = w.cross(sourceScout, 'shard1', w.targetRoom, position(10, 10, w.targetRoom.name));
    assert.equal(outbound.memory.data.scouting.revision, revision);
    w.behavior(outbound).target(outbound);
    const outboundProof = w.state('shard1').scoutProofs[`${mission.task.key}:outbound`];
    assert.equal(outboundProof.result, 'verified');
    assert.equal(outboundProof.scoutName, name);
    assert.equal(outboundProof.revision, revision);
    assert.equal(outboundProof.shard, 'shard1');
    assert.equal(outboundProof.roomName, w.targetRoom.name);
    assert.equal(outboundProof.observation.my, true);
    assert.equal(outbound.memory.data.phase, 'return');
    assert.ok(outboundProof.elapsedTicks > 0 && outboundProof.elapsedTicks < 20, 'independent shard Game.time values do not become an elapsed duration');

    w.select('shard0', true); w.report();
    w.sourceRoom.memory.creepConfig = {};
    w.controller.releaseShardCreepConfig();
    assert.equal(mission.scouting.outbound, true);
    assert.notEqual(mission.scouting.status, 'verified');
    assert.equal(Object.values(w.sourceRoom.memory.creepConfig).some(entry => entry.role === 'sHauler'), false);

    w.select('shard1', true);
    outbound.pos = position(19, 20, w.targetRoom.name);
    const returned = w.cross(outbound, 'shard0', w.sourceRoom, position(10, 10, w.sourceRoom.name));
    assert.equal(returned.memory.data.originShard, 'shard1');
    assert.equal(returned.memory.data.scouting.revision, revision);
    w.behavior(returned).target(returned);
    const returnProof = w.state('shard0').scoutProofs[`${mission.task.key}:return`];
    assert.equal(returnProof.result, 'verified');
    assert.equal(returnProof.scoutName, name);
    assert.equal(returnProof.revision, revision);
    assert.equal(returnProof.shard, 'shard0');
    assert.equal(returnProof.roomName, w.sourceRoom.name);
    assert.deepEqual(returnProof.route, JSON.parse(JSON.stringify(mission.task.returnRoute)));
    assert.equal(returned.memory.data.done, true);

    w.select('shard0', true); w.report();
    w.sourceRoom.memory.creepConfig = {};
    w.controller.releaseShardCreepConfig();
    assert.equal(mission.scouting.status, 'verified');
    assert.equal(mission.scouting.returning, true);
    assert.deepEqual(Object.values(w.sourceRoom.memory.creepConfig).map(entry => entry.role), ['sHauler']);
    assert.equal(mission.leases['scout:0'].name, name);
    assert.equal(w.state('shard0').reports[mission.task.key].scoutStatus, 'verified');
    assert.equal(w.calls.some(call => call.type !== 'move'), false, 'a scout performs no resource or expansion actions');
});
