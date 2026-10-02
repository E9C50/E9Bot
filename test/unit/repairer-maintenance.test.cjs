const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world() {
    const objects = new Map(), candidates = new Map(), reads = new Map(), actions = [];
    const game = { time: 1, shard: { name: 'shard3' }, cpu: { bucket: 9 },
        getObjectById: id => objects.get(id) || null };
    const memory = { warMode: {} };
    const loader = createSourceLoader({ globals: { Game: game, Memory: memory, RESOURCE_ENERGY: 'energy',
        STRUCTURE_WALL: 'constructedWall', STRUCTURE_RAMPART: 'rampart' }, modules: {
        utils: { getDistance: (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) },
        './RoleBaseUpgrader': () => ({ target(creep) { actions.push({ action: 'upgrade', name: creep.name }); return true; } }),
    } });
    const policy = loader.load('settings/rolePolicy').rolePolicy.repairer.cpuMaintenance;
    const factory = loader.load('role/base/RoleBaseRepairer').default;
    function room(name = 'W1N1') {
        if (candidates.has(name)) return candidates.get(name).room;
        const list = [], value = { name, level: 8, enemies: [], memory: {},
            get wallsNeedRepair() { reads.set(name, (reads.get(name) || 0) + 1); return list; },
            getDefenderCostMatrix: () => ({ get: () => 0 }) };
        candidates.set(name, { room: value, list });
        return value;
    }
    function barrier(id, local, hits = 1000000, type = 'rampart', x = 11) {
        const value = { id, hits, hitsMax: 300000000, structureType: type, pos: { x, y: 10, roomName: local.name } };
        objects.set(id, value); candidates.get(local.name).list.push(value); return value;
    }
    function unit(name = 'worker0', local = room(), target) {
        const data = { repairTarget: target?.id || '', sourceId: '' };
        const creep = { name, room: local, pos: { x: 10, y: 10, roomName: local.name }, memory: { data, working: true },
            store: { energy: 50, getFreeCapacity: () => 50 }, goBoost: () => true,
            say() {},
            repair(target) { actions.push({ action: 'repair', name, target: target.id, tick: game.time }); return 0; },
            moveTo(target) { actions.push({ action: 'move', name, target: target.id, tick: game.time }); return 0; },
            withdraw(target) { actions.push({ action: 'withdraw', name, target: target.id, tick: game.time }); return 0; },
        };
        return { creep, data, role: factory(data) };
    }
    return { game, memory, loader, policy, actions, objects, candidates, reads, room, barrier, unit,
        repairs: () => actions.filter(value => value.action === 'repair') };
}

test('ten peaceful high-barrier repairers spread fifty maintenance intents across twenty-five low-bucket ticks', () => {
    const w = world();
    const units = Array.from({ length: 10 }, (_, index) => {
        const local = w.room(`W${index}N1`), target = w.barrier(`wall-${index}`, local);
        return w.unit(`worker${index}`, local, target);
    });
    for (w.game.time = 1; w.game.time <= 25; w.game.time++) for (const unit of units) unit.role.target(unit.creep);
    assert.equal(w.repairs().length, 50, 'normal every-tick execution would issue 250 maintenance intents');
    for (const unit of units) assert.equal(w.repairs().filter(value => value.name === unit.creep.name).length, 5);
    const counts = new Map();
    for (const action of w.repairs()) counts.set(action.tick, (counts.get(action.tick) || 0) + 1);
    assert.equal(Math.max(...counts.values()), 2, 'maintenance does not create one shared modulo spike');
    assert.equal(w.actions.some(value => value.action === 'upgrade'), false);
    for (const unit of units) assert.equal(unit.data.repairTarget, `wall-${unit.creep.name.slice(-1)}`);
});

test('sufficient bucket preserves every-tick maintenance without critical candidate scans', () => {
    const w = world(); w.game.cpu.bucket = w.policy.minimumBucket;
    const local = w.room(), target = w.barrier('healthy-wall', local), unit = w.unit('worker0', local, target);
    for (w.game.time = 1; w.game.time <= 5; w.game.time++) unit.role.target(unit.creep);
    assert.equal(w.repairs().length, 5); assert.equal(w.reads.get(local.name) || 0, 0);
});

test('known war mode or actual enemies bypass the low-bucket budget immediately', () => {
    for (const danger of ['warMode', 'enemies']) {
        const w = world(), local = w.room(), target = w.barrier('healthy-wall', local), unit = w.unit('worker0', local, target);
        if (danger === 'warMode') w.memory.warMode[local.name] = true;
        else local.enemies.push({ id: 'new-hostile' });
        for (w.game.time = 1; w.game.time <= 5; w.game.time++) unit.role.target(unit.creep);
        assert.equal(w.repairs().length, 5, danger); assert.equal(w.reads.get(local.name) || 0, 0);
    }
});

test('a new one-hit rampart next tick supersedes a high cached target even on a deferred maintenance turn', () => {
    const w = world(), local = w.room(), target = w.barrier('high-wall', local), unit = w.unit('worker0', local, target);
    unit.role.target(unit.creep); assert.equal(w.repairs().length, 0);
    w.game.time++; const urgent = w.barrier('new-rampart', local, 1);
    unit.role.target(unit.creep);
    assert.equal(unit.data.repairTarget, urgent.id);
    assert.deepEqual(w.repairs().map(value => value.target), [urgent.id]);
});

test('one critical index is shared by all repairers in a room, retains weakest-target ties, and expires next tick', () => {
    const w = world(), local = w.room(), high = w.barrier('high', local);
    const first = w.barrier('first-critical', local, 50000), second = w.barrier('equal-critical', local, 50000);
    const units = [w.unit('worker0', local, high), w.unit('worker1', local, high)];
    for (const unit of units) unit.role.target(unit.creep);
    assert.equal(w.reads.get(local.name), 1);
    assert.deepEqual(w.repairs().map(value => value.target), [first.id, first.id]);
    w.game.time++; first.hits = 100001; second.hits = 5;
    for (const unit of units) unit.role.target(unit.creep);
    assert.equal(w.reads.get(local.name), 2);
    assert.deepEqual(w.repairs().slice(2).map(value => value.target), [second.id, second.id]);
});

test('critical target destruction and shard changes invalidate the tick-local critical index', () => {
    const w = world(), local = w.room(), high = w.barrier('high', local), urgent = w.barrier('urgent', local, 5);
    const unit = w.unit('worker0', local, high); unit.role.target(unit.creep);
    w.game.time++; w.objects.delete(urgent.id); w.candidates.get(local.name).list.splice(1, 1);
    const replacement = w.barrier('replacement', local, 10); unit.role.target(unit.creep);
    assert.equal(w.repairs().at(-1).target, replacement.id);
    w.game.shard.name = 'shard2'; replacement.hits = 200000;
    const next = w.barrier('new-shard-critical', local, 1); unit.role.target(unit.creep);
    assert.equal(w.repairs().at(-1).target, next.id);
});

test('the exact critical-hit boundary repairs immediately on every turn and distant critical targets still move', () => {
    const w = world(), local = w.room(), critical = w.barrier('critical-wall', local, w.policy.criticalHits, 'constructedWall');
    const unit = w.unit('worker0', local, critical);
    for (w.game.time = 1; w.game.time <= 5; w.game.time++) unit.role.target(unit.creep);
    assert.equal(w.repairs().length, 5);
    w.game.time++; critical.pos.x = 20; unit.role.target(unit.creep);
    assert.equal(w.actions.at(-1).action, 'move'); assert.equal(w.actions.at(-1).target, critical.id);
});

test('source withdrawal and the empty-energy phase transition are unaffected by low-bucket maintenance scheduling', () => {
    const w = world(), local = w.room(), high = w.barrier('high', local), unit = w.unit('worker0', local, high);
    const storage = { id: 'storage', store: { energy: 10000 }, pos: { x: 11, y: 10, roomName: local.name } };
    w.objects.set(storage.id, storage); unit.data.sourceId = storage.id;
    unit.role.source(unit.creep); assert.equal(w.actions.at(-1).action, 'withdraw');
    unit.creep.store.energy = 0;
    assert.equal(unit.role.target(unit.creep), false);
    assert.equal(unit.creep.memory.working, false); assert.equal(unit.data.repairTarget, '');
});

test('when barriers are already complete the existing upgrader fallback is preserved', () => {
    const w = world(), local = w.room(), unit = w.unit('worker0', local);
    unit.role.target(unit.creep);
    assert.deepEqual(w.actions.map(value => value.action), ['upgrade']);
});

test('non-barrier cached repair targets remain immediate even when their hits exceed the critical barrier limit', () => {
    const w = world(), local = w.room();
    const container = { id: 'container', structureType: 'container', hits: 249999, hitsMax: 250000,
        pos: { x: 11, y: 10, roomName: local.name } };
    w.objects.set(container.id, container); const unit = w.unit('worker0', local, container);
    unit.role.target(unit.creep); assert.deepEqual(w.repairs().map(value => value.target), [container.id]);
});
