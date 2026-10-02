const assert = require('node:assert/strict');
const test = require('node:test');
const { createWorld, validateBlueprint } = require('../helpers/planner-world.cjs');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const fixture = require('../fixtures/room-shard1-E39N5.json');

function realRoom() {
    const world = createWorld();
    const terrain = new Uint8Array(2500);
    // API terrain is row-major; the planner's local RoomArray and mock use x * 50 + y.
    for (let x = 0; x < 50; x++) for (let y = 0; y < 50; y++) terrain[x * 50 + y] = Number(fixture.terrain[y * 50 + x]);
    const room = world.roomFor(fixture.roomName, terrain);
    const point = value => ({ pos: new world.loader.globals.RoomPosition(value.x, value.y, room.name) });
    room.controller = point(fixture.controller);
    const mineral = point(fixture.mineral), sources = fixture.sources.map(point);
    room.find = type => type === 'minerals' ? [mineral] : sources;
    return { ...world, room, terrain, points: [room.controller, mineral, ...sources] };
}

test('actual shard1 E39N5 terrain has a complete RCL8 layout and accepts its mineral-wall extractor', () => {
    const world = realRoom();
    const { room, points } = world;
    const controllerEndpoints = [], originalSearch = world.pathFinder.search;
    world.pathFinder.search = (origin, goal, options) => {
        const route = originalSearch(origin, goal, options);
        if (Array.isArray(goal)) controllerEndpoints.push(route.path.at(-1) || origin);
        return route;
    };
    assert.equal(room.getTerrain().get(fixture.mineral.x, fixture.mineral.y), 1, 'the real mineral is on a natural wall');
    const raw = world.loader.load('planning/vendor/manor63').computeManor63(room.name, points, { minimumPlaneCount: 140 });
    assert.ok(raw, 'the original candidate search succeeds without lowering its plane threshold');
    assert.equal(raw.structMap.spawn.length, 3);
    assert.equal(raw.structMap.extension.length, 60);
    const result = world.planner.computeRoomBlueprint(room, { minimumPlaneCount: 140 });
    validateBlueprint(room, result);
    assert.equal(Math.max(Math.abs(result.controllerContainer[0] - fixture.controller.x), Math.abs(result.controllerContainer[1] - fixture.controller.y)), 3);
    assert.ok(result.structMap.container.some(([x, y]) => x === result.controllerContainer[0] && y === result.controllerContainer[1]));
    assert.ok(!result.structMap.container.some(([x, y]) => x === 10 && y === 28), 'the old range-one controller container is replaced');
    assert.ok(result.structMap.link.some(([x, y]) => x === 9 && y === 28), 'the existing planner controller Link stays at range two');
    assert.equal(world.routes.calls, 8, 'raw and adapted plans each connect controller, mineral and two Sources');
    assert.equal(world.routes.incomplete, 0);
    assert.equal(controllerEndpoints.length, 2, 'raw and adapted planners each route to an outer delivery seat');
    for (const endpoint of controllerEndpoints) {
        assert.ok(Math.max(Math.abs(endpoint.x - fixture.controller.x), Math.abs(endpoint.y - fixture.controller.y)) > 3);
        assert.equal(Math.max(Math.abs(endpoint.x - result.controllerContainer[0]), Math.abs(endpoint.y - result.controllerContainer[1])), 1);
    }

    const reserved = new Set(points.map(point => `${point.pos.x},${point.pos.y}`));
    const mineral = `${fixture.mineral.x},${fixture.mineral.y}`;
    const occupants = new Map();
    for (const [type, positions] of Object.entries(result.structMap)) for (const [x, y] of positions) {
        const key = `${x},${y}`;
        if (type !== 'road') assert.ok(x > 0 && y > 0 && x < 49 && y < 49, `${type} avoids the border`);
        if (reserved.has(key)) assert.equal(`${type}:${key}`, `extractor:${mineral}`, 'only the actual mineral extractor may occupy a resource');
        const previous = occupants.get(key) || [];
        for (const other of previous) {
            assert.ok(type === 'rampart' || other === 'rampart' ||
                (type === 'road' && other === 'container') || (type === 'container' && other === 'road'),
            `${type} cannot overlap ${other} at ${key}`);
        }
        previous.push(type); occupants.set(key, previous);
    }
});

test('an extractor moved to a different natural wall is still rejected', () => {
    const world = realRoom();
    const raw = world.loader.load('planning/vendor/manor63').computeManor63(world.room.name, world.points, { minimumPlaneCount: 140 });
    assert.ok(raw);
    let wrongWall;
    for (let x = 1; x < 49 && wrongWall === undefined; x++) for (let y = 1; y < 49; y++) {
        if (world.terrain[x * 50 + y] === 1 && (x !== fixture.mineral.x || y !== fixture.mineral.y)) { wrongWall = [x, y]; break; }
    }
    assert.ok(wrongWall);
    raw.structMap.extractor = [wrongWall];
    const loader = createSourceLoader({ globals: world.loader.globals, modules: {
        './vendor/manor63': { computeManor63: () => raw, PlanningBudgetExceeded: class extends Error {} },
    } });
    assert.equal(loader.load('planning/planner63').computeRoomBlueprint(world.room), undefined,
        'the wall exemption is restricted to the actual mineral coordinate');
});
