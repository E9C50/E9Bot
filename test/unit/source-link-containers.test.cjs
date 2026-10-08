const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world({ active = true, my = true, walls = [], center = true, centerActive = true, centerMy = true } = {}) {
    const calls = [], game = { time: 1, constructionSites: {}, creeps: {} }, wall = new Set(walls.map(p => p.join(',')));
    const pos = (x, y) => ({ x, y, roomName: 'E1N1' });
    const item = (type, x, y) => ({ id: `${type}:${x}:${y}`, structureType: type, pos: pos(x, y),
        destroy() { calls.push(['destroy', type, x, y]); return 0; } });
    const source = { id: 'mine', pos: pos(10, 10) }, link = { ...item('link', 12, 10), my, isActive: () => active };
    const centerLink = { ...item('link', 25, 25), my: centerMy, isActive: () => centerActive };
    const container = item('container', 11, 10), other = item('container', 20, 20), mineral = item('container', 30, 31);
    const site = { ...item('container', 9, 10), progressTotal: 500, my: true,
        remove() { calls.push(['remove', 'container', 9, 10]); return 0; } };
    const room = { name: 'E1N1', controller: { my: true, level: 8, pos: pos(20, 17) },
        memory: { roomBlueprint: { origin: 'snapshot', structures: { container: [[11, 10], [9, 10], [20, 20], [30, 31]] } } },
        structures: [link, ...(center ? [centerLink] : []), container, other, mineral], centerLink: center ? centerLink : undefined,
        sources: [source], mineral: { pos: pos(30, 30) }, constructionSites: [site],
        getTerrain: () => ({ get: (x, y) => wall.has(`${x},${y}`) ? 1 : 0 }),
        find(type) { return type === 'structures' ? this.structures : type === 'sites' ? this.constructionSites : type === 'sources' ? this.sources : []; },
        createConstructionSite(x, y, type) { calls.push(['create', type, x, y]); return 0; } };
    const globals = { Game: game, OK: 0, ERR_FULL: -8, TERRAIN_MASK_WALL: 1, STRUCTURE_CONTAINER: 'container',
        STRUCTURE_LINK: 'link', STRUCTURE_ROAD: 'road', STRUCTURE_RAMPART: 'rampart', STRUCTURE_WALL: 'wall', STRUCTURE_EXTRACTOR: 'extractor',
        FIND_STRUCTURES: 'structures', FIND_CONSTRUCTION_SITES: 'sites', FIND_MY_CONSTRUCTION_SITES: 'sites', FIND_SOURCES: 'sources', FIND_MINERALS: 'minerals',
        CONTROLLER_STRUCTURES: { container: { 6: 5, 8: 5 } } };
    const loader = createSourceLoader({ globals, modules: { 'settings/construction': { constructionPolicy: {
        building: { maximumNewSitesPerRoom: 5, maximumActiveSitesPerRoom: 10 }, structurePriority: ['container'] } } } });
    return { calls, game, room, source, link, centerLink, container, site, loader, api: loader.load('room/sourceLinks'),
        cleanup: loader.load('planning/sourceLinkContainers').cleanupSourceLinkContainers,
        build: loader.load('planning/construction').buildMissingStructures };
}

test('complete Source and central Link transport destroys only source Containers and cancels their own sites without rebuilding', () => {
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
    w.room.structures = [w.link, w.centerLink]; w.room.constructionSites = [];
    w.build(w.room, { origin: 'snapshot', structures: { container: [[11, 10], [9, 10]] } }, { remaining: 100, intents: new Map() });
    assert.equal(w.calls.length, 0);
});

test('source Container cleanup uses the Container group without traversing unrelated room structures', () => {
    const w = world();
    w.room.containers = [w.container];
    w.room.links = [w.link, w.centerLink];
    w.room.lookForAt = () => [];
    w.loader.globals.LOOK_STRUCTURES = 'structures';
    Object.defineProperty(w.room, 'structures', { get() { throw new Error('unrelated roads and ramparts are not cleanup candidates'); } });
    w.cleanup(w.room);
    assert.deepEqual(w.calls, [['destroy', 'container', 11, 10], ['remove', 'container', 9, 10]]);
});

test('inactive, foreign and statically inaccessible source Links retain Container logistics', () => {
    for (const options of [{ active: false }, { my: false }, { walls: [[11, 9], [11, 10], [11, 11]] }]) {
        const w = world(options); w.cleanup(w.room);
        assert.equal(w.api.sourceLink(w.room, w.source), undefined);
        assert.equal(w.calls.length, 0);
        assert.equal(w.room.memory.roomBlueprint.structures.container.length, 4);
    }
});

test('a Source Link alone retains stocked Containers, unfinished sites and their blueprint positions', () => {
    const w = world({ center: false }), planned = JSON.stringify(w.room.memory.roomBlueprint);
    w.container.store = { energy: 1000 };
    assert.equal(w.api.sourceLink(w.room, w.source), w.link);
    w.cleanup(w.room);
    assert.deepEqual(w.calls, []);
    assert.equal(w.container.store.energy, 1000);
    assert.equal(JSON.stringify(w.room.memory.roomBlueprint), planned);
    assert.equal(w.room.memory.needUpdateCache, undefined);
});

test('missing, inactive or foreign central Links allow the builder to restore planned source Containers', () => {
    for (const options of [{ center: false }, { centerActive: false }, { centerMy: false }]) {
        const w = world(options);
        w.room.structures = [w.link, ...(options.center === false ? [] : [w.centerLink])];
        w.room.constructionSites = [];
        const created = w.build(w.room, { origin: 'snapshot', structures: { container: [[11, 10], [9, 10]] } },
            { remaining: 100, intents: new Map() });
        assert.equal(created, 2, JSON.stringify(options));
        assert.deepEqual(w.calls, [['create', 'container', 11, 10], ['create', 'container', 9, 10]]);
    }
});

test('planned, stale, foreign-room and source-only central candidates cannot authorize Container cleanup', () => {
    for (const variant of ['site', 'stale', 'foreignRoom', 'sameSource', 'controllerOnly']) {
        const w = world({ center: false });
        if (variant === 'site') {
            w.room.centerLink = { ...w.centerLink, progressTotal: 500, remove() { throw Error('central Link site is unrelated'); } };
            w.room.constructionSites.push(w.room.centerLink);
            w.room.structures.push(w.room.centerLink); // Even a mixed adapter cannot call this a built Link.
        } else if (variant === 'stale') w.room.centerLink = w.centerLink;
        else if (variant === 'foreignRoom') {
            w.room.centerLink = { ...w.centerLink, pos: { ...w.centerLink.pos, roomName: 'E2N1' } };
            w.room.structures.push(w.room.centerLink);
        } else if (variant === 'sameSource') w.room.centerLink = w.link;
        else {
            w.room.controllerLink = w.centerLink;
            w.room.structures.push(w.centerLink);
        }
        w.cleanup(w.room);
        assert.deepEqual(w.calls, [], variant);
        assert.equal(w.api.redundantSourceContainer(w.room, 11, 10), false, variant);
        assert.equal(w.room.memory.roomBlueprint.structures.container.length, 4, variant);
    }
});

test('cleanup starts only on the tick when the central Link is built and active', () => {
    const w = world({ center: false });
    w.cleanup(w.room); assert.deepEqual(w.calls, []);
    w.game.time++; w.room.centerLink = w.centerLink; w.room.structures.push(w.centerLink);
    w.centerLink.isActive = () => false;
    w.cleanup(w.room); assert.deepEqual(w.calls, []);
    w.game.time++; w.centerLink.isActive = () => true;
    w.cleanup(w.room);
    assert.deepEqual(w.calls, [['destroy', 'container', 11, 10], ['remove', 'container', 9, 10]]);
    assert.deepEqual(Array.from(w.room.memory.roomBlueprint.structures.container, p => Array.from(p)), [[20, 20], [30, 31]]);
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

test('a pruned RCL6 snapshot recovers both source Containers on the seated miners and the builder resumes local supply', () => {
    const w = world({ center: false }), blueprint = w.room.memory.roomBlueprint;
    w.room.controller.level = 6;
    const one = { id: 'source-one', pos: { x: 44, y: 33, roomName: w.room.name } };
    const two = { id: 'source-two', pos: { x: 36, y: 34, roomName: w.room.name } };
    const linkOne = { ...w.link, id: 'link-one', pos: { x: 42, y: 34, roomName: w.room.name } };
    const linkTwo = { ...w.link, id: 'link-two', pos: { x: 38, y: 35, roomName: w.room.name } };
    w.room.sources = [one, two]; w.room.links = [linkOne, linkTwo];
    w.room.structures = [linkOne, linkTwo, ...w.room.structures.filter(s => s.structureType === 'container' && s !== w.container)];
    w.room.constructionSites = [];
    blueprint.structures.container = [[20, 20], [30, 31]];
    blueprint.controllerContainer = [20, 20];
    for (const [source, x, y] of [[one, 43, 33], [two, 37, 34]]) {
        w.game.creeps[source.id] = { pos: { x, y, roomName: w.room.name }, memory: { role: 'harvester', data: { sourceId: source.id } } };
    }
    w.cleanup(w.room);
    assert.deepEqual(Array.from(blueprint.structures.container, p => Array.from(p)), [[20, 20], [30, 31], [43, 33], [37, 34]]);
    assert.deepEqual(w.calls, [], 'recovery edits the saved blueprint and leaves native site budgets to the builder');
    assert.equal(w.build(w.room, blueprint, { remaining: 100, intents: new Map() }), 2);
    assert.deepEqual(w.calls, [['create', 'container', 43, 33], ['create', 'container', 37, 34]]);
    // Apply construction intents; repeated inspections must not duplicate or move the saved seats.
    w.room.constructionSites = [[43, 33], [37, 34]].map(([x, y]) => ({ structureType: 'container', my: true, progressTotal: 500, pos: { x, y, roomName: w.room.name } }));
    const persisted = JSON.stringify(blueprint); w.calls.length = 0;
    for (let tick = 0; tick < 3; tick++) {
        w.game.time += 10; delete w.room.memory.needUpdateCache; w.cleanup(w.room);
        assert.equal(w.build(w.room, blueprint, { remaining: 100, intents: new Map() }), 0);
        assert.equal(JSON.stringify(blueprint), persisted); assert.equal(w.room.memory.needUpdateCache, undefined);
    }
    assert.deepEqual(w.calls, []);
});

test('recovery restores an existing Container or unfinished site at its original position before selecting a Link seat', () => {
    for (const built of [false, true]) {
        const w = world({ center: false }), blueprint = w.room.memory.roomBlueprint;
        blueprint.structures.container = [[20, 20], [30, 31]];
        w.room.structures = w.room.structures.filter(item => item !== w.container);
        if (built) {
            w.container.pos = { x: 9, y: 10, roomName: w.room.name };
            w.room.structures.push(w.container); w.room.constructionSites = [];
        }
        w.cleanup(w.room);
        assert.deepEqual(Array.from(blueprint.structures.container, p => Array.from(p)), [[20, 20], [30, 31], [9, 10]]);
        assert.deepEqual(w.calls, []);
    }
});

test('recovery preserves an original preferred Container coordinate without replacing it with the current Link seat', () => {
    const w = world({ center: false }), blueprint = w.room.memory.roomBlueprint;
    w.room.structures = w.room.structures.filter(item => item !== w.container); w.room.constructionSites = [];
    blueprint.structures.container = [[20, 20], [30, 31], [9, 10]];
    w.game.creeps.miner = { pos: { x: 11, y: 11, roomName: w.room.name }, memory: { role: 'harvester', data: { sourceId: w.source.id } } };
    const original = JSON.stringify(blueprint);
    w.cleanup(w.room); assert.equal(JSON.stringify(blueprint), original);
    assert.equal(w.build(w.room, blueprint, { remaining: 100, intents: new Map() }), 1);
    assert.deepEqual(w.calls, [['create', 'container', 9, 10]]);
});

test('recovery avoids terrain, structures, unrelated construction and conflicting future blueprint positions', () => {
    for (const blocked of ['wall', 'structure', 'site', 'blueprint']) {
        const w = world({ center: false, walls: [[11, 9], ...(blocked === 'wall' ? [[11, 10]] : [])] });
        const blueprint = w.room.memory.roomBlueprint;
        blueprint.structures.container = [[20, 20], [30, 31]];
        w.room.structures = w.room.structures.filter(item => item !== w.container); w.room.constructionSites = [];
        if (blocked === 'structure') w.room.structures.push({ structureType: 'extension', pos: { x: 11, y: 10, roomName: w.room.name } });
        if (blocked === 'site') w.room.constructionSites.push({ structureType: 'extension', my: true, progressTotal: 500, pos: { x: 11, y: 10, roomName: w.room.name } });
        if (blocked === 'blueprint') blueprint.structures.extension = [[11, 10]];
        w.game.creeps.miner = { pos: { x: 11, y: 10, roomName: w.room.name }, memory: { role: 'harvester', data: { sourceId: w.source.id } } };
        w.cleanup(w.room);
        assert.deepEqual(Array.from(blueprint.structures.container, p => Array.from(p)), [[20, 20], [30, 31], [11, 11]], blocked);
    }
});

test('Container quota counts retained blueprints, native Containers and sites without demolishing unrelated supply', () => {
    for (const quotaSource of ['blueprint', 'structures', 'sites']) {
        const w = world({ center: false }), blueprint = w.room.memory.roomBlueprint;
        blueprint.structures.container = [[20, 20], [30, 31]];
        w.room.structures = w.room.structures.filter(item => item !== w.container); w.room.constructionSites = [];
        for (const [x, y] of [[40, 40], [41, 41], [42, 42]]) {
            if (quotaSource === 'blueprint') blueprint.structures.container.push([x, y]);
            else if (quotaSource === 'structures') w.room.structures.push({ structureType: 'container', pos: { x, y, roomName: w.room.name } });
            else w.room.constructionSites.push({ structureType: 'container', progressTotal: 500, my: true, pos: { x, y, roomName: w.room.name } });
        }
        const original = JSON.stringify(blueprint); w.cleanup(w.room);
        assert.equal(JSON.stringify(blueprint), original, quotaSource); assert.deepEqual(w.calls, []);
    }
});

test('recovery allows adding an existing source Container to a full native quota without consuming another slot', () => {
    const w = world({ center: false }), blueprint = w.room.memory.roomBlueprint;
    blueprint.structures.container = [[20, 20], [30, 31]]; w.room.constructionSites = [];
    for (const [x, y] of [[40, 40], [41, 41]]) w.room.structures.push({ structureType: 'container', pos: { x, y, roomName: w.room.name } });
    w.cleanup(w.room);
    assert.deepEqual(Array.from(blueprint.structures.container, p => Array.from(p)), [[20, 20], [30, 31], [11, 10]]);
    assert.deepEqual(w.calls, []);
});
