const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function emptyRoom() {
    return { creepConfig: {}, creepSpawnQueue: [], roomLabConfig: { singleLabConfig: {} },
        terminalSendJob: {}, terminalAmount: {}, roomStructure: {}, restrictedPos: {}, roomPosition: {},
        roomFillJob: { labInMineral: [] }, teamConfig: {}, boostNeed: {} };
}
function world(rooms = {}, memory = { rooms: {} }) {
    const game = { rooms, flags: {}, time: 1 };
    const loader = createSourceLoader({ globals: { Game: game, Memory: memory }, modules: {
        'settings/room': { roomSignTextList: [] },
        'settings/roomPolicy': { roomPolicy: { flags: { updateCache: 'updateCache' } } },
        'room/labBoostPriority': { prioritizeLabBoostJobs: () => false },
    } });
    return { game, memory, loader, ...loader.load('runtime/memory') };
}

test('105 historical initialization-only entries release their whole JSON size without touching live or mixed data', () => {
    const records = Object.fromEntries(Array.from({ length: 105 }, (_, index) => [`E${index + 50}N10`, emptyRoom()]));
    const mixed = {
        blueprint: { ...emptyRoom(), roomBlueprint: { structures: [{ x: 20, y: 20, type: 'spawn' }] } },
        userConfig: { ...emptyRoom(), fastUpgrade: false },
        remotes: { ...emptyRoom(), developmentRemotes: { selectedRooms: ['E10N10'] } },
        commands: { ...emptyRoom(), terminalSendJob: { send: { resourceType: 'energy', targetRoom: 'E10N10', amount: 3000 } } },
        lifecycle: { ...emptyRoom(), evacuation: { status: 'waiting' }, needUpdateCache: false },
    };
    const visibleMemory = emptyRoom();
    const memory = { rooms: { ...records, ...mixed, visible: visibleMemory },
        shardRouteCache: { keep: { portals: ['E10N10'] } }, shardPortalIntel: { scannedRooms: { E10N10: 100 } },
        userConfig: { keep: true }, creeps: { worker: { targetRoom: 'E10N10' } } };
    const w = world({ visible: { my: false } }, memory);
    const before = Buffer.byteLength(JSON.stringify(memory));
    const expected = { ...memory, rooms: { ...mixed, visible: visibleMemory } };
    const after = Buffer.byteLength(JSON.stringify(expected));
    assert.ok(before - after > 20000, '105 genuine initializer records occupy meaningful serialized space');
    const unrelated = [memory.shardRouteCache, memory.shardPortalIntel, memory.userConfig, memory.creeps];
    w.loadMemory();
    assert.equal(Buffer.byteLength(JSON.stringify(memory)), after);
    assert.deepEqual(Object.keys(memory.rooms).sort(), ['blueprint', 'commands', 'lifecycle', 'remotes', 'userConfig', 'visible']);
    for (const key in mixed) assert.equal(memory.rooms[key], mixed[key], 'mixed entries are retained whole');
    assert.equal(memory.rooms.visible, visibleMemory);
    assert.deepEqual([memory.shardRouteCache, memory.shardPortalIntel, memory.userConfig, memory.creeps], unrelated);
});

test('any flag and every visible room protect even completely empty initialization records', () => {
    const memory = { rooms: { visible: emptyRoom(), own: {}, flagged: emptyRoom(), stale: emptyRoom() } };
    const w = world({ visible: { my: false }, own: { my: true } }, memory);
    w.game.flags.customUserFlag = { pos: { roomName: 'flagged' } };
    w.loadMemory();
    assert.deepEqual(Object.keys(memory.rooms).sort(), ['flagged', 'own', 'visible']);
    delete w.game.flags.customUserFlag;
    w.game.time++;
    w.loadMemory();
    assert.equal(memory.rooms.flagged, undefined, 'an unprotected historical empty record can then be removed');
});

test('unknown fields and malformed or nonempty derived values are never discarded', () => {
    const variants = [
        { custom: {} }, { custom: false }, { custom: null }, { fastUpgrade: false }, { needUpdateCache: false },
        { creepConfig: [] }, { creepSpawnQueue: {} }, { terminalAmount: null }, { teamConfig: false },
        { boostNeed: 0 }, { roomPosition: '' }, { restrictedPos: { worker: { x: 10, y: 10 } } },
        { creepConfig: { worker: { role: 'harvester' } } }, { creepSpawnQueue: ['worker'] },
        { terminalAmount: { energy: 0 } }, { terminalSendJob: { send: { amount: 0 } } },
        { roomLabConfig: {} }, { roomLabConfig: { singleLabConfig: {}, sourceLab1: null } },
        { roomLabConfig: { singleLabConfig: [] } }, { roomLabConfig: { singleLabConfig: { lab: { boostMode: false } } } },
        { roomFillJob: {} }, { roomFillJob: { labInMineral: [], custom: [] } },
        { roomFillJob: { labInMineral: [], labOut: ['lab'] } }, { roomFillJob: { labInMineral: [], labInEnergy: null } },
        { roomFillJob: { labInMineral: {} } }, { roomStructure: { towerAllowRepair: null } },
    ];
    const records = Object.fromEntries(variants.map((variant, index) => [`case${index}`, { ...emptyRoom(), ...variant }]));
    const w = world({}, { rooms: records });
    w.loadMemory();
    assert.equal(Object.keys(w.memory.rooms).length, variants.length);
    for (const [name, original] of Object.entries(records)) assert.equal(w.memory.rooms[name], original);
});

test('the exact empty Lab queue variants and an empty room entry are safe derived states', () => {
    const w = world({}, { rooms: { blank: {}, labs: { ...emptyRoom(), roomFillJob: { labInMineral: [], labOut: [], labInEnergy: [] } } } });
    w.loadMemory();
    assert.deepEqual(w.memory.rooms, {});
});

test('fresh external configuration is read every tick and retained after a room was previously cleaned', () => {
    const w = world({}, { rooms: { historical: emptyRoom() } });
    w.loadMemory();
    assert.equal(w.memory.rooms.historical, undefined);
    const external = { ...emptyRoom(), autoLaylout: false, developmentRemotes: { enabled: false } };
    w.memory.rooms.historical = external;
    w.game.time++;
    w.loadMemory();
    assert.equal(w.memory.rooms.historical, external);
});

test('a cleaned room can become visible and initialize all required fields before unit work', () => {
    const w = world({}, { rooms: { returning: emptyRoom() } });
    w.loadMemory();
    assert.equal(w.memory.rooms.returning, undefined);
    const room = { name: 'returning', my: false, get memory() { return w.memory.rooms.returning ||= {}; } };
    w.game.rooms.returning = room;
    w.game.time++;
    w.loadMemory();
    w.loader.load('room/initialization').initializeRooms();
    assert.deepEqual(JSON.parse(JSON.stringify(room.memory)), emptyRoom());
    w.loadMemory();
    assert.equal(w.memory.rooms.returning, room.memory, 'subsequent cleanup never touches a visible room');
});

test('native Memory is accessed afresh and never replaced with a cached heap object', () => {
    const w = world();
    let current = { rooms: { previous: emptyRoom() }, keep: true }, accesses = 0;
    Object.defineProperty(w.loader.globals, 'Memory', { get() { accesses++; return current; } });
    w.loadMemory();
    assert.equal(accesses, 1);
    assert.deepEqual(current.rooms, {});
    current = { rooms: { next: { custom: 'changed externally' } }, keep: false };
    w.game.time++;
    w.loadMemory();
    assert.equal(accesses, 2);
    assert.equal(current.rooms.next.custom, 'changed externally');
    assert.equal(current.keep, false);
});
