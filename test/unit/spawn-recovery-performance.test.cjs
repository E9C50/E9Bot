const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const nativeBodies = require('../helpers/native-bodies.cjs');

function fixture() {
    const counts = { roomReads: 0, activeParts: 0, selections: 0, intents: 0 };
    const plans = [], game = { time: 100, creeps: {}, flags: {}, rooms: {}, getObjectById: () => null };
    const room = { name: 'W1N1', my: true, controller: { my: true, level: 8 },
        energyAvailable: 300, energyCapacityAvailable: 12900,
        memory: { creepConfig: { pending: { role: 'filler', name: 'pending', spawnRoom: 'W1N1', data: {} } },
            creepSpawnQueue: ['pending'] }, towers: [], labs: [], spawns: [], links: [] };
    game.rooms[room.name] = room;
    class NativeSpawn {
        spawnCreep() { counts.intents++; throw new Error('incomplete energy must not issue a birth'); }
    }
    let selector;
    const loader = createSourceLoader({ globals: { ...nativeBodies.globals, Game: game, Memory: {},
        StructureSpawn: NativeSpawn,
        BODYPART_COST: { work: 100, carry: 50, move: 50, claim: 600, tough: 10, attack: 80, ranged_attack: 150, heal: 250 },
    }, modules: { ...nativeBodies.modules,
        role: { isRoleSupported: () => true, createRoleBehavior: () => ({ isNeed: () => true }) },
        'creep/bodySelection': { selectCreepBody(...args) {
            counts.selections++; const plan = selector.selectCreepBody(...args); plans.push(plan); return plan;
        } },
        'creep/developmentRemotes': { isDevelopmentRemoteData: () => false },
        'combat/spawning': { combatSpawnAllowed: () => true, recordCombatSpawn() {} },
        'room/evacuationState': { isRoomEvacuating: () => false },
        'creep/storageFillerLifecycle': { isMatureStorageFiller: () => false },
        'creep/spawnEnergyPolicy': { needsEmergencyBody: () => false },
        'shard/targetDismantleControl': { isTargetDismantleSpawnReserved: () => false },
        'creep/remoteCommissioning': { remoteSpawnAllowed: () => true },
        'runtime/cpuRecovery': { cpuRecoveryWorkDue: () => true, hasPendingRoomBoost: () => false,
            isCpuRecoveryActive: () => false },
        'room/labBoostPriority': { prioritizeLabBoostJobs: () => false },
    } });
    selector = loader.load('creep/bodySelection');
    const Spawn = loader.load('mount/structure/SpawnExtension').default;
    for (let index = 0; index < 3; index++) {
        const spawn = new Spawn(); spawn.room = room; room.spawns.push(spawn);
    }
    function unit(name, role, currentRoom = room) {
        const state = { room: currentRoom, work: 1, carry: 1, move: 1 };
        const creep = { name, memory: { role, spawnRoom: room.name, data: {} }, ticksToLive: 1000,
            getActiveBodyparts(part) { counts.activeParts++; return state[part] || 0; } };
        Object.defineProperty(creep, 'room', { get() { counts.roomReads++; return state.room; } });
        game.creeps[name] = creep;
        return { creep, state };
    }
    return { loader, room, game, counts, plans, unit };
}

test('three idle Spawns waiting on a full body read only the two live mining and hauling rooms', () => {
    const w = fixture();
    for (let index = 0; index < 63; index++) w.unit(`unrelated${index}`, 'manager');
    w.unit('miner', 'harvester'); w.unit('carrier', 'filler');
    w.loader.load('module/StructureController').structureWorkController();
    assert.equal(w.counts.roomReads, 6, 'two relevant units × three Spawns, formerly 65 × two room reads × three');
    assert.equal(w.counts.activeParts, 9, 'WORK/CARRY/MOVE health remains checked for each Spawn');
    assert.equal(w.counts.selections, 3, 'this change does not cache the body or boost proposal');
    assert.deepEqual(w.plans.map(plan => plan.body.length), [50, 50, 50]);
    assert.equal(w.counts.intents, 0);
    assert.deepEqual(w.room.memory.creepSpawnQueue, ['pending']);
});

test('Spawn recovery reads current disabled, moved, boosting and restored transport within the same tick', () => {
    const w = fixture(); w.unit('miner', 'harvester');
    const carrier = w.unit('carrier', 'filler'), spawn = w.room.spawns[0];
    const fallback = { role: 'filler', name: 'fallback', spawnRoom: w.room.name, data: {}, bodyProfile: { carryParts: 2 } };
    w.room.memory.creepConfig.fallback = fallback;
    const queue = ['pending', 'fallback'];
    assert.equal(spawn.affordableRecovery(queue), undefined);
    carrier.state.move = 0;
    assert.equal(spawn.affordableRecovery(queue).memory, fallback);
    carrier.state.move = 1;
    carrier.state.room = { name: 'W2N1' };
    assert.equal(spawn.affordableRecovery(queue).memory, fallback);
    carrier.state.room = w.room;
    carrier.creep.memory.boostPlan = { tier: 3, steps: [{}] };
    assert.equal(spawn.affordableRecovery(queue).memory, fallback);
    carrier.creep.memory.boostPlan.completed = true;
    assert.equal(spawn.affordableRecovery(queue), undefined);
    assert.equal(w.counts.intents, 0);
});

test('irrelevant roles never resolve native rooms during recovery and active spawning skips selection', () => {
    const w = fixture();
    for (let index = 0; index < 65; index++) w.unit(`unrelated${index}`, 'repairer');
    assert.equal(w.room.spawns[0].affordableRecovery(['pending']), undefined);
    assert.equal(w.counts.roomReads, 0);
    w.room.spawns[0].spawning = { name: 'already-birthing' };
    w.room.spawns[0].doWork();
    assert.equal(w.counts.selections, 0);
});
