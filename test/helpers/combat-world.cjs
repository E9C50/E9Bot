const { createSourceLoader } = require('./load-typescript.cjs');

const DIRECTIONS = [[0, 0], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
const whitelist = ['NoName_', 'MoSaSa', 'Kaoruko', 'keqing', 'RainbowCandy'];
function roomXY(name) {
    const [, ew, x, ns, y] = /^([WE])(\d+)([NS])(\d+)$/.exec(name);
    return [ew === 'W' ? -Number(x) - 1 : Number(x), ns === 'N' ? -Number(y) - 1 : Number(y)];
}
function roomName(x, y) { return `${x < 0 ? `W${-x - 1}` : `E${x}`}${y < 0 ? `N${-y - 1}` : `S${y}`}`; }
class Position {
    constructor(x, y, roomName) {
        if (x < 0 || x > 49 || y < 0 || y > 49) throw new Error(`invalid position ${x},${y}`);
        Object.assign(this, { x, y, roomName });
    }
    getRangeTo(other) { other = other.pos || other; return other.roomName === this.roomName ? Math.max(Math.abs(other.x - this.x), Math.abs(other.y - this.y)) : Infinity; }
    getDirectionTo(other) {
        other = other.pos || other;
        const dx = Math.sign(other.x - this.x), dy = Math.sign(other.y - this.y);
        return DIRECTIONS.findIndex(([x, y]) => x === dx && y === dy);
    }
    isNearTo(other) { return this.getRangeTo(other) <= 1; }
    isEqualTo(other) { return this.getRangeTo(other) === 0; }
}
class Matrix {
    constructor() { this.costs = new Map(); }
    set(x, y, cost) { this.costs.set(`${x},${y}`, cost); return this; }
    get(x, y) { return this.costs.get(`${x},${y}`) || 0; }
}
function shifted(position, dx, dy) {
    let x = position.x + dx, y = position.y + dy, [rx, ry] = roomXY(position.roomName);
    if (x < 0) { rx--; x = 49; } else if (x > 49) { rx++; x = 0; }
    if (y < 0) { ry--; y = 49; } else if (y > 49) { ry++; y = 0; }
    return new Position(x, y, roomName(rx, ry));
}
function worldRange(a, b) {
    const [ax, ay] = roomXY(a.roomName), [bx, by] = roomXY(b.roomName);
    return Math.max(Math.abs(ax * 50 + a.x - bx * 50 - b.x), Math.abs(ay * 50 + a.y - by * 50 - b.y));
}

function createCombatWorld() {
    const units = [], structures = [], byId = new Map(), rooms = {}, walls = new Map(), findCounts = new Map();
    const game = { time: 100, shard: { name: 'shard3' }, rooms, creeps: {},
        getObjectById: id => byId.get(id) || null,
        map: { getRoomTerrain: name => ({ get: (x, y) => walls.get(`${name}:${x},${y}`) || 0 }),
            findRoute: (from, to) => [{ room: to, exit: 3 }] } };
    function room(name = 'W1N1', { my = false, owner = my ? 'me' : undefined } = {}) {
        if (rooms[name]) return rooms[name];
        const created = { name, sources: [], mineral: undefined, memory: {},
            controller: { my, owner: owner ? { username: owner } : undefined, pos: new Position(40, 40, name) },
            getTerrain: () => game.map.getRoomTerrain(name),
            find(kind) {
                const key = `${name}:${kind}`; findCounts.set(key, (findCounts.get(key) || 0) + 1);
                if (kind === 'structures') return structures.filter(item => item.pos.roomName === name);
                const local = units.filter(item => item.pos.roomName === name);
                if (kind === 'myCreeps') return local.filter(item => item.my && item.body);
                if (kind === 'creeps') return local.filter(item => item.body);
                if (kind === 'powerCreeps') return local.filter(item => !item.body);
                if (kind === 'hostileCreeps') return local.filter(item => !item.my && item.body);
                if (kind === 'hostilePowerCreeps') return local.filter(item => !item.my && !item.body);
                return [];
            },
            lookForAt(kind, x, y) {
                const local = kind === 'structure' ? structures : units.filter(item => kind === 'creep' ? item.body : !item.body);
                return local.filter(item => item.pos.roomName === name && item.pos.x === x && item.pos.y === y);
            },
        };
        Object.defineProperties(created, {
            structures: { get: () => structures.filter(item => item.pos.roomName === name), configurable: true },
            enemies: { get: () => units.filter(item => item.pos.roomName === name && !item.my && !whitelist.includes(item.owner.username)) },
            towers: { get: () => structures.filter(item => item.pos.roomName === name && item.structureType === 'tower') },
        });
        rooms[name] = created;
        return created;
    }
    function unit(name, parts = ['move'], { x = 10, y = 10, roomName = 'W1N1', my = true, owner = my ? 'me' : 'enemy', hits, hitsMax, fatigue = 0, power = false } = {}) {
        room(roomName);
        const body = parts.map(part => typeof part === 'string' ? { type: part, hits: 100 } : { hits: 100, ...part });
        const created = { name, id: name, my, owner: { username: owner }, memory: {}, pos: new Position(x, y, roomName),
            ...(power ? {} : { body }), fatigue, spawning: false, hits: hits ?? Math.max(100, body.length * 100),
            hitsMax: hitsMax ?? Math.max(100, body.length * 100), actions: [], ticksToLive: 1500 };
        Object.defineProperty(created, 'room', { get: () => rooms[created.pos.roomName] });
        for (const kind of ['attack', 'dismantle', 'rangedAttack', 'rangedMassAttack', 'heal', 'rangedHeal']) created[kind] = target => {
            created.actions.push({ kind, target: target?.id }); return 0;
        };
        created.move = direction => { created.actions.push({ kind: 'move', direction }); return 0; };
        created.moveTo = (pos, options) => { created.actions.push({ kind: 'moveTo', pos: pos.pos || pos, options }); return 0; };
        units.push(created); byId.set(name, created); if (my) game.creeps[name] = created;
        return created;
    }
    function structure(id, type, { x = 12, y = 10, roomName = 'W1N1', my = false, owner = my ? 'me' : 'enemy', hits = 1000,
        energy = 1000, effects = [], active = true, isPublic = false } = {}) {
        room(roomName);
        const created = { id, structureType: type, pos: new Position(x, y, roomName), my,
            owner: owner ? { username: owner } : undefined, hits, hitsMax: hits, effects, active, isPublic,
            store: { energy }, isActive: () => created.active };
        Object.defineProperty(created, 'room', { get: () => rooms[created.pos.roomName] });
        structures.push(created); byId.set(id, created); return created;
    }
    const boosts = { attack: {}, ranged_attack: {}, heal: {}, work: {}, tough: {}, move: {}, carry: {}, claim: {} };
    for (const [resources, part, actions, values] of [
        [['UH', 'UH2O', 'XUH2O'], 'attack', ['attack'], [2, 3, 4]],
        [['KO', 'KHO2', 'XKHO2'], 'ranged_attack', ['rangedAttack', 'rangedMassAttack'], [2, 3, 4]],
        [['LO', 'LHO2', 'XLHO2'], 'heal', ['heal', 'rangedHeal'], [2, 3, 4]],
        [['ZH', 'ZH2O', 'XZH2O'], 'work', ['dismantle'], [2, 3, 4]],
        [['GO', 'GHO2', 'XGHO2'], 'tough', ['damage'], [0.7, 0.5, 0.3]],
    ]) resources.forEach((resource, i) => boosts[part][resource] = Object.fromEntries(actions.map(action => [action, values[i]])));
    const pathFinder = { CostMatrix: Matrix, search(start, goal, options = {}) {
        goal = Array.isArray(goal) ? goal[0] : goal;
        if (worldRange(start, goal.pos) <= goal.range) return { path: [], incomplete: false };
        const candidates = [];
        for (let direction = 1; direction <= 8; direction++) {
            const [dx, dy] = DIRECTIONS[direction], next = shifted(start, dx, dy);
            const terrain = game.map.getRoomTerrain(next.roomName).get(next.x, next.y);
            if (terrain & 1) continue;
            const costs = options.roomCallback?.(next.roomName);
            if (costs === false || costs instanceof Matrix && costs.get(next.x, next.y) === 255) continue;
            candidates.push({ next, score: worldRange(next, goal.pos) + (costs instanceof Matrix ? costs.get(next.x, next.y) / 100 : 0) });
        }
        candidates.sort((a, b) => a.score - b.score);
        return { path: candidates.length ? [candidates[0].next] : [], incomplete: !candidates.length };
    } };
    const globals = { Game: game, Memory: {}, RoomPosition: Position, PathFinder: pathFinder, BOOSTS: boosts,
        ATTACK: 'attack', RANGED_ATTACK: 'ranged_attack', HEAL: 'heal', WORK: 'work', CLAIM: 'claim', TOUGH: 'tough', MOVE: 'move', CARRY: 'carry',
        ATTACK_POWER: 30, RANGED_ATTACK_POWER: 10, HEAL_POWER: 12, RANGED_HEAL_POWER: 4, DISMANTLE_POWER: 50,
        TOWER_POWER_ATTACK: 600, TOWER_POWER_HEAL: 400, TOWER_ENERGY_COST: 10, TOWER_OPTIMAL_RANGE: 5, TOWER_FALLOFF_RANGE: 20, TOWER_FALLOFF: 0.75,
        RESOURCE_ENERGY: 'energy', PWR_OPERATE_TOWER: 3, PWR_DISRUPT_TOWER: 10, EFFECT_INVULNERABILITY: 1001,
        POWER_INFO: { 3: { effect: [1.1, 1.2, 1.3, 1.4, 1.5] }, 10: { effect: [0.9, 0.8, 0.7, 0.6, 0.5] } },
        FIND_STRUCTURES: 'structures', FIND_MY_CREEPS: 'myCreeps', FIND_CREEPS: 'creeps', FIND_POWER_CREEPS: 'powerCreeps',
        FIND_HOSTILE_CREEPS: 'hostileCreeps', FIND_HOSTILE_POWER_CREEPS: 'hostilePowerCreeps',
        LOOK_STRUCTURES: 'structure', LOOK_CREEPS: 'creep', LOOK_POWER_CREEPS: 'powerCreep', TERRAIN_MASK_WALL: 1, TERRAIN_MASK_SWAMP: 2,
        OBSTACLE_OBJECT_TYPES: ['spawn', 'extension', 'constructedWall', 'link', 'storage', 'tower', 'lab', 'terminal', 'observer', 'invaderCore'],
        STRUCTURE_ROAD: 'road', STRUCTURE_CONTAINER: 'container', STRUCTURE_CONTROLLER: 'controller', STRUCTURE_SPAWN: 'spawn',
        STRUCTURE_WALL: 'constructedWall', STRUCTURE_RAMPART: 'rampart', STRUCTURE_TOWER: 'tower', STRUCTURE_INVADER_CORE: 'invaderCore',
        OK: 0,
    };
    const loader = createSourceLoader({ globals });
    function advance() {
        for (const creep of units) {
            const action = creep.actions.filter(item => item.kind === 'move' || item.kind === 'moveTo').at(-1);
            if (action && !creep.fatigue) creep.pos = action.kind === 'move' ? shifted(creep.pos, ...DIRECTIONS[action.direction]) :
                (worldRange(creep.pos, action.pos) <= 1 ? action.pos : pathFinder.search(creep.pos, { pos: action.pos, range: 0 }).path[0] || creep.pos);
            room(creep.pos.roomName); creep.actions.length = 0;
        }
        game.time++;
    }
    return { loader, game, rooms, units, structures, byId, findCounts, room, unit, structure, walls,
        position: (x, y, name = 'W1N1') => new Position(x, y, name), advance, shifted, pathFinder };
}
module.exports = { createCombatWorld, Position, DIRECTIONS };
