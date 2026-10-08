const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world() {
    let checks = 0, receiverReads = 0, sends = 0;
    class StructureLink {}
    const loader = createSourceLoader({ globals: { StructureLink, RESOURCE_ENERGY: 'energy', STRUCTURE_LINK: 'link', OK: 0 }, modules: {
        'settings/structures': { structurePolicy: { link: { edgeMargin: 3, minimumTargetFreeCapacity: 10 } } },
        'creep/development': { isDevelopingRoom() { checks++; return false; } },
        'creep/developmentLogistics': { controllerEnergyBuffer() { throw new Error('mature room'); } },
        'settings/development': { developmentPolicy: { logistics: { emergencySpawnEnergy: 300 } } },
    } });
    const Extension = loader.load('mount/structure/LinkExtension').default;
    const target = { id: 'center', store: { getFreeCapacity: () => 800 } };
    const link = new Extension();
    Object.assign(link, { id: 'source', cooldown: 0, pos: { x: 48, y: 10 },
        store: { energy: 0, getFreeCapacity: () => 0 },
        transferEnergy(receiver) { assert.equal(receiver, target); sends++; return 0; },
        room: { get centerLink() { receiverReads++; return target; }, get controllerLink() { receiverReads++; return undefined; } } });
    return { link, checks: () => checks, receiverReads: () => receiverReads, sends: () => sends };
}

test('empty and cooling source links avoid receiver lookup and failed native transfer, and send immediately when ready', () => {
    const w = world();
    for (let i = 0; i < 20; i++) w.link.doWork();
    assert.equal(w.checks(), 0); assert.equal(w.receiverReads(), 0); assert.equal(w.sends(), 0);
    w.link.store.energy = 800; w.link.cooldown = 2;
    for (let i = 0; i < 20; i++) w.link.doWork();
    assert.equal(w.checks(), 0); assert.equal(w.receiverReads(), 0); assert.equal(w.sends(), 0);
    w.link.cooldown = 0;
    w.link.doWork();
    assert.equal(w.checks(), 1); assert.equal(w.receiverReads(), 2); assert.equal(w.sends(), 1);
});

test('ready interior links retain full-buffer batching', () => {
    const w = world();
    w.link.pos.x = 20; w.link.store.energy = 300;
    w.link.store.getFreeCapacity = () => 500;
    w.link.doWork(); assert.equal(w.sends(), 0);
    w.link.store.energy = 800; w.link.store.getFreeCapacity = () => 0;
    w.link.doWork(); assert.equal(w.sends(), 1);
});
