const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function constructionWorld() {
    let sites = [];
    let structures = [];
    const calls = [];
    class Room {
        constructor(name) { this.name = name; }
        get structures() { return this.structuresGetter(); }
        find(type) {
            calls.push(type);
            if (type === 'structures') return structures;
            assert.equal(type, 'my-sites');
            return sites.filter(site => site.my);
        }
    }
    const loader = createSourceLoader({
        globals: {
            Room, FIND_MY_CONSTRUCTION_SITES: 'my-sites', FIND_STRUCTURES: 'structures',
            STRUCTURE_SPAWN: 'spawn', STRUCTURE_LAB: 'lab', STRUCTURE_FACTORY: 'factory',
            Game: { getObjectById() { throw new Error('construction sites must not reuse previous tick IDs'); } },
        },
        modules: {
            'settings/settings': { STRUCTURE_PRIVATEKEY_PERFIX: '_', STRUCTURE_MEMORYKEY_PERFIX: 'IDOF_', creepWhiteList: [] },
            'settings/creep': { roleAdvEnum: {} },
            'utils/CostMatrix': { generateCostMatrix() {} },
            utils: { getDistance() {} },
        },
    });
    loader.globals.W1N1 = { structureIdList: {} };
    const RoomExtension = loader.load('mount/extension/RoomExtension').default;
    return {
        createRoom: () => new RoomExtension('W1N1'),
        setSites: value => { sites = value; },
        setStructures: value => { structures = value; },
        cache: loader.globals.W1N1.structureIdList,
        calls,
    };
}

test('construction getter returns its initial find and reuses that array within one Room object', () => {
    const world = constructionWorld();
    const site = { id: 'new-spawn', my: true };
    world.setSites([site]);
    const room = world.createRoom();
    const first = room.constructionSitesGetter();
    assert.deepEqual(Array.from(first), [site]);
    assert.equal(room.constructionSitesGetter(), first);
    assert.deepEqual(world.calls, ['my-sites']);
    assert.deepEqual(Array.from(world.cache.IDOF_CONSTRUCTION_SITE), ['new-spawn']);
});

test('an empty previous tick cache does not hide newly created construction sites', () => {
    const world = constructionWorld();
    assert.deepEqual(Array.from(world.createRoom().constructionSitesGetter()), []);
    assert.deepEqual(Array.from(world.cache.IDOF_CONSTRUCTION_SITE), []);
    const site = { id: 'new-container', my: true };
    world.setSites([site]);
    assert.deepEqual(Array.from(world.createRoom().constructionSitesGetter()), [site]);
    assert.deepEqual(Array.from(world.cache.IDOF_CONSTRUCTION_SITE), ['new-container']);
    assert.deepEqual(world.calls, ['my-sites', 'my-sites']);
});

test('a completed construction site disappears on the following tick and updates cached IDs', () => {
    const world = constructionWorld();
    const completed = { id: 'completed-spawn', my: true };
    const pending = { id: 'pending-container', my: true };
    world.setSites([completed, pending]);
    assert.equal(world.createRoom().constructionSitesGetter().length, 2);
    world.setSites([pending]);
    assert.deepEqual(Array.from(world.createRoom().constructionSitesGetter()), [pending]);
    assert.deepEqual(Array.from(world.cache.IDOF_CONSTRUCTION_SITE), ['pending-container']);
});

test('foreign construction sites are excluded even if their IDs were in the old global cache', () => {
    const world = constructionWorld();
    const own = { id: 'mine', my: true };
    const foreign = { id: 'theirs', my: false };
    world.cache.IDOF_CONSTRUCTION_SITE = ['theirs'];
    world.setSites([foreign, own]);
    assert.deepEqual(Array.from(world.createRoom().constructionSitesGetter()), [own]);
    assert.deepEqual(Array.from(world.cache.IDOF_CONSTRUCTION_SITE), ['mine']);
});

test('the first finished Spawn and Lab are discovered after an empty previous tick structure cache', () => {
    const world = constructionWorld();
    const previousRoom = world.createRoom();
    assert.deepEqual(Array.from(previousRoom.spawnsGetter()), []);
    assert.deepEqual(Array.from(previousRoom.labsGetter()), []);
    assert.deepEqual(Array.from(world.cache.IDOF_STRUCTURE_SPAWN), []);
    const spawn = { id: 'first-spawn', structureType: 'spawn' };
    const lab = { id: 'first-lab', structureType: 'lab' };
    world.setStructures([spawn, lab]);
    const currentRoom = world.createRoom();
    const spawns = currentRoom.spawnsGetter();
    assert.deepEqual(Array.from(spawns), [spawn]);
    assert.equal(currentRoom.spawnsGetter(), spawns);
    assert.deepEqual(Array.from(currentRoom.labsGetter()), [lab]);
    assert.deepEqual(Array.from(world.cache.IDOF_STRUCTURE_SPAWN), ['first-spawn']);
    assert.deepEqual(world.calls, ['structures', 'structures'], 'all structure types share one find per Room object');
});

test('destroyed multiple and single structures vanish on the next tick without trusting their old IDs', () => {
    const world = constructionWorld();
    const spawn = { id: 'destroyed-spawn', structureType: 'spawn' };
    const factory = { id: 'destroyed-factory', structureType: 'factory' };
    world.setStructures([spawn, factory]);
    const previousRoom = world.createRoom();
    assert.equal(previousRoom.spawnsGetter()[0], spawn);
    assert.equal(previousRoom.factoryGetter(), factory);
    world.setStructures([]);
    const currentRoom = world.createRoom();
    assert.deepEqual(Array.from(currentRoom.spawnsGetter()), []);
    assert.equal(currentRoom.factoryGetter(), undefined);
    assert.equal(currentRoom.factoryGetter(), undefined);
    assert.equal(world.cache.IDOF_STRUCTURE_FACTORY, undefined);
    assert.deepEqual(Array.from(world.cache.IDOF_STRUCTURE_SPAWN), []);
    assert.deepEqual(world.calls, ['structures', 'structures']);
});

test('a previously absent single structure is discovered when it is built on a later tick', () => {
    const world = constructionWorld();
    const previousRoom = world.createRoom();
    assert.equal(previousRoom.factoryGetter(), undefined);
    const factory = { id: 'new-factory', structureType: 'factory' };
    world.setStructures([factory]);
    const currentRoom = world.createRoom();
    assert.equal(currentRoom.factoryGetter(), factory);
    assert.equal(currentRoom.factoryGetter(), factory);
    assert.equal(world.cache.IDOF_STRUCTURE_FACTORY, 'new-factory');
    assert.deepEqual(world.calls, ['structures', 'structures']);
});
