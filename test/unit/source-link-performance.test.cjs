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
    return { room, source, link, game, calls, cells, walls, pos, api: loader.load('room/sourceLinks') };
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
