const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const copy = value => JSON.parse(JSON.stringify(value));

function world() {
    const cpu = { used: 1.5, queryCost: 0 }, clock = { now: 1000000 }, calls = [];
    const game = { time: 1, shard: { name: 'shard3' }, cpu: { bucket: 0, limit: 20, tickLimit: 21,
        getUsed() { cpu.used += cpu.queryCost; return cpu.used; } }, map: {
        findRoute() { calls.push('native-route'); throw new Error('light candidate must not run native route searches'); },
        getRoomStatus() { calls.push('native-status'); throw new Error('light candidate must not scan room status'); },
    } };
    const loader = createSourceLoader({ globals: { Game: game, Date: class extends Date { static now() { return clock.now; } } },
        modules: { 'settings/settings': { findPathAvoidRooms: [] } } });
    const policy = loader.load('settings/interShard').interShardPolicy;
    const budgets = loader.load('shard/planningBudget'), routes = loader.load('shard/lowBucketRoutes');
    const portal = (shard, room, destinationShard, destinationRoom, extra = {}) => ({ id: `${shard}/${room}`,
        shard, roomName: room, x: 10, y: 10, destinationShard, destinationRoom, observedAt: clock.now, ...extra });
    const plan = portals => routes.planLowBucketPortalRoute('shard3', 'E41N8', 'shard1', 'E41N6', portals,
        budgets.reserveLowBucketPlanning());
    return { cpu, clock, game, calls, loader, policy, budgets, routes, portal, plan };
}

test('bucket zero with 20 CPU can reserve one small step per shard tick while preserving headroom', () => {
    const w = world();
    assert.equal(w.budgets.isLowBucketPlanning('routing'), true);
    const first = w.budgets.reserveLowBucketPlanning();
    assert.equal(first.maximumPlanningCpu, 0.75); assert.equal(first.minimumCpuHeadroom, 2);
    assert.equal(w.budgets.reserveLowBucketPlanning(), undefined);
    w.game.time++; assert.ok(w.budgets.reserveLowBucketPlanning());
    w.game.shard.name = 'shard2'; assert.ok(w.budgets.reserveLowBucketPlanning(), 'unrelated tick counters cannot exhaust another shard');
    w.game.time++; w.cpu.used = 19.1;
    assert.equal(w.budgets.lowBucketPlanningReady(), false); assert.equal(w.budgets.reserveLowBucketPlanning(), undefined);
});

test('light route uses nearest observed next-shard doors through an unowned intermediate shard without native searches', () => {
    const w = world(), near = w.portal('shard3', 'E40N10', 'shard2', 'E40N10');
    const far = w.portal('shard3', 'E20N20', 'shard2', 'E40N0');
    const second = w.portal('shard2', 'E40N10', 'shard1', 'E40N10');
    const result = w.plan([far, near, second]);
    assert.deepEqual(copy(result.route.map(hop => [hop.shard, hop.roomName, hop.destinationShard])),
        [['shard3', 'E40N10', 'shard2'], ['shard2', 'E40N10', 'shard1']]);
    assert.deepEqual(w.calls, []);
});

test('a bounded candidate never invents an absent intermediate portal or consumes a full graph search', () => {
    const w = world();
    assert.equal(w.plan([w.portal('shard3', 'E40N10', 'shard2', 'E40N10')]), undefined);
    assert.deepEqual(w.calls, []);
});

test('expired, future, stale, malformed and self-loop doors cannot make a lightweight route ready', () => {
    for (const extra of [{ expiresAt: 999999 }, { observedAt: 1000001 }, { observedAt: -100000000 },
        { destinationRoom: undefined }, { x: -1 }, { destinationShard: 'shard3' }]) {
        const w = world(), first = w.portal('shard3', 'E40N10', 'shard2', 'E40N10', extra);
        assert.equal(w.plan([first, w.portal('shard2', 'E40N10', 'shard1', 'E40N10')]), undefined);
        assert.deepEqual(w.calls, []);
    }
});

test('CPU allowance exhaustion defers a lightweight candidate without any native map call', () => {
    const w = world(); w.cpu.queryCost = 0.2;
    assert.equal(w.plan([w.portal('shard3', 'E40N10', 'shard2', 'E40N10'),
        w.portal('shard2', 'E40N10', 'shard1', 'E40N10')]), undefined);
    assert.deepEqual(w.calls, []);
});
