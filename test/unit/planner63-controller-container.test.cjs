const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const { createWorld, validateBlueprint } = require('../helpers/planner-world.cjs');

const range = (first, second) => Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y));
const key = (x, y) => `${x},${y}`;
function countSeats(controller, container, canWalk) {
    let inner = 0, hauler = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (!(dx || dy)) continue;
        const x = container[0] + dx, y = container[1] + dy;
        if (!canWalk(x, y)) continue;
        const distance = range(controller, { x, y });
        if (distance < 3) inner++;
        else if (distance > 3) hauler++;
    }
    return { inner, hauler };
}

test('the pure selector imports without Game and chooses a three-tile ring with inner and outer space', () => {
    const loader = createSourceLoader();
    const { selectControllerContainer } = loader.load('planning/controllerContainer');
    assert.equal(loader.globals.Game, undefined);
    const controller = { x: 25, y: 25 };
    const selected = selectControllerContainer(controller, () => true, () => true, { x: 40, y: 25 });
    assert.equal(range(controller, { x: selected[0], y: selected[1] }), 3);
    assert.equal(selected[0], 28, 'after seat counts tie, prefer the logistics anchor');
    const seats = countSeats(controller, selected, () => true);
    assert.ok(seats.inner >= 2);
    assert.ok(seats.hauler >= 1);
    assert.equal(selectControllerContainer({ x: 25.5, y: 25 }, () => true, () => true), undefined);
});

test('the selector rejects blocked builds, missing inner seats, missing outer access and diagonal one-seat pockets', () => {
    const { selectControllerContainer } = createSourceLoader().load('planning/controllerContainer');
    const controller = { x: 25, y: 25 }, candidate = { x: 28, y: 25 };
    const onlyCandidate = (x, y) => x === candidate.x && y === candidate.y;
    assert.equal(selectControllerContainer(controller, () => true, () => false), undefined);
    assert.equal(selectControllerContainer(controller, (x, y) => x !== 27 || y !== 24 && y !== 25, onlyCandidate), undefined,
        'a single remaining inside seat is insufficient');
    assert.equal(selectControllerContainer(controller, (x, y) => x <= 28, onlyCandidate), undefined,
        'a delivery worker needs a tile outside the controller range');
    assert.equal(selectControllerContainer(controller, () => true, (x, y) => x === 28 && y === 28), undefined,
        'a diagonal corner has only one strict inner seat');
    const allowed = new Set(['28,25', '27,24', '27,25', '29,25']);
    assert.deepEqual(Array.from(selectControllerContainer(controller, (x, y) => allowed.has(key(x, y)), onlyCandidate)), [28, 25]);
});

test('the selector never builds on a border or calls callbacks outside the interior', () => {
    const { selectControllerContainer } = createSourceLoader().load('planning/controllerContainer');
    const inside = (x, y) => { assert.ok(x > 0 && y > 0 && x < 49 && y < 49); return true; };
    for (const controller of [{ x: 1, y: 1 }, { x: 48, y: 48 }]) {
        const selected = selectControllerContainer(controller, inside, inside);
        assert.ok(selected);
        assert.equal(range(controller, { x: selected[0], y: selected[1] }), 3);
    }
});

test('the complete planner replaces only the controller container and preserves its legacy inner Link', () => {
    const world = createWorld(), room = world.roomFor('controller-layout');
    const requests = [], originalSearch = world.pathFinder.search;
    const natural = new Set([room.controller, ...room.find('sources'), ...room.find('minerals')].map(point => key(point.pos.x, point.pos.y)));
    world.pathFinder.search = (origin, goal, options) => {
        const result = originalSearch(origin, goal, options);
        requests.push({ goal, result });
        for (const pos of result.path) assert.ok(!natural.has(key(pos.x, pos.y)), 'resource roads avoid native impassable objects');
        return result;
    };
    const result = world.planner.computeRoomBlueprint(room);
    validateBlueprint(room, result);
    assert.equal(world.routes.calls, 4);
    assert.equal(world.routes.incomplete, 0);
    assert.equal(range(room.controller.pos, { x: result.controllerContainer[0], y: result.controllerContainer[1] }), 3);
    assert.ok(result.structMap.container.some(([x, y]) => key(x, y) === key(...result.controllerContainer)));
    assert.ok(!result.structMap.container.some(([x, y]) => x === 11 && y === 40), 'the old controller container is absent');
    for (const resourceContainer of [[11, 10], [41, 40], [41, 10]])
        assert.ok(result.structMap.container.some(([x, y]) => key(x, y) === key(...resourceContainer)), 'source and mineral containers stay put');
    assert.ok(result.structMap.link.some(([x, y]) => x === 12 && y === 40), 'legacy controller Link stays at controller range two');
    const controllerRoute = requests.find(request => Array.isArray(request.goal));
    assert.ok(controllerRoute, 'controller transport has explicit outer delivery goals');
    assert.equal(requests.filter(request => !Array.isArray(request.goal) && request.goal.range === 1).length, 3,
        'source and mineral routes retain their adjacent interaction ranges');
    for (const goal of controllerRoute.goal) {
        assert.equal(goal.range, 0);
        assert.ok(range(room.controller.pos, goal.pos) > 3);
        assert.equal(range({ x: result.controllerContainer[0], y: result.controllerContainer[1] }, goal.pos), 1);
    }
    const actualEndpoint = controllerRoute.result.path.at(-1);
    assert.ok(range(room.controller.pos, actualEndpoint) > 3, 'the real A* road ends outside the upgrade ring');
    assert.equal(range({ x: result.controllerContainer[0], y: result.controllerContainer[1] }, actualEndpoint), 1);
    const obstacles = new Set();
    for (const [type, positions] of Object.entries(result.structMap)) {
        if (!['road', 'rampart', 'container'].includes(type)) for (const [x, y] of positions) obstacles.add(key(x, y));
    }
    for (const point of [room.controller, ...room.find('sources'), ...room.find('minerals')]) obstacles.add(key(point.pos.x, point.pos.y));
    const seats = countSeats(room.controller.pos, result.controllerContainer, (x, y) => !obstacles.has(key(x, y)) && room.getTerrain().get(x, y) !== 1);
    assert.ok(seats.inner >= 2);
    assert.ok(seats.hauler >= 1);
});

test('the adapter rejects controller metadata outside range three, absent from the map, or malformed', () => {
    const world = createWorld(), room = world.roomFor('metadata-layout');
    const points = [room.controller, ...room.find('minerals'), ...room.find('sources')];
    const original = world.loader.load('planning/vendor/manor63').computeManor63(room.name, points, { minimumPlaneCount: 140 });
    for (const mutate of [
        raw => { raw.controllerContainer = [room.controller.pos.x + 1, room.controller.pos.y]; raw.structMap.container.push(raw.controllerContainer); },
        raw => { raw.structMap.container = raw.structMap.container.filter(([x, y]) => key(x, y) !== key(...raw.controllerContainer)); },
        raw => { raw.controllerContainer.push(1); },
        raw => { delete raw.controllerContainer; },
    ]) {
        const raw = JSON.parse(JSON.stringify(original)); mutate(raw);
        const loader = createSourceLoader({ globals: world.loader.globals, modules: { './vendor/manor63': { computeManor63: () => raw } } });
        assert.equal(loader.load('planning/planner63').computeRoomBlueprint(room), undefined);
    }
});
