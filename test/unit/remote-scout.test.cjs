const assert = require('node:assert/strict');
const test = require('node:test');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world() {
    const moves = [];
    class Position {
        constructor(x, y, roomName) { Object.assign(this, { x, y, roomName }); }
        inRangeTo(other, range) { const pos = other.pos || other; return this.roomName === pos.roomName &&
            Math.max(Math.abs(this.x - pos.x), Math.abs(this.y - pos.y)) <= range; }
        isEqualTo(other) { return this.inRangeTo(other, 0); }
    }
    const game = { flags: { W1N1_OUT0: { pos: new Position(25, 25, 'W1N2') },
        W1N1_OUT1: { pos: new Position(25, 25, 'W1N3') } }, rooms: {} };
    const loader = createSourceLoader({ globals: { Game: game, RoomPosition: Position },
        modules: { 'settings/room': { defaultReserverSign: 'sign' } } });
    const creep = { memory: { spawnRoom: 'W1N1', dontPullMe: true }, room: { name: 'W1N1' },
        pos: new Position(25, 25, 'W1N1'), moveTo(target, options) { moves.push({ target, options }); } };
    const role = data => loader.load('role/base/RoleBaseScout').default(data);
    return { game, creep, moves, role, Position };
}

test('dedicated OUT scout reaches only its assigned remote and never patrols the next OUT', () => {
    const w = world(), behavior = w.role({ targetFlag: 'W1N1_OUT0' });
    behavior.target(w.creep);
    assert.deepEqual(w.moves[0].target, new w.Position(25, 25, 'W1N2'));
    assert.equal(w.moves[0].options.range, 20);
    w.creep.pos = new w.Position(24, 25, 'W1N2');
    w.creep.room.name = 'W1N2'; w.moves.length = 0;
    behavior.target(w.creep);
    assert.equal(w.moves.length, 0);
    assert.equal(w.creep.memory.dontPullMe, false);
});

test('deleting the assigned OUT does not redirect its paid scout into a later remote', () => {
    const w = world(), behavior = w.role({ targetFlag: 'W1N1_OUT0' });
    delete w.game.flags.W1N1_OUT0;
    behavior.target(w.creep);
    assert.equal(w.moves.length, 0);
    w.game.flags.W1N1_OUT0 = { pos: new w.Position(20, 20, 'W2N2') };
    behavior.target(w.creep);
    assert.equal(w.moves[0].target.roomName, 'W2N2');
});

test('an ordinary SCOUT retains the existing OUT fallback when its explicit flag is absent', () => {
    const w = world(); w.role({ targetFlag: 'W1N1_SCOUT' }).target(w.creep);
    assert.equal(w.moves[0].target.roomName, 'W1N2');
});
