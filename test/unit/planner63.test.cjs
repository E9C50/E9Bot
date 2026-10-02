const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

const { createWorld, validateBlueprint } = require('../helpers/planner-world.cjs');

test('planner imports without Game or prototype/global installation', () => {
    const loader = createSourceLoader();
    const globalKeys = Object.keys(loader.globals).sort().join(',');
    const arrayKeys = vm.runInContext('Object.getOwnPropertyNames(Array.prototype).join(",")', loader.globals);
    assert.equal(typeof loader.load('planning/planner63').computeRoomBlueprint, 'function');
    assert.equal(Object.keys(loader.globals).sort().join(','), globalKeys);
    assert.equal(vm.runInContext('Object.getOwnPropertyNames(Array.prototype).join(",")', loader.globals), arrayKeys);
    assert.equal(loader.globals.Game, undefined);
    assert.equal(loader.globals.minPlaneCnt, undefined);
});

test('real planner lays out a complete open room and routes all resources', () => {
    const world = createWorld();
    const room = world.roomFor('W1N1');
    validateBlueprint(room, world.planner.computeRoomBlueprint(room));
    assert.equal(world.routes.calls, 4);
    assert.equal(world.routes.incomplete, 0);
});

test('real planner handles irregular walls, passages, and swamp terrain', () => {
    const world = createWorld();
    const grid = new Uint8Array(2500);
    for (let x = 13; x <= 17; x++) {
        for (let y = 8; y <= 37; y++) if (y < 22 || y > 25) grid[x * 50 + y] = 1;
    }
    for (let x = 26; x <= 44; x++) {
        for (let y = 18; y <= 21; y++) if (x < 34 || x > 36) grid[x * 50 + y] = 1;
    }
    for (let x = 27; x <= 40; x++) {
        for (let y = 30; y <= 33; y++) grid[x * 50 + y] = 2;
    }
    const room = world.roomFor('W2N2', grid);
    validateBlueprint(room, world.planner.computeRoomBlueprint(room));
    assert.equal(world.routes.calls, 4);
    assert.equal(world.routes.incomplete, 0);
});

test('the preferred storage coordinate is the manager position next to actual storage', () => {
    const world = createWorld();
    const room = world.roomFor('W3N3');
    const original = world.planner.computeRoomBlueprint(room);
    assert(original);
    const preferred = { x: original.storagePos.x, y: original.storagePos.y };
    const result = world.planner.computeRoomBlueprint(room, { storagePosition: preferred });
    validateBlueprint(room, result);
    assert.equal(result.storagePos.x, preferred.x);
    assert.equal(result.storagePos.y, preferred.y);
});

test('a preferred anchor cannot save storage or terminal on a terrain wall', () => {
    for (const type of ['storage', 'terminal']) {
        const world = createWorld();
        const grid = new Uint8Array(2500);
        const room = world.roomFor(`wall-${type}`, grid);
        const original = world.planner.computeRoomBlueprint(room);
        assert(original);
        const [x, y] = original.structMap[type][0];
        grid[x * 50 + y] = 1;
        assert.equal(world.planner.computeRoomBlueprint(room, {
            storagePosition: { x: original.storagePos.x, y: original.storagePos.y }
        }), undefined, `${type} must not be pinned onto the new wall`);
    }
});

test('a preferred anchor cannot save the fixed core cluster on the room border', () => {
    const world = createWorld();
    const room = world.roomFor('border-core');
    assert.equal(world.planner.computeRoomBlueprint(room, { storagePosition: { x: 1, y: 25 } }), undefined);
});

test('CPU budget failures are identifiable and leave the next planning call usable', () => {
    const world = createWorld();
    const room = world.roomFor('W4N4');
    let used = 0;
    world.cpu.getUsed = () => used += 0.1;
    assert.throws(() => world.planner.computeRoomBlueprint(room, { maximumCpu: 1 }), error => {
        assert(error instanceof world.planner.PlanningBudgetExceeded);
        assert.equal(error.name, 'PlanningBudgetExceeded');
        assert.equal(error.maximumCpu, 1);
        return true;
    });
    assert(used >= 1, 'the algorithm should stop once its work budget is spent');
    world.cpu.getUsed = () => 0;
    validateBlueprint(room, world.planner.computeRoomBlueprint(room, { maximumCpu: 300 }));
});

test('an incomplete resource route rejects the plan and permits a later clean call', () => {
    const world = createWorld();
    const room = world.roomFor('W5N5');
    const completeSearch = world.pathFinder.search;
    world.pathFinder.search = () => ({ path: [], incomplete: true, ops: 0, cost: 0 });
    assert.throws(() => world.planner.computeRoomBlueprint(room), /could not connect a resource route/);
    world.pathFinder.search = completeSearch;
    validateBlueprint(room, world.planner.computeRoomBlueprint(room));
    assert.equal(world.routes.calls, 4);
    assert.equal(world.routes.incomplete, 0);
});

test('missing mineral and invalid options are rejected before running the algorithm', () => {
    const world = createWorld();
    const room = world.roomFor('W6N6');
    const completeFind = room.find;
    room.find = type => type === 'minerals' ? [] : completeFind(type);
    assert.equal(world.planner.computeRoomBlueprint(room), undefined);
    room.find = completeFind;
    for (const options of [
        { minimumPlaneCount: 0 }, { minimumPlaneCount: 2501 },
        { maximumCpu: 0 }, { maximumCpu: Infinity },
        { storagePosition: { x: 25.5, y: 25 } }
    ]) assert.equal(world.planner.computeRoomBlueprint(room, options), undefined);
    assert.equal(world.routes.calls, 0);
});
