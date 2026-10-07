const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function loadRegistry() {
    // Registry tests isolate factories; development wrappers are exercised with native globals separately.
    const modules = { 'creep/developmentRemotes': { withDevelopmentRemoteRole: (_data, behavior) => behavior } };
    for (const category of ['base', 'adv', 'war']) {
        const directory = path.resolve(__dirname, '../../src/role', category);
        for (const file of fs.readdirSync(directory).filter(file => file.endsWith('.ts'))) {
            modules[`./${category}/${path.basename(file, '.ts')}`] = data => ({ data });
        }
    }
    return createSourceLoader({ modules }).load('role');
}

test('role registry rejects unknown, unimplemented, and inherited property names', () => {
    const registry = loadRegistry();
    for (const role of [undefined, 'unknown', 'rAttacker', 'toString', 'constructor', '__proto__']) {
        assert.equal(registry.isRoleSupported(role), false, String(role));
        assert.equal(registry.createRoleBehavior(role, {}), undefined, String(role));
    }
    for (const role of ['harvester', 'manager', 'rHarvester', 'defender', 'rdefender']) {
        assert.equal(registry.isRoleSupported(role), true, role);
    }
});

test('role registry passes the existing data object to the factory', () => {
    const registry = loadRegistry();
    const data = { sourceId: 'source', custom: true };
    assert.equal(registry.createRoleBehavior('harvester', data).data, data);
});

function queueApi() {
    return createSourceLoader({
        globals: { RESOURCE_ENERGY: 'energy' },
        modules: {
            'settings/creep': { roleBaseEnum: { HARVESTER: 'harvester', FILLER: 'filler' } },
            role: { isRoleSupported: role => ['harvester', 'filler', 'manager', 'builder'].includes(role) }
        }
    }).load('creep/spawnQueue');
}

function liveCreep(role, roomName = 'W1N1') {
    return { room: { name: roomName }, memory: { role } };
}

function demand(role, priority, sourceId) {
    return { role, spawnPriority: priority, data: sourceId ? { sourceId } : {} };
}

test('spawn queue uses normal priorities, ignores living and unsupported units, and preserves Memory', () => {
    const oldQueue = ['previous'];
    const config = {
        worker: demand('builder', 4), filler: demand('filler', 2),
        manager: demand('manager', 0), living: demand('harvester', 1), unsupported: demand('rAttacker', -1)
    };
    const room = { name: 'W1N1', memory: { creepConfig: config, creepSpawnQueue: oldQueue }, containers: [] };
    const queue = queueApi().buildSpawnQueue(room, { living: liveCreep('harvester'), activeFiller: liveCreep('filler') });
    assert.deepEqual(Array.from(queue), ['manager', 'filler', 'worker']);
    assert.equal(room.memory.creepConfig, config);
    assert.equal(room.memory.creepSpawnQueue, oldQueue);
    assert.deepEqual(oldQueue, ['previous']);
});

test('without a live harvester, its emergency replacement precedes a manager', () => {
    const room = {
        name: 'W1N1', containers: [],
        memory: { creepConfig: { manager: demand('manager', 0), harvester: demand('harvester', 1), filler: demand('filler', 2) } }
    };
    assert.deepEqual(Array.from(queueApi().buildSpawnQueue(room, {})), ['harvester', 'manager', 'filler']);
});

test('with harvesters but no filler, choose the filler for the first energized container', () => {
    const room = {
        name: 'W1N1',
        containers: [{ id: 'empty', store: { energy: 0 } }, { id: 'energized', store: { energy: 1000 } }],
        memory: { creepConfig: {
            manager: demand('manager', 0), emptyFiller: demand('filler', 2, 'empty'),
            energizedFiller: demand('filler', 2, 'energized'), builder: demand('builder', 4)
        } }
    };
    const queue = queueApi().buildSpawnQueue(room, { activeHarvester: liveCreep('harvester') });
    assert.deepEqual(Array.from(queue), ['energizedFiller', 'manager', 'emptyFiller', 'builder']);
});

test('an empty mature logistics fleet spawns its storage carrier before a waiting full-size manager', () => {
    const room = { name: 'W1N1', controller: { level: 8, my: true }, containers: [],
        storage: { id: 'storage', store: { energy: 10000 } }, memory: { creepConfig: {
            manager: demand('manager', 0), harvester: demand('harvester', 1),
            storageFiller: demand('filler', 2, 'storage'), builder: demand('builder', 4)
        } } };
    assert.deepEqual(Array.from(queueApi().buildSpawnQueue(room, {})),
        ['storageFiller', 'manager', 'harvester', 'builder']);
    room.storage.store.energy = 0;
    assert.equal(queueApi().buildSpawnQueue(room, {})[0], 'harvester');
});

function executionWorld(creeps, createRoleBehavior, { warMode = {}, scope = 'empire', teams = {} } = {}) {
    const errors = [];
    const game = { creeps, rooms: {}, shard: { name: 'test' }, cpu: { getUsed: () => 0 } };
    const loader = createSourceLoader({
        globals: { Game: game, Memory: { warMode }, console: { log: message => errors.push(message) } },
        modules: {
            // Framework factories run independently of real builder job discovery.
            'role/support/builderMaintenance': { idleBuilderIfNoWork: () => false },
            role: { createRoleBehavior },
            squard: teams,
            'combat/missions': { runCombatUnits() {} },
            'combat/defense': { requestTowerSupport() {} },
            'settings/creep': { warModeRole: ['filler', 'defender'] },
            'settings/runtime': { runtimePolicy: {
                warModeScope: scope,
                profiling: { enabled: false, shards: [], creepWarningCpu: 0.8 }
            } }
        }
    });
    return { api: loader.load('creep/execution'), game, errors };
}

test('new compound-dependent economy units finish boosting before preparing or leaving their home', () => {
    const creep = unit('boosting', { role: 'filler' }), calls = [];
    creep.memory.boostPlan = { tier: 2, steps: [{ type: 'boostCarry', resource: 'KH2O', parts: 4 }] };
    creep.goBoost = () => { calls.push('boost'); return false; };
    const w = executionWorld({ boosting: creep }, () => ({ prepare() { calls.push('prepare'); return true; }, source() { calls.push('source'); } }));
    w.api.creepWorkController();
    assert.deepEqual(calls, ['boost']);
    creep.memory.boostPlan.completed = true;
    w.api.creepWorkController();
    assert.deepEqual(calls, ['boost', 'prepare', 'source']);
});

test('duo preparation services both pending boost plans even when the first member must wait', () => {
    const calls = [];
    const game = { flags: { team: {} }, creeps: {
        first: { goBoost() { calls.push('first'); return false; } },
        second: { goBoost() { calls.push('second'); return true; } },
    } };
    const team = createSourceLoader({ globals: { Game: game }, modules: { 'combat/support': { returnCombatUnit() {} } } }).load('squard/TeamDuo').default({ teamFlag: 'team', creepNameList: ['first', 'second'] });
    assert.equal(team.prepare(), false);
    assert.deepEqual(calls, ['first', 'second']);
});

function unit(name, { working = false, role = 'builder', spawning = false, isTeam = false, wounded = false, roomName = 'W1N1' } = {}) {
    return {
        name, spawning,
        memory: { role, working, isTeam, data: { name } },
        hits: wounded ? 50 : 100, hitsMax: 100,
        room: { name: roomName, my: true, towers: [] }
    };
}

test('a failing role factory, prepare, or work phase leaves later units runnable', () => {
    const calls = [];
    const constructions = [];
    const creeps = {
        factoryFailure: unit('factoryFailure'), prepareFailure: unit('prepareFailure'),
        phaseFailure: unit('phaseFailure'), healthy: unit('healthy', { working: true, wounded: true })
    };
    const { api, errors } = executionWorld(creeps, (role, data) => {
        constructions.push(data.name);
        if (data.name === 'factoryFailure') throw new Error('factory failed');
        return {
            prepare() {
                calls.push(`${data.name}:prepare`);
                if (data.name === 'prepareFailure') throw new Error('prepare failed');
                return true;
            },
            source() {
                calls.push(`${data.name}:source`);
                if (data.name === 'phaseFailure') throw new Error('phase failed');
            },
            target() { calls.push(`${data.name}:target`); }
        };
    });
    assert.doesNotThrow(api.creepWorkController);
    assert.deepEqual(constructions, ['factoryFailure', 'prepareFailure', 'phaseFailure', 'healthy']);
    assert.deepEqual(calls, ['prepareFailure:prepare', 'phaseFailure:prepare', 'phaseFailure:source', 'healthy:prepare', 'healthy:target']);
    assert.equal(errors.length, 3);
    assert.match(errors[0], /factoryFailure/);
    assert.match(errors[1], /prepareFailure/);
    assert.match(errors[2], /phaseFailure/);
});

test('spawned and team units wait, and unprepared or unknown roles do not enter work phases', () => {
    const constructions = [];
    const work = [];
    const creeps = {
        spawning: unit('spawning', { spawning: true }), team: unit('team', { isTeam: true }),
        unknown: unit('unknown', { role: 'unknown' }), waiting: unit('waiting'), ready: unit('ready')
    };
    const { api } = executionWorld(creeps, (role, data) => {
        constructions.push(data.name);
        if (role === 'unknown') return undefined;
        return {
            prepare: () => data.name !== 'waiting',
            source: () => work.push(data.name), target: () => work.push(data.name)
        };
    });
    api.creepWorkController();
    assert.deepEqual(constructions, ['unknown', 'waiting', 'ready']);
    assert.deepEqual(work, ['ready']);
});

test('configurable war scope preserves the empire default and allows peaceful room work', () => {
    for (const [scope, expected] of [['empire', ['defender']], ['room', ['peaceful', 'defender']]]) {
        const calls = [];
        const creeps = {
            peaceful: unit('peaceful', { roomName: 'W2N2' }),
            atWar: unit('atWar', { roomName: 'W1N1' }),
            defender: unit('defender', { role: 'defender', roomName: 'W1N1' })
        };
        const { api } = executionWorld(creeps, (role, data) => ({
            prepare: () => true, source: () => calls.push(data.name), target() {}
        }), { warMode: { W1N1: true }, scope });
        api.creepWorkController();
        assert.deepEqual(calls, expected, scope);
    }
});

test('team factory or work failures do not prevent later teams from working', () => {
    const calls = [];
    const configurations = {
        unknown: { teamType: 'constructor', teamFlag: 'unknown' },
        failed: { teamType: 'duo', teamFlag: 'failed' },
        ready: { teamType: 'duo', teamFlag: 'ready' }
    };
    const { api, game, errors } = executionWorld({}, () => undefined, { teams: {
        duo: config => {
            calls.push(`${config.teamFlag}:factory`);
            return {
                prepare: () => true,
                doWork() {
                    calls.push(`${config.teamFlag}:work`);
                    if (config.teamFlag === 'failed') throw new Error('team failed');
                }
            };
        }
    } });
    game.rooms.W1N1 = { my: true, memory: { teamConfig: configurations } };
    api.teamWorkController();
    assert.deepEqual(calls, ['failed:factory', 'failed:work', 'ready:factory', 'ready:work']);
    assert.equal(errors.length, 1);
});

test('enemy grouping merges a bridge into one component without repeating enemies', () => {
    const { groupEnemies } = createSourceLoader({
        modules: { 'settings/population': { populationPolicy: { defense: { enemyGroupRange: 3 } } } }
    }).load('creep/threats');
    const enemy = (name, x) => ({ name, x, pos: { getRangeTo: other => Math.abs(x - other.x) } });
    const a = enemy('a', 0), b = enemy('b', 6), bridge = enemy('bridge', 3), isolated = enemy('isolated', 20);
    const groups = groupEnemies([a, b, bridge, isolated]);
    assert.deepEqual(Array.from(groups, group => Array.from(group, member => member.name).sort()), [['a', 'b', 'bridge'], ['isolated']]);
    assert.equal(new Set(groups.flat()).size, 4);
    assert.deepEqual(Array.from(groupEnemies([])), []);
});
