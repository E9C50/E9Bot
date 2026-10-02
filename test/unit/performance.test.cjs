const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function profilingWorld() {
    let used = 0;
    let reads = 0;
    const game = {
        time: 1, shard: { name: 'shard0' },
        cpu: { getUsed() { reads++; return used; } },
    };
    const loader = createSourceLoader({ globals: { Game: game, console: { log() {} } } });
    return {
        loader, game,
        api: loader.load('runtime/profiling'),
        policy: loader.load('settings/runtime').runtimePolicy.profiling,
        use: amount => { used += amount; },
        reads: () => reads,
    };
}

test('disabled profiling preserves stage order and performs no CPU reads or aggregation', () => {
    const world = profilingWorld();
    world.policy.enabled = false;
    const calls = [];
    const runner = world.loader.load('runtime/TickRunner').createTickRunner([
        { name: 'rooms', run: () => calls.push('rooms') },
        { name: 'creeps', run: () => calls.push('creeps') },
    ]);
    runner();
    runner();
    assert.deepEqual(calls, ['rooms', 'creeps', 'rooms', 'creeps']);
    assert.equal(world.reads(), 0);
    assert.equal(world.api.getCpuProfile().length, 0);
});

test('enabled stage profiling computes bounded totals, counts, maxima and EMA', () => {
    const world = profilingWorld();
    world.policy.enabled = true;
    world.policy.emaAlpha = 0.5;
    let roomCpu = 2;
    const runner = world.loader.load('runtime/TickRunner').createTickRunner([
        { name: 'rooms', run: () => world.use(roomCpu) },
        { name: 'creeps', run: () => world.use(5) },
    ]);
    runner();
    world.game.time = 2;
    roomCpu = 6;
    runner();
    assert.equal(world.reads(), 8, 'exactly one start and end read per stage');
    const results = world.api.getCpuProfile(10, 'total');
    assert.deepEqual(Array.from(results, entry => entry.name), ['tick:creeps', 'tick:rooms']);
    const room = results.find(entry => entry.name === 'tick:rooms');
    assert.equal(room.count, 2);
    assert.equal(room.total, 8);
    assert.equal(room.max, 6);
    assert.equal(room.ema, 4);
    assert.equal(room.average, 4);
    assert.equal(room.lastTick, 2);
    room.total = 999;
    assert.equal(world.api.getCpuProfile(10).find(entry => entry.name === 'tick:rooms').total, 8, 'query results are copies');
});

test('a failed profiled stage is sampled and stops later stages with the same original error', () => {
    const world = profilingWorld();
    world.policy.enabled = true;
    const failure = new Error('failed planning');
    const calls = [];
    const runner = world.loader.load('runtime/TickRunner').createTickRunner([
        { name: 'rooms', run() { calls.push('rooms'); world.use(1); } },
        { name: 'planning', run() { calls.push('planning'); world.use(3); throw failure; } },
        { name: 'creeps', run() { calls.push('creeps'); } },
    ]);
    assert.throws(runner, error => error === failure);
    assert.deepEqual(calls, ['rooms', 'planning']);
    assert.equal(world.reads(), 4);
    const entry = world.api.getCpuProfile().find(entry => entry.name === 'tick:planning');
    assert.equal(entry.count, 1);
    assert.equal(entry.total, 3);
});

test('profiling respects shard filters, with an empty filter enabling all shards', () => {
    const world = profilingWorld();
    world.policy.enabled = true;
    world.policy.shards = ['shard3'];
    assert.equal(world.api.isCpuProfilingEnabled(), false);
    assert.equal(world.api.profileCpuTask('work', () => 42), 42);
    assert.equal(world.reads(), 0);
    world.policy.shards = [];
    assert.equal(world.api.isCpuProfilingEnabled(), true);
    world.api.profileCpuTask('work', () => world.use(2));
    assert.equal(world.reads(), 2);
});

test('aggregation evicts the oldest inactive name at its cap and can be reset', () => {
    const world = profilingWorld();
    world.policy.enabled = true;
    world.policy.maximumEntries = 2;
    const sample = name => world.api.profileCpuTask(name, () => world.use(1));
    sample('a');
    sample('b');
    sample('a');
    sample('c');
    assert.deepEqual(Array.from(world.api.getCpuProfile(100), entry => entry.name).sort(), ['a', 'c']);
    assert.equal(world.api.getCpuProfile(100).find(entry => entry.name === 'a').count, 2);
    world.policy.maximumEntries = 1;
    sample('a');
    assert.equal(world.api.getCpuProfile(100).length, 1);
    world.api.resetCpuProfile();
    assert.equal(world.api.getCpuProfile(100).length, 0);
});

test('disabled creep profiling allocates no values list for Game.creeps and performs no sort or CPU reads', () => {
    let creepValues = 0;
    const calls = [];
    const unit = (name, working = false) => ({
        name, spawning: false, memory: { role: 'builder', working, data: { name } },
        room: { name: 'W1N1', my: true, towers: [] }, hits: 100, hitsMax: 100,
    });
    const game = { creeps: { a: unit('a'), b: unit('b', true) } };
    const loader = createSourceLoader({
        globals: {
            Game: game, Memory: { warMode: {} },
            Object: new Proxy(Object, {
                get(target, key) {
                    if (key === 'values') return value => { if (value === game.creeps) creepValues++; return Object.values(value); };
                    return Reflect.get(target, key);
                },
            }),
        },
        modules: {
            role: { createRoleBehavior: (role, data) => ({
                prepare() { calls.push(`${data.name}:prepare`); return true; },
                source() { calls.push(`${data.name}:source`); }, target() { calls.push(`${data.name}:target`); },
            }) },
            squard: {}, 'settings/creep': { warModeRole: [] },
            'combat/missions': { runCombatUnits() {} },
            'combat/defense': { requestTowerSupport() {} },
        },
    });
    vm.runInContext('global.sortCalls = 0; const originalSort = Array.prototype.sort; Array.prototype.sort = function(...args) { global.sortCalls++; return originalSort.apply(this, args); };', loader.globals);
    loader.load('settings/runtime').runtimePolicy.profiling.enabled = false;
    loader.load('creep/execution').creepWorkController();
    assert.deepEqual(calls, ['a:prepare', 'a:source', 'b:prepare', 'b:target']);
    assert.equal(creepValues, 0);
    assert.equal(loader.globals.sortCalls, 0);
    // Game.cpu 不存在；任何额外 getUsed 都会使测试失败。
});

function profiledUnit(name, role = 'builder', options = {}) {
    return {
        name, spawning: false, memory: { role, working: false, data: { name } },
        room: { name: 'W1N1', my: true, towers: [] }, hits: 100, hitsMax: 100,
        ...options,
    };
}

function roleProfilingWorld(creeps, costs, warMode = {}) {
    let used = 0, reads = 0, creepValues = 0;
    const calls = [], logs = [];
    const game = { time: 1, shard: { name: 'shard3' }, creeps, cpu: { getUsed() { reads++; return used; } } };
    const loader = createSourceLoader({ globals: {
        Game: game, Memory: { warMode }, console: { log: (...values) => logs.push(values.map(String).join(' ')) },
        Object: new Proxy(Object, { get(target, key) {
            if (key === 'values') return value => { if (value === game.creeps) creepValues++; return Object.values(value); };
            return Reflect.get(target, key);
        } }),
    }, modules: {
        role: { createRoleBehavior(role, data) {
            const cost = costs[data.name] || {};
            calls.push(`${data.name}:factory`); used += cost.factory || 0;
            if (cost.unknown) return undefined;
            if (cost.factoryFailure) throw cost.factoryFailure;
            const work = phase => () => {
                calls.push(`${data.name}:${phase}`); used += cost.work || 0;
                if (cost.workFailure) throw cost.workFailure;
            };
            return { prepare() {
                calls.push(`${data.name}:prepare`); used += cost.prepare || 0;
                if (cost.prepareFailure) throw cost.prepareFailure;
                return cost.ready !== false;
            }, source: work('source'), target: work('target') };
        } },
        squard: {}, 'settings/creep': { warModeRole: ['defender'] },
        'combat/missions': { runCombatUnits() {} },
        'combat/defense': { requestTowerSupport() {} },
    } });
    const policy = loader.load('settings/runtime').runtimePolicy.profiling;
    Object.assign(policy, { enabled: true, roleDetails: true, creepDetails: false });
    const execution = loader.load('creep/execution'), profiling = loader.load('runtime/profiling');
    vm.runInContext('global.sortCalls = 0; const originalSort = Array.prototype.sort; Array.prototype.sort = function(...args) { global.sortCalls++; return originalSort.apply(this, args); };', loader.globals);
    return { game, calls, logs, policy, loader, execution, profiling, reads: () => reads, creepValues: () => creepValues };
}

test('role profiling combines same-role units in the current tick without individual warnings, sorting or a creep values allocation', () => {
    const first = profiledUnit('builder-one'), second = profiledUnit('builder-two'); second.memory.working = true;
    const w = roleProfilingWorld({ first, second }, {
        'builder-one': { prepare: 1, work: 2 }, 'builder-two': { prepare: 2, work: 3 },
    });
    w.execution.creepWorkController();
    assert.equal(w.reads(), 4, 'each eligible role invocation needs only its start and end CPU reads');
    assert.equal(w.creepValues(), 0); assert.equal(w.loader.globals.sortCalls, 0); assert.deepEqual(w.logs, []);
    assert.ok(w.calls.includes('builder-one:source')); assert.ok(w.calls.includes('builder-two:target'));
    const entries = w.profiling.getCpuProfile(100);
    assert.deepEqual(Array.from(entries, entry => entry.name), ['creep:builder']);
    assert.equal(entries[0].count, 2); assert.equal(entries[0].rollingTotal, 8);
    assert.equal(entries[0].current, 8); assert.equal(entries[0].rollingMax, 8); assert.equal(entries[0].max, 5);
});

test('unknown, unprepared and failed unit CPU is recorded while role failures remain isolated from subsequent units', () => {
    const w = roleProfilingWorld({
        unknown: profiledUnit('unknown', 'unsupported'), pending: profiledUnit('pending'),
        failed: profiledUnit('failed'), healthy: profiledUnit('healthy', 'manager'),
    }, {
        unknown: { unknown: true, factory: 1 }, pending: { factory: 1, prepare: 2, ready: false },
        failed: { factory: 1, prepare: 1, work: 4, workFailure: new Error('build failed') }, healthy: { prepare: 1, work: 2 },
    });
    assert.doesNotThrow(() => w.execution.creepWorkController());
    assert.equal(w.reads(), 8); assert.equal(w.calls.includes('pending:source'), false);
    assert.ok(w.calls.includes('healthy:source'));
    assert.equal(w.logs.length, 1); assert.match(w.logs[0], /\[unit:failed\].*build failed/s);
    const entries = w.profiling.getCpuProfile(100);
    assert.equal(entries.find(entry => entry.name === 'creep:unsupported').current, 1);
    assert.equal(entries.find(entry => entry.name === 'creep:builder').current, 9);
    assert.equal(entries.find(entry => entry.name === 'creep:manager').current, 3);
});

test('spawning, team and war-skipped creeps create no role samples and no CPU reads', () => {
    const spawning = profiledUnit('spawning', 'builder', { spawning: true });
    const team = profiledUnit('team'); team.memory.isTeam = true;
    const w = roleProfilingWorld({ spawning, team, peaceful: profiledUnit('peaceful'), fighter: profiledUnit('fighter', 'defender') },
        { fighter: { prepare: 1, work: 2 } }, { W1N1: true });
    w.execution.creepWorkController();
    assert.equal(w.reads(), 2); assert.equal(w.calls.some(name => /spawning|team|peaceful/.test(name)), false);
    assert.deepEqual(Array.from(w.profiling.getCpuProfile(100), entry => entry.name), ['creep:defender']);
});

test('a role CPU sampler failure cannot stop subsequent units or replace a business failure report', () => {
    const w = roleProfilingWorld({ failed: profiledUnit('failed'), healthy: profiledUnit('healthy') }, {
        failed: { workFailure: new Error('build failed') }, healthy: { prepare: 1, work: 2 },
    });
    w.profiling.recordCpuSample = () => { throw new Error('CPU sampler unavailable'); };
    assert.doesNotThrow(() => w.execution.creepWorkController());
    assert.ok(w.calls.includes('healthy:source'));
    assert.equal(w.logs.length, 1);
    assert.match(w.logs[0], /\[unit:failed\].*build failed/s);
    assert.equal(w.profiling.getCpuProfile(100).length, 0);
});

test('room module profiling aggregates both owned rooms under stable module names and turns off without extra CPU reads', () => {
    let used = 0, reads = 0;
    const calls = [];
    const mark = (phase, cost = 0) => room => {
        calls.push(`${phase}:${room?.name || 'all'}`);
        used += typeof cost === 'function' ? cost(room) : cost;
    };
    const rooms = { a: { name: 'a', my: true }, b: { name: 'b', my: true }, neutral: { name: 'neutral', my: false } };
    for (const room of Object.values(rooms)) room.getDefenderCostMatrix = () => { calls.push(`matrix:${room.name}`); used += 2; };
    const loader = createSourceLoader({ globals: {
        Game: { time: 1000, shard: { name: 'shard3' }, rooms, cpu: { getUsed() { reads++; return used; } } },
    }, modules: {
        'settings/roomPolicy': { roomPolicy: { profiling: { enabled: false }, defense: { costMatrixRefreshInterval: 1000 } } },
        'room/initialization': { initializeRooms: mark('initialize', 5), initializeStructures: mark('structures'), updateRoomSign: mark('sign') },
        'room/flags': { processRoomFlags: mark('flags', 2) },
        'room/defense': { autoEnableSafeMode: mark('safeMode', 1), findTowerEnemy: mark('enemies'), repairStructure: mark('repair') },
        'room/labs': { updateLabBoostConfig: mark('boost'), updateLabReactionConfig: mark('reaction') },
        'room/layout': { autoComputeCenterPos: mark('center'), releaseConstructionSite: mark('layout', room => room.name === 'a' ? 3 : 7) },
        'room/market': { processRoomMarket: mark('market') }, 'room/terminal': { processTerminalResource: mark('terminal') },
    } });
    const policy = loader.load('settings/runtime').runtimePolicy.profiling;
    const controller = loader.load('module/RoomController'), profiling = loader.load('runtime/profiling');
    controller.roomController();
    const entries = profiling.getCpuProfile(100);
    const construction = entries.find(entry => entry.name === 'room:construction');
    assert.equal(construction.count, 2); assert.equal(construction.current, 10); assert.equal(construction.rollingMax, 10);
    assert.equal(entries.find(entry => entry.name === 'room:flags').count, 1);
    assert.equal(entries.some(entry => entry.name === 'room:defenderMatrix'), false);
    assert.equal(calls.some(name => name.startsWith('matrix:')), false, 'room orchestration does not prewarm defense matrices');
    assert.equal(calls.some(name => name.endsWith(':neutral')), false);
    const enabledCalls = calls.slice(), beforeReads = reads;
    policy.enabled = false; calls.length = 0; controller.roomController();
    assert.deepEqual(calls, enabledCalls); assert.equal(reads, beforeReads, 'disabled profiling executes the same room business without CPU reads');
    assert.equal(profiling.getCpuProfile(100).find(entry => entry.name === 'room:construction').count, 2);
});

test('room flags are processed once after initialization across multiple owned rooms', () => {
    const calls = [];
    const mark = phase => room => calls.push(`${phase}:${room?.name || 'all'}`);
    const rooms = { a: { name: 'a', my: true }, b: { name: 'b', my: true }, neutral: { name: 'neutral', my: false } };
    const loader = createSourceLoader({
        globals: { Game: { time: 1, rooms } },
        modules: {
            'settings/roomPolicy': { roomPolicy: { profiling: { enabled: false }, defense: { costMatrixRefreshInterval: 1000 } } },
            'room/initialization': { initializeRooms: mark('initialize'), initializeStructures: mark('structures'), updateRoomSign: mark('sign') },
            'room/flags': { processRoomFlags: mark('flags') },
            'room/defense': { autoEnableSafeMode: mark('safeMode'), findTowerEnemy: mark('enemies'), repairStructure: mark('repair') },
            'room/labs': { updateLabBoostConfig: mark('boost'), updateLabReactionConfig: mark('reaction') },
            'room/layout': { autoComputeCenterPos: mark('center'), releaseConstructionSite: mark('layout') },
            'room/market': { processRoomMarket: mark('market') },
            'room/terminal': { processTerminalResource: mark('terminal') },
        },
    });
    loader.load('settings/runtime').runtimePolicy.profiling.enabled = false;
    const api = loader.load('module/RoomController');
    api.roomController();
    assert.equal(calls[0], 'initialize:all');
    assert.equal(calls[1], 'flags:all');
    assert.equal(calls.filter(call => call === 'flags:all').length, 1);
    for (const name of ['a', 'b']) {
        assert.deepEqual(calls.filter(call => call.endsWith(`:${name}`)).map(call => call.split(':')[0]),
            ['safeMode', 'center', 'layout', 'terminal', 'market', 'boost', 'reaction', 'structures', 'enemies', 'repair', 'sign']);
    }
    assert.equal(calls.some(call => call.endsWith(':neutral')), false);
    calls.length = 0;
    rooms.a.my = rooms.b.my = false;
    api.roomController();
    assert.deepEqual(calls, ['initialize:all'], 'without owned rooms the original flag-processing scope remains unchanged');
});
