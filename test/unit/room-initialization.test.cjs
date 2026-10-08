const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function createWorld(rooms = {}, memory = {}) {
    const cacheDeletes = [];
    const loader = createSourceLoader({
        globals: {
            Game: { rooms, flags: {}, time: 1 },
            Memory: memory,
            BetterMove: { deletePathInRoom: roomName => cacheDeletes.push(roomName) },
            console: { log() {} }
        },
        modules: {
            'room/labBoostPriority': { prioritizeLabBoostJobs: () => false },
            'settings/room': { roomSignTextList: ['first sign', 'second sign'] },
            'settings/roomPolicy': { roomPolicy: { flags: { updateCache: 'updateCache', repairTower: 'repairTower' } } }
        }
    });
    return { ...loader, api: loader.load('room/initialization'), cacheDeletes, memory };
}

test('an empty world initializes global Memory before creep and power controllers', () => {
    const { api, memory } = createWorld();
    api.initializeRooms();
    assert.equal(typeof memory.warMode, 'object');
    assert.equal(typeof memory.creeps, 'object');
    assert.deepEqual(Object.keys(memory.warMode), []);
    assert.deepEqual(Object.keys(memory.creeps), []);
});

test('a first visible room is ready for population and spawn work on a non-refresh tick', () => {
    const room = { name: 'W1N1', my: false, memory: {} };
    const { api, globals } = createWorld({ W1N1: room });
    api.initializeRooms();
    for (const field of [
        'creepConfig', 'teamConfig', 'terminalSendJob', 'terminalAmount',
        'roomStructure', 'restrictedPos', 'roomPosition', 'roomFillJob', 'boostNeed'
    ]) {
        assert.equal(typeof room.memory[field], 'object', `${field} is initialized`);
    }
    assert.equal(Array.isArray(room.memory.creepSpawnQueue), true);
    assert.equal(Array.isArray(room.memory.roomFillJob.labInMineral), true);
    assert.equal(typeof room.memory.roomLabConfig.singleLabConfig, 'object');
    assert.equal(typeof globals.W1N1.structureIdList, 'object');
});

test('initialization fills missing fields without replacing persistent configuration or jobs', () => {
    const creepConfig = { incumbent: { role: 'harvester', data: { sourceId: 'source' } } };
    const queue = ['incumbent'];
    const roomLabConfig = { sourceLab1: 'lab1', labReactionConfig: 'OH' };
    const terminalJobs = { job: { amount: 150, targetRoom: 'W2N2', resourceType: 'energy' } };
    const roomFillJob = { tower: ['tower1'] };
    const warMode = { W1N1: true };
    const creeps = { incumbent: { working: true } };
    const oldBoostNeed = { XGH2O: 100 };
    const memory = { warMode, creeps, customGlobalState: { keep: true } };
    const room = {
        name: 'W1N1', my: false,
        memory: {
            creepConfig, creepSpawnQueue: queue, roomLabConfig,
            terminalSendJob: terminalJobs, roomFillJob, boostNeed: oldBoostNeed,
            customRoomState: { keep: true }
        }
    };
    const { api, globals } = createWorld({ W1N1: room }, memory);
    const structureIdList = { sources: ['source'] };
    globals.W1N1 = { structureIdList };
    api.initializeRooms();

    assert.equal(memory.warMode, warMode);
    assert.equal(memory.creeps, creeps);
    assert.equal(room.memory.creepConfig, creepConfig);
    assert.equal(room.memory.creepSpawnQueue, queue);
    assert.equal(room.memory.roomLabConfig, roomLabConfig);
    assert.equal(room.memory.terminalSendJob, terminalJobs);
    assert.equal(room.memory.roomFillJob, roomFillJob);
    assert.equal(globals.W1N1.structureIdList, structureIdList);
    assert.equal(memory.customGlobalState.keep, true);
    assert.equal(room.memory.customRoomState.keep, true);
    assert.notEqual(room.memory.boostNeed, oldBoostNeed, 'boost demand remains a per-tick aggregate');
    assert.deepEqual(Object.keys(room.memory.boostNeed), []);
    assert.deepEqual(Object.keys(roomLabConfig.singleLabConfig), []);
    assert.equal(Array.isArray(roomFillJob.labInMineral), true);
});

test('cache refresh removes only the requested room path and structure cache', () => {
    const room = { name: 'W1N1', my: false, memory: { needUpdateCache: true } };
    const { api, globals, cacheDeletes } = createWorld({ W1N1: room });
    globals.W1N1 = { structureIdList: { stale: 'destroyed' }, unrelated: 'preserved' };
    api.initializeRooms();
    assert.deepEqual(cacheDeletes, ['W1N1']);
    assert.deepEqual(Object.keys(globals.W1N1.structureIdList), []);
    assert.equal(globals.W1N1.unrelated, 'preserved');
    assert.equal(room.memory.needUpdateCache, false);
});
