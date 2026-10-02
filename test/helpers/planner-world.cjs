const assert = require('node:assert/strict');
const { createSourceLoader } = require('./load-typescript.cjs');

/** Run the actual planner and heap with local terrain and an eight-direction A* PathFinder. */
function createWorld() {
    const terrains = new Map();
    class Terrain {
        constructor(roomName) { this.roomName = roomName; }
        get(x, y) { return terrains.get(this.roomName)[x * 50 + y]; }
    }
    class Position {
        constructor(x, y, roomName) {
            assert(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < 50 && y < 50);
            Object.assign(this, { x, y, roomName });
        }
    }
    class Matrix {
        constructor() { this.values = new Uint8Array(2500); }
        set(x, y, cost) { this.values[x * 50 + y] = cost; }
        get(x, y) { return this.values[x * 50 + y]; }
    }

    const counts = {
        spawn: 3, extension: 60, road: 2500, constructedWall: 2500, rampart: 2500,
        link: 6, storage: 1, tower: 6, observer: 1, powerSpawn: 1, extractor: 1,
        lab: 10, terminal: 1, container: 5, nuker: 1, factory: 1
    };
    const blockers = [
        'spawn', 'extension', 'constructedWall', 'link', 'storage', 'tower', 'observer',
        'powerSpawn', 'lab', 'terminal', 'nuker', 'factory', 'extractor'
    ];
    const routes = { calls: 0, incomplete: 0 };
    let Heap;
    function search(origin, goal, options) {
        routes.calls++;
        assert.equal(options.maxRooms, 1);
        const goals = Array.isArray(goal) ? goal : [goal];
        assert.ok(goals.length > 0, 'a resource route needs at least one endpoint');
        const matrix = options.roomCallback(origin.roomName);
        const heap = new Heap(true);
        const distance = new Float64Array(2500).fill(Infinity);
        const previous = new Int16Array(2500).fill(-1);
        const start = origin.x * 50 + origin.y;
        distance[start] = 0;
        heap.push({ k: 0, g: 0, x: origin.x, y: origin.y });
        let final = -1;
        let ops = 0;
        while (!heap.isEmpty()) {
            const item = heap.pop();
            const index = item.x * 50 + item.y;
            if (item.g !== distance[index]) continue;
            ops++;
            if (goals.some(target => Math.max(Math.abs(item.x - target.pos.x), Math.abs(item.y - target.pos.y)) <= target.range)) {
                final = index;
                break;
            }
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    const x = item.x + dx;
                    const y = item.y + dy;
                    if (!(dx || dy) || x < 0 || y < 0 || x >= 50 || y >= 50 || matrix.get(x, y) >= 255) continue;
                    const neighbor = x * 50 + y;
                    const score = distance[index] + (matrix.get(x, y) || 2);
                    if (score >= distance[neighbor]) continue;
                    distance[neighbor] = score;
                    previous[neighbor] = index;
                    const heuristic = Math.min(...goals.map(target => Math.max(0,
                        Math.max(Math.abs(x - target.pos.x), Math.abs(y - target.pos.y)) - target.range)));
                    heap.push({ k: score + heuristic, g: score, x, y });
                }
            }
        }
        const path = [];
        if (final < 0) {
            routes.incomplete++;
            return { path, ops, cost: 0, incomplete: true };
        }
        const cost = distance[final];
        while (final !== start) {
            path.push(new Position(Math.floor(final / 50), final % 50, origin.roomName));
            final = previous[final];
            assert(final >= 0);
        }
        path.reverse();
        return { path, ops, cost, incomplete: false };
    }
    const cpu = { getUsed: () => 0 };
    const pathFinder = { CostMatrix: Matrix, search };
    const loader = createSourceLoader({ globals: {
        Game: { cpu }, Room: { Terrain }, RoomPosition: Position, PathFinder: pathFinder,
        CONTROLLER_STRUCTURES: Object.fromEntries(Object.entries(counts).map(([name, count]) => [name, { 8: count }])),
        OBSTACLE_OBJECT_TYPES: blockers, TERRAIN_MASK_WALL: 1, TERRAIN_MASK_SWAMP: 2,
        FIND_MINERALS: 'minerals', FIND_SOURCES: 'sources'
    } });
    Heap = loader.load('planning/vendor/PriorityQueue').PriorityQueue;
    const planner = loader.load('planning/planner63');
    function roomFor(name, grid = new Uint8Array(2500)) {
        terrains.set(name, grid);
        const mineral = { pos: new Position(40, 10, name) };
        const sources = [{ pos: new Position(10, 10, name) }, { pos: new Position(40, 40, name) }];
        return {
            name, controller: { pos: new Position(10, 40, name) },
            find: type => type === 'minerals' ? [mineral] : sources,
            getTerrain: () => new Terrain(name)
        };
    }
    return { planner, roomFor, cpu, pathFinder, routes, loader };
}

function validateBlueprint(room, result) {
    assert(result, 'the real algorithm should produce a blueprint');
    assert.equal(result.roomName, room.name);
    for (const [type, count] of Object.entries({
        spawn: 3, extension: 60, tower: 6, lab: 10, storage: 1, terminal: 1,
        factory: 1, nuker: 1, powerSpawn: 1, observer: 1, extractor: 1
    })) {
        assert.equal(result.structMap[type].length, count, `${type} RCL8 quota`);
    }
    assert.equal(result.structMap.container.length, 4);
    assert(result.structMap.road.length > 0);
    assert(result.structMap.rampart.length > 0);
    const mineral = room.find('minerals')[0].pos;
    assert.equal(result.structMap.extractor[0].join(','), `${mineral.x},${mineral.y}`, 'the mineral keeps upstream point index 1');
    assert.equal(result.storagePos.x, result.structMap.storage[0][0] + 1);
    assert.equal(result.storagePos.y, result.structMap.storage[0][1]);
    const terrain = room.getTerrain();
    for (const [type, positions] of Object.entries(result.structMap)) {
        const seen = new Set();
        for (const [x, y] of positions) {
            assert(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < 50 && y < 50);
            const mineralHere = room.find('minerals').some(mineral => mineral.pos.x === x && mineral.pos.y === y);
            if (type !== 'extractor' || !mineralHere)
                assert.notEqual(terrain.get(x, y), 1, `${type} must not occupy a terrain wall`);
            assert(!seen.has(`${x},${y}`), `${type} coordinates must be deduplicated`);
            seen.add(`${x},${y}`);
        }
    }
}

module.exports = { createWorld, validateBlueprint };
