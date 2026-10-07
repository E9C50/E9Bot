const assert = require('node:assert/strict');
const test = require('node:test');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const { createWorld } = require('../helpers/planner-world.cjs');
const fixture = require('../fixtures/room-shard2-E41N6.json');

const loader = createSourceLoader();
const { computeExitPerimeter, isRampartTerrainLegal } = loader.load('planning/exitPerimeter');
const { planExitTowers, towerAttackPowerAtRange } = loader.load('planning/exitTowers');
const policy = { enabled: true, maximumExitTiles: 32, maximumRamparts: 80 };
const key = position => position.join(',');
const positions = list => Array.from(list, position => Array.from(position));
const distance = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
const terrainFrom = grid => ({ get: (x, y) => Number(grid[y * 50 + x]) });

let actual;
function realLayout() {
    if (actual) return actual;
    const world = createWorld(), grid = new Uint8Array(2500);
    for (let y = 0; y < 50; y++) for (let x = 0; x < 50; x++) grid[x * 50 + y] = Number(fixture.terrain[y * 50 + x]);
    const room = world.roomFor(fixture.roomName, grid);
    const nativePoints = [fixture.controller, fixture.mineral, ...fixture.sources].map(point => [point.x, point.y]);
    const points = nativePoints.map(([x, y]) => ({ pos: new world.loader.globals.RoomPosition(x, y, room.name) }));
    const raw = world.loader.load('planning/vendor/manor63').computeManor63(room.name, points,
        { minimumPlaneCount: 140, optimizeResourceAccess: true, resourceAccessWeights: { source: 3, controller: 2, mineral: 0.5 } });
    assert.ok(raw);
    const terrain = terrainFrom(fixture.terrain), perimeter = computeExitPerimeter(terrain, policy);
    const structures = Object.fromEntries(Object.entries(raw.structMap).map(([type, list]) => [type, positions(list)]));
    structures.rampart = positions(perimeter.ramparts);
    actual = { terrain, perimeter, structures, nativePoints };
    return actual;
}

function outsidePositions(perimeter) {
    return Array.from(perimeter.outside, (outside, index) => outside ? [index % 50, Math.floor(index / 50)] : undefined).filter(Boolean);
}

function assertTowerPlan(world, plan, fixed = []) {
    assert.ok(plan, 'terrain and supply roads admit a complete tower plan');
    assert.equal(plan.towers.length, 6);
    assert.equal(new Set(plan.towers.map(key)).size, 6);
    const outside = outsidePositions(world.perimeter), fixedKeys = new Set(fixed.map(key));
    const forbidden = new Set(world.nativePoints.map(key));
    for (const [type, list] of Object.entries(world.structures)) if (type !== 'tower') for (const pos of list)
        if (type !== 'rampart' || !fixedKeys.has(key(pos))) forbidden.add(key(pos));
    for (const tower of plan.towers) {
        assert.ok(isRampartTerrainLegal(world.terrain, ...tower));
        assert.ok(!world.perimeter.outside[tower[1] * 50 + tower[0]]);
        assert.ok(!forbidden.has(key(tower)));
        if (!fixedKeys.has(key(tower))) for (const enemy of outside) assert.ok(distance(enemy, tower) >= 4,
            `tower ${key(tower)} is beyond ranged range 3 from enemy ${key(enemy)}`);
    }
    const roadSet = new Set(plan.roads.map(key));
    assert.equal(roadSet.size, plan.roads.length);
    const queue = [world.structures.road[0]], seen = new Set([key(queue[0])]);
    for (let cursor = 0; cursor < queue.length; cursor++) {
        const [x, y] = queue[cursor];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const next = [x + dx, y + dy], k = key(next);
            if ((!dx && !dy) || seen.has(k) || !roadSet.has(k)) continue;
            seen.add(k); queue.push(next);
        }
    }
    assert.equal(seen.size, roadSet.size, 'all supply roads join the original connected road network');
    for (const tower of plan.towers) assert.ok(plan.roads.some(road => distance(road, tower) === 1), 'each tower has road access');
    const originalRoads = new Set(world.structures.road.map(key));
    const obstacles = new Set(world.nativePoints.map(key));
    for (const [type, list] of Object.entries(world.structures)) if (!['road', 'container', 'tower'].includes(type))
        for (const pos of list) obstacles.add(key(pos));
    for (const tower of plan.towers) obstacles.add(key(tower));
    for (const road of plan.roads) if (!originalRoads.has(key(road))) {
        assert.ok(!obstacles.has(key(road)));
        assert.ok(!world.perimeter.outside[road[1] * 50 + road[0]]);
        assert.equal(world.terrain.get(...road) & 1, 0);
    }
}

test('tower attack curve matches full power through range 5 and minimum power from range 20', () => {
    for (const [range, power] of [[0, 600], [3, 600], [5, 600], [6, 570], [10, 450], [19, 180], [20, 150], [49, 150]])
        assert.equal(towerAttackPowerAtRange(range), power);
});

test('actual E41N6 towers cover the complete south entrance from safe positions with connected supply roads', () => {
    const world = realLayout(), before = JSON.stringify(world.structures);
    const plan = planExitTowers(world.terrain, world.perimeter, world.structures, world.nativePoints);
    assertTowerPlan(world, plan);
    assert.equal(JSON.stringify(world.structures), before, 'planning does not mutate the caller blueprint');
    const outside = outsidePositions(world.perimeter);
    const power = towers => outside.map(enemy => towers.reduce((sum, tower) => sum + towerAttackPowerAtRange(distance(enemy, tower)), 0));
    const oldPower = power(world.structures.tower), newPower = power(plan.towers);
    assert.ok(Math.min(...newPower) > Math.min(...oldPower), 'the weakest entrance position receives more total firepower');
    assert.ok(newPower.reduce((a, b) => a + b, 0) > oldPower.reduce((a, b) => a + b, 0), 'total entrance firepower improves');
    const xs = plan.towers.map(([x]) => x);
    assert.ok(Math.max(...xs) - Math.min(...xs) >= 20, 'six towers spread over the entrance instead of clustering at the core');
    assert.ok(outside.every(enemy => plan.towers.some(tower => distance(enemy, tower) <= 7)), 'the entire opening has a nearby firing arc');
    for (let i = 0; i < plan.towers.length; i++) for (let j = 0; j < i; j++)
        assert.ok(distance(plan.towers[i], plan.towers[j]) >= 3, 'the firing line avoids adjacent tower clusters');
    // Early RCL quotas use the strongest weakest combined arc from the final
    // tower positions. Equal-firepower choices may favour broader coverage.
    for (let n = 1; n <= plan.towers.length; n++) {
        const prefix = plan.towers.slice(0, n - 1), chosenMinimum = Math.min(...power(plan.towers.slice(0, n)));
        for (const alternative of plan.towers.slice(n))
            assert.ok(chosenMinimum >= Math.min(...power([...prefix, alternative])), 'each construction slot maximizes weakest prefix firepower');
    }
});

test('mirrored and rotated real terrain always keeps the towers safe and supply routes connected', () => {
    const original = realLayout();
    for (let mirror = 0; mirror < 2; mirror++) for (let rotation = 0; rotation < 4; rotation++) {
        const transform = (x, y) => {
            if (mirror) x = 49 - x;
            for (let turn = 0; turn < rotation; turn++) [x, y] = [49 - y, x];
            return [x, y];
        };
        const grid = new Uint8Array(2500);
        for (let y = 0; y < 50; y++) for (let x = 0; x < 50; x++) {
            const [nx, ny] = transform(x, y); grid[ny * 50 + nx] = original.terrain.get(x, y);
        }
        const terrain = terrainFrom(grid), perimeter = computeExitPerimeter(terrain, policy);
        const structures = Object.fromEntries(Object.entries(original.structures).map(([type, list]) => [type, list.map(pos => transform(...pos))]));
        const world = { terrain, perimeter, structures, nativePoints: original.nativePoints.map(pos => transform(...pos)) };
        const plan = planExitTowers(terrain, perimeter, structures, world.nativePoints);
        assertTowerPlan(world, plan);
    }
});

test('an existing built tower is fixed while remaining towers cover the exit', () => {
    const world = realLayout(), fixedTowers = [world.structures.tower[0]];
    const plan = planExitTowers(world.terrain, world.perimeter, world.structures, world.nativePoints, { fixedTowers });
    assertTowerPlan(world, plan, fixedTowers);
    assert.deepEqual(Array.from(plan.towers[0]), fixedTowers[0]);
});

test('a covering friendly Rampart does not disqualify an invested tower', () => {
    const original = realLayout(), fixedTowers = [original.structures.tower[0]];
    const world = { ...original, structures: { ...original.structures,
        rampart: [...original.structures.rampart, [...fixedTowers[0]]] } };
    const plan = planExitTowers(world.terrain, world.perimeter, world.structures, world.nativePoints, { fixedTowers });
    assertTowerPlan(world, plan, fixedTowers);
    assert.deepEqual(Array.from(plan.towers[0]), fixedTowers[0]);
    const invalid = { ...world.structures, road: [...world.structures.road, [...fixedTowers[0]]] };
    assert.equal(planExitTowers(world.terrain, world.perimeter, invalid, world.nativePoints, { fixedTowers }), undefined,
        'a Tower cannot share its tile with a road even if a friendly Rampart is also present');
});

test('small entrances on separate sides both receive firing coverage', () => {
    const grid = new Uint8Array(2500).fill(1);
    for (let y = 1; y < 49; y++) for (let x = 1; x < 49; x++) grid[y * 50 + x] = 0;
    grid[24] = grid[24 * 50 + 49] = 0;
    const terrain = terrainFrom(grid), perimeter = computeExitPerimeter(terrain, policy);
    assert.equal(perimeter.exitSides, 2);
    const plan = planExitTowers(terrain, perimeter, { road: [[25, 25]] }, []);
    assert.ok(plan);
    for (const enemy of outsidePositions(perimeter)) {
        assert.ok(plan.towers.every(tower => distance(enemy, tower) >= 4));
        assert.ok(plan.towers.some(tower => distance(enemy, tower) <= 8), 'each distinct entry has its own nearby firing arc');
    }
});

test('ranged safety crosses walls instead of treating walls as shields', () => {
    const grid = new Uint8Array(2500).fill(1);
    // The frontier is sealed, but a natural wall separates this protected room
    // from exterior standing tiles. Towers must still respect geometric range.
    for (let y = 30; y <= 46; y++) for (let x = 10; x <= 39; x++) grid[y * 50 + x] = 0;
    const outside = new Uint8Array(2500);
    for (let x = 10; x <= 39; x++) { grid[48 * 50 + x] = 0; outside[48 * 50 + x] = 1; }
    const perimeter = { ramparts: [[10, 47]], outside };
    const structures = { road: [[25, 35]], tower: [] };
    const plan = planExitTowers(terrainFrom(grid), perimeter, structures, []);
    assert.ok(plan);
    assert.ok(plan.towers.every(([, y]) => y <= 44), 'a terrain wall at y47 does not protect y45 or y46 from ranged attacks');
});

test('insufficient safe space or inaccessible supply returns undefined without mutation', () => {
    const world = realLayout();
    const noRoads = { ...world.structures, road: [] }, before = JSON.stringify(noRoads);
    assert.equal(planExitTowers(world.terrain, world.perimeter, noRoads, world.nativePoints), undefined);
    assert.equal(JSON.stringify(noRoads), before);
    const grid = new Uint8Array(2500).fill(1);
    for (let y = 45; y <= 49; y++) for (let x = 20; x <= 25; x++) grid[y * 50 + x] = 0;
    const terrain = terrainFrom(grid), perimeter = computeExitPerimeter(terrain, policy);
    assert.ok(perimeter);
    assert.equal(planExitTowers(terrain, perimeter, { road: [[20, 45]] }, []), undefined);
});

test('invalid options cannot weaken enemy ranged safety or exceed the native tower quota', () => {
    const world = realLayout();
    for (const options of [{ minimumEnemyRange: 3 }, { minimumEnemyRange: 2.5 }, { towerCount: 0 }, { towerCount: 7 },
        { fixedTowers: Array.from({ length: 7 }, (_, i) => [i + 12, 30]) }])
        assert.equal(planExitTowers(world.terrain, world.perimeter, world.structures, world.nativePoints, options), undefined);
    const one = planExitTowers(world.terrain, world.perimeter, world.structures, world.nativePoints, { towerCount: 1 });
    assert.equal(one.towers.length, 1);
});

test('budget callbacks can interrupt geometry, tower scoring and road routing without mutation', () => {
    const world = realLayout(), before = JSON.stringify(world.structures);
    let calls = 0;
    assert.throws(() => planExitTowers(world.terrain, world.perimeter, world.structures, world.nativePoints, {}, () => {
        if (++calls === 150) throw new Error('tower planning budget exhausted');
    }), /tower planning budget exhausted/);
    assert.equal(JSON.stringify(world.structures), before);
});
