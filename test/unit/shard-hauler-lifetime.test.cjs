const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world(options = {}) {
    const game = { time: 100, shard: { name: 'shard0' }, map: new Proxy({}, { get() { throw new Error('Lifetime estimates must not query native routes'); } }) };
    const loader = createSourceLoader({ globals: {
        Game: game, RESOURCE_ENERGY: 'energy', MOVE: 'move', CARRY: 'carry',
        BOOSTS: { move: { fast: { fatigue: 4 } } },
        PathFinder: { search() { throw new Error('Lifetime estimates must not run PathFinder'); } },
    } });
    const api = loader.load('shard/haulerLifetime');
    const policy = loader.load('settings/interShard').interShardPolicy.haulerLifetime;
    const task = {
        sourceShard: 'shard0', sourceRoom: 'W1N1', targetShard: 'shard1', targetRoom: 'W2N2',
        route: [{ shard: 'shard0', roomName: 'W1N1', x: 20, y: 20, destinationShard: 'shard1', destinationRoom: 'W2N2' }],
        returnRoute: [{ shard: 'shard1', roomName: 'W2N2', x: 40, y: 40, destinationShard: 'shard0', destinationRoom: 'W1N1' }],
        ...options.task,
    };
    const data = { unitKind: 'hauler', task, route: task.route, phase: 'load' };
    const creep = {
        ticksToLive: 1500, pos: { x: 10, y: 10, roomName: task.sourceRoom }, store: { energy: 100 },
        body: [...Array.from({ length: 25 }, () => ({ type: 'carry', hits: 100 })),
            ...Array.from({ length: 25 }, () => ({ type: 'move', hits: 100 }))],
        ...options.creep,
    };
    function observe(phase, remaining, shard = game.shard.name, roomName = creep.pos.roomName) {
        data.phase = phase; creep.ticksToLive = remaining; game.shard.name = shard;
        creep.pos = { ...creep.pos, roomName };
        if (phase === 'outbound') data.route = task.route;
        if (phase === 'return') data.route = task.returnRoute;
        api.observeHaulerLifetime(creep, data);
    }
    return { api, policy, game, data, creep, observe };
}

function outbound(w, ticks = 100, unload = 5) {
    w.observe('load', 1500);
    w.observe('outbound', 1490);
    w.game.time = 987654;
    w.observe('work', 1490 - ticks, 'shard1', w.data.task.targetRoom);
    w.creep.store.energy = 0;
    w.observe('work', 1490 - ticks - unload);
}

test('native TTL measures loaded travel and confirmed unloading across unrelated shard clocks', () => {
    const w = world();
    w.observe('load', 1500);
    w.observe('outbound', 1490);
    w.game.time = 999999;
    w.observe('work', 1390, 'shard1', w.data.task.targetRoom);
    assert.equal(w.data.life.loadedOutboundTicks, 100);
    w.data.pendingDelivery = { amount: 100, energyBefore: 100, tick: 999999 };
    w.creep.store.energy = 0;
    w.game.time = -500;
    w.observe('work', 1385);
    assert.equal(w.data.life.unloadTicks, undefined, 'an outstanding delivery intent has not confirmed unloading');
    delete w.data.pendingDelivery;
    w.api.observeHaulerLifetime(w.creep, w.data);
    assert.equal(w.data.life.unloadTicks, 5);
    w.observe('work', 1370);
    assert.equal(w.data.life.unloadTicks, 5, 'waiting after empty cargo does not inflate completed unloading');
    assert.equal(w.api.hasMeasuredHaulerOutbound(w.data), true);
});

test('next trip uses the highest complete native samples, including asymmetric return and reload', () => {
    const w = world();
    outbound(w);
    w.observe('return', 1385);
    w.game.time = 1;
    w.observe('load', 1145, 'shard0', w.data.task.sourceRoom);
    assert.equal(w.data.life.returnTicks, 240);
    w.creep.store.energy = 100;
    w.observe('outbound', 1115);
    w.observe('work', 975, 'shard1', w.data.task.targetRoom);
    w.creep.store.energy = 0;
    w.observe('work', 970);
    assert.equal(w.data.life.loadedOutboundTicks, 140);
    assert.equal(w.data.life.loadTicks, 30);
    assert.equal(w.api.estimateHaulerNextTrip(w.creep, w.data), 240 + 30 + 140 + 5 + w.policy.safetyTicks);
    w.observe('return', 970);
    w.observe('load', 730, 'shard0', w.data.task.sourceRoom);
    w.creep.store.energy = 100;
    w.observe('outbound', 720);
    w.observe('work', 620, 'shard1', w.data.task.targetRoom);
    assert.equal(w.data.life.loadedOutboundTicks, 140, 'a faster later trip cannot erase the slowest actual trip');
    assert.equal(w.data.life.loadTicks, 30);
});

test('actual loaded samples override a conservative scout estimate; return uses its own verified proof', () => {
    const w = world();
    w.api.seedHaulerLifetime(w.creep, w.data, { outboundTicks: 500, returnTicks: 300 });
    outbound(w, 80, 4);
    assert.equal(w.api.estimateHaulerNextTrip(w.creep, w.data), 300 + 10 + 80 + 4 + w.policy.safetyTicks);
    assert.equal(w.data.life.scoutOutboundTicks, 500);
});

test('a long return route is estimated independently from a short outbound sample without route queries', () => {
    const w = world();
    outbound(w, 20, 2);
    const near = w.api.estimateHaulerNextTrip(w.creep, w.data);
    w.data.task.returnRoute[0].roomName = 'W15N15';
    // The changed task route invalidates old outbound too; re-measure a full outbound against this task revision.
    outbound(w, 20, 2);
    const far = w.api.estimateHaulerNextTrip(w.creep, w.data);
    assert.ok(far > near + 1000);
    assert.equal(w.data.life.loadedOutboundTicks, 20);
});

test('changing a task route or endpoint discards every sample and its old scout fallbacks', () => {
    const w = world();
    w.api.seedHaulerLifetime(w.creep, w.data, { outboundTicks: 30, returnTicks: 40 });
    outbound(w);
    w.data.task.route[0].x++;
    w.api.observeHaulerLifetime(w.creep, w.data);
    assert.equal(w.data.life.loadedOutboundTicks, undefined);
    assert.equal(w.data.life.scoutOutboundTicks, undefined);
    assert.equal(w.data.life.scoutReturnTicks, undefined);
    assert.equal(w.api.hasMeasuredHaulerOutbound(w.data), false);
    w.api.seedHaulerLifetime(w.creep, w.data, { outboundTicks: 12 });
    w.data.task.targetEnergyId = 'another-receiver';
    w.api.observeHaulerLifetime(w.creep, w.data);
    assert.equal(w.data.life.scoutOutboundTicks, undefined);
});

test('in-flight rerouting invalidates the entire leg rather than recording its remaining partial distance', () => {
    const w = world();
    w.api.seedHaulerLifetime(w.creep, w.data, { outboundTicks: 30, returnTicks: 40 });
    w.observe('load', 1500);
    w.observe('outbound', 1490);
    w.creep.ticksToLive = 1450;
    w.data.route = [{ ...w.data.task.route[0], x: 35 }];
    w.api.observeHaulerLifetime(w.creep, w.data);
    assert.equal(w.data.life.scoutOutboundTicks, undefined);
    assert.equal(w.data.life.scoutReturnTicks, 40);
    w.api.seedHaulerLifetime(w.creep, w.data, { outboundTicks: 30 });
    assert.equal(w.data.life.scoutOutboundTicks, undefined, 'proof for the obsolete task route cannot re-seed its replacement');
    w.observe('work', 1400, 'shard1', w.data.task.targetRoom);
    assert.equal(w.data.life.loadedOutboundTicks, undefined, 'the changed leg is not a complete measured trip');
    assert.equal(w.api.hasMeasuredHaulerOutbound(w.data), false);
});

test('return rerouting drops its old proof and actual return sample while keeping same-route outbound', () => {
    const w = world();
    outbound(w);
    w.observe('return', 1385);
    w.observe('load', 1355, 'shard0', w.data.task.sourceRoom);
    w.observe('outbound', 1350);
    w.creep.store.energy = 100;
    w.observe('work', 1250, 'shard1', w.data.task.targetRoom);
    w.creep.store.energy = 0;
    w.observe('work', 1245);
    w.api.seedHaulerLifetime(w.creep, w.data, { returnTicks: 30 });
    w.observe('return', 1245);
    w.data.route = [{ ...w.data.task.returnRoute[0], roomName: 'W10N10' }];
    w.creep.ticksToLive = 1244;
    w.api.observeHaulerLifetime(w.creep, w.data);
    assert.equal(w.data.life.returnTicks, undefined);
    assert.equal(w.data.life.scoutReturnTicks, undefined);
    assert.equal(w.data.life.loadedOutboundTicks, 100);
    assert.ok(w.api.estimateHaulerNextTrip(w.creep, w.data) > 1000);
});

test('loading estimates deduct native time already spent and keep an intent-confirmation tick', () => {
    const w = world();
    outbound(w, 100, 5);
    w.observe('return', 1385);
    w.observe('load', 1355, 'shard0', w.data.task.sourceRoom);
    const initial = w.api.estimateHaulerOutbound(w.creep, w.data);
    assert.equal(initial, 10 + 100 + 5 + w.policy.safetyTicks);
    w.creep.ticksToLive = 1349;
    w.game.time = 200000;
    assert.equal(w.api.estimateHaulerOutbound(w.creep, w.data), initial - 6);
    w.creep.ticksToLive = 1330;
    assert.equal(w.api.estimateHaulerOutbound(w.creep, w.data), 1 + 100 + 5 + w.policy.safetyTicks);
});

test('next delivery budget includes the configured safety margin and every remaining leg', () => {
    const w = world();
    w.api.seedHaulerLifetime(w.creep, w.data, { outboundTicks: 10, returnTicks: 200 });
    outbound(w, 100, 5);
    const need = w.api.estimateHaulerNextTrip(w.creep, w.data);
    assert.equal(need, 200 + 10 + 100 + 5 + w.policy.safetyTicks);
    assert.ok(need > 200 + w.policy.safetyTicks);
});

test('real active MOVE boosts and full CARRY weight safely scale the first loaded scout estimate', () => {
    const ordinary = world({ creep: { body: [{ type: 'carry', hits: 100 }, { type: 'carry', hits: 100 }, { type: 'move', hits: 100 }] } });
    ordinary.api.seedHaulerLifetime(ordinary.creep, ordinary.data, { outboundTicks: 10, returnTicks: 20 });
    assert.equal(ordinary.api.estimateHaulerNextTrip(ordinary.creep, ordinary.data), 100 + 20 + 75 + 50 + ordinary.policy.safetyTicks);
    const boosted = world({ creep: { body: [{ type: 'carry', hits: 100 }, { type: 'carry', hits: 100 }, { type: 'move', hits: 100, boost: 'fast' }] } });
    boosted.api.seedHaulerLifetime(boosted.creep, boosted.data, { outboundTicks: 10, returnTicks: 20 });
    assert.equal(boosted.api.estimateHaulerNextTrip(boosted.creep, boosted.data), 30 + 20 + 75 + 50 + boosted.policy.safetyTicks);
    boosted.creep.body[2].hits = 0;
    boosted.api.observeHaulerLifetime(boosted.creep, boosted.data);
    assert.equal(boosted.api.estimateHaulerNextTrip(boosted.creep, boosted.data), Infinity);
    assert.equal(boosted.data.life.scoutOutboundTicks, undefined, 'changed native movement capability invalidates old samples and seeds');
});

test('mock bodies and unknown lifespan get conservative estimates without inventing traveled samples', () => {
    const w = world({ creep: { body: undefined, ticksToLive: undefined } });
    w.api.seedHaulerLifetime(w.creep, w.data, { outboundTicks: 10, returnTicks: 300 });
    w.observe('load', undefined);
    w.observe('outbound', undefined);
    w.observe('work', undefined, 'shard1', w.data.task.targetRoom);
    w.creep.store.energy = 0;
    w.api.observeHaulerLifetime(w.creep, w.data);
    assert.equal(w.api.hasMeasuredHaulerOutbound(w.data), false);
    assert.equal(w.data.life.loadedOutboundTicks, undefined);
    assert.equal(w.data.life.unloadTicks, undefined);
    assert.equal(w.api.estimateHaulerNextTrip(w.creep, w.data), 50 + 300 + 75 + 50 + w.policy.safetyTicks);
});

test('TTL renewal and missing observations cannot create a cheap partial leg', () => {
    const w = world();
    w.observe('load', 1500);
    w.observe('outbound', 1450);
    w.observe('outbound', 1490);
    w.observe('work', 1400, 'shard1', w.data.task.targetRoom);
    assert.equal(w.data.life.loadedOutboundTicks, undefined);
    assert.equal(w.api.hasMeasuredHaulerOutbound(w.data), false);
});

test('bounded geometry rejects disconnected, unknown landing and overlong portal routes', () => {
    const disconnected = world({ task: { returnRoute: [] } });
    assert.equal(disconnected.api.estimateHaulerNextTrip(disconnected.creep, disconnected.data), Infinity);
    const unknown = world();
    delete unknown.data.task.returnRoute[0].destinationRoom;
    assert.equal(unknown.api.estimateHaulerNextTrip(unknown.creep, unknown.data), Infinity);
    const long = world();
    long.data.task.returnRoute = Array.from({ length: 10000 }, () => ({ ...long.data.task.returnRoute[0] }));
    assert.equal(long.api.estimateHaulerNextTrip(long.creep, long.data), Infinity);
});
