const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world() {
    const calls = [], cells = new Map(), walls = new Set();
    const pos = (x, y) => ({ x, y, roomName: 'E1N1' });
    const source = { id: 'source', pos: pos(10, 10) };
    const link = { id: 'link', structureType: 'link', pos: pos(12, 10), my: true,
        active: true, isActive() { calls.push(['active', this.id]); return this.active; } };
    const game = { time: 1, shard: { name: 'shard3' } };
    const room = { name: 'E1N1', sources: [source], mineral: { pos: pos(30, 30) },
        controller: { pos: pos(20, 20) }, links: [link],
        get structures() { throw Error('native Source Link geometry must not scan the full structure list'); },
        find() { throw Error('native Source Link geometry must not find full structure lists'); },
        getTerrain: () => ({ get(x, y) { return walls.has(`${x}/${y}`) ? 1 : 0; } }),
        lookForAt(type, x, y) {
            assert.equal(type, 'structures', 'temporary creep occupancy is not a static obstacle');
            calls.push(['look', x, y]); return cells.get(`${x}/${y}`) || [];
        } };
    const loader = createSourceLoader({ globals: { Game: game, TERRAIN_MASK_WALL: 1, LOOK_STRUCTURES: 'structures',
        STRUCTURE_LINK: 'link', STRUCTURE_CONTAINER: 'container', STRUCTURE_ROAD: 'road', STRUCTURE_RAMPART: 'rampart' } });
    return { room, source, link, game, calls, cells, walls, pos, loader, api: loader.load('room/sourceLinks') };
}

function nativeController(w) {
    Object.assign(w.room.controller, { id: 'controller', level: 8, my: true, owner: { username: 'player' } });
    for (const link of w.room.links) link.owner = { username: 'player' };
}

function freshRoom(room, changes) {
    return Object.assign(Object.create(Object.getPrototypeOf(room), Object.getOwnPropertyDescriptors(room)), changes);
}

test('two mature mines inspect only their local harvest seats rather than hundreds of remote structures', () => {
    const w = world();
    const second = { id: 'second', pos: w.pos(40, 40) };
    w.room.sources.push(second);
    w.room.links.push({ ...w.link, id: 'second-link', pos: w.pos(42, 40) });
    assert.equal(w.api.sourceLink(w.room, w.source), w.link);
    assert.equal(w.api.sourceLink(w.room, second).id, 'second-link');
    for (let index = 0; index < 20; index++) {
        assert.equal(w.api.sourceLink(w.room, w.source), w.link);
        assert.equal(w.api.sourceLink(w.room, second).id, 'second-link');
    }
    assert.deepEqual(w.calls.filter(call => call[0] === 'look'), [['look', 11, 9], ['look', 41, 39]]);
    assert.equal(w.calls.filter(call => call[0] === 'active').length, 2);
});

test('distant or inactive Links perform no seat query or full-room obstacle scan', () => {
    const w = world(); w.link.pos = w.pos(30, 30);
    assert.equal(w.api.sourceLink(w.room, w.source), undefined);
    assert.equal(w.calls.filter(call => call[0] === 'look').length, 0);
    w.game.time++; w.link.pos = w.pos(12, 10); w.link.active = false;
    assert.equal(w.api.sourceLink(w.room, w.source), undefined);
    assert.equal(w.calls.filter(call => call[0] === 'look').length, 0);
});

test('current-room tile geometry observes new blockers and destroyed cover on the next tick', () => {
    const w = world();
    assert.equal(w.api.sourceLink(w.room, w.source), w.link);
    for (const y of [9, 10, 11]) w.cells.set(`11/${y}`, [{ structureType: 'extension', pos: w.pos(11, y) }]);
    w.game.time++;
    assert.equal(w.api.sourceLink(w.room, w.source), undefined);
    w.cells.delete('11/11'); w.game.time++;
    assert.equal(w.api.sourceLink(w.room, w.source), w.link);
    w.link.my = false; w.game.time++;
    assert.equal(w.api.sourceLink(w.room, w.source), undefined);
});

test('road, Container and friendly/public Rampart seats remain usable while private hostile cover blocks', () => {
    for (const cover of [{ structureType: 'road' }, { structureType: 'container' },
        { structureType: 'rampart', my: true }, { structureType: 'rampart', my: false, isPublic: true }]) {
        const w = world(); w.walls.add('11/9'); w.walls.add('11/11'); w.cells.set('11/10', [cover]);
        assert.equal(w.api.sourceLink(w.room, w.source), w.link);
    }
    const blocked = world(); blocked.walls.add('11/9'); blocked.walls.add('11/11');
    blocked.cells.set('11/10', [{ structureType: 'rampart', my: false, isPublic: false }]);
    assert.equal(blocked.api.sourceLink(blocked.room, blocked.source), undefined);
});

test('Sources, minerals and Controllers exclude natural seats without native structure queries', () => {
    const w = world(); w.room.sources.push({ id: 'natural', pos: w.pos(11, 9) });
    w.room.mineral.pos = w.pos(11, 10); w.room.controller.pos = w.pos(11, 11);
    assert.equal(w.api.sourceLink(w.room, w.source), undefined);
    assert.equal(w.calls.filter(call => call[0] === 'look').length, 0);
});

test('Room adapters without tile lookup retain current structure-array obstruction behavior', () => {
    const w = world(); delete w.room.lookForAt;
    Object.defineProperty(w.room, 'structures', { value: [w.link, ...[9, 10, 11].map(y =>
        ({ structureType: 'extension', pos: w.pos(11, y) }))] });
    assert.equal(w.api.sourceLink(w.room, w.source), undefined);
    w.room.structures.pop(); w.game.time++;
    assert.equal(w.api.sourceLink(w.room, w.source), w.link);
});

test('native controller topology reuses scalar activation and the last usable seat across fresh native objects', () => {
    const w = world(); nativeController(w);
    w.walls.add('11/9'); w.cells.set('11/10', [{ structureType: 'extension' }]);
    for (let tick = 0; tick < 100; tick++) {
        const link = { ...w.room.links[0], pos: w.pos(12, 10) };
        const source = { ...w.source, pos: w.pos(10, 10) };
        const room = freshRoom(w.room, { links: [link], sources: [source] });
        assert.equal(w.api.sourceLink(room, source), link, 'a cached native object must never escape into a new tick');
        w.game.time++;
    }
    assert.equal(w.calls.filter(call => call[0] === 'active').length, 1, 'stable activation avoids one full engine room-object scan per tick');
    assert.equal(w.calls.filter(call => call[0] === 'look').length, 101, 'only the proven seat needs a live blocker query after the first tick');
});

test('native cached activation immediately observes RCL, owner, membership and Link-position changes', () => {
    const w = world(); nativeController(w);
    w.link.isActive = function () {
        w.calls.push(['active', this.id]);
        return w.room.controller.level >= 5 && w.room.controller.owner.username === this.owner.username && this.active;
    };
    assert.equal(w.api.sourceLink(w.room, w.source), w.link);
    w.room.controller.level = 4; w.game.time++;
    assert.equal(w.api.sourceLink(w.room, w.source), undefined);
    w.room.controller.level = 5; w.game.time++;
    assert.equal(w.api.sourceLink(w.room, w.source), w.link);
    w.room.controller.owner = { username: 'other' }; w.game.time++;
    assert.equal(w.api.sourceLink(w.room, w.source), undefined);
    w.room.controller.owner = { username: 'player' }; w.game.time++;
    assert.equal(w.api.sourceLink(w.room, w.source), w.link);
    const next = { ...w.link, id: 'new-link', pos: w.pos(9, 8) };
    w.room.links.unshift(next); w.game.time++;
    assert.equal(w.api.sourceLink(w.room, w.source), next);
    next.pos = w.pos(40, 40); w.game.time++;
    assert.equal(w.api.sourceLink(w.room, w.source), w.link);
    w.room.links = [next]; w.game.time++;
    assert.equal(w.api.sourceLink(w.room, w.source), undefined);
    w.room.links = [w.link]; w.link.my = false; w.game.time++;
    assert.equal(w.api.sourceLink(w.room, w.source), undefined);
    assert.equal(w.calls.filter(call => call[0] === 'active').length, 7);
});

test('cached seats detect a new obstruction and choose reopened seats without retaining a blocked Link', () => {
    const w = world(); nativeController(w);
    w.cells.set('11/9', [{ structureType: 'extension' }]);
    w.cells.set('11/10', [{ structureType: 'extension' }]);
    assert.equal(w.api.sourceLink(w.room, w.source), w.link);
    w.cells.set('11/11', [{ structureType: 'extension' }]); w.game.time++;
    assert.equal(w.api.sourceLink(w.room, w.source), undefined);
    w.cells.delete('11/9'); w.game.time++;
    assert.equal(w.api.sourceLink(w.room, w.source), w.link);
    w.room.mineral.pos = w.pos(11, 9); w.game.time++;
    assert.equal(w.api.sourceLink(w.room, w.source), undefined, 'natural blockers are also checked against cached scalar seats');
});

test('native quota failures are cached only until closer Link membership or equal-distance order changes', () => {
    const w = world(); nativeController(w); w.room.controller.level = 5;
    const closer = { ...w.link, id: 'closer', pos: w.pos(20, 19) };
    const tied = { ...w.link, id: 'tied', pos: w.pos(10, 20) };
    w.room.links = [closer, tied, w.link];
    w.link.isActive = function () {
        w.calls.push(['active', this.id]);
        const dist = value => Math.max(Math.abs(value.pos.x - 20), Math.abs(value.pos.y - 20));
        const own = w.room.links.filter(value => value.my && value.owner.username === 'player');
        return own.slice().sort((a, b) => dist(a) - dist(b)).indexOf(this) < 2;
    };
    assert.equal(w.api.sourceLink(w.room, w.source), undefined);
    w.game.time++;
    assert.equal(w.api.sourceLink(w.room, w.source), undefined);
    assert.equal(w.calls.filter(call => call[0] === 'active').length, 1);
    w.room.links = [closer, w.link, tied]; w.game.time++;
    assert.equal(w.api.sourceLink(w.room, w.source), w.link, 'quota ties must be rechecked when the complete Link order changes');
    w.room.links = [w.link, tied]; w.game.time++;
    assert.equal(w.api.sourceLink(w.room, w.source), w.link);
    assert.equal(w.calls.filter(call => call[0] === 'active').length, 3);
});

test('receiver activation shares source topology validation while live ownership and Storage stay current', () => {
    const w = world(); nativeController(w);
    const receiver = { ...w.link, id: 'receiver', pos: w.pos(20, 19) };
    w.room.links.push(receiver); w.room.centerLink = receiver;
    w.room.storage = { my: true, isActive: () => true };
    assert.equal(w.api.hasSourceLinkTransport(w.room, w.source), true);
    w.game.time++;
    assert.equal(w.api.hasSourceLinkTransport(w.room, w.source), true);
    assert.equal(w.calls.filter(call => call[0] === 'active').length, 2);
    receiver.my = false; w.game.time++;
    assert.equal(w.api.hasSourceLinkTransport(w.room, w.source), false);
    receiver.my = true; w.room.storage.my = false; w.game.time++;
    assert.equal(w.api.hasSourceLinkTransport(w.room, w.source), false);
});

test('room cache is bounded and drops proofs after shard changes or a reversed native clock', () => {
    const w = world(); nativeController(w);
    w.loader.load('settings/sourceLinks').sourceLinkPolicy.maximumCachedRooms = 2;
    for (const name of ['E1N1', 'E2N1', 'E3N1', 'E1N1']) {
        const source = { ...w.source, pos: { x: 10, y: 10, roomName: name } };
        const room = freshRoom(w.room, { name, sources: [source] });
        assert.equal(w.api.sourceLink(room, source), w.link);
        w.game.time++;
    }
    assert.equal(w.calls.filter(call => call[0] === 'active').length, 4, 'evicted room proofs are revalidated');
    w.game.shard.name = 'shard1';
    assert.equal(w.api.sourceLink(w.room, w.source), w.link);
    w.game.time = 0;
    assert.equal(w.api.sourceLink(w.room, w.source), w.link);
    assert.equal(w.calls.filter(call => call[0] === 'active').length, 6);
});

test('runtime disabling or shrinking the room limit invalidates retained proofs before any new signature', () => {
    const w = world(); nativeController(w);
    const policy = w.loader.load('settings/sourceLinks').sourceLinkPolicy;
    const inspect = name => {
        const source = { ...w.source, pos: { x: 10, y: 10, roomName: name } };
        assert.equal(w.api.sourceLink(freshRoom(w.room, { name, sources: [source] }), source), w.link);
        w.game.time++;
    };
    for (const name of ['E1N1', 'E2N1', 'E3N1']) inspect(name);
    policy.maximumCachedRooms = 1;
    inspect('E3N1');
    assert.equal(w.calls.filter(call => call[0] === 'active').length, 3, 'the retained newest room keeps its proof');
    inspect('E1N1');
    assert.equal(w.calls.filter(call => call[0] === 'active').length, 4, 'older rooms were evicted without requiring a topology edit');
    for (const invalid of [0, -1, NaN, Infinity, 1.5]) {
        policy.maximumCachedRooms = invalid;
        inspect('E1N1'); inspect('E1N1');
    }
    assert.equal(w.calls.filter(call => call[0] === 'active').length, 14, 'disabled/invalid limits use current-tick activation only');
});
