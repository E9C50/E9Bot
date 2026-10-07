const assert = require('node:assert/strict');
const test = require('node:test');
const { createWorld, validateBlueprint } = require('../helpers/planner-world.cjs');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const fixture = require('../fixtures/room-shard1-E39N5.json');

function realRoom(roomFixture = fixture) {
    const world = createWorld();
    const terrain = new Uint8Array(2500);
    // API terrain is row-major; the planner's local RoomArray and mock use x * 50 + y.
    for (let x = 0; x < 50; x++) for (let y = 0; y < 50; y++) terrain[x * 50 + y] = Number(roomFixture.terrain[y * 50 + x]);
    const room = world.roomFor(roomFixture.roomName, terrain);
    const point = value => ({ pos: new world.loader.globals.RoomPosition(value.x, value.y, room.name) });
    room.controller = point(roomFixture.controller);
    const mineral = point(roomFixture.mineral), sources = roomFixture.sources.map(point);
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
    assert.ok(result.structMap.link.some(([x, y]) =>
        Math.max(Math.abs(x - fixture.controller.x), Math.abs(y - fixture.controller.y)) === 2),
    'the planner controller Link stays at its valid range-two seat');
    assert.equal(world.routes.calls, 8, 'raw and adapted plans each connect controller, mineral and two Sources');
    assert.equal(world.routes.incomplete, 0);
    assert.equal(controllerEndpoints.length, 2, 'raw and adapted planners each route to an outer delivery seat');
    for (const [index, endpoint] of controllerEndpoints.entries()) {
        const container = index === 0 ? raw.controllerContainer : result.controllerContainer;
        assert.ok(Math.max(Math.abs(endpoint.x - fixture.controller.x), Math.abs(endpoint.y - fixture.controller.y)) > 3);
        assert.equal(Math.max(Math.abs(endpoint.x - container[0]), Math.abs(endpoint.y - container[1])), 1);
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

test('actual shard2 E41N6 avoids the extension-road collision and keeps resource paths and roads connected', () => {
    const world = realRoom(require('../fixtures/room-shard2-E41N6.json'));
    const { room, points } = world;
    const routes = [], originalSearch = world.pathFinder.search;
    world.pathFinder.search = (origin, goal, options) => {
        const route = originalSearch(origin, goal, options);
        routes.push(route.path);
        return route;
    };
    const raw = world.loader.load('planning/vendor/manor63').computeManor63(room.name, points, { minimumPlaneCount: 140 });
    assert.ok(raw);
    assert.ok(raw.structMap.extension.some(([x, y]) => x === 46 && y === 21), 'keep the building selected by the real planner');
    assert.ok(!raw.structMap.road.some(([x, y]) => x === 46 && y === 21), 'the lab road gradient must not cross the extension');
    routes.length = 0;
    const result = world.planner.computeRoomBlueprint(room);
    validateBlueprint(room, result);
    const blocked = new Set(points.map(point => `${point.pos.x},${point.pos.y}`));
    for (const type of world.loader.globals.OBSTACLE_OBJECT_TYPES) {
        for (const [x, y] of result.structMap[type] || []) blocked.add(`${x},${y}`);
    }
    for (const [x, y] of result.structMap.road) assert.ok(!blocked.has(`${x},${y}`), 'every proposed road remains buildable');
    for (const path of routes) for (const pos of path) assert.ok(!blocked.has(`${pos.x},${pos.y}`), 'road costs must not make an obstacle traversable');
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
    for (const road of roads) assert.ok(reachable.has(road), 'removing the collision preserves the complete road network');
    assert.equal(world.routes.incomplete, 0);
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
