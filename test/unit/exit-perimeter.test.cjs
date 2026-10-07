const assert = require('node:assert/strict');
const test = require('node:test');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const fixture = require('../fixtures/room-shard2-E41N6.json');

const { computeExitPerimeter, isRampartTerrainLegal } = createSourceLoader().load('planning/exitPerimeter');
const policy = { enabled: true, maximumExitTiles: 12, maximumRamparts: 80 };

function terrainFrom(grid) {
    return {
        grid,
        get(x, y) {
            assert.ok(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < 50 && y < 50);
            return Number(grid[y * 50 + x]);
        }
    };
}

function enclosedTerrain() {
    const grid = new Uint8Array(2500).fill(1);
    for (let y = 1; y < 49; y++) for (let x = 1; x < 49; x++) grid[y * 50 + x] = 0;
    return terrainFrom(grid);
}

function sortedPositions(positions) {
    return Array.from(positions, pos => `${pos[0]},${pos[1]}`).sort();
}

function reachableFromExits(terrain, barriers = []) {
    const blocked = new Set(sortedPositions(barriers)), reached = new Uint8Array(2500), queue = [];
    for (let y = 0; y < 50; y++) for (let x = 0; x < 50; x++) {
        if (x !== 0 && y !== 0 && x !== 49 && y !== 49) continue;
        if ((terrain.get(x, y) & 1) || blocked.has(`${x},${y}`)) continue;
        reached[y * 50 + x] = 1;
        queue.push([x, y]);
    }
    for (let cursor = 0; cursor < queue.length; cursor++) {
        const [x, y] = queue[cursor];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if ((!dx && !dy) || nx < 0 || nx >= 50 || ny < 0 || ny >= 50) continue;
            const index = ny * 50 + nx;
            if (reached[index] || (terrain.get(nx, ny) & 1) || blocked.has(`${nx},${ny}`)) continue;
            reached[index] = 1;
            queue.push([nx, ny]);
        }
    }
    return reached;
}

function assertSealed(terrain, result) {
    assert.ok(result);
    assert.equal(result.outside.length, 2500);
    const reached = reachableFromExits(terrain, result.ramparts);
    for (let y = 0; y < 50; y++) for (let x = 0; x < 50; x++) {
        assert.equal(reached[y * 50 + x], result.outside[y * 50 + x], 'outside uses row-major coordinates');
        if (reached[y * 50 + x]) assert.equal(isRampartTerrainLegal(terrain, x, y), false,
            `exit movement cannot cross into buildable terrain at ${x},${y}`);
    }
    for (const [x, y] of result.ramparts) assert.equal(isRampartTerrainLegal(terrain, x, y), true);
}

function transformTerrain(terrain, transform) {
    const grid = new Uint8Array(2500);
    for (let y = 0; y < 50; y++) for (let x = 0; x < 50; x++) {
        const [nx, ny] = transform(x, y);
        grid[ny * 50 + nx] = terrain.get(x, y);
    }
    return terrainFrom(grid);
}

test('exit perimeter imports and computes without Screeps globals', () => {
    const loader = createSourceLoader();
    const before = Object.keys(loader.globals).sort();
    const module = loader.load('planning/exitPerimeter');
    const terrain = enclosedTerrain(); terrain.grid[49 * 50 + 25] = 0;
    assert.ok(module.computeExitPerimeter(terrain, policy));
    assert.deepEqual(Object.keys(loader.globals).sort(), before);
    assert.equal(loader.globals.Game, undefined);
});

test('native legality rejects borders, walls and the three tiles beside each exit', () => {
    const terrain = enclosedTerrain();
    terrain.grid[49 * 50 + 25] = 0;
    for (const pos of [[25, 49], [25, 0], [0, 25], [49, 25], [-1, 25], [50, 25], [25.5, 25]]) {
        assert.equal(isRampartTerrainLegal(terrain, ...pos), false);
    }
    for (const x of [24, 25, 26]) assert.equal(isRampartTerrainLegal(terrain, x, 48), false);
    for (const pos of [[23, 48], [27, 48], [25, 47], [1, 25], [48, 25], [25, 1]]) {
        assert.equal(isRampartTerrainLegal(terrain, ...pos), true);
    }
    terrain.grid[25 * 50 + 25] = 1;
    terrain.grid[25 * 50 + 26] = 3;
    terrain.grid[25 * 50 + 27] = 2;
    assert.equal(isRampartTerrainLegal(terrain, 25, 25), false);
    assert.equal(isRampartTerrainLegal(terrain, 26, 25), false, 'wall remains blocked when other terrain bits are present');
    assert.equal(isRampartTerrainLegal(terrain, 27, 25), true, 'swamp is buildable');
});

test('actual E41N6 seals the south opening then turns down at the right end', () => {
    const terrain = terrainFrom(fixture.terrain);
    const result = computeExitPerimeter(terrain, policy);
    const expected = Array.from({ length: 29 }, (_, i) => [i + 8, 47]).concat([[36, 48]]);
    assertSealed(terrain, result);
    assert.equal(result.exitSides, 1);
    assert.equal(result.exitCount, 29);
    assert.equal(result.ramparts.length, 30);
    assert.deepEqual(sortedPositions(result.ramparts), sortedPositions(expected));
    assert.ok(!result.ramparts.some(([x]) => x > 36), 'the frontier stops at the legal corner instead of stretching to x43');
    for (const point of [fixture.controller, fixture.mineral, ...fixture.sources]) {
        assert.equal(result.outside[point.y * 50 + point.x], 0, 'room resources stay behind the exit barrier');
    }
});

test('rotations and mirrors of E41N6 produce the same terrain-derived barrier', () => {
    const original = terrainFrom(fixture.terrain);
    const expected = Array.from({ length: 29 }, (_, i) => [i + 8, 47]).concat([[36, 48]]);
    for (let mirrored = 0; mirrored <= 1; mirrored++) for (let rotation = 0; rotation < 4; rotation++) {
        const transform = (x, y) => {
            if (mirrored) x = 49 - x;
            for (let turn = 0; turn < rotation; turn++) [x, y] = [49 - y, x];
            return [x, y];
        };
        const terrain = transformTerrain(original, transform);
        const result = computeExitPerimeter(terrain, policy);
        assertSealed(terrain, result);
        assert.equal(result.exitSides, 1);
        assert.deepEqual(sortedPositions(result.ramparts), sortedPositions(expected.map(pos => transform(...pos))));
    }
});

test('a broad single-side exit qualifies independently of the small-exit threshold', () => {
    const terrain = enclosedTerrain();
    for (let x = 1; x < 49; x++) terrain.grid[49 * 50 + x] = 0;
    const result = computeExitPerimeter(terrain, { ...policy, maximumExitTiles: 0 });
    assertSealed(terrain, result);
    assert.equal(result.exitCount, 48);
    assert.equal(result.exitSides, 1);
    assert.deepEqual(sortedPositions(result.ramparts), sortedPositions(Array.from({ length: 48 }, (_, i) => [i + 1, 47])));
});

test('small exits on multiple sides qualify, but larger multi-side rooms fall back', () => {
    const terrain = enclosedTerrain();
    for (const x of [12, 13, 14]) terrain.grid[x] = 0;
    for (const y of [31, 32, 33]) terrain.grid[y * 50 + 49] = 0;
    const result = computeExitPerimeter(terrain, { ...policy, maximumExitTiles: 6 });
    assertSealed(terrain, result);
    assert.equal(result.exitCount, 6);
    assert.equal(result.exitSides, 2);
    assert.equal(computeExitPerimeter(terrain, { ...policy, maximumExitTiles: 5 }), undefined);
    const open = terrainFrom(new Uint8Array(2500));
    assert.equal(computeExitPerimeter(open, policy), undefined);
});

test('legal endpoint caps prevent diagonal entry around a straight rampart row', () => {
    const terrain = enclosedTerrain();
    for (let x = 20; x <= 25; x++) terrain.grid[49 * 50 + x] = 0;
    const result = computeExitPerimeter(terrain, policy);
    assertSealed(terrain, result);
    const expected = Array.from({ length: 10 }, (_, i) => [i + 18, 47]).concat([[18, 48], [27, 48]]);
    assert.deepEqual(sortedPositions(result.ramparts), sortedPositions(expected));
    const openEnd = result.ramparts.filter(([x, y]) => x !== 27 || y !== 48);
    assert.equal(reachableFromExits(terrain, openEnd)[48 * 50 + 27], 1,
        'omitting the turned-down cap opens a diagonal route around the frontier');
});

test('disconnected exit gaps are sealed separately without spanning the wall between them', () => {
    const terrain = enclosedTerrain();
    terrain.grid[49 * 50 + 10] = 0; terrain.grid[49 * 50 + 40] = 0;
    const result = computeExitPerimeter(terrain, policy);
    assertSealed(terrain, result);
    assert.equal(result.exitSides, 1);
    assert.equal(result.exitCount, 2);
    assert.ok(result.ramparts.every(([x]) => x <= 12 || x >= 38));
});

test('maximum ramparts is enforced even for a single-side opening', () => {
    const terrain = terrainFrom(fixture.terrain);
    assert.ok(computeExitPerimeter(terrain, { ...policy, maximumRamparts: 30 }));
    assert.equal(computeExitPerimeter(terrain, { ...policy, maximumRamparts: 29 }), undefined);
});

test('disabled, invalid policy and rooms without usable exits fall back safely', () => {
    const terrain = enclosedTerrain();
    assert.equal(computeExitPerimeter(terrain, policy), undefined);
    terrain.grid[49 * 50 + 25] = 0;
    for (const changes of [{ enabled: false }, { maximumExitTiles: -1 }, { maximumExitTiles: Infinity },
        { maximumExitTiles: 2.5 }, { maximumRamparts: 0 }, { maximumRamparts: NaN }, { maximumRamparts: 1.5 }]) {
        assert.equal(computeExitPerimeter(terrain, { ...policy, ...changes }), undefined);
    }
    assert.equal(computeExitPerimeter(terrainFrom(new Uint8Array(2500).fill(3)), policy), undefined);
    const isolated = new Uint8Array(2500).fill(1); isolated[49 * 50 + 25] = 0;
    assert.equal(computeExitPerimeter(terrainFrom(isolated), policy), undefined, 'a wall-isolated border tile needs no barrier');
});

test('budget callbacks run throughout geometry work and propagate their original errors', () => {
    const terrain = terrainFrom(fixture.terrain);
    for (const throwAt of [1, 25, 75, 125]) {
        const error = new Error(`budget-${throwAt}`); let calls = 0;
        assert.throws(() => computeExitPerimeter(terrain, policy, () => {
            if (++calls === throwAt) throw error;
        }), thrown => thrown === error);
        assert.equal(calls, throwAt);
    }
    assertSealed(terrain, computeExitPerimeter(terrain, policy));
});
