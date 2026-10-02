const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function movementWorld(searchResult) {
    const moves = [], moveCalls = [], searches = [], roomReads = new Map();
    class Position {
        constructor(x, y, roomName) { Object.assign(this, { x, y, roomName }); }
        findClosestByPath() { return null; }
        findInRange(type, range, options = {}) {
            if (type !== 'creeps') return [];
            return Object.values(game.creeps).filter(unit => unit.pos.roomName === this.roomName &&
                Math.max(Math.abs(unit.pos.x - this.x), Math.abs(unit.pos.y - this.y)) <= range &&
                (!options.filter || options.filter(unit)));
        }
    }
    class Creep {
        constructor(room) {
            Object.assign(this, { name: 'scout', room, pos: new Position(47, 25, room.name), memory: { role: 'sScout' },
                my: true, spawning: false, fatigue: 0, body: [{ type: 'move', hits: 100 }] });
        }
        move(direction) { moves.push(direction); moveCalls.push({ name: this.name, direction }); return Number.isInteger(direction) && direction >= 1 && direction <= 8 ? 0 : -10; }
        moveTo() { throw new Error('The reproduction must use the real BetterMove implementation'); }
        build() {} repair() {} dismantle() {} harvest() {}
    }
    class PowerCreep extends Creep {}
    class CostMatrix {
        constructor() { this.data = new Map(); }
        get(x, y) { return this.data.get(`${x},${y}`) || 0; }
        set(x, y, value) { this.data.set(`${x},${y}`, value); }
        clone() { const result = new CostMatrix(); result.data = new Map(this.data); return result; }
    }
    const rooms = {};
    function room(name, structures = []) {
        if (!rooms[name]) rooms[name] = { name, lookForAt: (type, pos) => type === 'creep'
            ? Object.values(game.creeps).filter(unit => unit.pos.roomName === name && unit.pos.x === pos.x && unit.pos.y === pos.y) : [], find(type) {
            roomReads.set(name, (roomReads.get(name) || 0) + 1);
            return type === 'structures' ? structures : [];
        } };
        return rooms[name];
    }
    const game = { time: 1, rooms: { E0S0: room('E0S0') }, creeps: {}, cpu: { getUsed: () => 0 }, getObjectById: () => null,
        map: { findRoute: (from, to) => [{ exit: 3, room: to }], describeExits: () => ({}), getRoomStatus: () => ({ status: 'normal' }) } };
    const creep = new Creep(game.rooms.E0S0); game.creeps.scout = creep;
    const loader = createSourceLoader({ globals: {
        Game: game, Memory: {}, Creep, PowerCreep, RoomPosition: Position,
        PathFinder: { CostMatrix, search(from, goal, options) {
            searches.push({ from: { ...from }, goal: { pos: { ...goal.pos }, range: goal.range }, options });
            const result = searchResult(from, goal, options, searches.length);
            return { ...result, path: result.path.map(pos => new Position(pos.x, pos.y, pos.roomName)) };
        } },
        OBSTACLE_OBJECT_TYPES: ['link', 'factory', 'terminal', 'storage'], MOVE: 'move', WORK: 'work', TOP: 1, TOP_RIGHT: 2, RIGHT: 3, BOTTOM_RIGHT: 4,
        BOTTOM: 5, BOTTOM_LEFT: 6, LEFT: 7, TOP_LEFT: 8,
        OK: 0, ERR_NOT_OWNER: -1, ERR_BUSY: -4, ERR_INVALID_TARGET: -7, ERR_NOT_FOUND: -5, ERR_NO_PATH: -2,
        ERR_INVALID_ARGS: -10, ERR_NO_BODYPART: -12, ERR_TIRED: -11,
        FIND_CREEPS: 'creeps', FIND_POWER_CREEPS: 'powerCreeps',
        FIND_STRUCTURES: 'structures', FIND_SOURCES: 'sources', FIND_MINERALS: 'minerals', FIND_DEPOSITS: 'deposits',
        STRUCTURE_INVADER_CORE: 'invaderCore', STRUCTURE_PORTAL: 'portal', STRUCTURE_WALL: 'constructedWall',
        STRUCTURE_ROAD: 'road', STRUCTURE_RAMPART: 'rampart', LOOK_CREEPS: 'creep', LOOK_POWER_CREEPS: 'powerCreep',
    }, modules: { 'settings/settings': { findPathAvoidRooms: [], observersFindPathIdList: [] },
        'runtime/observerScheduling': { scheduleObservation: () => 0 } } });
    loader.load('utils/BetterMove');
    const target = new Position(25, 25, 'E1S0');
    function moveAt(x, roomName = 'E0S0', options = { ignoreSwamps: true, plainCost: 1, swampCost: 1, range: 20 }, destination = target) {
        creep.room = game.rooms[roomName] = room(roomName);
        creep.pos = new Position(x, 25, roomName);
        const result = creep.moveTo(destination, options); game.time++;
        return result;
    }
    return { moves, moveCalls, searches, roomReads, creep, game, loader, Position, room, moveAt, target };
}

const point = (x, roomName = 'E0S0') => ({ x, y: 25, roomName });
const landingPath = () => Array.from({ length: 6 }, (_, x) => point(x, 'E1S0'));

test('real BetterMove replans an exhausted incomplete path at the border instead of moving with an undefined direction', () => {
    const world = movementWorld((from, goal, options, attempt) => attempt === 1
        ? { incomplete: true, path: [point(48), point(49)] }
        : { incomplete: false, path: landingPath() });
    assert.equal(world.moveAt(47), 0);
    assert.equal(world.moveAt(48), 0);
    assert.equal(world.moveAt(49), 0);
    assert.deepEqual(world.moves, [3, 3, 3], 'the border tick sends an actual crossing direction');
    assert.equal(world.searches.length, 2, 'only the exhausted incomplete path is searched again');
    assert.equal(world.searches[1].from.x, 49);
    assert.equal(world.moveAt(0, 'E1S0'), 0);
    assert.equal(world.moves.at(-1), 3, 'the newly visible landing room supplies its missing cached direction');
    assert.equal(world.searches.length, 2);
});

test('complete cached cross-room paths keep one search while handling automatic edge transfer', () => {
    const world = movementWorld(() => ({ incomplete: false, path: [point(48), point(49), ...landingPath()] }));
    assert.equal(world.moveAt(47), 0);
    assert.equal(world.moveAt(48), 0);
    // Screeps transfers a creep reaching an exit to the neighboring room's opposite edge.
    for (let x = 0; x <= 5; x++) assert.equal(world.moveAt(x, 'E1S0'), 0);
    assert.equal(world.searches.length, 1);
    assert.deepEqual(world.moves, Array(7).fill(3));
    assert.equal(world.roomReads.get('E1S0'), 4, 'the landing cost matrix is generated once');
});

test('an incomplete edge endpoint replans after automatic transfer instead of walking back into the old room', () => {
    const world = movementWorld((from, goal, options, attempt) => attempt === 1
        ? { incomplete: true, path: [point(48), point(49)] }
        : { incomplete: false, path: landingPath() });
    assert.equal(world.moveAt(47), 0);
    assert.equal(world.moveAt(48), 0);
    // Reaching exit 49 immediately places the creep at 0 in the next room on the official server.
    assert.equal(world.moveAt(0, 'E1S0'), 0);
    assert.deepEqual(world.moves, [3, 3, 3], 'the landing tick continues east rather than returning west');
    assert.equal(world.searches.length, 2);
    assert.equal(world.searches[1].from.roomName, 'E1S0');
    assert.equal(world.searches[1].from.x, 0);
    assert.equal(world.moveAt(1, 'E1S0'), 0);
    assert.equal(world.moves.at(-1), 3);
    assert.equal(world.searches.length, 2, 'the replacement landing path remains cached');
});

test('an exhausted incomplete path with no continuation returns ERR_NO_PATH without sending an invalid move intent', () => {
    const world = movementWorld((from, goal, options, attempt) => attempt === 1
        ? { incomplete: true, path: [point(48), point(49)] }
        : { incomplete: true, path: [] });
    assert.equal(world.moveAt(47), 0);
    assert.equal(world.moveAt(48), 0);
    assert.equal(world.moveAt(49), -2);
    assert.deepEqual(world.moves, [3, 3]);
    assert.equal(world.searches.length, 2);
});

test('portal range-zero approaches still stop beside the blocked portal and move directly onto it on the next tick', () => {
    const world = movementWorld((from, goal, options) => {
        assert.equal(goal.range, 1, 'the existing BetterMove portal approach range is retained');
        assert.equal(options.roomCallback('E0S0').get(10, 25), 255, 'portal tiles remain blocked during pathfinding');
        return { incomplete: false, path: [point(8), point(9)] };
    });
    const portal = { structureType: 'portal', pos: new world.Position(10, 25, 'E0S0') };
    // The source room has not generated its cost matrix until the first moveTo.
    const portalRoom = { name: 'E0S0', lookForAt: () => [], find: type => type === 'structures' ? [portal] : [] };
    world.game.rooms.E0S0 = portalRoom; world.creep.room = portalRoom;
    world.creep.pos = new world.Position(7, 25, 'E0S0');
    const options = () => ({ ignoreSwamps: true, plainCost: 1, swampCost: 1, range: 0 });
    assert.equal(world.creep.moveTo(portal.pos, options()), 0); world.game.time++;
    world.creep.pos = new world.Position(8, 25, 'E0S0');
    assert.equal(world.creep.moveTo(portal.pos, options()), 0); world.game.time++;
    world.creep.pos = new world.Position(9, 25, 'E0S0');
    assert.equal(world.creep.moveTo(portal.pos, options()), 0);
    assert.deepEqual(world.moves, [3, 3, 3]);
    assert.equal(world.searches.length, 1, 'the final portal intent still uses the adjacent direct move');
});

test('real BetterMove bypasses a dontPullMe manager occupying the cached endpoint beside Storage', () => {
    const points = [[34, 18], [35, 17], [36, 18], [36, 19]].map(([x, y]) => ({ x, y, roomName: 'E0S0' }));
    const world = movementWorld((from, goal, options, attempt) => {
        assert.equal(goal.range, 1);
        if (attempt === 1) return { incomplete: false, path: [{ x: 35, y: 20, roomName: 'E0S0' }] };
        assert.equal(attempt, 2, 'the bypass is searched once and then reused');
        const matrix = options.roomCallback('E0S0');
        assert.equal(matrix.get(35, 20), 255, 'the stationary manager is excluded from the temporary path');
        for (const [x, y] of [[35, 19], [34, 20], [35, 21], [36, 20]]) assert.equal(matrix.get(x, y), 255);
        return { incomplete: false, path: points };
    });
    const structures = [['link', 35, 19], ['factory', 34, 20], ['terminal', 35, 21], ['storage', 36, 20]]
        .map(([structureType, x, y]) => ({ structureType, pos: new world.Position(x, y, 'E0S0') }));
    world.creep.room.find = type => type === 'structures' ? structures : [];
    world.creep.name = 'filler'; world.creep.memory.role = 'filler'; world.creep.pos = new world.Position(34, 19, 'E0S0');
    world.game.creeps = { filler: world.creep };
    const manager = new world.creep.constructor(world.creep.room);
    manager.name = 'manager'; manager.memory = { role: 'manager', dontPullMe: true };
    manager.pos = new world.Position(35, 20, 'E0S0'); world.game.creeps.manager = manager;
    const destination = structures.find(structure => structure.structureType === 'storage');
    assert.equal(world.creep.moveTo(destination, { range: 1 }), 0);
    assert.equal(world.moves.at(-1), 4, 'the initial cached route tries its final diagonal tile');
    // The engine leaves filler at its origin because manager refuses to move.
    world.game.time++;
    assert.equal(world.creep.moveTo(destination, { range: 1 }), 0);
    assert.equal(world.moves.at(-1), 1, 'a blocked last step enters the bypass branch instead of hitting the same global cache');
    assert.equal(world.searches.length, 2);
    for (const [index, point] of points.entries()) {
        world.creep.pos = new world.Position(point.x, point.y, point.roomName); world.game.time++;
        assert.equal(world.creep.moveTo(destination, { range: 1 }), 0);
        if (index < points.length - 1) assert.ok(world.moves.at(-1) >= 1 && world.moves.at(-1) <= 8);
    }
    assert.equal(world.searches.length, 2, 'complete bypass movement does not search every tick');
    assert.equal(world.moves.length, 5, 'the final walkable adjacent tile satisfies range one without entering Storage');
    assert.equal(world.moveCalls.some(call => call.name === 'manager'), false, 'dontPullMe must never receive a forced swap move');
    assert.deepEqual([manager.pos.x, manager.pos.y], [35, 20]);
});
