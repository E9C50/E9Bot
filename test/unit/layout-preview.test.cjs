const assert = require('node:assert/strict');
const test = require('node:test');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const { createVisualRuntime } = require('../helpers/room-visual.cjs');

const plan = structures => ({ schemaVersion: 1, origin: 'planner63', createdAt: 1, structures });
function world(blueprint = plan({ spawn: [[17, 27]] }), modules = {}) {
    const visuals = createVisualRuntime();
    const game = { rooms: {}, flags: { layout: { pos: { roomName: 'E39N5' } } } };
    const memory = { rooms: { E39N5: { roomBlueprint: blueprint, autoLaylout: false } } };
    const loader = createSourceLoader({ globals: { Game: game, Memory: memory, RoomVisual: visuals.RoomVisual }, modules: {
        'settings/roomPolicy': { roomPolicy: { flags: { layoutPreview: 'layout' } } },
        'settings/labs': { reactionSource: {} }, ...modules,
    } });
    const api = loader.load('planning/layoutPreview');
    const policy = loader.load('settings/layoutPreview').layoutPreviewPolicy;
    return { ...visuals, game, memory, loader, api, policy, draw: () => api.renderLayoutPreview(),
        commands: () => visuals.commands('E39N5') };
}

test('no flag or disabled preview has no Memory access, allocation or drawing', () => {
    const w = world(); delete w.game.flags.layout;
    Object.defineProperty(w.loader.globals, 'Memory', { get: () => { throw new Error('unnecessary Memory read'); } });
    w.draw(); assert.equal(w.calls.constructors, 0); assert.equal(w.calls.primitives, 0);
    w.game.flags.layout = { pos: { roomName: 'E39N5' } }; w.policy.enabled = false;
    w.draw(); assert.equal(w.calls.constructors, 0);
});

test('layout integrates independently of SV and room ownership, and leaves the blueprint and construction state unchanged', () => {
    const w = world(plan({ spawn: [[17, 27]], factory: [[18, 27]], rampart: [[17, 27]] }));
    w.game.rooms.E39N5 = { my: false, name: 'E39N5' };
    const before = JSON.stringify(w.memory);
    w.loader.load('module/VisualController').visualController();
    assert.ok(w.commands().some(command => command.method === 'poly'), 'future Factory and Rampart are previewed');
    assert.equal(w.commands().filter(command => command.method === 'text').length, 1);
    assert.equal(JSON.stringify(w.memory), before, 'preview works even when automatic layout is disabled');
});

test('roads connect adjacent tiles once, leave distant tiles unconnected, and precede overlaid structures', () => {
    const w = world(plan({ road: [[10, 10], [11, 10], [11, 11], [20, 20], [10, 10]],
        spawn: [[10, 10]], rampart: [[10, 10]] }));
    w.draw(); const commands = w.commands();
    assert.equal(commands.filter(command => command.method === 'line').length, 3);
    assert.equal(commands.filter(command => command.method === 'circle' && command.args.at(-1).radius === 0.1).length, 4);
    const firstSpawn = commands.findIndex(command => command.method === 'circle' && command.args.at(-1).radius === 0.43);
    const rampart = commands.findIndex(command => command.method === 'poly');
    assert.ok(firstSpawn > 3 && rampart > firstSpawn, 'Roads are below buildings, Ramparts are above');
});

test('shared RoomVisual data is preserved once and never captured in the cached layout', () => {
    const w = world(), other = new w.RoomVisual('E39N5');
    other.text('old-tick overlay', 5, 5); w.draw();
    assert.equal(w.commands().filter(command => command.args[0] === 'old-tick overlay').length, 1);
    assert.equal(w.commands().filter(command => command.method === 'circle').length, 3, 'first generation is not imported twice');
    w.nextTick(); other.text('new-tick overlay', 6, 6); const primitives = w.calls.primitives;
    w.loader.globals.Memory = JSON.parse(JSON.stringify(w.memory)); // Fresh Memory object, same blueprint.
    w.draw();
    assert.equal(w.calls.primitives, primitives, 'unchanged layout imports cached data without primitive calls');
    assert.ok(w.commands().some(command => command.args[0] === 'new-tick overlay'));
    assert.ok(!w.commands().some(command => command.args[0] === 'old-tick overlay'));
});

test('in-place blueprint edits and appearance changes refresh the cache immediately', () => {
    const w = world(); w.draw(); w.nextTick();
    w.memory.rooms.E39N5.roomBlueprint.structures.spawn[0] = [22, 24]; w.draw();
    assert.equal(w.commands().find(command => command.method === 'circle').args[0], 22);
    w.nextTick(); w.policy.opacity = 0.45; w.draw();
    assert.equal(w.commands().find(command => command.method === 'circle').args.at(-1).opacity, 0.45);
});

test('moving and removing the flag stops the previous room and recreates its cache when re-added', () => {
    const w = world(); w.memory.rooms.E40N10 = { roomBlueprint: plan({ tower: [[8, 9]] }) };
    w.draw(); w.nextTick(); w.game.flags.layout.pos.roomName = 'E40N10'; w.draw();
    assert.equal(w.commands().length, 0);
    assert.ok(new w.RoomVisual('E40N10').getSize() > 2);
    w.nextTick(); delete w.game.flags.layout; w.draw(); assert.equal(w.commands().length, 0);
    const primitives = w.calls.primitives;
    w.game.flags.layout = { pos: { roomName: 'E39N5' } }; w.draw();
    assert.ok(w.calls.primitives > primitives);
});

test('a room without a blueprint displays a message and begins previewing when a snapshot appears', () => {
    const w = world(); delete w.memory.rooms.E39N5.roomBlueprint; w.draw();
    assert.match(w.commands()[0].args[0], /暂无/);
    assert.equal(w.memory.rooms.E39N5.roomBlueprint, undefined);
    w.nextTick(); w.memory.rooms.E39N5.roomBlueprint = { ...plan({ container: [[12, 14]] }), origin: 'snapshot' };
    w.draw(); assert.match(w.commands().find(command => command.method === 'text').args[0], /现有布局/);
});

test('malformed, duplicate and unknown structure coordinates cannot produce invalid geometry', () => {
    const w = world(plan({ spawn: [[17, 27], [17, 27], null, [], [-1, 2], [50, 2], [3.5, 4], [3, 4, 5]],
        tower: null, unexpected: [[3, 3]] }));
    w.draw(); assert.equal(w.commands().filter(command => command.method === 'circle').length, 3);
});

test('a rendering exception restores unrelated visuals and keeps the failed cache empty', () => {
    let fail = true;
    const w = world(undefined, { 'planning/structureIcons': { drawStructureIcon: visual => {
        if (fail) throw new Error('icon failed'); visual.circle(17, 27);
    } } });
    const visual = new w.RoomVisual('E39N5'); visual.text('keep me', 2, 2); const before = visual.export();
    assert.throws(() => w.draw(), /icon failed/); assert.equal(visual.export(), before);
    fail = false; w.draw(); assert.ok(w.commands().some(command => command.method === 'circle'));
});

test('preview size and remaining native capacity are bounded without losing other overlays', () => {
    const w = world(), visual = new w.RoomVisual('E39N5');
    visual.text('keep me', 2, 2); w.policy.maximumCacheBytes = 50; w.draw();
    assert.equal(w.commands().filter(command => command.method === 'circle').length, 0);
    assert.ok(w.commands().some(command => command.args[0] === 'keep me'));
    assert.match(w.commands().at(-1).args[0], /超出绘图容量/);
    w.nextTick(); w.policy.maximumCacheBytes = 300000; visual.text('x'.repeat(511600), 2, 2); w.draw();
    assert.equal(w.commands().filter(command => command.method === 'circle').length, 0);
    assert.match(w.commands().at(-1).args[0], /容量不足/);
    assert.ok(visual.getSize() <= 512000);
    w.nextTick(); w.draw(); assert.equal(w.commands().filter(command => command.method === 'circle').length, 3);
});

test('even warning labels are withheld when they cannot fit in the remaining native capacity', () => {
    for (const state of ['no-blueprint', 'oversized-preview', 'not-enough-capacity']) {
        const w = world(), visual = new w.RoomVisual('E39N5');
        if (state === 'no-blueprint') delete w.memory.rooms.E39N5.roomBlueprint;
        if (state === 'oversized-preview') w.policy.maximumCacheBytes = 50;
        visual.text('x'.repeat(511800), 2, 2); const before = visual.export();
        w.draw();
        assert.equal(visual.export(), before, state);
        assert.ok(visual.getSize() <= 512000, state);
    }
});
