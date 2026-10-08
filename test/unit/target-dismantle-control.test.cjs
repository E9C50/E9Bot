const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const { createCombatWorld } = require('../helpers/combat-world.cjs');

const route = [{ shard: 'shard3', roomName: 'E40N0', x: 20, y: 20, destinationShard: 'shard2', destinationRoom: 'E40N0' }];
function input(overrides = {}) {
    return { sourceRoom: 'E41N8', targetShard: 'shard2', targetRoom: 'E41N5', route,
        targets: [{ id: 'outer', x: 10, y: 35, type: 'rampart' }, { id: 'inner', x: 11, y: 36, type: 'rampart' }],
        controller: { x: 10, y: 37 }, maxEnergy: 180000, ...overrides };
}
function sharedWorld() {
    const bus = {}, clock = { now: 1000000 }, worlds = [], reads = [], writes = [];
    function runtime(shard = 'shard3') {
        const combat = createCombatWorld(), game = combat.game, memory = { creeps: {} }, calls = [], plans = [];
        game.shard.name = shard;
        const home = combat.room('E41N8', { my: true });
        home.energyCapacityAvailable = 5600; home.energyAvailable = 5600;
        let canBoost = true, spawnResult = 0;
        const spawn = { id: `spawn-${shard}`, spawning: null, spawnCreep(body, name, options) {
            calls.push({ body: [...body], name, memory: options.memory });
            if (spawnResult === 0) spawn.spawning = { name, remainingTime: 150 };
            return spawnResult;
        } };
        const find = home.find.bind(home);
        home.find = type => type === 'my-spawns' ? [spawn] : find(type);
        const loader = createSourceLoader({ globals: { ...combat.loader.globals, Game: game, Memory: memory,
            Date: class extends Date { static now() { return clock.now; } },
            StructureSpawn: class {}, BODYPART_COST: { work: 100, move: 50, carry: 50 },
            FIND_MY_SPAWNS: 'my-spawns', RESOURCE_CATALYZED_ZYNTHIUM_ACID: 'XZH2O', RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE: 'XZHO2',
            InterShardMemory: { getLocal: () => { reads.push(`${shard}:local`); return bus[shard] || ''; },
                getRemote: peer => { reads.push(`${shard}:${peer}`); return bus[peer] || ''; },
                setLocal: value => { writes.push(shard); bus[shard] = value; } },
        }, modules: { 'creep/boosting': {
            canPrepareBoosts(room, plan) { plans.push(JSON.parse(JSON.stringify(plan))); return canBoost; },
            reserveBoostPlan(room, name, plan) { calls.push({ reservation: name, plan }); },
        }, role: { isRoleSupported: () => true },
            'creep/bodySelection': { selectCreepBody: () => ({ body: ['move'], boostPlan: { tier: 0, steps: [] } }) },
        } });
        const api = loader.load('shard/targetDismantleControl'), transport = loader.load('shard/transport');
        const policy = loader.load('settings/interShard').interShardPolicy;
        policy.reportInterval = 1;
        function worker(name, payload, { roomName = 'E41N8', blank = false } = {}) {
            const unit = combat.unit(name, Array(40).fill('work').concat(Array(10).fill('move')), { roomName, x: 12, y: 36 });
            unit.memory = blank ? {} : JSON.parse(JSON.stringify(payload));
            unit.getActiveBodyparts = type => unit.body.filter(part => part.type === type && part.hits > 0).length;
            if (!blank) unit.memory.boostPlan.completed = true;
            return unit;
        }
        function born() {
            const call = calls.findLast(call => call.body);
            const unit = worker(call.name, call.memory); spawn.spawning = null;
            return unit;
        }
        function tick(milliseconds = 1000) {
            clock.now += milliseconds; game.time++;
            api.runTargetDismantleControl(); transport.flushInterShardMemory();
        }
        const state = { ...combat, game, memory, home, spawn, loader, api, transport, policy, calls, plans, born, worker, tick,
            task: () => Object.values(memory.targetDismantleTasks || {})[0],
            births: () => calls.filter(call => call.body), reservations: () => calls.filter(call => call.reservation),
            setCanBoost: value => { canBoost = value; }, setSpawnResult: value => { spawnResult = value; } };
        worlds.push(state); return state;
    }
    return { bus, clock, worlds, reads, writes, runtime };
}
function create(w, overrides = {}, id = 'entrance') { assert.match(w.api.createTargetDismantleTask(id, input(overrides)), /已创建/); return w.task(); }
function spawnAndArrive(shared, source, destination) {
    source.tick(); const unit = source.born(); source.tick();
    unit.memory.data.transferPreparedAt = source.game.time; source.tick();
    assert.equal(source.transport.publishCreepTransfer(unit, destination.game.shard.name, 1), true);
    source.transport.flushInterShardMemory(); delete source.game.creeps[unit.name];
    const arrival = destination.worker(unit.name, {}, { roomName: 'E41N5', blank: true });
    assert.equal(destination.transport.restoreArrivingCreeps(), 1);
    destination.tick(); source.tick(); return arrival;
}

test('valid explicit create clones configuration, broadcasts one independent task and reports budget/state', () => {
    const s = sharedWorld(), w = s.runtime(), options = input();
    assert.match(w.api.createTargetDismantleTask('entrance', options), /已创建/);
    options.targets[0].id = 'changed'; options.route[0].x = 3;
    assert.equal(w.task().input.targets[0].id, 'outer'); assert.equal(w.task().input.route[0].x, 20);
    assert.match(w.api.listTargetDismantleTasks(), /active.*180000/);
    assert.match(w.api.createTargetDismantleTask('entrance', input()), /已存在/);
    assert.equal(Object.keys(w.memory.targetDismantleTasks).length, 1);
    assert.equal(w.memory.shardMissions, undefined);
    assert.equal(JSON.parse(s.bus.shard3).ecbotShard.reports[w.task().key].type, 'targetDismantleCommand');
});

test('invalid targets/routes/budgets/ownership/capacity never create a task or reserve resources', () => {
    for (const overrides of [{ route: [] }, { route: [{ ...route[0], destinationShard: 'shard1' }] },
        { targets: [{ id: 'bad', x: 10, y: 35, type: 'spawn' }] }, { controller: { x: 50, y: 37 } },
        { targets: [input().targets[0], input().targets[0]] }, { maxEnergy: 4499 }, { targetShard: 'shard3' }]) {
        const w = sharedWorld().runtime();
        assert.doesNotMatch(w.api.createTargetDismantleTask('bad', input(overrides)), /已创建/);
        assert.equal(w.task(), undefined); assert.equal(w.calls.length, 0);
    }
    for (const change of ['capacity', 'ownership']) {
        const w = sharedWorld().runtime();
        if (change === 'capacity') w.home.energyCapacityAvailable = 3000; else w.home.controller.my = false;
        assert.doesNotMatch(w.api.createTargetDismantleTask('bad', input()), /已创建/);
    }
});

test('native spawning waits for full 4500 energy and exact boosts; reserves only after OK', () => {
    const w = sharedWorld().runtime(); create(w);
    w.home.energyAvailable = 4000; w.tick(); assert.equal(w.births().length, 0); assert.match(w.task().reason, /4500/);
    w.home.energyAvailable = 5600; w.setCanBoost(false); w.tick(); assert.equal(w.births().length, 0);
    assert.match(w.task().reason, /1200.*300/); assert.equal(w.task().spent, 0); assert.equal(w.reservations().length, 0);
    w.setCanBoost(true); w.setSpawnResult(-6); w.tick();
    assert.equal(w.task().spent, 0); assert.equal(w.task().lease, undefined); assert.equal(w.reservations().length, 0);
    w.setSpawnResult(0); w.tick();
    const call = w.births().at(-1);
    assert.equal(call.body.length, 50); assert.equal(call.body.filter(part => part === 'work').length, 40);
    assert.equal(call.body.filter(part => part === 'move').length, 10);
    assert.equal(call.memory.role, 'sBuilder'); assert.equal(call.memory.boostPlan.tier, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(call.memory.boostPlan.steps)), [
        { type: 'boostDismantle', resource: 'XZH2O', parts: 40 }, { type: 'boostMove', resource: 'XZHO2', parts: 10 },
    ]);
    assert.equal(w.task().spent, 4500); assert.equal(w.reservations().length, 1);
    assert.equal(w.loader.load('shard/missions').isShardUnitData(call.memory.data), false);
    for (let i = 0; i < 10; i++) w.tick();
    assert.equal(w.births().filter(call => call.name === w.task().lease.name).length, 1);
});

test('the local pending/spawning/alive slot persists and confirmed local death creates one replacement', () => {
    const w = sharedWorld().runtime(); create(w); w.tick(); const first = w.task().lease.name;
    for (let i = 0; i < 4; i++) w.tick(); assert.equal(w.births().length, 1);
    const unit = w.born(); unit.spawning = true; w.tick(); unit.spawning = false; w.tick();
    assert.equal(w.births().length, 1); delete w.game.creeps[first]; w.tick();
    assert.equal(w.births().length, 2); assert.notEqual(w.task().lease.name, first);
    assert.equal(w.task().generation, 2); assert.equal(w.task().spent, 9000);
});

test('empty destination reports do not release the source lease while the worker is travelling', () => {
    const s = sharedWorld(), source = s.runtime(), dest = s.runtime('shard2'); create(source);
    source.tick(); const unit = source.born(); source.tick(); dest.tick();
    unit.memory.data.transferPreparedAt = source.game.time; source.tick(); delete source.game.creeps[unit.name];
    dest.tick(61000); source.tick();
    assert.equal(source.task().lease.name, unit.name); assert.equal(source.births().length, 1);
    assert.equal(source.task().lease.lastShard, 'shard3'); assert.equal(source.task().lease.leaving, true);
});

test('real transfer/arrival ack/alive report preserve the slot; destination-confirmed death renews exactly once', () => {
    const s = sharedWorld(), source = s.runtime(), dest = s.runtime('shard2'); create(source);
    const arrival = spawnAndArrive(s, source, dest), first = arrival.name;
    assert.equal(source.task().lease.lastShard, 'shard2'); assert.equal(source.task().lease.confirmed, true);
    assert.equal(source.births().length, 1); assert.equal(arrival.memory.targetDismantle.controlState, 'active');
    dest.tick(); source.tick(); assert.equal(source.births().length, 1);
    delete dest.game.creeps[first]; dest.tick(30000); source.tick(); assert.equal(source.births().length, 1);
    dest.tick(31000); source.tick();
    assert.equal(source.births().length, 2); assert.equal(source.task().generation, 2); assert.equal(source.task().spent, 9000);
    source.tick(); assert.equal(source.births().length, 2);
});

test('stale, mismatched-generation and unconfirmed negative reports cannot free an arrival lease', () => {
    for (const change of ['stale', 'generation', 'unconfirmed']) {
        const s = sharedWorld(), source = s.runtime(), dest = s.runtime('shard2'); create(source);
        const arrival = spawnAndArrive(s, source, dest); delete dest.game.creeps[arrival.name];
        dest.tick(61000);
        const stored = JSON.parse(s.bus.shard2), status = stored.ecbotShard.reports[`${source.task().key}:status`];
        if (change === 'stale') status.updatedAt -= 100000;
        if (change === 'generation') status.generation = 0;
        if (change === 'unconfirmed') { source.task().lease.confirmed = false; stored.ecbotShard.acks = {}; }
        s.bus.shard2 = JSON.stringify(stored); source.tick();
        assert.equal(source.births().length, 1, change); assert.ok(source.task().lease, change);
    }
});

test('a missed cross-shard heartbeat pauses safely rather than duplicating an unconfirmed live slot', () => {
    const s = sharedWorld(), w = s.runtime(); create(w); w.tick(); const unit = w.born();
    unit.memory.data.transferPreparedAt = w.game.time; w.tick(); delete w.game.creeps[unit.name];
    w.tick(w.policy.leaseDuration + 1);
    assert.equal(w.task().state, 'paused'); assert.match(w.task().reason, /death is unconfirmed/);
    assert.equal(w.births().length, 1); assert.equal(w.task().lease.name, unit.name);
});

test('boost failures pause and remain consumed locally and after cross-shard restore', () => {
    for (const remote of [false, true]) {
        const s = sharedWorld(), source = s.runtime(), dest = s.runtime('shard2'); create(source);
        let unit;
        if (remote) unit = spawnAndArrive(s, source, dest);
        else { source.tick(); unit = source.born(); }
        unit.memory.boostPlan.failed = true; unit.memory.boostPlan.failureReason = 'lab timed out';
        if (remote) dest.tick(); source.tick();
        assert.equal(source.task().state, 'paused'); assert.match(source.task().reason, /Boost failed/);
        if (remote) dest.tick();
        assert.equal(unit.memory.targetDismantle.controlState, 'paused');
        const execution = (remote ? dest : source).loader.load('creep/targetDismantle');
        assert.equal(execution.runTargetDismantle(unit), true);
        assert.equal(unit.actions.some(action => action.kind === 'dismantle'), false);
        assert.equal(source.births().length, 1);
    }
});

test('budget pauses only after the current worker dies and never spends on a rejected native spawn', () => {
    const w = sharedWorld().runtime(); create(w, { maxEnergy: 4500 }); w.tick(); const unit = w.born(); w.tick();
    assert.equal(w.task().state, 'active'); delete w.game.creeps[unit.name]; w.tick();
    assert.equal(w.task().state, 'paused'); assert.match(w.task().reason, /budget exhausted/);
    assert.equal(w.task().spent, 4500); assert.equal(w.births().length, 1);
});

test('remote exact list + controller connectivity completion stops replenishment and leaves worker independent', () => {
    const s = sharedWorld(), source = s.runtime(), dest = s.runtime('shard2'); create(source);
    const unit = spawnAndArrive(s, source, dest), room = dest.game.rooms.E41N5;
    room.controller.pos = dest.position(10, 37, 'E41N5');
    dest.pathFinder.search = () => ({ path: [], incomplete: false });
    assert.equal(dest.loader.load('creep/targetDismantle').runTargetDismantle(unit), true);
    assert.equal(unit.memory.targetDismantle.done, true); assert.equal(unit.memory.targetDismantle.index, 2);
    dest.tick(); source.tick(); assert.equal(source.task().state, 'completed'); assert.equal(source.task().index, 2);
    delete dest.game.creeps[unit.name]; dest.tick(61000); source.tick();
    assert.equal(source.births().length, 1); assert.equal(source.task().state, 'completed');
    assert.match(source.api.listTargetDismantleTasks(), /completed/);
});

test('source cancel halts remote dismantling and pending transfers without adopting ordinary builder work', () => {
    const s = sharedWorld(), source = s.runtime(), dest = s.runtime('shard2'); create(source);
    const unit = spawnAndArrive(s, source, dest);
    assert.match(source.api.cancelTargetDismantleTask('entrance'), /已取消/); dest.tick();
    assert.equal(unit.memory.targetDismantle.controlState, 'cancelled');
    assert.equal(dest.loader.load('creep/targetDismantle').runTargetDismantle(unit), true);
    assert.equal(unit.actions.some(action => action.kind === 'dismantle'), false);
    unit.memory.targetDismantle.done = true; dest.tick(); source.tick();
    assert.equal(source.task().state, 'cancelled'); assert.equal(source.births().length, 1);
});

test('source command loss pauses a remote worker and a new source generation never adopts an old unit', () => {
    const s = sharedWorld(), source = s.runtime(), dest = s.runtime('shard2'); create(source);
    const unit = spawnAndArrive(s, source, dest);
    dest.tick(source.policy.reportMaxAge + 1); assert.equal(unit.memory.targetDismantle.controlState, 'paused');
    assert.match(unit.memory.targetDismantle.lastError, /heartbeat/);
    source.tick(); dest.tick(); assert.equal(unit.memory.targetDismantle.controlState, 'active');
    const stored = JSON.parse(s.bus.shard3); stored.ecbotShard.reports[source.task().key].generation++;
    s.bus.shard3 = JSON.stringify(stored); dest.tick();
    assert.equal(unit.memory.targetDismantle.controlState, 'cancelled');
    assert.match(unit.memory.targetDismantle.lastError, /Superseded/);
});

test('completion and cancellation history is bounded and expires without changing unrelated transport reports', () => {
    const s = sharedWorld(), w = s.runtime();
    for (let i = 0; i < 24; i++) {
        assert.match(w.api.createTargetDismantleTask(`old_${i}`, input()), /已创建/);
        w.api.cancelTargetDismantleTask(`old_${i}`); w.tick();
    }
    assert.equal(Object.keys(w.memory.targetDismantleTasks).length, 20);
    const state = w.transport.getLocalShardState(); state.reports.unrelated = { type: 'other', updatedAt: 0 };
    w.transport.markShardStateDirty(); w.transport.flushInterShardMemory();
    w.tick(w.policy.arrivalHistoryTtl + 1);
    assert.equal(Object.keys(w.memory.targetDismantleTasks).length, 0);
    assert.equal(Object.keys(w.transport.getLocalShardState().reports).filter(key => key.startsWith('targetDismantle:')).length, 0);
    assert.equal(w.transport.getLocalShardState().reports.unrelated.type, 'other');
});

test('malformed local communication rejects creation without leaving a phantom command or spawning', () => {
    const s = sharedWorld(); s.bus.shard3 = '{broken'; const w = s.runtime();
    assert.match(w.api.createTargetDismantleTask('entrance', input()), /未创建/);
    assert.equal(w.task(), undefined); w.tick(); assert.equal(w.births().length, 0);
    assert.equal(s.bus.shard3, '{broken');
});

test('new native births yield to economy/NPC defense queues and local evacuation or hostilities', () => {
    for (const condition of ['manager', 'filler', 'npcGuard', 'evacuation', 'war', 'hostile']) {
        const w = sharedWorld().runtime(); create(w);
        if (['manager', 'filler', 'npcGuard'].includes(condition)) {
            w.home.memory.creepConfig = { rescue: { role: condition === 'npcGuard' ? 'rdefender' : condition, spawnPriority: 3 } };
            w.home.memory.creepSpawnQueue = ['rescue'];
        }
        if (condition === 'evacuation') w.home.memory.evacuation = {};
        if (condition === 'war') w.memory.warMode = { E41N8: true };
        if (condition === 'hostile') w.unit('invader', ['attack'], { roomName: 'E41N8', my: false });
        w.tick(); assert.equal(w.births().length, 0, condition); assert.equal(w.task().spent, 0);
        w.home.memory.creepSpawnQueue = []; delete w.home.memory.evacuation;
        w.memory.warMode = {}; w.units.splice(0, w.units.length); w.tick();
        assert.equal(w.births().length, 1, condition);
    }
});

test('a real later SpawnExtension cannot overwrite or spend reserved room energy, and other rooms work', () => {
    const w = sharedWorld().runtime(); create(w); w.tick();
    const Spawn = w.loader.load('mount/structure/SpawnExtension').default, ordinary = new Spawn();
    ordinary.id = w.spawn.id; ordinary.room = w.home; ordinary.spawning = null;
    const attempts = []; ordinary.spawnCreep = (...args) => { attempts.push(args); return 0; };
    w.home.memory.creepConfig = { builder: { name: 'builder', role: 'builder', data: {}, spawnPriority: 4 } };
    w.home.memory.creepSpawnQueue = ['builder'];
    assert.equal(w.api.isTargetDismantleSpawnReserved(ordinary), true); ordinary.doWork();
    assert.equal(attempts.length, 0); assert.equal(w.home.memory.creepSpawnQueue.length, 1);
    ordinary.id = 'other-spawn'; assert.equal(w.api.isTargetDismantleSpawnReserved(ordinary), true); ordinary.doWork();
    assert.equal(attempts.length, 0);
    ordinary.room = { ...w.home, name: 'E42N8' };
    assert.equal(w.api.isTargetDismantleSpawnReserved(ordinary), false); ordinary.doWork();
    assert.equal(attempts.length, 1); assert.equal(attempts[0][1], 'builder');
    ordinary.id = w.spawn.id; w.game.time++;
    assert.equal(w.api.isTargetDismantleSpawnReserved(ordinary), false);
    assert.equal(w.api.isTargetDismantleSpawnReserved({}), false);
});

test('middle-shard pending transfer survives a missed short leaving report and empty status', () => {
    const s = sharedWorld(), source = s.runtime(), middle = s.runtime('shard2');
    create(source, { targetShard: 'shard1', route: [route[0],
        { shard: 'shard2', roomName: 'E40N0', x: 21, y: 20, destinationShard: 'shard1', destinationRoom: 'E40N0' }] });
    const unit = spawnAndArrive(s, source, middle);
    assert.equal(source.task().lease.lastShard, 'shard2'); assert.equal(source.task().lease.leaving, false);
    assert.equal(middle.transport.publishCreepTransfer(unit, 'shard1', 2), true); middle.transport.flushInterShardMemory();
    delete middle.game.creeps[unit.name]; middle.tick(61000); source.tick();
    assert.equal(source.births().length, 1); assert.equal(source.task().lease.name, unit.name);
    assert.equal(source.task().lease.leaving, true);
    // Even a fresh empty intermediate report, after its transfer expires, cannot prove final arrival/death.
    const stored = JSON.parse(s.bus.shard2); stored.ecbotShard.transfers = {}; s.bus.shard2 = JSON.stringify(stored);
    source.tick(); assert.equal(source.births().length, 1);
});

test('multi-hop alive/ack chain reaches the final destination before negative reports can release a slot', () => {
    const s = sharedWorld(), source = s.runtime(), middle = s.runtime('shard2'), final = s.runtime('shard1');
    create(source, { targetShard: 'shard1', route: [route[0],
        { shard: 'shard2', roomName: 'E40N0', x: 21, y: 20, destinationShard: 'shard1', destinationRoom: 'E40N0' }] });
    const unit = spawnAndArrive(s, source, middle);
    unit.memory.data.transferPreparedAt = middle.game.time; middle.tick();
    assert.equal(middle.transport.publishCreepTransfer(unit, 'shard1', 2), true); middle.transport.flushInterShardMemory();
    delete middle.game.creeps[unit.name];
    const arrival = final.worker(unit.name, {}, { roomName: 'E41N5', blank: true });
    assert.equal(final.transport.restoreArrivingCreeps(), 1); final.tick(); source.tick();
    assert.equal(source.task().lease.lastShard, 'shard1'); assert.equal(source.births().length, 1);
    delete final.game.creeps[arrival.name]; final.tick(61000); source.tick();
    assert.equal(source.births().length, 2);
});

test('reusing an id after history expiry creates a new instance and cannot reactivate old remote workers', () => {
    const s = sharedWorld(), source = s.runtime(), dest = s.runtime('shard2'); create(source);
    const unit = spawnAndArrive(s, source, dest), oldKey = source.task().key;
    source.api.cancelTargetDismantleTask('entrance'); dest.tick();
    source.tick(source.policy.arrivalHistoryTtl + 1);
    assert.equal(source.task(), undefined);
    create(source); source.tick(); dest.tick();
    assert.notEqual(source.task().key, oldKey); assert.equal(source.task().generation, 1);
    assert.equal(unit.memory.targetDismantle.generation, 1);
    assert.notEqual(unit.memory.targetDismantle.controlState, 'active');
    assert.notEqual(source.task().lease.name, unit.name);
});

test('an idle shard only discovers commands periodically and never writes empty reports', () => {
    const s = sharedWorld(), w = s.runtime(); w.policy.reportInterval = 10;
    for (let i = 0; i < 9; i++) { w.game.time++; w.api.runTargetDismantleControl(); }
    assert.equal(s.reads.length, 0); assert.equal(s.writes.length, 0);
    w.game.time++; w.api.runTargetDismantleControl();
    assert.equal(s.reads.length, 4); assert.equal(w.transport.getLocalShardState().reports, undefined);
    w.transport.flushInterShardMemory(); assert.equal(s.writes.length, 0);
});

test('TTL-only drift does not publish per-tick reports but progress changes do', () => {
    const s = sharedWorld(), source = s.runtime(), dest = s.runtime('shard2'); create(source);
    const unit = spawnAndArrive(s, source, dest); dest.policy.reportInterval = 10;
    const start = s.writes.length;
    for (let i = 0; i < 4; i++) { unit.ticksToLive--; dest.tick(); }
    assert.equal(s.writes.length, start);
    unit.memory.targetDismantle.index = 1; dest.tick();
    assert.equal(s.writes.length, start + 1);
});

test('commands for other routes do not force an unrelated shard into every-tick discovery or reports', () => {
    const s = sharedWorld(), source = s.runtime(), unrelated = s.runtime('shard0'); create(source);
    unrelated.policy.reportInterval = 10; unrelated.api.runTargetDismantleControl();
    const start = s.reads.length;
    for (let i = 0; i < 9; i++) { unrelated.game.time++; unrelated.api.runTargetDismantleControl(); }
    assert.equal(s.reads.length, start);
    assert.equal(unrelated.transport.getLocalShardState().reports, undefined);
});
