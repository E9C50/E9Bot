const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world({ reverse = false, remote = false } = {}) {
    const calls = [], objects = new Map(), moved = {}, cache = {}, game = { time: 100, shard: { name: 'shard1' }, rooms: {}, creeps: {}, flags: {},
        cpu: { bucket: 5000, tickLimit: 100, getUsed: () => 0 }, getObjectById: id => objects.get(id) || null };
    class Position {
        constructor(x, y = 25, roomName = 'E39N5') { Object.assign(this, { x, y, roomName }); }
        getRangeTo(other) { other = other.pos || other; return this.roomName === other.roomName ? Math.max(Math.abs(this.x - other.x), Math.abs(this.y - other.y)) : Infinity; }
        isNearTo(other) { return this.getRangeTo(other) <= 1; }
    }
    const p = (x, roomName = 'E39N5') => new Position(x, 25, roomName);
    const home = { name: 'E39N5', my: true, controller: { my: true, level: 3, pos: p(45), owner: { username: 'me' } },
        memory: { creepConfig: {} }, sources: [], spawns: [{ id: 'spawn', pos: p(45), owner: { username: 'me' } }], extensions: [], towers: [], labs: [], containers: [], links: [] };
    const source = { id: 'mine', pos: p(5, remote ? 'E39N6' : home.name), energy: 3000 };
    const buffer = { id: 'buffer', pos: p(45), store: { energy: 1000 }, structureType: 'container' };
    home.containers.push(buffer);
    if (!remote) home.sources.push(source);
    game.rooms[home.name] = home; objects.set(source.id, source);
    if (remote) home.memory.developmentRemotes = { enabled: true, selectedRooms: ['E39N6'], intel: {
        E39N6: { seenAt: 100, status: 'safe', sources: [{ id: source.id }] } } };
    const loader = createSourceLoader({ globals: { Game: game, Memory: { warMode: {} }, RoomPosition: Position,
        RESOURCE_ENERGY: 'energy', STRUCTURE_CONTAINER: 'container', STRUCTURE_LINK: 'link', OK: 0,
        FIND_HOSTILE_STRUCTURES: 'hostileStructures', FIND_HOSTILE_CREEPS: 'hostileCreeps',
        STRUCTURE_INVADER_CORE: 'invaderCore', STRUCTURE_TOWER: 'tower', TOWER_ENERGY_COST: 10,
        ATTACK: 'attack', RANGED_ATTACK: 'ranged_attack', WORK: 'work', HEAL: 'heal' },
        modules: { './developmentLogistics': { controllerEnergyBuffer: () => buffer },
            './developmentRetirement': { retireDevelopmentCreep: () => false },
            role: { createRoleBehavior: role => ({ prepare: () => true, source: c => calls.push({ type: 'ordinary-source', name: c.name, role }),
                target: c => calls.push({ type: 'ordinary-target', name: c.name, role }) }) },
            squard: {}, 'combat/missions': { runCombatUnits() {} }, 'combat/defense': { requestTowerSupport() {} },
            'runtime/profiling': { isCpuProfilingEnabled: () => false, recordCpuSample() {} },
            'settings/creep': { warModeRole: ['filler'] } } });
    const movement = loader.load('utils/cachedMovement');
    loader.globals.BetterMove = { creepPathCache: cache, getNextCachedStep: c => movement.nextCachedMovementStep(c.pos, cache[c.name], moved[c.name], game.time) };
    function unit(name, x, energy, capacity = 200) {
        const store = { energy, getUsedCapacity: () => store.energy + (store.mineral || 0), getFreeCapacity: () => capacity - store.getUsedCapacity(), getCapacity: () => capacity };
        const data = remote ? { developmentRemote: { kind: 'hauler', homeRoom: home.name, targetRoom: 'E39N6', homePosition: { x: 45, y: 25 },
            source: { id: source.id, x: 5, y: 25 } } } : { mineId: source.id, sourceId: source.id };
        const creep = { name, id: name, pos: p(x), room: home, store, ticksToLive: 1000, fatigue: 0, spawning: false,
            memory: { name: `${home.name}_DEVELOP_FILLER_${source.id}_${name}`, spawnRoom: home.name, role: remote ? 'rFiller' : 'filler',
                working: energy > 0, data, development: { carryParts: 4 }, boostPlan: { tier: 0, steps: [] } },
            transfer(other, resource, amount) {
                const result = creep.transferResult ?? (creep.pos.isNearTo(other) && other.store.getFreeCapacity() >= amount && store.energy >= amount ? 0 : -8);
                calls.push({ type: 'transfer', name, target: other.name, resource, amount, result }); return result;
            },
            moveTo(target, options) {
                const route = cache[name];
                assert.equal(creep.pos.getRangeTo(route.path.posArray[route.idx]), 0, 'exchanged route is anchored at its new owner current tile');
                const next = route.path.posArray[route.idx + 1];
                calls.push({ type: 'move', name, destination: target.x, step: next.x, options });
                route.idx++; moved[name] = game.time; return 0;
            } };
        objects.set(name, creep); home.memory.creepConfig[name] = { role: creep.memory.role, data, development: { carryParts: 4 } };
        return creep;
    }
    const donor = unit('donor', 24, 200), receiver = unit('receiver', 25, 0);
    if (remote) source.pos = p(5, 'E39N6');
    const outbound = Array.from({ length: 41 }, (_, i) => p(i + 5));
    const inbound = [...outbound].reverse();
    cache.donor = { dst: p(45), idx: 19, path: { posArray: outbound, ignoreStructures: true } };
    cache.receiver = { dst: p(5, remote ? 'E39N6' : home.name), idx: 20, path: { posArray: inbound, ignoreStructures: false } };
    moved.donor = moved.receiver = game.time - 1;
    game.creeps = reverse ? { receiver, donor } : { donor, receiver };
    const relay = loader.load('creep/haulerRelay');
    function commit() {
        for (const call of calls.filter(c => c.type === 'transfer' && c.result === 0)) {
            const sender = game.creeps[call.name], recipient = game.creeps[call.target]; sender.store.energy -= call.amount; recipient.store.energy += call.amount;
        }
        for (const call of calls.filter(c => c.type === 'move')) game.creeps[call.name].pos = p(call.step);
        game.time++; calls.length = 0;
    }
    return { game, home, source, donor, receiver, cache, moved, p, calls, relay, loader,
        policy: loader.load('settings/haulerRelay').haulerRelayPolicy, commit };
}

for (const reverse of [false, true]) test(`whole-load relay retains creep identities and reuses routes in ${reverse ? 'receiver' : 'donor'}-first iteration`, () => {
    const w = world({ reverse }), donorIdentity = w.donor.memory.name, receiverIdentity = w.receiver.memory.name;
    const paths = [w.cache.donor.path.posArray, w.cache.receiver.path.posArray];
    w.relay.runHaulerRelays();
    assert.equal(w.calls.filter(c => c.type === 'transfer').length, 1);
    assert.equal(w.donor.store.energy, 200); assert.equal(w.receiver.store.energy, 0, 'native Store is never projected into memory');
    assert.equal(w.donor.memory.working, false); assert.equal(w.receiver.memory.working, true);
    assert.equal(w.donor.memory.developmentHauler.phase, 'load'); assert.equal(w.receiver.memory.developmentHauler.phase, 'deliver');
    assert.equal(w.donor.memory.name, donorIdentity); assert.equal(w.receiver.memory.name, receiverIdentity);
    assert.equal(w.donor.memory.data.mineId, 'mine'); assert.equal(w.receiver.memory.data.mineId, 'mine');
    assert.equal(w.cache.donor.path.posArray, paths[1]); assert.equal(w.cache.receiver.path.posArray, paths[0]);
    assert.deepEqual(w.calls.filter(c => c.type === 'move').map(c => [c.name, c.destination, c.step]), [['donor', 5, 23], ['receiver', 45, 26]]);
    assert.equal(w.calls.find(c => c.name === 'receiver' && c.type === 'move').options.ignoreDestructibleStructures, true);
    assert.equal(w.relay.haulerRelayHandled(w.donor), true); assert.equal(w.relay.haulerRelayHandled(w.receiver), true);
    w.commit(); assert.equal(w.donor.store.energy, 0); assert.equal(w.receiver.store.energy, 200);
    assert.equal(w.donor.pos.x, 23); assert.equal(w.receiver.pos.x, 26);
    w.relay.runHaulerRelays(); assert.equal(w.calls.length, 0, 'new directions cannot immediately hand the same energy backwards');
});

test('a same-lane automatic external hauler relays without modifying mission/source metadata', () => {
    const w = world({ remote: true }), before = JSON.stringify(w.receiver.memory.data.developmentRemote);
    w.relay.runHaulerRelays(); assert.equal(w.calls.filter(c => c.type === 'transfer').length, 1);
    assert.equal(JSON.stringify(w.receiver.memory.data.developmentRemote), before);
    assert.equal(w.receiver.memory.developmentHauler, undefined);
});

for (const remote of [false, true]) test(`${remote ? 'remote' : 'local'} mine relay accepts a Storage trip while rejecting old controller or Link destinations`, () => {
    for (const destination of ['storage', 'controller', 'link', 'full-storage']) {
        const w = world({ remote });
        const free = destination === 'full-storage' ? 0 : 1000;
        w.home.storage = { id: 'storage', structureType: 'storage', pos: w.p(destination === 'storage' || destination === 'full-storage' ? 45 : 40),
            store: { getFreeCapacity: () => free } };
        w.home.controller.pos = w.p(47);
        if (destination === 'link') w.home.links.push({ id: 'old-controller-link', structureType: 'link', pos: w.p(45) });
        const caches = [w.cache.donor, w.cache.receiver], identity = [w.donor.memory.name, w.receiver.memory.name];
        w.loader.load('creep/execution').creepWorkController();
        if (destination === 'storage') {
            assert.equal(w.calls.filter(call => call.type === 'transfer').length, 1);
            assert.equal(w.calls.filter(call => call.type.startsWith('ordinary-')).length, 0);
        } else {
            assert.equal(w.calls.filter(call => call.type === 'transfer' || call.type === 'move').length, 0);
            assert.ok(w.calls.some(call => call.type === 'ordinary-target' && call.name === w.donor.name),
                'the ordinary role can immediately replace the old delivery destination');
            assert.equal(w.cache.donor, caches[0]); assert.equal(w.cache.receiver, caches[1]);
            assert.equal(w.donor.memory.working, true); assert.equal(w.receiver.memory.working, false);
        }
        assert.deepEqual([w.donor.memory.name, w.receiver.memory.name], identity);
    }
});

test('no-Storage controller worker destinations are indexed in the same pass regardless of iteration order', () => {
    for (const reverse of [false, true]) {
        const w = world({ reverse });
        w.home.containers = []; w.home.spawns = [];
        w.game.creeps.worker = { name: 'worker', pos: w.p(44), room: w.home, spawning: false,
            memory: { role: 'upgrader' }, store: { getFreeCapacity: () => 100 } };
        w.loader.globals.PathFinder = { search() { throw Error('relay must only inspect cached movement'); } };
        w.relay.runHaulerRelays();
        assert.equal(w.calls.filter(call => call.type === 'transfer').length, 1);
    }
});

test('no-Storage relay rejects an arbitrary controller area and an exact Link destination beside a real worker', () => {
    for (const destination of ['empty-region', 'link']) {
        const w = world();
        w.home.containers = []; w.home.spawns = [];
        if (destination === 'link') {
            w.home.links.push({ id: 'controller-link', pos: w.p(45), structureType: 'link' });
            w.game.creeps.worker = { name: 'worker', pos: w.p(44), room: w.home, spawning: false,
                memory: { role: 'upgrader' }, store: { getFreeCapacity: () => 100 } };
        }
        w.relay.runHaulerRelays();
        assert.equal(w.calls.length, 0);
        assert.equal(w.relay.haulerRelayHandled(w.donor), false);
    }
});

test('the real execution pass skips both old trip phases only after a successful native handoff', () => {
    for (const failed of [false, true]) {
        const w = world({ reverse: true });
        if (failed) w.donor.transferResult = -8;
        w.loader.load('creep/execution').creepWorkController();
        assert.deepEqual(w.calls.filter(c => c.type.startsWith('ordinary-')).map(c => [c.name, c.type]),
            failed ? [['receiver', 'ordinary-source'], ['donor', 'ordinary-target']] : []);
        assert.equal(w.calls.filter(c => c.type === 'move').length, failed ? 0 : 2);
    }
});

for (const reason of ['full', 'partial', 'mixed', 'ttl', 'fatigue', 'different-source', 'stale-route', 'wrong-direction', 'near-source', 'near-sink', 'bucket', 'mature', 'boost', 'war']) {
    test(`${reason} never exchanges phases or cached routes`, () => {
        const w = world();
        if (reason === 'full') w.receiver.store.energy = 200;
        if (reason === 'partial') w.receiver.store.energy = 1;
        if (reason === 'mixed') w.receiver.store.mineral = 1;
        if (reason === 'ttl') w.receiver.ticksToLive = 50;
        if (reason === 'fatigue') w.donor.fatigue = 1;
        if (reason === 'different-source') w.receiver.memory.data.mineId = 'other';
        if (reason === 'stale-route') w.moved.receiver = 98;
        if (reason === 'wrong-direction') w.cache.receiver.path.posArray[21] = w.p(26);
        if (reason === 'near-source') w.source.pos = w.p(23);
        if (reason === 'near-sink') w.cache.donor.dst = w.p(25);
        if (reason === 'bucket') w.game.cpu.bucket = 999;
        if (reason === 'mature') w.home.controller.level = 8;
        if (reason === 'boost') w.receiver.memory.boostPlan = { steps: [{ resource: 'KH', parts: 4 }] };
        if (reason === 'war') w.loader.globals.Memory.warMode.E39N5 = true;
        const before = [w.cache.donor, w.cache.receiver], phase = [w.donor.memory.working, w.receiver.memory.working];
        w.relay.runHaulerRelays(); assert.equal(w.calls.length, 0);
        assert.equal(w.cache.donor, before[0]); assert.equal(w.cache.receiver, before[1]);
        assert.deepEqual([w.donor.memory.working, w.receiver.memory.working], phase);
    });
}

test('a recipient must fit the whole load and failed native transfer cannot change a trip', () => {
    const w = world(); w.receiver.store.getFreeCapacity = () => 199;
    w.relay.runHaulerRelays(); assert.equal(w.calls.length, 0);
    w.receiver.store.getFreeCapacity = () => 250; w.donor.transferResult = -8;
    w.relay.runHaulerRelays(); assert.equal(w.calls.filter(c => c.type === 'move').length, 0);
    assert.equal(w.donor.memory.working, true); assert.equal(w.receiver.memory.working, false);
    w.calls.length = 0; w.donor.transferResult = 0; w.relay.runHaulerRelays();
    assert.equal(w.calls.filter(c => c.type === 'transfer')[0].amount, 200);
});

test('stale or dangerous remote intelligence keeps the original withdrawal and evacuation behavior', () => {
    for (const state of ['danger', 'stale', 'retiring', 'enemy', 'invader-core', 'active-tower', 'manual', 'disabled', 'no-spawn', 'level-limit']) {
        const w = world({ remote: true });
        if (state === 'danger') w.home.memory.developmentRemotes.intel.E39N6.status = 'blocked';
        if (state === 'stale') w.home.memory.developmentRemotes.intel.E39N6.seenAt = -2000;
        if (state === 'retiring') w.receiver.memory.data.developmentRemote.retiring = true;
        if (['enemy', 'invader-core', 'active-tower'].includes(state)) w.game.rooms.E39N6 = {
            name: 'E39N6', controller: {}, find: kind => kind === 'hostileCreeps' ?
                (state === 'enemy' ? [{ getActiveBodyparts: () => 1 }] : []) :
                (state === 'invader-core' ? [{ structureType: 'invaderCore' }] : state === 'active-tower' ?
                [{ structureType: 'tower', isActive: () => true, store: { energy: 1000 } }] : []) };
        if (state === 'manual') w.game.flags.E39N5_OUT1 = { pos: { roomName: 'E39N6' } };
        if (state === 'disabled') w.loader.load('settings/developmentRemotes').developmentRemotePolicy.enabled = false;
        if (state === 'no-spawn') w.home.spawns = [];
        if (state === 'level-limit') w.home.controller.level = w.loader.load('settings/developmentRemotes').developmentRemotePolicy.maximumLevel + 1;
        w.relay.runHaulerRelays(); assert.equal(w.calls.length, 0, state);
    }
});

test('candidate indexing stops at its CPU budget before any transfer or trip changes', () => {
    const w = world(); let reads = 0;
    w.game.cpu.getUsed = () => reads++ < 2 ? 0 : 2;
    w.relay.runHaulerRelays(); assert.equal(w.calls.length, 0);
    assert.equal(w.donor.memory.working, true); assert.equal(w.receiver.memory.working, false);
    assert.equal(w.relay.getHaulerRelayStatus().current.pairs, 0);
});

test('an unsafe home and low CPU headroom leave ordinary hauling responsible for the tick', () => {
    for (const hazard of ['hostile', 'headroom']) {
        const w = world();
        if (hazard === 'hostile') w.home.enemies = [{}];
        else w.game.cpu.tickLimit = 2;
        w.relay.runHaulerRelays(); assert.equal(w.calls.length, 0, hazard);
        assert.equal(w.relay.haulerRelayHandled(w.donor), false);
    }
});

test('previous movement prediction rejects off-path, exhausted and cross-room boundary steps', () => {
    const w = world(), predict = w.loader.load('utils/cachedMovement').nextCachedMovementStep;
    const route = w.cache.donor;
    assert.equal(predict(w.donor.pos, route, 99, 100).x, 25);
    assert.equal(predict(w.donor.pos, route, 98, 100), undefined);
    assert.equal(predict(w.p(30), route, 99, 100), undefined);
    const edge = { idx: 0, path: { posArray: [w.p(49), w.p(0, 'E40N5')] } };
    assert.equal(predict(w.p(49), edge, 99, 100), undefined);
    assert.equal(predict(w.p(49), { idx: 0, path: { posArray: [w.p(49)] } }, 99, 100), undefined);
    assert.equal(predict(w.p(23), route, 99, 100).x, 24, 'a blocked last step retries its adjacent actual route');
});

test('native prototype coordinates survive prediction and enable a real execution handoff', () => {
    const w = world();
    class NativePosition {
        constructor(position) { Object.defineProperty(this, 'coordinates', { value: [position.x, position.y, position.roomName] }); }
        get x() { return this.coordinates[0]; }
        get y() { return this.coordinates[1]; }
        get roomName() { return this.coordinates[2]; }
    }
    for (const route of Object.values(w.cache)) route.path.posArray = route.path.posArray.map(p => new NativePosition(p));
    assert.deepEqual(Object.keys(w.cache.donor.path.posArray[20]), [], 'native coordinate accessors cannot be spread');
    const step = w.loader.globals.BetterMove.getNextCachedStep(w.donor);
    assert.equal(step.x, 25); assert.equal(step.y, 25); assert.equal(step.roomName, w.home.name);
    w.loader.load('creep/execution').creepWorkController();
    assert.equal(w.calls.filter(c => c.type === 'transfer').length, 1);
    assert.equal(w.calls.filter(c => c.type === 'move').length, 2);
    assert.equal(w.calls.filter(c => c.type.startsWith('ordinary-')).length, 0);
});

test('mature rooms do not scan the creep population and relay statistics stay bounded', () => {
    const w = world(); w.home.controller.level = 8;
    Object.defineProperty(w.game, 'creeps', { get() { throw Error('mature relay scanned all creeps'); } });
    for (let n = 0; n < 150; n++) { w.relay.runHaulerRelays(); w.game.time++; }
    const status = w.relay.getHaulerRelayStatus();
    assert.ok(status.rolling.ticks <= 100); assert.equal(status.rolling.pairs, 0);
});

test('closing local or remote homes leave all haulers to evacuation without changing cached trips', () => {
    for (const remote of [false, true]) {
        const w = world({ remote }); w.home.memory.evacuation = { status: 'draining' };
        const original = w.cache.donor;
        w.relay.runHaulerRelays();
        assert.equal(w.calls.length, 0); assert.equal(w.cache.donor, original);
        assert.equal(w.relay.haulerRelayHandled(w.donor), false);
        delete w.home.memory.evacuation; w.game.time++;
        w.moved.donor = w.moved.receiver = w.game.time - 1;
        w.relay.runHaulerRelays();
        assert.equal(w.calls.filter(call => call.type === 'transfer').length, 1);
    }
});
