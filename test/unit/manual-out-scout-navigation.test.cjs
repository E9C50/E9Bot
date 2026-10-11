const assert = require('node:assert/strict');
const test = require('node:test');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world(targetFlag = 'E39N5_OUT1') {
    class Position {
        constructor(x, y, roomName) { Object.assign(this, { x, y, roomName }); }
        inRangeTo(other, range) { const pos = other.pos || other; return this.roomName === pos.roomName &&
            Math.max(Math.abs(this.x - pos.x), Math.abs(this.y - pos.y)) <= range; }
        isEqualTo(other) { return this.inRangeTo(other, 0); }
    }
    const moves = [], flag = { pos: new Position(1, 0, 'E39N4') };
    const game = { flags: { [targetFlag]: flag }, rooms: {} };
    const loader = createSourceLoader({ globals: { Game: game, RoomPosition: Position },
        modules: { 'settings/room': { defaultReserverSign: 'sign' } } });
    const creep = { memory: { spawnRoom: 'E39N5', dontPullMe: true }, room: { name: 'E39N5' },
        pos: new Position(25, 25, 'E39N5'), moveTo(target, options) { moves.push({ target, options }); return 0; } };
    const behavior = loader.load('role/base/RoleBaseScout').default({ targetFlag });
    const place = (room, x, y) => { creep.room = { name: room }; creep.pos = new Position(x, y, room); };
    return { moves, flag, creep, behavior, place, Position };
}

test('a wall-border OUT flag sends its scout to a broad reachable interior instead of the wall tile', () => {
    const w = world();
    w.behavior.target(w.creep);
    assert.equal(w.moves.length, 1);
    const { target, options } = w.moves[0];
    assert.deepEqual(target, new w.Position(25, 25, 'E39N4'));
    assert.deepEqual({ ...options }, { range: 20, reusePath: 20 });
    const goalTiles = [];
    for (let x = 0; x < 50; x++) for (let y = 0; y < 50; y++) {
        if (new w.Position(x, y, 'E39N4').inRangeTo(target, options.range)) goalTiles.push([x, y]);
    }
    assert.ok(goalTiles.length > 0);
    assert.ok(goalTiles.every(([x, y]) => x >= 5 && x <= 45 && y >= 5 && y <= 45),
        'the accepted goal excludes both the live wall rectangle x0..2/y0..1 and every room exit');
    assert.equal(w.creep.memory.dontPullMe, false);
});

test('an OUT scout moves off an entry border then retains vision anywhere in the interior', () => {
    const w = world();
    for (const [x, y] of [[0, 25], [49, 25], [25, 0], [25, 49], [4, 25]]) {
        w.place('E39N4', x, y); w.moves.length = 0;
        w.behavior.target(w.creep);
        assert.equal(w.moves.length, 1, 'entry and exit-adjacent tiles must be cleared');
        assert.equal(w.moves[0].target.roomName, 'E39N4');
    }
    for (const [x, y] of [[5, 25], [45, 25], [25, 5], [25, 45], [25, 25]]) {
        w.place('E39N4', x, y); w.moves.length = 0;
        w.behavior.target(w.creep);
        assert.equal(w.moves.length, 0, 'interior vision does not require approaching the flag');
    }
});

test('moving an OUT flag inside its room leaves the scout in place while moving it to another room retargets travel', () => {
    const w = world(); w.place('E39N4', 15, 15);
    w.flag.pos = new w.Position(49, 49, 'E39N4');
    w.behavior.target(w.creep);
    assert.equal(w.moves.length, 0);
    w.flag.pos = new w.Position(1, 0, 'E39N3');
    w.behavior.target(w.creep);
    assert.deepEqual(w.moves[0].target, new w.Position(25, 25, 'E39N3'));
    assert.equal(w.moves[0].options.range, 20);
});

test('ordinary SCOUT instructions retain their exact flag target even on a border', () => {
    const w = world('E39N5_SCOUT');
    w.behavior.target(w.creep);
    assert.equal(w.moves[0].target, w.flag);
    assert.equal(w.moves[0].options, undefined);
    w.place('E39N4', 1, 0); w.moves.length = 0;
    w.behavior.target(w.creep);
    assert.equal(w.moves.length, 0);
});
