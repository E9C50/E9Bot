const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world({ roomName = 'W2N1', life = 1200, capacity = 100, energy = 0 } = {}) {
    const actions = [], routeCalls = [], failedRoutes = new Set();
    class Position {
        constructor(x, y, roomName) { Object.assign(this, { x, y, roomName }); }
        getRangeTo(value) { const pos = value.pos || value; return this.roomName === pos.roomName ? Math.max(Math.abs(this.x - pos.x), Math.abs(this.y - pos.y)) : Infinity; }
        isNearTo(value) { return this.getRangeTo(value) <= 1; }
        getDirectionTo(value) { return this.x === value.x ? this.y > value.y ? 1 : 5 : this.x > value.x ? this.y === value.y ? 7 : this.y > value.y ? 8 : 6 : this.y === value.y ? 3 : this.y > value.y ? 2 : 4; }
    }
    const pos = (x, y, roomName = 'W2N1') => new Position(x, y, roomName);
    function store(contents = {}, capacity = 1000, energyOnly = false) {
        const result = { ...contents };
        Object.defineProperties(result, {
            getUsedCapacity: { value: resource => resource === undefined ? Object.values(result).reduce((sum, value) => sum + value, 0) : result[resource] || 0 },
            getCapacity: { value: resource => energyOnly && resource !== undefined && resource !== 'energy' ? null : capacity },
            getFreeCapacity: { value: resource => energyOnly && resource !== undefined && resource !== 'energy' ? null : capacity - result.getUsedCapacity() },
        });
        return result;
    }
    const game = { time: 1, shard: { name: 'shard3' }, rooms: {}, creeps: {}, spawns: {}, map: {
        findRoute(from, to, options) {
            routeCalls.push({ from, to, options });
            if (failedRoutes.has(`${from}/${to}`)) return -2;
            if (from === to) return [];
            const fromX = Number(/W(\d+)/.exec(from)[1]), toX = Number(/W(\d+)/.exec(to)[1]);
            const result = [];
            for (let x = fromX + Math.sign(toX - fromX); x !== toX + Math.sign(toX - fromX); x += Math.sign(toX - fromX)) {
                const room = `W${x}N1`;
                if (options?.routeCallback?.(room) === Infinity) return -2;
                result.push({ room, exit: 3 });
            }
            return result;
        },
    } };
    function room(name) {
        const value = { name, structures: [], units: [], ruins: [], tombstones: [], dropped: [],
            controller: { id: `${name}-controller`, my: name === 'W1N1', level: name === 'W1N1' ? 8 : 0, pos: pos(25, 25, name), owner: name === 'W1N1' ? { username: 'me' } : undefined },
            getTerrain: () => ({ get: () => 0 }),
            find(type) { return ({ structures: value.structures, 'my-creeps': value.units.filter(unit => unit.my), creeps: value.units, 'power-creeps': [], ruins: value.ruins, tombstones: value.tombstones, dropped: value.dropped })[type] || []; },
            lookForAt(type, x, y) { return (type === 'structures' ? value.structures : value.units).filter(item => item.pos.x === x && item.pos.y === y); },
        };
        Object.defineProperty(value, 'enemies', { get: () => value.units.filter(unit => !unit.my && unit.owner.username !== 'friend') });
        game.rooms[name] = value; return value;
    }
    const home = room('W1N1'), target = room('W2N1');
    function structure(id, type, x, y, options = {}) {
        const current = game.rooms[options.roomName || 'W2N1'];
        const value = { id, name: id, structureType: type, room: current, pos: pos(x, y, current.name), hits: 1000,
            my: options.my ?? (current === home), owner: type === 'container' ? undefined : { username: options.owner || (options.my || current === home ? 'me' : 'Invader') },
            spawning: options.spawning, effects: options.effects || [], store: store(options.contents || { energy: 0 }, options.capacity || 1000, type === 'spawn' || type === 'extension'),
            isPublic: options.isPublic || false, isActive: () => options.active !== false,
            recycleCreep(unit) { actions.push({ type: 'recycle', target: id, unit: unit.name }); return unit.pos.isNearTo(value) ? 0 : -9; },
        };
        current.structures.push(value);
        if (type === 'spawn') game.spawns[id] = value;
        if (type === 'storage') current.storage = value;
        if (type === 'terminal') current.terminal = value;
        return value;
    }
    const creep = { id: 'unit', name: 'unit', owner: { username: 'me' }, my: true, room: game.rooms[roomName], pos: pos(10, 10, roomName),
        store: store({ energy }, capacity), memory: { working: false, combatJob: 'loot', combatTaskId: 'task' }, ticksToLive: life,
        body: [{ type: 'move', hits: 100 }, { type: 'carry', hits: 100 }, { type: 'claim', hits: 100 }], hits: 300, hitsMax: 300, fatigue: 0,
        getActiveBodyparts(part) { return creep.body.filter(item => item.type === part && item.hits > 0).length; },
        moveTo(value, options) { const goal = value.pos || value; actions.push({ type: 'moveTo', target: value.id, roomName: goal.roomName, x: goal.x, y: goal.y, ...options }); return creep.moveResult ?? 0; },
        move(direction) { actions.push({ type: 'move', direction }); return 0; },
        attackController(value) { actions.push({ type: 'attackController', target: value.id }); return creep.attackResult ?? (creep.pos.isNearTo(value) ? 0 : -9); },
        withdraw(value, resource) { actions.push({ type: 'withdraw', target: value.id, resource }); return creep.pos.isNearTo(value) ? 0 : -9; },
        pickup(value) { actions.push({ type: 'pickup', target: value.id, resource: value.resourceType }); return creep.pos.isNearTo(value) ? 0 : -9; },
        transfer(value, resource) { actions.push({ type: 'transfer', target: value.id, resource }); return creep.pos.isNearTo(value) ? 0 : -9; },
        suicide() { throw new Error('Combat support must preserve cargo and controller intents instead of suicide'); },
        attack() { throw new Error('Support must never steal combat intents'); },
        rangedAttack() { throw new Error('Support must never steal combat intents'); },
    };
    creep.room.units.push(creep); game.creeps[creep.name] = creep;
    function place(name, x = 10, y = 10) {
        creep.room.units = creep.room.units.filter(unit => unit !== creep);
        creep.room = game.rooms[name] || room(name); creep.room.units.push(creep); creep.pos = pos(x, y, name);
    }
    function enemy(x, y, { owner = 'Invader', attack = 1, ranged = 0 } = {}) {
        const value = { id: `enemy-${x}-${y}`, room: creep.room, pos: pos(x, y, creep.room.name), owner: { username: owner }, my: false, fatigue: 0,
            body: [...Array(attack).fill('attack'), ...Array(ranged).fill('ranged_attack'), 'move'].map(type => ({ type, hits: 100 })) };
        creep.room.units.push(value); return value;
    }
    function remains(id, type, x, y, { owner = 'Invader', contents = { energy: 100 }, life = 500 } = {}) {
        const value = { id, pos: pos(x, y), store: store(contents), ticksToDecay: life, structure: { owner: owner === undefined ? undefined : { username: owner } }, creep: { owner: { username: owner } } };
        target[type].push(value); return value;
    }
    function drop(id, x, y, resource = 'energy', amount = 100) { const value = { id, pos: pos(x, y), resourceType: resource, amount }; target.dropped.push(value); return value; }
    class Matrix { set() {} }
    const globals = { Game: game, Memory: {}, RoomPosition: Position,
        PathFinder: { CostMatrix: Matrix, search(origin, goals, options) {
            actions.push({ type: 'flee-search', goals, options }); options.roomCallback(origin.roomName);
            return { path: [pos(origin.x - 1, origin.y - 1, origin.roomName)], incomplete: false };
        } },
        OK: 0, ERR_NOT_IN_RANGE: -9, ERR_NO_PATH: -2, RESOURCE_ENERGY: 'energy', RESOURCE_POWER: 'power', COMMODITIES: { battery: {} },
        CREEP_LIFE_TIME: 1500, CREEP_CLAIM_LIFE_TIME: 600,
        ATTACK: 'attack', RANGED_ATTACK: 'ranged_attack', HEAL: 'heal', WORK: 'work', CLAIM: 'claim', MOVE: 'move', TOUGH: 'tough',
        ATTACK_POWER: 30, RANGED_ATTACK_POWER: 10, HEAL_POWER: 12, RANGED_HEAL_POWER: 4, DISMANTLE_POWER: 50,
        TOWER_ENERGY_COST: 10, TOWER_POWER_ATTACK: 600, TOWER_POWER_HEAL: 400, TOWER_OPTIMAL_RANGE: 5, TOWER_FALLOFF_RANGE: 20, TOWER_FALLOFF: 0.75,
        EFFECT_INVULNERABILITY: 1001, PWR_OPERATE_TOWER: 3, PWR_DISRUPT_TOWER: 10, POWER_INFO: {}, BOOSTS: {}, TERRAIN_MASK_WALL: 1,
        FIND_STRUCTURES: 'structures', FIND_MY_CREEPS: 'my-creeps', FIND_CREEPS: 'creeps', FIND_POWER_CREEPS: 'power-creeps', FIND_RUINS: 'ruins', FIND_TOMBSTONES: 'tombstones', FIND_DROPPED_RESOURCES: 'dropped', LOOK_STRUCTURES: 'structures',
        STRUCTURE_STORAGE: 'storage', STRUCTURE_TERMINAL: 'terminal', STRUCTURE_SPAWN: 'spawn', STRUCTURE_EXTENSION: 'extension', STRUCTURE_CONTAINER: 'container', STRUCTURE_INVADER_CORE: 'invaderCore', STRUCTURE_RAMPART: 'rampart', STRUCTURE_WALL: 'constructedWall', STRUCTURE_TOWER: 'tower', STRUCTURE_PORTAL: 'portal', OBSTACLE_OBJECT_TYPES: ['spawn', 'extension', 'storage', 'terminal', 'tower', 'invaderCore'],
    };
    const policy = { maximumActiveTasks: 8, minimumTravelLife: 100, travelTicksPerRoom: 65, supportFleeMaxOps: 2000, lootSafetyTicks: 25, lootUrgencyTicks: 100, lootRouteCacheTicks: 100 };
    const loader = createSourceLoader({ globals, modules: {
        'settings/combat': { combatPolicy: policy }, 'settings/settings': { creepWhiteList: ['friend'], getFindPathAvoidRooms: () => ['W9N1'] },
        'settings/roomPolicy': { roomPolicy: { defense: { npcOwners: ['Invader', 'Source Keeper'] } } },
        'shard/scoutMovement': { scoutMovementOptions: { plainCost: 1, swampCost: 1, ignoreSwamps: true } },
    } });
    return { ...loader.load('combat/support'), game, home, target, creep, actions, routeCalls, failedRoutes, pos, place, structure, enemy, remains, drop, policy,
        options: { homeRoom: home.name, targetRoom: target.name }, nextTick() { game.time++; actions.length = 0; } };
}

test('a scout follows room transitions with exact cross-room range and stops once vision is available', () => {
    const w = world({ roomName: 'W1N1' }); delete w.game.rooms[w.target.name];
    w.runCombatScout(w.creep, w.options);
    assert.deepEqual(w.actions.map(action => action.type), ['moveTo']); assert.equal(w.actions[0].roomName, w.target.name);
    assert.equal(w.actions[0].range, 1); assert.equal(w.actions[0].plainCost, 1); assert.equal(w.actions[0].swampCost, 1);
    w.game.rooms[w.target.name] = w.target; w.place(w.target.name); w.nextTick(); w.runCombatScout(w.creep, w.options);
    assert.deepEqual(w.actions, []);
});

test('a scout records no hostile intents and withdraws even from distant combat troops', () => {
    const w = world(); w.enemy(40, 40); w.runCombatScout(w.creep, w.options);
    assert.deepEqual(w.actions.map(action => action.type), ['moveTo']); assert.equal(w.actions[0].roomName, w.home.name);
});

test('an immediately threatened support unit flees with a native move instead of retaining a cached inward path', () => {
    const w = world(); w.enemy(11, 10, { ranged: 1 }); w.runCombatScout(w.creep, w.options);
    assert.deepEqual(w.actions.map(action => action.type), ['flee-search', 'move']);
    assert.equal(w.actions[0].options.flee, true); assert.equal(w.actions[0].options.maxOps, w.policy.supportFleeMaxOps);
    assert.equal(w.actions[1].direction, 8);
});

test('whitelisted troops do not trigger support retreat', () => {
    const w = world(); w.enemy(11, 10, { owner: 'friend' }); w.runCombatScout(w.creep, w.options); assert.deepEqual(w.actions, []);
});

test('controller attackers approach the controller and report only successfully submitted native intents', () => {
    const w = world(); w.target.controller.owner = { username: 'enemy' };
    assert.equal(w.runControllerAttack(w.creep, w.options), false);
    assert.deepEqual(w.actions.map(action => action.type), ['attackController', 'moveTo']); assert.equal(w.actions[1].target, w.target.controller.id);
    w.place(w.target.name, 25, 24); w.nextTick(); assert.equal(w.runControllerAttack(w.creep, w.options), true);
    assert.deepEqual(w.actions.map(action => action.type), ['attackController']);
    assert.equal(w.target.controller.upgradeBlocked, undefined, 'submission is not native next-tick confirmation');
    w.creep.attackResult = -7; w.nextTick(); assert.equal(w.runControllerAttack(w.creep, w.options), false);
});

test('reserved hostile controllers can be attacked on consecutive ticks without inventing an owned-controller lock', () => {
    const w = world(); w.target.controller.reservation = { username: 'enemy', ticksToEnd: 500 }; w.place(w.target.name, 25, 24);
    assert.equal(w.runControllerAttack(w.creep, w.options), true); w.nextTick(); assert.equal(w.runControllerAttack(w.creep, w.options), true);
    assert.deepEqual(w.actions.map(action => action.type), ['attackController']);
});

for (const blocked of ['own', 'ally-owner', 'ally-reservation', 'self-reservation', 'neutral', 'safe-mode', 'shield']) test(`controller support refuses ${blocked} targets`, () => {
    const w = world(); const controller = w.target.controller;
    if (blocked === 'own') { controller.my = true; controller.owner = { username: 'me' }; }
    if (blocked === 'ally-owner') controller.owner = { username: 'friend' };
    if (blocked === 'ally-reservation') controller.reservation = { username: 'friend', ticksToEnd: 100 };
    if (blocked === 'self-reservation') controller.reservation = { username: 'me', ticksToEnd: 100 };
    if (blocked === 'safe-mode') { controller.owner = { username: 'enemy' }; controller.safeMode = 300; }
    if (blocked === 'shield') { controller.owner = { username: 'enemy' }; controller.effects = [{ effect: 1001, ticksRemaining: 300 }]; }
    assert.equal(w.runControllerAttack(w.creep, w.options), false);
    assert.equal(w.actions.some(action => action.type === 'attackController'), false); assert.equal(w.actions.at(-1).roomName, w.home.name);
});

test('an owned-controller 1000-tick lock recycles a 600-tick CLAIM unit; a short lock safely waits', () => {
    const w = world({ life: 600 }); w.target.controller.owner = { username: 'enemy' }; w.target.controller.upgradeBlocked = 1000;
    assert.equal(w.runControllerAttack(w.creep, w.options), false); assert.equal(w.actions.at(-1).roomName, w.home.name);
    w.target.controller.upgradeBlocked = 3; w.nextTick(); assert.equal(w.runControllerAttack(w.creep, w.options), false); assert.deepEqual(w.actions, []);
    w.target.controller.upgradeBlocked = 0; w.place(w.target.name, 25, 24); w.nextTick(); assert.equal(w.runControllerAttack(w.creep, w.options), true);
});

test('NPC loot prioritizes power over nearby energy and supports intact neutral NPC treasure containers', () => {
    const w = world(); w.remains('energy', 'ruins', 10, 11); w.structure('container', 'container', 11, 10, { contents: { power: 100 } });
    w.runCombatLoot(w.creep, w.options); assert.deepEqual(w.actions, [{ type: 'withdraw', target: 'container', resource: 'power' }]);
});

test('same-value loot that is about to vanish outranks closer long-lived loot; unreachable expiry is skipped', () => {
    const w = world(); w.remains('durable', 'ruins', 10, 11, { contents: { power: 100 }, life: 500 });
    w.remains('expiring', 'tombstones', 15, 10, { contents: { power: 100 }, life: 10 });
    w.remains('already-too-late', 'ruins', 20, 10, { contents: { power: 100 }, life: 5 });
    w.runCombatLoot(w.creep, w.options); assert.equal(w.actions[0].target, 'expiring'); assert.equal(w.actions[1].target, 'expiring');
});

test('loot recovers NPC/self remains while refusing hostile-player and ally remains/stores in a neutral room', () => {
    const w = world();
    w.remains('player', 'ruins', 10, 11, { owner: 'enemy', contents: { power: 100 } });
    w.remains('ally', 'tombstones', 11, 10, { owner: 'friend', contents: { power: 100 } });
    w.structure('player-store', 'storage', 11, 11, { owner: 'enemy', contents: { power: 100 } });
    w.structure('ally-store', 'terminal', 11, 9, { owner: 'friend', contents: { power: 100 } });
    w.remains('mine', 'tombstones', 9, 10, { owner: 'me', contents: { energy: 10 } });
    w.remains('npc', 'ruins', 10, 9, { owner: 'Invader', contents: { XGH2O: 30 } });
    w.runCombatLoot(w.creep, w.options); assert.deepEqual(w.actions, [{ type: 'withdraw', target: 'npc', resource: 'XGH2O' }]);
    w.target.ruins.length = 0; w.nextTick(); w.runCombatLoot(w.creep, w.options); assert.equal(w.actions[0].target, 'mine');
});

for (const kind of ['player-owner', 'ally-owner', 'player-reservation', 'ally-reservation']) test(`loot refuses even unowned drops in a ${kind} room`, () => {
    const w = world(); const owner = kind.startsWith('ally') ? 'friend' : 'enemy';
    if (kind.endsWith('reservation')) w.target.controller.reservation = { username: owner, ticksToEnd: 500 };
    else w.target.controller.owner = { username: owner };
    w.drop('power', 10, 11, 'power', 100); w.runCombatLoot(w.creep, w.options);
    assert.equal(w.actions.some(action => ['pickup', 'withdraw'].includes(action.type)), false); assert.equal(w.actions.at(-1).roomName, w.home.name);
});

test('NPC dropped minerals are picked up and closed hostile ramparts exclude covered stores', () => {
    const w = world(); w.structure('closed', 'rampart', 10, 11);
    w.remains('covered', 'ruins', 10, 11, { contents: { power: 100 } });
    w.drop('uncovered', 11, 10, 'XGH2O', 30); w.runCombatLoot(w.creep, w.options);
    assert.deepEqual(w.actions, [{ type: 'pickup', target: 'uncovered', resource: 'XGH2O' }]);
});

for (const danger of ['live-core', 'core-shield', 'rampart-shield', 'tower', 'armed']) test(`loot retreats without withdrawing while ${danger} remains`, () => {
    const w = world(); w.remains('loot', 'ruins', 10, 11);
    if (danger === 'armed') w.enemy(40, 40);
    else if (danger === 'tower') w.structure('danger', 'tower', 40, 40, { contents: { energy: 100 } });
    else w.structure('danger', danger.startsWith('rampart') ? 'rampart' : 'invaderCore', 40, 40, { effects: danger.includes('shield') ? [{ effect: 1001, ticksRemaining: 10 }] : [] });
    w.runCombatLoot(w.creep, w.options); assert.equal(w.actions.some(action => action.type === 'withdraw'), false); assert.equal(w.actions.at(-1).roomName, w.home.name);
});

test('partial cargo is returned when a room is emptied; Store stays occupied until its transfer actually resolves', () => {
    const w = world({ energy: 10 }); const storage = w.structure('home-store', 'storage', 10, 11, { roomName: w.home.name, my: true });
    w.runCombatLoot(w.creep, w.options); assert.equal(w.creep.memory.working, true); assert.equal(w.actions.at(-1).roomName, w.home.name);
    w.place(w.home.name); w.nextTick(); w.runCombatLoot(w.creep, w.options);
    assert.deepEqual(w.actions, [{ type: 'transfer', target: storage.id, resource: 'energy' }]); assert.equal(w.creep.memory.working, true); assert.equal(w.creep.store.energy, 10);
    w.creep.store.energy = 0; w.nextTick(); w.runCombatLoot(w.creep, w.options); assert.equal(w.creep.memory.working, false); assert.deepEqual(w.actions, []);
});

test('returning task units deposit all cargo before selecting a nonbusy active spawn among multiple spawns', () => {
    const w = world({ roomName: 'W1N1', energy: 10 }); w.creep.store.power = 5;
    w.structure('storage', 'storage', 10, 11, { roomName: w.home.name, my: true });
    w.structure('busy', 'spawn', 11, 10, { roomName: w.home.name, my: true, spawning: {} });
    w.structure('inactive', 'spawn', 11, 10, { roomName: w.home.name, my: true, active: false });
    w.structure('free', 'spawn', 15, 10, { roomName: w.home.name, my: true });
    w.returnCombatUnit(w.creep, w.home.name); assert.deepEqual(w.actions, [{ type: 'transfer', target: 'storage', resource: 'power' }]);
    delete w.creep.store.power; w.nextTick(); w.returnCombatUnit(w.creep, w.home.name); assert.deepEqual(w.actions, [{ type: 'transfer', target: 'storage', resource: 'energy' }]);
    w.creep.store.energy = 0; w.nextTick(); w.returnCombatUnit(w.creep, w.home.name);
    assert.deepEqual(w.actions.map(action => action.type), ['recycle', 'moveTo']); assert.equal(w.actions[0].target, 'free'); assert.equal(w.actions[1].target, 'free');
});

test('home delivery falls back from full storage to terminal, then energy spawn or a mineral container without destroying cargo', () => {
    const w = world({ roomName: 'W1N1', energy: 10 });
    w.structure('full', 'storage', 10, 11, { roomName: w.home.name, my: true, contents: { energy: 1000 } });
    const terminal = w.structure('terminal', 'terminal', 10, 11, { roomName: w.home.name, my: true });
    const spawn = w.structure('spawn', 'spawn', 10, 11, { roomName: w.home.name, my: true });
    const container = w.structure('container', 'container', 11, 10, { roomName: w.home.name });
    w.returnCombatUnit(w.creep, w.home.name); assert.equal(w.actions[0].target, terminal.id);
    terminal.store.energy = 1000; w.nextTick(); w.returnCombatUnit(w.creep, w.home.name); assert.equal(w.actions[0].target, spawn.id);
    w.creep.store.energy = 0; w.creep.store.XGH2O = 30; w.nextTick(); w.returnCombatUnit(w.creep, w.home.name); assert.equal(w.actions[0].target, container.id);
    container.store.energy = 1000; w.nextTick(); w.returnCombatUnit(w.creep, w.home.name); assert.deepEqual(w.actions, []); assert.equal(w.creep.store.XGH2O, 30);
});

test('cross-room TTL protection returns existing cargo and refuses a new round trip that cannot be completed', () => {
    const w = world({ life: 180, energy: 10 }); w.remains('loot', 'ruins', 10, 11);
    w.runCombatLoot(w.creep, w.options); assert.deepEqual(w.actions.map(action => action.type), ['moveTo']); assert.equal(w.actions[0].roomName, w.home.name);
    const atHome = world({ roomName: 'W1N1', life: 210 }); atHome.structure('spawn', 'spawn', 10, 11, { roomName: atHome.home.name, my: true });
    atHome.runCombatLoot(atHome.creep, atHome.options); assert.equal(atHome.actions[0].type, 'recycle');
});

test('room routing selects the next hop rather than sending a support creep directly across many rooms', () => {
    const w = world({ roomName: 'W1N1' }); const options = { homeRoom: w.home.name, targetRoom: 'W4N1' };
    w.runCombatScout(w.creep, options); assert.equal(w.actions[0].roomName, 'W2N1'); assert.equal(w.actions[0].maxRooms, 2);
    assert.equal(w.routeCalls[0].options.routeCallback('W9N1'), Infinity);
    w.nextTick(); w.runCombatScout(w.creep, options); assert.equal(w.routeCalls.length, 1, 'runtime route cache avoids repeated findRoute for the same leg');
});

test('an inaccessible loot path temporarily skips its target and permits another source next tick', () => {
    const w = world(); w.remains('unreachable', 'ruins', 20, 20, { contents: { power: 100 } }); w.remains('near', 'ruins', 10, 11);
    w.creep.moveResult = -2; w.runCombatLoot(w.creep, w.options); assert.equal(w.actions[0].target, 'unreachable');
    w.nextTick(); w.runCombatLoot(w.creep, w.options); assert.deepEqual(w.actions, [{ type: 'withdraw', target: 'near', resource: 'energy' }]);
    w.game.time += w.policy.lootRouteCacheTicks; w.nextTick(); w.runCombatLoot(w.creep, w.options); assert.equal(w.actions[0].target, 'unreachable');
});

test('an unknown home remains a cargo-preserving destination and never causes suicide/recycle in the loot room', () => {
    const w = world({ energy: 10 }); delete w.game.rooms[w.home.name]; w.returnCombatUnit(w.creep, w.home.name);
    assert.deepEqual(w.actions.map(action => action.type), ['moveTo']); assert.equal(w.actions[0].roomName, w.home.name); assert.equal(w.creep.store.energy, 10);
});

test('injured haulers at home deposit cargo and then recycle without waiting for healing', () => {
    const w = world({ roomName: 'W1N1', energy: 10 }); w.creep.hits--; w.creep.store.power = 5;
    w.structure('storage', 'storage', 10, 11, { roomName: w.home.name, my: true });
    w.structure('spawn', 'spawn', 11, 10, { roomName: w.home.name, my: true });
    w.runCombatLoot(w.creep, w.options); assert.deepEqual(w.actions, [{ type: 'transfer', target: 'storage', resource: 'power' }]);
    delete w.creep.store.power; w.creep.store.energy = 0; w.nextTick(); w.runCombatLoot(w.creep, w.options);
    assert.deepEqual(w.actions, [{ type: 'recycle', target: 'spawn', unit: 'unit' }]);
});

test('injured controller units at home recycle rather than freezing in a same-room retreat', () => {
    const w = world({ roomName: 'W1N1' }); w.creep.hits--; w.structure('spawn', 'spawn', 11, 10, { roomName: w.home.name, my: true });
    assert.equal(w.runControllerAttack(w.creep, w.options), false); assert.deepEqual(w.actions, [{ type: 'recycle', target: 'spawn', unit: 'unit' }]);
});

test('a controller unit with insufficient outward life recycles before starting another journey', () => {
    const w = world({ roomName: 'W1N1', life: 150 }); w.structure('spawn', 'spawn', 11, 10, { roomName: w.home.name, my: true });
    assert.equal(w.runControllerAttack(w.creep, { homeRoom: w.home.name, targetRoom: 'W4N1' }), false);
    assert.deepEqual(w.actions, [{ type: 'recycle', target: 'spawn', unit: 'unit' }]);
});

test('a controller attacker can finish its one-way objective even when a full return trip no longer fits CLAIM lifetime', () => {
    const w = world({ life: 75 }); w.target.controller.owner = { username: 'enemy' }; w.place(w.target.name, 25, 24);
    assert.equal(w.runControllerAttack(w.creep, w.options), true); assert.deepEqual(w.actions, [{ type: 'attackController', target: w.target.controller.id }]);
});

test('support refuses known live towers in an intermediate room before crossing the exit', () => {
    const w = world({ roomName: 'W1N1' }); w.structure('tower', 'tower', 40, 40, { contents: { energy: 100 } });
    w.runCombatScout(w.creep, { homeRoom: w.home.name, targetRoom: 'W4N1' }); assert.deepEqual(w.actions, []);
    assert.equal(w.routeCalls[0].options.routeCallback(w.target.name), Infinity);
});

test('an intermediate room gaining a tower invalidates the cached next hop before movement', () => {
    const w = world({ roomName: 'W1N1' }); const options = { homeRoom: w.home.name, targetRoom: 'W4N1' };
    w.runCombatScout(w.creep, options); assert.equal(w.actions[0].roomName, w.target.name);
    w.structure('tower', 'tower', 40, 40, { contents: { energy: 100 } }); w.nextTick(); w.runCombatScout(w.creep, options);
    assert.deepEqual(w.actions, []); assert.equal(w.routeCalls.length, 2, 'a new route is attempted only after the next hop becomes unsafe');
});

test('loot intel counts the same eligible NPC/self resources, excluding player/ally remains and invulnerable stores', () => {
    const w = world(); w.remains('npc', 'ruins', 10, 11, { contents: { energy: 20, power: 30 } });
    w.remains('self', 'tombstones', 11, 10, { owner: 'me', contents: { XGH2O: 5 } });
    w.remains('player', 'ruins', 11, 11, { owner: 'enemy', contents: { power: 1000 } });
    w.remains('ally', 'tombstones', 10, 9, { owner: 'friend', contents: { power: 1000 } });
    w.structure('protected', 'storage', 20, 20, { contents: { power: 1000 }, effects: [{ effect: 1001, ticksRemaining: 10 }] });
    w.structure('treasure', 'container', 30, 30, { contents: { energy: 10 } }); w.drop('drop', 20, 19, 'power', 7);
    assert.equal(w.countCombatLoot(w.target, w.home.name), 72);
    w.runCombatLoot(w.creep, w.options); assert.equal(w.actions[0].target, 'npc'); assert.equal(w.actions[0].resource, 'power');
});

test('closed-rampart loot remains in eligible intel while waiting for task cleanup, but cannot be withdrawn yet', () => {
    const w = world(); w.remains('treasure', 'ruins', 10, 11, { contents: { power: 100 } }); w.structure('closed', 'rampart', 10, 11);
    assert.equal(w.countCombatLoot(w.target, w.home.name), 100); w.runCombatLoot(w.creep, w.options); assert.deepEqual(w.actions, []);
});

test('player-owned and ally-reserved rooms expose no permitted default loot amount', () => {
    const w = world(); w.drop('drop', 10, 11, 'power', 100); w.target.controller.owner = { username: 'enemy' };
    assert.equal(w.countCombatLoot(w.target, w.home.name), 0);
    delete w.target.controller.owner; w.target.controller.reservation = { username: 'friend' }; assert.equal(w.countCombatLoot(w.target, w.home.name), 0);
});
