const assert = require('node:assert/strict');
const test = require('node:test');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

const getters = [
    ['spawnsGetter', 'spawn', 'STRUCTURE_SPAWN', 'IDOF_STRUCTURE_SPAWN'],
    ['extensionsGetter', 'extension', 'STRUCTURE_EXTENSION', 'IDOF_STRUCTURE_EXTENSION'],
    ['towersGetter', 'tower', 'STRUCTURE_TOWER', 'IDOF_STRUCTURE_TOWER'],
    ['containersGetter', 'container', 'STRUCTURE_CONTAINER', 'IDOF_STRUCTURE_CONTAINER'],
    ['linksGetter', 'link', 'STRUCTURE_LINK', 'IDOF_STRUCTURE_LINK'],
    ['labsGetter', 'lab', 'STRUCTURE_LAB', 'IDOF_STRUCTURE_LAB'],
    ['roadsGetter', 'road', 'STRUCTURE_ROAD', 'IDOF_STRUCTURE_ROAD'],
    ['rampartsGetter', 'rampart', 'STRUCTURE_RAMPART', 'IDOF_STRUCTURE_RAMPART'],
    ['factoryGetter', 'factory', 'STRUCTURE_FACTORY', 'IDOF_STRUCTURE_FACTORY', true],
    ['observerGetter', 'observer', 'STRUCTURE_OBSERVER', 'IDOF_STRUCTURE_OBSERVER', true],
    ['powerSpawnGetter', 'powerSpawn', 'STRUCTURE_POWER_SPAWN', 'IDOF_STRUCTURE_POWER_SPAWN', true],
    ['extractorGetter', 'extractor', 'STRUCTURE_EXTRACTOR', 'IDOF_STRUCTURE_EXTRACTOR', true]
];

function structureWorld() {
    let structures = [];
    let finds = 0;
    class Room {
        constructor(name) { this.name = name; }
        get structures() { return this.structuresGetter(); }
        find(type) { assert.equal(type, 'structures'); finds++; return structures; }
    }
    const loader = createSourceLoader({
        globals: {
            Room, FIND_STRUCTURES: 'structures',
            ...Object.fromEntries(getters.map(([, type, constant]) => [constant, type]))
        },
        modules: {
            'settings/structures': { structurePolicy: {} },
            'settings/settings': { STRUCTURE_PRIVATEKEY_PERFIX: '_', STRUCTURE_MEMORYKEY_PERFIX: 'IDOF_', creepWhiteList: [] },
            'settings/creep': { roleAdvEnum: { PROCESSER: 'processer' } },
            'utils/CostMatrix': { generateCostMatrix() {} }, utils: { getDistance() {} }
        }
    });
    loader.globals.W1N1 = { structureIdList: {} };
    const RoomExtension = loader.load('mount/extension/RoomExtension').default;
    return {
        createRoom: () => new RoomExtension('W1N1'),
        setStructures: value => { structures = value; },
        cache: loader.globals.W1N1.structureIdList,
        finds: () => finds
    };
}

test('twelve getter types each called twenty times read structureType only once per structure', () => {
    const world = structureWorld();
    let typeReads = 0;
    const structures = Array.from({ length: 120 }, (_, index) => ({
        id: `structure${index}`, my: index % 3 === 0,
        get structureType() { typeReads++; return getters[index % getters.length][1]; }
    }));
    // Measure the old cached filter/find workload, including early-stop single getters.
    const previous = new Map();
    for (let repeat = 0; repeat < 20; repeat++) {
        for (const [method, type, , , single] of getters) {
            if (previous.has(method)) continue;
            previous.set(method, single
                ? structures.find(structure => structure.structureType === type)
                : structures.filter(structure => structure.structureType === type));
        }
    }
    assert.equal(typeReads, 1002, 'eight full filters and four early-stop finds');
    typeReads = 0;
    world.setStructures(structures);
    const room = world.createRoom();
    const firstResults = new Map();
    for (let repeat = 0; repeat < 20; repeat++) {
        for (const [method, , , memoryKey, single] of getters) {
            const result = room[method]();
            if (repeat === 0) {
                firstResults.set(method, result);
                if (single) {
                    assert.equal(result, previous.get(method));
                    assert.equal(world.cache[memoryKey], result.id);
                } else {
                    assert.deepEqual(Array.from(result), previous.get(method), 'original find order and ownership stay intact');
                    assert.deepEqual(Array.from(world.cache[memoryKey]), previous.get(method).map(structure => structure.id));
                }
            } else assert.equal(result, firstResults.get(method), 'the getter must reuse its private result');
        }
    }
    assert.equal(typeReads, structures.length);
    assert.equal(world.finds(), 1);
    assert.equal(room.factoryGetter().my, false, 'single getters retain the first matching neutral/foreign structure');
});

test('an empty previous Room index cannot hide the next tick first Spawn or retain a destroyed factory', () => {
    const world = structureWorld();
    const factory = { id: 'oldFactory', structureType: 'factory' };
    world.setStructures([factory]);
    const previousRoom = world.createRoom();
    assert.deepEqual(Array.from(previousRoom.spawnsGetter()), []);
    assert.equal(previousRoom.factoryGetter(), factory);
    const spawn = { id: 'firstSpawn', structureType: 'spawn', my: true };
    world.setStructures([spawn]);
    const nextRoom = world.createRoom();
    assert.deepEqual(Array.from(nextRoom.spawnsGetter()), [spawn]);
    assert.equal(nextRoom.factoryGetter(), undefined);
    assert.equal(nextRoom.factoryGetter(), undefined);
    assert.deepEqual(Array.from(world.cache.IDOF_STRUCTURE_SPAWN), ['firstSpawn']);
    assert.equal(world.cache.IDOF_STRUCTURE_FACTORY, undefined);
    assert.equal(world.finds(), 2);
});

test('absent center and controller links are cached within a Room and newly built links are seen next tick', () => {
    let scans = 0, distances = 0;
    class Room { constructor(name) { this.name = name; this.storage = { pos: { x: 10, y: 10 } }; this.controller = { pos: { x: 30, y: 30 } }; }
        get links() { scans++; return links; } }
    let links = Array.from({ length: 6 }, (_, index) => ({ id: `link${index}`, pos: { x: index, y: 45 } }));
    const loader = createSourceLoader({ globals: { Room, Game: { getObjectById: () => null } }, modules: {
        'settings/structures': { structurePolicy: {} },
        'settings/settings': { STRUCTURE_PRIVATEKEY_PERFIX: '_', STRUCTURE_MEMORYKEY_PERFIX: 'IDOF_', creepWhiteList: [] },
        'settings/creep': { roleAdvEnum: { PROCESSER: 'processer' } }, 'utils/CostMatrix': {},
        utils: { getDistance(a, b) { distances++; return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); } },
    } });
    loader.globals.W1N1 = { structureIdList: {} };
    const Extension = loader.load('mount/extension/RoomExtension').default, first = new Extension('W1N1');
    for (let repeat = 0; repeat < 10; repeat++) {
        assert.equal(first.centerLinkGetter(), undefined); assert.equal(first.controllerLinkGetter(), undefined);
    }
    assert.equal(scans, 2); assert.equal(distances, 12, 'the previous truthy guard scanned 20 times and read 120 distances');
    const center = { id: 'new-center', pos: { x: 10, y: 11 } }, controller = { id: 'new-controller', pos: { x: 31, y: 30 } };
    links = [center, controller];
    const next = new Extension('W1N1');
    assert.equal(next.centerLinkGetter(), center); assert.equal(next.controllerLinkGetter(), controller);
    assert.equal(scans, 4);
});
