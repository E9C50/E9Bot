const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const { createCombatWorld } = require('../helpers/combat-world.cjs');
const BOOST_CONFIG = { boostMove: ['ZO', 'ZHO2', 'XZHO2'], boostDismantle: ['ZH', 'ZH2O', 'XZH2O'],
    boostTough: ['GO', 'GHO2', 'XGHO2'], boostHeal: ['LO', 'LHO2', 'XLHO2'] };
const BOOST_PARTS = { boostMove: 'move', boostDismantle: 'work', boostTough: 'tough', boostHeal: 'heal' };
const BOOST_TYPES = { BoostTypeMove: 'boostMove', BoostTypeDismantle: 'boostDismantle',
    BoostTypeTough: 'boostTough', BoostTypeHeal: 'boostHeal' };

const route = [{ shard: 'shard3', roomName: 'E40N0', x: 20, y: 20, destinationShard: 'shard2', destinationRoom: 'E40N0' }];
function input(overrides = {}) {
    return { sourceRoom: 'E41N8', targetShard: 'shard2', targetRoom: 'E41N5', route,
        targets: [{ id: 'outer', x: 10, y: 35, type: 'rampart' }, { id: 'inner', x: 11, y: 36, type: 'rampart' }],
        controller: { x: 10, y: 37 }, maxEnergy: 180000, ...overrides };
}
function sharedWorld() {
    const bus = {}, clock = { now: 1000000 }, worlds = [], reads = [], writes = [];
    function runtime(shard = 'shard3', restoredMemory) {
        const combat = createCombatWorld(), game = combat.game, memory = restoredMemory || { creeps: {} }, calls = [], plans = [], routes = [];
        game.shard.name = shard;
        game.flags = {};
        for (const [index, resource] of BOOST_CONFIG.boostMove.entries()) combat.loader.globals.BOOSTS.move[resource] = { fatigue: index + 2 };
        const home = combat.room('E41N8', { my: true });
        home.energyCapacityAvailable = 5600; home.energyAvailable = 5600;
        let canBoost = true, spawnResult = 0, boostIndexInvalidations = 0, failWrites = false;
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
            MAX_CREEP_SIZE: 50,
            FIND_MY_SPAWNS: 'my-spawns', RESOURCE_CATALYZED_ZYNTHIUM_ACID: 'XZH2O', RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE: 'XZHO2',
            InterShardMemory: { getLocal: () => { reads.push(`${shard}:local`); return bus[shard] || ''; },
                getRemote: peer => { reads.push(`${shard}:${peer}`); return bus[peer] || ''; },
                setLocal: value => { writes.push(shard); if (failWrites) throw new Error('temporary write failure'); bus[shard] = value; } },
        }, modules: { 'settings/boost': { boostConfig: BOOST_CONFIG, boostBodyPart: BOOST_PARTS, boostTypeEnum: BOOST_TYPES },
            'creep/boosting': {
            invalidateBoostRequestIndex() { boostIndexInvalidations++; },
            canPrepareBoosts(room, plan) { plans.push(JSON.parse(JSON.stringify(plan))); return canBoost; },
            reserveBoostPlan(room, name, plan) { calls.push({ reservation: name, plan }); },
        }, role: { isRoleSupported: () => true },
            'creep/bodySelection': { selectCreepBody: () => ({ body: ['move'], boostPlan: { tier: 0, steps: [] } }) },
            './routeCache': { storePortalRoute(...args) { routes.push(JSON.parse(JSON.stringify(args))); return true; } },
            './portalIntel': { getKnownPortals: () => route.map(hop => ({ ...hop })) },
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
        const state = { ...combat, game, memory, home, spawn, loader, api, transport, policy, calls, plans, routes, born, worker, tick,
            task: () => Object.values(memory.targetDismantleTasks || {})[0],
            births: () => calls.filter(call => call.body), reservations: () => calls.filter(call => call.reservation),
            boostIndexInvalidations: () => boostIndexInvalidations,
            setCanBoost: value => { canBoost = value; }, setSpawnResult: value => { spawnResult = value; } };
        state.setWriteFailure = value => { failWrites = value; };
        worlds.push(state); return state;
    }
    return { bus, clock, worlds, reads, writes, runtime };
}
function create(w, overrides = {}, id = 'entrance') { assert.match(w.api.createTargetDismantleTask(id, input(overrides)), /已创建/); return w.task(); }
function placeFlag(w, name = 'yellow', { roomName = 'E41N5', x = 10, y = 35, work = false, visible = true } = {}) {
    w.game.flags[name] = { name, pos: w.position(x, y, roomName) };
    if (visible) w.room(roomName); else delete w.game.rooms[roomName];
    if (work) w.structure(`flag-${name}-${x}-${y}`, 'rampart', { roomName, x, y });
    return w.game.flags[name];
}
function createFlag(w, options = {}, name = 'yellow') {
    assert.match(w.api.createFlagDismantleTask('E41N8', name, { id: 'entrance', ...options }), /已创建/);
    return w.task();
}
function spawnAndArrive(shared, source, destination) {
    source.tick(); const unit = source.born(); source.tick();
    unit.memory.data.transferPreparedAt = source.game.time; source.tick();
    assert.equal(source.transport.publishCreepTransfer(unit, destination.game.shard.name, 1), true);
    source.transport.flushInterShardMemory(); delete source.game.creeps[unit.name];
    const arrival = destination.worker(unit.name, {}, { roomName: 'E41N5', blank: true });
    destination.game.time++; // Arrival is a new tick, after any earlier empty status cached the source.
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
        if (change === 'capacity') w.home.energyCapacityAvailable = 100; else w.home.controller.my = false;
        assert.doesNotMatch(w.api.createTargetDismantleTask('bad', input()), /已创建/);
    }
});

test('native spawning waits for full 4500 energy and exact boosts; reserves only after OK', () => {
    const w = sharedWorld().runtime(); create(w);
    w.home.energyAvailable = 4000; w.tick(); assert.equal(w.births().length, 0); assert.match(w.task().reason, /4500/);
    w.home.energyAvailable = 5600; w.setCanBoost(false); w.tick(); assert.equal(w.births().length, 0);
    assert.match(w.task().reason, /300.*1200/); assert.equal(w.task().spent, 0); assert.equal(w.reservations().length, 0);
    w.setCanBoost(true); w.setSpawnResult(-6); w.tick();
    assert.equal(w.task().spent, 0); assert.equal(w.task().lease, undefined); assert.equal(w.reservations().length, 0);
    w.setSpawnResult(0); w.tick();
    const call = w.births().at(-1);
    assert.equal(call.body.length, 50); assert.equal(call.body.filter(part => part === 'work').length, 40);
    assert.equal(call.body.filter(part => part === 'move').length, 10);
    assert.equal(call.memory.role, 'sBuilder'); assert.equal(call.memory.boostPlan.tier, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(call.memory.boostPlan.steps)), [
        { type: 'boostMove', resource: 'XZHO2', parts: 10 }, { type: 'boostDismantle', resource: 'XZH2O', parts: 40 },
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
    const unit = spawnAndArrive(s, source, dest), room = dest.game.rooms.E41N5, key = source.task().key;
    room.controller.pos = dest.position(10, 37, 'E41N5');
    dest.pathFinder.search = () => ({ path: [], incomplete: false });
    assert.equal(dest.loader.load('creep/targetDismantle').runTargetDismantle(unit), true);
    assert.equal(unit.memory.targetDismantle.done, true); assert.equal(unit.memory.targetDismantle.index, 2);
    dest.tick(); source.tick(); assert.equal(source.task(), undefined);
    assert.equal(source.memory.targetDismantleStops[key].state, 'completed');
    assert.equal(source.memory.targetDismantleStops[key].input, undefined, 'the stop record retains no task body or target list');
    assert.deepEqual(source.routes[0].slice(0, 4), ['shard3', 'E41N8', 'shard2', 'E41N5']);
    assert.deepEqual(source.routes[0][4], { route });
    delete dest.game.creeps[unit.name]; dest.tick(61000); source.tick();
    assert.equal(source.births().length, 1); assert.equal(source.task(), undefined);
    assert.equal(source.api.listTargetDismantleTasks(), '没有拆迁任务');
});

test('source cancel halts remote dismantling and pending transfers without adopting ordinary builder work', () => {
    const s = sharedWorld(), source = s.runtime(), dest = s.runtime('shard2'); create(source);
    const unit = spawnAndArrive(s, source, dest);
    assert.match(source.api.cancelTargetDismantleTask('entrance'), /已取消/); dest.tick();
    assert.equal(unit.memory.targetDismantle.controlState, 'cancelled');
    assert.equal(dest.loader.load('creep/targetDismantle').runTargetDismantle(unit), true);
    assert.equal(unit.actions.some(action => action.kind === 'dismantle'), false);
    unit.memory.targetDismantle.done = true; dest.tick(); source.tick();
    assert.equal(source.task(), undefined); assert.equal(source.births().length, 1);
    assert.equal(source.api.listTargetDismantleTasks('entrance'), '没有拆迁任务');
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

test('terminal tasks leave the catalogue immediately and temporary stops expire without changing unrelated transport reports', () => {
    const s = sharedWorld(), w = s.runtime();
    for (let i = 0; i < 24; i++) {
        assert.match(w.api.createTargetDismantleTask(`old_${i}`, input()), /已创建/);
        w.api.cancelTargetDismantleTask(`old_${i}`); w.tick();
    }
    assert.equal(Object.keys(w.memory.targetDismantleTasks).length, 0);
    assert.equal(Object.keys(w.memory.targetDismantleStops).length, 24);
    const state = w.transport.getLocalShardState(); state.reports.unrelated = { type: 'other', updatedAt: 0 };
    w.transport.markShardStateDirty(); w.transport.flushInterShardMemory();
    w.tick(w.policy.arrivalHistoryTtl + 1);
    assert.equal(Object.keys(w.memory.targetDismantleTasks).length, 0);
    assert.equal(Object.keys(w.memory.targetDismantleStops).length, 0);
    assert.equal(Object.keys(w.transport.getLocalShardState().reports).filter(key => key.startsWith('targetDismantle:')).length, 0);
    assert.equal(w.transport.getLocalShardState().reports.unrelated.type, 'other');
});

test('same id recreation within the same tick gets a new instance and leaves the old local worker permanently stopped', () => {
    const s = sharedWorld(), w = s.runtime();
    create(w, { targetShard: 'shard3', route: [] }); w.tick(); const old = w.born(), oldKey = w.task().key;
    assert.match(w.api.cancelTargetDismantleTask('entrance'), /已取消/);
    assert.equal(w.task(), undefined); assert.equal(old.memory.targetDismantle.controlState, 'cancelled');
    create(w, { targetShard: 'shard3', route: [] });
    assert.notEqual(w.task().key, oldKey, 'ordinary Memory nonce distinguishes identical clock and tick values');
    assert.equal(w.task().generation, 0);
    w.tick(); assert.equal(w.births().length, 2);
    assert.equal(old.memory.targetDismantle.controlState, 'cancelled');
    w.tick(w.policy.arrivalHistoryTtl + 1);
    assert.equal(w.memory.targetDismantleStops[oldKey], undefined);
    assert.equal(old.memory.targetDismantle.controlState, 'cancelled', 'expiry of a stop broadcast never resumes its worker');
});

test('failed cancellation broadcasts retry from ordinary Memory after a global reset', () => {
    const s = sharedWorld(), source = s.runtime(), dest = s.runtime('shard2'); create(source);
    const unit = spawnAndArrive(s, source, dest), key = source.task().key;
    source.setWriteFailure(true);
    assert.match(source.api.cancelTargetDismantleTask('entrance'), /广播尚未成功/);
    assert.equal(source.task(), undefined);
    assert.equal(source.memory.targetDismantleStops[key].state, 'cancelled');
    assert.equal(JSON.parse(s.bus.shard3).ecbotShard.reports[key].state, 'active');
    const restarted = s.runtime('shard3', source.memory);
    restarted.tick(); dest.tick();
    assert.equal(JSON.parse(s.bus.shard3).ecbotShard.reports[key].state, 'cancelled');
    assert.equal(unit.memory.targetDismantle.controlState, 'cancelled');
    assert.equal(restarted.task(), undefined); assert.equal(restarted.births().length, 0);
});

test('terminal cleanup preserves an already departed worker\'s handshake and stops its restored old instance', () => {
    const s = sharedWorld(), source = s.runtime(), dest = s.runtime('shard2'); create(source);
    source.tick(); const old = source.born(), key = source.task().key;
    assert.equal(source.transport.publishCreepTransfer(old, 'shard2', 1), true);
    source.transport.flushInterShardMemory(); delete source.game.creeps[old.name];
    const transfer = Object.keys(JSON.parse(s.bus.shard3).ecbotShard.transfers)[0];
    assert.match(source.api.cancelTargetDismantleTask('entrance'), /已取消/);
    assert.ok(JSON.parse(s.bus.shard3).ecbotShard.transfers[transfer], 'pending arrival still has its independent role snapshot');
    create(source); assert.notEqual(source.task().key, key);
    const arrived = dest.worker(old.name, {}, { roomName: 'E41N5', blank: true });
    assert.equal(dest.transport.restoreArrivingCreeps(), 1);
    dest.transport.flushInterShardMemory(); dest.tick();
    assert.equal(arrived.memory.role, 'sBuilder'); assert.equal(arrived.memory.targetDismantle.missionId, key);
    assert.equal(arrived.memory.targetDismantle.controlState, 'cancelled');
    assert.ok(dest.transport.getLocalShardState().acks[transfer], 'the cancellation does not erase acknowledgement state');
    assert.equal(dest.loader.load('creep/targetDismantle').runTargetDismantle(arrived), true);
    assert.equal(arrived.actions.some(action => action.kind === 'dismantle'), false);
});

test('legacy terminal catalogue records migrate immediately without removing an active flag waiting for its next tile', () => {
    const w = sharedWorld().runtime();
    create(w, {}, 'old'); const old = w.task(); old.state = 'completed'; old.finishedAt = Date.now();
    placeFlag(w, 'yellow', { work: false }); createFlag(w, { boostTier: 0 });
    assert.equal(w.memory.targetDismantleTasks[old.key], undefined);
    assert.ok(w.memory.targetDismantleStops[old.key]);
    w.tick();
    assert.equal(w.task().state, 'active'); assert.equal(w.task().reason.includes('clear'), true);
    assert.match(w.api.listTargetDismantleTasks(), /entrance: active/);
    assert.doesNotMatch(w.api.listTargetDismantleTasks(), /old:/);
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

test('same-shard flag tasks create, spawn, pause, resume and cancel without InterShardMemory', () => {
    for (const unavailable of ['disabled', 'missing']) {
        const shared = sharedWorld(), w = shared.runtime();
        if (unavailable === 'disabled') w.policy.enabled = false; else w.loader.globals.InterShardMemory = undefined;
        placeFlag(w, 'yellow', { work: true }); createFlag(w, { boostTier: 0, workParts: 10 }); w.setCanBoost(false);
        assert.equal(w.task().input.targetShard, 'shard3'); assert.equal(w.task().input.route.length, 0);
        assert.equal(w.task().input.targets.length, 0); assert.equal(w.task().input.controller, undefined);
        w.tick(); const unit = w.born(); w.tick();
        assert.equal(w.births().length, 1); assert.equal(w.task().spent, 1500);
        assert.equal(w.reservations().length, 0); assert.equal(unit.memory.targetDismantle.flagName, 'yellow');
        assert.match(w.api.pauseTargetDismantleTask('entrance'), /已暂停/); w.tick();
        assert.equal(unit.memory.targetDismantle.controlState, 'paused');
        const lease = w.task().lease.name, generation = w.task().generation;
        assert.match(w.api.resumeTargetDismantleTask('entrance'), /已恢复/); w.tick();
        assert.equal(unit.memory.targetDismantle.controlState, 'active'); assert.equal(w.task().lease.name, lease);
        assert.equal(w.task().generation, generation); assert.equal(w.births().length, 1);
        assert.match(w.api.cancelTargetDismantleTask('entrance'), /已取消/); w.tick();
        assert.equal(unit.memory.targetDismantle.controlState, 'cancelled'); assert.equal(shared.writes.length, 0);
    }
});

test('arbitrary native flag names get stable independent default ids and listing can filter', () => {
    const w = sharedWorld().runtime();
    const first = w.api.createFlagDismantleTask('E41N8', '黄球 一', { boostTier: 0 });
    const second = w.api.createFlagDismantleTask('E41N8', '黄球 二', { boostTier: 0 });
    assert.match(first, /已创建.*黄球 一/); assert.match(second, /已创建.*黄球 二/);
    const tasks = Object.values(w.memory.targetDismantleTasks);
    assert.equal(tasks.length, 2); assert.notEqual(tasks[0].id, tasks[1].id);
    assert.match(w.api.createFlagDismantleTask('E41N8', '黄球 一', { boostTier: 0 }), /已存在/);
    assert.match(w.api.listTargetDismantleTasks(tasks[0].id), /黄球 一/);
    assert.doesNotMatch(w.api.listTargetDismantleTasks(tasks[0].id), /黄球 二/);
});

test('missing/clear flags idle without spawning, while moved unseen flags may send a worker for vision', () => {
    const w = sharedWorld().runtime(); createFlag(w, { boostTier: 0 });
    w.tick(); assert.equal(w.births().length, 0); assert.equal(w.task().state, 'active');
    placeFlag(w); w.tick(); assert.equal(w.births().length, 0); assert.match(w.task().reason, /tile is clear/);
    const cleared = w.task().clearedFlag;
    delete w.game.rooms.E41N5; w.tick(); assert.equal(w.births().length, 0); assert.equal(w.task().clearedFlag, cleared);
    delete w.game.flags.yellow; w.tick();
    placeFlag(w, 'yellow', { visible: false }); w.tick(); assert.equal(w.births().length, 0);
    placeFlag(w, 'yellow', { visible: false, x: 12 }); w.tick();
    assert.equal(w.births().length, 1); assert.equal(w.task().clearedFlag, undefined);
    assert.equal(w.task().state, 'active');
});

test('a never-observed flag room allows its first worker without confusing absence with cleared work', () => {
    const w = sharedWorld().runtime(); placeFlag(w, 'yellow', { visible: false }); createFlag(w, { boostTier: 0 });
    w.tick(); assert.equal(w.births().length, 1); assert.equal(w.task().lastFlag.hasWork, undefined);
});

test('flag deletion pauses unfinished boosts without permanently pausing the task; moving a flag revives one live slot', () => {
    const w = sharedWorld().runtime(); placeFlag(w, 'yellow', { work: true }); createFlag(w); w.tick();
    const unit = w.born(); unit.memory.boostPlan.completed = false; w.tick();
    delete w.game.flags.yellow; w.tick(); assert.equal(unit.memory.targetDismantle.controlState, 'paused');
    assert.equal(w.task().state, 'active');
    placeFlag(w, 'yellow', { work: true, x: 12 }); w.tick();
    assert.equal(unit.memory.targetDismantle.controlState, 'active'); assert.equal(w.births().length, 1);
    placeFlag(w, 'yellow', { x: 14 }); w.tick();
    assert.equal(unit.memory.targetDismantle.controlState, 'paused'); assert.equal(w.task().state, 'active');
    unit.memory.targetDismantle.done = true; w.tick(); assert.equal(w.task().state, 'active');
});

test('body capacity and boost settings determine actual costs; current energy cannot shrink a requested worker', () => {
    const w = sharedWorld().runtime(); w.home.energyCapacityAvailable = 800; w.home.energyAvailable = 150;
    placeFlag(w, 'yellow', { work: true }); createFlag(w, { boostTier: 0, workParts: 5, maxEnergy: 750 });
    w.tick(); assert.equal(w.births().length, 0); assert.match(w.task().reason, /750 spawn energy/);
    w.home.energyAvailable = 750; w.tick();
    const body = w.births()[0].body;
    assert.equal(body.filter(part => part === 'work').length, 5); assert.equal(body.filter(part => part === 'move').length, 5);
    assert.equal(w.task().spent, 750); assert.equal(w.births()[0].memory.boostPlan.tier, 0);
    const small = sharedWorld().runtime(); small.home.energyCapacityAvailable = 800;
    assert.doesNotMatch(small.api.createFlagDismantleTask('E41N8', 'yellow', { workParts: 10 }), /已创建/);
    assert.equal(small.task(), undefined);
});

test('resume extends exhausted budget without changing the slot generation or bypassing failed boost state', () => {
    const w = sharedWorld().runtime(); placeFlag(w, 'yellow', { work: true }); createFlag(w, { boostTier: 0, workParts: 5, maxEnergy: 750 });
    w.tick(); const unit = w.born(); w.tick(); delete w.game.creeps[unit.name]; w.tick();
    assert.equal(w.task().state, 'paused'); assert.match(w.task().reason, /budget/);
    assert.doesNotMatch(w.api.resumeTargetDismantleTask('entrance', { maxEnergy: 749 }), /已恢复/);
    assert.match(w.api.resumeTargetDismantleTask('entrance', { maxEnergy: 1500 }), /已恢复/);
    assert.equal(w.task().generation, 1); assert.equal(w.task().spent, 750); w.tick();
    assert.equal(w.births().length, 2); assert.equal(w.task().spent, 1500);
    const second = w.born(); second.memory.boostPlan.failed = true; w.tick();
    assert.equal(w.task().state, 'paused'); const name = w.task().lease.name, generation = w.task().generation;
    assert.match(w.api.resumeTargetDismantleTask('entrance'), /已恢复/); w.tick();
    assert.equal(w.task().state, 'paused'); assert.match(w.task().reason, /Boost failed/);
    assert.equal(w.task().lease.name, name); assert.equal(w.task().generation, generation); assert.equal(w.births().length, 2);
});

test('cross-shard flags require explicit routes and fresh destination reports before spawning', () => {
    const s = sharedWorld(), source = s.runtime(), dest = s.runtime('shard2');
    assert.doesNotMatch(source.api.createFlagDismantleTask('E41N8', 'yellow', { targetShard: 'shard2' }), /已创建/);
    createFlag(source, { targetShard: 'shard2', route }); source.tick(); assert.equal(source.births().length, 0);
    dest.tick(); source.tick(); assert.equal(source.births().length, 0);
    const absent = JSON.parse(s.bus.shard2).ecbotShard.reports[`${source.task().key}:status`];
    assert.equal(absent.flag, null); assert.equal(absent.units.length, 0);
    placeFlag(dest, 'yellow', { work: true }); dest.tick();
    const saved = s.bus.shard2, stale = JSON.parse(saved);
    stale.ecbotShard.reports[`${source.task().key}:status`].updatedAt -= source.policy.reportMaxAge + 1;
    s.bus.shard2 = JSON.stringify(stale); source.tick(); assert.equal(source.births().length, 0);
    s.bus.shard2 = saved; source.tick(); assert.equal(source.births().length, 1);
    assert.equal(source.births()[0].memory.targetDismantle.targetRoom, 'E41N5');
});

test('a target-shard flag wakes spawning without workers and its moved position overrides old source idle immediately', () => {
    const s = sharedWorld(), source = s.runtime(), dest = s.runtime('shard2');
    createFlag(source, { targetShard: 'shard2', route });
    placeFlag(dest); dest.tick(); source.tick(); assert.equal(source.births().length, 0);
    placeFlag(dest, 'yellow', { work: true, x: 12 }); dest.tick(); source.tick();
    assert.equal(source.births().length, 1);
    const arrival = spawnAndArrive(s, source, dest);
    placeFlag(dest, 'yellow', { x: 14 }); dest.tick(); source.tick(); dest.tick();
    assert.equal(arrival.memory.targetDismantle.controlState, 'paused'); assert.equal(source.task().state, 'active');
    // The destination observes the newly moved flag while the source still advertises flagReady=false.
    placeFlag(dest, 'yellow', { work: true, x: 16 }); dest.tick();
    assert.equal(arrival.memory.targetDismantle.controlState, 'active');
    assert.equal(source.births().length, 1);
    assert.match(source.api.pauseTargetDismantleTask('entrance'), /已暂停/); dest.tick();
    placeFlag(dest, 'yellow', { work: true, x: 18 }); dest.tick();
    assert.equal(arrival.memory.targetDismantle.controlState, 'paused');
});

test('cleared cross-shard flags retain idle memory after vision loss and confirmed death cannot spawn useless replacements', () => {
    const s = sharedWorld(), source = s.runtime(), dest = s.runtime('shard2');
    createFlag(source, { targetShard: 'shard2', route }); placeFlag(dest, 'yellow', { work: true }); dest.tick(); source.tick();
    const arrival = spawnAndArrive(s, source, dest);
    placeFlag(dest, 'yellow', { x: 14 }); dest.tick(); source.tick();
    delete dest.game.creeps[arrival.name]; delete dest.game.rooms.E41N5; dest.tick(61000); source.tick();
    assert.equal(source.task().lease, undefined); assert.equal(source.births().length, 1);
    assert.equal(source.task().state, 'active'); assert.match(source.task().reason, /Previously cleared/);
    placeFlag(dest, 'yellow', { x: 16, visible: false }); dest.tick(); source.tick();
    assert.equal(source.births().length, 2);
});

test('cross-shard pause/resume and an expired lease retain the one in-transit slot', () => {
    const s = sharedWorld(), source = s.runtime(), dest = s.runtime('shard2');
    createFlag(source, { targetShard: 'shard2', route }); placeFlag(dest, 'yellow', { work: true }); dest.tick(); source.tick();
    const unit = source.born(); unit.memory.data.transferPreparedAt = source.game.time; source.tick();
    delete source.game.creeps[unit.name]; source.tick(source.policy.leaseDuration + 1);
    assert.equal(source.task().state, 'paused'); const generation = source.task().generation;
    assert.match(source.api.resumeTargetDismantleTask('entrance', { maxEnergy: 200000 }), /已恢复/);
    assert.equal(source.task().lease.name, unit.name); assert.equal(source.task().generation, generation);
    source.tick(); assert.equal(source.births().length, 1); assert.ok(source.task().lease);
});

function realBoosting(w) {
    for (const room of Object.values(w.game.rooms)) room.labs ||= [];
    return createSourceLoader({ globals: { ...w.loader.globals, LAB_BOOST_MINERAL: 30, LAB_BOOST_ENERGY: 20 },
        modules: { 'settings/boost': { boostConfig: BOOST_CONFIG, boostBodyPart: BOOST_PARTS, roleBoostConfig: {} },
            'combat/spawning': { combatSpawnAllowed: () => true } } }).load('creep/boosting');
}

test('pending boost timeout excludes more than 300 paused ticks for deleted flags, clear tiles and manual pauses', () => {
    for (const reason of ['missing', 'clear', 'manual']) {
        const w = sharedWorld().runtime(); placeFlag(w, 'yellow', { work: true }); createFlag(w); w.tick();
        const unit = w.born(), plan = unit.memory.boostPlan;
        plan.completed = false; plan.startedAt = w.game.time - 50; w.tick();
        const name = unit.name, generation = w.task().generation, beforeInvalidations = w.boostIndexInvalidations();
        if (reason === 'missing') delete w.game.flags.yellow;
        else if (reason === 'clear') placeFlag(w, 'yellow', { x: 14 });
        else w.api.pauseTargetDismantleTask('entrance');
        w.tick(); assert.equal(unit.memory.targetDismantle.controlState, 'paused');
        assert.equal(w.boostIndexInvalidations(), beforeInvalidations + 1);
        const pausedAt = unit.memory.targetDismantle.boostClock.pausedAt, activeAge = pausedAt - plan.startedAt;
        w.game.time += 500; w.tick(); assert.equal(unit.memory.targetDismantle.boostClock.pausedAt, pausedAt);
        if (reason === 'manual') w.api.resumeTargetDismantleTask('entrance');
        else placeFlag(w, 'yellow', { work: true, x: 16 });
        w.tick(); assert.equal(unit.memory.targetDismantle.controlState, 'active');
        assert.equal(w.game.time - plan.startedAt, activeAge);
        assert.equal(unit.memory.targetDismantle.boostClock.pausedAt, undefined);
        assert.equal(w.boostIndexInvalidations(), beforeInvalidations + 2);
        // Invoke the real timeout path: missing Labs wait, rather than declaring the resumed plan failed.
        assert.equal(realBoosting(w).runCreepBoosts(unit), false); assert.notEqual(plan.failed, true);
        assert.equal(w.task().lease.name, name); assert.equal(w.task().generation, generation); assert.equal(w.births().length, 1);
    }
});

test('pending boost clocks reset across shard migration and missing source heartbeats freeze the local timer', () => {
    const s = sharedWorld(), source = s.runtime(), dest = s.runtime('shard2'); create(source);
    const arrival = spawnAndArrive(s, source, dest), plan = arrival.memory.boostPlan;
    plan.completed = false; plan.startedAt = 100;
    arrival.memory.targetDismantle.boostClock = { shard: 'shard3', pausedAt: 10000 };
    dest.game.time = 100000; dest.tick();
    assert.equal(plan.startedAt, dest.game.time); assert.equal(arrival.memory.targetDismantle.boostClock.shard, 'shard2');
    assert.equal(arrival.memory.targetDismantle.boostClock.pausedAt, undefined);
    plan.startedAt = dest.game.time - 50;
    dest.tick(source.policy.reportMaxAge + 1);
    assert.equal(arrival.memory.targetDismantle.controlState, 'paused');
    const elapsed = dest.game.time - plan.startedAt;
    dest.game.time += 500; dest.tick(); source.tick(); dest.tick();
    assert.equal(arrival.memory.targetDismantle.controlState, 'active'); assert.equal(dest.game.time - plan.startedAt, elapsed);
    assert.equal(realBoosting(dest).runCreepBoosts(arrival), false); assert.notEqual(plan.failed, true);
    assert.equal(source.births().length, 1); assert.equal(source.task().lease.name, arrival.name);
});

test('completed and genuinely failed boost plans never have their timers or outcomes rewritten by task pauses', () => {
    for (const outcome of ['completed', 'failed']) {
        const w = sharedWorld().runtime(); placeFlag(w, 'yellow', { work: true }); createFlag(w); w.tick();
        const unit = w.born(), plan = unit.memory.boostPlan;
        plan.completed = outcome === 'completed'; plan.failed = outcome === 'failed'; plan.startedAt = w.game.time - 10;
        if (plan.failed) plan.failureReason = 'actual preparation failure';
        unit.memory.targetDismantle.boostClock = { shard: 'shard3', pausedAt: w.game.time };
        const original = JSON.stringify(plan); delete w.game.flags.yellow; w.tick(); w.game.time += 500; w.tick();
        placeFlag(w, 'yellow', { work: true, x: 16 }); w.api.resumeTargetDismantleTask('entrance'); w.tick();
        assert.equal(JSON.stringify(plan), original); assert.equal(unit.memory.targetDismantle.boostClock, undefined);
        assert.equal(w.births().length, 1);
    }
});
