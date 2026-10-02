const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world() {
    const actions = [], objects = new Map(), enemies = [], friendlies = [], structures = [], walls = new Set();
    const reads = { enemies: 0, structures: 0, friendlies: 0, geometry: 0, matrix: 0, look: 0 };
    const game = { time: 10, shard: { name: 'shard3' }, rooms: {}, creeps: {}, getObjectById: id => objects.get(id) || null };
    const memory = { warMode: {} };
    class RoomPosition {
        constructor(x, y, roomName = 'W1N1') { Object.assign(this, { x, y, roomName }); }
        getRangeTo(target) { const pos = target.pos || target; return Math.max(Math.abs(this.x - pos.x), Math.abs(this.y - pos.y)); }
        isNearTo(target) { return this.getRangeTo(target) <= 1; }
        inRangeTo(target, range) { return this.getRangeTo(target) <= range; }
        findInRange() { throw new Error('defenders must use the shared snapshot'); }
        lookFor() { throw new Error('defenders must use the shared cover index'); }
    }
    class Terrain { get(x, y) { return walls.has(`${x}:${y}`) ? 1 : 0; } }
    class Room {}; Room.Terrain = Terrain;
    class StructureTower {};
    const p = (x, y) => new RoomPosition(x, y);
    const native = {
        Game: game, Memory: memory, Room, RoomPosition, StructureTower, console: { log() {} },
        RESOURCE_ENERGY: 'energy', OK: 0, TOWER_ENERGY_COST: 10, TOWER_POWER_ATTACK: 600, TOWER_POWER_HEAL: 400,
        TOWER_OPTIMAL_RANGE: 5, TOWER_FALLOFF_RANGE: 20, TOWER_FALLOFF: 0.75,
        ATTACK: 'attack', RANGED_ATTACK: 'ranged_attack', HEAL: 'heal', WORK: 'work', MOVE: 'move', TOUGH: 'tough', CLAIM: 'claim',
        ATTACK_POWER: 30, RANGED_ATTACK_POWER: 10, HEAL_POWER: 12, RANGED_HEAL_POWER: 4, DISMANTLE_POWER: 50,
        STRUCTURE_SPAWN: 'spawn', STRUCTURE_EXTENSION: 'extension', STRUCTURE_TOWER: 'tower', STRUCTURE_LAB: 'lab',
        STRUCTURE_STORAGE: 'storage', STRUCTURE_TERMINAL: 'terminal', STRUCTURE_ROAD: 'road', STRUCTURE_CONTAINER: 'container',
        STRUCTURE_RAMPART: 'rampart', STRUCTURE_WALL: 'constructedWall', TERRAIN_MASK_WALL: 1,
        FIND_STRUCTURES: 'structures', FIND_MY_CREEPS: 'friendlies', LOOK_STRUCTURES: 'structures',
        EFFECT_INVULNERABILITY: 1001, PWR_OPERATE_TOWER: 3, PWR_DISRUPT_TOWER: 10,
        POWER_INFO: { 3: { effect: [1.1, 1.2, 1.3, 1.4, 1.5] }, 10: { effect: [0.9, 0.8, 0.7, 0.6, 0.5] } },
        OBSTACLE_OBJECT_TYPES: ['spawn', 'extension', 'tower', 'constructedWall'],
        BOOSTS: { attack: { XUH2O: { attack: 4 } }, ranged_attack: { XKHO2: { rangedAttack: 4 } },
            heal: { XLHO2: { heal: 4, rangedHeal: 4 } }, tough: { XGHO2: { damage: 0.3 } }, work: { XZH2O: { dismantle: 4 } } }
    };
    const room = {
        name: 'W1N1', my: true, controller: { my: true, pos: p(25, 25) },
        memory: { roomPosition: {}, roomFillJob: {}, creepConfig: {}, creepSpawnQueue: [], teamConfig: {} },
        get enemies() { reads.enemies++; return enemies; },
        get structures() { reads.geometry++; return structures; },
        get ramparts() { return structures.filter(value => value.structureType === 'rampart'); },
        get towers() { return structures.filter(value => value.structureType === 'tower'); },
        sources: [], roads: [], extensions: [], spawns: [], labs: [], containers: [], links: [],
        getTerrain: () => new Terrain(),
        find(kind) { reads[kind]++; return kind === 'structures' ? structures : friendlies; },
        lookForAt(kind, x, y) { reads.look++; return structures.filter(value => value.pos.x === x && value.pos.y === y); },
        getDefenderCostMatrix() { reads.matrix++; return { get: () => 0 }; },
    };
    game.rooms[room.name] = room;
    const loader = createSourceLoader({ globals: native, modules: {
        'settings/settings': { creepWhiteList: ['ally'] },
        'settings/roomPolicy': { roomPolicy: { defense: { enemyScanInterval: 1, notificationInterval: 10,
            minimumRoadDamage: 200, minimumRoadDamageFraction: 0.05, criticalRoadHealthFraction: 0.5,
            npcOwners: ['Invader', 'Source Keeper'], invaderOwner: 'Invader' } } },
        'settings/population': { populationPolicy: { defense: { enemyGroupRange: 2, minimumDamage: 1000 } } },
        'settings/creep': { roleWarEnum: { DEFENDER: 'defender', RDEFENDER: 'rdefender' } },
        'settings/structures': { structurePolicy: { tower: { refillFreeCapacity: 500 } } },
        './demand': { addCreepConfig(target, role, name, data) { target.memory.creepConfig[name] = { name, role, data }; return name; } },
    } });
    const api = loader.load('combat/defense'), policy = loader.load('settings/combatDefense').combatDefensePolicy;
    const body = (type, count, boost) => Array.from({ length: count }, () => ({ type, hits: 100, ...(boost ? { boost } : {}) }));
    function unit(id, { x = 12, y = 10, parts = body('attack', 1), hits = 1000, hitsMax = hits, my = false, role = 'defender', ...extra } = {}) {
        const value = { id, name: id, room, pos: p(x, y), body: parts, hits, hitsMax, my, fatigue: 0,
            owner: { username: my ? 'me' : 'enemy' }, memory: { role, data: {} }, ...extra,
            moveTo(target, options) { actions.push({ action: 'move', id, x: target.x, y: target.y, range: options?.range }); return 0; },
            goBoost: () => true, heal(target) { actions.push({ action: 'creepHeal', id, target: target.id }); return 0; },
            attack(target) { actions.push({ action: 'melee', id, target: target.id }); return 0; },
            rangedAttack(target) { actions.push({ action: 'ranged', id, target: target.id }); return 0; },
            rangedMassAttack() { actions.push({ action: 'mass', id }); return 0; },
        };
        objects.set(id, value); (my ? friendlies : enemies).push(value); if (my) game.creeps[id] = value; return value;
    }
    function tower(id, { x = 8, y = 8, energy = 1000, my = true, active = true, effects = [] } = {}) {
        const value = { id, room, pos: p(x, y), store: { energy, getFreeCapacity: () => 1000 - value.store.energy }, my,
            owner: { username: my ? 'me' : 'enemy' }, structureType: 'tower', hits: 3000, hitsMax: 3000, effects,
            isActive: () => active,
            attack(target) { actions.push({ action: 'towerAttack', id, target: target.id }); return 0; },
            heal(target) { actions.push({ action: 'towerHeal', id, target: target.id }); return 0; },
            repair(target) { actions.push({ action: 'repair', id, target: target.id }); return 0; },
        };
        structures.push(value); objects.set(id, value); return value;
    }
    function rampart(id, x = 10, y = 10, hits = 100000) {
        const value = { id, room, pos: p(x, y), my: true, owner: { username: 'me' }, structureType: 'rampart', hits, hitsMax: 100000 };
        structures.push(value); return value;
    }
    const calls = action => actions.filter(value => value.action === action);
    const advance = () => { game.time++; actions.length = 0; };
    return { ...api, loader, room, game, memory, policy, reads, objects, actions, enemies, friendlies, structures, walls, p, body, unit, tower, rampart, calls, advance };
}

test('minimum lethal tower sets split across killable enemies and cannot be overwritten by later callers', () => {
    const w = world(), first = w.tower('first'), second = w.tower('second');
    const a = w.unit('a', { hits: 500 }), b = w.unit('b', { hits: 500 });
    w.runRoomTowerDefense(w.room);
    assert.deepEqual(w.calls('towerAttack').map(call => call.target), ['a', 'b']);
    const injured = w.unit('friendly', { my: true, hits: 50, hitsMax: 100 });
    w.requestTowerSupport(injured, { healFriendly: true }); w.requestTowerSupport(a); w.runRoomTowerDefense(w.room);
    assert.equal(w.issueTowerRepair(first, { id: 'road' }), false);
    assert.equal(w.issueTowerRepair({ ...first }, { id: 'road' }), false, 'one native tower id cannot be reissued through another wrapper');
    assert.equal(w.hasTowerIntent(second), true); assert.equal(w.actions.length, 2);
});

test('live TOUGH absorption requires two towers while a plain target uses only one', () => {
    const w = world(); w.tower('one'); w.tower('two'); w.tower('three');
    w.unit('armored', { hits: 300, parts: [...w.body('tough', 2, 'XGHO2'), ...w.body('attack', 1)] });
    w.unit('plain', { hits: 400, parts: w.body('attack', 4) });
    w.runRoomTowerDefense(w.room);
    assert.equal(w.calls('towerAttack').filter(call => call.target === 'plain').length, 1);
    assert.equal(w.calls('towerAttack').filter(call => call.target === 'armored').length, 2);
});

test('support HEAL and current target hits prevent a false one-tower kill', () => {
    const w = world(); w.tower('one'); w.tower('two');
    w.unit('target', { hits: 200 }); w.unit('healer', { x: 13, hits: 4000, parts: w.body('heal', 40) });
    w.runRoomTowerDefense(w.room);
    assert.deepEqual(w.calls('towerAttack').map(call => call.target), ['target', 'target']);
});

test('critical guards receive the minimum rescue towers while remaining towers still attack', () => {
    const w = world(); w.tower('one'); w.tower('two'); w.tower('three');
    w.unit('guard', { my: true, x: 10, hits: 100, hitsMax: 1000 });
    w.unit('attacker', { x: 11, hits: 5000, parts: w.body('attack', 7) });
    w.runRoomTowerDefense(w.room);
    assert.equal(w.calls('towerHeal').length, 1); assert.equal(w.calls('towerHeal')[0].target, 'guard');
    assert.equal(w.calls('towerAttack').length, 2);
});

test('low-energy, inactive and hostile towers never block usable own towers or receive our intents', () => {
    const w = world(); w.tower('empty', { energy: 9 }); w.tower('inactive', { active: false });
    w.tower('hostile', { my: false }); w.tower('usable'); w.unit('enemy', { hits: 500 });
    w.runRoomTowerDefense(w.room);
    assert.deepEqual(w.calls('towerAttack').map(call => call.id), ['usable']);
});

test('tower operation effects and range participate in minimum kill allocation', () => {
    const w = world();
    w.tower('operated', { effects: [{ effect: 3, level: 5, ticksRemaining: 10 }] }); w.tower('ordinary');
    w.unit('enemy', { hits: 800 }); w.runRoomTowerDefense(w.room);
    assert.deepEqual(w.calls('towerAttack').map(call => call.id), ['operated']);
});

test('normal peaceful first-road repair priority is retained and skips targets after a tower intent', () => {
    const w = world(), tower = w.tower('one');
    const road = { id: 'road', hits: 90, hitsMax: 100 }; w.room.roads = [road];
    const repair = w.loader.load('room/defense').repairStructure;
    w.runRoomTowerDefense(w.room); repair(w.room); repair(w.room);
    assert.deepEqual(w.calls('repair').map(call => call.target), ['road']);
    w.advance(); w.unit('wounded', { my: true, hits: 50, hitsMax: 100 });
    w.runRoomTowerDefense(w.room);
    Object.defineProperty(w.room, 'roads', { get() { throw new Error('an issued heal must skip repair scans'); } });
    repair(w.room); assert.equal(w.hasTowerIntent(tower), true); assert.equal(w.calls('towerHeal').length, 1);
});

test('native TowerExtension delegates NPC attack into the shared room decision once', () => {
    const w = world(), tower = w.tower('one'); w.unit('npc', { hits: 500, owner: { username: 'Invader' } });
    const extension = w.loader.load('mount/structure/TowerExtension').default;
    extension.prototype.doWork.call(tower); extension.prototype.doWork.call(tower);
    assert.equal(w.calls('towerAttack').length, 1);
});

test('enemy group keys and live targets survive input reorder and original anchor death', () => {
    const w = world(), a = w.unit('a'), b = w.unit('b', { x: 13 });
    const first = w.defenseGroups(w.room)[0]; assert.equal(first.key, 'a');
    w.advance(); w.enemies.reverse(); assert.equal(w.defenseGroups(w.room)[0].key, first.key);
    w.advance(); w.enemies.splice(w.enemies.indexOf(a), 1);
    const surviving = w.defenseGroups(w.room)[0]; assert.equal(surviving.key, first.key); assert.equal(surviving.target.id, b.id);
});

test('split groups retain distinct keys instead of publishing two demands under the old anchor', () => {
    const w = world(), a = w.unit('a'), b = w.unit('b', { x: 13 }); w.defenseGroups(w.room);
    w.advance(); w.enemies.reverse(); a.pos = w.p(30, 30);
    const groups = w.defenseGroups(w.room); assert.equal(groups.length, 2); assert.equal(new Set(groups.map(group => group.key)).size, 2);
});

test('war publication removes legacy offensive flag demand and queue without reading or creating flags', () => {
    const w = world();
    Object.defineProperty(w.game, 'flags', { get() { throw new Error('defense tasks do not use flags'); } });
    w.room.memory.creepConfig.old = { name: 'W1N1_T2ATTACK_W1N1_T2ATT_0', role: 'attacker' };
    w.room.memory.creepConfig.dis = { name: 'W1N1_DIS_old', role: 'dismantler' };
    w.room.memory.creepConfig.economy = { name: 'builder', role: 'builder' };
    w.room.memory.creepSpawnQueue = ['old', 'dis', 'economy']; w.room.memory.teamConfig.W1N1_T2ATT_0 = {};
    w.unit('strong', { parts: w.body('attack', 40) });
    w.loader.load('creep/warPopulation').releaseWarCreepConfig();
    assert.equal(w.room.memory.creepConfig.old, undefined); assert.equal(w.room.memory.creepConfig.dis, undefined);
    assert.deepEqual(Array.from(w.room.memory.creepSpawnQueue), ['economy']);
    assert.equal(w.room.memory.teamConfig.W1N1_T2ATT_0, undefined);
    const configs = Object.values(w.room.memory.creepConfig); assert.equal(configs.filter(config => config.role === 'defender').length, 1);
    w.advance(); w.enemies.length = 0; w.loader.load('creep/warPopulation').releaseWarCreepConfig();
    assert.equal(Object.values(w.room.memory.creepConfig).filter(config => config.role === 'defender').length, 0);
});

test('ranged defenders share one snapshot and one geometry scan without native range searches or random targets', () => {
    const w = world(); w.policy.pursuit.enabled = false;
    w.rampart('left', 10, 10); w.rampart('right', 10, 11);
    const enemy = w.unit('target', { x: 13, hits: 5000 });
    const first = w.unit('first', { my: true, x: 10, parts: w.body('ranged_attack', 2) });
    const second = w.unit('second', { my: true, x: 10, y: 11, parts: w.body('ranged_attack', 2) });
    const role = w.loader.load('role/war/RoleWarDefenderRanged').default;
    const a = { targetEnemy: 'gone' }, b = { targetEnemy: enemy.id };
    role(a).target(first); role(b).target(second);
    assert.equal(w.calls('ranged').length, 2); assert.equal(a.targetEnemy, enemy.id);
    assert.equal(w.reads.enemies, 2); assert.equal(w.reads.structures, 0); assert.equal(w.reads.friendlies, 1);
    assert.equal(w.reads.geometry, 2); assert.equal(w.reads.matrix, 1); assert.equal(w.calls('move').length, 0);
});

test('ranged mass attack is chosen only when its aggregate actual damage exceeds a single attack', () => {
    const w = world(); w.policy.pursuit.enabled = false; w.rampart('guard');
    w.unit('a', { x: 11 }); w.unit('b', { x: 11, y: 11 });
    const guard = w.unit('guard', { my: true, x: 10, parts: w.body('ranged_attack', 2) });
    w.runDefender(guard, { targetEnemy: 'a' }, true); assert.equal(w.calls('mass').length, 1); assert.equal(w.calls('ranged').length, 0);
});

test('a safe short pursuit uses a locally proven return corridor and records its bounded start', () => {
    const w = world(); w.tower('one'); w.rampart('seat');
    const enemy = w.unit('weak', { x: 12, hits: 2000, parts: [...w.body('attack', 1), ...w.body('move', 1)] });
    const guard = w.unit('guard', { my: true, x: 10, parts: w.body('attack', 10) });
    const data = { targetEnemy: enemy.id };
    w.runDefender(guard, data, false);
    assert.equal(w.calls('move').length, 1); assert.equal(data.pursuitStartedAt, 10);
    const next = w.calls('move')[0]; assert.ok(Math.max(Math.abs(next.x - 10), Math.abs(next.y - 10)) <= 3);
});

test('strong enemies, missing tower support and fatigue keep a full-health defender behind its rampart', () => {
    for (const mode of ['strong', 'noTower', 'fatigue']) {
        const w = world(); if (mode !== 'noTower') w.tower('one'); w.rampart('seat');
        const enemy = w.unit('enemy', { x: 12, hits: 5000, parts: [...w.body('attack', mode === 'strong' ? 20 : 1, mode === 'strong' ? 'XUH2O' : undefined), ...w.body('move', 1)] });
        const guard = w.unit('guard', { my: true, x: 10, fatigue: mode === 'fatigue' ? 1 : 0, parts: w.body('attack', 10) });
        w.runDefender(guard, { targetEnemy: enemy.id }, false); assert.equal(w.calls('move').length, 0, mode);
    }
});

test('a threatened critical entrance cannot be abandoned to chase another enemy', () => {
    const w = world(); w.tower('one'); w.rampart('seat');
    const distant = w.unit('distant', { x: 14, hits: 5000, parts: w.body('attack', 1) });
    w.unit('entry', { x: 11, hits: 5000, parts: w.body('attack', 1) });
    const guard = w.unit('guard', { my: true, x: 10, parts: w.body('attack', 10) });
    w.runDefender(guard, { targetEnemy: distant.id }, false); assert.equal(w.calls('move').length, 0);
});

test('an injured or timed-out pursuing defender returns to its stable guard position', () => {
    for (const mode of ['injured', 'timeout']) {
        const w = world(); w.tower('one'); w.rampart('seat');
        const enemy = w.unit('target', { x: 14, hits: 5000, parts: w.body('attack', 1) });
        const guard = w.unit('guard', { my: true, x: 11, hits: mode === 'injured' ? 600 : 1000, hitsMax: 1000, parts: w.body('attack', 10) });
        const data = { targetEnemy: enemy.id, guardPosition: { x: 10, y: 10, roomName: w.room.name }, pursuitStartedAt: mode === 'timeout' ? 0 : 9 };
        w.runDefender(guard, data, false);
        assert.deepEqual(w.calls('move').map(call => [call.x, call.y]), [[10, 10]], mode);
    }
});

test('closed local return corridors and a far-away unposted defender never start a pursuit', () => {
    const w = world(); w.tower('one'); w.rampart('seat');
    const enemy = w.unit('target', { x: 13, hits: 5000, parts: w.body('attack', 1) });
    const guard = w.unit('guard', { my: true, x: 10, parts: w.body('attack', 10) });
    for (let x = 9; x <= 11; x++) for (let y = 9; y <= 11; y++) if (x !== 10 || y !== 10) w.walls.add(`${x}:${y}`);
    const data = { targetEnemy: enemy.id };
    w.runDefender(guard, data, false); assert.equal(w.calls('move').length, 0); assert.equal(data.pursuitStartedAt, undefined);
    w.advance(); w.walls.clear(); guard.pos = w.p(20, 20);
    w.runDefender(guard, data, false); assert.deepEqual(w.calls('move').map(call => [call.x, call.y]), [[10, 10]]);
});

test('peaceful rooms with healthy creeps use zero native finds and share one empire injury enumeration', () => {
    const w = world(); w.tower('one'); w.unit('healthy', { my: true, x: 10 });
    let enumerations = 0;
    w.game.creeps = new Proxy(w.game.creeps, { ownKeys(target) { enumerations++; return Reflect.ownKeys(target); } });
    const second = { name: 'W2N2', enemies: [], towers: [{ ...w.room.towers[0], room: undefined }],
        find() { throw new Error('healthy peaceful rooms need no native find'); } };
    w.runRoomTowerDefense(w.room); w.runRoomTowerDefense(second); w.runRoomTowerDefense(w.room);
    assert.equal(w.reads.structures, 0); assert.equal(w.reads.friendlies, 0); assert.equal(w.reads.geometry, 0); assert.equal(enumerations, 1);
});

test('a hostile appearing off the configured scan interval attacks before repair can occupy the tower', () => {
    const w = world(); w.game.time = 11; const tower = w.tower('one'); w.unit('enemy', { hits: 500 });
    w.room.roads = [{ id: 'road', hits: 1, hitsMax: 100 }];
    const defense = w.loader.load('room/defense');
    defense.findTowerEnemy(w.room); defense.repairStructure(w.room);
    assert.equal(w.hasTowerIntent(tower), true); assert.equal(w.calls('towerAttack').length, 1); assert.equal(w.calls('repair').length, 0);
});

test('hostile rampart cover receives tower damage rather than falsely allocating a kill on its occupant', () => {
    const w = world(); w.tower('one'); w.tower('two');
    const enemy = w.unit('covered', { x: 12, hits: 100 });
    const cover = w.rampart('cover', 12, 10, 10000); cover.my = false; cover.owner.username = 'enemy';
    w.runRoomTowerDefense(w.room);
    assert.deepEqual(w.calls('towerAttack').map(call => call.target), ['cover', 'cover']);
    w.advance(); w.rampart('ourSeat', 10, 10);
    const guard = w.unit('guard', { my: true, x: 10, parts: w.body('attack', 10) });
    w.runDefender(guard, { targetEnemy: enemy.id }, false); assert.equal(w.calls('move').length, 0);
});

test('hostile PowerCreeps are valid tower targets without body reads or automatic defensive duo flags', () => {
    const w = world(); w.tower('one'); const power = w.unit('power', { hits: 500 });
    delete power.body; power.powers = {};
    w.runRoomTowerDefense(w.room); assert.deepEqual(w.calls('towerAttack').map(call => call.target), ['power']);
    assert.equal(w.defenseGroups(w.room).length, 0);
});

test('melee defenders never overwrite their attack with healing but idle healing and ranged healing remain valid', () => {
    for (const ranged of [false, true]) {
        const w = world(); w.policy.pursuit.enabled = false; w.rampart('seat');
        const target = w.unit('target', { x: 11, hits: 5000 });
        const guard = w.unit('guard', { my: true, x: 10, hits: 900, hitsMax: 1000,
            parts: [...w.body(ranged ? 'ranged_attack' : 'attack', 1), ...w.body('heal', 1)] });
        w.runDefender(guard, { targetEnemy: target.id }, ranged);
        assert.equal(w.calls(ranged ? 'ranged' : 'melee').length, 1); assert.equal(w.calls('creepHeal').length, ranged ? 1 : 0);
    }
});

test('spatial enemy grouping preserves transitive bridges with no pairwise native distance queries', () => {
    const w = world();
    for (let index = 0; index < 20; index++) {
        const enemy = w.unit(`chain-${index}`, { x: 5 + index * 2, y: 10 });
        enemy.pos.getRangeTo = () => { throw new Error('grouping must consume nearby tile buckets'); };
    }
    const separate = w.unit('separate', { x: 25, y: 40 });
    const groups = w.defenseGroups(w.room); assert.equal(groups.length, 2);
    assert.equal(groups[0].enemies.length, 20); assert.equal(groups[1].target, separate);
});

test('a posted peaceful guard performs no native scans and returns from its last pursuit when enemies leave', () => {
    const w = world(), guard = w.unit('guard', { my: true, x: 11 });
    const data = { targetEnemy: 'gone', guardPosition: { x: 10, y: 10, roomName: w.room.name }, pursuitStartedAt: 9 };
    w.runDefender(guard, data, false);
    assert.deepEqual(w.calls('move').map(call => [call.x, call.y]), [[10, 10]]);
    assert.equal(data.pursuitStartedAt, undefined); assert.equal(w.reads.geometry, 0); assert.equal(w.reads.friendlies, 0);
});


test('peaceful defense population avoids structures and friendly native scans', () => {
    const w = world();
    const release = w.loader.load('creep/warPopulation').releaseWarCreepConfig;
    release(); release();
    assert.equal(w.reads.geometry, 0); assert.equal(w.reads.structures, 0); assert.equal(w.reads.friendlies, 0);
    w.game.time++; w.unit('new-enemy', { parts: w.body('attack', 40) });
    release();
    assert.equal(Object.keys(w.room.memory.creepConfig).length, 1, 'new vision still publishes a defensive group on the next tick');
});
