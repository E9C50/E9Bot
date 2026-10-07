const assert = require('node:assert/strict');
const test = require('node:test');
const { createWorld, validateBlueprint } = require('../helpers/planner-world.cjs');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const exitFixture = require('../fixtures/room-shard2-E41N6.json');

const key = (x, y) => `${x},${y}`;
const transforms = {
    original: (x, y) => [x, y],
    clockwise: (x, y) => [49 - y, x],
    halfTurn: (x, y) => [49 - x, 49 - y],
    counterclockwise: (x, y) => [y, 49 - x],
    mirror: (x, y) => [49 - x, y],
};

function transformedWorld(transform = transforms.original, name = exitFixture.roomName) {
    const world = createWorld();
    const terrain = new Uint8Array(2500);
    for (let x = 0; x < 50; x++) for (let y = 0; y < 50; y++) {
        const [tx, ty] = transform(x, y);
        terrain[tx * 50 + ty] = Number(exitFixture.terrain[y * 50 + x]);
    }
    const room = world.roomFor(name, terrain);
    const point = value => {
        const [x, y] = transform(value.x, value.y);
        return { pos: new world.loader.globals.RoomPosition(x, y, room.name) };
    };
    room.controller = point(exitFixture.controller);
    const mineral = point(exitFixture.mineral), sources = exitFixture.sources.map(point);
    room.find = type => type === 'minerals' ? [mineral] : sources;
    return { ...world, room, points: [room.controller, mineral, ...sources] };
}

function isNativeRampartLegal(terrain, x, y) {
    if (x < 1 || y < 1 || x > 48 || y > 48 || terrain.get(x, y) === 1) return false;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const tx = x + dx, ty = y + dy;
        if ((tx === 0 || ty === 0 || tx === 49 || ty === 49) && terrain.get(tx, ty) !== 1) return false;
    }
    return true;
}

function validateRoadNetwork(world, blueprint) {
    const roads = new Set(blueprint.structMap.road.map(([x, y]) => key(x, y)));
    const blocked = new Set(world.points.map(point => key(point.pos.x, point.pos.y)));
    for (const type of world.loader.globals.OBSTACLE_OBJECT_TYPES) {
        for (const [x, y] of blueprint.structMap[type] || []) blocked.add(key(x, y));
    }
    for (const road of roads) assert.ok(!blocked.has(road), `${road} road avoids buildings and resources`);
    const reachable = new Set(), queue = [[blueprint.storagePos.x, blueprint.storagePos.y]];
    for (let index = 0; index < queue.length; index++) {
        const [x, y] = queue[index], current = key(x, y);
        if (reachable.has(current)) continue;
        reachable.add(current);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            const neighbor = key(x + dx, y + dy);
            if ((dx || dy) && roads.has(neighbor) && !reachable.has(neighbor)) queue.push([x + dx, y + dy]);
        }
    }
    for (const road of roads) assert.ok(reachable.has(road), `${road} remains connected by eight-direction roads`);
    if (blueprint.exitDefense) {
        for (const [x, y] of blueprint.structMap.tower) {
            assert.ok([-1, 0, 1].some(dx => [-1, 0, 1].some(dy =>
                (dx || dy) && roads.has(key(x + dx, y + dy)) && reachable.has(key(x + dx, y + dy)))),
            `Tower at ${x},${y} has a connected adjacent supply road`);
        }
    }
    assert.equal(world.routes.incomplete, 0, 'every resource has a complete path');
}

function validatePerimeter(world, blueprint) {
    const terrain = world.room.getTerrain();
    const ramparts = new Set(blueprint.structMap.rampart.map(([x, y]) => key(x, y)));
    for (const [x, y] of blueprint.structMap.rampart) {
        assert.ok(isNativeRampartLegal(terrain, x, y), `${x},${y} is a native-buildable Rampart tile`);
    }
    const outside = new Set(), queue = [];
    for (let x = 0; x < 50; x++) for (let y = 0; y < 50; y++) {
        if ((x === 0 || y === 0 || x === 49 || y === 49) && terrain.get(x, y) !== 1) queue.push([x, y]);
    }
    for (let index = 0; index < queue.length; index++) {
        const [x, y] = queue[index], current = key(x, y);
        if (outside.has(current)) continue;
        outside.add(current);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            const tx = x + dx, ty = y + dy, next = key(tx, ty);
            if (!(dx || dy) || tx < 0 || ty < 0 || tx > 49 || ty > 49 ||
                terrain.get(tx, ty) === 1 || ramparts.has(next) || outside.has(next)) continue;
            queue.push([tx, ty]);
        }
    }
    for (let x = 1; x < 48; x++) for (let y = 1; y < 48; y++) {
        assert.ok(![[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]
            .every(([tx, ty]) => outside.has(key(tx, ty))),
        'enemy space before the perimeter has no persistent 2-by-2 formation clear of the room border');
    }
    for (const point of world.points) {
        const { x, y } = point.pos;
        assert.ok(!outside.has(key(x, y)), 'controller, sources and mineral all stay inside the exit perimeter');
        assert.ok([-1, 0, 1].some(dx => [-1, 0, 1].some(dy => {
            const tx = x + dx, ty = y + dy;
            return (dx || dy) && tx >= 1 && ty >= 1 && tx < 49 && ty < 49 &&
                terrain.get(tx, ty) !== 1 && !outside.has(key(tx, ty)) && !ramparts.has(key(tx, ty));
        })), 'each resource has an accessible work tile in the protected interior');
    }
    for (const [type, positions] of Object.entries(blueprint.structMap)) {
        if (type === 'rampart' || type === 'road') continue;
        for (const [x, y] of positions) assert.ok(!outside.has(key(x, y)), `${type} at ${x},${y} is protected without an eight-direction leak`);
    }
    return [...outside].map(value => value.split(',').map(Number));
}

function towerDamage(tower, target) {
    const range = Math.max(Math.abs(tower[0] - target[0]), Math.abs(tower[1] - target[1]));
    return 600 - 30 * Math.max(0, Math.min(20, range) - 5);
}

function weakestEntranceDamage(towers, outside) {
    return Math.min(...outside.map(target => towers.reduce((sum, tower) => sum + towerDamage(tower, target), 0)));
}

function validateTowerDefense(blueprint, outside) {
    const towers = blueprint.structMap.tower;
    assert.equal(towers.length, 6, 'all six RCL8 Towers remain planned');
    assert.equal(new Set(towers.map(([x, y]) => key(x, y))).size, 6, 'Tower positions remain unique');
    for (const tower of towers) {
        for (const target of outside) {
            const range = Math.max(Math.abs(tower[0] - target[0]), Math.abs(tower[1] - target[1]));
            assert.ok(range >= 4,
                `Tower at ${tower} stays outside rangedAttack range from enemy-reachable ${target}`);
        }
    }
}

for (const [name, transform] of Object.entries(transforms)) {
    test(`a one-sided room uses an exit perimeter with a short corner (${name})`, () => {
        const world = transformedWorld(transform, `E41N6-${name}`);
        const result = world.planner.computeRoomBlueprint(world.room);
        validateBlueprint(world.room, result);
        assert.equal(result.planningStrategyVersion, world.loader.load('planning/types').PLANNING_STRATEGY_VERSION);
        assert.equal(result.exitDefense.exitSides, 1);
        const expected = new Set();
        for (let x = 8; x <= 36; x++) expected.add(key(...transform(x, 47)));
        expected.add(key(...transform(36, 48)));
        assert.deepEqual(new Set(result.structMap.rampart.map(([x, y]) => key(x, y))), expected,
            'the defense turns down at the last exit instead of extending across the eastern empty ground');
        if (name === 'original') assert.ok(result.storagePos.x < 25, 'resource access selects the left-hand building area');
        validateRoadNetwork(world, result);
        validateTowerDefense(result, validatePerimeter(world, result));
    });
}

test('entrance Towers improve the weakest entry firepower over the previous core placement', () => {
    const world = transformedWorld();
    const previous = world.loader.load('planning/vendor/manor63').computeManor63(world.room.name, world.points,
        { minimumPlaneCount: 140 });
    assert.ok(previous);
    const result = world.planner.computeRoomBlueprint(world.room);
    const outside = validatePerimeter(world, result);
    validateTowerDefense(result, outside);
    const previousMinimum = weakestEntranceDamage(previous.structMap.tower, outside);
    const currentMinimum = weakestEntranceDamage(result.structMap.tower, outside);
    assert.ok(currentMinimum >= previousMinimum * 1.5,
        `the weakest entry gets substantially more combined Tower damage (${previousMinimum} -> ${currentMinimum})`);
});

test('one-sided exit defense preserves an explicit existing storage anchor', () => {
    const world = transformedWorld();
    const raw = world.loader.load('planning/vendor/manor63').computeManor63(world.room.name, world.points,
        { minimumPlaneCount: 140 });
    assert.ok(raw);
    const anchor = { x: raw.structMap.storage[0][0] + 1, y: raw.structMap.storage[0][1] };
    const result = world.planner.computeRoomBlueprint(world.room, { storagePosition: anchor });
    validateBlueprint(world.room, result);
    assert.equal(result.storagePos.x, anchor.x);
    assert.equal(result.storagePos.y, anchor.y);
    validateRoadNetwork(world, result);
    validateTowerDefense(result, validatePerimeter(world, result));
});

test('existing Towers keep their positions when the remaining entrance Towers are planned', () => {
    const world = transformedWorld();
    const previous = world.loader.load('planning/vendor/manor63').computeManor63(world.room.name, world.points,
        { minimumPlaneCount: 140 });
    assert.ok(previous);
    const fixedTowers = previous.structMap.tower.slice(0, 2).map(position => Array.from(position));
    const anchor = { x: previous.structMap.storage[0][0] + 1, y: previous.structMap.storage[0][1] };
    const result = world.planner.computeRoomBlueprint(world.room, { storagePosition: anchor, fixedTowers });
    validateBlueprint(world.room, result);
    for (const fixed of fixedTowers) {
        assert.ok(result.structMap.tower.some(([x, y]) => x === fixed[0] && y === fixed[1]),
            `existing Tower at ${fixed} is preserved`);
    }
    validateRoadNetwork(world, result);
    validateTowerDefense(result, validatePerimeter(world, result));
});

test('few exits on multiple sides also use native-legal exit defense', () => {
    const world = createWorld();
    const terrain = new Uint8Array(2500);
    for (let x = 0; x < 50; x++) for (let y = 0; y < 50; y++) {
        if (x === 0 || y === 0 || x === 49 || y === 49) terrain[x * 50 + y] = 1;
    }
    for (let x = 10; x <= 12; x++) terrain[x * 50] = terrain[x * 50 + 49] = 0;
    const room = world.roomFor('few-two-sided-exits', terrain);
    const points = [room.controller, ...room.find('minerals'), ...room.find('sources')];
    const result = world.planner.computeRoomBlueprint(room);
    validateBlueprint(room, result);
    assert.equal(result.exitDefense.exitCount, 6);
    assert.equal(result.exitDefense.exitSides, 2);
    const populated = { ...world, room, points };
    validateRoadNetwork(populated, result);
    validateTowerDefense(result, validatePerimeter(populated, result));
});

test('wide exits on several sides retain the original layout and defensive ring', () => {
    const world = createWorld();
    const room = world.roomFor('wide-many-sided-exits');
    const points = [room.controller, ...room.find('minerals'), ...room.find('sources')];
    const raw = world.loader.load('planning/vendor/manor63').computeManor63(room.name, points, { minimumPlaneCount: 140 });
    const result = world.planner.computeRoomBlueprint(room);
    validateBlueprint(room, result);
    assert.equal(result.exitDefense, undefined);
    assert.equal(result.storagePos.x, raw.structMap.storage[0][0] + 1);
    assert.equal(result.storagePos.y, raw.structMap.storage[0][1]);
    for (const type of Object.keys(raw.structMap)) {
        assert.deepEqual(Array.from(result.structMap[type], position => Array.from(position)),
            Array.from(raw.structMap[type], position => Array.from(position)), `${type} keeps the upstream fallback layout`);
    }
});

test('the CPU budget covers blueprint adaptation after vendor planning has returned', () => {
    const world = transformedWorld();
    const raw = world.loader.load('planning/vendor/manor63').computeManor63(world.room.name, world.points,
        { minimumPlaneCount: 140 });
    assert.ok(raw);
    let vendorReturned = false;
    world.cpu.getUsed = () => vendorReturned ? 2 : 0;
    const loader = createSourceLoader({ globals: world.loader.globals, modules: {
        './vendor/manor63': { computeManor63: () => { vendorReturned = true; return raw; } },
    } });
    const planner = loader.load('planning/planner63');
    assert.throws(() => planner.computeRoomBlueprint(world.room, { maximumCpu: 1 }), error => {
        assert.equal(error.name, 'PlanningBudgetExceeded');
        assert.equal(error.maximumCpu, 1);
        return true;
    });
    assert.equal(vendorReturned, true, 'the budget is enforced after the vendor planner, not only within it');
    world.cpu.getUsed = () => 0;
    validateBlueprint(world.room, planner.computeRoomBlueprint(world.room, { maximumCpu: 300 }));
});
