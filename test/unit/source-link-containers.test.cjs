const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world({ active = true, my = true, walls = [] } = {}) {
    const calls = [], game = { time: 1, constructionSites: {} }, wall = new Set(walls.map(p => p.join(',')));
    const pos = (x, y) => ({ x, y, roomName: 'E1N1' });
    const item = (type, x, y) => ({ id: `${type}:${x}:${y}`, structureType: type, pos: pos(x, y),
        destroy() { calls.push(['destroy', type, x, y]); return 0; } });
    const source = { id: 'mine', pos: pos(10, 10) }, link = { ...item('link', 12, 10), my, isActive: () => active };
    const container = item('container', 11, 10), other = item('container', 20, 20), mineral = item('container', 30, 31);
    const site = { ...item('container', 9, 10), progressTotal: 500, my: true,
        remove() { calls.push(['remove', 'container', 9, 10]); return 0; } };
    const room = { name: 'E1N1', controller: { my: true, level: 8, pos: pos(20, 17) },
        memory: { roomBlueprint: { origin: 'snapshot', structures: { container: [[11, 10], [9, 10], [20, 20], [30, 31]] } } },
        structures: [link, container, other, mineral], sources: [source], mineral: { pos: pos(30, 30) }, constructionSites: [site],
        getTerrain: () => ({ get: (x, y) => wall.has(`${x},${y}`) ? 1 : 0 }),
        find(type) { return type === 'structures' ? this.structures : type === 'sites' ? this.constructionSites : type === 'sources' ? this.sources : []; },
        createConstructionSite(x, y, type) { calls.push(['create', type, x, y]); return 0; } };
    const globals = { Game: game, OK: 0, ERR_FULL: -8, TERRAIN_MASK_WALL: 1, STRUCTURE_CONTAINER: 'container',
        STRUCTURE_LINK: 'link', STRUCTURE_ROAD: 'road', STRUCTURE_RAMPART: 'rampart', STRUCTURE_WALL: 'wall', STRUCTURE_EXTRACTOR: 'extractor',
        FIND_STRUCTURES: 'structures', FIND_CONSTRUCTION_SITES: 'sites', FIND_MY_CONSTRUCTION_SITES: 'sites', FIND_SOURCES: 'sources', FIND_MINERALS: 'minerals',
        CONTROLLER_STRUCTURES: { container: { 8: 5 } } };
    const loader = createSourceLoader({ globals, modules: { 'settings/construction': { constructionPolicy: {
        building: { maximumNewSitesPerRoom: 5, maximumActiveSitesPerRoom: 10 }, structurePriority: ['container'] } } } });
    return { calls, game, room, source, link, container, site, loader, api: loader.load('room/sourceLinks'),
        cleanup: loader.load('planning/sourceLinkContainers').cleanupSourceLinkContainers,
        build: loader.load('planning/construction').buildMissingStructures };
}

test('source Link conversion destroys only source Containers and cancels their own sites without rebuilding', () => {
    const w = world(), plan = w.room.memory.roomBlueprint;
    w.cleanup(w.room); w.cleanup(w.room);
    assert.deepEqual(w.calls, [['destroy', 'container', 11, 10], ['remove', 'container', 9, 10]]);
    assert.deepEqual(Array.from(plan.structures.container, p => Array.from(p)), [[20, 20], [30, 31]]);
    assert.equal(w.room.memory.needUpdateCache, true);
    // Native destruction/removal are intents: emulate their application on the next tick.
    w.game.time++; w.room.structures = w.room.structures.filter(s => s !== w.container); w.room.constructionSites = [];
    w.build(w.room, plan, { remaining: 100, intents: new Map() });
    assert.equal(w.calls.some(c => c[0] === 'create'), false);
});

test('blueprint builder also rejects redundant source Container positions before cleanup', () => {
    const w = world();
    w.room.structures = [w.link]; w.room.constructionSites = [];
    w.build(w.room, { origin: 'snapshot', structures: { container: [[11, 10], [9, 10]] } }, { remaining: 100, intents: new Map() });
    assert.equal(w.calls.length, 0);
});

test('inactive, foreign and statically inaccessible source Links retain Container logistics', () => {
    for (const options of [{ active: false }, { my: false }, { walls: [[11, 9], [11, 10], [11, 11]] }]) {
        const w = world(options); w.cleanup(w.room);
        assert.equal(w.api.sourceLink(w.room, w.source), undefined);
        assert.equal(w.calls.length, 0);
        assert.equal(w.room.memory.roomBlueprint.structures.container.length, 4);
    }
});

test('temporary occupancy does not retire the source Link and the controller dedicated Container is preserved', () => {
    const w = world();
    w.room.memory.roomBlueprint.controllerContainer = [11, 10];
    w.room.lookForAt = () => [{ name: 'temporary blocker' }];
    assert.equal(w.api.sourceLink(w.room, w.source), w.link);
    w.cleanup(w.room);
    assert.deepEqual(w.calls, [['remove', 'container', 9, 10]]);
    assert.equal(w.room.memory.roomBlueprint.structures.container.some(p => p[0] === 11 && p[1] === 10), true);
});

test('cleanup respects ownership and automatic layout opt-out does not prevent Link conversion', () => {
    const w = world(); w.room.memory.autoLaylout = false;
    w.cleanup(w.room); assert.equal(w.calls.length, 2);
    const other = world(); other.room.controller.my = false; other.cleanup(other.room);
    assert.equal(other.calls.length, 0);
});

test('a newly activated Link and newly blocked harvest seats are re-evaluated next tick', () => {
    const w = world(); w.link.isActive = () => false;
    assert.equal(w.api.sourceLink(w.room, w.source), undefined);
    w.game.time++; w.link.isActive = () => true;
    assert.equal(w.api.sourceLink(w.room, w.source), w.link);
    w.game.time++;
    for (const y of [9, 10, 11]) w.room.structures.push({ structureType: 'extension', pos: { x: 11, y, roomName: w.room.name } });
    assert.equal(w.api.sourceLink(w.room, w.source), undefined);
});

test('a shared Container still required by a Source without a Link or by a mineral retains its role', () => {
    const w = world();
    w.room.sources.push({ id: 'unlinked', pos: { x: 12, y: 10, roomName: w.room.name } });
    w.link.pos.x = 8;
    w.cleanup(w.room);
    assert.equal(w.calls.some(c => c[0] === 'destroy'), false);
    assert.equal(w.room.memory.roomBlueprint.structures.container.some(p => p[0] === 11 && p[1] === 10), true);
    const mineral = world(); mineral.room.mineral.pos = { x: 10, y: 11, roomName: mineral.room.name };
    mineral.cleanup(mineral.room);
    assert.equal(mineral.calls.length, 0);
});

test('mature snapshots and manual layouts retain an unmarked controller supply Container shared with a linked Source', () => {
    for (const manual of [false, true]) {
        const w = world(); w.room.controller.pos = { x: 14, y: 10, roomName: w.room.name };
        w.room.memory.autoLaylout = !manual; w.link.pos.x = 8;
        w.cleanup(w.room);
        assert.equal(w.calls.some(c => c[0] === 'destroy'), false);
        assert.equal(w.room.memory.roomBlueprint.structures.container.some(p => p[0] === 11 && p[1] === 10), true);
    }
});
