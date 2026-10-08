const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

test('tower damage keeps the optimal, falling, and minimum damage boundaries using game constants', () => {
    const { default: BattleCalc } = createSourceLoader({
        globals: {
            WORK: 'work', ATTACK: 'attack', RANGED_ATTACK: 'ranged_attack', HEAL: 'heal',
            DISMANTLE_POWER: 50, ATTACK_POWER: 30, RANGED_ATTACK_POWER: 10, HEAL_POWER: 12,
            BOOSTS: {}, TOWER_POWER_ATTACK: 600, TOWER_OPTIMAL_RANGE: 5,
            TOWER_FALLOFF_RANGE: 20, TOWER_FALLOFF: 0.75
        }
    }).load('utils/BattleCalc');
    for (const [distance, expected] of [[0, 600], [5, 600], [6, 570], [12, 390], [20, 150], [49, 150]]) {
        assert.equal(BattleCalc.calcTowerDamage(distance), expected);
    }
});

function spawnWorld(body = ['move']) {
    const calls = [];
    const bodyCalls = [];
    const game = { creeps: { living: { room: { name: 'W1N1' }, memory: { role: 'builder', spawnRoom: 'W1N1' } } } };
    const loader = createSourceLoader({
        globals: { StructureSpawn: class {}, Game: game, OK: 0, BODYPART_COST: { move: 50, carry: 50 } },
        modules: {
            'settings/creep': {
                bodyConfigs: { harvester: [{}], builder: [{}] },
                roleBaseEnum: { HARVESTER: 'harvester', FILLER: 'filler' }, roleAdvEnum: { MANAGER: 'manager' }
            },
            role: { isRoleSupported: role => ['harvester', 'builder', 'manager'].includes(role) },
            'creep/bodySelection': { selectCreepBody(room, config, force) {
                bodyCalls.push(force); return { body, boostPlan: { tier: 0, steps: [] } } } },
            'creep/boosting': { reserveBoostPlan() {} },
            'creep/developmentRemotes': { isDevelopmentRemoteData: () => false },
            'shard/targetDismantleControl': { isTargetDismantleSpawnReserved: () => false }
        }
    });
    const SpawnExtension = loader.load('mount/structure/SpawnExtension').default;
    const spawn = new SpawnExtension();
    spawn.spawnCreep = (parts, name, options) => { calls.push({ parts, name, memory: options.memory }); return 0; };
    return { spawn, calls, bodyCalls };
}

test('spawn discards stale, living, and unsupported queue entries before spawning valid demand', () => {
    const { spawn, calls, bodyCalls } = spawnWorld();
    const valid = { role: 'harvester', data: { sourceId: 'source' } };
    const queue = ['stale', 'living', 'unsupported', 'valid'];
    spawn.room = { name: 'W1N1', memory: { creepSpawnQueue: queue, creepConfig: {
        living: { role: 'harvester' }, unsupported: { role: 'rAttacker' }, valid
    } } };
    assert.doesNotThrow(() => spawn.doWork());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'valid');
    assert.equal(calls[0].memory, valid);
    assert.deepEqual(bodyCalls, [false]);
    assert.deepEqual(queue, []);

    spawn.room = { memory: { creepSpawnQueue: ['stale'] } };
    assert.doesNotThrow(() => spawn.doWork());
    assert.equal(calls.length, 1);
    assert.deepEqual(spawn.room.memory.creepSpawnQueue, []);
});

test('an unaffordable empty body waits in the queue without attempting a spawn', () => {
    const { spawn, calls } = spawnWorld([]);
    spawn.room = { name: 'W1N1', memory: { creepSpawnQueue: ['valid'], creepConfig: { valid: { role: 'builder' } } } };
    spawn.doWork();
    assert.deepEqual(calls, []);
    assert.deepEqual(spawn.room.memory.creepSpawnQueue, ['valid']);
});

test('a hub replacement waits for its complete 2500 energy body instead of forcing a small spawn', () => {
    const body = [...Array(49).fill('carry'), 'move'];
    const { spawn, calls, bodyCalls } = spawnWorld(body);
    spawn.room = { name: 'W1N1', energyAvailable: 300, memory: {
        creepSpawnQueue: ['manager'], creepConfig: { manager: { role: 'manager', data: {} } }
    } };
    spawn.doWork();
    assert.deepEqual(bodyCalls, [false]);
    assert.deepEqual(calls, []);
    assert.deepEqual(spawn.room.memory.creepSpawnQueue, ['manager']);
    spawn.room.energyAvailable = 2500;
    spawn.doWork();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].parts.length, 50);
});

test('custom body tables may have any length and emergency bodies fit current available energy', () => {
    const costs = { move: 50, carry: 50, work: 100 };
    const { getBodyConfig } = createSourceLoader({
        globals: { BODYPART_COST: costs },
        modules: { jssha: class {}, 'settings/settings': { colorEnum: { GREEN: 'green' } } }
    }).load('utils');
    const room = { energyAvailable: 150, energyCapacityAvailable: 500 };
    const configs = [{ move: 1, carry: 1 }, { move: 2, carry: 2 }, { work: 2, carry: 2, move: 2 }];
    const emergencyBody = getBodyConfig(room, configs, true);
    const bodyCost = body => Array.from(body).reduce((total, part) => total + costs[part], 0);
    assert.equal(bodyCost(emergencyBody), 100);
    assert.ok(bodyCost(emergencyBody) <= room.energyAvailable);
    assert.equal(bodyCost(getBodyConfig(room, configs)), 400, 'ordinary demand may wait for room capacity energy');
    assert.deepEqual(Array.from(getBodyConfig(room, [{ work: 2 }], true)), []);
    assert.equal(bodyCost(getBodyConfig(room, [{ move: 1 }], true)), 50);
    assert.deepEqual(Array.from(getBodyConfig(room, [], true)), []);
});

function towerWorld() {
    const calls = [];
    const game = { time: 10, shard: { name: 'shard3' }, creeps: {} };
    const intelligence = {
        combatSnapshot: room => ({ enemies: room.enemies, friendlies: [], towers: [], structures: [] }),
        combatPower: () => ({ attack: 0, ranged: 0, heal: 0, rangedHeal: 0, dismantle: 0, claim: 0 }),
        effectiveDamage: (target, raw) => raw, incomingDamage: () => 0, towerDamage: () => 600, towerHeal: () => 400,
        isCombatHostile: target => !target.my, isInvulnerable: () => false,
    };
    const loader = createSourceLoader({ globals: { Game: game, RESOURCE_ENERGY: 'energy', TOWER_ENERGY_COST: 10, OK: 0 }, modules: {
        'combat/intelligence': intelligence, './intelligence': intelligence,
    } });
    const tower = (name, energy) => ({
        store: { energy },
        heal: target => { calls.push(`${name}:heal:${target.id}`); return 0; },
        attack: target => { calls.push(`${name}:attack:${target.id}`); return 0; }
    });
    return { api: loader.load('role/support/towers'), game, calls, tower };
}

test('tower support tolerates a missing target, room, or tower', () => {
    const { api, calls } = towerWorld();
    assert.doesNotThrow(() => api.supportWithTowers(undefined));
    assert.doesNotThrow(() => api.supportWithTowers({ id: 'missingRoom' }));
    assert.doesNotThrow(() => api.supportWithTowers({ id: 'emptyRoom', room: { towers: [] } }));
    assert.deepEqual(calls, []);
});

test('tower support heals injured friendly creeps immediately and never duplicates an intent within a tick', () => {
    const { api, game, calls, tower } = towerWorld();
    const target = { id: 'friendly', my: true, body: [], hits: 50, hitsMax: 100, room: { name: 'W1N1', enemies: [], towers: [tower('one', 100)] } };
    api.supportWithTowers(target, { healFriendly: true });
    assert.deepEqual(calls, ['one:heal:friendly']);
    api.supportWithTowers(target, { healFriendly: true }); assert.equal(calls.length, 1);
    game.time = 11;
    api.supportWithTowers(target, { healFriendly: true });
    assert.equal(calls.filter(call => call.includes(':heal:')).length, 2);
});

test('usable towers attack even when another tower cannot afford the native energy cost', () => {
    const { api, game, calls, tower } = towerWorld();
    const towers = [tower('one', 100), tower('two', 0)];
    const target = { id: 'enemy', my: false, body: [], hits: 1200, hitsMax: 1200, pos: { x: 10, y: 10, roomName: 'W1N1' }, room: { name: 'W1N1', enemies: [], towers } };
    target.room.enemies.push(target);
    api.supportWithTowers(target);
    assert.deepEqual(calls, ['one:attack:enemy']);
    towers[1].store.energy = 1;
    api.supportWithTowers(target);
    assert.deepEqual(calls, ['one:attack:enemy']);
    towers[1].store.energy = 10;
    game.time++;
    api.supportWithTowers(target);
    assert.deepEqual(calls, ['one:attack:enemy', 'one:attack:enemy', 'two:attack:enemy']);
});

test('an obsolete flag duo with only its second member withdraws without following the flag', () => {
    const moves = [];
    let boosts = 0;
    const flagPosition = { roomName: 'W1N1', lookFor: () => [] };
    const second = {
        id: 'second', memory: { spawnRoom: 'W1N1' }, body: [], spawning: false, hits: 100, hitsMax: 100, fatigue: 0,
        room: { name: 'W1N1', enemies: [], my: false },
        pos: { findInRange: () => [], isEqualTo: () => false },
        goBoost() { boosts++; return true; }, moveTo: target => moves.push(target)
    };
    const game = { creeps: { second }, flags: { rally: { pos: flagPosition, color: 0 } } };
    const behavior = createSourceLoader({
        globals: { Game: game, HEAL: 'heal', ATTACK: 'attack', RANGED_ATTACK: 'ranged_attack', WORK: 'work', COLOR_WHITE: 10, FIND_HOSTILE_CREEPS: 1, LOOK_STRUCTURES: 'structure' },
        modules: { 'combat/support': { returnCombatUnit: creep => moves.push(creep.id) } }
    }).load('squard/TeamDuo').default({ teamFlag: 'rally', creepNameList: ['missing', 'second'] });
    assert.equal(behavior.prepare(), true);
    assert.equal(boosts, 1);
    assert.equal(behavior.doWork(), true);
    assert.deepEqual(moves, ['second']);
});

test('an unspawned PowerCreep waits when its flag room is not visible', () => {
    let spawns = 0;
    const pc = { name: 'operator', spawn: () => spawns++ };
    const game = { powerCreeps: { operator: pc }, flags: { PC_operator: { pos: { roomName: 'unseen' } } }, rooms: {} };
    const { powerSpawnController } = createSourceLoader({
        globals: { Game: game }, modules: { utils: { getDistance: () => 0 } }
    }).load('role/pc/PowerCreep');
    assert.doesNotThrow(powerSpawnController);
    assert.equal(spawns, 0);
});

test('a PowerCreep needing renewal waits safely without a power spawn or power bank', () => {
    const renewals = [];
    const room = { name: 'W1N1', powerBanks: [] };
    const pc = {
        name: 'operator', room, ticksToLive: 100, memory: {},
        isPowerAvailable: () => false, renew: target => renewals.push(target)
    };
    const game = { powerCreeps: { operator: pc }, flags: { PC_operator: { pos: { roomName: 'W1N1' } } }, rooms: { W1N1: room } };
    const { powerSpawnController } = createSourceLoader({
        globals: { Game: game, PWR_GENERATE_OPS: 1 }, modules: { utils: { getDistance: () => 0 } }
    }).load('role/pc/PowerCreep');
    assert.doesNotThrow(powerSpawnController);
    assert.equal(pc.memory.needRenew, true);
    assert.deepEqual(renewals, []);
});
