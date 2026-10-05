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
    const store = (energy, capacity) => ({ energy, getFreeCapacity: () => capacity-energy, getUsedCapacity: () => energy, getCapacity: () => capacity });
    function structure(id, type, x, y, energy = 0, capacity = 1000) {
        const object = { id, structureType: type, my: true, store: store(energy, capacity), room, pos: new Position(x,y) };
        objects.set(id, object);
        const list = { spawn: 'spawns', extension: 'extensions', tower: 'towers', lab: 'labs', link: 'links', container: 'containers' }[type];
        if(list)room[list].push(object);else room[type === 'powerSpawn' ? 'powerSpawn' : type] = object;
        return object;
    }
    const game = { time: 100, shard: { name: 'shard1' }, flags: {}, creeps: {}, getObjectById: id => objects.get(id) };
    const loader = createSourceLoader({ globals: { Game: game, RESOURCE_ENERGY: 'energy', STRUCTURE_LINK: 'link',
        FIND_MY_CREEPS: 'my-creeps', ERR_NOT_IN_RANGE: -9, OK: 0 }, modules: {
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
