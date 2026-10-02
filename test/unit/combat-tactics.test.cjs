const test = require('node:test');
const assert = require('node:assert/strict');
const { createCombatWorld, DIRECTIONS } = require('../helpers/combat-world.cjs');

function actions(unit, ...kinds) { return unit.actions.filter(action => kinds.includes(action.kind)); }
function movement(unit) { return actions(unit, 'move', 'moveTo'); }
function destination(w, unit) {
    const action = movement(unit).at(-1);
    return !action ? unit.pos : action.kind === 'move' ? w.shifted(unit.pos, ...DIRECTIONS[action.direction]) : action.pos;
}
function run(w, members, options = {}) {
    w.loader.load('combat/tactics').executeCombatSquad(members, { targetRoom: 'W1N1', mode: 'attack', ...options });
}

// A bounded grid search models a genuinely unreachable destination and a partial path to its outer wall.
function gridPathFinder(w) {
    w.pathFinder.search = (start, goal, options = {}) => {
        const costs = options.roomCallback?.(start.roomName), key = (x, y) => `${x},${y}`;
        const queue = [start], visited = new Map([[key(start.x, start.y), null]]), points = new Map([[key(start.x, start.y), start]]);
        let nearest = start, found;
        for (let index = 0; index < queue.length; index++) {
            const point = queue[index];
            if (point.getRangeTo(goal.pos) < nearest.getRangeTo(goal.pos)) nearest = point;
            if (point.getRangeTo(goal.pos) <= goal.range) { found = point; break; }
            for (let direction = 1; direction <= 8; direction++) {
                const [dx, dy] = DIRECTIONS[direction], x = point.x + dx, y = point.y + dy;
                if (x < 0 || y < 0 || x > 49 || y > 49 || visited.has(key(x, y)) ||
                    w.walls.get(`${start.roomName}:${x},${y}`) & 1 || costs?.get(x, y) === 255) continue;
                const next = w.position(x, y, start.roomName);
                visited.set(key(x, y), key(point.x, point.y)); points.set(key(x, y), next); queue.push(next);
            }
        }
        const path = []; let cursor = key((found || nearest).x, (found || nearest).y);
        while (visited.get(cursor) !== null) { path.unshift(points.get(cursor)); cursor = visited.get(cursor); }
        return { path, incomplete: !found, ops: visited.size, cost: path.length };
    };
}

test('a hybrid heals and uses one ranged intent without issuing an incompatible melee intent', () => {
    const w = createCombatWorld();
    const mine = w.unit('mine', ['attack', 'ranged_attack', 'heal', 'move'], { hits: 360 });
    w.unit('enemy', ['move'], { my: false, x: 11 });
    run(w, [mine]);
    assert.equal(actions(mine, 'heal').length, 1);
    assert.equal(actions(mine, 'rangedAttack').length, 1);
    assert.equal(actions(mine, 'attack', 'dismantle').length, 0);
});

test('structure attacks choose dismantle or melee once and can combine a separate ranged attack', () => {
    const w = createCombatWorld();
    const mine = w.unit('mine', ['attack', 'work', 'ranged_attack', 'move']);
    w.structure('enemy-tower', 'tower', { x: 11, energy: 0 });
    run(w, [mine]);
    assert.equal(actions(mine, 'dismantle').length, 1);
    assert.equal(actions(mine, 'attack').length, 0);
    assert.equal(actions(mine, 'rangedAttack').length, 1);
});

test('ranged healing occupies ranged and primary intent slots instead of being overwritten by fire', () => {
    const w = createCombatWorld();
    const mine = w.unit('healer', ['heal', 'ranged_attack', 'move']);
    w.unit('hurt-ally', ['move'], { x: 13, hits: 10 });
    w.unit('enemy', ['move'], { x: 12, my: false });
    run(w, [mine], { mode: 'hold' });
    assert.equal(actions(mine, 'rangedHeal').length, 1);
    assert.equal(actions(mine, 'rangedAttack', 'rangedMassAttack', 'attack').length, 0);
});

test('coordinated healers allocate separate wounded members instead of double-healing the first', () => {
    const w = createCombatWorld();
    const a = w.unit('a', ['ranged_attack', 'move'], { x: 11, y: 10, hits: 180 });
    const b = w.unit('b', ['ranged_attack', 'move'], { x: 11, y: 11, hits: 180 });
    const h1 = w.unit('h1', ['heal', 'move'], { x: 10, y: 10 });
    const h2 = w.unit('h2', ['heal', 'move'], { x: 10, y: 11 });
    run(w, [a, b, h1, h2], { formation: 'quad', mode: 'hold' });
    const healed = [...actions(h1, 'heal'), ...actions(h2, 'heal')].map(action => action.target);
    assert.equal(healed.length, 2);
    assert.equal(new Set(healed).size, 2);
});

test('mass attack is chosen for multiple adjacent targets but single attack wins at range three', () => {
    const close = createCombatWorld(), first = close.unit('mine', ['ranged_attack', 'move']);
    close.unit('e1', ['move'], { my: false, x: 11, y: 10 });
    close.unit('e2', ['move'], { my: false, x: 10, y: 11 });
    run(close, [first]);
    assert.equal(actions(first, 'rangedMassAttack').length, 1);
    assert.equal(actions(first, 'rangedAttack').length, 0);
    const far = createCombatWorld(), second = far.unit('mine', ['ranged_attack', 'move']);
    for (let y = 10; y <= 12; y++) far.unit(`e${y}`, ['move'], { my: false, x: 13, y });
    run(far, [second]);
    assert.equal(actions(second, 'rangedAttack').length, 1);
    assert.equal(actions(second, 'rangedMassAttack').length, 0);
});

test('mass attacks avoid whitelisted players, PowerCreeps and neutral economic structures', () => {
    for (const collateral of ['creep', 'powerCreep', 'road']) {
        const w = createCombatWorld(), mine = w.unit('mine', ['ranged_attack', 'move']);
        w.unit('e1', ['move'], { my: false, x: 11, y: 10 });
        w.unit('e2', ['move'], { my: false, x: 10, y: 11 });
        if (collateral === 'road') w.structure('road', 'road', { x: 11, y: 11, my: undefined, owner: null });
        else w.unit('friend', ['move'], { my: false, owner: 'NoName_', x: 11, y: 11, power: collateral === 'powerCreep' });
        run(w, [mine]);
        assert.equal(actions(mine, 'rangedMassAttack').length, 0, collateral);
        assert.equal(actions(mine, 'rangedAttack').length, 1, collateral);
    }
});

test('hostile ramparts take priority over the creep or tower protected underneath', () => {
    const w = createCombatWorld(), mine = w.unit('mine', ['ranged_attack', 'move']);
    w.unit('enemy', ['move'], { my: false, x: 13 });
    w.structure('cover', 'rampart', { x: 13 });
    w.structure('enemy-tower', 'tower', { x: 13, energy: 0 });
    run(w, [mine]);
    assert.equal(actions(mine, 'rangedAttack')[0].target, 'cover');
});

test('holding position does not destroy economic structures or advance toward them', () => {
    const w = createCombatWorld(), mine = w.unit('mine', ['ranged_attack', 'attack', 'move']);
    w.structure('enemy-spawn', 'spawn', { x: 11 });
    run(w, [mine], { mode: 'hold' });
    assert.equal(actions(mine, 'attack', 'rangedAttack', 'rangedMassAttack', 'dismantle').length, 0);
    assert.equal(movement(mine).length, 0);
});

test('hold mode pursues hostile units elsewhere in the target room while ignoring economic structures', () => {
    const w = createCombatWorld(), mine = w.unit('mine', ['attack', 'move']);
    const enemy = w.unit('enemy', ['move'], { my: false, x: 25 });
    w.structure('enemy-spawn', 'spawn', { x: 11 });
    run(w, [mine], { mode: 'hold' });
    assert.ok(destination(w, mine).getRangeTo(enemy.pos) < mine.pos.getRangeTo(enemy.pos));
    assert.equal(actions(mine, 'attack', 'dismantle', 'rangedAttack').length, 0);
});

test('an inaccessible enemy spawn is reached by dismantling a reachable wall instead of stalling at a partial path', () => {
    const w = createCombatWorld(), mine = w.unit('mine', ['work', 'move']);
    gridPathFinder(w);
    for (let y = 0; y < 50; y++) w.structure(`wall-${y}`, 'constructedWall', { x: 12, y, owner: null, hits: 50 });
    const spawn = w.structure('spawn', 'spawn', { x: 16, y: 10 });
    run(w, [mine]);
    assert.equal(destination(w, mine).x, 11);
    w.advance(); run(w, [mine]);
    const demolition = actions(mine, 'dismantle')[0];
    assert.ok(demolition?.target.startsWith('wall-'));
    const barrier = w.byId.get(demolition.target);
    w.structures.splice(w.structures.indexOf(barrier), 1); w.byId.delete(barrier.id);
    w.advance(); run(w, [mine]);
    assert.ok(destination(w, mine).getRangeTo(spawn.pos) < mine.pos.getRangeTo(spawn.pos));
});

test('Invader Cores are attacked with legal weapons and never receive a dismantle intent', () => {
    const workerWorld = createCombatWorld(), worker = workerWorld.unit('worker', ['work', 'move']);
    workerWorld.structure('core', 'invaderCore', { x: 11 });
    run(workerWorld, [worker]);
    assert.equal(actions(worker, 'dismantle').length, 0);
    assert.equal(movement(worker).length, 0);
    const hybridWorld = createCombatWorld(), hybrid = hybridWorld.unit('hybrid', ['work', 'attack', 'ranged_attack', 'move']);
    hybridWorld.structure('core', 'invaderCore', { x: 11 });
    run(hybridWorld, [hybrid]);
    assert.equal(actions(hybrid, 'dismantle').length, 0);
    assert.equal(actions(hybrid, 'attack').length, 1);
    assert.equal(actions(hybrid, 'rangedAttack').length, 1);
});

test('risk forecasting does not reuse one healer for every simultaneously pressured member', () => {
    const w = createCombatWorld();
    const front = w.unit('front', ['attack', 'move'], { x: 10, y: 10 });
    const second = w.unit('second', ['attack', 'move'], { x: 11, y: 10 });
    const healer = w.unit('healer', [{ type: 'heal', boost: 'XLHO2' }, 'move'], { x: 10, y: 11 });
    const fourth = w.unit('fourth', ['move'], { x: 11, y: 11 });
    const left = w.unit('left', ['attack', ...Array(20).fill('move')], { my: false, x: 8 });
    w.unit('right', ['attack', ...Array(20).fill('move')], { my: false, x: 13 });
    run(w, [front, second, healer, fourth], { formation: 'quad' });
    assert.ok(destination(w, front).getRangeTo(left.pos) >= front.pos.getRangeTo(left.pos));
});

test('an immediately threatened squad member receives healing before a larger external ally deficit', () => {
    const w = createCombatWorld();
    const front = w.unit('front', Array(10).fill('ranged_attack'), { hits: 450, x: 10, y: 10 });
    const healer = w.unit('healer', [...Array(25).fill({ type: 'heal', boost: 'XLHO2' }), ...Array(25).fill('move')], { x: 11, y: 10 });
    w.unit('outside', Array(50).fill('move'), { hits: 500, x: 11, y: 11 });
    w.structure('tower', 'tower', { x: 12, y: 10, hits: 100 });
    run(w, [front, healer], { formation: 'duo' });
    assert.equal(actions(healer, 'heal')[0]?.target, 'front');
    assert.equal(actions(front, 'rangedAttack')[0]?.target, 'tower');
});

test('a rejected healing intent is not counted as current-tick survival support', () => {
    const w = createCombatWorld();
    const front = w.unit('front', [...Array(9).fill('ranged_attack'), 'move'], { hits: 450, x: 10, y: 10 });
    const healer = w.unit('healer', [...Array(25).fill({ type: 'heal', boost: 'XLHO2' }), ...Array(25).fill('move')], { x: 11, y: 10 });
    healer.heal = target => { healer.actions.push({ kind: 'heal', target: target.id }); return -9; };
    const tower = w.structure('tower', 'tower', { x: 12, y: 10, hits: 50 });
    run(w, [front, healer], { formation: 'duo' });
    assert.equal(actions(healer, 'heal')[0]?.target, 'front');
    assert.ok(destination(w, front).getRangeTo(tower.pos) > front.pos.getRangeTo(tower.pos));
});

test('quad path matrices, room occupancy and searches are reused only during their current tick', () => {
    const w = createCombatWorld(), room = w.room();
    const quad = [[10, 10], [11, 10], [10, 11], [11, 11]].map(([x, y], i) => w.unit(String(i), ['ranged_attack', 'move'], { x, y }));
    const movementModule = w.loader.load('combat/squadMovement'), goal = w.position(20, 10);
    let searches = 0, terrainReads = 0;
    const originalSearch = w.pathFinder.search, originalTerrain = w.game.map.getRoomTerrain;
    w.pathFinder.search = (...args) => { searches++; return originalSearch(...args); };
    w.game.map.getRoomTerrain = name => { const terrain = originalTerrain(name); return { get(x, y) { terrainReads++; return terrain.get(x, y); } }; };
    movementModule.planSquadMovement(quad, goal, 3, 'quad');
    const initialReads = terrainReads;
    movementModule.planSquadMovement(quad, goal, 3, 'quad');
    movementModule.planSquadMovement(quad, goal, 3, 'quad');
    assert.equal(searches, 1);
    assert.equal(terrainReads, initialReads);
    assert.equal(w.findCounts.get('W1N1:creeps'), 1);
    assert.equal(w.findCounts.get('W1N1:powerCreeps'), 1);
    w.game.time++;
    w.structure('new-blocker', 'constructedWall', { x: 12, y: 10, owner: null });
    const next = movementModule.planSquadMovement(quad, goal, 3, 'quad');
    assert.equal(searches, 2);
    assert.ok(terrainReads > initialReads);
    assert.equal(w.findCounts.get('W1N1:creeps'), 2);
    for (const pos of next.values()) assert.notEqual(`${pos.x},${pos.y}`, '12,10');
});

test('cross-room movement follows the safe map route and refuses known dangerous transit rooms', () => {
    const w = createCombatWorld(), mine = w.unit('mine', ['ranged_attack', 'move']);
    w.room('W2N1', { owner: 'enemy' });
    w.room('W2N2'); w.structure('transit-tower', 'tower', { roomName: 'W2N2' });
    w.room('W2N3'); w.unit('armed-transit', ['attack', 'move'], { my: false, roomName: 'W2N3' });
    w.room('W1N2', { owner: 'NoName_' });
    w.room('W3N1', { owner: 'enemy' });
    let routes = 0;
    w.game.map.findRoute = (from, to, options) => {
        routes++;
        assert.equal(options.routeCallback('W2N1'), Infinity);
        assert.equal(options.routeCallback('W2N2'), Infinity);
        assert.equal(options.routeCallback('W2N3'), Infinity);
        assert.equal(options.routeCallback('W1N2'), 1);
        assert.equal(options.routeCallback('W3N1'), 1, 'the explicit attack destination remains eligible');
        return [{ room: 'W1N2', exit: 1 }, { room: to, exit: 3 }];
    };
    w.pathFinder.search = (start, goal, options) => {
        for (const name of ['W2N1', 'W2N2', 'W2N3', 'W4N4']) assert.equal(options.roomCallback(name), false, name);
        assert.notEqual(options.roomCallback('W1N2'), false);
        assert.notEqual(options.roomCallback('W3N1'), false);
        return { path: [w.position(10, 9)], incomplete: false, ops: 1, cost: 1 };
    };
    const planner = w.loader.load('combat/squadMovement');
    planner.planSquadMovement([mine], w.position(25, 25, 'W3N1'), 10, 'solo');
    planner.planSquadMovement([mine], w.position(25, 25, 'W3N1'), 10, 'solo');
    assert.equal(routes, 1);
    assert.equal(w.findCounts.get('W2N1:myCreeps'), 1);
});

test('an unknown transit room becoming visible with tower pressure makes the squad retreat safely', () => {
    const w = createCombatWorld();
    w.room('W1N1', { my: true });
    const mine = w.unit('mine', ['ranged_attack', 'move'], { roomName: 'W2N1', x: 49, y: 25 });
    const tower = w.structure('new-tower', 'tower', { roomName: 'W2N1', x: 45, y: 25 });
    run(w, [mine], { targetRoom: 'W3N1', retreatRoom: 'W1N1' });
    assert.equal(destination(w, mine).roomName, 'W1N1');
    assert.ok(destination(w, mine).getRangeTo(tower.pos) > mine.pos.getRangeTo(tower.pos));
});

test('PowerCreep occupancy cannot be mistaken for an allowed squad member with the same name', () => {
    const w = createCombatWorld(), mine = w.unit('same', ['attack', 'move']);
    w.unit('same', [], { power: true, x: 11 });
    assert.equal(w.loader.load('combat/squadMovement').combatWalkable(w.position(11, 10), [mine]), false);
});

test('unsustainable tower fire causes retreat even when an attack goal remains present', () => {
    const w = createCombatWorld(), mine = w.unit('mine', ['ranged_attack', 'heal', 'move']);
    const tower = w.structure('tower', 'tower', { x: 12 });
    run(w, [mine]);
    assert.equal(movement(mine).length, 1);
    assert.ok(destination(w, mine).getRangeTo(tower.pos) > mine.pos.getRangeTo(tower.pos));
});

test('enemy healing that exceeds squad damage stops an advance into a fight it cannot win', () => {
    const w = createCombatWorld(), mine = w.unit('mine', ['ranged_attack', 'move']);
    w.unit('enemy', [{ type: 'heal', boost: 'XLHO2' }, 'move'], { my: false, x: 20 });
    run(w, [mine]);
    assert.equal(movement(mine).length, 0);
});

test('a strong melee unit can close for a short fight but weak melee does not enter counterattack danger', () => {
    const strong = createCombatWorld();
    const a = strong.unit('mine', [...Array(10).fill('attack'), ...Array(10).fill('move')]);
    strong.unit('enemy', ['attack', 'attack', 'move'], { my: false, x: 12 });
    run(strong, [a]);
    assert.ok(destination(strong, a).getRangeTo(strong.units[1].pos) < a.pos.getRangeTo(strong.units[1].pos));
    const weak = createCombatWorld(), b = weak.unit('mine', ['attack', 'move']);
    weak.unit('enemy', [...Array(5).fill('attack'), 'move'], { my: false, x: 12 });
    run(weak, [b]);
    assert.ok(destination(weak, b).getRangeTo(weak.units[1].pos) >= b.pos.getRangeTo(weak.units[1].pos));
});

test('ranged solo kites an approaching melee enemy while preserving one ranged intent', () => {
    const w = createCombatWorld(), mine = w.unit('mine', ['ranged_attack', ...Array(4).fill('heal'), 'move']);
    const enemy = w.unit('enemy', ['attack', 'move'], { my: false, x: 12 });
    run(w, [mine]);
    assert.equal(destination(w, mine).getRangeTo(enemy.pos), 3);
    assert.equal(actions(mine, 'rangedAttack', 'rangedMassAttack').length, 1);
});

test('duo leader waits for a distant follower and fatigue synchronizes both members', () => {
    const w = createCombatWorld(), front = w.unit('front', ['attack', 'move']);
    const healer = w.unit('healer', ['heal', 'move'], { x: 4 });
    w.unit('enemy', ['move'], { my: false, x: 20 });
    run(w, [front, healer], { formation: 'duo' });
    assert.equal(movement(front).length, 0);
    assert.equal(movement(healer).length, 1);
    w.advance(); healer.pos = w.position(9, 10); healer.fatigue = 1;
    run(w, [front, healer], { formation: 'duo' });
    assert.equal(movement(front).length, 0);
    assert.equal(movement(healer).length, 0);
});

test('a ready quad advances as a rigid 2x2, preserving all four offsets', () => {
    const w = createCombatWorld();
    const quad = [[10, 10], [11, 10], [10, 11], [11, 11]].map(([x, y], i) => w.unit(String(i), ['ranged_attack', 'move'], { x, y }));
    w.unit('enemy', ['move'], { my: false, x: 20 });
    run(w, quad, { formation: 'quad' });
    const deltas = quad.map(member => { const next = destination(w, member); return `${next.x - member.pos.x},${next.y - member.pos.y}`; });
    assert.equal(new Set(deltas).size, 1);
    assert.equal(quad.reduce((sum, member) => sum + movement(member).length, 0), 4);
});

test('quad footprint checks every member tile rather than letting a rear member walk into a wall', () => {
    const w = createCombatWorld();
    const quad = [[10, 10], [11, 10], [10, 11], [11, 11]].map(([x, y], i) => w.unit(String(i), ['ranged_attack', 'move'], { x, y }));
    w.walls.set('W1N1:12,10', 1);
    w.unit('enemy', ['move'], { my: false, x: 20 });
    run(w, quad, { formation: 'quad' });
    for (const member of quad) { const next = destination(w, member); assert.notEqual(`${next.x},${next.y}`, '12,10'); }
});

test('quad does not force a 2x2 through a single-tile corridor', () => {
    const w = createCombatWorld();
    const quad = [[10, 10], [11, 10], [10, 11], [11, 11]].map(([x, y], i) => w.unit(String(i), ['ranged_attack', 'move'], { x, y }));
    for (let x = 8; x <= 13; x++) for (let y = 8; y <= 13; y++) {
        if ((x === 10 || x === 11) && (y === 10 || y === 11) || (x === 12 || x === 13) && y === 10) continue;
        w.walls.set(`W1N1:${x},${y}`, 1);
    }
    w.unit('enemy', ['move'], { my: false, x: 20 });
    run(w, quad, { formation: 'quad' });
    assert.equal(quad.reduce((sum, member) => sum + movement(member).length, 0), 0);
});

test('one unfinished or failed boost plan holds the entire quad until all are prepared', () => {
    const w = createCombatWorld();
    const quad = [[10, 10], [11, 10], [10, 11], [11, 11]].map(([x, y], i) => w.unit(String(i), ['ranged_attack', 'move'], { x, y }));
    w.unit('enemy', ['move'], { my: false, x: 20 });
    quad[2].memory.boostPlan = { tier: 3, steps: [{ type: 'boostRAttack', resource: 'XKHO2', parts: 1 }] };
    run(w, quad, { formation: 'quad' });
    assert.equal(quad.flatMap(member => member.actions).length, 0);
    quad[2].memory.boostPlan.completed = true;
    run(w, quad, { formation: 'quad' });
    assert.ok(quad.some(member => movement(member).length > 0));
});

test('partial quad loss retreats rather than charging a new attack with three members', () => {
    const w = createCombatWorld();
    const quad = [[10, 10], [11, 10], [10, 11]].map(([x, y], i) => w.unit(String(i), ['ranged_attack', 'move'], { x, y }));
    const enemy = w.unit('enemy', ['move'], { my: false, x: 20 });
    run(w, quad, { formation: 'quad' });
    assert.ok(destination(w, quad[0]).getRangeTo(enemy.pos) >= quad[0].pos.getRangeTo(enemy.pos));
});

test('duo clears a border and reunites across rooms before advancing again', () => {
    const w = createCombatWorld();
    const front = w.unit('front', ['attack', 'move'], { roomName: 'W1N1', x: 0, y: 25 });
    const healer = w.unit('healer', ['heal', 'move'], { roomName: 'W2N1', x: 49, y: 25 });
    run(w, [front, healer], { formation: 'duo', mode: 'hold' });
    assert.equal(destination(w, front).x, 1);
    assert.equal(destination(w, healer).roomName, 'W1N1');
    w.advance();
    run(w, [front, healer], { formation: 'duo', mode: 'hold' });
    assert.equal(destination(w, front).x, 2);
    assert.equal(destination(w, healer).x, 1);
    w.advance();
    assert.ok(front.pos.getRangeTo(healer.pos) <= 1);
    assert.ok(front.pos.x > 0 && healer.pos.x > 0);
});

test('hold formation still gathers a distant follower without moving the leader', () => {
    const w = createCombatWorld(), front = w.unit('front', ['attack', 'move']);
    const healer = w.unit('healer', ['heal', 'move'], { x: 4 });
    run(w, [front, healer], { formation: 'duo', mode: 'hold' });
    assert.equal(movement(front).length, 0);
    assert.equal(movement(healer).length, 1);
});

test('repeated execution cannot overwrite intents or poison the following tick with artificial retreat', () => {
    const w = createCombatWorld(), mine = w.unit('mine', ['ranged_attack', 'move']);
    w.unit('enemy', ['move'], { my: false, x: 20 });
    run(w, [mine]); run(w, [mine]);
    assert.equal(movement(mine).length, 1);
    assert.ok(destination(w, mine).x > mine.pos.x);
    w.advance(); run(w, [mine]);
    assert.ok(destination(w, mine).x > mine.pos.x);
});

test('room-edge retreat evaluates legal positions without constructing out-of-bounds coordinates', () => {
    const w = createCombatWorld(), mine = w.unit('mine', ['ranged_attack', 'move'], { x: 0, y: 0, hits: 40 });
    w.unit('enemy', ['move'], { my: false, x: 1, y: 1 });
    assert.doesNotThrow(() => run(w, [mine]));
    const next = destination(w, mine);
    assert.ok(next.x >= 0 && next.x <= 49 && next.y >= 0 && next.y <= 49);
});

test('foreign safe mode waits and a missing MOVE part never lets squad mates abandon the immobile member', () => {
    const w = createCombatWorld(), front = w.unit('front', ['attack', 'move']);
    const healer = w.unit('healer', ['heal', { type: 'move', hits: 0 }], { x: 9 });
    w.unit('enemy', ['move'], { my: false, x: 20 });
    run(w, [front, healer], { formation: 'duo' });
    assert.equal(movement(front).length + movement(healer).length, 0);
    w.advance(); healer.body[1].hits = 100; w.room().controller.safeMode = 10;
    run(w, [front, healer], { formation: 'duo' });
    assert.equal(movement(front).length + movement(healer).length, 0);
    assert.equal(actions(front, 'attack').length, 0);
});
