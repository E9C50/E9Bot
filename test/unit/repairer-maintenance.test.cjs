const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world() {
    const objects = new Map(), candidates = new Map(), reads = new Map(), actions = [], pending = [];
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
        const blocked = new Set(), list = [], value = { name, level: 8, enemies: [], memory: {}, blocked,
            get wallsNeedRepair() { reads.set(name, (reads.get(name) || 0) + 1); return list; },
            getDefenderCostMatrix: () => ({ get: (x, y) => blocked.has(`${x},${y}`) ? 255 : 0 }) };
        candidates.set(name, { room: value, list });
        return value;
    }
    function barrier(id, local, hits = 1000000, type = 'rampart', x = 11) {
        const value = { id, hits, hitsMax: 300000000, structureType: type, room: local, pos: { x, y: 10, roomName: local.name } };
        if (type === 'rampart') value.my = true;
        objects.set(id, value); candidates.get(local.name).list.push(value); return value;
    }
    function unit(name = 'worker0', local = room(), target) {
        const data = { repairTarget: target?.id || '', sourceId: '' };
        const creep = { name, room: local, pos: { x: 10, y: 10, roomName: local.name }, memory: { data, working: true },
            store: { energy: 50, getFreeCapacity: () => 100 - creep.store.energy }, goBoost: () => true,
            say() {},
            repair(target) {
                actions.push({ action: 'repair', name, target: target.id, tick: game.time });
                pending.push({ action: 'repair', creep, target }); return 0;
            },
            moveTo(target) { actions.push({ action: 'move', name, target: target.id, tick: game.time }); return 0; },
            withdraw(target) {
                actions.push({ action: 'withdraw', name, target: target.id, tick: game.time });
                pending.push({ action: 'withdraw', creep, target }); return 0;
            },
        };
        return { creep, data, role: factory(data) };
    }
    // Resolve only in lifecycle cases: one unboosted WORK spends one energy per repair intent.
    function resolveIntents() {
        for (const { action, creep, target } of pending.splice(0)) {
            if (action === 'repair') {
                const energy = Math.min(1, creep.store.energy, Math.ceil((target.hitsMax - target.hits) / 100));
                if (energy > 0) { creep.store.energy -= energy; target.hits = Math.min(target.hitsMax, target.hits + energy * 100); }
            } else {
                const energy = Math.min(target.store.energy, creep.store.getFreeCapacity());
                target.store.energy -= energy; creep.store.energy += energy;
            }
        }
    }
    return { game, memory, loader, policy, actions, objects, candidates, reads, room, barrier, unit, resolveIntents,
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

test('a new one-hit rampart cannot replace a live cached target during its current energy round', () => {
    const w = world(), local = w.room(), target = w.barrier('high-wall', local), unit = w.unit('worker0', local, target);
    unit.role.target(unit.creep); assert.equal(w.repairs().length, 0);
    w.game.time++; const urgent = w.barrier('new-rampart', local, 1);
    unit.role.target(unit.creep);
    assert.equal(unit.data.repairTarget, target.id);
    assert.equal(w.repairs().length, 0, 'new urgency does not bypass the current high-wall cadence');
    for (w.game.time = 3; w.game.time <= 25; w.game.time++) unit.role.target(unit.creep);
    assert.deepEqual(w.repairs().map(value => value.target), Array(5).fill(target.id));
    assert.equal(w.reads.get(local.name) || 0, 0, 'a valid cached target never scans the new rampart');
    assert.notEqual(unit.data.repairTarget, urgent.id);
});

test('uncached workers scan once for the weakest target, retain equal-hit list order and keep it next tick', () => {
    const w = world(), local = w.room(), high = w.barrier('high', local);
    const first = w.barrier('first-critical', local, 50000), second = w.barrier('equal-critical', local, 50000);
    const units = [w.unit('worker0', local), w.unit('worker1', local)];
    for (const unit of units) unit.role.target(unit.creep);
    assert.equal(w.reads.get(local.name), 2, 'each uncached worker makes one linear selection pass');
    assert.deepEqual(w.repairs().map(value => value.target), [first.id, first.id]);
    w.game.time++; first.hits = 100001; second.hits = 5;
    for (const unit of units) unit.role.target(unit.creep);
    assert.equal(w.reads.get(local.name), 2);
    assert.ok(units.every(unit => unit.data.repairTarget === first.id));
    assert.deepEqual(w.candidates.get(local.name).list.map(value => value.id), [high.id, first.id, second.id],
        'selection cannot sort or modify the shared room list');
});

test('full, destroyed, foreign and other-room targets release their cache and select a valid local replacement', () => {
    for (const invalid of ['full', 'destroyed', 'foreign', 'other-room']) {
        const w = world(), local = w.room(), old = w.barrier('old-target', local, 5);
        const replacement = w.barrier('replacement', local, 50), unit = w.unit('worker0', local, old);
        if (invalid === 'full') old.hits = old.hitsMax;
        if (invalid === 'destroyed') { w.objects.delete(old.id); w.candidates.get(local.name).list.shift(); }
        if (invalid === 'foreign') old.my = false;
        if (invalid === 'other-room') { old.pos.roomName = 'W2N1'; old.room = w.room('W2N1'); }
        unit.role.target(unit.creep);
        assert.equal(unit.data.repairTarget, replacement.id, invalid);
        assert.deepEqual(w.repairs().map(value => value.target), [replacement.id], invalid);
        assert.equal(w.reads.get(local.name), 1, invalid);
    }
});

test('a cached target blocked by the war cost matrix is released without ever repairing an unreachable target', () => {
    const w = world(), local = w.room(), blocked = w.barrier('blocked', local, 1);
    const replacement = w.barrier('reachable', local, 50, 'rampart', 12), unit = w.unit('worker0', local, blocked);
    w.memory.warMode[local.name] = true; local.blocked.add(`${blocked.pos.x},${blocked.pos.y}`);
    unit.role.target(unit.creep);
    assert.equal(unit.data.repairTarget, replacement.id);
    assert.deepEqual(w.repairs().map(value => value.target), [replacement.id]);
});

test('a current critical target repairs every tick while a still-weaker new rampart remains unselected', () => {
    const w = world(), local = w.room(), current = w.barrier('current-critical', local, 50000);
    const unit = w.unit('worker0', local, current);
    w.barrier('new-weaker', local, 1);
    for (w.game.time = 1; w.game.time <= 5; w.game.time++) unit.role.target(unit.creep);
    assert.deepEqual(w.repairs().map(value => value.target), Array(5).fill(current.id));
    assert.equal(w.reads.get(local.name) || 0, 0);
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

test('repair intents consume the complete carried energy round before refilling and choosing a newly weaker target', () => {
    const w = world(), local = w.room(), original = w.barrier('first-round', local), unit = w.unit('worker0', local, original);
    w.game.cpu.bucket = w.policy.minimumBucket;
    unit.creep.store.energy = 2;
    unit.role.target(unit.creep); w.resolveIntents();
    assert.equal(unit.creep.store.energy, 1);
    const weaker = w.barrier('next-round', local, 1);
    w.game.time++; unit.role.target(unit.creep); w.resolveIntents();
    assert.equal(unit.creep.store.energy, 0);
    assert.deepEqual(w.repairs().map(value => value.target), [original.id, original.id]);
    assert.equal(original.hits, 1000200);
    assert.equal(w.reads.get(local.name) || 0, 0);
    assert.equal(unit.role.target(unit.creep), false);
    assert.equal(unit.creep.memory.working, false);
    assert.equal(unit.data.repairTarget, '');
    const storage = { id: 'storage', store: { energy: 1000 }, pos: { x: 11, y: 10, roomName: local.name } };
    w.objects.set(storage.id, storage); unit.data.sourceId = storage.id;
    w.game.time++; unit.role.source(unit.creep); w.resolveIntents();
    assert.equal(unit.creep.store.energy, 100);
    assert.equal(storage.store.energy, 900);
    assert.equal(unit.data.repairTarget, '');
    assert.equal(unit.role.source(unit.creep), false, 'the full carrying body returns to its target phase');
    assert.equal(unit.creep.memory.working, true);
    w.game.time++; unit.role.target(unit.creep);
    assert.equal(unit.data.repairTarget, weaker.id);
    assert.equal(w.repairs().at(-1).target, weaker.id);
    assert.equal(w.reads.get(local.name), 1, 'only the new energy round requires selection');
});

test('partial and stalled refills do not preselect a repair target before the working phase resumes', () => {
    const w = world(), local = w.room(), original = w.barrier('old-round', local), unit = w.unit('worker0', local, original);
    const storage = { id: 'storage', store: { energy: 25 }, pos: { x: 11, y: 10, roomName: local.name } };
    w.objects.set(storage.id, storage); unit.data.sourceId = storage.id;
    unit.creep.store.energy = 0; unit.creep.memory.working = false;
    unit.role.source(unit.creep); w.resolveIntents();
    assert.equal(unit.creep.store.energy, 25);
    assert.equal(unit.data.repairTarget, '');
    const weaker = w.barrier('newly-built', local, 1);
    w.game.time++; unit.role.source(unit.creep); w.resolveIntents();
    assert.equal(unit.creep.store.energy, 25, 'empty Storage leaves the worker in its refill phase');
    assert.equal(unit.creep.memory.working, false);
    assert.equal(unit.data.repairTarget, '');
    assert.equal(w.reads.get(local.name) || 0, 0);
    assert.equal(w.repairs().length, 0);
    storage.store.energy = 75;
    w.game.time++; unit.role.source(unit.creep); w.resolveIntents();
    assert.equal(unit.creep.store.energy, 100);
    assert.equal(unit.data.repairTarget, '');
    assert.equal(w.reads.get(local.name) || 0, 0);
    w.game.time++; assert.equal(unit.role.source(unit.creep), false);
    assert.equal(unit.creep.memory.working, true);
    assert.equal(unit.data.repairTarget, '');
    w.game.time++; unit.role.target(unit.creep);
    assert.equal(unit.data.repairTarget, weaker.id);
    assert.equal(w.repairs().at(-1).target, weaker.id);
});

test('every source entry clears a stale repair target before a full-body transition, withdrawal, movement or wait', () => {
    for (const phase of ['full', 'withdraw', 'distant', 'empty-source', 'missing-source']) {
        const w = world(), local = w.room(), target = w.barrier('stale-target', local), unit = w.unit('worker0', local, target);
        const storage = { id: 'storage', store: { energy: 1000 }, pos: { x: phase === 'distant' ? 20 : 11, y: 10, roomName: local.name } };
        w.objects.set(storage.id, storage); unit.data.sourceId = storage.id;
        unit.creep.memory.working = false;
        if (phase === 'full') unit.creep.store.energy = 100;
        if (phase === 'empty-source') storage.store.energy = 0;
        if (phase === 'missing-source') w.objects.delete(storage.id);
        unit.role.source(unit.creep);
        assert.equal(unit.data.repairTarget, '', phase);
        assert.equal(w.reads.get(local.name) || 0, 0, phase);
        assert.equal(w.repairs().length, 0, phase);
        if (phase === 'withdraw') assert.equal(w.actions.at(-1).action, 'withdraw');
        if (phase === 'distant') assert.equal(w.actions.at(-1).action, 'move');
        if (['full', 'empty-source', 'missing-source'].includes(phase)) assert.equal(w.actions.length, 0, phase);
    }
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
