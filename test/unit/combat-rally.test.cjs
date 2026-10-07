const test = require('node:test');
const assert = require('node:assert/strict');
const { createCombatWorld, DIRECTIONS } = require('../helpers/combat-world.cjs');

function world() {
    const w = createCombatWorld(), home = w.room('W1N1', { my: true }), sites = [];
    Object.assign(w.loader.globals, { FIND_CONSTRUCTION_SITES: 'sites', FIND_SOURCES: 'sources', FIND_MINERALS: 'minerals', ERR_NO_PATH: -2 });
    const find = home.find.bind(home);
    home.find = kind => kind === 'sites' ? sites : find(kind);
    w.pathFinder.CostMatrix.prototype.clone = function () {
        const copy = new w.pathFinder.CostMatrix(); copy.costs = new Map(this.costs); return copy;
    };
    // Validate the complete route, rather than accepting any first step as a reachable parking goal.
    w.pathFinder.search = (start, goal, options = {}) => {
        const costs = options.roomCallback?.(start.roomName), key = pos => `${pos.x},${pos.y}`;
        const queue = [start], seen = new Set([key(start)]), previous = new Map();
        let found;
        for (let index = 0; index < queue.length; index++) {
            const pos = queue[index];
            if (pos.getRangeTo(goal.pos) <= goal.range) { found = pos; break; }
            for (const [dx, dy] of DIRECTIONS.slice(1)) {
                const x = pos.x + dx, y = pos.y + dy;
                if (x < 0 || x > 49 || y < 0 || y > 49 || seen.has(`${x},${y}`) ||
                    (w.walls.get(`${start.roomName}:${x},${y}`) || 0) & 1 || costs?.get(x, y) === 255) continue;
                const next = w.position(x, y); seen.add(key(next)); previous.set(key(next), pos); queue.push(next);
            }
        }
        const path = [];
        for (let pos = found; pos && key(pos) !== key(start); pos = previous.get(key(pos))) path.unshift(pos);
        return { path, incomplete: !found, ops: seen.size, cost: path.length };
    };
    home.spawns = [w.structure('spawn', 'spawn', { x: 20, y: 20, my: true })];
    home.memory.roomPosition = { managerPos: w.position(21, 20), centerPos: w.position(21, 20) };
    const park = w.loader.load('combat/rally').parkReadyCombatMembers;
    function task(id, names, count = names.length) {
        const value = { id, shard: 'shard3', homeRoom: 'W1N1', targetRoom: 'W2N1', phase: 'spawning',
            generation: 1, memberNames: names, plan: { formation: count > 2 ? 'quad' : count === 2 ? 'duo' : 'solo', members: Array(count).fill({}) } };
        (w.loader.globals.Memory.combatTasks ||= {})[id] = value;
        return value;
    }
    return { ...w, home, sites, task, park };
}

function goal(member) { return member.actions.filter(action => action.kind === 'moveTo').at(-1)?.pos; }
function footprint(task) {
    const width = task.rally.count > 1 ? 2 : 1, height = task.rally.count > 2 ? 2 : 1, tiles = [];
    for (let dx = -1; dx <= width; dx++) for (let dy = -1; dy <= height; dy++) tiles.push(`${task.rally.x + dx},${task.rally.y + dy}`);
    return tiles;
}

test('legacy tasks automatically receive an open formation area and issue real moves away from economic traffic', () => {
    const w = world();
    for (const [type, x, y] of [['storage', 22, 20], ['terminal', 22, 21], ['lab', 24, 23]])
        w.structure(type, type, { x, y, my: true });
    for (let y = 5; y <= 44; y++) w.structure(`road-${y}`, 'road', { x: 19, y, my: true });
    w.sites.push({ structureType: 'lab', pos: w.position(15, 16) });
    const members = ['a', 'b', 'c', 'd'].map((name, i) => w.unit(name, ['move'], { x: 20 + i % 2, y: 21 + Math.floor(i / 2) }));
    const task = w.task('old', members.map(member => member.name));
    assert.equal(task.rally, undefined);
    w.park(task, members);
    assert.ok(task.rally);
    assert.equal(new Set(members.map(member => `${goal(member).x},${goal(member).y}`)).size, 4);
    for (const member of members) {
        const destination = goal(member);
        assert.ok(destination.x >= 5 && destination.x <= 44 && destination.y >= 5 && destination.y <= 44);
        assert.ok(destination.getRangeTo(w.home.spawns[0]) > 5);
        for (const building of [...w.structures.filter(item => item.structureType !== 'road'), ...w.sites])
            assert.ok(destination.getRangeTo(building.pos) > (building.structureType === 'spawn' ? 5 : 3));
        assert.ok(Math.abs(destination.x - 19) > 1, 'the waiting footprint does not occupy the road or its neighboring tile');
        assert.equal(member.actions.at(-1).options.range, 0);
    }
    for (let tick = 0; tick < 30; tick++) { w.advance(); w.park(task, members); }
    const arrived = members.map(member => member.pos);
    assert.equal(new Set(arrived.map(pos => `${pos.x},${pos.y}`)).size, 4);
    assert.ok(arrived.every(pos => pos.x >= task.rally.x && pos.x <= task.rally.x + 1 && pos.y >= task.rally.y && pos.y <= task.rally.y + 1));
});

test('different active tasks reserve disjoint seats and approach rings even before every fighter exists', () => {
    const w = world(), first = w.unit('a', ['move'], { x: 20, y: 21 }), second = w.unit('e', ['move'], { x: 21, y: 21 });
    const a = w.task('a', ['a', 'b', 'c', 'd']), b = w.task('b', ['e', 'f', 'g', 'h']);
    w.park(a, [first]); w.park(b, [second]);
    assert.equal(Object.keys(a.rally.slots).length, 4);
    assert.equal(Object.keys(b.rally.slots).length, 4);
    const occupied = new Set(footprint(a));
    assert.equal(footprint(b).some(tile => occupied.has(tile)), false);
    assert.notDeepEqual(goal(first), goal(second));
});

test('legacy tasks without published member order keep existing seats when another ready fighter joins', () => {
    const w = world(), first = w.unit('first', ['move'], { x: 20, y: 21 }), task = w.task('old', [], 4);
    delete task.memberNames;
    w.park(task, [first]); const firstSeat = goal(first);
    const second = w.unit('second', ['move'], { x: 21, y: 21 });
    w.game.time++; first.actions.length = 0;
    w.park(task, [second, first]);
    assert.deepEqual(goal(first), firstSeat);
    assert.notDeepEqual(goal(first), goal(second));
    assert.equal(task.rally.slots.first, 0); assert.equal(task.rally.slots.second, 1);
});

test('nearby open pockets behind a wall cannot crowd reachable candidate areas out of consideration', () => {
    const w = world(), member = w.unit('a', ['move'], { x: 20, y: 21 }), task = w.task('a', ['a']);
    for (let y = 0; y < 50; y++) w.walls.set(`W1N1:15,${y}`, 1);
    w.park(task, [member]);
    assert.ok(task.rally.x > 15, 'the selected empty area is in the same accessible part of the room');
    assert.ok(goal(member));
});

test('new roads, building sites or a foreign occupant invalidate cached parking instead of holding a corridor', () => {
    for (const obstacle of ['road', 'site', 'creep']) {
        const w = world(), member = w.unit('a', ['move'], { x: 20, y: 21 }), task = w.task('a', ['a']);
        w.park(task, [member]); const old = { ...task.rally }; member.actions.length = 0;
        if (obstacle === 'road') w.structure('new-road', 'road', { x: old.x, y: old.y, my: true });
        if (obstacle === 'site') w.sites.push({ structureType: 'storage', pos: w.position(old.x, old.y) });
        if (obstacle === 'creep') w.unit('filler', ['move'], { x: old.x, y: old.y });
        w.game.time++; w.park(task, [member]);
        assert.ok(task.rally.x !== old.x || task.rally.y !== old.y, obstacle);
        assert.ok(goal(member), obstacle);
    }
});

test('repeated no-path movement failures recheck an empty cached area when its approach becomes unreachable', () => {
    const w = world(), member = w.unit('a', ['move'], { x: 20, y: 21 }), task = w.task('a', ['a']);
    w.park(task, [member]); const old = { ...task.rally }, move = member.moveTo;
    const search = w.pathFinder.search;
    w.pathFinder.search = (start, goal, options) => goal.pos.x === old.x && goal.pos.y === old.y ?
        { path: [], incomplete: true } : search(start, goal, options);
    member.moveTo = (pos, options) => { move(pos, options); return pos.x === old.x && pos.y === old.y ? -2 : 0; };
    for (let tick = 0; tick < 3; tick++) { w.game.time++; w.park(task, [member]); }
    assert.equal(task.rally.pathFailures.a, 3);
    w.game.time++; w.park(task, [member]);
    assert.ok(task.rally.x !== old.x || task.rally.y !== old.y, 'the cached empty footprint alone cannot preserve an unreachable parking destination');
});

test('an enemy or PowerCreep sharing a fighter name cannot occupy that fighters reserved seat', () => {
    for (const power of [false, true]) {
        const w = world(), member = w.unit('a', ['move'], { x: 20, y: 21 }), task = w.task('a', ['a']);
        w.park(task, [member]); const old = { ...task.rally };
        w.unit('a', ['move'], { x: old.x, y: old.y, my: power, power });
        member.actions.length = 0; w.game.time++; w.park(task, [member]);
        assert.ok(task.rally.x !== old.x || task.rally.y !== old.y);
    }
});

test('parked fighters remain crossable and tired waiting members do not stop healthy teammates from moving', () => {
    const w = world(), healthy = w.unit('a', ['move'], { x: 20, y: 21 }), tired = w.unit('b', ['move'], { x: 21, y: 21, fatigue: 1 });
    const task = w.task('a', ['a', 'b']);
    healthy.memory.dontPullMe = true; healthy.memory.lastPos = { x: 20, y: 21, time: 50 };
    w.park(task, [healthy, tired]);
    assert.ok(goal(healthy)); assert.equal(goal(tired), undefined);
    healthy.pos = goal(healthy); healthy.actions.length = 0; healthy.memory.dontPullMe = true;
    w.game.time++; w.park(task, [healthy, tired]);
    assert.equal(goal(healthy), undefined);
    assert.equal(healthy.memory.dontPullMe, false); assert.equal(healthy.memory.lastPos.time, 0);
});

test('a room without a reachable safe area retries without locking traffic or assigning unsafe seats', () => {
    const w = world(), member = w.unit('a', ['move'], { x: 20, y: 21 }), task = w.task('a', ['a']);
    member.memory.dontPullMe = true;
    w.pathFinder.search = () => ({ path: [], incomplete: true });
    w.park(task, [member]);
    assert.equal(task.rally, undefined); assert.equal(goal(member), undefined);
    assert.equal(task.rallyRetryAt, w.game.time + 10); assert.equal(member.memory.dontPullMe, false);
});
