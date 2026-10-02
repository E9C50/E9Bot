const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world() {
    let used = 0, reads = 0;
    const logs = [];
    const logger = { failCpu: false };
    const game = { time: 1, shard: { name: 'shard3' }, cpu: {
        getUsed() { reads++; return used; },
    } };
    const loader = createSourceLoader({ globals: { Game: game, console: {
        log(message) {
            if (logger.failCpu && String(message).startsWith('[CPU]')) throw new Error('CPU logger unavailable');
            logs.push(String(message));
        },
    } } });
    const api = loader.load('runtime/profiling');
    const policy = loader.load('settings/runtime').runtimePolicy.profiling;
    return { api, policy, loader, game, logs, logger,
        use(amount) { used += amount; }, reads: () => reads,
        tick(tick) { game.time = tick; used = 0; },
        sample(name, amount) { return api.profileCpuTask(name, () => { used += amount; return amount; }); },
        entry(name) { return api.getCpuProfile(100).find(entry => entry.name === name); },
        cpuLogs() { return logs.filter(message => message.startsWith('[CPU]')); },
    };
}

test('rolling module profiling defaults to a 100-tick window with enabled aggregate logs and no per-creep warnings', () => {
    const w = world();
    assert.equal(w.policy.enabled, true); assert.equal(w.policy.logEnabled, true);
    assert.equal(w.policy.windowSize, 100); assert.equal(w.policy.logInterval, 100);
    assert.equal(w.policy.creepDetails, false);
    assert.equal(w.policy.logDetails, true); assert.equal(w.policy.roleDetails, true);
    assert.deepEqual(JSON.parse(JSON.stringify(w.api.getCpuProfileWindow())), {
        windowSize: 100, windowTicks: 0, startTick: null, endTick: null, ready: false,
    });
});

test('tick 101 expires tick 1 from every rolling metric while preserving lifetime totals', () => {
    const w = world();
    w.sample('tick:planning', 100); w.api.finishCpuProfilingTick();
    for (let tick = 2; tick <= 100; tick++) { w.tick(tick); w.api.finishCpuProfilingTick(); }
    let entry = w.entry('tick:planning');
    assert.equal(entry.windowTicks, 100); assert.equal(entry.rollingTotal, 100);
    assert.equal(entry.rollingAverage, 1); assert.equal(entry.rollingMax, 100); assert.equal(entry.current, 0);
    assert.equal(w.api.getCpuProfileWindow().startTick, 1); assert.equal(w.api.getCpuProfileWindow().endTick, 100);
    assert.equal(w.api.getCpuProfileWindow().ready, true);
    w.tick(101); w.api.finishCpuProfilingTick();
    entry = w.entry('tick:planning');
    assert.equal(entry.rollingTotal, 0); assert.equal(entry.rollingAverage, 0);
    assert.equal(entry.rollingMax, 0); assert.equal(entry.current, 0);
    assert.equal(entry.total, 100); assert.equal(entry.count, 1); assert.equal(entry.max, 100);
    assert.equal(w.api.getCpuProfileWindow().startTick, 2);
});

test('warm-up uses a shared tick denominator including ticks with no module call', () => {
    const w = world();
    w.api.finishCpuProfilingTick();
    w.tick(2); w.sample('tick:rooms', 8); w.api.finishCpuProfilingTick();
    w.tick(4); w.sample('tick:creeps', 6); w.api.finishCpuProfilingTick();
    const rooms = w.entry('tick:rooms'), creeps = w.entry('tick:creeps');
    assert.equal(rooms.windowTicks, 4); assert.equal(creeps.windowTicks, 4);
    assert.equal(rooms.rollingAverage, 2); assert.equal(creeps.rollingAverage, 1.5);
    assert.equal(rooms.current, 0); assert.equal(creeps.current, 6);
    assert.equal(rooms.average, 8); assert.equal(creeps.average, 6);
    assert.equal(w.api.getCpuProfileWindow().startTick, 1);
    assert.equal(w.api.getCpuProfileWindow().ready, false);
    assert.equal(rooms.sampledTicks, 1); assert.equal(rooms.sampledAverage, 8);
    assert.equal(creeps.sampledTicks, 1); assert.equal(creeps.sampledAverage, 6);
});

test('zero CPU samples count as observed ticks while missing final stages remain visible', () => {
    const w = world(); Object.assign(w.policy, { windowSize: 3, logInterval: 3 });
    w.sample('tick:memory', 0); w.sample('tick:shardFlush', 1); w.api.finishCpuProfilingTick();
    w.tick(2); w.sample('tick:memory', 0); w.api.finishCpuProfilingTick();
    w.tick(3); w.sample('tick:memory', 0); w.sample('tick:shardFlush', 3); w.api.finishCpuProfilingTick();
    assert.equal(w.entry('tick:memory').sampledTicks, 3);
    assert.equal(w.entry('tick:shardFlush').sampledTicks, 2);
    assert.equal(w.entry('tick:shardFlush').sampledAverage, 2);
    assert.match(w.cpuLogs()[0], /末阶段采样 2\/3 tick/);
    w.tick(4); w.sample('tick:memory', 0); w.api.finishCpuProfilingTick();
    assert.equal(w.entry('tick:shardFlush').sampledTicks, 1);
    w.tick(10); w.api.finishCpuProfilingTick();
    assert.equal(w.entry('tick:shardFlush').sampledTicks, 0);
    assert.equal(w.entry('tick:shardFlush').sampledAverage, 0);
});

test('multiple calls in one tick add to current and the tick peak instead of treating calls as separate window samples', () => {
    const w = world();
    w.sample('tick:rooms', 3); w.sample('tick:rooms', 5); w.api.finishCpuProfilingTick();
    let entry = w.entry('tick:rooms');
    assert.equal(entry.count, 2); assert.equal(entry.average, 4); assert.equal(entry.max, 5);
    assert.equal(entry.current, 8); assert.equal(entry.rollingTotal, 8);
    assert.equal(entry.rollingAverage, 8); assert.equal(entry.rollingMax, 8);
    w.api.finishCpuProfilingTick();
    assert.equal(w.entry('tick:rooms').windowTicks, 1, 'finishing the same tick twice cannot advance the window');
    w.tick(2); w.sample('tick:rooms', 2); w.api.finishCpuProfilingTick();
    entry = w.entry('tick:rooms');
    assert.equal(entry.windowTicks, 2); assert.equal(entry.rollingTotal, 10);
    assert.equal(entry.rollingAverage, 5); assert.equal(entry.rollingMax, 8); assert.equal(entry.current, 2);
});

test('jumping more than a window counts absent ticks as zero and evicts old work without replaying skipped ticks', () => {
    const w = world();
    w.sample('tick:rooms', 90); w.api.finishCpuProfilingTick();
    w.tick(250); w.sample('tick:creeps', 20); w.api.finishCpuProfilingTick();
    assert.equal(w.entry('tick:rooms').rollingTotal, 0);
    assert.equal(w.entry('tick:rooms').rollingMax, 0);
    assert.equal(w.entry('tick:creeps').windowTicks, 100);
    assert.equal(w.entry('tick:creeps').rollingTotal, 20);
    assert.equal(w.entry('tick:creeps').rollingAverage, 0.2);
    assert.equal(w.entry('tick:creeps').current, 20);
    assert.equal(w.api.getCpuProfileWindow().startTick, 151);
    assert.equal(w.api.getCpuProfileWindow().endTick, 250);
});

test('default profile ordering reflects recent per-tick work instead of an expired cumulative spike', () => {
    const w = world();
    w.sample('tick:old', 100); w.api.finishCpuProfilingTick();
    w.tick(101); w.sample('tick:active', 1); w.api.finishCpuProfilingTick();
    assert.deepEqual(Array.from(w.api.getCpuProfile(), entry => entry.name), ['tick:active', 'tick:old']);
    assert.deepEqual(Array.from(w.api.getCpuProfile(10, 'total'), entry => entry.name), ['tick:old', 'tick:active']);
    const entry = w.entry('tick:active'); entry.rollingTotal = 999; entry.current = 999;
    assert.equal(w.entry('tick:active').rollingTotal, 1); assert.equal(w.entry('tick:active').current, 1);
});

test('completed 100-tick logs include all modules despite a small query limit and report only once per interval', () => {
    const w = world(); w.policy.topCount = 1;
    for (let tick = 1; tick <= 99; tick++) {
        w.tick(tick); w.sample('tick:rooms', 1); w.sample('tick:creeps', 2);
        w.api.recordCpuSample('role:builder', 0.5); w.api.finishCpuProfilingTick();
    }
    assert.equal(w.cpuLogs().length, 0, 'logs wait until the initial 100-tick window is complete');
    w.tick(100); w.sample('tick:rooms', 1); w.sample('tick:creeps', 2);
    const beforeFinish = w.reads(); w.api.finishCpuProfilingTick();
    assert.equal(w.reads(), beforeFinish, 'printing a report must reuse samples rather than query CPU');
    assert.equal(w.cpuLogs().length, 1);
    const message = w.cpuLogs()[0];
    assert.match(message, /shard3/); assert.match(message, /1\s*-\s*100/);
    assert.ok(message.includes('tick:rooms')); assert.ok(message.includes('tick:creeps')); assert.ok(message.includes('role:builder'));
    assert.ok(message.indexOf('tick:creeps') < message.indexOf('tick:rooms'), 'top-level modules are ordered by their recent average');
    assert.match(message, /已.*包含|包含.*顶层|included/i, 'detail groups explain that their CPU is already counted in the top-level module');
    assert.equal(w.api.getCpuProfile().length, 1, 'topCount still applies to explicit console queries');
    w.api.finishCpuProfilingTick(); assert.equal(w.cpuLogs().length, 1);
    w.tick(199); w.api.finishCpuProfilingTick(); assert.equal(w.cpuLogs().length, 1);
    w.tick(200); w.api.finishCpuProfilingTick(); assert.equal(w.cpuLogs().length, 2);
    assert.match(w.cpuLogs()[1], /101\s*-\s*200/);
});

test('report detail and automatic log switches control output without disabling the measured rolling window', () => {
    const w = world(); Object.assign(w.policy, { windowSize: 2, logInterval: 2, logDetails: false });
    w.sample('tick:rooms', 2); w.api.recordCpuSample('role:builder', 1); w.api.finishCpuProfilingTick();
    w.tick(2); w.api.finishCpuProfilingTick();
    assert.equal(w.cpuLogs().length, 1); assert.ok(w.cpuLogs()[0].includes('tick:rooms'));
    assert.equal(w.cpuLogs()[0].includes('role:builder'), false);
    w.policy.logEnabled = false; w.tick(4); w.sample('tick:rooms', 4); w.api.finishCpuProfilingTick();
    assert.equal(w.cpuLogs().length, 1); assert.equal(w.entry('tick:rooms').rollingTotal, 4);
});

test('disabled profiling and excluded shards execute work with no CPU reads, aggregation or logs', () => {
    const w = world(); w.policy.enabled = false;
    assert.equal(w.sample('tick:rooms', 2), 2); w.api.recordCpuSample('role:builder', 1); w.api.finishCpuProfilingTick();
    assert.equal(w.reads(), 0); assert.equal(w.api.getCpuProfile().length, 0); assert.equal(w.cpuLogs().length, 0);
    w.policy.enabled = true; w.policy.shards = ['shard1']; w.tick(200);
    assert.equal(w.sample('tick:rooms', 3), 3); w.api.recordCpuSample('role:builder', 2); w.api.finishCpuProfilingTick();
    assert.equal(w.reads(), 0); assert.equal(w.api.getCpuProfile().length, 0); assert.equal(w.cpuLogs().length, 0);
    w.policy.shards = []; w.sample('tick:rooms', 4); w.api.finishCpuProfilingTick();
    assert.equal(w.reads(), 2); assert.equal(w.entry('tick:rooms').windowTicks, 1);
});

test('already measured detail samples share the window without extra CPU reads and ignore invalid CPU values', () => {
    const w = world();
    w.api.recordCpuSample('role:builder', 1.5); w.api.recordCpuSample('role:builder', 2.5);
    for (const amount of [-1, Infinity, NaN]) w.api.recordCpuSample('invalid', amount);
    w.api.finishCpuProfilingTick();
    assert.equal(w.reads(), 0); assert.equal(w.entry('role:builder').current, 4);
    assert.equal(w.entry('role:builder').rollingMax, 4); assert.equal(w.entry('invalid'), undefined);
});

test('window storage follows aggregation eviction and reset without resurrecting evicted module samples', () => {
    const w = world(); w.policy.maximumEntries = 2;
    w.sample('a', 1); w.sample('b', 2); w.api.finishCpuProfilingTick();
    w.tick(2); w.sample('a', 3); w.api.finishCpuProfilingTick();
    w.tick(3); w.sample('c', 4); w.api.finishCpuProfilingTick();
    assert.deepEqual(Array.from(w.api.getCpuProfile(100), entry => entry.name).sort(), ['a', 'c']);
    assert.equal(w.entry('a').rollingTotal, 4); assert.equal(w.entry('a').windowTicks, 3);
    w.tick(4); w.sample('b', 5); w.api.finishCpuProfilingTick();
    assert.equal(w.entry('b').rollingTotal, 5, 'a new name generation must not inherit the evicted value from tick 1');
    assert.equal(w.entry('b').count, 1);
    w.api.resetCpuProfile();
    assert.equal(w.api.getCpuProfile(100).length, 0); assert.equal(w.api.getCpuProfileWindow().windowTicks, 0);
    w.tick(500); w.sample('tick:rooms', 6); w.api.finishCpuProfilingTick();
    assert.equal(w.entry('tick:rooms').windowTicks, 1); assert.equal(w.entry('tick:rooms').rollingAverage, 6);
    assert.equal(w.api.getCpuProfileWindow().startTick, 500);
});

test('changing window size resets rolling history while preserving lifetime CPU totals', () => {
    const w = world(); w.sample('tick:rooms', 10); w.api.finishCpuProfilingTick();
    w.tick(2); w.sample('tick:rooms', 6); w.api.finishCpuProfilingTick();
    w.policy.windowSize = 2; w.tick(3); w.sample('tick:rooms', 4); w.api.finishCpuProfilingTick();
    assert.equal(w.entry('tick:rooms').total, 20); assert.equal(w.entry('tick:rooms').count, 3);
    assert.equal(w.entry('tick:rooms').rollingTotal, 4); assert.equal(w.entry('tick:rooms').rollingAverage, 4);
    assert.equal(w.api.getCpuProfileWindow().startTick, 3); assert.equal(w.api.getCpuProfileWindow().windowTicks, 1);
});

test('periodic CPU logger failures do not mask a business-stage exception and failed work is still measured', () => {
    const w = world(); Object.assign(w.policy, { windowSize: 2, logInterval: 2 });
    const failure = new Error('layout failed');
    const runner = w.loader.load('runtime/TickRunner').createTickRunner([
        { name: 'planning', run() { w.use(3); if (w.game.time === 2) throw failure; } },
        { name: 'creeps', run() { w.use(2); } },
    ]);
    runner(); w.tick(2); w.logger.failCpu = true;
    assert.throws(runner, error => error === failure);
    assert.equal(w.entry('tick:planning').rollingTotal, 6); assert.equal(w.entry('tick:planning').count, 2);
    assert.equal(w.entry('tick:creeps').rollingTotal, 2); assert.equal(w.entry('tick:creeps').count, 1);
    assert.equal(w.entry('tick:creeps').current, 0);
});
