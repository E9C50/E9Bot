const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const nativeBodies = require('../helpers/native-bodies.cjs');

function world() {
    class Position {
        constructor(x, y) { Object.assign(this, { x, y, roomName: 'E39N5' }); }
        getRangeTo(value) { const p = value.pos || value; return Math.max(Math.abs(this.x - p.x), Math.abs(this.y - p.y)); }
        isNearTo(value) { return this.getRangeTo(value) <= 1; }
        inRangeTo(value, range) { return this.getRangeTo(value) <= range; }
    }
    const p = (x, y) => new Position(x, y), objects = new Map(), calls = [], intents = [], births = [];
    const store = (energy, capacity) => ({ energy, getCapacity: () => capacity, getUsedCapacity() { return this.energy; }, getFreeCapacity() { return capacity - this.energy; } });
    const structure = (id, type, x, y, energy, capacity) => {
        const target = { id, structureType: type, pos: p(x, y), store: store(energy, capacity), my: true };
        objects.set(id, target); return target;
    };
    const source = { id: 'mine', pos: p(42, 32), energy: 3000, energyCapacity: 3000 };
    const storage = structure('storage', 'storage', 18, 29, 0, 1000000);
    const terminal = structure('terminal', 'terminal', 19, 30, 8509, 300000);
    const container = structure('mine-container', 'container', 43, 33, 0, 2000);
    const controllerBuffer = structure('controller-container', 'container', 11, 31, 2000, 2000);
    let spawn = structure('spawn', 'spawn', 17, 27, 300, 300);
    const extensions = Array.from({ length: 38 }, (_, i) => structure(`extension-${i}`, 'extension', 20 + i % 10, 24 + Math.floor(i / 10), 0, 50));
    const minerBody = [...Array(13).fill('work'), ...Array(3).fill('carry'), ...Array(13).fill('move')];
    const distributorBody = [...Array(22).fill('carry'), ...Array(22).fill('move')];
    const room = { name: 'E39N5', my: true, level: 6, energyCapacityAvailable: 2200, controller: { my: true, level: 6, ticksToDowngrade: 100000, pos: p(9, 29) },
        storage, terminal, sources: [source], containers: [controllerBuffer, container], links: [], droppedResource: [], spawns: [spawn], extensions,
        memory: { roomFillJob: {}, creepConfig: {
            miner: { role: 'harvester', spawnRoom: 'E39N5', data: { sourceId: source.id }, spawnPriority: 1, development: { fullBody: true, stationary: true }, testBody: minerBody },
            distributor: { role: 'filler', spawnRoom: 'E39N5', data: { sourceId: storage.id }, spawnPriority: 2, development: { fullBody: true }, testBody: distributorBody },
        } } };
    Object.defineProperty(room, 'energyAvailable', { get: () => [spawn, ...extensions].reduce((total, target) => total + target.store.energy, 0) });
    source.room = room; objects.set(source.id, source);
    const game = { time: 100, shard: { name: 'shard1' }, rooms: { E39N5: room }, creeps: {}, getObjectById: id => objects.get(id) || null };
    function filler(name = 'carrier', capacity = 600) {
        const carrier = { name, room, pos: p(42, 34), spawning: false, ticksToLive: 1200, store: store(0, capacity),
            memory: { role: 'filler', name: 'E39N5_DEVELOP_FILLER_mine_0', spawnRoom: room.name, data: { sourceId: container.id, mineId: source.id },
                developmentHauler: { shard: 'shard1', roomName: room.name, mineId: source.id, phase: 'load', energy: 0, lastGainTick: 99 } },
            getActiveBodyparts: part => part === 'carry' || part === 'move' ? 12 : 0,
            moveTo(target) { calls.push({ method: 'move', target: target.id }); this.pos = p(target.pos.x + 1, target.pos.y); return 0; },
            withdraw(target, resource, amount) {
                calls.push({ method: 'withdraw', target: target.id, amount });
                if (!this.pos.isNearTo(target)) return -9;
                intents.push(() => { const quantity = Math.min(amount, target.store.energy, this.store.getFreeCapacity()); target.store.energy -= quantity; this.store.energy += quantity; }); return 0;
            },
            transfer(target, resource, amount) {
                calls.push({ method: 'transfer', target: target.id, amount });
                if (!this.pos.isNearTo(target)) return -9;
                intents.push(() => { const quantity = Math.min(amount ?? this.store.energy, this.store.energy, target.store.getFreeCapacity()); this.store.energy -= quantity; target.store.energy += quantity; }); return 0;
            },
            pickup() { assert.fail('there is no dropped energy in this world'); },
        };
        game.creeps[name] = carrier; return carrier;
    }
    const carrier = filler(); let previews = 0, linked = false;
    class NativeSpawn {
        spawnCreep(body, name, { memory }) {
            const cost = body.reduce((sum, part) => sum + ({ work: 100, carry: 50, move: 50 })[part], 0);
            if (cost > room.energyAvailable) return -6;
            let remaining = cost;
            for (const target of [spawn, ...extensions]) {
                const spent = Math.min(remaining, target.store.energy); target.store.energy -= spent; remaining -= spent;
            }
            const born = memory.role === 'filler' ? filler(name, body.filter(part => part === 'carry').length * 50) : {
                name, room, pos: source.pos, store: store(0, 150), ticksToLive: 1500,
                getActiveBodyparts: part => body.filter(type => type === part).length,
            };
            born.memory = { ...memory }; born.spawning = true; born.body = body.map(type => ({ type, hits: 100 }));
            if (memory.role === 'filler') delete born.memory.developmentHauler;
            game.creeps[name] = born;
            this.spawning = { name, remainingTime: body.length * 3 };
            births.push({ name, role: memory.role, cost, parts: body.length }); return 0;
        }
    }
    const loader = createSourceLoader({ globals: { ...nativeBodies.globals, Game: game, Memory: {}, StructureSpawn: NativeSpawn, RESOURCE_ENERGY: 'energy', WORK: 'work', CARRY: 'carry', MOVE: 'move',
        BODYPART_COST: { work: 100, carry: 50, move: 50 }, STRUCTURE_CONTAINER: 'container', STRUCTURE_LINK: 'link', OK: 0, ERR_NOT_IN_RANGE: -9 },
        modules: { ...nativeBodies.modules,
            'room/sourceLinks': { sourceLinkWithCenter: () => linked ? { id: 'source-link' } : undefined },
            'creep/developmentLogistics': { controllerEnergyBuffer: () => controllerBuffer },
            'creep/haulerPickup': { haulerEnergyPickupReserved: () => 0, reserveHaulerEnergyPickup() {},
                haulerEnergyPickupHandled: () => false, pickupAdjacentHaulerEnergy: () => false, continueCachedHaulerRoute() {} },
            utils: { getDistance: (first, second) => first.getRangeTo(second), sha1String: value => value },
            role: { isRoleSupported: () => true, createRoleBehavior: () => ({ isNeed: () => true }) },
            'creep/developmentRemotes': { isDevelopmentRemoteData: () => false },
            'creep/remoteCommissioning': { remoteSpawnAllowed: () => true, recordRemoteEnergyDelivery() {} },
            'combat/spawning': { combatSpawnAllowed: () => true, recordCombatSpawn() {} },
            'shard/targetDismantleControl': { isTargetDismantleSpawnReserved: () => false },
            'room/labBoostPriority': { prioritizeLabBoostJobs: () => false },
            './haulerPickup': { haulerEnergyPickupReserved: () => 0, reserveHaulerEnergyPickup() {}, haulerEnergyPickupHandled: () => false, pickupAdjacentHaulerEnergy: () => false, continueCachedHaulerRoute() {} },
            'room/labBoostPriority': { boostLabEnergyDeficit: () => 0, prioritizeLabBoostJobs: () => false, recordBoostLabEnergyTransfer() {} },
            'creep/storageFillerLifecycle': { retireSupersededStorageFiller: () => false },
        } });
    const api = loader.load('creep/fillerProductionRecovery');
    spawn = Object.assign(new (loader.load('mount/structure/SpawnExtension').default)(), spawn);
    spawn.room = room; room.spawns[0] = spawn; objects.set(spawn.id, spawn);
    room.memory.creepConfig.manager = { role: 'manager', spawnRoom: room.name, data: {}, spawnPriority: 0,
        development: { fullBody: true, stationary: true } };
    const secondSource = { id: 'second-mine', pos: p(36, 34), energy: 3000, energyCapacity: 3000, room };
    room.sources.push(secondSource); objects.set(secondSource.id, secondSource);
    room.memory.creepConfig.secondMiner = { role: 'harvester', spawnRoom: room.name, data: { sourceId: secondSource.id }, spawnPriority: 1,
        development: { fullBody: true, stationary: true } };
    const behavior = loader.load('role/base/RoleBaseFiller').default(carrier.memory.data);
    return { api, game, room, carrier, filler, source, container, controllerBuffer, terminal, storage, spawn, calls, births, loader, behavior,
        get previews() { return previews; },
        setLinked(value) { linked = value; },
        tick(run = () => {
            const action = carrier.memory.working ? 'target' : 'source'; return behavior[action](carrier);
        }) {
            const result = run(); intents.splice(0).forEach(intent => intent());
            if (spawn.spawning && --spawn.spawning.remainingTime <= 0) {
                game.creeps[spawn.spawning.name].spawning = false; spawn.spawning = undefined;
            }
            const miner = game.creeps.miner;
            if (miner && !miner.spawning && source.energy > 0) {
                const harvested = Math.min(source.energy, 26, container.store.getFreeCapacity()); source.energy -= harvested; container.store.energy += harvested;
            }
            game.time++; if (game.time % 300 === 0) source.energy = 3000;
            return result;
        },
        queue() { room.memory.creepSpawnQueue = Array.from(loader.load('creep/spawnQueue').buildSpawnQueue(room)); return room.memory.creepSpawnQueue; },
        miner() { const miner = { name: 'miner', room, pos: source.pos, spawning: false, ticksToLive: 1400,
            memory: { role: 'harvester', spawnRoom: room.name, data: { sourceId: source.id } }, getActiveBodyparts: part => part === 'work' ? 13 : part === 'carry' ? 3 : 13 };
            game.creeps.miner = miner; return miner; },
        carrierPredicate: loader.load('creep/spawnEnergyCarrier').isSpawnEnergyCarrier };
}

test('complete production recovery crosses Terminal loan, miner birth, temporary Spawn supply, Storage handover and repayment', () => {
    const w = world(), lane = JSON.stringify(w.carrier.memory.data), originalState = JSON.stringify(w.carrier.memory.developmentHauler);
    for (let count = 0; count < 160 && w.births.length === 0; count++) {
        w.queue(); w.spawn.doWork(); w.tick();
        assert.ok(!w.births.some(birth => birth.name === 'manager'));
    }
    assert.deepEqual(w.births, [{ name: 'miner', role: 'harvester', cost: 2100, parts: 29 }]);
    assert.equal(w.terminal.store.energy, 6709); assert.equal(w.room.memory.productionRecoveryTerminalDebt.restoreEnergy, 8509);
    assert.equal(JSON.stringify(w.carrier.memory.data), lane);
    assert.equal(JSON.stringify(w.carrier.memory.developmentHauler), originalState, 'critical inventory loan keeps the mine loading state intact');

    for (let count = 0; count < 500 && w.births.length < 2; count++) {
        assert.equal(w.carrierPredicate(w.room, w.carrier), true, 'miner runs before Filler and accepts the previous tick marker');
        w.queue();
        assert.equal(w.room.memory.creepSpawnQueue[0], 'distributor', 'fresh temporary supply reserves permanent distribution before Manager or the second miner');
        w.spawn.doWork();
        w.tick();
        assert.equal(w.carrierPredicate(w.room, w.carrier), true, 'Filler refreshes its temporary Spawn supply after its action');
    }
    assert.deepEqual(w.births.slice(0, 2), [
        { name: 'miner', role: 'harvester', cost: 2100, parts: 29 },
        { name: 'distributor', role: 'filler', cost: 2200, parts: 44 },
    ]);
    assert.equal(w.terminal.store.energy, 6709, 'productive bridge does not borrow a second Terminal loan or repay before permanent distribution');
    while (w.game.creeps.distributor.spawning) { w.tick(); assert.ok(w.carrier.memory.productionRecoverySpawn); }

    for (let count = 0; count < 900 && w.room.memory.productionRecoveryTerminalDebt; count++) w.tick();
    assert.equal(w.carrier.memory.productionRecoverySpawn, undefined);
    assert.equal(w.room.memory.productionRecoveryTerminalDebt, undefined);
    assert.equal(w.terminal.store.energy, 8509, 'the critical 1800-energy loan is repaid exactly');
    assert.equal(w.controllerBuffer.store.energy, 2000, 'controller supply is never borrowed');
    assert.equal(JSON.stringify(w.carrier.memory.data), lane, 'temporary deliveries never rewrite permanent mine binding');

    const stored = w.storage.store.energy;
    for (let count = 0; count < 480 && w.storage.store.energy <= stored; count++) w.tick();
    assert.ok(w.storage.store.energy > stored, 'the original mine carrier resumes its normal mine-to-Storage lane');
    assert.equal(w.carrierPredicate(w.room, w.carrier), false, 'ordinary mine imports do not pretend to be permanent Spawn distribution');
    assert.ok(!w.births.some(birth => birth.name === 'manager'));
});
