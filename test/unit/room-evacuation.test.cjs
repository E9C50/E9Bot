const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world() {
    const objects = new Map(), actions = [], intents = [], memory = { rooms: {}, warMode: {} };
    const game = { time: 1, shard: { name: 'shard3' }, rooms: {}, creeps: {}, powerCreeps: {}, flags: {},
        getObjectById: id => objects.get(id) || null,
        market: { outgoingTransactions: [], calcTransactionCost: value => Math.ceil(value / 10) } };
    const globals = { Game: game, Memory: memory, RESOURCE_ENERGY: 'energy', MOVE: 'move', CARRY: 'carry', WORK: 'work',
        STRUCTURE_NUKER: 'nuker', STRUCTURE_TOWER: 'tower', STRUCTURE_SPAWN: 'spawn', STRUCTURE_EXTENSION: 'extension', STRUCTURE_RAMPART: 'rampart',
        PWR_OPERATE_TERMINAL: 19, POWER_INFO: { 19: { effect: [0.9, 0.8, 0.7, 0.6, 0.5] } },
        TOP: 1, TOP_RIGHT: 2, RIGHT: 3, BOTTOM_RIGHT: 4, BOTTOM: 5, BOTTOM_LEFT: 6, LEFT: 7, TOP_LEFT: 8,
        TERRAIN_MASK_WALL: 1, LOOK_CREEPS: 'creep', LOOK_STRUCTURES: 'structure', OBSTACLE_OBJECT_TYPES: ['storage','terminal','spawn','extension'],
        OK: 0, ERR_NO_PATH: -2, ERR_INVALID_TARGET: -7,
        RoomPosition: class { constructor(x,y,roomName) { Object.assign(this,{x,y,roomName}); } } };
    const loader = createSourceLoader({ globals });
    const api = loader.load('room/evacuation'), state = loader.load('room/evacuationState');
    const policy = loader.load('settings/evacuation').evacuationPolicy;
    function store(initial = {}, capacity = 300000) {
        const result = { ...initial };
        Object.defineProperties(result, {
            getUsedCapacity: { value(resource) { return resource ? result[resource] || 0 : Object.values(result).reduce((a,b) => a+b,0); } },
            getFreeCapacity: { value() { return capacity - result.getUsedCapacity(); } },
            getCapacity: { value() { return capacity; } },
        });
        return result;
    }
    function structure(room, type, initial = {}, capacity = 1000000, id = `${room.name}:${type}:${room.structures.length}`) {
        const object = { id, my: true, room, structureType: type, pos: { x: 10, y: 10, roomName: room.name }, store: store(initial, capacity) };
        room.structures.push(object); objects.set(id,object);
        if (['spawn','extension','container','tower'].includes(type)) room[`${type}s`].push(object);
        if (['storage','terminal','factory','powerSpawn','nuker'].includes(type)) room[type] = object;
        if (type === 'terminal') {
            object.cooldown = 0;
            object.send = (resource, amount, target, description) => {
                actions.push({ action: 'send', resource, amount, target, description });
                const cost = game.market.calcTransactionCost(amount, room.name, target);
                if ((object.store.energy || 0) < cost + (resource === 'energy' ? amount : 0)) return -6;
                intents.push({ action: 'send', object, resource, amount, target, description }); return 0;
            };
        }
        return object;
    }
    function room(name, terminalInitial = {}) {
        const room = { name, my: true, controller: { my: true }, structures: [], spawns: [], extensions: [], containers: [], towers: [],
            ruins: [], tombstones: [], droppedResource: [], enemies: [],
            memory: memory.rooms[name] = { creepConfig: {}, creepSpawnQueue: [], terminalSendJob: {}, restrictedPos: {} },
            getTerrain: () => ({ get: () => 0 }), lookForAt: () => [] };
        Object.defineProperty(room,'energyAvailable',{ configurable:true,get: () => [...room.spawns,...room.extensions].filter(item=>typeof item.isActive!=='function'||item.isActive()).reduce((n,item) => n+(item.store.energy||0),0) });
        room.energyCapacityAvailable = 300;
        game.rooms[name] = room;
        structure(room,'terminal',terminalInitial,300000);
        return room;
    }
    function unit(room, name = 'carrier', role = 'filler', initial = {}, capacity = 100, ttl = 1000) {
        const creep = { name, room, ticksToLive: ttl, spawning: false, pos: { x: 10, y: 11, roomName: room.name },
            body: [{ type: 'carry', hits:100 },{ type:'move',hits:100 }], store: store(initial,capacity),
            memory: { role, spawnRoom:room.name, data: {}, dontPullMe:true },
            getActiveBodyparts: type => creep.body.filter(part => part.type===type && part.hits>0).length,
            moveTo(target) { actions.push({ action:'moveTo', name, target:target.id, room:target.roomName||target.pos.roomName }); return creep.moveCode||0; },
            move(direction) { actions.push({action:'move',name,direction}); return 0; },
            withdraw(object,resource,amount) { actions.push({action:'withdraw',name,target:object.id,resource,amount}); intents.push({action:'withdraw',creep,object,resource,amount}); return 0; },
            transfer(object,resource,amount) { actions.push({action:'transfer',name,target:object.id,resource,amount}); intents.push({action:'transfer',creep,object,resource,amount}); return 0; },
            pickup(object) { actions.push({action:'pickup',name,target:object.id}); intents.push({action:'pickup',creep,object}); return 0; },
        };
        game.creeps[name] = creep; return creep;
    }
    function tick() {
        for (const intent of intents.splice(0)) {
            const { action, creep, object } = intent;
            if (action === 'send') {
                const receiver = game.rooms[intent.target]?.terminal;
                if (!receiver) continue;
                const sent = Math.min(intent.amount, object.store[intent.resource]||0, receiver.store.getFreeCapacity());
                if (sent <= 0) continue;
                const effect = object.effects?.find(value => value.effect===19), factor = effect ? globals.POWER_INFO[19].effect[effect.level-1] : 1;
                const cost = Math.ceil(game.market.calcTransactionCost(sent)*factor);
                if ((object.store.energy||0)<cost+(intent.resource==='energy'?sent:0)) continue;
                object.store[intent.resource] -= sent; object.store.energy -= cost;
                receiver.store[intent.resource] = (receiver.store[intent.resource]||0)+sent;
                game.market.outgoingTransactions.unshift({ from:object.room.name,to:intent.target,resourceType:intent.resource,amount:sent,description:intent.description,time:game.time });
                object.cooldown = 10;
            } else if (action==='withdraw') {
                const value = Math.min(intent.amount,object.store[intent.resource]||0,creep.store.getFreeCapacity());
                object.store[intent.resource] -= value; creep.store[intent.resource]=(creep.store[intent.resource]||0)+value;
            } else if (action==='transfer') {
                const value = Math.min(intent.amount,creep.store[intent.resource]||0,object.store.getFreeCapacity());
                creep.store[intent.resource]-=value; object.store[intent.resource]=(object.store[intent.resource]||0)+value;
            } else {
                const value=Math.min(object.amount,creep.store.getFreeCapacity()); object.amount-=value;
                creep.store[object.resourceType]=(creep.store[object.resourceType]||0)+value;
            }
        }
        game.time++;
        for (const room of Object.values(game.rooms)) if (room.terminal.cooldown>0) room.terminal.cooldown--;
        for (const creep of Object.values(game.creeps)) if (!creep.spawning) creep.ticksToLive--;
    }
    const source=room('E31N2'), target=room('E34N3');
    const create=()=>api.createRoomEvacuation(source.name,target.name);
    const status=()=>JSON.parse(api.getRoomEvacuationStatus(source.name));
    function publish(room,role,logicalName,data) {
        const name='hash:'+logicalName;
        room.memory.creepConfig[name]={role,data,name:logicalName,spawnRoom:room.name,spawnPriority:2}; return name;
    }
    return {game,memory,api,state,policy,objects,actions,intents,source,target,room,structure,unit,store,tick,create,status,publish};
}

function nativeSpawnDriver(w, spawn) {
    const {globals:nativeGlobals,modules:nativeModules}=require('../helpers/native-bodies.cjs');
    const cost={carry:50,move:50,work:100,claim:600,tough:10,attack:80,ranged_attack:150,heal:250};
    const loader=createSourceLoader({globals:{...nativeGlobals,Game:w.game,Memory:w.memory,StructureSpawn:class{},BODYPART_COST:cost,BOOSTS:{},OK:0},modules:{
        ...nativeModules,role:{createRoleBehavior:()=>({isNeed:()=>true}),isRoleSupported:()=>true},
        'creep/development':{isDevelopingRoom:()=>false},'creep/developmentBodies':{getDevelopmentBody:()=>undefined,needsEmergencyBody:()=>false},
        'creep/developmentEconomy':{getDevelopmentSpawnReserve:()=>0},'creep/developmentRemotes':{isDevelopmentRemoteData:()=>false},
        'combat/spawning':{combatSpawnAllowed:()=>true,recordCombatSpawn(){}},
    }});
    const Spawn=loader.load('mount/structure/SpawnExtension').default;
    Object.setPrototypeOf(spawn,Spawn.prototype);
    let intent, birth, spent=0;
    spawn.spawnCreep=(body,name,options)=>{intent={body,name,memory:options.memory};return 0;};
    return {
        work(){Spawn.prototype.doWork.call(spawn);},
        resolve(){
            if(intent){
                const value=intent.body.reduce((total,part)=>total+cost[part],0);
                if(w.source.energyAvailable>=value){
                    let remaining=value;for(const object of [...w.source.spawns,...w.source.extensions]){const take=Math.min(remaining,object.store.energy||0);object.store.energy-=take;remaining-=take;}
                    spent+=value;const creep=w.unit(w.source,intent.name,'filler',{},intent.body.filter(part=>part==='carry').length*50);
                    creep.body=intent.body.map(type=>({type,hits:100}));creep.memory=intent.memory;creep.spawning=true;
                    spawn.spawning={name:creep.name};birth={creep,left:intent.body.length*3};
                }
                intent=undefined;
            }else if(birth&&--birth.left<=0){birth.creep.spawning=false;spawn.spawning=undefined;birth=undefined;}
        },
        get spent(){return spent;},
    };
}

test('evacuation state imports safely without a game and starts only between current-shard owned terminals',()=>{
    const state=createSourceLoader().load('room/evacuationState');
    assert.equal(state.isRoomEvacuating('E31N2'),false);
    const w=world();
    for (const input of [['E31N2','E31N2'],['shard1/E31N2','E34N3'],['E31N2','E99N99']]) assert.match(w.api.createRoomEvacuation(...input),/不能|当前 shard/);
    w.target.controller.my=false; assert.match(w.create(),/自有/);
    w.target.controller.my=true; w.create();
    const task=w.source.memory.evacuation;
    assert.match(w.create(),/已存在/); assert.equal(w.source.memory.evacuation,task);
    const third=w.room('E35N3'); assert.match(w.api.createRoomEvacuation(w.source.name,third.name),/先/);
    assert.match(w.api.createRoomEvacuation(w.target.name,third.name),/接收目标/);
    assert.match(w.api.createRoomEvacuation(third.name,w.source.name),/正在撤离/);
});

test('evacuation preserves defensive configs and suspends ordinary jobs without destroying cancel recovery',()=>{
    const w=world();
    w.source.memory.creepConfig={guard:{role:'defender'},miner:{role:'harvester'}};
    w.source.memory.creepSpawnQueue=['guard','miner'];
    const jobs=w.source.memory.terminalSendJob={old:{targetRoom:'E99N9',resourceType:'H',amount:30}};
    w.create(); assert.deepEqual(Object.keys(w.source.memory.creepConfig),['guard']); assert.deepEqual(w.source.memory.creepSpawnQueue,['guard']);
    assert.equal(w.source.memory.terminalSendJob,jobs); assert.equal(w.state.isRoomEvacuating(w.source),true);
    w.api.cancelRoomEvacuation(w.source.name); assert.equal(w.state.isRoomEvacuating(w.source),false); assert.equal(w.source.memory.terminalSendJob,jobs);
});

test('send intent is asynchronous, confirmed from actual transaction, and limited to one per source tick',()=>{
    const w=world(); Object.assign(w.source.terminal.store,{H:1000,energy:100}); w.create();
    w.api.processRoomEvacuation(w.source); w.api.processRoomEvacuation(w.source);
    assert.equal(w.actions.filter(x=>x.action==='send').length,1); assert.equal(w.source.terminal.store.H,1000);
    assert.deepEqual({...w.source.memory.evacuation.sent},{}); assert.equal(w.status().readyToUnclaim,false);
    w.tick(); w.api.processRoomEvacuation(w.source);
    assert.equal(w.source.memory.evacuation.sent.H,1000); assert.equal(w.source.memory.evacuation.energySpent,100); assert.equal(w.status().readyToUnclaim,false);
    w.tick(); w.api.processRoomEvacuation(w.source); w.tick(); w.api.processRoomEvacuation(w.source);
    assert.equal(w.status().readyToUnclaim,true); assert.equal(w.source.controller.my,true);
});

test('receiver capacity races confirm only partial shipment and retain the unsent source stock',()=>{
    const w=world(); Object.assign(w.source.terminal.store,{H:1000,energy:100}); w.create(); w.api.processRoomEvacuation(w.source);
    w.target.terminal.store.energy=299950; w.tick(); w.api.processRoomEvacuation(w.source);
    assert.equal(w.source.memory.evacuation.sent.H,50); assert.equal(w.source.terminal.store.H,950); assert.equal(w.source.memory.evacuation.energySpent,5);
    assert.equal(w.status().readyToUnclaim,false); assert.match(w.status().message,/容量不足/);
});

test('accepted send with no transaction is not counted or completed when the target becomes full',()=>{
    const w=world(); Object.assign(w.source.terminal.store,{H:1000,energy:100}); w.create(); w.api.processRoomEvacuation(w.source);
    w.target.terminal.store.energy=300000; w.tick(); w.api.processRoomEvacuation(w.source);
    assert.deepEqual({...w.source.memory.evacuation.sent},{}); assert.equal(w.source.terminal.store.H,1000); assert.equal(w.status().readyToUnclaim,false);
    assert.match(w.status().message,/交易记录/);
});

test('nonenergy sends need exact undiscounted API fee while confirmed fees use the operate-terminal multiplier',()=>{
    const w=world(); Object.assign(w.source.terminal.store,{H:1000,energy:50}); w.source.terminal.effects=[{effect:19,level:5,ticksRemaining:100}];
    w.create(); w.api.processRoomEvacuation(w.source);
    assert.equal(w.actions.find(x=>x.action==='send').amount,500); w.tick(); w.api.processRoomEvacuation(w.source);
    assert.equal(w.source.memory.evacuation.sent.H,500); assert.equal(w.source.memory.evacuation.energySpent,25); assert.equal(w.source.terminal.store.energy,25);
});

test('energy waits for uncollected nonenergy and sends its last affordable batch with fee included',()=>{
    const w=world(); w.source.terminal.store.energy=100; w.structure(w.source,'factory',{H:10}); const worker=w.unit(w.source);
    w.create(); w.api.processRoomEvacuation(w.source); assert.equal(w.actions.some(x=>x.action==='send'),false);
    w.api.runRoomEvacuationCreep(worker); assert.equal(w.actions.find(x=>x.action==='withdraw').resource,'H');
    w.tick(); w.api.runRoomEvacuationCreep(worker); w.tick(); w.api.processRoomEvacuation(w.source); w.tick();
    w.source.terminal.cooldown=0; w.api.processRoomEvacuation(w.source);
    const energySend=w.actions.filter(x=>x.action==='send'&&x.resource==='energy').at(-1);
    assert.ok(energySend.amount+Math.ceil(energySend.amount/10)<=99); w.tick(); w.api.processRoomEvacuation(w.source);
    assert.equal(w.source.memory.evacuation.sent.H,10); assert.ok(w.source.memory.evacuation.sent.energy>0);
});

test('fee dust and nuker locked resources are visible and never destroyed or automatically unclaimed',()=>{
    const w=world(); w.source.terminal.store.energy=1; w.structure(w.source,'nuker',{energy:300000,G:5000}); w.create();
    for(let i=0;i<3;i++){w.api.processRoomEvacuation(w.source);w.tick();}
    const status=w.status(); assert.equal(status.readyToUnclaim,true); assert.equal(status.energyDust,1);
    assert.deepEqual(status.nonWithdrawable,{energy:300000,G:5000}); assert.equal(w.source.controller.my,true);
    assert.equal(w.actions.some(x=>x.action==='send'||x.action==='withdraw'),false);
});

test('special combat, shard, team and power creep cargo is reported while ordinary roles stop work and clear carried cargo',()=>{
    const w=world(); const worker=w.unit(w.source,'builder','builder',{energy:20});
    const mission=w.unit(w.source,'shard','sBuilder',{H:10}), defender=w.unit(w.source,'guard','defender',{energy:5});
    w.game.powerCreeps.pc={room:w.source,store:w.store({ops:30},100)};
    w.create(); assert.equal(w.api.runRoomEvacuationCreep(mission),false); assert.equal(w.api.runRoomEvacuationCreep(defender),false);
    assert.equal(w.api.runRoomEvacuationCreep(worker),true); assert.equal(worker.memory.dontPullMe,false); assert.equal(w.actions.at(-1).action,'transfer');
    assert.deepEqual(w.status().manualCargo,{H:10,energy:5,ops:30}); assert.equal(w.status().readyToUnclaim,false);
});

test('foreign remote haulers passing through are not retasked, but home haulers return to unload',()=>{
    const w=world(), other=w.room('E35N3'), sourceSpawn=w.structure(w.source,'spawn',{energy:300},300);
    const passing=w.unit(w.source,'passing','rFiller',{energy:50}); passing.memory.spawnRoom=other.name; passing.memory.data.targetFlag=other.terminal.id;
    const incoming=w.unit(other,'home','rFiller',{energy:50}); incoming.memory.spawnRoom=w.source.name; incoming.memory.data.targetFlag=sourceSpawn.id;
    w.create(); assert.equal(w.api.runRoomEvacuationCreep(passing),false); assert.equal(w.api.runRoomEvacuationCreep(incoming),true);
    assert.equal(w.actions.at(-1).action,'moveTo'); assert.equal(w.actions.at(-1).room,w.source.name);
    assert.equal(w.status().manualCargo.energy,50);
});

test('full fee-starved terminal temporarily stages nonenergy without dropping it, then admits external stored energy',()=>{
    const w=world(); w.source.terminal.store.H=300000; const storage=w.structure(w.source,'storage',{energy:100},1000000);
    const worker=w.unit(w.source); w.create(); w.api.runRoomEvacuationCreep(worker);
    assert.equal(w.actions.at(-1).action,'withdraw'); assert.equal(w.actions.at(-1).target,w.source.terminal.id);
    w.tick(); w.api.runRoomEvacuationCreep(worker); assert.equal(w.actions.at(-1).target,storage.id); w.tick();
    w.api.runRoomEvacuationCreep(worker); assert.equal(w.actions.at(-1).resource,'energy'); w.tick(); w.api.runRoomEvacuationCreep(worker); w.tick();
    assert.equal(w.source.terminal.store.energy,100); assert.equal((w.source.terminal.store.H||0)+(storage.store.H||0),300000);
    assert.equal(w.actions.some(x=>x.action==='drop'),false);
});

test('native cargo reservations prevent two workers from withdrawing the same snapshot batch',()=>{
    const w=world(); w.source.terminal.store.energy=100; const factory=w.structure(w.source,'factory',{H:100}), first=w.unit(w.source,'first'), second=w.unit(w.source,'second');
    w.create(); w.api.runRoomEvacuationCreep(first); w.api.runRoomEvacuationCreep(second);
    assert.equal(w.actions.filter(x=>x.action==='withdraw'&&x.target===factory.id).length,1); assert.equal(factory.store.H,100);
});

test('low TTL workers feed a minimum replacement spawn from terminal energy before their lanes retire',()=>{
    const w=world(); w.source.terminal.store.energy=110; w.structure(w.source,'factory',{H:100}); const spawn=w.structure(w.source,'spawn',{},300);
    const worker=w.unit(w.source,'old','filler',{},100,99); w.create();
    w.api.runRoomEvacuationCreep(worker); assert.equal(w.actions.at(-1).target,w.source.terminal.id); w.tick();
    w.api.runRoomEvacuationCreep(worker); assert.equal(w.actions.at(-1).target,spawn.id); w.tick(); assert.equal(w.source.energyAvailable,100);
    w.api.releaseRoomEvacuationConfigs(w.source,w.publish);
    const configs=Object.values(w.source.memory.creepConfig); assert.equal(configs.length,1); assert.equal(configs[0].bodyProfile.maximumCost,100);
    const helperName=Object.keys(w.source.memory.creepConfig)[0], helper=w.unit(w.source,helperName,'filler');
    helper.memory.data={evacuationRoom:w.source.name}; helper.spawning=true; spawn.store.energy=0;
    w.tick(); helper.spawning=false; w.api.runRoomEvacuationCreep(helper); assert.equal(w.actions.at(-1).resource,'H');
    assert.equal(w.status().carriers.includes(helper.name),true);
});

test('helper demand names persist while unborn and rotate for an aging born helper',()=>{
    const w=world(); w.source.terminal.store.energy=10; w.structure(w.source,'factory',{H:100}); w.structure(w.source,'spawn',{energy:100},300); w.create();
    w.api.releaseRoomEvacuationConfigs(w.source,w.publish); const before=Object.keys(w.source.memory.creepConfig);
    w.tick(); w.source.memory.creepConfig={}; w.api.releaseRoomEvacuationConfigs(w.source,w.publish);
    assert.deepEqual(Object.keys(w.source.memory.creepConfig),before);
    const old=w.unit(w.source,before[0],'filler',{},100,99); old.memory.data={evacuationRoom:w.source.name};
    w.tick(); w.source.memory.creepConfig={}; w.api.releaseRoomEvacuationConfigs(w.source,w.publish);
    assert.ok(Object.keys(w.source.memory.creepConfig).some(name=>!before.includes(name)));
});

test('a dying carrier takes the final spawn energy to the terminal without refilling or commissioning another carrier',()=>{
    const w=world(), spawn=w.structure(w.source,'spawn',{energy:100},300), worker=w.unit(w.source,'last','filler',{},100,99);
    w.create(); w.api.releaseRoomEvacuationConfigs(w.source,w.publish); assert.equal(Object.keys(w.source.memory.creepConfig).length,0);
    w.api.runRoomEvacuationCreep(worker); assert.equal(w.actions.at(-1).target,spawn.id); w.tick();
    w.api.releaseRoomEvacuationConfigs(w.source,w.publish); assert.equal(Object.keys(w.source.memory.creepConfig).length,0);
    w.api.runRoomEvacuationCreep(worker); assert.equal(w.actions.at(-1).target,w.source.terminal.id); w.tick();
    assert.equal(spawn.store.energy,0); assert.equal(w.source.terminal.store.energy,100); w.api.processRoomEvacuation(w.source);
    assert.equal(w.actions.at(-1).action,'send');
});

test('shared receiving capacity accounts for multiple send intents and local carrier deposits without mutating stores',()=>{
    const w=world(); w.target.terminal.store.energy=299900;
    assert.equal(w.api.getEvacuationIncomingCapacity(w.target),100); w.api.reserveEvacuationIncoming(w.target,60);
    assert.equal(w.api.getEvacuationIncomingCapacity(w.target),40); w.tick(); assert.equal(w.api.getEvacuationIncomingCapacity(w.target),100);
    w.source.terminal.store.energy=299950; const first=w.unit(w.source,'one','filler',{H:40}), second=w.unit(w.source,'two','filler',{H:40});
    w.create(); w.api.runRoomEvacuationCreep(first); w.api.runRoomEvacuationCreep(second);
    assert.deepEqual(w.actions.filter(x=>x.action==='transfer').map(x=>x.amount),[40,10]); assert.equal(w.source.terminal.store.H,undefined);
});

test('source loss, destination loss, missing haulers, and unreachable stocks never report completed',()=>{
    const w=world(); w.source.terminal.store.energy=100; w.structure(w.source,'factory',{H:100}); w.create(); w.api.processRoomEvacuation(w.source);
    assert.equal(w.status().readyToUnclaim,false); assert.match(w.status().message,/搬运工/);
    const worker=w.unit(w.source); worker.pos.x=20; worker.moveCode=-2; w.tick(); w.api.runRoomEvacuationCreep(worker);
    assert.match(w.status().message,/不可达/); assert.equal(w.status().blocked.length,1);
    w.target.controller.my=false; w.tick(); w.api.processRoomEvacuation(w.source); assert.match(w.status().message,/目标失去/); assert.equal(w.status().readyToUnclaim,false);
});

test('cancel restores worker roles only after mixed evacuation cargo is actually unloaded',()=>{
    for(const role of ['harvester','miner','repairer','upgrader']) {
        const w=world(), storage=w.structure(w.source,'storage',{}), worker=w.unit(w.source,'worker',role,{energy:20,H:30,GH2O:40});
        w.create(); w.api.runRoomEvacuationCreep(worker);
        // Cancel before the first accepted transfer resolves: the old role must not receive a mixed cargo body.
        w.api.cancelRoomEvacuation(w.source.name); w.tick();
        assert.equal(w.api.runRoomEvacuationCreep(worker),true); assert.equal(worker.memory.evacuationCargoRoom,w.source.name);
        w.tick(); assert.equal(w.api.runRoomEvacuationCreep(worker),true); w.tick();
        assert.equal(w.api.runRoomEvacuationCreep(worker),false); assert.equal(worker.memory.evacuationCargoRoom,undefined);
        assert.equal(worker.memory.working,false); assert.equal(worker.memory.ready,false); assert.equal(storage.store.H,30); assert.equal(storage.store.GH2O,40);
    }
});

test('cancelled workers hold cargo when their own deposits are full instead of dropping or resuming an incompatible role',()=>{
    const w=world(), storage=w.structure(w.source,'storage',{energy:1000000}), worker=w.unit(w.source,'worker','harvester',{GH2O:30});
    w.create(); w.api.runRoomEvacuationCreep(worker); w.intents.length=0;
    w.api.cancelRoomEvacuation(w.source.name); w.source.terminal.store.energy=300000; w.tick();
    assert.equal(w.api.runRoomEvacuationCreep(worker),true); assert.equal(worker.store.GH2O,30); assert.equal(storage.store.GH2O,undefined);
    assert.equal(worker.memory.evacuationCargoRoom,w.source.name); assert.equal(w.actions.some(x=>x.action==='drop'),false);
});

test('inactive native terminals cannot start an evacuation that would freeze upgrades below terminal RCL',()=>{
    const w=world(); w.source.terminal.isActive=()=>false;
    assert.match(w.create(),/有终端/); assert.equal(w.source.memory.evacuation,undefined);
});

test('completed status is never ready with newly arrived stock, manual cargo, or lost visibility',()=>{
    const w=world(); w.create(); for(let i=0;i<3;i++){w.api.processRoomEvacuation(w.source);w.tick();}
    assert.equal(w.status().readyToUnclaim,true);
    w.source.terminal.store.energy=500; w.tick(); assert.equal(w.status().readyToUnclaim,false); assert.equal(w.status().energyDust,0);
    w.source.terminal.store.energy=0; w.game.powerCreeps.pc={room:w.source,store:w.store({ops:1})}; w.tick(); assert.equal(w.status().readyToUnclaim,false);
    delete w.game.rooms[w.source.name]; w.tick(); assert.equal(w.status().readyToUnclaim,false);
});

test('cancelled returning hauler continues to its old owned deposit instead of stopping in an owned room without storage',()=>{
    const w=world(), transit=w.room('E35N3'), storage=w.structure(w.source,'storage',{}), worker=w.unit(w.source,'remote','rFiller',{H:30});
    worker.memory.data.targetFlag=w.source.terminal.id; w.create(); w.api.runRoomEvacuationCreep(worker); w.intents.length=0;
    w.api.cancelRoomEvacuation(w.source.name); w.tick(); worker.room=transit; worker.pos.roomName=transit.name; delete transit.terminal;
    assert.equal(w.api.runRoomEvacuationCreep(worker),true); assert.equal(w.actions.at(-1).target,storage.id); assert.equal(w.actions.at(-1).room,w.source.name);
});

test('two existing carriers evacuate all withdrawable stores and remains with native intent resolution and confirmed receipt',()=>{
    const w=world(); w.structure(w.source,'storage',{H:40,energy:800}); w.structure(w.source,'lab',{GH2O:20,energy:100});
    w.structure(w.source,'factory',{X:50,energy:100}); w.structure(w.source,'container',{energy:100}); w.structure(w.source,'link',{energy:50});
    w.structure(w.source,'powerSpawn',{power:10,energy:80}); w.structure(w.source,'spawn',{energy:300},300);
    w.structure(w.source,'extension',{energy:50},50); w.structure(w.source,'tower',{energy:100},1000);
    const nuker=w.structure(w.source,'nuker',{G:5000,energy:300000});
    for(const [id,resourceType,amount] of [['drop-L','L',30],['drop-E','energy',50]]){
        const value={id,resourceType,amount,pos:{x:10,y:10,roomName:w.source.name}}; w.source.droppedResource.push(value);w.objects.set(id,value);
    }
    for(const [field,id,resources] of [['tombstones','tomb',{K:10,energy:20}],['ruins','ruin',{U:15,energy:10}]]){
        const value={id,store:w.store(resources),pos:{x:10,y:10,roomName:w.source.name}};w.source[field].push(value);w.objects.set(id,value);
    }
    const first=w.unit(w.source,'first'), second=w.unit(w.source,'second');
    const originalEnergy=w.source.structures.filter(value=>value!==nuker).reduce((total,value)=>total+(value.store.energy||0),0)+80;
    w.create(); let completed=false;
    for(let tick=0;tick<250;tick++){
        w.api.processRoomEvacuation(w.source); w.api.runRoomEvacuationCreep(first);w.api.runRoomEvacuationCreep(second);
        const status=w.status();
        if(status.readyToUnclaim){completed=true;break;}
        if(status.pending)assert.equal(status.readyToUnclaim,false);
        w.tick();
    }
    assert.equal(completed,true,w.status().message);
    const status=w.status(); assert.equal(status.status,'complete'); assert.equal(w.source.memory.evacuation.pending,undefined);
    for(const object of w.source.structures)if(object!==nuker&&object!==w.source.terminal)assert.equal(object.store.getUsedCapacity(),0,object.id);
    assert.equal(first.store.getUsedCapacity(),0);assert.equal(second.store.getUsedCapacity(),0);
    for(const object of [...w.source.ruins,...w.source.tombstones])assert.equal(object.store.getUsedCapacity(),0);
    for(const object of w.source.droppedResource)assert.equal(object.amount,0);
    for(const [resource,value] of Object.entries(status.sent))assert.equal(w.target.terminal.store[resource],value,resource);
    assert.equal(w.target.terminal.store.energy+status.energySpent+status.energyDust,originalEnergy);
    assert.deepEqual(status.nonWithdrawable,{G:5000,energy:300000});assert.equal(w.source.controller.my,true);
});

test('the real spawn body selector submits a 100-energy carry-only replacement after an aging worker feeds it',()=>{
    const w=world();w.source.terminal.store.energy=110;w.structure(w.source,'factory',{H:100});
    const spawn=w.structure(w.source,'spawn',{},300), old=w.unit(w.source,'old','filler',{},100,99);w.create();
    w.api.runRoomEvacuationCreep(old);w.tick();w.api.runRoomEvacuationCreep(old);w.tick();
    w.api.releaseRoomEvacuationConfigs(w.source,w.publish);
    const {globals:nativeGlobals,modules:nativeModules}=require('../helpers/native-bodies.cjs');
    const cost={carry:50,move:50,work:100,claim:600,tough:10,attack:80,ranged_attack:150,heal:250};
    const loader=createSourceLoader({globals:{...nativeGlobals,Game:w.game,Memory:w.memory,StructureSpawn:class{},BODYPART_COST:cost,BOOSTS:{},OK:0},modules:{
        ...nativeModules,
        role:{createRoleBehavior:()=>({isNeed:()=>true}),isRoleSupported:()=>true},
        'creep/development':{isDevelopingRoom:()=>false},
        'creep/developmentBodies':{getDevelopmentBody:()=>undefined,needsEmergencyBody:()=>false},
        'creep/developmentEconomy':{getDevelopmentSpawnReserve:()=>0},
        'creep/developmentRemotes':{isDevelopmentRemoteData:()=>false},
        'combat/spawning':{combatSpawnAllowed:()=>true,recordCombatSpawn(){}},
    }});
    const Spawn=loader.load('mount/structure/SpawnExtension').default;
    Object.setPrototypeOf(spawn,Spawn.prototype);
    w.source.memory.creepSpawnQueue=Object.keys(w.source.memory.creepConfig);
    let submitted;
    spawn.spawnCreep=(body,name,options)=>{submitted={body,name,memory:options.memory};spawn.spawning={name};spawn.store.energy-=body.reduce((total,part)=>total+cost[part],0);return 0;};
    Spawn.prototype.doWork.call(spawn);
    assert.ok(submitted,'native spawn intent is submitted at 100 available energy');
    assert.deepEqual([...submitted.body],['carry','move']);assert.equal(spawn.store.energy,0);
    const replacement=w.unit(w.source,submitted.name,'filler');replacement.memory=submitted.memory;
    w.tick();w.api.runRoomEvacuationCreep(replacement);
    assert.equal(w.actions.at(-1).action,'withdraw');assert.equal(w.actions.at(-1).resource,'H');
});

test('partial pool withdrawals and native helper budgets preserve nonenergy fees at 250 and 100 total energy',()=>{
    for(const pool of [250,100]){
        const w=world();w.structure(w.source,'storage',{H:100});const spawn=w.structure(w.source,'spawn',{energy:pool},300);
        w.unit(w.source,'old','filler',{},100,99);w.create();const driver=nativeSpawnDriver(w,spawn);let complete=false;
        for(let index=0;index<120;index++){
            if(index%5===0){w.source.memory.creepConfig={};w.api.releaseRoomEvacuationConfigs(w.source,w.publish);w.source.memory.creepSpawnQueue=Object.keys(w.source.memory.creepConfig);}
            w.api.processRoomEvacuation(w.source);
            for(const creep of Object.values(w.game.creeps))w.api.runRoomEvacuationCreep(creep);
            driver.work();driver.resolve();w.tick();
            if(w.status().readyToUnclaim){complete=true;break;}
        }
        assert.equal(complete,true,`${pool}: ${w.status().message}`);assert.equal(w.target.terminal.store.H,100);
        assert.equal(pool===100?driver.spent===0:driver.spent>0,true);
        assert.equal((w.target.terminal.store.energy||0)+w.status().energySpent+w.status().energyDust+driver.spent,pool);
    }
});

test('inactive spawn and extension energy is withdrawable without consuming the active spawn reserve',()=>{
    const w=world();w.structure(w.source,'storage',{H:100});
    w.structure(w.source,'spawn',{energy:100},300);const inactive=w.structure(w.source,'extension',{energy:50},50);inactive.isActive=()=>false;
    const worker=w.unit(w.source,'old','filler',{},100,99);w.create();w.api.runRoomEvacuationCreep(worker);
    assert.equal(w.actions.at(-1).target,inactive.id);assert.equal(w.actions.at(-1).amount,50);
});

test('native passive spawn regeneration cannot prevent completion after the original 300 energy was actually drained',()=>{
    const w=world(),spawn=w.structure(w.source,'spawn',{energy:300},300);w.unit(w.source,'first');w.unit(w.source,'second');w.create();
    let generated=0,complete=false;
    for(let index=0;index<120;index++){
        w.api.processRoomEvacuation(w.source);for(const creep of Object.values(w.game.creeps))w.api.runRoomEvacuationCreep(creep);
        if(w.source.energyAvailable<300){spawn.store.energy++;generated++;}w.tick();
        if(w.status().readyToUnclaim){complete=true;break;}
    }
    assert.equal(complete,true,w.status().message);assert.ok(w.target.terminal.store.energy>250,'the original pool reached the receiver after fees');
    const status=w.status();assert.ok(status.passiveGeneration.energy>0);assert.equal(status.passiveGeneration.energy,spawn.store.energy);
    assert.equal((w.target.terminal.store.energy||0)+status.energySpent+status.energyDust+status.passiveGeneration.energy,300+generated);
    for(let index=0;index<130;index++){
        const previous=w.actions.length;w.api.processRoomEvacuation(w.source);for(const creep of Object.values(w.game.creeps))w.api.runRoomEvacuationCreep(creep);
        assert.equal(w.actions.slice(previous).some(value=>value.action==='withdraw'),false);assert.equal(w.status().readyToUnclaim,true);
        spawn.store.energy++;w.tick();
    }
});

test('native activation checks are cached per tick while reservation math covers a full mature pool',()=>{
    const w=world(),calls=new Map();
    for(let index=0;index<60;index++){const object=w.structure(w.source,'extension',{energy:1},50);object.isActive=()=>{calls.set(object.id,(calls.get(object.id)||0)+1);return true;};}
    const spawn=w.structure(w.source,'spawn',{energy:1},300);spawn.isActive=()=>{calls.set(spawn.id,(calls.get(spawn.id)||0)+1);return true;};
    Object.defineProperty(w.source,'energyAvailable',{get:()=>[...w.source.spawns,...w.source.extensions].reduce((total,object)=>total+(object.store.energy||0),0)});
    const first=w.unit(w.source,'first'),second=w.unit(w.source,'second');w.create();w.api.processRoomEvacuation(w.source);
    w.api.runRoomEvacuationCreep(first);w.api.runRoomEvacuationCreep(second);w.status();
    assert.equal(calls.size,61);assert.equal(Math.max(...calls.values()),1);
    w.tick();w.api.processRoomEvacuation(w.source);w.api.runRoomEvacuationCreep(first);w.api.runRoomEvacuationCreep(second);
    assert.ok(Math.max(...calls.values())<=2);
});

test('passive spawn proof requires next-tick stock evidence and invalidates on excess cargo or a newly active spawn',()=>{
    const w=world(),spawn=w.structure(w.source,'spawn',{energy:100},300),worker=w.unit(w.source);w.create();
    w.api.runRoomEvacuationCreep(worker);assert.equal(w.status().passiveGeneration.energy,0);
    // The accepted withdrawal fails to resolve; the old energy cannot be reclassified as regeneration.
    w.intents.length=0;w.tick();assert.equal(w.status().passiveGeneration.energy,0);assert.equal(w.source.memory.evacuation.spawnPoolDrain,undefined);
    spawn.store.energy=0;w.tick();w.status();spawn.store.energy=1;w.tick();assert.equal(w.status().passiveGeneration.energy,1);
    w.structure(w.source,'spawn',{energy:300},300);w.tick();assert.equal(w.status().passiveGeneration.energy,0);assert.equal(w.status().readyToUnclaim,false);
});

test('near-spawn regeneration cannot starve a distant extension or container energy stock',()=>{
    for(const type of ['extension','container']){
        const w=world(),spawn=w.structure(w.source,'spawn',{energy:10},300),far=w.structure(w.source,type,{energy:50},50);
        far.pos.x=40;far.pos.y=40;const worker=w.unit(w.source);w.create();let destination,generated=0,complete=false;
        worker.moveTo=target=>{w.actions.push({action:'moveTo',name:worker.name,target:target.id});destination=target.pos;return 0;};
        for(let index=0;index<250;index++){
            w.api.processRoomEvacuation(w.source);w.api.runRoomEvacuationCreep(worker);
            if(w.source.energyAvailable<300){spawn.store.energy++;generated++;}
            w.tick();
            if(destination&&Math.max(Math.abs(worker.pos.x-destination.x),Math.abs(worker.pos.y-destination.y))>1){
                worker.pos.x+=Math.sign(destination.x-worker.pos.x);worker.pos.y+=Math.sign(destination.y-worker.pos.y);
            }
            destination=undefined;
            if(w.status().readyToUnclaim){complete=true;break;}
        }
        assert.equal(complete,true,`${type}: ${w.status().message}`);assert.equal(far.store.energy,0);
        assert.equal(w.actions.find(value=>value.action==='withdraw').target,far.id);
        assert.equal((w.target.terminal.store.energy||0)+w.status().energySpent+w.status().energyDust+w.status().passiveGeneration.energy,60+generated);
    }
});
