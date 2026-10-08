const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world() {
    const game = { time: 10, shard: { name: 'test' }, rooms: {} };
    const phases = [], readers = [], samples = [];
    let planning = true, created = 0, nativeReads = 0, stock = 42;
    for (let index = 0; index < 3; index++) {
        const room = { name: `W${index + 1}N1`, my: true, memory: { roomStructure: {} } };
        room.factory = { room };
        game.rooms[room.name] = room;
    }
    const read = (room, source, name) => {
        phases.push(`${name}:${room.name}`);
        if (!planning) return;
        const inventory = source();
        readers.push(inventory);
        samples.push(inventory.globalAmount('stock'));
    };
    const noop = () => {};
    const loader = createSourceLoader({ globals: { Game: game }, modules: {
        'room/defense': { autoEnableSafeMode: noop, findTowerEnemy: noop, repairStructure: noop },
        'room/flags': { processRoomFlags: noop },
        'room/initialization': { initializeRooms: noop, initializeStructures: noop, updateRoomSign: noop },
        'room/labs': { updateLabBoostConfig: noop, updateLabReactionConfig: (room, source) => read(room, source, 'lab') },
        'room/factory': { planFactoryProduction: (factory, source) => read(factory.room, source, 'factory') },
        'room/resourceNetwork': { createResourceInventory() {
            created++;
            let snapshot;
            return { globalAmount() { if (snapshot === undefined) { nativeReads++; snapshot = stock; } return snapshot; } };
        } },
        'room/layout': { autoComputeCenterPos: noop, releaseConstructionSite: noop },
        'room/market': { processRoomMarket: noop },
        'room/terminal': { processTerminalResource(room) { phases.push(`terminal:${room.name}`); stock++; } },
        'room/evacuationState': { isRoomEvacuating: () => false },
        'room/evacuation': { processRoomEvacuation: noop },
        'settings/roomPolicy': { roomPolicy: { profiling: { enabled: false } } },
        'runtime/profiling': { isCpuProfilingEnabled: () => false },
    } });
    return { run: loader.load('module/RoomController').roomController, phases, readers, samples,
        created: () => created, nativeReads: () => nativeReads, setPlanning: value => { planning = value; } };
}

test('one synchronous production phase shares a lazy reader across all Lab and Factory plans before terminal intents', () => {
    const w = world();
    w.run();
    assert.deepEqual(w.phases, ['lab:W1N1', 'factory:W1N1', 'lab:W2N1', 'factory:W2N1', 'lab:W3N1', 'factory:W3N1',
        'terminal:W1N1', 'terminal:W2N1', 'terminal:W3N1']);
    assert.equal(w.created(), 1);
    assert.equal(w.nativeReads(), 1, 'all six planners share the same native stock read');
    assert.equal(new Set(w.readers).size, 1);
    assert.deepEqual(w.samples, Array(6).fill(42));
    w.run();
    assert.equal(w.created(), 2, 'even another call in the same tick starts a fresh synchronous scope');
    assert.equal(w.nativeReads(), 2);
    assert.equal(new Set(w.readers).size, 2);
    assert.deepEqual(w.samples.slice(6), Array(6).fill(45), 'later terminal intents are visible to the new scope');
});

test('no due planner or global rank demand leaves the shared inventory uncreated', () => {
    const w = world();
    w.setPlanning(false);
    w.run();
    assert.equal(w.created(), 0);
    assert.equal(w.nativeReads(), 0);
});
