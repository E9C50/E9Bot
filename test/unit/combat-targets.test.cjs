const test = require('node:test');
const assert = require('node:assert/strict');
const { createCombatWorld, DIRECTIONS } = require('../helpers/combat-world.cjs');

// Search every reachable tile with native eight-way steps and weighted CostMatrix costs.
// The small combat-world mock intentionally returns only one step, so it cannot prove connectivity.
function useCompletePathFinder(w) {
    w.pathFinder.search = (start, goal, options = {}) => {
        const costs = options.roomCallback?.(start.roomName), key = (x, y) => x * 50 + y;
        const frontier = [{ point: start, cost: 0 }], best = new Map([[key(start.x, start.y), 0]]);
        const previous = new Map([[key(start.x, start.y), undefined]]), points = new Map([[key(start.x, start.y), start]]);
        let nearest = start, found;
        while (frontier.length > 0) {
            frontier.sort((first, second) => second.cost - first.cost);
            const { point, cost } = frontier.pop();
            if (cost !== best.get(key(point.x, point.y))) continue;
            if (point.getRangeTo(goal.pos) < nearest.getRangeTo(goal.pos)) nearest = point;
            if (point.getRangeTo(goal.pos) <= goal.range) { found = point; break; }
            for (let direction = 1; direction <= 8; direction++) {
                const [dx, dy] = DIRECTIONS[direction], x = point.x + dx, y = point.y + dy;
                const terrain = w.walls.get(`${start.roomName}:${x},${y}`) || 0;
                if (x < 0 || y < 0 || x > 49 || y > 49 || terrain & 1 || costs?.get(x, y) === 255) continue;
                const nextCost = cost + (costs?.get(x, y) || (terrain & 2 ? options.swampCost : options.plainCost) || 1);
                if (nextCost >= (best.get(key(x, y)) ?? Infinity)) continue;
                const next = w.position(x, y, start.roomName);
                best.set(key(x, y), nextCost); previous.set(key(x, y), key(point.x, point.y)); points.set(key(x, y), next);
                frontier.push({ point: next, cost: nextCost });
            }
        }
        const path = []; let cursor = key((found || nearest).x, (found || nearest).y);
        while (previous.get(cursor) !== undefined) { path.unshift(points.get(cursor)); cursor = previous.get(cursor); }
        return { path, incomplete: !found, ops: best.size, cost: best.get(key((found || nearest).x, (found || nearest).y)) };
    };
}

function api(w) { return w.loader.load('combat/targets'); }
function snapshot(w) { return w.loader.load('combat/intelligence').combatSnapshot(w.room()); }
function select(w, members, formation = 'solo', range = 1, mode = 'attack') {
    return api(w).selectCombatTarget(members, snapshot(w), mode, formation, range);
}
function remove(w, object) {
    w.structures.splice(w.structures.indexOf(object), 1); w.byId.delete(object.id); w.game.time++;
}
function curtain(w, x, gaps = []) {
    for (let y = 0; y < 50; y++) if (!gaps.includes(y))
        w.structure(`wall-${x}-${y}`, 'constructedWall', { x, y, owner: null, hits: 50 });
}

test('every hostile creep is cleared before an adjacent tower, including unarmed workers and PowerCreeps', () => {
    for (const power of [false, true]) {
        const w = createCombatWorld(), mine = w.unit('mine', ['attack', 'move']);
        const enemy = w.unit('worker', ['work', 'carry', 'move'], { my: false, x: 30, power });
        w.structure('tower', 'tower', { x: 11, energy: 0 });
        assert.equal(select(w, [mine]), enemy);
        assert.deepEqual(Array.from(api(w).combatAttackObjectives(snapshot(w), 'attack', mine.room), object => object.id), ['worker']);
    }
});

test('the structure stage includes neutral roads and containers and never includes barriers or controller', () => {
    const w = createCombatWorld(), mine = w.unit('mine', ['work', 'move']);
    w.structure('wall', 'constructedWall', { x: 13, owner: null });
    w.structure('rampart', 'rampart', { x: 14 });
    w.structure('controller', 'controller', { x: 16 });
    const road = w.structure('road', 'road', { x: 11, owner: null });
    const container = w.structure('container', 'container', { x: 12, owner: null });
    const intelligence = w.loader.load('combat/intelligence');
    assert.equal(intelligence.isCombatHostile(road, mine.room), false, 'general defense hostility remains unchanged');
    assert.deepEqual(Array.from(api(w).combatAttackObjectives(snapshot(w), 'attack', mine.room), object => object.id), ['road', 'container']);
    assert.equal(select(w, [mine]), road);
    remove(w, road); assert.equal(select(w, [mine]), container);
    remove(w, container); assert.equal(select(w, [mine]), undefined, 'leftover barriers do not become cleaning objectives');
});

test('own and whitelisted objects and rooms are excluded from the structure clearing predicate', () => {
    const w = createCombatWorld(), targets = api(w), room = w.room();
    const own = w.structure('own', 'tower', { my: true });
    const allied = w.structure('allied', 'tower', { owner: 'NoName_' });
    const neutral = w.structure('neutral', 'container', { owner: null });
    const destroyed = w.structure('destroyed', 'spawn', { hits: 0 });
    const indestructible = w.structure('indestructible', 'controller'); delete indestructible.hits;
    for (const object of [own, allied, destroyed, indestructible]) assert.equal(targets.isCombatStructureObjective(object, room), false, object.id);
    assert.equal(targets.isCombatStructureObjective(neutral, room), true);
    assert.equal(targets.isCombatStructureObjective(neutral, w.room('W2N1', { my: true })), false);
    assert.equal(targets.isCombatStructureObjective(neutral, w.room('W2N2', { owner: 'NoName_' })), false);
});

test('indestructible portals and keeper lairs are never objectives even if a fixture exposes hit points', () => {
    const w = createCombatWorld(), mine = w.unit('mine', ['work', 'move']);
    const lair = w.structure('lair', 'keeperLair', { owner: null, hits: 1000 });
    const portal = w.structure('portal', 'portal', { owner: null, hits: 1000 });
    for (const object of [lair, portal]) assert.equal(api(w).isCombatStructureObjective(object, mine.room), false);
    assert.equal(select(w, [mine]), undefined);
});

test('hold mode preserves its unit-only targets and does not clear neutral facilities', () => {
    const w = createCombatWorld(), mine = w.unit('mine', ['attack', 'move']);
    w.structure('road', 'road', { x: 11, owner: null });
    w.structure('spawn', 'spawn', { x: 12 });
    assert.equal(select(w, [mine], 'solo', 1, 'hold'), undefined);
    const enemy = w.unit('worker', ['move'], { my: false, x: 15 }); w.game.time++;
    assert.equal(select(w, [mine], 'solo', 1, 'hold'), enemy);
});

test('a hostile unit covered by a rampart selects its own cover before any unrelated rampart or structure', () => {
    const w = createCombatWorld(), mine = w.unit('mine', ['ranged_attack', 'move']);
    w.unit('worker', ['move'], { my: false, x: 13 });
    const cover = w.structure('cover', 'rampart', { x: 13 });
    w.structure('other-cover', 'rampart', { x: 11 });
    w.structure('tower', 'tower', { x: 12, energy: 0 });
    assert.equal(select(w, [mine], 'solo', 3), cover);
});

test('an invulnerable enemy prevents switching to structure cleanup while its legal targets are empty', () => {
    const w = createCombatWorld(), mine = w.unit('mine', ['attack', 'move']);
    const shielded = w.unit('shielded', ['move'], { my: false, x: 15 });
    shielded.effects = [{ effect: 1001, ticksRemaining: 10 }];
    w.structure('tower', 'tower', { x: 11, energy: 0 });
    assert.equal(snapshot(w).enemies.length, 0);
    assert.equal(select(w, [mine]), undefined);
    shielded.effects[0].ticksRemaining = 0; w.game.time++;
    assert.equal(select(w, [mine]), shielded);
});

test('an enclosed creep takes one opening on its route and reuses that opening for later buildings', () => {
    const w = createCombatWorld(), mine = w.unit('mine', ['attack', 'work', 'move']);
    useCompletePathFinder(w); curtain(w, 12);
    const worker = w.unit('worker', ['move'], { my: false, x: 16 });
    const spawn = w.structure('spawn', 'spawn', { x: 20 });
    const barrier = select(w, [mine]);
    assert.equal(barrier.structureType, 'constructedWall'); assert.equal(barrier.pos.x, 12);
    remove(w, barrier); assert.equal(select(w, [mine]), worker);
    worker.hits = 0; w.game.time++;
    assert.equal(select(w, [mine]), spawn, 'the same opening serves structure cleanup');
    assert.equal(w.structures.filter(object => object.structureType === 'constructedWall').length, 49);
    remove(w, spawn); assert.equal(select(w, [mine]), undefined);
});

test('an existing reachable gap and an irrelevant adjacent wall do not cause any demolition', () => {
    const w = createCombatWorld(), mine = w.unit('mine', ['work', 'move']);
    useCompletePathFinder(w); curtain(w, 12, [10]);
    w.structure('irrelevant', 'constructedWall', { x: 11, y: 11, owner: null });
    const spawn = w.structure('spawn', 'spawn', { x: 16 });
    assert.equal(select(w, [mine]), spawn);
});

test('a quad opens only the contiguous width its footprint needs and then keeps all remaining barriers', () => {
    const w = createCombatWorld(); useCompletePathFinder(w); curtain(w, 14);
    const quad = [[10, 10], [11, 10], [10, 11], [11, 11]].map(([x, y], index) => w.unit(`q${index}`, ['work', 'move'], { x, y }));
    const spawn = w.structure('spawn', 'spawn', { x: 20 });
    const first = select(w, quad, 'quad'); assert.equal(first.structureType, 'constructedWall');
    remove(w, first);
    const second = select(w, quad, 'quad'); assert.equal(second.structureType, 'constructedWall');
    assert.equal(first.pos.x, second.pos.x); assert.equal(Math.abs(first.pos.y - second.pos.y), 1);
    remove(w, second); assert.equal(select(w, quad, 'quad'), spawn);
    assert.equal(w.structures.filter(object => object.structureType === 'constructedWall').length, 48);
});

test('a wall on a partial route that can never reach the objective is not selected for useless demolition', () => {
    const w = createCombatWorld(), mine = w.unit('mine', ['work', 'move']);
    useCompletePathFinder(w); curtain(w, 12);
    for (let y = 0; y < 50; y++) w.walls.set(`W1N1:14,${y}`, 1);
    const spawn = w.structure('spawn', 'spawn', { x: 16 });
    assert.equal(select(w, [mine]), spawn);
});
