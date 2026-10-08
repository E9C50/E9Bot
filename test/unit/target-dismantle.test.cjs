const test = require('node:test');
const assert = require('node:assert/strict');
const { createCombatWorld, DIRECTIONS } = require('../helpers/combat-world.cjs');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

const roomName = 'E41N5';
function world(options = {}) {
    const w = createCombatWorld(), room = w.room(roomName), calls = [], travel = { status: 'arrived' };
    room.controller.pos = w.position(10, 37, roomName);
    const unit = w.unit('precise-worker', ['work', 'move'], { roomName, x: 12, y: 36 });
    unit.getActiveBodyparts = type => unit.body.filter(part => part.type === type && part.hits > 0).length;
    unit.dismantle = target => {
        unit.actions.push({ kind: 'dismantle', target: target.id });
        return unit.pos.getRangeTo(target.pos) > 1 ? -9 : options.dismantleResult ?? 0;
    };
    const barrier = w.structure('explicit-ram', 'rampart', { roomName, x: 11, y: 36, hits: 4211101 });
    unit.memory.role = 'sBuilder';
    unit.memory.boostPlan = { tier: 3, completed: true, steps: [{ type: 'boostDismantle', resource: 'XZH2O', parts: 1 }] };
    unit.memory.data = { missionId: 'precise-order', originShard: w.game.shard.name, route: [], hopIndex: 0 };
    unit.memory.targetDismantle = { targetShard: w.game.shard.name, targetRoom: roomName,
        targets: [{ id: barrier.id, x: 11, y: 36, type: 'rampart' }], controller: { x: 10, y: 37 } };
    const loader = createSourceLoader({ globals: { ...w.loader.globals, ERR_NOT_IN_RANGE: -9, ERR_NO_PATH: -2 }, modules: {
        'shard/travel': { travelPortalRoute(creep, data) { calls.push(['travel', data.hopIndex]); return travel; } },
    } });
    function remove(target) { w.structures.splice(w.structures.indexOf(target), 1); w.byId.delete(target.id); }
    return { ...w, newRoom: w.room, newUnit: w.unit, room, unit, barrier, calls, travel, loader, remove,
        run: () => loader.load('creep/targetDismantle').runTargetDismantle(unit) };
}

function completePathFinder(w) {
    let searches = 0;
    w.pathFinder.search = (start, goal, options = {}) => {
        searches++;
        const matrix = options.roomCallback?.(start.roomName), queue = [start], seen = new Set([`${start.x},${start.y}`]);
        for (let index = 0; index < queue.length; index++) {
            const point = queue[index];
            if (point.getRangeTo(goal.pos) <= goal.range) return { path: [], incomplete: false, ops: seen.size };
            for (let direction = 1; direction <= 8; direction++) {
                const [dx, dy] = DIRECTIONS[direction], x = point.x + dx, y = point.y + dy, key = `${x},${y}`;
                if (x < 0 || y < 0 || x > 49 || y > 49 || seen.has(key) || matrix?.get(x, y) === 255 ||
                    w.walls.get(`${start.roomName}:${x},${y}`) & 1) continue;
                seen.add(key); queue.push(w.position(x, y, start.roomName));
            }
        }
        return { path: [], incomplete: true, ops: seen.size };
    };
    return () => searches;
}

function flagWorld(options = {}) {
    const w = world(options), flagName = 'yellow-demolition';
    w.game.flags = { [flagName]: { pos: w.position(11, 36, roomName) } };
    w.unit.memory.targetDismantle = { targetShard: w.game.shard.name, targetRoom: '', targets: [], flagName };
    w.flagName = flagName;
    w.moveFlag = (x, y, name = roomName) => { w.game.flags[flagName] = { pos: w.position(x, y, name) }; };
    w.snapshot = () => w.loader.load('creep/targetDismantle').getFlagDismantleSnapshot(flagName);
    return w;
}

test('flag snapshots distinguish missing flags, unseen rooms, visible empty tiles and dismantle targets', () => {
    const w = flagWorld();
    assert.deepEqual({ ...w.snapshot() }, { roomName, x: 11, y: 36, hasWork: true });
    w.moveFlag(20, 20);
    assert.deepEqual({ ...w.snapshot() }, { roomName, x: 20, y: 20, hasWork: false });
    w.moveFlag(20, 20, 'E42N5');
    assert.deepEqual({ ...w.snapshot() }, { roomName: 'E42N5', x: 20, y: 20 });
    delete w.game.flags[w.flagName];
    assert.equal(w.snapshot(), null);
});

test('flag orders have no fixed room or controller and only dismantle the flag tile, with rampart cover first', () => {
    const w = flagWorld();
    w.structure('protected-spawn', 'spawn', { roomName, x: 11, y: 36 });
    w.structure('neighbour-wall', 'constructedWall', { roomName, x: 12, y: 35, owner: null });
    assert.equal(w.run(), true);
    assert.deepEqual(w.unit.actions, [{ kind: 'dismantle', target: w.barrier.id }]);
    assert.equal(w.unit.memory.targetDismantle.targetRoom, roomName);
    w.remove(w.barrier); w.unit.actions.length = 0; w.run();
    assert.deepEqual(w.unit.actions, [{ kind: 'dismantle', target: 'protected-spawn' }]);
    assert.equal(w.unit.memory.targetDismantle.done, undefined);
});

test('moving the flag changes the dismantle tile immediately without finishing or advancing a fixed target list', () => {
    const w = flagWorld();
    const other = w.structure('new-location', 'constructedWall', { roomName, x: 12, y: 35, owner: null });
    w.run(); w.unit.actions.length = 0;
    w.moveFlag(12, 35); w.run();
    assert.deepEqual(w.unit.actions, [{ kind: 'dismantle', target: other.id }]);
    assert.deepEqual({ ...w.unit.memory.targetDismantle.lastFlagPos }, { roomName, x: 12, y: 35 });
    assert.equal(w.unit.memory.targetDismantle.index, undefined);
    assert.equal(w.unit.memory.targetDismantle.done, undefined);
});

test('moving the flag to another room updates the approach room and never dismantles the previous room tile', () => {
    const w = flagWorld(); w.run(); w.unit.actions.length = 0;
    w.unit.memory.targetDismantle.waitPos = { x: 13, y: 39 };
    w.newRoom('E42N5'); w.moveFlag(20, 21, 'E42N5'); w.run();
    assert.equal(w.unit.memory.targetDismantle.targetRoom, 'E42N5');
    assert.equal(w.unit.memory.targetDismantle.waitPos, undefined);
    assert.equal(w.unit.actions.length, 1);
    assert.equal(w.unit.actions[0].kind, 'moveTo');
    assert.deepEqual(w.unit.actions[0].pos, w.position(20, 21, 'E42N5'));
    assert.equal(w.unit.actions[0].options.range, 1);
});

test('a flag in an unseen room can direct the worker there without declaring its tile clear', () => {
    const w = flagWorld(); w.moveFlag(20, 21, 'E42N5');
    assert.equal(w.snapshot().hasWork, undefined);
    w.run();
    assert.equal(w.unit.actions.at(-1).pos.roomName, 'E42N5');
    assert.equal(w.unit.memory.targetDismantle.done, undefined);
});

test('an empty flag tile parks off roads and away from the flag; moving or replacing the flag resumes work', () => {
    const w = flagWorld();
    w.moveFlag(12, 36); w.structure('traffic-road', 'road', { roomName, x: 12, y: 36, owner: null });
    // Roads are legal targets; clear this tile first, then leave it available to normal traffic.
    const road = w.byId.get('traffic-road'); w.remove(road);
    w.structure('beside-road', 'road', { roomName, x: 13, y: 36, owner: null });
    w.run();
    const order = w.unit.memory.targetDismantle;
    assert.ok(order.waitPos);
    assert.ok(Math.max(Math.abs(order.waitPos.x - 12), Math.abs(order.waitPos.y - 36)) > 2);
    assert.equal(w.room.lookForAt('structure', order.waitPos.x, order.waitPos.y).some(s => s.structureType === 'road'), false);
    assert.equal(w.unit.actions.some(a => a.kind === 'dismantle'), false);
    assert.equal(order.done, undefined);
    delete w.game.flags[w.flagName]; w.unit.actions.length = 0; w.run();
    assert.match(order.lastError, /Waiting for the dismantle flag/);
    assert.equal(w.unit.actions.some(a => a.kind === 'dismantle'), false);
    w.moveFlag(11, 36); w.unit.actions.length = 0; w.run();
    assert.deepEqual(w.unit.actions, [{ kind: 'dismantle', target: w.barrier.id }]);
    assert.equal(order.waitPos, undefined);
});

test('a same-named source-shard flag cannot retarget a worker before its portal route arrives on the target shard', () => {
    const w = flagWorld();
    w.unit.memory.targetDismantle.targetShard = 'shard2';
    w.travel.status = 'moving'; w.run();
    assert.equal(w.unit.memory.targetDismantle.targetRoom, '');
    assert.equal(w.unit.memory.targetDismantle.lastFlagPos, undefined);
    assert.equal(w.unit.actions.length, 0);
    w.travel.status = 'arrived'; w.run();
    assert.match(w.unit.memory.targetDismantle.lastError, /another shard/);
    assert.equal(w.unit.memory.targetDismantle.lastFlagPos, undefined);
    assert.equal(w.unit.actions.length, 0);
    w.game.shard.name = 'shard2'; w.run();
    assert.equal(w.unit.actions.at(-1).target, w.barrier.id);
});

test('paused, cancelled and failed-boost flag workers never travel or dismantle', () => {
    for (const state of ['paused', 'cancelled', 'completed', 'failed']) {
        const w = flagWorld();
        if (state === 'failed') w.unit.memory.boostPlan.failed = true;
        else w.unit.memory.targetDismantle.controlState = state;
        w.run();
        assert.equal(w.calls.length, 0, state);
        assert.equal(w.unit.actions.some(a => a.kind === 'dismantle'), false, state);
    }
});

test('cancelling during travel parks outside the spawn apron without needing a controller or target-room vision', () => {
    const w = flagWorld();
    w.unit.pos = w.position(25, 25, 'E41N6'); w.newRoom('E41N6');
    w.structure('home-spawn', 'spawn', { roomName: 'E41N6', x: 24, y: 25, my: true });
    w.structure('home-road', 'road', { roomName: 'E41N6', x: 25, y: 25, owner: null });
    w.unit.memory.targetDismantle.controlState = 'cancelled';
    w.run();
    const wait = w.unit.memory.targetDismantle.waitPos;
    assert.ok(wait);
    assert.ok(Math.max(Math.abs(wait.x - 24), Math.abs(wait.y - 25)) > 2);
    assert.equal(w.unit.actions.at(-1).kind, 'moveTo');
    assert.equal(w.calls.length, 0);
});

test('pausing after crossing rooms replaces the previous room parking tile with a nearby tile', () => {
    for (const legacy of [false, true]) {
        const w = flagWorld();
        w.moveFlag(20, 20); w.unit.pos = w.position(21, 20, roomName); w.run();
        const order = w.unit.memory.targetDismantle, previous = { ...order.waitPos };
        assert.equal(previous.roomName, roomName);
        if (legacy) delete order.waitPos.roomName;
        w.newRoom('E41N6'); w.unit.pos = w.position(40, 40, 'E41N6');
        order.controlState = 'paused'; w.unit.actions.length = 0; w.calls.length = 0;
        w.run();
        assert.equal(order.waitPos.roomName, 'E41N6');
        assert.ok(Math.max(Math.abs(order.waitPos.x - 40), Math.abs(order.waitPos.y - 40)) <= 5);
        assert.ok(order.waitPos.x !== previous.x || order.waitPos.y !== previous.y);
        assert.equal(w.calls.length, 0);
        assert.equal(w.unit.actions.some(a => a.kind === 'dismantle'), false);
        assert.equal(w.unit.actions.some(a => a.kind === 'moveTo' && a.pos.roomName !== 'E41N6'), false);
    }
});

test('illegal native targets, friendly ownership and adjacent targets are clear flag tiles with no dismantle intent', () => {
    for (const type of ['controller', 'portal', 'powerBank', 'keeperLair', 'invaderCore', 'unknown-structure']) {
        const w = flagWorld(); w.remove(w.barrier);
        w.structure(`banned-${type}`, type, { roomName, x: 11, y: 36 });
        assert.equal(w.snapshot().hasWork, false, type);
        w.run();
        assert.equal(w.unit.actions.some(a => a.kind === 'dismantle'), false, type);
    }
    for (const owner of ['mine', 'whitelist', 'friendly-room', 'own-room']) {
        const w = flagWorld();
        if (owner === 'mine') w.barrier.my = true;
        if (owner === 'whitelist') w.barrier.owner.username = 'NoName_';
        if (owner === 'friendly-room') w.room.controller.owner = { username: 'NoName_' };
        if (owner === 'own-room') w.room.controller.my = true;
        assert.equal(w.snapshot().hasWork, false, owner);
        w.run();
        assert.equal(w.unit.actions.some(a => a.kind === 'dismantle'), false, owner);
    }
    const w = flagWorld(); w.moveFlag(12, 36); w.run();
    assert.equal(w.snapshot().hasWork, false);
    assert.equal(w.unit.actions.some(a => a.kind === 'dismantle'), false);
});

test('unowned roads and containers are dismantle targets only outside own and allied rooms', () => {
    for (const type of ['road', 'container']) for (const owner of ['enemy', 'mine', 'whitelist']) {
        const w = flagWorld(); w.remove(w.barrier);
        w.structure(`unowned-${type}`, type, { roomName, x: 11, y: 36, owner: null });
        if (owner === 'mine') w.room.controller.my = true;
        if (owner === 'whitelist') w.room.controller.owner = { username: 'NoName_' };
        w.run();
        assert.equal(w.snapshot().hasWork, owner === 'enemy', `${type} ${owner}`);
        assert.equal(w.unit.actions.some(a => a.kind === 'dismantle'), owner === 'enemy', `${type} ${owner}`);
    }
});

test('safe mode and invulnerability preserve flag work but block dismantle intents', () => {
    const w = flagWorld();
    w.barrier.effects = [{ effect: 1001, ticksRemaining: 10 }]; w.run();
    assert.equal(w.snapshot().hasWork, true);
    assert.match(w.unit.memory.targetDismantle.lastError, /invulnerable/);
    w.barrier.effects = []; w.room.controller.safeMode = 100; w.run();
    assert.equal(w.snapshot().hasWork, true);
    assert.match(w.unit.memory.targetDismantle.lastError, /safe mode/);
    assert.equal(w.unit.actions.length, 0);
});

test('flag targets use native range-one movement and refuse to breach any other tile when no route exists', () => {
    const w = flagWorld(); w.unit.pos = w.position(20, 20, roomName);
    w.unit.moveTo = (target, options) => { w.unit.actions.push({ kind: 'moveTo', target: target.id, options }); return -2; };
    w.run();
    assert.equal(w.unit.actions.at(-1).target, w.barrier.id);
    assert.equal(w.unit.actions.at(-1).options.range, 1);
    assert.match(w.unit.memory.targetDismantle.lastError, /No path to the flag tile/);
    assert.equal(w.unit.memory.targetDismantle.done, undefined);
});

test('ordinary units are untouched, while invalid explicit orders are consumed without falling into Builder work', () => {
    const w = world();
    delete w.unit.memory.targetDismantle;
    assert.equal(w.run(), false);
    w.unit.memory.targetDismantle = { targetShard: w.game.shard.name, targetRoom: roomName, targets: [] };
    assert.equal(w.run(), true);
    assert.equal(w.unit.memory.targetDismantle.lastError, 'Invalid precise dismantle order');
    assert.equal(w.unit.actions.length, 0);
});

test('unfinished and failed boost plans never travel or dispatch the precise worker', () => {
    for (const failed of [false, true]) {
        const w = world();
        w.unit.memory.boostPlan.completed = false;
        w.unit.memory.boostPlan.failed = failed;
        assert.equal(w.run(), true);
        assert.equal(w.calls.length, 0);
        assert.equal(w.unit.actions.length, 0);
        assert.match(w.unit.memory.targetDismantle.lastError, failed ? /failed/ : /Waiting/);
    }
});

test('missing live WORK and invalid portal payloads stop the worker rather than allowing ordinary Builder work', () => {
    const w = world();
    w.unit.body[0].hits = 0; assert.equal(w.run(), true);
    assert.match(w.unit.memory.targetDismantle.lastError, /WORK/);
    w.unit.body[0].hits = 100; w.unit.memory.data = {}; assert.equal(w.run(), true);
    assert.match(w.unit.memory.targetDismantle.lastError, /portal/);
    assert.equal(w.unit.actions.length, 0);
});

test('cross-shard travel and target-room approach cannot interpret a missing remote ID as completion', () => {
    const w = world(); w.remove(w.barrier);
    w.travel.status = 'moving'; assert.equal(w.run(), true);
    assert.equal(w.unit.memory.targetDismantle.index, undefined);
    assert.equal(w.unit.memory.targetDismantle.done, undefined);
    w.travel.status = 'arrived'; w.unit.memory.targetDismantle.targetShard = 'shard2'; w.run();
    assert.match(w.unit.memory.targetDismantle.lastError, /another shard/);
    w.unit.memory.targetDismantle.targetShard = w.game.shard.name;
    w.newRoom('E41N6'); w.unit.pos = w.position(12, 36, 'E41N6'); w.run();
    assert.equal(w.unit.memory.targetDismantle.index, undefined);
    assert.equal(w.unit.actions.at(-1).kind, 'moveTo');
    assert.equal(w.unit.actions.at(-1).pos.roomName, roomName);
});

test('the worker dismantles only its exact explicit barrier and ignores nearby enemies, structures and other walls', () => {
    const w = world();
    w.structure('other-ram', 'rampart', { roomName, x: 12, y: 35 });
    w.structure('other-wall', 'constructedWall', { roomName, x: 13, y: 36, owner: null });
    w.structure('enemy-spawn', 'spawn', { roomName, x: 13, y: 35 });
    w.newUnit('enemy', ['move'], { roomName, my: false, x: 12, y: 37 });
    assert.equal(w.run(), true);
    assert.deepEqual(w.unit.actions, [{ kind: 'dismantle', target: 'explicit-ram' }]);
    assert.equal(w.unit.memory.dontPullMe, false);
    assert.equal(w.unit.memory.targetDismantle.done, undefined);
});

test('a finite explicit sequence advances only after its previous ID is gone', () => {
    const w = world();
    const second = w.structure('second-ram', 'rampart', { roomName, x: 12, y: 35 });
    w.unit.memory.targetDismantle.targets.push({ id: second.id, x: 12, y: 35, type: 'rampart' });
    w.run(); assert.equal(w.unit.actions.at(-1).target, 'explicit-ram');
    w.remove(w.barrier); w.unit.actions.length = 0; w.run();
    assert.equal(w.unit.memory.targetDismantle.index, 1);
    assert.deepEqual(w.unit.actions, [{ kind: 'dismantle', target: second.id }]);
});

test('changed type, position and friendly ownership never receive a dismantle intent', () => {
    for (const change of ['type', 'position', 'mine', 'whitelist']) {
        const w = world();
        if (change === 'type') w.barrier.structureType = 'spawn';
        if (change === 'position') w.barrier.pos = w.position(11, 35, roomName);
        if (change === 'mine') w.barrier.my = true;
        if (change === 'whitelist') w.barrier.owner.username = 'NoName_';
        assert.equal(w.run(), true);
        assert.equal(w.unit.actions.length, 0, change);
        assert.match(w.unit.memory.targetDismantle.lastError, /no longer matches/);
    }
});

test('protected barriers and foreign safe mode wait without changing the target sequence', () => {
    const w = world();
    w.barrier.effects = [{ effect: 1001, ticksRemaining: 10 }]; w.run();
    assert.match(w.unit.memory.targetDismantle.lastError, /invulnerable/);
    w.barrier.effects = []; w.room.controller.safeMode = 100; w.run();
    assert.match(w.unit.memory.targetDismantle.lastError, /safe mode/);
    assert.equal(w.unit.actions.length, 0);
    assert.equal(w.unit.memory.targetDismantle.index, undefined);
});

test('an out-of-range explicit barrier gets approach movement and no alternative barrier when the route fails', () => {
    const w = world(); w.unit.pos = w.position(20, 20, roomName);
    w.unit.moveTo = (target, options) => { w.unit.actions.push({ kind: 'moveTo', target: target.id, options }); return -2; };
    w.run();
    assert.equal(w.unit.actions.at(-1).target, w.barrier.id);
    assert.match(w.unit.memory.targetDismantle.lastError, /No path/);
    assert.equal(w.unit.memory.targetDismantle.index, undefined);
});

test('completion requires a real controller range-one route and then vacates the opening without Builder fallthrough', () => {
    const w = world(); completePathFinder(w);
    w.remove(w.barrier); w.unit.pos = w.position(11, 36, roomName);
    assert.equal(w.run(), true);
    const order = w.unit.memory.targetDismantle;
    assert.equal(order.done, true); assert.equal(order.index, 1);
    assert.ok(order.waitPos);
    assert.ok(Math.max(Math.abs(order.waitPos.x - 10), Math.abs(order.waitPos.y - 37)) > 2);
    assert.equal(w.unit.actions.at(-1).kind, 'moveTo');
    w.structure('new-ram', 'rampart', { roomName, x: 11, y: 36 });
    w.unit.actions.length = 0; assert.equal(w.run(), true);
    assert.equal(w.unit.actions.some(action => action.kind === 'dismantle'), false);
});

test('remaining unlisted barriers keep the order blocked, never retarget, and bound connectivity retries', () => {
    const w = world(), searches = completePathFinder(w);
    w.remove(w.barrier); w.unit.pos = w.position(15, 37, roomName);
    for (let y = 0; y < 50; y++) w.structure(`unlisted-${y}`, 'rampart', { roomName, x: 12, y });
    w.run();
    assert.equal(w.unit.memory.targetDismantle.done, undefined);
    assert.match(w.unit.memory.targetDismantle.lastError, /still unreachable/);
    for (let tick = 1; tick < 25; tick++) { w.game.time++; w.run(); }
    assert.equal(searches(), 1);
    assert.equal(w.unit.actions.length, 0);
    w.game.time++; w.run(); assert.equal(searches(), 2);
});

test('completed workers replace an occupied waiting tile instead of remaining in the reserver passage', () => {
    const w = world(); completePathFinder(w); w.remove(w.barrier);
    w.unit.pos = w.position(11, 36, roomName); w.run();
    const previous = { ...w.unit.memory.targetDismantle.waitPos };
    w.newUnit('occupant', ['move'], { roomName, x: previous.x, y: previous.y });
    w.unit.actions.length = 0; w.run();
    assert.notDeepEqual(w.unit.memory.targetDismantle.waitPos, previous);
    assert.equal(w.unit.actions.at(-1).kind, 'moveTo');
    assert.equal(w.unit.actions.some(action => action.kind === 'dismantle'), false);
});

test('the precise top-level order survives existing InterShardMemory transfer while remaining outside shardTask quotas', () => {
    const bus = {}, source = world(), destination = world();
    destination.game.shard.name = 'shard2';
    const hop = { shard: 'shard3', roomName: 'E40N5', x: 20, y: 20, destinationShard: 'shard2', destinationRoom: 'E40N5' };
    source.unit.memory.data = { missionId: 'precise-order', originShard: 'shard3', route: [hop], hopIndex: 0 };
    source.unit.memory.targetDismantle.targetShard = 'shard2';
    const transportLoader = w => createSourceLoader({ globals: { ...w.loader.globals, InterShardMemory: {
        getLocal: () => bus[w.game.shard.name] || '', getRemote: name => bus[name] || '',
        setLocal: value => { bus[w.game.shard.name] = value; },
    } } });
    const sourceLoader = transportLoader(source), targetLoader = transportLoader(destination);
    const outgoing = sourceLoader.load('shard/transport'), incoming = targetLoader.load('shard/transport');
    assert.equal(outgoing.publishCreepTransfer(source.unit, 'shard2', 1), true);
    assert.equal(outgoing.flushInterShardMemory(), true);
    destination.unit.memory = {};
    assert.equal(incoming.restoreArrivingCreeps(), 1);
    assert.equal(destination.unit.memory.role, 'sBuilder');
    assert.equal(destination.unit.memory.targetDismantle.targets[0].id, source.barrier.id);
    assert.equal(destination.unit.memory.data.hopIndex, 1);
    assert.equal(targetLoader.load('shard/missions').isShardUnitData(destination.unit.memory.data), false);
    assert.equal(targetLoader.load('creep/targetDismantle').runTargetDismantle(destination.unit), true);
    assert.equal(destination.unit.actions.at(-1).target, destination.barrier.id);
});
