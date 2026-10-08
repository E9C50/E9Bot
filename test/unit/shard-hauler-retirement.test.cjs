const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world({ energyAmount = 0 } = {}) {
    let now = 1000000, failWrites = false, suicideResult = 0;
    const bus = new Map(), deaths = [];
    function room(name) {
        return { name, controller: { my: true, level: 8 }, spawns: [{ id: `${name}-spawn` }],
            energyCapacityAvailable: 3000, energyAvailable: 3000, memory: { creepConfig: {}, creepSpawnQueue: [] },
            find(type) { return type === 'my-spawns' ? this.spawns : []; } };
    }
    const home = room('W1N1'), target = room('W2N2');
    const frames = {
        shard0: { time: 100000, room: home, creeps: {}, memory: { creeps: {}, warMode: {} } },
        shard1: { time: 10, room: target, creeps: {}, memory: { creeps: {}, warMode: {} } },
    };
    const game = { shard: { name: 'shard0' }, structures: {}, cpu: { bucket: 10000, getUsed: () => 0 },
        map: { getRoomStatus: () => ({ status: 'normal' }), getRoomLinearDistance: () => 1, findRoute: () => [] } };
    const loader = createSourceLoader({
        globals: {
            Game: game, Memory: frames.shard0.memory, Date: class extends Date { static now() { return now; } },
            InterShardMemory: { getLocal: () => bus.get(game.shard.name) || '', getRemote: shard => bus.get(shard) || '',
                setLocal(value) { if (failWrites) throw new Error('write rejected'); bus.set(game.shard.name, value); } },
            RESOURCE_ENERGY: 'energy', FIND_MY_SPAWNS: 'my-spawns', FIND_STRUCTURES: 'structures',
            STRUCTURE_PORTAL: 'portal', STRUCTURE_OBSERVER: 'observer', OBSERVER_RANGE: 10,
            WORK: 'work', CARRY: 'carry', MOVE: 'move', CLAIM: 'claim', ATTACK: 'attack', HEAL: 'heal', TOUGH: 'tough', RANGED_ATTACK: 'ranged_attack',
            BODYPART_COST: { claim: 600, move: 50 }, OK: 0,
        },
        modules: { role: { isRoleSupported: () => true }, utils: { sha1String: value => value },
            './portalIntel': { runPortalDiscovery() {}, getKnownPortals: () => [], getPortalIntelStatus: () => ({ observers: 0 }) } },
    });
    function select(shard, milliseconds = 0) {
        now += milliseconds;
        const frame = frames[shard]; frame.time += 10;
        game.shard.name = shard; game.time = frame.time;
        game.rooms = { [frame.room.name]: frame.room }; game.creeps = frame.creeps;
        loader.globals.Memory = frame.memory;
        return frame;
    }
    select('shard0');
    const policy = loader.load('settings/interShard').interShardPolicy;
    policy.peers = ['shard0', 'shard1'];
    const controller = loader.load('shard/controller'), state = loader.load('shard/state'), transport = loader.load('shard/transport');
    const route = [{ shard: 'shard0', roomName: home.name, x: 10, y: 10, destinationShard: 'shard1', destinationRoom: target.name }];
    const returnRoute = [{ shard: 'shard1', roomName: target.name, x: 20, y: 20, destinationShard: 'shard0', destinationRoom: home.name }];
    assert.match(controller.createShardTask({ id: 'haul', sourceRoom: home.name, targetShard: 'shard1', targetRoom: target.name,
        route, returnRoute, claim: false, builders: 0, haulers: 1, energyAmount }), /已创建/);
    controller.releaseShardCreepConfig();
    const mission = Object.values(frames.shard0.memory.shardMissions)[0];
    const lease = mission.leases['hauler:0'];
    lease.departed = true; lease.lastShard = 'shard1'; lease.seenAt = now; lease.locationUpdatedAt = now;
    const config = home.memory.creepConfig[lease.name];
    function unit(name = lease.name) {
        const data = JSON.parse(JSON.stringify(config.data));
        Object.assign(data, { phase: 'work', hopIndex: route.length });
        const creep = { name, id: `${name}-native`, spawning: false, ticksToLive: 50, room: target,
            store: { energy: 0 }, memory: { role: 'sHauler', data },
            suicide() {
                const persisted = JSON.parse(bus.get('shard1')).ecbotShard.reports[data.missionId];
                deaths.push({ name, persisted }); return suicideResult;
            } };
        frames.shard1.creeps[name] = creep;
        return creep;
    }
    select('shard1');
    const creep = unit();
    function report() { controller.runShardController(); assert.equal(transport.flushInterShardMemory(), true); }
    function persisted() { return JSON.parse(bus.get('shard1')).ecbotShard.reports[mission.task.key]; }
    return { loader, frames, game, home, target, policy, controller, state, transport, mission, lease, creep,
        select, unit, report, persisted, bus, deaths, now: () => now,
        fail(value) { failWrites = value; }, suicideResult(value) { suicideResult = value; } };
}

test('retirement persists the latest confirmed delivery and all other units before the native suicide intent', () => {
    const w = world(), other = w.unit('other-hauler');
    w.state.recordShardDelivery(w.creep.memory.data, 400);
    w.state.recordShardDelivery(other.memory.data, 50);
    assert.equal(w.state.retireShardHauler(w.creep, w.creep.memory.data), true);
    assert.equal(w.deaths.length, 1);
    assert.equal(w.deaths[0].persisted.energyDelivered, 450);
    assert.equal(w.deaths[0].persisted.targetOwned, true);
    assert.equal(w.deaths[0].persisted.units.find(unit => unit.name === w.creep.name).done, true);
    assert.equal(w.deaths[0].persisted.units.find(unit => unit.name === other.name).done, false);
    assert.equal(w.creep.memory.data.done, true); assert.equal(w.creep.memory.data.phase, 'done');
});

test('failed publication preserves the previous report and live worker until a later retry is persisted', () => {
    for (const failure of ['write', 'capacity']) {
        const w = world(); w.report();
        const previous = w.bus.get('shard1');
        w.state.recordShardDelivery(w.creep.memory.data, 300);
        if (failure === 'write') w.fail(true); else w.policy.maximumBytes = 10;
        assert.equal(w.state.retireShardHauler(w.creep, w.creep.memory.data), false, failure);
        assert.equal(w.deaths.length, 0); assert.equal(w.creep.memory.data.done, undefined);
        assert.equal(w.creep.memory.data.retireForLifetime, true);
        assert.equal(w.creep.memory.data.phase, 'work'); assert.equal(w.bus.get('shard1'), previous);
        assert.equal(w.frames.shard1.memory.shardArrivals[w.mission.task.key].retiredUnits, undefined);
        assert.equal(w.frames.shard1.memory.shardArrivals[w.mission.task.key].energyDelivered, 300);
        // A replacement route may become cheaper while communication is unavailable; the retirement decision stays final.
        w.creep.memory.data.task.route[0].x = 15;
        assert.equal(w.creep.memory.data.retireForLifetime, true);
        w.fail(false); w.policy.maximumBytes = 90000; w.select('shard1', 1000);
        assert.equal(w.state.retireShardHauler(w.creep, w.creep.memory.data), true);
        assert.equal(w.deaths.length, 1); assert.equal(w.persisted().energyDelivered, 300);
    }
});

test('retirement survives dead creep GC, multiple target reports and a much later source polling interval', () => {
    const w = world(); w.state.recordShardDelivery(w.creep.memory.data, 200);
    assert.equal(w.state.retireShardHauler(w.creep, w.creep.memory.data), true);
    delete w.frames.shard1.creeps[w.creep.name];
    for (let count = 0; count < 3; count++) { w.select('shard1', 100000); w.report(); }
    assert.equal(w.persisted().units.find(unit => unit.name === w.creep.name).done, true);
    w.select('shard0'); w.controller.runShardController();
    assert.equal(w.mission.energyDelivered, 200); assert.equal(w.mission.state, 'active');
    assert.equal(w.mission.leases['hauler:0'], undefined);
    w.controller.releaseShardCreepConfig();
    const replacement = w.mission.leases['hauler:0'];
    assert.notEqual(replacement.name, w.creep.name);
    w.select('shard0', 1000); w.controller.runShardController(); w.controller.releaseShardCreepConfig();
    assert.equal(w.mission.leases['hauler:0'].name, replacement.name, 'repeated old done cannot delete the new identity');
    assert.equal(Object.keys(w.mission.leases).length, 1);
});

test('retirement at a finite confirmed goal releases the old slot without publishing a replacement', () => {
    const w = world({ energyAmount: 100 }); w.state.recordShardDelivery(w.creep.memory.data, 100);
    w.state.retireShardHauler(w.creep, w.creep.memory.data);
    delete w.frames.shard1.creeps[w.creep.name];
    w.select('shard0'); w.controller.runShardController(); w.controller.releaseShardCreepConfig();
    assert.equal(w.mission.energyDelivered, 100); assert.equal(w.mission.state, 'complete');
    assert.equal(w.frames.shard0.memory.shardMissions[w.mission.task.key], undefined);
    assert.equal(w.frames.shard0.memory.shardMissionStops[w.mission.task.key].state, 'complete');
    assert.equal(Object.keys(w.mission.leases).length, 0); assert.equal(Object.keys(w.home.memory.creepConfig).length, 0);
});

test('a retired hauler below a finite goal renews with a new identity and cannot duplicate delivery on retry', () => {
    const w = world({ energyAmount: 1000 }); w.state.recordShardDelivery(w.creep.memory.data, 200);
    w.suicideResult(-4);
    assert.equal(w.state.retireShardHauler(w.creep, w.creep.memory.data), true);
    const retiredAt = w.frames.shard1.memory.shardArrivals[w.mission.task.key].retiredUnits[w.creep.name].retiredAt;
    w.select('shard1', 1000); w.suicideResult(0);
    assert.equal(w.state.retireShardHauler(w.creep, w.creep.memory.data), true);
    assert.equal(w.deaths.length, 2); assert.equal(w.persisted().energyDelivered, 200);
    assert.equal(w.frames.shard1.memory.shardArrivals[w.mission.task.key].retiredUnits[w.creep.name].retiredAt, retiredAt);
    delete w.frames.shard1.creeps[w.creep.name];
    w.select('shard0'); w.controller.runShardController(); w.controller.releaseShardCreepConfig();
    assert.equal(w.mission.state, 'active'); assert.notEqual(w.mission.leases['hauler:0'].name, w.creep.name);
});

test('unexpired retirement identities are bounded and only expired entries release publication capacity', () => {
    const w = world(); w.policy.maximumTransfers = 2;
    w.frames.shard1.memory.shardArrivals = { [w.mission.task.key]: { task: w.mission.task, updatedAt: w.now(), energyDelivered: 0,
        retiredUnits: { older: { kind: 'hauler', retiredAt: w.now() }, previous: { kind: 'hauler', retiredAt: w.now() } } } };
    assert.equal(w.state.retireShardHauler(w.creep, w.creep.memory.data), false);
    assert.equal(w.deaths.length, 0); assert.match(w.creep.memory.data.lastError, /容量/);
    assert.equal(w.creep.memory.data.retireForLifetime, true);
    w.select('shard1', w.policy.leaseDuration + w.policy.reportMaxAge + 1);
    assert.equal(w.state.retireShardHauler(w.creep, w.creep.memory.data), true);
    assert.deepEqual(Object.keys(w.frames.shard1.memory.shardArrivals[w.mission.task.key].retiredUnits), [w.creep.name]);
});

test('cargo, unconfirmed delivery, the wrong target or the wrong role cannot be retired by the transport helper', () => {
    for (const invalid of ['cargo', 'pending', 'room', 'shard', 'kind']) {
        const w = world(), data = w.creep.memory.data;
        if (invalid === 'cargo') w.creep.store.energy = 1;
        if (invalid === 'pending') data.pendingDelivery = { tick: w.game.time, amount: 1, energyBefore: 1 };
        if (invalid === 'room') w.creep.room = { name: 'W3N3' };
        if (invalid === 'shard') w.select('shard0');
        if (invalid === 'kind') data.unitKind = 'builder';
        assert.equal(w.state.retireShardHauler(w.creep, data), false, invalid); assert.equal(w.deaths.length, 0, invalid);
        assert.equal(data.retireForLifetime, undefined, invalid);
    }
});

test('verified route commands expose the real scout outbound and return elapsed ticks as lifetime hints', () => {
    const w = world(); w.select('shard0');
    w.mission.task.verifyRoute = true;
    const verification = w.loader.load('shard/verification'); verification.refreshMissionScouting(w.mission);
    Object.assign(w.mission.scouting, { status: 'verified', outbound: true, returning: true, verifiedAt: w.now(),
        outboundTicks: 300, returnTicks: 150 });
    w.report();
    const command = JSON.parse(w.bus.get('shard0')).ecbotShard.reports[w.mission.task.key];
    assert.equal(command.verification.outboundTicks, 300); assert.equal(command.verification.returnTicks, 150);
});
