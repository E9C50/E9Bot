const assert = require('node:assert/strict');
const test = require('node:test');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world(level = 6) {
    const objects = new Map(), calls = [];
    class Position {
        constructor(x, y, roomName = 'E39N5') { Object.assign(this, { x, y, roomName }); }
        inRangeTo(other, limit) { const p = other.pos || other; return this.roomName === p.roomName && Math.max(Math.abs(this.x-p.x), Math.abs(this.y-p.y)) <= limit; }
    }
    const room = { name: 'E39N5', my: true, controller: { level, my: true, pos: new Position(10, 25) },
        spawns: [], extensions: [], towers: [], labs: [], links: [], containers: [], sources: [], workers: [],
        memory: {}, find() { return this.workers; } };
    const store = (energy, capacity) => {
        const value = { energy, getFreeCapacity: () => capacity-value.energy, getUsedCapacity: () => value.energy, getCapacity: () => capacity };
        return value;
    };
    function structure(id, type, x, y, energy = 0, capacity = 1000) {
        const object = { id, structureType: type, my: true, store: store(energy, capacity), room, pos: new Position(x,y) };
        objects.set(id, object);
        const list = { spawn: 'spawns', extension: 'extensions', tower: 'towers', lab: 'labs', link: 'links', container: 'containers' }[type];
        if(list)room[list].push(object);else room[type === 'powerSpawn' ? 'powerSpawn' : type] = object;
        return object;
    }
    const game = { time: 100, shard: { name: 'shard1' }, rooms: { [room.name]: room }, flags: {}, creeps: {}, getObjectById: id => objects.get(id) };
    const loader = createSourceLoader({ globals: { Game: game, RESOURCE_ENERGY: 'energy', STRUCTURE_LINK: 'link',
        STRUCTURE_SPAWN: 'spawn', FIND_MY_CREEPS: 'my-creeps', ERR_NOT_IN_RANGE: -9, OK: 0 }, modules: {
            utils: { getClosestTarget: (p, list) => list[0], getDistance: (p,q) => p.roomName === q.roomName ? Math.max(Math.abs(p.x-q.x),Math.abs(p.y-q.y)) : Infinity },
            'role/support/towers': { supportWithTowers() {} },
        } });
    const api = loader.load('creep/haulerDelivery');
    const remote = loader.load('role/adv/RoleAdvRemoteFiller').default;
    function unit(name, x, y, energy = 1000, capacity = 1000) {
        const creep = { name, id: name, room, pos: new Position(x,y), memory: { role: 'rFiller', working: true }, store: store(energy,capacity),
            transfer(target, resource, amount) { calls.push({ type:'transfer', unit:name, target:target.id, resource, amount }); return this.pos.inRangeTo(target,1) ? 0 : -9; },
            moveTo(target, opts) { calls.push({ type:'move', unit:name, target:target.id, pos:target.pos||target, opts }); return 0; },
            say() {}, hits: 100, hitsMax: 100 };
        return creep;
    }
    return { ...api, loader, remote, structure, unit, calls, room, game, Position, store, objects };
}

test('a returning hauler chooses Storage over a nearer empty Link or distant production deficit', () => {
    const w = world(), storage = w.structure('storage','storage',25,25,0,10000);
    w.structure('controllerLink','link',10,24); w.structure('spawn','spawn',20,20,0,300);
    w.deliverHaulerEnergy(w.unit('import',10,23));
    assert.equal(w.calls.find(c=>c.type==='move').target, storage.id);
    assert.ok(w.calls.every(c=>c.target!=='controllerLink'&&c.target!=='spawn'));
});

test('already adjacent waypoints fill without a detour and remaining energy keeps moving toward Storage', () => {
    const w = world(), storage = w.structure('storage','storage',25,25,0,10000), extension = w.structure('extension','extension',12,12,0,50);
    w.deliverHaulerEnergy(w.unit('import',11,11));
    assert.deepEqual(w.calls.map(c=>[c.type,c.target,c.amount]),[['transfer',extension.id,50],['move',storage.id,undefined]]);
});

test('an adjacent Storage finishes the import even when a production waypoint is also adjacent', () => {
    const w=world(), storage=w.structure('storage','storage',12,12,0,10000);
    w.structure('extension','extension',10,12,0,50);w.deliverHaulerEnergy(w.unit('import',11,11));
    assert.deepEqual(w.calls.map(c=>c.target),[storage.id]);
});

test('same-tick reservations cannot overfill Storage or choose a Link for the next carrier', () => {
    const w=world(), storage=w.structure('storage','storage',12,12,9800,10000), extension=w.structure('extension','extension',10,12,0,50);
    w.structure('link','link',12,10);
    w.deliverHaulerEnergy(w.unit('a',11,11,200));w.deliverHaulerEnergy(w.unit('b',11,11,200));
    assert.deepEqual(w.calls.filter(c=>c.type==='transfer').map(c=>[c.target,c.amount]),[[storage.id,200],[extension.id,50]]);
    w.game.time++;w.calls.length=0;w.deliverHaulerEnergy(w.unit('c',11,11,200));
    assert.equal(w.calls[0].target,storage.id);
});

test('without Storage carriers supply a controller Container or worker, never the controller Link', () => {
    const w=world(), buffer=w.structure('container','container',12,25), link=w.structure('link','link',10,24);
    w.deliverHaulerEnergy(w.unit('a',11,24));assert.equal(w.calls[0].target,buffer.id);
    w.room.containers=[];w.calls.length=0;
    const worker=w.unit('upgrader',12,25,0,100);worker.memory.role='upgrader';w.room.workers.push(worker);
    w.deliverHaulerEnergy(w.unit('b',11,24));assert.equal(w.calls[0].target,worker.id);
    assert.ok(w.calls.every(c=>c.target!==link.id));
});

test('full or inactive Storage retains non-Link delivery fallbacks', () => {
    for(const inactive of [false,true]) {
        const w=world(), storage=w.structure('storage','storage',25,25,inactive?0:10000,10000), tower=w.structure('tower','tower',12,12);
        if(inactive)storage.isActive=()=>false;
        w.structure('link','link',10,12);w.deliverHaulerEnergy(w.unit('a',11,11));assert.equal(w.calls[0].target,tower.id);
    }
});

test('multiple carriers skip full targets, share activation checks and reserve the exact remaining capacity', () => {
    const w = world();
    for (let index = 0; index < 60; index++) {
        const extension = w.structure(`full-${index}`, 'extension', 11, 12, 50, 50);
        extension.isActive = () => { throw Error('full targets must not perform an activation scan'); };
    }
    const tower = w.structure('tower', 'tower', 12, 12, 0, 250);
    let activationChecks = 0;
    tower.isActive = () => { activationChecks++; return true; };
    assert.equal(w.deliverHaulerEnergy(w.unit('a', 11, 11, 150)), true);
    assert.equal(w.deliverHaulerEnergy(w.unit('b', 11, 11, 150)), true);
    assert.equal(w.deliverHaulerEnergy(w.unit('c', 11, 11, 150)), false);
    assert.deepEqual(w.calls.filter(call => call.type === 'transfer').map(call => [call.unit, call.target, call.amount]),
        [['a', tower.id, 150], ['b', tower.id, 100]]);
    assert.equal(activationChecks, 1, 'one live structure activation check serves selection and final amount for all carriers');
});

test('activation cache refreshes on the next tick and a shard change without caching capacity', () => {
    const w = world(), storage = w.structure('storage', 'storage', 12, 12, 0, 1000);
    let active = true, activationChecks = 0;
    storage.isActive = () => { activationChecks++; return active; };
    assert.equal(w.deliverHaulerEnergy(w.unit('a', 11, 11, 100)), true);
    storage.store.energy = 1000;
    assert.equal(w.deliverHaulerEnergy(w.unit('full', 11, 11, 100)), false,
        'a live full store is rejected even though its activation result is cached');
    assert.equal(activationChecks, 1);
    storage.store.energy = 0;
    active = false; w.game.time++;
    assert.equal(w.deliverHaulerEnergy(w.unit('downgraded', 11, 11, 100)), false);
    assert.equal(activationChecks, 2, 'a next-tick controller downgrade disables the receiver immediately');
    active = true; w.game.shard.name = 'shard3';
    assert.equal(w.deliverHaulerEnergy(w.unit('other-shard', 11, 11, 100)), true);
    assert.equal(activationChecks, 3);
    active = false; w.game.time--;
    assert.equal(w.deliverHaulerEnergy(w.unit('rewound', 11, 11, 100)), false);
    assert.equal(activationChecks, 4, 'a replay/time rollback also discards old activation results');
});

test('a replacement receiver with the same ID uses its own activation result', () => {
    const w = world(), oldStorage = w.structure('storage', 'storage', 12, 12, 0, 1000);
    let oldChecks = 0, replacementChecks = 0;
    oldStorage.isActive = () => { oldChecks++; return false; };
    assert.equal(w.deliverHaulerEnergy(w.unit('before', 11, 11, 100)), false);
    const replacement = w.structure(oldStorage.id, 'storage', 12, 12, 0, 1000);
    replacement.isActive = () => { replacementChecks++; return true; };
    assert.equal(w.deliverHaulerEnergy(w.unit('after', 11, 11, 100)), true);
    assert.equal(oldChecks, 1); assert.equal(replacementChecks, 1);
    assert.equal(w.calls[0].target, replacement.id);
});

test('manual remote filler uses the same import rules and unloads its real mineral instead of energy first', () => {
    const w=world(8), storage=w.structure('storage','storage',12,12,0,10000);
    w.structure('link','link',12,10);w.game.flags.delivery={pos:storage.pos};
    const behavior=w.remote({sourceFlag:'source',targetFlag:'delivery'}), creep=w.unit('manual',11,11,100);
    behavior.target(creep);assert.equal(w.calls[0].target,storage.id);
    w.calls.length=0;creep.store.H=10;creep.store.getUsedCapacity=()=>110;
    behavior.target(creep);assert.equal(w.calls[0].resource,'H');
    w.calls.length=0;creep.pos=new w.Position(5,5);creep.memory.dontPullMe=true;
    const move=creep.moveTo;
    creep.moveTo=function(...args){this.memory.dontPullMe=true;return move.apply(this,args);};
    behavior.target(creep);
    assert.equal(w.calls[0].target,storage.id);
    assert.equal(creep.memory.dontPullMe,false,'mineral imports also yield at depot entrances');
});

test('OUT haulers aim at home Storage on the return trip while explicit RF flags retain their destination', () => {
    const w = world(), spawn = w.structure('spawn', 'spawn', 20, 20, 0, 300);
    const storage = w.structure('storage', 'storage', 30, 30, 0, 10000);
    const creep = w.unit('out', 10, 10, 100); creep.memory.spawnRoom = w.room.name;
    creep.room = { name: 'E38N5' }; creep.pos = new w.Position(10, 10, creep.room.name);
    const behavior = w.remote({ sourceFlag: 'source', targetFlag: spawn.id });
    behavior.target(creep); assert.deepEqual(w.calls.at(-1).pos, storage.pos);
    delete w.room.storage; w.calls.length = 0;
    behavior.target(creep); assert.deepEqual(w.calls.at(-1).pos, spawn.pos);
    w.room.storage = storage; w.calls.length = 0;
    w.game.flags.delivery = { pos: new w.Position(15, 15, w.room.name) };
    w.remote({ sourceFlag: 'source', targetFlag: 'delivery' }).target(creep);
    assert.deepEqual(w.calls.at(-1).pos, w.game.flags.delivery.pos);
});

test('worker fallback is limited to the delivery room and uses no path search or global creep scan', () => {
    const w=world();const other=w.unit('other',1,1,0,100);other.room={name:'elsewhere'};other.memory.role='upgrader';
    w.room.workers.push(other);
    Object.defineProperty(w.game,'creeps',{get(){throw Error('global scan forbidden');}});
    assert.equal(w.deliverHaulerEnergy(w.unit('import',10,10)),false);assert.equal(w.calls.length,0);
});


test('delivery carriers release old and moveTo-created crossing locks while moving, unloading or idle', () => {
    const w = world();
    w.structure('storage', 'storage', 25, 25, 0, 10000);
    const carrier = w.unit('import', 10, 10);
    carrier.memory.dontPullMe = true;
    const move = carrier.moveTo;
    carrier.moveTo = function (...args) { this.memory.dontPullMe = true; return move.apply(this, args); };
    assert.equal(w.deliverHaulerEnergy(carrier), true);
    assert.equal(carrier.memory.dontPullMe, false, 'a repeated native moveTo call must not lock depot traffic');
    carrier.memory.dontPullMe = true;
    carrier.pos = new w.Position(24, 24);
    assert.equal(w.deliverHaulerEnergy(carrier), true);
    assert.equal(carrier.memory.dontPullMe, false, 'a carrier handing in cargo is not a stationary worker');
    const empty = w.unit('waiting', 24, 24, 0);
    empty.memory.dontPullMe = true;
    assert.equal(w.deliverHaulerEnergy(empty), false);
    assert.equal(empty.memory.dontPullMe, false, 'empty haulers also allow occupied depot tiles to be crossed');
});
