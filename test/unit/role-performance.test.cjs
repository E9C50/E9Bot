const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world(roleName, data = {}) {
    const objects = new Map(), actions = [];
    const reads = { lookups: [], lists: {}, entries: {}, distances: 0, methods: 0, energy: {}, free: {} };
    const game = { time:1, shard:{name:'shard3'}, rooms:{}, getObjectById(id) { reads.lookups.push(id); return objects.get(id) || null; } };
    const memory = { warMode: {} };
    const lists = { wallsNeedRepair: [], constructionSites: [], links: [], containers: [], extensions: [], spawns: [] };
    const room = { name: 'W1N1', level: 6, memory: { roomFillJob: {}, fastUpgrade:false }, sources:[], structures:[],
        getTerrain:()=>({get:()=>0}),
        find(type){if(type==='minerals') return [];throw new Error('unexpected native scan '+type);},
        lookForAt(type,x,y){return (type==='structures'?room.structures:[creep]).filter(value=>value.pos.x===x&&value.pos.y===y);},
        getDefenderCostMatrix: () => ({ get: () => 0 }),
        createConstructionSite(x, y, type) { actions.push({ type: 'create', x, y, structureType: type }); return 0; } };
    for (const name of Object.keys(lists)) Object.defineProperty(room, name, { get() {
        reads.lists[name] = (reads.lists[name] || 0) + 1; return lists[name];
    } });
    const distance = (first, second) => { reads.distances++; return Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y)); };
    class Position {
        constructor(x,y,roomName=room.name){Object.assign(this,{x,y,roomName});}
        getRangeTo(value){const p=value.pos||value;return p.roomName===this.roomName?Math.max(Math.abs(this.x-p.x),Math.abs(this.y-p.y)):Infinity;}
        isNearTo(value){return this.getRangeTo(value)<=1;}
        inRangeTo(value,range){return this.getRangeTo(value)<=range;}
        isEqualTo(value){return this.getRangeTo(value)===0;}
    }
    const position=(x,y,roomName=room.name)=>new Position(x,y,roomName);
    const creep = { id:'worker-original', name: 'worker', pos: position(10, 10), room,
        body:[{type:'work',hits:100},{type:'carry',hits:100},{type:'carry',hits:100},{type:'move',hits:100}],hits:400,hitsMax:400,
        getActiveBodyparts:part=>creep.body.filter(item=>item.type===part&&item.hits>0).length,
        store: { energy: 50, getCapacity:()=>100, getFreeCapacity: () => 100-creep.store.energy, getUsedCapacity: () => creep.store.energy },
        memory: { data, working: true },
        moveTo(target) { actions.push({ type: 'move', id: target.id }); return 0; },
        say(message) { actions.push({ type: 'say', message }); }, goBoost: () => true,
        pickupDroppedResource() { return false; },
        takeFromTarget(target, resource) { actions.push({ type: 'take', id: target.id, resource }); return true; },
        transferToTarget(target, resource) {
            actions.push({ type: 'fill', id: target.id, resource });
            return distance(creep.pos, target.pos) <= 1;
        },
    };
    creep.pos.isNearTo = target => distance(creep.pos, target.pos || target) <= 1;
    for (const action of ['repair', 'build', 'transfer', 'withdraw', 'harvest']) creep[action] = (target, resource) => {
        actions.push({ type: action, id: target.id, ...(resource ? { resource } : {}) }); return 0;
    };
    if(roleName==='harvester') {
        const source={id:data.sourceId||'source',pos:position(10,9),room,energy:3000};objects.set(source.id,source);room.sources=[source];
    }
    game.rooms[room.name]=room;
    const loader = createSourceLoader({ globals: { Game: game, Memory: memory, RoomPosition:Position, RESOURCE_ENERGY: 'energy',
        STRUCTURE_CONTAINER: 'container', STRUCTURE_LINK: 'link', STRUCTURE_ROAD:'road', STRUCTURE_RAMPART:'rampart',
        LOOK_STRUCTURES:'structures',LOOK_CREEPS:'creeps',FIND_MINERALS:'minerals',TERRAIN_MASK_WALL:1,
        WORK:'work',HARVEST_POWER:2,CONTAINER_DECAY:5000,CREEP_LIFE_TIME:1500, ERR_NOT_IN_RANGE: -9 }, modules: {
        'creep/boosting': { getActiveRoomBoostRequests: () => [] },
        'runtime/creepIndex': { getRoomProcessors: () => [] },
        utils: { getDistance: distance, getClosestTarget() { throw new Error('Candidate filtering and closest selection must be one pass'); } },
        './RoleBaseUpgrader': () => ({ target() { actions.push({ type: 'upgrade' }); return true; } }),
    } });
    const names = { repairer: 'Repairer', harvester: 'Harvester', filler: 'Filler' };
    const role = loader.load(`role/base/RoleBase${names[roleName]}`).default(data);
    function structure(id, { x = 10, y = 10, energy = 0, capacity = 100, hits = 50, hitsMax = 100, type = 'container', ...extra } = {}) {
        const state = { energy, capacity };
        const store = {
            getFreeCapacity() { reads.free[id] = (reads.free[id] || 0) + 1; return state.capacity - state.energy; },
            getUsedCapacity() { return state.energy; },
        };
        Object.defineProperty(store, 'energy', { enumerable: true, get() { reads.energy[id] = (reads.energy[id] || 0) + 1; return state.energy; } });
        const value = { id, pos: position(x, y), store, hits, hitsMax, structureType: type, ...extra };
        objects.set(id, value); room.structures.push(value); return Object.assign(value, { state });
    }
    function site(id, x = 10, y = 10) {
        const value = { id, pos: position(x, y), my: true };
        objects.set(id, value); return value;
    }
    function list(name, entries) {
        lists[name] = new Proxy(entries, { get(target, key, receiver) {
            if (['filter', 'sort', 'map'].includes(key)) return () => {
                reads.methods++; throw new Error(`${name}.${key} allocates or sorts hot candidates`);
            };
            if (typeof key === 'string' && /^\d+$/.test(key)) reads.entries[name] = (reads.entries[name] || 0) + 1;
            return Reflect.get(target, key, receiver);
        } });
        return lists[name];
    }
    return { role, data, creep, room, game, memory, objects, actions, reads, structure, site, list, position };
}

test('repairer immediately repairs the newly selected weakest wall, keeps equal-hit order and never sorts the shared room list', () => {
    const w = world('repairer', { repairTarget: 'gone' });
    const original = [w.structure('strong', { hits: 80 }), w.structure('weak-first', { hits: 20 }), w.structure('weak-second', { hits: 20 })];
    w.list('wallsNeedRepair', original);
    assert.equal(w.role.target(w.creep), true);
    assert.equal(w.data.repairTarget, 'weak-first');
    assert.deepEqual(w.actions, [{ type: 'repair', id: 'weak-first' }]);
    assert.equal(w.reads.entries.wallsNeedRepair, original.length);
    assert.deepEqual(original.map(target => target.id), ['strong', 'weak-first', 'weak-second']);
    assert.equal(w.reads.methods, 0);
});

test('repairer replaces a full cached wall and skips currently full candidates instead of repairing the old wall again', () => {
    const w = world('repairer', { repairTarget: 'full' });
    const full = w.structure('full', { hits: 100 });
    w.list('wallsNeedRepair', [full, w.structure('needs-repair', { hits: 60 })]);
    w.role.target(w.creep);
    assert.deepEqual(w.actions, [{ type: 'repair', id: 'needs-repair' }]);
    assert.equal(w.data.repairTarget, 'needs-repair');
});

test('repairer reuses a living cached target without reading or scanning the room wall candidates', () => {
    const w = world('repairer', { repairTarget: 'cached' }); w.structure('cached');
    w.role.target(w.creep); w.role.target(w.creep);
    assert.equal(w.reads.lists.wallsNeedRepair || 0, 0);
    assert.deepEqual(w.reads.lookups, ['cached', 'cached']);
    assert.deepEqual(w.actions.map(action => action.type), ['repair', 'repair']);
});

test('war repairer chooses the weakest reachable wall in one pass and waits if every wall is blocked or full', () => {
    const w = world('repairer', {}); w.memory.warMode.W1N1 = true;
    const blocked = w.structure('blocked', { x: 9, hits: 5 }), reachable = w.structure('reachable', { x: 11, hits: 10 });
    w.list('wallsNeedRepair', [blocked, reachable]);
    w.room.getDefenderCostMatrix = () => ({ get: x => x === 9 ? 255 : 0 });
    w.role.target(w.creep); assert.equal(w.data.repairTarget, 'reachable'); assert.equal(w.actions[0].id, 'reachable');
    reachable.hits = reachable.hitsMax; w.role.target(w.creep);
    assert.deepEqual(w.actions, [{ type: 'repair', id: 'reachable' }]); assert.equal(w.data.repairTarget, '');
});

test('harvester validates its ready Source once per phase and safely resets missing or out-of-range Sources', () => {
    const w = world('harvester', { sourceId: 'source' }); w.creep.memory.ready = true;
    assert.equal(w.role.prepare(w.creep), true); assert.deepEqual(w.reads.lookups,['source']);
    w.objects.delete('source');
    assert.equal(w.role.source(w.creep), false); assert.equal(w.creep.memory.ready, false);
    assert.equal(w.role.prepare(w.creep), false);
    const source = { id: 'source', pos: w.position(11, 10), energy: 3000 }; w.objects.set(source.id, source);
    assert.equal(w.role.prepare(w.creep), true); assert.equal(w.creep.memory.ready, true);
    w.creep.harvest = () => -9; assert.equal(w.role.source(w.creep), true); assert.equal(w.creep.memory.ready, false);
});

test('harvester without a usable Source Link selects the closest construction site in one scan and retains first-site ties', () => {
    const w = world('harvester', { sourceId: 'source', buildTarget: 'second' });
    const sites = [w.site('too-far', 14), w.site('first', 12), w.site('second', 10, 12), w.site('third', 13)];
    w.list('constructionSites', sites); w.list('links', [w.structure('unrelated-link',{type:'link',x:30})]);
    w.role.target(w.creep);
    assert.equal(w.data.buildTarget, 'first'); assert.deepEqual(w.actions, [{ type: 'build', id: 'first' }]);
    assert.equal(w.reads.entries.constructionSites, sites.length); assert.equal(w.reads.entries.links || 0,0,'missing central Link bypasses the Source Link candidate scan');
    assert.equal(w.reads.methods, 0);
});

test('harvester can reuse its cached construction site underfoot without scanning room sites but reselects a new closer site otherwise', () => {
    const w = world('harvester', { sourceId: 'source', buildTarget: 'underfoot' }); w.site('underfoot');
    w.role.target(w.creep); assert.equal(w.reads.lists.constructionSites || 0, 0);
    assert.equal(w.actions[0].id, 'underfoot');
    const old = w.site('old-near', 12); w.data.buildTarget = old.id;
    w.list('constructionSites', [old, w.site('new-underfoot')]); w.role.target(w.creep);
    assert.equal(w.actions.at(-1).id, 'new-underfoot');
});

test('completed cached construction invalidates the room cache before normal Container delivery without a Source Link',()=>{
    const w=world('harvester',{sourceId:'source',buildTarget:'finished'});w.list('constructionSites',[]);
    w.list('containers',[w.structure('container',{energy:50,hits:100})]);w.role.target(w.creep);
    assert.equal(w.data.buildTarget,undefined);assert.equal(w.room.memory.needUpdateCache,true);
    assert.deepEqual(w.actions,[{type:'transfer',id:'container',resource:'energy'}]);
});

test('a full Source Link with a central receiver retains cargo and ignores Container fallback even when a second Link has capacity',()=>{
    const w=world('harvester',{sourceId:'source'});w.creep.store.energy=100;
    const first=w.structure('first-link',{type:'link',x:11,y:10,energy:100,my:true,isActive:()=>true});
    const second=w.structure('second-link',{type:'link',x:12,y:10,my:true,isActive:()=>true});
    const center=w.structure('center-link',{type:'link',x:30,y:30,my:true,isActive:()=>true});w.room.centerLink=center;
    w.list('links',[first,second,center]);w.list('containers',[w.structure('container',{energy:50,hits:30})]);
    w.list('constructionSites',[w.site('source-container',10,10)]);
    assert.equal(w.role.prepare(w.creep),true);assert.equal(w.role.target(w.creep),true);assert.deepEqual(w.actions,[]);
    assert.equal(w.creep.store.energy,100);assert.equal(w.creep.memory.working,false);
    assert.equal(w.reads.entries.links,3,'one room index is shared by preparation and work');
    assert.equal(w.reads.lists.containers||0,0);assert.equal(w.reads.lists.constructionSites||0,0);
    first.state.energy=0;w.role.source(w.creep);
    assert.deepEqual(w.actions,[{type:'transfer',id:'first-link',resource:'energy'}]);
    assert.equal(w.creep.store.energy,100,'a native transfer intent does not immediately free Store capacity');
    assert.equal(w.reads.methods,0);
});

test('harvester selects the lowest current-energy adjacent container in one pass and repairs it before transferring', () => {
    const w = world('harvester', { sourceId: 'source' });
    const first = w.structure('first', { energy: 40, hits: 100 }), lowest = w.structure('lowest', { energy: 10, hits: 30 });
    const tied = w.structure('tied', { energy: 10 }), far = w.structure('far', { energy: 0, x: 20 });
    w.list('containers', [first, lowest, tied, far]); w.role.target(w.creep);
    assert.deepEqual(w.actions, [{ type: 'repair', id: 'lowest' }]);
    assert.equal(w.reads.entries.containers, 4); assert.equal(w.reads.energy.first, 1); assert.equal(w.reads.energy.lowest, 1);
    assert.equal(w.reads.energy.tied, 1); assert.equal(w.reads.energy.far || 0, 0);
    lowest.hits = lowest.hitsMax; lowest.state.energy = 90; first.state.energy = 5;
    w.role.target(w.creep);
    assert.equal(w.actions.at(-1).id, 'first'); assert.equal(w.actions.at(-1).type, 'transfer');
});

test('harvester keeps creating a missing Container beside an isolated Source Link until a central receiver exists', () => {
    const w = world('harvester', { sourceId: 'source' }); w.role.target(w.creep);
    assert.deepEqual(w.actions, [{ type: 'create', x: 10, y: 10, structureType: 'container' }]);
    w.actions.length = 0; w.room.level = 8; w.role.target(w.creep); assert.deepEqual(w.actions, []);
    w.room.level = 6; w.creep.store.energy=100;
    const link=w.structure('full-link', { type:'link',x:11,y:10,energy:100,my:true,isActive:()=>true });
    w.list('links',[link]);w.game.time++;w.role.target(w.creep);
    assert.deepEqual(w.actions,[{type:'create',x:10,y:10,structureType:'container'}]);w.actions.length=0;
    const center=w.structure('center-link',{type:'link',x:30,y:30,my:true,isActive:()=>true});w.room.centerLink=center;
    w.list('links',[link,center]);w.game.time++;w.role.target(w.creep);
    assert.deepEqual(w.actions, []);
});

test('filler chooses available Storage before resolving a cached source, loose energy or scanning closer mine stock', () => {
    const w = world('filler', { sourceId: 'container' });
    w.list('containers', [w.structure('empty', { energy: 0 }), w.structure('container', { energy: 50, x: 12 })]);
    w.list('links', [w.structure('link', { type: 'link', energy: 50, x: 8 })]);
    w.room.storage = w.structure('storage', { type: 'storage', energy: 1, x: 30, y: 30 });
    w.room.terminal = w.structure('terminal', { type: 'terminal', energy: 50, x: 10, y: 8 });
    w.creep.pickupDroppedResource = () => { throw new Error('Usable Storage must precede loose-energy collection'); };
    assert.equal(w.role.source(w.creep), true); assert.equal(w.data.sourceId, 'storage');
    assert.deepEqual(w.actions, [{ type: 'take', id: 'storage', resource: 'energy' }]);
    assert.deepEqual(w.reads.lookups, []);
    assert.equal(w.reads.lists.containers || 0, 0); assert.equal(w.reads.lists.links || 0, 0);
    assert.deepEqual(w.reads.energy, { storage: 1 });
    assert.equal(w.reads.distances, 0); assert.equal(w.reads.methods, 0);
});

test('without Storage filler source selection scans each fallback list once and retains container-link-terminal closest ties', () => {
    const w = world('filler', { sourceId: 'gone' });
    w.list('containers', [w.structure('empty', { energy: 0 }), w.structure('container', { energy: 50, x: 12 })]);
    w.list('links', [w.structure('link', { type: 'link', energy: 50, x: 8 })]);
    w.room.terminal = w.structure('terminal', { type: 'terminal', energy: 50, x: 10, y: 8 });
    assert.equal(w.role.source(w.creep), true); assert.equal(w.data.sourceId, 'container');
    assert.deepEqual(w.actions, [{ type: 'take', id: 'container', resource: 'energy' }]);
    assert.equal(w.reads.lists.containers, 1); assert.equal(w.reads.lists.links, 1);
    assert.equal(w.reads.entries.containers, 2); assert.equal(w.reads.entries.links, 1);
    assert.equal(w.reads.energy.container, 2, 'one candidate read plus the final selected-source validity check');
    assert.equal(w.reads.energy.link, 1); assert.equal(w.reads.energy.empty, 1); assert.equal(w.reads.energy.terminal, 1);
    assert.equal(w.reads.distances, 3);
    assert.equal(w.reads.methods, 0);
});

test('without Storage filler reuses a nonempty cached source and short-circuits full capacity or dropped-resource pickup before resolving it', () => {
    const w = world('filler', { sourceId: 'cached' }); const source = w.structure('cached', { energy: 50 });
    w.role.source(w.creep); assert.deepEqual(w.reads.lookups, ['cached']); assert.equal(w.reads.lists.containers || 0, 0);
    source.state.energy = 0; w.list('links', [w.structure('replacement', { energy: 20 })]);
    w.role.source(w.creep); assert.equal(w.data.sourceId, 'replacement');
    const before = w.reads.lookups.length; w.creep.store.getFreeCapacity = () => 0;
    assert.equal(w.role.source(w.creep), false); assert.equal(w.creep.memory.working, true); assert.equal(w.reads.lookups.length, before);
    w.creep.store.getFreeCapacity = () => 50; w.creep.pickupDroppedResource = () => true;
    assert.equal(w.role.source(w.creep), true); assert.equal(w.reads.lookups.length, before);
});

test('filler resolves each lab job once, removes missing/full jobs, keeps nearest ties and gives labs priority over extensions', () => {
    const w = world('filler', { sourceId: 'storage' });
    w.structure('full', { energy: 100 }); w.structure('lab-first', { x: 15 }); w.structure('lab-second', { y: 15 });
    const jobs = w.room.memory.roomFillJob; jobs.labInEnergy = ['gone', 'full', 'lab-first', 'lab-second']; jobs.extension = true;
    w.role.target(w.creep);
    assert.deepEqual(w.reads.lookups, ['gone', 'full', 'lab-first', 'lab-second']);
    assert.deepEqual(jobs.labInEnergy, ['lab-first', 'lab-second']);
    assert.equal(w.actions[0].id, 'lab-first'); assert.equal(w.reads.lists.extensions || 0, 0);
});

test('stale lab/tower jobs safely fall through to a usable lower-priority target without transferring to null or a full store', () => {
    const w = world('filler', { sourceId: 'storage' });
    const jobs = w.room.memory.roomFillJob; jobs.labInEnergy = ['gone-lab']; jobs.tower = ['gone-tower', 'full-tower']; jobs.nukerEnergy = true;
    w.structure('full-tower', { energy: 100 }); w.room.nuker = w.structure('nuker');
    assert.doesNotThrow(() => w.role.target(w.creep));
    assert.deepEqual(jobs.labInEnergy, []); assert.deepEqual(jobs.tower, []);
    assert.deepEqual(w.actions, [{ type: 'fill', id: 'nuker', resource: 'energy' }]);
});

test('filler reselects vanished or full cached extensions and avoids full extension scans while a valid cached target is pending', () => {
    const w = world('filler', { sourceId: 'storage', targetId: 'full' }); w.room.memory.roomFillJob.extension = true;
    const full = w.structure('full', { energy: 100 }), first = w.structure('extension', { x: 15 }), spawn = w.structure('spawn', { y: 15 });
    w.list('extensions', [full, first]); w.list('spawns', [spawn]); w.role.target(w.creep);
    assert.equal(w.data.targetId, 'extension'); assert.equal(w.actions[0].id, 'extension');
    const before = w.reads.lists.extensions; w.role.target(w.creep);
    assert.equal(w.reads.lists.extensions, before); assert.equal(w.actions.at(-1).id, 'extension');
    w.objects.delete('extension'); w.list('extensions', [full]); w.role.target(w.creep);
    assert.equal(w.data.targetId, 'spawn'); assert.equal(w.actions.at(-1).id, 'spawn');
});

test('filler tower jobs perform one lookup per id and choose an unfilled tower instead of getting stuck on a full closer one', () => {
    const w = world('filler', { sourceId: 'storage' });
    w.structure('full', { energy: 100 }); w.structure('tower', { x: 15 });
    w.room.memory.roomFillJob.tower = ['gone', 'full', 'tower']; w.role.target(w.creep);
    assert.deepEqual(w.reads.lookups, ['gone', 'full', 'tower']);
    assert.equal(w.actions[0].id, 'tower'); assert.deepEqual(w.room.memory.roomFillJob.tower, ['tower']);
});

test('filler does not predict Store changes after transfer intents and can idle without a Spawn', () => {
    const w = world('filler', { sourceId: 'storage' }); const tower = w.structure('tower');
    w.room.memory.roomFillJob.tower = ['tower']; w.role.target(w.creep);
    assert.equal(tower.state.energy, 0, 'a successful helper return does not synchronously fill the game Store');
    assert.equal(w.room.memory.roomFillJob.tower.length, 0);
    w.actions.length = 0; assert.doesNotThrow(() => w.role.target(w.creep));
    assert.deepEqual(w.actions, [{ type: 'say', message: '💤' }]);
});

test('filler unloads carried minerals before energy jobs even when energy is the first enumerable Store key', () => {
    const w = world('filler', { sourceId: 'storage' });
    w.room.storage = w.structure('storage'); w.creep.store.H = 5; w.creep.store.getUsedCapacity = () => 55;
    w.room.memory.roomFillJob.extension = true; w.role.target(w.creep);
    assert.deepEqual(w.actions, [{ type: 'fill', id: 'storage', resource: 'H' }]);
    assert.equal(w.reads.lists.extensions || 0, 0);
});
