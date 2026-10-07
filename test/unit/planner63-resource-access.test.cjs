const assert = require('node:assert/strict');
const test = require('node:test');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const { createWorld, validateBlueprint } = require('../helpers/planner-world.cjs');

function scoresFor(grid, points, weights, checkBudget) {
    const loader = createSourceLoader({ globals: { TERRAIN_MASK_WALL: 1 } });
    return loader.load('planning/resourceDistances').resourceAccessScores(
        { get: (x, y) => grid[x * 50 + y] }, points, weights, checkBudget);
}

test('resource access uses actual eight-direction terrain paths instead of direct range', () => {
    const grid = new Uint8Array(2500);
    for (let y = 1; y <= 25; y++) grid[15 * 50 + y] = 1;
    const scores = scoresFor(grid, [{ pos: { x: 10, y: 10 }, kind: 'source' }], { source: 1 });
    assert.equal(scores[20 * 50 + 10], 31, 'the path detours below the natural wall');
    assert.equal(scores[10 * 50 + 10], Infinity, 'the Source itself is not walkable');
    assert.equal(scores[0 * 50 + 10], Infinity, 'routes remain inside the room');
});

test('resource access weighs every resource and permits explicit transport priorities', () => {
    const grid = new Uint8Array(2500);
    const points = [
        { pos: { x: 20, y: 20 }, kind: 'source' },
        { pos: { x: 30, y: 20 }, kind: 'controller' },
        { pos: { x: 25, y: 25 }, kind: 'mineral' }
    ];
    assert.equal(scoresFor(grid, points)[25 * 50 + 20], 22);
    assert.equal(scoresFor(grid, points, { source: 0.5, controller: 1, mineral: 2 })[25 * 50 + 20], 14);
});

test('resource access rejects anchors separated by native objects or requiring a border detour', () => {
    const corridor = new Uint8Array(2500).fill(1);
    for (let x = 1; x < 49; x++) corridor[x * 50 + 10] = 0;
    const points = [
        { pos: { x: 10, y: 10 }, kind: 'source' },
        { pos: { x: 15, y: 10 }, kind: 'controller' }
    ];
    assert.equal(scoresFor(corridor, points)[20 * 50 + 10], Infinity);
    assert.equal(scoresFor(corridor, points, { source: 0 })[20 * 50 + 10], Infinity,
        'a zero weight does not waive a required resource connection');
    const divided = new Uint8Array(2500);
    for (let y = 1; y < 49; y++) divided[15 * 50 + y] = 1;
    assert.equal(scoresFor(divided, [points[0]])[20 * 50 + 10], Infinity);
});

test('resource access checks its CPU budget throughout the flood', () => {
    let checks = 0;
    assert.throws(() => scoresFor(new Uint8Array(2500), [
        { pos: { x: 10, y: 10 }, kind: 'source' }
    ], undefined, () => { if (++checks === 60) throw new Error('budget reached'); }), /budget reached/);
    assert.equal(checks, 60);
});

function realRoom() {
    const fixture = require('../fixtures/room-shard2-E41N6.json');
    const world = createWorld(), grid = new Uint8Array(2500);
    for (let x = 0; x < 50; x++) for (let y = 0; y < 50; y++) grid[x * 50 + y] = Number(fixture.terrain[y * 50 + x]);
    const room = world.roomFor(fixture.roomName, grid);
    const point = value => ({ pos: new world.loader.globals.RoomPosition(value.x, value.y, room.name) });
    room.controller = point(fixture.controller);
    const mineral = point(fixture.mineral), sources = fixture.sources.map(point);
    room.find = type => type === 'minerals' ? [mineral] : sources;
    return { ...world, room, points: [room.controller, mineral, ...sources] };
}

test('resource-optimized E41N6 uses the left basin in one planner pass with complete resource routes', () => {
    const world = realRoom();
    const result = world.planner.computeRoomBlueprint(world.room, { optimizeResourceAccess: true });
    validateBlueprint(world.room, result);
    assert.ok(result.storagePos.x < 25, 'the base occupies the left open area');
    assert.equal(world.routes.calls, 4, 'each resource is routed once after choosing the anchor');
    assert.equal(world.routes.incomplete, 0);
    const roads = new Set(result.structMap.road.map(([x, y]) => `${x},${y}`));
    const reachable = new Set(), queue = [[result.storagePos.x, result.storagePos.y]];
    for (let i = 0; i < queue.length; i++) {
        const [x, y] = queue[i], key = `${x},${y}`;
        if (reachable.has(key)) continue;
        reachable.add(key);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            const next = `${x + dx},${y + dy}`;
            if ((dx || dy) && roads.has(next) && !reachable.has(next)) queue.push([x + dx, y + dy]);
        }
    }
    for (const road of roads) assert.ok(reachable.has(road), 'all planned roads join the core');
});

test('resource optimization preserves an explicit existing storage anchor', () => {
    const world = realRoom();
    const raw = world.loader.load('planning/vendor/manor63').computeManor63(world.room.name, world.points, { minimumPlaneCount: 140 });
    assert.ok(raw);
    const result = world.planner.computeRoomBlueprint(world.room, { optimizeResourceAccess: true, storagePosition: raw.storagePos });
    validateBlueprint(world.room, result);
    assert.deepEqual({ x: result.storagePos.x, y: result.storagePos.y }, { x: raw.storagePos.x, y: raw.storagePos.y });
});
