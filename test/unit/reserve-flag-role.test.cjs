const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world() {
    const calls = [], memory = { warMode: {} }, policy = { warModeScope: 'empire' };
    const game = { rooms: {}, flags: {} };
    class Position {
        constructor(x, y, roomName) { Object.assign(this, { x, y, roomName }); }
        getRangeTo(target) {
            const pos = target.pos || target;
            return this.roomName === pos.roomName ? Math.max(Math.abs(this.x - pos.x), Math.abs(this.y - pos.y)) : Infinity;
        }
    }
    function room(name, my = false) {
        const value = { name, my, memory: {}, enemies: [], hostileStructures: [], spawns: [], controller: {
            pos: new Position(25, 25, name), my, owner: my ? { username: 'self' } : undefined
        } };
        game.rooms[name] = value;
        return value;
    }
    const home = room('E39N5', true), remote = room('E38N5'), another = room('E37N5');
    home.spawns.push({ pos: new Position(20, 20, home.name) });
    const flagName = `${home.name}_RESERVE0`, flag = { name: flagName, pos: new Position(10, 10, remote.name) };
    game.flags[flagName] = flag;
    let resolveCount = 0;
    const role = createSourceLoader({ globals: {
        Game: game, Memory: memory, RoomPosition: Position, CONTROLLER_RESERVE_MAX: 5000
    }, modules: {
        'creep/reserveFlags': { isReserveFlagRoomSafe(value) {
            return value.enemies.length === 0 && value.hostileStructures.length === 0 &&
                !memory.warMode[value.name] && !value.memory.evacuation;
        }, resolveReserveFlag(homeRoom, name) {
            resolveCount++;
            const result = game.flags[name], target = result && game.rooms[result.pos.roomName];
            return name.startsWith(`${homeRoom.name}_RESERVE`) && result && result.pos.roomName !== homeRoom.name &&
                (!target || (target.controller && !target.controller.owner && !target.controller.my)) ? result : undefined;
        } },
        'room/evacuationState': { isRoomEvacuating: value => !!value.memory.evacuation },
        'settings/runtime': { runtimePolicy: policy },
        'settings/room': { defaultReserverSign: 'reserved by ecbot' },
        'settings/rolePolicy': { rolePolicy: { reserver: { renewBelowTicks: 4800 } } },
        utils: { getDistance: (first, second) => first.getRangeTo(second) }
    } }).load('role/adv/RoleAdvReserver').default;
    function unit(value = remote, data = { targetRoom: remote.name, reserveFlag: flagName }) {
        return {
            name: 'manual-reserver', room: value, pos: new Position(24, 25, value.name), spawning: false,
            memory: { spawnRoom: home.name, data, working: false, dontPullMe: true }, owner: { username: 'self' },
            moveTo(target, options) { const pos = target.pos || target; calls.push({ type: 'move', roomName: pos.roomName, x: pos.x, y: pos.y, options }); return 0; },
            reserveController(controller) { calls.push({ type: 'reserve', roomName: controller.pos.roomName }); return 0; },
            attackController(controller) { calls.push({ type: 'attack', roomName: controller.pos.roomName }); return 0; },
            signController(controller, text) { calls.push({ type: 'sign', roomName: controller.pos.roomName, text }); return 0; },
            goBoost() { calls.push({ type: 'boost' }); return true; },
            say(text) { calls.push({ type: 'say', text }); }
        };
    }
    return { calls, game, memory, policy, home, remote, another, flag, flagName, room, role, unit, resolveCount: () => resolveCount };
}

test('flag reserver prepares without boosts, switches to work and follows the flag room before controller approach', () => {
    const w = world(), creep = w.unit(w.home), config = w.role(creep.memory.data);
    assert.equal(config.prepare(creep), true);
    assert.equal(config.source(creep), true);
    assert.equal(creep.memory.working, true);
    assert.equal(creep.memory.dontPullMe, false);
    assert.equal(config.target(creep), true);
    assert.deepEqual(w.calls.map(call => call.type), ['move']);
    assert.equal(w.calls[0].roomName, w.remote.name);
    assert.equal(w.calls[0].options.range, 20);
    assert.equal(w.resolveCount(), 3, 'each hook observes current flag position and cancellation');
    w.calls.length = 0; creep.room = w.remote; creep.pos = new w.flag.pos.constructor(10, 10, w.remote.name);
    config.target(creep);
    assert.equal(w.calls[0].type, 'move');
    assert.equal(w.calls[0].x, 25); assert.equal(w.calls[0].y, 25); assert.equal(w.calls[0].options.range, 1);
});

for (const ticks of [undefined, 0, 4799, 4800, 4999]) test(`flag reserver continues renewing at reservation ${ticks ?? 'absent'} ticks`, () => {
    const w = world(), creep = w.unit();
    if (ticks !== undefined) w.remote.controller.reservation = { username: 'self', ticksToEnd: ticks };
    assert.equal(w.role(creep.memory.data).target(creep), true);
    assert.deepEqual(w.calls.map(call => call.type), ['reserve', 'sign']);
    assert.equal(w.calls[1].text, 'reserved by ecbot');
    assert.equal(creep.memory.dontPullMe, false);
});

test('a full controller reservation waits and signs only when its signature differs', () => {
    const w = world(), creep = w.unit();
    w.remote.controller.reservation = { username: 'self', ticksToEnd: 5000 };
    w.role(creep.memory.data).target(creep);
    assert.deepEqual(w.calls.map(call => call.type), ['sign']);
    w.calls.length = 0; w.remote.controller.sign = { text: 'reserved by ecbot' };
    w.role(creep.memory.data).target(creep);
    assert.deepEqual(w.calls, []);
});

test('foreign reservation gets one attack intent and no competing reserve intent until it clears', () => {
    const w = world(), creep = w.unit();
    w.remote.controller.reservation = { username: 'other', ticksToEnd: 100 };
    const config = w.role(creep.memory.data);
    config.target(creep);
    assert.deepEqual(w.calls.map(call => call.type), ['attack']);
    w.calls.length = 0; delete w.remote.controller.reservation;
    config.target(creep);
    assert.deepEqual(w.calls.map(call => call.type), ['reserve', 'sign']);
});

for (const hook of ['prepare', 'source', 'target']) test(`moving a reservation flag updates the live ${hook} target`, () => {
    const w = world(), creep = w.unit(), config = w.role(creep.memory.data);
    w.flag.pos.roomName = w.another.name;
    config[hook](creep);
    assert.equal(creep.memory.data.targetRoom, w.another.name);
    assert.equal(creep.memory.dontPullMe, false);
    if (hook === 'target') assert.equal(w.calls[0].roomName, w.another.name);
});

for (const hook of ['prepare', 'source', 'target']) test(`deleted reservation flag stops the ${hook} hook and returns the reserver home`, () => {
    const w = world(), creep = w.unit(), config = w.role(creep.memory.data);
    delete w.game.flags[w.flagName];
    assert.equal(config[hook](creep), hook !== 'prepare');
    assert.deepEqual(w.calls.map(call => call.type), ['move']);
    assert.equal(w.calls[0].roomName, w.home.name);
    assert.equal(w.calls[0].options.range, 3);
    assert.equal(creep.memory.dontPullMe, false);
});

test('an idle cancelled reserver remains movable at home without issuing controller actions', () => {
    const w = world(), creep = w.unit(w.home);
    delete w.game.flags[w.flagName];
    assert.equal(w.role(creep.memory.data).prepare(creep), false);
    w.role(creep.memory.data).source(creep);
    w.role(creep.memory.data).target(creep);
    assert.deepEqual(w.calls, []);
    assert.equal(creep.memory.dontPullMe, false);
});

for (const owner of ['self', 'ally', 'enemy']) test(`a controller owned by ${owner} is never attacked or reserved by a flag reserver`, () => {
    const w = world(), creep = w.unit();
    w.remote.controller.owner = { username: owner };
    w.role(creep.memory.data).target(creep);
    assert.deepEqual(w.calls.map(call => call.type), ['move']);
    assert.equal(w.calls[0].roomName, w.home.name);
});

for (const invalid of ['no-controller', 'home-flag', 'wrong-home', 'lost-home']) test(`${invalid} flag reservation is inactive and returns home`, () => {
    const w = world(), creep = w.unit();
    if (invalid === 'no-controller') delete w.remote.controller;
    if (invalid === 'home-flag') w.flag.pos.roomName = w.home.name;
    if (invalid === 'wrong-home') creep.memory.data.reserveFlag = 'E11N1_RESERVE0';
    if (invalid === 'lost-home') w.home.my = false;
    assert.equal(w.role(creep.memory.data).prepare(creep), false);
    assert.deepEqual(w.calls.map(call => call.type), ['move']);
    assert.equal(w.calls[0].roomName, w.home.name);
    assert.equal(creep.memory.dontPullMe, false);
});

for (const reason of ['empire-war', 'home-war', 'current-war', 'target-war', 'evacuation', 'current-enemies', 'target-enemies']) test(`${reason} pauses reservation and retreats to home`, () => {
    const w = world(), creep = w.unit();
    if (reason === 'empire-war') w.memory.warMode.E11N1 = true;
    if (reason === 'home-war') { w.policy.warModeScope = 'room'; w.memory.warMode[w.home.name] = true; }
    if (reason === 'current-war') { w.policy.warModeScope = 'room'; w.memory.warMode[w.remote.name] = true; }
    if (reason === 'target-war') { w.policy.warModeScope = 'room'; w.memory.warMode[w.another.name] = true; w.flag.pos.roomName = w.another.name; }
    if (reason === 'evacuation') w.home.memory.evacuation = {};
    if (reason === 'current-enemies') w.remote.enemies.push({});
    if (reason === 'target-enemies') { w.another.enemies.push({}); w.flag.pos.roomName = w.another.name; }
    const config = w.role(creep.memory.data);
    assert.equal(config.prepare(creep), false);
    w.calls.length = 0;
    config.target(creep);
    assert.deepEqual(w.calls.map(call => call.type), ['move']);
    assert.equal(w.calls[0].roomName, w.home.name);
    assert.equal(creep.memory.dontPullMe, false);
});

test('a room outside a room-scoped war continues manual reservation', () => {
    const w = world(), creep = w.unit();
    w.policy.warModeScope = 'room'; w.memory.warMode.E11N1 = true;
    assert.equal(w.role(creep.memory.data).prepare(creep), true);
    w.role(creep.memory.data).target(creep);
    assert.deepEqual(w.calls.map(call => call.type), ['reserve', 'sign']);
});

for (const structureType of ['invaderCore', 'tower']) test(`a newly visible hostile ${structureType} withdraws a live flag reserver`, () => {
    const w = world(), creep = w.unit(), config = w.role(creep.memory.data);
    assert.equal(config.prepare(creep), true);
    w.remote.hostileStructures.push({ structureType });
    config.target(creep);
    assert.deepEqual(w.calls.map(call => call.type), ['move']);
    assert.equal(w.calls[0].roomName, w.home.name);
    assert.equal(creep.memory.dontPullMe, false);
});

test('a spawning flag reserver stays in prepare without issuing movement or boost intents', () => {
    const w = world(), creep = w.unit(w.home); creep.spawning = true;
    assert.equal(w.role(creep.memory.data).prepare(creep), false);
    assert.deepEqual(w.calls, []);
});

test('ordinary OUT and automatic reservers retain their existing 4800 threshold and flag-independent hooks', () => {
    const w = world(), creep = w.unit(w.remote, { targetRoom: w.remote.name }), config = w.role(creep.memory.data);
    w.memory.warMode[w.home.name] = true; w.remote.enemies.push({});
    assert.equal(config.prepare(creep), true); assert.equal(config.source(creep), true);
    assert.equal(creep.memory.working, true);
    w.remote.controller.reservation = { username: 'self', ticksToEnd: 4800 };
    w.remote.controller.sign = { text: 'reserved by ecbot' };
    config.target(creep);
    assert.deepEqual(w.calls, []);
    w.remote.controller.reservation.ticksToEnd = 4799;
    config.target(creep);
    assert.deepEqual(w.calls.map(call => call.type), ['reserve']);
    assert.equal(w.resolveCount(), 0);
    assert.equal(creep.memory.dontPullMe, true, 'legacy path remains unchanged');
});
