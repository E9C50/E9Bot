const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

const policy = {
    flags: { managerPosition: 'managerPos', centerPosition: 'centerPos', repairTower: 'repairTower', sourceLab1: 'lab1', sourceLab2: 'lab2' },
    defense: { enemyScanInterval: 5, notificationInterval: 50, npcOwners: ['Invader', 'Source Keeper'], invaderOwner: 'Invader' }
};

function roomWorld() {
    const game = { time: 1, rooms: {}, flags: {} };
    const memory = { warMode: {} };
    const logs = [];
    const loader = createSourceLoader({
        globals: {
            Game: game, Memory: memory, console: { log: message => logs.push(message) },
            ATTACK: 'attack', RANGED_ATTACK: 'ranged_attack', WORK: 'work', CLAIM: 'claim', OK: 0,
            STRUCTURE_STORAGE: 'storage', STRUCTURE_TERMINAL: 'terminal', STRUCTURE_TOWER: 'tower', STRUCTURE_LAB: 'lab', LOOK_STRUCTURES: 'structure'
        },
        modules: { 'settings/roomPolicy': { roomPolicy: policy } }
    });
    return { ...loader, game, memory, logs };
}

test('a room already at war refreshes enemies each tick and clears war mode after they leave', () => {
    const world = roomWorld();
    const { findTowerEnemy } = world.load('room/defense');
    const room = { name: 'W1N1', memory: {}, enemies: [] };
    world.memory.warMode.W1N1 = true;
    findTowerEnemy(room);
    assert.equal(world.memory.warMode.W1N1, false);
    world.game.time = 5;
    room.enemies = [{ id: 'hostile', owner: { username: 'hostilePlayer' }, body: [{ type: 'attack' }, { type: 'move' }] }];
    findTowerEnemy(room);
    assert.equal(world.memory.warMode.W1N1, true);
});

test('peaceful enemy scans clear stale state immediately and safely inspect PowerCreeps without body parts', () => {
    const world = roomWorld();
    const { findTowerEnemy } = world.load('room/defense');
    let reads = 0;
    const room = { name: 'W1N1', memory: { npcTarget: 'stale' }, get enemies() { reads++; return []; } };
    assert.doesNotThrow(() => findTowerEnemy(room));
    assert.equal(reads, 1); assert.equal(room.memory.npcTarget, undefined);
    world.game.time = 5;
    const powerRoom = { name: 'W1N1', memory: {}, enemies: [{ id: 'pc', owner: { username: 'player' } }] };
    assert.doesNotThrow(() => findTowerEnemy(powerRoom));
    assert.notEqual(world.memory.warMode.W1N1, true);
});

test('safe mode can activate with no cooldown property and only reports successful activation', () => {
    const world = roomWorld();
    const { autoEnableSafeMode } = world.load('room/defense');
    let activations = 0;
    let result = 0;
    const room = {
        name: 'W1N1', enemies: [{}], spawns: [],
        storage: { hits: 50, hitsMax: 100 },
        controller: { safeModeAvailable: 1, activateSafeMode() { activations++; return result; } }
    };
    autoEnableSafeMode(room);
    assert.equal(activations, 1);
    assert.equal(world.logs.length, 1);
    result = -6;
    autoEnableSafeMode(room);
    assert.equal(activations, 2);
    assert.equal(world.logs.length, 1);
    room.controller.safeModeCooldown = 100;
    autoEnableSafeMode(room);
    assert.equal(activations, 2);
    room.controller.safeModeCooldown = undefined;
    room.controller.safeMode = 100;
    autoEnableSafeMode(room);
    assert.equal(activations, 2);
});

test('position flags in unseen rooms remain available until the room is visible', () => {
    const world = roomWorld();
    const { processRoomFlags } = world.load('room/flags');
    let removed = 0;
    const position = { roomName: 'W1N1', x: 10, y: 20 };
    world.game.flags.managerPos = { pos: position, remove: () => removed++ };
    processRoomFlags();
    assert.equal(removed, 0);
    world.game.rooms.W1N1 = { memory: { roomPosition: {}, roomStructure: {}, roomLabConfig: {} } };
    processRoomFlags();
    assert.equal(removed, 1);
    assert.equal(world.game.rooms.W1N1.memory.roomPosition.managerPos, position);
});

test('structure flags require the requested structure type and select it among other structures', () => {
    const world = roomWorld();
    const { processRoomFlags } = world.load('room/flags');
    let removed = 0;
    let structures = [{ id: 'road', structureType: 'road' }];
    const room = { memory: { roomPosition: {}, roomStructure: {}, roomLabConfig: {} } };
    world.game.rooms.W1N1 = room;
    world.game.flags.lab1 = { pos: { roomName: 'W1N1', lookFor: () => structures }, remove: () => removed++ };
    processRoomFlags();
    assert.equal(removed, 0);
    assert.equal(room.memory.roomLabConfig.sourceLab1, undefined);
    structures = [...structures, { id: 'correctLab', structureType: 'lab' }];
    processRoomFlags();
    assert.equal(removed, 1);
    assert.equal(room.memory.roomLabConfig.sourceLab1, 'correctLab');
});
