const test = require('node:test');
const assert = require('node:assert/strict');
const { createCombatWorld } = require('../helpers/combat-world.cjs');

test('combat snapshot reuses room structure cache, excludes allies and neutral facilities, and expires each tick', () => {
    const w = createCombatWorld(), room = w.room();
    const enemy = w.unit('enemy', ['attack'], { my: false });
    w.unit('ally', ['attack'], { my: false, owner: 'NoName_' });
    const mine = w.unit('mine');
    const hostileTower = w.structure('hostile-tower', 'tower');
    w.structure('own-tower', 'tower', { my: true });
    w.structure('ally-tower', 'tower', { owner: 'NoName_' });
    w.structure('road', 'road', { owner: null, my: undefined });
    const wall = w.structure('wall', 'constructedWall', { owner: null, my: undefined });
    w.structure('shield-core', 'invaderCore', { effects: [{ effect: 1001, ticksRemaining: 10 }] });
    const api = w.loader.load('combat/intelligence'), first = api.combatSnapshot(room);
    assert.deepEqual(Array.from(first.enemies, item => item.name), ['enemy']);
    assert.deepEqual(Array.from(first.friendlies, item => item.name), ['mine']);
    assert.deepEqual(Array.from(first.towers, item => item.id), ['hostile-tower']);
    assert.deepEqual(Array.from(first.structures, item => item.id), ['hostile-tower', 'wall']);
    assert.equal(w.findCounts.get('W1N1:structures') || 0, 0, 'RoomExtension structures are reused');
    assert.equal(api.combatSnapshot(room), first);
    enemy.hits = 0; w.structures.splice(w.structures.indexOf(hostileTower), 1);
    w.game.time++;
    assert.notEqual(api.combatSnapshot(room), first);
    assert.equal(api.combatSnapshot(room).towers.length, 0);
    assert.equal(api.isCombatHostile(mine), false);
    assert.equal(api.isCombatHostile(wall, w.room('W2N1', { my: true })), false);
});

test('native structure fallback is scanned once per tick when RoomExtension is absent', () => {
    const w = createCombatWorld(), room = w.room();
    Object.defineProperty(room, 'structures', { value: undefined });
    const api = w.loader.load('combat/intelligence');
    api.combatSnapshot(room); api.combatSnapshot(room);
    assert.equal(w.findCounts.get('W1N1:structures'), 1);
    w.game.time++; api.combatSnapshot(room);
    assert.equal(w.findCounts.get('W1N1:structures'), 2);
});

test('combat power uses live parts and exact native action boosts, with no body assumption for PowerCreep', () => {
    const w = createCombatWorld(), unit = w.unit('unit', [
        { type: 'attack', boost: 'XUH2O' }, { type: 'attack', boost: 'XUH2O', hits: 0 },
        { type: 'ranged_attack', boost: 'KHO2' }, { type: 'heal', boost: 'XLHO2' },
        { type: 'work', boost: 'XZH2O' }, 'claim', 'move',
    ]);
    const api = w.loader.load('combat/intelligence');
    assert.deepEqual(JSON.parse(JSON.stringify(api.combatPower(unit))), { attack: 120, ranged: 30, heal: 48, rangedHeal: 16, dismantle: 200, claim: 1 });
    assert.equal(api.combatPower(unit), api.combatPower(unit));
    const pc = w.unit('pc', [], { power: true, my: false, hits: 5000, hitsMax: 5000 });
    assert.equal(api.combatPower(pc).attack, 0);
    assert.equal(api.effectiveDamage(pc, 1000), 1000);
    unit.body[0].hits = 0; w.game.time++;
    assert.equal(api.combatPower(unit).attack, 0);
});

test('TOUGH protection consumes front live hits, ignores broken parts and preserves lethal overflow', () => {
    const w = createCombatWorld(), unit = w.unit('unit', [{ type: 'tough', boost: 'XGHO2' }, 'move']);
    const { effectiveDamage } = w.loader.load('combat/intelligence');
    assert.equal(effectiveDamage(unit, 300), 90);
    assert.equal(effectiveDamage(unit, 101), 30, 'native rounding cannot overestimate a tower kill by one hit');
    assert.equal(effectiveDamage(unit, 400), 167);
    assert.equal(effectiveDamage(unit, 2000), 1767, 'not clamped to current 200 hits');
    unit.body[0].hits = 0;
    assert.equal(effectiveDamage(unit, 300), 300);
    const rearTough = w.unit('rear', ['move', { type: 'tough', boost: 'XGHO2' }]);
    assert.equal(effectiveDamage(rearTough, 100), 100);
});

test('tower falloff, ammunition, active state and actual power-effect levels apply to damage and healing', () => {
    const w = createCombatWorld(), tower = w.structure('tower', 'tower', { x: 10, y: 10 });
    const api = w.loader.load('combat/intelligence');
    assert.equal(api.towerDamage(tower, w.position(15, 10)), 600);
    assert.equal(api.towerDamage(tower, w.position(20, 10)), 450);
    assert.equal(api.towerDamage(tower, w.position(30, 10)), 150);
    tower.effects = [{ effect: 3, level: 5, ticksRemaining: 2 }, { effect: 10, level: 1, ticksRemaining: 2 }];
    assert.equal(api.towerDamage(tower, w.position(10, 10)), 810);
    assert.equal(api.towerHeal(tower, w.position(10, 10)), 540);
    tower.effects[0].ticksRemaining = 0;
    assert.equal(api.towerDamage(tower, w.position(10, 10)), 540);
    tower.store.energy = 9; assert.equal(api.towerDamage(tower, w.position(10, 10)), 0);
    tower.store.energy = 10; tower.active = false; assert.equal(api.towerDamage(tower, w.position(10, 10)), 0);
    tower.active = true; assert.equal(api.towerDamage(tower, w.position(10, 10, 'W2N1')), 0);
});

test('incoming damage adds independent melee and ranged intents but never double-counts ranged mass', () => {
    const w = createCombatWorld(), mine = w.unit('mine', ['tough', 'move'], { x: 10, y: 10 });
    w.unit('enemy', ['attack', 'ranged_attack', 'move'], { my: false, x: 11, y: 10 });
    w.structure('tower', 'tower', { x: 10, y: 10 });
    const api = w.loader.load('combat/intelligence');
    assert.equal(api.incomingDamage(mine, mine.pos, api.combatSnapshot(mine.room), false), 640);
});

test('movement prediction checks fatigue, live MOVE, terrain and friendly barriers', () => {
    const w = createCombatWorld(), mine = w.unit('mine', ['move'], { x: 10, y: 10 });
    const enemy = w.unit('enemy', ['attack', 'move'], { my: false, x: 12, y: 10 });
    const api = w.loader.load('combat/intelligence'), snapshot = api.combatSnapshot(mine.room);
    assert.equal(api.incomingDamage(mine, mine.pos, snapshot, false), 0);
    assert.equal(api.incomingDamage(mine, mine.pos, snapshot), 30);
    enemy.fatigue = 1; assert.equal(api.incomingDamage(mine, mine.pos, snapshot), 0);
    enemy.fatigue = 0;
    for (const y of [9, 10, 11]) w.walls.set(`W1N1:11,${y}`, 1);
    assert.equal(api.incomingDamage(mine, mine.pos, snapshot), 0);
    w.walls.clear();
    for (const y of [9, 10, 11]) w.structure(`cover-${y}`, 'rampart', { x: 11, y, my: true });
    assert.equal(api.incomingDamage(mine, mine.pos, snapshot), 0);
});

test('own rampart protection and native safe mode protect defenders before TOUGH', () => {
    const w = createCombatWorld(), room = w.room('W1N1', { my: true });
    const mine = w.unit('mine', ['move']);
    w.structure('tower', 'tower');
    const cover = w.structure('cover', 'rampart', { my: true, x: 10, y: 10, hits: 1000 });
    const api = w.loader.load('combat/intelligence'), snapshot = api.combatSnapshot(room);
    assert.equal(api.incomingDamage(mine, mine.pos, snapshot), 0);
    cover.hits = 100; assert.equal(api.incomingDamage(mine, mine.pos, snapshot), 500);
    room.controller.safeMode = 50; assert.equal(api.incomingDamage(mine, mine.pos, snapshot), 0);
});
