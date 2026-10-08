const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

const coreTypes = [
    ['extensions', 'extension', 'EXTENSION_HITS', 1000], ['spawns', 'spawn', 'SPAWN_HITS', 5000],
    ['towers', 'tower', 'TOWER_HITS', 3000], ['labs', 'lab', 'LAB_HITS', 500],
    ['containers', 'container', 'CONTAINER_HITS', 250000], ['links', 'link', 'LINK_HITS_MAX', 1000],
    ['nuker', 'nuker', 'NUKER_HITS', 1000], ['storage', 'storage', 'STORAGE_HITS', 10000],
    ['factory', 'factory', 'FACTORY_HITS', 1000], ['terminal', 'terminal', 'TERMINAL_HITS', 3000],
    ['observer', 'observer', 'OBSERVER_HITS', 500], ['extractor', 'extractor', 'EXTRACTOR_HITS', 500],
    ['powerSpawn', 'powerSpawn', 'POWER_SPAWN_HITS', 5000],
];

function world(constants = Object.fromEntries(coreTypes.map(([, , name, hits]) => [name, hits]))) {
    let hitReads = 0, maxReads = 0;
    const actions = [];
    const game = { time: 1, shard: { name: 'shard3' }, cpu: { bucket: 1 }, rooms: {}, creeps: {}, powerCreeps: {} };
    const loader = createSourceLoader({ globals: { Game: game, Memory: { warMode: {} }, OK: 0,
        RESOURCE_ENERGY: 'energy', TOWER_ENERGY_COST: 10, ...constants }, modules: {
        'settings/roomPolicy': { roomPolicy: { defense: { lowBucketRoadInspectionInterval: 1 } } },
    } });
    const repair = loader.load('room/defense').repairStructure;
    function core(type, id, hits, hitsMax, roomName) {
        return { id, structureType: type, my: true, pos: { x: 10, y: 10, roomName },
            get hits() { hitReads++; return hits; }, get hitsMax() { maxReads++; return hitsMax; },
            store: { energy: 1000 }, isActive: () => true,
            repair(target) { actions.push({ tick: game.time, target }); return 0; } };
    }
    function addRoom(name = 'W1N1') {
        const room = { name, memory: {}, controller: { my: true, level: 8 }, enemies: [], roads: [],
            extensions: [], spawns: [], towers: [core('tower', `${name}:tower`, 3000, 3000, name)], labs: [], containers: [], links: [] };
        game.rooms[name] = room;
        return room;
    }
    return { game, actions, core, addRoom, repair, tick: () => game.time++, reads: () => ({ hitReads, maxReads }) };
}

test('ten healthy rooms read fresh core health every tick but verify each fixed maximum only once across native wrapper replacements', () => {
    const w = world(), rooms = Array.from({ length: 10 }, (_, index) => w.addRoom(`W${index + 1}N1`));
    for (let tick = 0; tick < 31; tick++) {
        for (const room of rooms) {
            room.extensions = Array.from({ length: 60 }, (_, index) => w.core('extension', `${room.name}:extension:${index}`, 1000, 1000, room.name));
            room.towers = [w.core('tower', `${room.name}:tower`, 3000, 3000, room.name)];
            w.repair(room);
        }
        w.tick();
    }
    assert.equal(w.reads().hitReads, 10 * 61 * 31, 'damage detection retains its original per-tick frequency');
    assert.equal(w.reads().maxReads, 10 * 61, 'healthy structures avoid 18,300 repeated native maximum queries');
    assert.equal(w.actions.length, 0);
    const damaged = w.core('extension', `${rooms[0].name}:extension:59`, 999, 1000, rooms[0].name);
    rooms[0].extensions[59] = damaged;
    w.repair(rooms[0]);
    assert.equal(w.actions[0].target, damaged, 'even one new point of damage repairs on the next tick');
    assert.equal(w.reads().maxReads, 10 * 61 + 1, 'damaged structures still read their actual maximum');
});

test('all fixed core groups retain immediate one-hit repairs after full-health verification and an RCL change', () => {
    for (const [key, type, , hitsMax] of coreTypes) {
        const w = world(), room = w.addRoom();
        const put = structure => { if (Array.isArray(room[key])) room[key] = [structure]; else room[key] = structure; };
        put(w.core(type, key, hitsMax, hitsMax, room.name));
        w.repair(room);
        assert.equal(w.actions.length, 0, key);
        w.tick(); room.controller.level = 7;
        const damaged = w.core(type, key, hitsMax - 1, hitsMax, room.name);
        put(damaged); w.repair(room);
        assert.equal(w.actions.length, 1, key);
        assert.equal(w.actions[0].target, damaged, `${key} uses the current object and health`);
    }
});

test('private-server nonstandard maxima and nonstandard current hits use live maxima without entering the verified fast path', () => {
    const w = world(), room = w.addRoom();
    for (let tick = 0; tick < 2; tick++) {
        const damaged = w.core('extension', 'custom-extension', 1000, 2000, room.name);
        room.extensions = [damaged]; w.repair(room);
        assert.equal(w.actions[tick].target, damaged, 'standard hit value cannot hide a larger actual limit');
        assert.equal(w.reads().maxReads, tick + 1, 'nonstandard maxima are never reused');
        w.tick();
    }
    room.extensions = [w.core('extension', 'custom-extension', 2000, 2000, room.name)];
    w.repair(room);
    assert.equal(w.actions.length, 2, 'overstandard healthy values are confirmed against actual hitsMax');
    w.tick();
    const damaged = w.core('extension', 'custom-extension', 1999, 2000, room.name);
    room.extensions = [damaged]; w.repair(room);
    assert.equal(w.actions[2].target, damaged);
});

test('missing constants preserve live getter fallback and custom server constants can be verified', () => {
    const w = world({}), room = w.addRoom();
    room.extensions = [w.core('extension', 'extension', 1000, 1000, room.name)];
    for (let tick = 0; tick < 3; tick++) { w.repair(room); w.tick(); }
    assert.equal(w.reads().maxReads, 6, 'both extension and tower maxima stay live without constants');
    const custom = world({ EXTENSION_HITS: 1500 }), customRoom = custom.addRoom();
    customRoom.extensions = [custom.core('extension', 'extension', 1500, 1500, customRoom.name)];
    custom.repair(customRoom); custom.tick(); custom.repair(customRoom);
    assert.equal(custom.reads().maxReads, 3, 'custom extension limit verifies once while the missing tower constant stays live');
});

test('shard changes, time rollback, and lost visibility invalidate scalar maximum verification', () => {
    for (const reset of ['shard', 'time', 'visibility']) {
        const w = world(), room = w.addRoom();
        room.extensions = [w.core('extension', 'extension', 1000, 1000, room.name)];
        w.repair(room); w.tick(); w.repair(room); w.tick();
        if (reset === 'shard') w.game.shard.name = 'shard2';
        if (reset === 'time') w.game.time = 1;
        if (reset === 'visibility') {
            delete w.game.rooms[room.name];
            w.repair(w.addRoom('W2N1')); w.tick(); w.game.rooms[room.name] = room;
        }
        const damaged = w.core('extension', 'extension', 1000, 2000, room.name);
        room.extensions = [damaged]; w.repair(room);
        assert.equal(w.actions.at(-1).target, damaged, `${reset} forces validation against this world's actual maximum`);
    }
});
