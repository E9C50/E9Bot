const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world() {
    const calls = [], objects = new Map();
    class Position {
        constructor(x, y, roomName = 'E41N5') { Object.assign(this, { x, y, roomName }); }
    }
    const store = (energy, capacity = 900, minerals = 0) => ({ energy, ...(minerals ? { H: minerals } : {}),
        getFreeCapacity: () => capacity - energy - minerals, getUsedCapacity: () => energy + minerals });
    const home = { name: 'E41N6', memory: { remoteCommissioning: { rooms: { E41N5: { kind: 'manual',
        sources: { first: { id: 'first', x: 25, y: 26 }, second: { id: 'second', x: 39, y: 35 } } } } } } };
    const remote = { name: 'E41N5', containers: [], droppedResource: [], sources: [
        { id: 'first', pos: new Position(25, 26) }, { id: 'second', pos: new Position(39, 35) } ],
        memory: {}, my: false, powerBanks: [], spawns: [], extensions: [] };
    const game = { time: 100, shard: { name: 'shard2' }, flags: {}, creeps: {}, rooms: { [home.name]: home, [remote.name]: remote },
        getObjectById: id => objects.get(id) || null };
    const loader = createSourceLoader({ globals: { Game: game, RoomPosition: Position,
        RESOURCE_ENERGY: 'energy', STRUCTURE_CONTAINER: 'container', OK: 0, ERR_NOT_IN_RANGE: -9 }, modules: {
        'creep/haulerDelivery': { withHaulerTraffic: behavior => behavior, deliverHaulerEnergy() {} },
        utils: { getDistance: (a, b) => a.roomName === b.roomName ? Math.max(Math.abs(a.x-b.x), Math.abs(a.y-b.y)) : Infinity,
            getClosestTarget: (_pos, targets) => targets[0] },
        'role/support/towers': { supportWithTowers() {} },
    } });
    const factory = loader.load('role/adv/RoleAdvRemoteFiller').default;
    function container(id, x, y, energy = 1000) {
        const item = { id, structureType: 'container', pos: new Position(x, y), store: store(energy, 2000) };
        objects.set(id, item); remote.containers.push(item); return item;
    }
    function dropped(id, x, y, amount, resourceType = 'energy') {
        const item = { id, pos: new Position(x, y), amount, resourceType };
        objects.set(id, item); remote.droppedResource.push(item); return item;
    }
    function unit(sourceFlag = 'second', energy = 0, room = remote) {
        const data = { sourceFlag, targetFlag: 'spawn' };
        const creep = { name: 'hauler-' + Object.keys(game.creeps).length, room, pos: new Position(26, 23, room.name),
            memory: { role: 'rFiller', spawnRoom: home.name, working: false, data }, store: store(energy),
            moveTo(target, options) { calls.push({ type: 'move', target: target.id || { ...target }, options: { ...options } }); return 0; },
            withdraw(target, resource) { calls.push({ type: 'withdraw', id: target.id, resource }); return 0; },
            pickup(target) { calls.push({ type: 'pickup', id: target.id }); return 0; },
            pickupDroppedResource() { throw Error('OUT collection must not scan arbitrary resources throughout the room'); },
            say() {}, hits: 100, hitsMax: 100 };
        game.creeps[creep.name] = creep;
        return { creep, data, run: () => factory(data).source(creep) };
    }
    return { calls, objects, game, home, remote, container, dropped, unit, loader };
}

test('manual two-Source haulers collect only their assigned Source even beside the other full container', () => {
    const w = world(); w.container('first-bin', 26, 25, 2000); w.container('second-bin', 40, 34, 1000);
    const first = w.unit('first'), second = w.unit('second');
    first.run(); second.run();
    assert.deepEqual(w.calls, [ { type: 'withdraw', id: 'first-bin', resource: 'energy' },
        { type: 'withdraw', id: 'second-bin', resource: 'energy' } ]);
    assert.equal(second.data.withdrawTarget, 'second-bin');
});

test('an old wrong-Source or unrelated structure cache is discarded instead of draining another lane', () => {
    for (const cached of ['first-bin', 'depot']) {
        const w = world(); w.container('first-bin', 26, 25, 2000); w.container('second-bin', 40, 34, 1000);
        w.objects.set('depot', { id: 'depot', structureType: 'storage', pos: { x: 40, y: 34, roomName: w.remote.name }, store: { energy: 10000 } });
        const unit = w.unit(); unit.data.withdrawTarget = cached; unit.run();
        assert.deepEqual(w.calls, [{ type: 'withdraw', id: 'second-bin', resource: 'energy' }]);
        assert.equal(unit.data.withdrawTarget, 'second-bin');
    }
});

test('unseen manual Sources use commissioning coordinates for outward travel without waiting for another creep to supply vision', () => {
    const w = world(); delete w.game.rooms[w.remote.name];
    const unit = w.unit('second', 0, w.home); assert.equal(unit.run(), true);
    assert.deepEqual(w.calls, [{ type: 'move', target: { x: 39, y: 35, roomName: 'E41N5' }, options: { range: 3 } }]);
});

test('an empty assigned lane waits at its own Source instead of visiting the first Source or draining its full container', () => {
    const w = world(); w.container('first-bin', 26, 25, 2000); w.container('empty-second-bin', 40, 34, 0);
    const unit = w.unit(); unit.data.withdrawTarget = 'empty-second-bin'; unit.run();
    assert.deepEqual(w.calls, [{ type: 'move', target: { x: 39, y: 35, roomName: 'E41N5' }, options: { range: 3 } }]);
    assert.equal(unit.data.withdrawTarget, undefined);
});

test('manual loading recovers only assigned Source energy piles and respects native pickup reservations', () => {
    const w = world(); w.dropped('other-lane', 26, 25, 10000); w.dropped('mineral', 40, 34, 10000, 'H');
    w.dropped('assigned-energy', 40, 34, 1200); w.container('second-bin', 40, 34, 1000);
    const first = w.unit(), second = w.unit(); first.run(); second.run();
    assert.deepEqual(w.calls, [{ type: 'pickup', id: 'assigned-energy' }, { type: 'withdraw', id: 'second-bin', resource: 'energy' }]);
    assert.equal(first.creep.store.energy, 0, 'accepted intents do not project next-tick cargo into the native snapshot');
});

test('a loaded or partially loaded manual hauler returns rather than waiting indefinitely for an empty Source', () => {
    for (const energy of [100, 900]) {
        const w = world(); w.container('first-bin', 26, 25, 2000); const unit = w.unit('second', energy);
        assert.equal(unit.run(), false); assert.equal(unit.creep.memory.working, true);
        assert.deepEqual(w.calls, []);
    }
});

test('arbitrary RF source flags retain their resource hauling behavior and never bind to a commissioned Source', () => {
    const w = world(); const unit = w.unit('E41N6_RF_S0');
    assert.equal(w.loader.load('creep/manualRemoteHauling').collectManualRemoteEnergy(unit.creep, unit.data), undefined);
    w.game.flags.second = { pos: { x: 5, y: 5, roomName: 'E42N6' } };
    unit.data.sourceFlag = 'second';
    assert.equal(w.loader.load('creep/manualRemoteHauling').collectManualRemoteEnergy(unit.creep, unit.data), undefined,
        'an explicit named flag takes precedence even if its name resembles a Source id');
    assert.deepEqual(w.calls, []);
});
