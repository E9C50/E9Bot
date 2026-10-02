const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function matrixWorld(time = 10) {
    const calls = [];
    const game = { time, shard: { name: 'shard3' }, cpu: { bucket: 1000 } };
    class Room { constructor(name) { this.name = name; } }
    class Matrix { constructor() { this.fallback = true; } }
    const loader = createSourceLoader({ globals: { Room, Game: game, PathFinder: { CostMatrix: Matrix } }, modules: {
        'settings/structures': { structurePolicy: { defense: { costMatrixInterval: 10, minimumBucket: 100 } } },
        'settings/settings': { STRUCTURE_PRIVATEKEY_PERFIX: '_', STRUCTURE_MEMORYKEY_PERFIX: 'IDOF_' },
        'settings/creep': { roleAdvEnum: { PROCESSER: 'processer' } },
        'utils/CostMatrix': { generateCostMatrix(name) { const value = { name, builtAt: game.time }; calls.push(value); return value; } },
        utils: { getDistance() {} },
    } });
    const ExtendedRoom = loader.load('mount/extension/RoomExtension').default;
    function room(name = 'W1N1') {
        loader.globals[name] ||= {};
        return new ExtendedRoom(name);
    }
    return { game, calls, loader, room };
}

test('eleven peaceful RCL8 rooms never prewarm defense matrices on the old shared refresh boundary', () => {
    let matrixCalls = 0, enemyChecks = 0, repairs = 0;
    const game = { time: 1000, shard: { name: 'shard3' }, rooms: {} };
    for (let index = 0; index < 11; index++) {
        const name = `W${index}N1`;
        game.rooms[name] = { name, my: true, controller: { my: true, level: 8 }, enemies: [],
            getDefenderCostMatrix() { matrixCalls++; throw new Error('peaceful posted guards do not need a defense matrix'); } };
    }
    const noop = () => {};
    const loader = createSourceLoader({ globals: { Game: game }, modules: {
        'runtime/profiling': { isCpuProfilingEnabled: () => false },
        'settings/roomPolicy': { roomPolicy: { profiling: { enabled: false }, defense: { costMatrixRefreshInterval: 1000 } } },
        'room/initialization': { initializeRooms: noop, initializeStructures: noop, updateRoomSign: noop },
        'room/flags': { processRoomFlags: noop },
        'room/defense': { autoEnableSafeMode: noop, findTowerEnemy() { enemyChecks++; }, repairStructure() { repairs++; } },
        'room/labs': { updateLabBoostConfig: noop, updateLabReactionConfig: noop },
        'room/layout': { autoComputeCenterPos: noop, releaseConstructionSite: noop },
        'room/market': { processRoomMarket: noop }, 'room/terminal': { processTerminalResource: noop },
    } });
    const { roomController } = loader.load('module/RoomController');
    roomController(); game.time = 2000; roomController();
    assert.equal(matrixCalls, 0);
    assert.equal(enemyChecks, 22, 'enemy detection keeps its original per-tick invocation');
    assert.equal(repairs, 22, 'tower repair orchestration remains unchanged');
});

test('multiple consumers and Room wrappers rebuild a shared matrix once on a refresh tick', () => {
    const w = matrixWorld(), first = w.room(), second = w.room();
    const matrix = first.getDefenderCostMatrix();
    for (let index = 0; index < 20; index++) assert.equal(second.getDefenderCostMatrix(), matrix);
    assert.equal(w.calls.length, 1);
    w.game.time = 11;
    assert.equal(w.room().getDefenderCostMatrix(), matrix);
    w.game.time = 20;
    const refreshed = w.room().getDefenderCostMatrix();
    assert.notEqual(refreshed, matrix);
    assert.equal(second.getDefenderCostMatrix(), refreshed);
    assert.equal(w.calls.length, 2);
});

test('a first enemy-side matrix request is immediate and a long peaceful gap refreshes off the periodic boundary', () => {
    const w = matrixWorld(13), room = w.room();
    const initial = room.getDefenderCostMatrix();
    assert.equal(initial.builtAt, 13);
    assert.equal(w.calls.length, 1);
    w.game.time = 1017;
    const refreshed = w.room().getDefenderCostMatrix();
    assert.equal(refreshed.builtAt, 1017);
    assert.notEqual(refreshed, initial);
    assert.equal(room.getDefenderCostMatrix(), refreshed);
    assert.equal(w.calls.length, 2);
});

test('the original periodic refresh still occurs even when the previous on-demand matrix is younger than its interval', () => {
    const w = matrixWorld(19), room = w.room();
    const matrix = room.getDefenderCostMatrix();
    w.game.time = 20;
    assert.notEqual(room.getDefenderCostMatrix(), matrix);
    assert.equal(w.calls.length, 2);
});

test('an existing heap matrix without a freshness stamp is refreshed on its first on-demand call', () => {
    const w = matrixWorld(17), room = w.room();
    const legacy = { legacy: true };
    w.loader.globals[room.name].defenderCostMatrix = legacy;
    assert.notEqual(room.getDefenderCostMatrix(), legacy);
    assert.equal(w.calls.length, 1);
    assert.equal(w.loader.globals[room.name].defenderCostMatrixTick, 17);
});

test('low bucket fallback does not hide an actual rebuild when CPU capacity returns in the same tick', () => {
    const w = matrixWorld(), room = w.room();
    w.game.cpu.bucket = 99;
    assert.equal(room.getDefenderCostMatrix().fallback, true);
    assert.equal(w.calls.length, 0);
    assert.equal(w.loader.globals[room.name].defenderCostMatrixTick, undefined);
    w.game.cpu.bucket = 100;
    const matrix = room.getDefenderCostMatrix();
    assert.equal(matrix.fallback, undefined);
    assert.equal(w.room().getDefenderCostMatrix(), matrix);
    assert.equal(w.calls.length, 1);
});
