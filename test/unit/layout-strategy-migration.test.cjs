const assert = require('node:assert/strict');
const test = require('node:test');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const { PLANNING_STRATEGY_VERSION } = createSourceLoader().load('planning/types');

const clone = value => JSON.parse(JSON.stringify(value));
const options = { maximumCpu: 100, minimumPlaneCount: 140 };

function createMigrationWorld({ level = 2, perimeter, planner, planned, towers, towerPolicy } = {}) {
    const events = [], structures = [], sites = [], cpu = { used: 100 };
    const baselinePerimeter = { ramparts: [[10, 47], [11, 47]], outside: new Uint8Array(2500), exitCount: 5, exitSides: 1 };
    for (let x = 0; x < 50; x++) baselinePerimeter.outside[48 * 50 + x] = 1;
    const policy = { exitDefense: { enabled: true, maximumExitTiles: 32, maximumRamparts: 80,
        towers: { enabled: Boolean(towers), minimumEnemyRange: 4, ...towerPolicy } } };
    class RoomPosition {
        constructor(x, y, roomName) { this.x = x; this.y = y; this.roomName = roomName; }
    }
    const position = (x, y) => new RoomPosition(x, y, 'W1N1');
    const room = {
        name: 'W1N1', memory: { roomPosition: {} },
        controller: { my: true, level, pos: position(30, 15) },
        sources: [{ pos: position(5, 15) }, { pos: position(40, 15) }], mineral: { pos: position(15, 40) },
        getTerrain: () => ({ get: () => 0 }),
        find(type) {
            if (type === 'structures') return structures;
            if (type === 'sites') return sites.filter(site => site.my);
            if (type === 'sources') return this.sources;
            if (type === 'minerals') return [this.mineral];
            throw new Error(`Unexpected find: ${type}`);
        }
    };
    const before = { schemaVersion: 1, origin: 'planner63', createdAt: 1, center: [23, 23],
        structures: { spawn: [[24, 24]], extension: [[25, 24]], road: [[40, 48]], rampart: [[25, 25]] } };
    const next = { schemaVersion: 1, origin: 'planner63', createdAt: 99, center: [16, 25],
        exitDefense: { exitCount: 5, exitSides: 1 },
        structures: { spawn: [[15, 25]], extension: [[16, 26]], road: [[16, 24]], rampart: [[10, 47], [11, 47]] } };
    const result = { roomName: room.name, storagePos: { x: 16, y: 25 }, labPos: { x: 17, y: 25 }, structMap: next.structures };
    const world = { events, structures, sites, cpu, room, before, next, result, perimeter: baselinePerimeter, policy,
        plannerCalls: [], plannedCalls: [], towerCalls: [], position };
    const loader = createSourceLoader({
        globals: {
            Game: { time: 99, cpu: { getUsed: () => cpu.used } }, RoomPosition, OK: 0,
            FIND_STRUCTURES: 'structures', FIND_MY_CONSTRUCTION_SITES: 'sites', FIND_SOURCES: 'sources', FIND_MINERALS: 'minerals',
            CONTROLLER_STRUCTURES: { tower: { 8: 6 } }
        },
        modules: {
            'settings/construction': { constructionPolicy: policy },
            './exitPerimeter': { computeExitPerimeter(terrain, actualPolicy, checkBudget) {
                events.push('perimeter'); assert.equal(actualPolicy, policy.exitDefense); checkBudget();
                return perimeter ? perimeter(world, checkBudget) : baselinePerimeter;
            } },
            './exitTowers': { planExitTowers(terrain, perimeter, occupants, resources, options, checkBudget) {
                events.push('towers'); world.towerCalls.push({ terrain, perimeter, occupants, resources, options });
                checkBudget(); return towers ? towers(world, checkBudget) : undefined;
            } },
            './planner63': { computeRoomBlueprint(actualRoom, actualOptions) {
                events.push('planner'); world.plannerCalls.push({ room: actualRoom, options: actualOptions });
                return planner ? planner(world, actualOptions) : result;
            } },
            './blueprint': { plannedRoomBlueprint(actualRoom, actualResult, actualOptions) {
                events.push('validation'); world.plannedCalls.push({ room: actualRoom, result: actualResult, options: actualOptions });
                return planned ? planned(world, actualOptions) : clone(next);
            } }
        }
    });
    world.api = loader.load('planning/layoutStrategyMigration');
    world.BudgetError = loader.load('planning/vendor/PlanningBudgetExceeded').PlanningBudgetExceeded;
    world.run = () => world.api.migrateLayoutStrategy(room, before, options);
    world.site = (type, x, y, progress = 0, returnCode = 0) => {
        const site = { id: `site:${sites.length}`, structureType: type, my: true, pos: position(x, y), progress,
            remove() { events.push(`remove:${site.id}`); return returnCode; } };
        sites.push(site); return site;
    };
    world.structure = (type, x, y, my = true) => {
        const item = { id: `structure:${structures.length}`, structureType: type, pos: position(x, y),
            destroy() { throw new Error('A migration must never destroy a built structure'); } };
        if (my !== undefined) item.my = my;
        structures.push(item); return item;
    };
    return world;
}

function removals(world) { return world.events.filter(event => event.startsWith('remove:')); }

test('an unbuilt early room validates its complete replacement before removing obsolete zero-progress sites', () => {
    const world = createMigrationWorld();
    const oldSpawn = world.site('spawn', 24, 24), kept = world.site('spawn', 15, 25), road = world.site('road', 40, 48);
    world.before.structures.spawn.push([15, 25]);
    world.structure('spawn', 40, 40, false);
    world.structure('controller', 30, 15);
    const automatic = world.position(23, 23), manual = world.position(7, 9);
    world.room.memory.roomPosition = { centerPos: automatic, managerPos: manual };
    const original = clone(world.before);
    const migrated = world.run();
    assert.equal(migrated.deferConstruction, true, 'removal intents must settle before construction resumes');
    assert.deepEqual(clone(migrated.blueprint.structures), world.next.structures);
    assert.equal(migrated.blueprint.planningStrategyVersion, PLANNING_STRATEGY_VERSION);
    assert.deepEqual(clone(migrated.blueprint.exitDefense), { exitCount: 5, exitSides: 1 });
    assert.deepEqual(world.before, original, 'the old blueprint is not mutated during validation');
    assert.deepEqual(Array.from(world.plannedCalls[0].options.excludedConstructionSites).sort(), [oldSpawn.id, kept.id, road.id].sort());
    assert.deepEqual(removals(world), [`remove:${oldSpawn.id}`, `remove:${road.id}`]);
    assert.ok(world.events.indexOf('validation') < world.events.indexOf(`remove:${oldSpawn.id}`));
    assert.deepEqual([world.room.memory.roomPosition.centerPos.x, world.room.memory.roomPosition.centerPos.y], [16, 25]);
    assert.equal(world.room.memory.roomPosition.managerPos, manual);
    assert.equal(world.room.memory.needUpdateCache, true);
});

test('automatic manager and center positions move together while missing or manually distinct values remain intact', () => {
    const world = createMigrationWorld();
    world.room.memory.roomPosition = { centerPos: world.position(23, 23), managerPos: world.position(23, 23) };
    world.run();
    for (const field of ['centerPos', 'managerPos']) assert.deepEqual(
        [world.room.memory.roomPosition[field].x, world.room.memory.roomPosition[field].y], [16, 25]);
    const empty = createMigrationWorld(); empty.run();
    assert.deepEqual(empty.room.memory.roomPosition, {});
    const differentRoom = createMigrationWorld();
    const manual = { x: 23, y: 23, roomName: 'W2N2' }; differentRoom.room.memory.roomPosition.managerPos = manual;
    differentRoom.run(); assert.equal(differentRoom.room.memory.roomPosition.managerPos, manual);
});

test('a complete replacement retains the final planner defense metadata when it falls back to an internal perimeter', () => {
    const world = createMigrationWorld({ planned(world) {
        const replacement = clone(world.next);
        replacement.structures.rampart = [[20, 20], [21, 20]];
        delete replacement.exitDefense;
        return replacement;
    } });
    const migrated = world.run();
    assert.deepEqual(clone(migrated.blueprint.structures.rampart), [[20, 20], [21, 20]]);
    assert.equal(migrated.blueprint.exitDefense, undefined, 'an internal perimeter must not be labeled as exit defense');
    assert.equal(migrated.blueprint.planningStrategyVersion, PLANNING_STRATEGY_VERSION);
});

test('built own and neutral structures preserve the core and allow only perimeter migration', () => {
    for (const [type, my] of [['spawn', true], ['road', undefined], ['container', undefined]]) {
        const world = createMigrationWorld(); world.structure(type, 20, 20, my);
        const migrated = world.run();
        assert.deepEqual(world.plannerCalls, [], `${type} must not permit whole-room relocation`);
        assert.deepEqual(clone(migrated.blueprint.structures.spawn), world.before.structures.spawn);
        assert.deepEqual(clone(migrated.blueprint.center), world.before.center);
        assert.deepEqual(clone(migrated.blueprint.structures.rampart), world.perimeter.ramparts);
        assert.equal(migrated.deferConstruction, false);
    }
});

test('invested sites and built Ramparts remain protected while obsolete unstarted Rampart sites are removed', () => {
    const world = createMigrationWorld();
    const investedSpawn = world.site('spawn', 24, 24, 1);
    const oldRampart = world.site('rampart', 25, 25);
    const investedRampart = world.site('rampart', 26, 25, 50);
    const currentRampart = world.site('rampart', 10, 47);
    world.structure('rampart', 27, 25);
    world.structure('rampart', 28, 25, false);
    const before = clone(world.before), migrated = world.run();
    assert.deepEqual(world.plannerCalls, []);
    assert.deepEqual(clone(migrated.blueprint.structures.rampart).sort(), [[10, 47], [11, 47], [26, 25], [27, 25]].sort());
    assert.deepEqual(removals(world), [`remove:${oldRampart.id}`]);
    assert.ok(!removals(world).includes(`remove:${investedSpawn.id}`));
    assert.ok(!removals(world).includes(`remove:${investedRampart.id}`));
    assert.ok(!removals(world).includes(`remove:${currentRampart.id}`));
    assert.deepEqual(world.before, before);
    assert.equal(migrated.deferConstruction, true);
});

test('RCL4 and later rooms receive only perimeter changes even before their first building', () => {
    for (const level of [4, 7]) {
        const world = createMigrationWorld({ level });
        const oldSpawn = world.site('spawn', 24, 24);
        const migrated = world.run();
        assert.deepEqual(world.plannerCalls, []);
        assert.deepEqual(clone(migrated.blueprint.structures.spawn), world.before.structures.spawn);
        assert.ok(!removals(world).includes(`remove:${oldSpawn.id}`));
        assert.equal(migrated.blueprint.planningStrategyVersion, PLANNING_STRATEGY_VERSION);
    }
});

test('resources outside or on the frontier retain the original layout and mark its checked strategy', () => {
    for (const kind of ['source', 'mineral', 'controller', 'frontier']) {
        const world = createMigrationWorld(); world.site('spawn', 24, 24);
        if (kind === 'source') world.room.sources[0].pos = world.position(5, 48);
        if (kind === 'mineral') world.room.mineral.pos = world.position(5, 48);
        if (kind === 'controller') world.room.controller.pos = world.position(5, 48);
        if (kind === 'frontier') world.room.sources[0].pos = world.position(10, 47);
        const migrated = world.run();
        assert.deepEqual(clone(migrated.blueprint.structures), world.before.structures);
        assert.equal(migrated.blueprint.planningStrategyVersion, PLANNING_STRATEGY_VERSION);
        assert.equal(migrated.blueprint.exitDefense, undefined);
        assert.equal(migrated.deferConstruction, false);
        assert.deepEqual(world.plannerCalls, []);
        assert.deepEqual(removals(world), []);
    }
});

test('non-road core positions outside retain their layout, while old road and defensive positions do not block migration', () => {
    const unsafe = createMigrationWorld(); unsafe.before.structures.spawn = [[24, 48]];
    const retained = unsafe.run();
    assert.deepEqual(clone(retained.blueprint.structures), unsafe.before.structures);
    assert.equal(retained.blueprint.planningStrategyVersion, PLANNING_STRATEGY_VERSION);
    assert.deepEqual(unsafe.plannerCalls, []);
    const safe = createMigrationWorld();
    safe.before.structures.rampart = [[25, 48]]; safe.before.structures.constructedWall = [[26, 48]];
    assert.ok(safe.run()); assert.equal(safe.plannerCalls.length, 1);
});

test('rooms without a qualifying exit perimeter retain their blueprint and do not invoke a planner', () => {
    const world = createMigrationWorld({ perimeter: () => undefined }); world.site('spawn', 24, 24);
    const migrated = world.run();
    assert.deepEqual(clone(migrated.blueprint.structures), world.before.structures);
    assert.equal(migrated.blueprint.planningStrategyVersion, PLANNING_STRATEGY_VERSION);
    assert.equal(migrated.deferConstruction, false);
    assert.deepEqual(world.plannerCalls, []);
    assert.deepEqual(removals(world), []);
});

test('planning or blueprint validation failure leaves the complete old blueprint, metadata and sites untouched', () => {
    for (const failure of ['planner', 'validation']) {
        const world = createMigrationWorld(failure === 'planner' ? { planner: () => undefined } : { planned: () => undefined });
        world.site('spawn', 24, 24); world.room.memory.roomPosition.managerPos = world.position(23, 23);
        const before = clone(world.before), memory = clone(world.room.memory);
        assert.equal(world.run(), undefined);
        assert.deepEqual(world.before, before);
        assert.deepEqual(clone(world.room.memory), memory);
        assert.deepEqual(removals(world), []);
    }
});

test('the complete operation shares one CPU budget and gives the planner only the remaining amount', () => {
    const world = createMigrationWorld({ perimeter(world, checkBudget) { world.cpu.used += 17; checkBudget(); return world.perimeter; } });
    world.run();
    assert.equal(world.plannerCalls[0].options.maximumCpu, 83);
    assert.equal(world.plannerCalls[0].options.minimumPlaneCount, 140);
});

test('CPU failures in exit analysis, planning or validation occur before any removal or metadata change', () => {
    for (const stage of ['perimeter', 'planner', 'validation']) {
        const cost = world => { world.cpu.used += 101; };
        const setup = stage === 'perimeter' ? { perimeter(world, checkBudget) { cost(world); checkBudget(); return world.perimeter; } }
            : stage === 'planner' ? { planner(world) { cost(world); return world.result; } }
                : { planned(world) { cost(world); return clone(world.next); } };
        const world = createMigrationWorld(setup); world.site('spawn', 24, 24);
        const before = clone(world.before);
        assert.throws(() => world.run(), error => error instanceof world.BudgetError && error.maximumCpu === 100);
        assert.deepEqual(world.before, before);
        assert.deepEqual(removals(world), []);
        assert.equal(world.room.memory.needUpdateCache, undefined);
    }
});

test('vendor remaining-budget errors are reported against the original whole-operation allowance', () => {
    const world = createMigrationWorld({
        perimeter(world, checkBudget) { world.cpu.used += 17; checkBudget(); return world.perimeter; },
        planner(world, actualOptions) { throw new world.BudgetError(actualOptions.maximumCpu); }
    });
    world.site('spawn', 24, 24);
    assert.throws(() => world.run(), error => error instanceof world.BudgetError && error.maximumCpu === 100);
    assert.equal(world.plannerCalls[0].options.maximumCpu, 83);
    assert.deepEqual(removals(world), []);
});

test('a native removal failure keeps the old plan and stops subsequent removals', () => {
    const world = createMigrationWorld();
    const failed = world.site('spawn', 24, 24, 0, -7); world.site('extension', 25, 24);
    const automatic = world.position(23, 23); world.room.memory.roomPosition.managerPos = automatic;
    const migrated = world.run();
    assert.equal(migrated.blueprint, world.before);
    assert.equal(migrated.deferConstruction, true);
    assert.equal(world.before.planningStrategyVersion, undefined, 'a failed migration remains eligible for retry');
    assert.equal(world.room.memory.roomPosition.managerPos, automatic);
    assert.deepEqual(removals(world), [`remove:${failed.id}`]);
});

test('a partial native removal failure defers rebuilding and refreshes caches while keeping the old plan', () => {
    const world = createMigrationWorld();
    const removed = world.site('spawn', 24, 24), failed = world.site('extension', 25, 24, 0, -7);
    const migrated = world.run();
    assert.equal(migrated.blueprint, world.before);
    assert.equal(migrated.deferConstruction, true);
    assert.equal(world.before.planningStrategyVersion, undefined);
    assert.equal(world.room.memory.needUpdateCache, true);
    assert.deepEqual(removals(world), [`remove:${removed.id}`, `remove:${failed.id}`]);
});

test('a failed Rampart-only removal also preserves the old defensive blueprint', () => {
    const world = createMigrationWorld({ level: 4 }); world.site('rampart', 25, 25, 0, -7);
    const migrated = world.run();
    assert.equal(migrated.blueprint, world.before);
    assert.equal(migrated.deferConstruction, true);
    assert.deepEqual(world.plannerCalls, []);
});

test('a full migration defers construction even when every zero-progress site already belongs to its new plan', () => {
    const world = createMigrationWorld(); world.site('spawn', 15, 25);
    world.before.structures.spawn.push([15, 25]);
    const migrated = world.run();
    assert.equal(migrated.deferConstruction, true);
    assert.equal(migrated.blueprint.planningStrategyVersion, PLANNING_STRATEGY_VERSION);
    assert.deepEqual(removals(world), []);
});

test('an unknown manually added zero-progress site prevents whole-room relocation', () => {
    const world = createMigrationWorld();
    const known = world.site('spawn', 24, 24), manual = world.site('extension', 18, 18);
    const migrated = world.run();
    assert.deepEqual(world.plannerCalls, [], 'an unrecognized site is evidence of a later manual layout choice');
    assert.deepEqual(clone(migrated.blueprint.structures.spawn), world.before.structures.spawn);
    assert.deepEqual(clone(migrated.blueprint.center), world.before.center);
    assert.deepEqual(clone(migrated.blueprint.structures.rampart), world.perimeter.ramparts);
    assert.equal(migrated.deferConstruction, false);
    assert.ok(!removals(world).includes(`remove:${known.id}`));
    assert.ok(!removals(world).includes(`remove:${manual.id}`));
});

test('an unknown manual zero-progress Rampart is retained while a recorded obsolete Rampart is canceled', () => {
    const world = createMigrationWorld();
    const obsolete = world.site('rampart', 25, 25), manual = world.site('rampart', 28, 25);
    const migrated = world.run();
    assert.deepEqual(world.plannerCalls, [], 'an unknown Rampart site also blocks complete relocation');
    assert.deepEqual(clone(migrated.blueprint.structures.rampart), [[10, 47], [11, 47], [28, 25]]);
    assert.deepEqual(removals(world), [`remove:${obsolete.id}`]);
    assert.ok(!removals(world).includes(`remove:${manual.id}`));
    assert.equal(migrated.deferConstruction, true);
});

function upgradedTowers(world) {
    return { towers: [[7, 44], [12, 44], [17, 44], [22, 44], [27, 44], [32, 44]],
        roads: [...world.before.structures.road.map(position => [...position]), [12, 43], [17, 43]] };
}

test('an existing exit-defense strategy upgrades Tower positions without reselecting an unbuilt base', () => {
    const world = createMigrationWorld({ towers: upgradedTowers });
    world.before.planningStrategyVersion = 1;
    world.before.structures.tower = [[20, 20], [21, 20]];
    const spawn = world.site('spawn', 24, 24), extension = world.site('extension', 25, 24);
    const obsolete = world.site('tower', 20, 20), obsoleteTwo = world.site('tower', 21, 20);
    world.room.memory.roomPosition = { centerPos: world.position(23, 23), managerPos: world.position(23, 23) };
    const before = clone(world.before), memoryPositions = clone(world.room.memory.roomPosition);
    const migrated = world.run();
    assert.equal(world.plannerCalls.length, 0, 'a policy upgrade must not relocate the already selected base');
    assert.deepEqual(clone(migrated.blueprint.structures.tower), upgradedTowers(world).towers);
    assert.deepEqual(clone(migrated.blueprint.structures.road), upgradedTowers(world).roads);
    assert.deepEqual(clone(migrated.blueprint.structures.spawn), before.structures.spawn);
    assert.deepEqual(clone(migrated.blueprint.structures.extension), before.structures.extension);
    assert.deepEqual(clone(migrated.blueprint.center), before.center);
    assert.deepEqual(world.before, before);
    assert.deepEqual(clone(world.room.memory.roomPosition), memoryPositions);
    assert.deepEqual(removals(world), [`remove:${obsolete.id}`, `remove:${obsoleteTwo.id}`]);
    assert.ok(!removals(world).includes(`remove:${spawn.id}`));
    assert.ok(!removals(world).includes(`remove:${extension.id}`));
    assert.ok(world.events.indexOf('towers') < world.events.indexOf(`remove:${obsolete.id}`));
    assert.equal(migrated.blueprint.planningStrategyVersion, PLANNING_STRATEGY_VERSION);
    assert.equal(migrated.deferConstruction, true);
    assert.equal(world.towerCalls[0].options.minimumEnemyRange, 4);
    assert.equal(world.towerCalls[0].options.towerCount, 6);
    assert.deepEqual(clone(world.towerCalls[0].resources), [[5, 15], [40, 15], [15, 40], [30, 15]]);
});

test('built, invested and unknown manual Tower sites remain fixed during a Tower policy upgrade', () => {
    const world = createMigrationWorld({ towers(world) {
        return { towers: [...world.towerCalls[0].options.fixedTowers, [7, 44], [12, 44]],
            roads: world.towerCalls[0].occupants.road };
    } });
    world.before.planningStrategyVersion = 1;
    world.before.structures.tower = [[20, 20], [22, 22], [33, 33], [25, 25]];
    const obsolete = world.site('tower', 20, 20);
    const invested = world.site('tower', 22, 22, 1), manual = world.site('tower', 11, 11);
    const unknownProgress = world.site('tower', 25, 25); delete unknownProgress.progress;
    world.structure('tower', 33, 33); world.site('tower', 33, 33, 1);
    const migrated = world.run();
    assert.deepEqual(clone(world.towerCalls[0].options.fixedTowers).sort(), [[33, 33], [22, 22], [11, 11], [25, 25]].sort());
    for (const position of [[33, 33], [22, 22], [11, 11], [25, 25]])
        assert.ok(migrated.blueprint.structures.tower.some(actual => actual[0] === position[0] && actual[1] === position[1]));
    assert.deepEqual(removals(world), [`remove:${obsolete.id}`]);
    for (const site of [invested, manual, unknownProgress]) assert.ok(!removals(world).includes(`remove:${site.id}`));
});

test('Tower optimization accounts for later real buildings and sites without changing non-Tower blueprint positions', () => {
    const world = createMigrationWorld({ towers: upgradedTowers });
    world.before.planningStrategyVersion = 1;
    world.before.structures.container = [[6, 15]];
    world.structure('extension', 9, 9); world.structure('container', 7, 8, undefined);
    world.structure('tower', 8, 8, false);
    const manualSpawn = world.site('spawn', 10, 10), manualRoad = world.site('road', 8, 9);
    const before = clone(world.before), migrated = world.run();
    const occupants = clone(world.towerCalls[0].occupants);
    assert.ok(occupants.extension.some(([x, y]) => x === 9 && y === 9));
    assert.ok(occupants.container.some(([x, y]) => x === 7 && y === 8));
    assert.ok(occupants.spawn.some(([x, y]) => x === 10 && y === 10));
    assert.ok(occupants.road.some(([x, y]) => x === 8 && y === 9));
    assert.ok(occupants.constructedWall.some(([x, y]) => x === 8 && y === 8), 'a hostile Tower remnant blocks candidate positions');
    for (const type of ['spawn', 'extension', 'container'])
        assert.deepEqual(clone(migrated.blueprint.structures[type]), before.structures[type]);
    assert.deepEqual(world.before, before);
    assert.ok(!removals(world).includes(`remove:${manualSpawn.id}`));
    assert.ok(!removals(world).includes(`remove:${manualRoad.id}`));
});

test('an unavailable safe Tower arrangement retains existing Towers while migrating the perimeter', () => {
    const world = createMigrationWorld({ towers: () => undefined });
    world.before.planningStrategyVersion = 1;
    world.before.structures.tower = [[20, 20], [21, 20]];
    const tower = world.site('tower', 20, 20), rampart = world.site('rampart', 25, 25);
    const before = clone(world.before), migrated = world.run();
    assert.deepEqual(clone(migrated.blueprint.structures.tower), before.structures.tower);
    assert.deepEqual(clone(migrated.blueprint.structures.road), before.structures.road);
    assert.deepEqual(clone(migrated.blueprint.structures.rampart), world.perimeter.ramparts);
    assert.equal(migrated.blueprint.planningStrategyVersion, PLANNING_STRATEGY_VERSION);
    assert.deepEqual(removals(world), [`remove:${rampart.id}`]);
    assert.ok(!removals(world).includes(`remove:${tower.id}`));
});

test('a disabled Tower policy keeps positions and skips optimization during strategy migration', () => {
    const world = createMigrationWorld({ towers: upgradedTowers, towerPolicy: { enabled: false } });
    world.before.planningStrategyVersion = 1; world.before.structures.tower = [[20, 20]];
    world.site('tower', 20, 20);
    const migrated = world.run();
    assert.deepEqual(world.towerCalls, []);
    assert.deepEqual(clone(migrated.blueprint.structures.tower), world.before.structures.tower);
    assert.equal(migrated.blueprint.planningStrategyVersion, PLANNING_STRATEGY_VERSION);
    assert.deepEqual(removals(world), []);
});

test('Tower CPU exhaustion occurs before any cancellation or persisted metadata change', () => {
    const world = createMigrationWorld({ towers(world, checkBudget) {
        world.cpu.used += 101; checkBudget(); return upgradedTowers(world);
    } });
    world.before.planningStrategyVersion = 1; world.before.structures.tower = [[20, 20]];
    world.site('tower', 20, 20); world.site('rampart', 25, 25);
    const before = clone(world.before), memory = clone(world.room.memory);
    assert.throws(() => world.run(), error => error instanceof world.BudgetError && error.maximumCpu === 100);
    assert.deepEqual(removals(world), []);
    assert.deepEqual(world.before, before);
    assert.deepEqual(clone(world.room.memory), memory);
});

test('a failed Tower cancellation keeps the old strategy eligible for retry and stops later cancellations', () => {
    const world = createMigrationWorld({ towers: upgradedTowers });
    world.before.planningStrategyVersion = 1;
    world.before.structures.rampart = clone(world.perimeter.ramparts);
    world.before.structures.tower = [[20, 20], [21, 20]];
    const failed = world.site('tower', 20, 20, 0, -7); world.site('tower', 21, 20);
    const migrated = world.run();
    assert.equal(migrated.blueprint, world.before);
    assert.equal(migrated.blueprint.planningStrategyVersion, 1);
    assert.equal(migrated.deferConstruction, true);
    assert.deepEqual(removals(world), [`remove:${failed.id}`]);
});

test('a zero-progress Tower already used by the upgraded defense keeps its construction site', () => {
    const world = createMigrationWorld({ towers: upgradedTowers });
    world.before.planningStrategyVersion = 1; world.before.structures.tower = [[7, 44]];
    world.site('tower', 7, 44);
    const migrated = world.run();
    assert.deepEqual(removals(world), []);
    assert.equal(migrated.deferConstruction, false);
    assert.ok(migrated.blueprint.structures.tower.some(([x, y]) => x === 7 && y === 44));
});
