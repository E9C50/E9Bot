const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');
const nativeBodies = require('../helpers/native-bodies.cjs');
const COST = { work:100, carry:50, move:50, claim:600, tough:10, attack:80, ranged_attack:150, heal:250 };

function world({ automatic = false, capacity = 800, available = capacity } = {}) {
    const actions = [], units = [], configs = [];
    class Position {
        constructor(x, y, roomName) { Object.assign(this, { x, y, roomName }); }
        isNearTo(value) { const p = value.pos || value; return p.roomName === this.roomName && Math.max(Math.abs(this.x-p.x), Math.abs(this.y-p.y)) <= 1; }
    }
    const pos = (x, y, roomName) => new Position(x, y, roomName);
    const home = { name: 'E39N5', my:true, controller: { my: true, level: 6, owner: { username: 'me' } },
        memory: { creepConfig: {}, creepSpawnQueue: [] }, energyCapacityAvailable: capacity, energyAvailable: available,
        enemies: [], containers: [], sources: [], links: [], getTerrain: () => ({ get: () => 0 }) };
    home.spawns = [{ my: true, id: 'spawn', pos: pos(25, 25, home.name), recycleCreep: creep => { actions.push(['recycle', creep.name]); return 0; } }];
    const target = { name: 'E38N5', controller: { pos: pos(20,20,'E38N5') }, enemies: [], sources: [],
        getTerrain: () => ({ get: () => 0 }), lookForAt: () => [] };
    const invader = (name = 'npc', username = 'Invader', x = 25, y = 25) => ({ id:name, hits:1000, body:[],
        owner: { username }, pos:pos(x,y,target.name), getActiveBodyparts: part => part === 'attack' ? 1 : 0 });
    target.enemies.push(invader());
    const game = { time: 101, shard: { name: 'shard1' }, rooms: { [home.name]:home, [target.name]:target }, creeps: {}, flags: {},
        map:{getRoomLinearDistance:(from,to)=>Math.abs(Number(/\d+/.exec(from)[0])-Number(/\d+/.exec(to)[0]))} };
    if (automatic) home.memory.developmentRemotes = { candidates:[target.name], selectedRooms:[], intel:{[target.name]:{status:'blocked',seenAt:100,reason:'存在活动敌对单位'}} };
    else game.flags[home.name+'_OUT0'] = {pos:pos(25,25,target.name)};
    const memory = { creeps:{}, warMode:{} };
    const publish = (room, role, name, data) => {
        configs.push({role,name,data});
        room.memory.creepConfig[name] = { role,name,data,spawnRoom:room.name,spawnPriority:3 }; return name;
    };
    const buildQueue = room => Object.entries(room.memory.creepConfig).filter(([name]) => !game.creeps[name])
        .sort((a,b) => a[1].spawnPriority-b[1].spawnPriority).map(([name])=>name);
    const loader = createSourceLoader({ globals:{ ...nativeBodies.globals, Game:game, Memory:memory, RoomPosition:Position,
        StructureSpawn:class {}, OK:0, BODYPART_COST:COST,
        HEAL_POWER:12, RANGED_ATTACK_POWER:10,
        BOOSTS:{heal:{LO:{heal:2},LHO2:{heal:3},XLHO2:{heal:4}},ranged_attack:{KO:{rangedAttack:2},KHO2:{rangedAttack:3},XKHO2:{rangedAttack:4}},
            tough:{GO:{damage:0.7},GHO2:{damage:0.5},XGHO2:{damage:0.3}}},
        TERRAIN_MASK_WALL:1, LOOK_CREEPS:'creeps', LOOK_STRUCTURES:'structures', STRUCTURE_RAMPART:'rampart',
        OBSTACLE_OBJECT_TYPES:['spawn','extension','tower','constructedWall'] }, modules:{ ...nativeBodies.modules,
        './development': {isDevelopingRoom: room => room?.controller.my && room.controller.level < 8},
        './spawnQueue':{buildSpawnQueue:buildQueue,orderCreepSpawnQueue(){actions.push(['full-order']);}},
        './demand':{addCreepConfig:publish},
        './basePopulation':{releaseBaseCreepConfig(){actions.push(['ordinary-refresh']);}},
        './remotePopulation':{releaseJobsCreepConfig(){}}, './warPopulation':{releaseWarCreepConfig(){}},
        './developmentRemotes':{releaseDevelopmentRemoteConfigs(){}},
        'creep/development':{isDevelopingRoom:room=>room?.controller.my && room.controller.level<8},
        'creep/developmentRemotes':{isDevelopmentRemoteData:()=>false},
        'creep/storageFillerLifecycle':{isMatureStorageFiller:()=>false,hasUsableStorageFiller:()=>true},
        'role':{isRoleSupported:()=>true},
        'combat/spawning':{combatSpawnAllowed:()=>true,recordCombatSpawn(){}},
        'shard/controller':{releaseShardCreepConfig(){}}, 'combat/missions':{releaseCombatCreepConfigs(){}},
        'room/evacuation':{releaseRoomEvacuationConfigs(){}},
        'combat/defense':{runDefender(creep,data,ranged){actions.push(['local-defense',ranged]);return true;}},
    }});
    const api = loader.load('creep/remoteInvaderDefense');
    const release = () => api.releaseRemoteInvaderDefenseConfigs(publish, buildQueue);
    const demand = (room=home) => Object.entries(room.memory.creepConfig).find(([,config])=>api.isRemoteInvaderGuardData(config.data));
    function unit(room=home) {
        const [name, config] = demand(room);
        const creep={name,room,pos:pos(25,25,room.name),hits:1000,hitsMax:1000,
            body:[...Array(config.bodyProfile.combatPrimaryParts).fill('ranged_attack'),...Array(config.bodyProfile.combatHealParts).fill('heal'),
                ...Array(config.bodyProfile.combatPrimaryParts+config.bodyProfile.combatHealParts).fill('move')].map(type=>({type,hits:100})),
            memory:{...config,boostPlan:{tier:0,steps:[],completed:true}},goBoost(){actions.push(['boost']);return true;},
            getActiveBodyparts:part=>part==='heal'?config.bodyProfile.combatHealParts:part==='ranged_attack'?config.bodyProfile.combatPrimaryParts:0,
            moveTo(value,options){actions.push(['move',value.pos||value,options]);return 0;},
            heal(value){actions.push(['heal',value.name]);return 0;},
            rangedAttack(value){actions.push(['attack',value.id]);return 0;},
            rangedMassAttack(){throw Error('NPC response must never issue collateral mass fire');}};
        game.creeps[name]=creep;units.push(creep);return creep;
    }
    return {api,loader,game,memory,home,target,actions,configs,units,invader,pos,release,demand,unit};
}

function combatInvader(w, name, parts) {
    const enemy=w.invader(name);enemy.body=parts.map(part=>typeof part==='string'?{type:part,hits:100}:part);
    enemy.hits=enemy.body.reduce((sum,part)=>sum+part.hits,0);enemy.hitsMax=enemy.body.length*100;
    enemy.getActiveBodyparts=type=>enemy.body.filter(part=>part.type===type && part.hits>0).length;return enemy;
}
function spawnGuard(w, room=w.home) {
    const Spawn=w.loader.load('mount/structure/SpawnExtension').default, born=[];
    const spawn=Object.assign(new Spawn(),{room,spawnCreep(body,name,options){born.push({body,name,memory:options.memory});return 0;}});
    spawn.doWork();return born[0];
}
function addHome(w,name,capacity=12900,available=capacity,{level=8,logistics=true}={}) {
    const room={...w.home,name,controller:{my:true,level,owner:{username:'me'}},memory:{creepConfig:{},creepSpawnQueue:[]},
        energyCapacityAvailable:capacity,energyAvailable:available,enemies:[]};
    room.spawns=[{my:true,pos:w.pos(25,25,name),recycleCreep:()=>0}];w.game.rooms[name]=room;
    if(logistics)w.game.creeps[name+'_filler']={name:name+'_filler',room,memory:{role:'filler',spawnRoom:name},getActiveBodyparts:part=>['carry','move'].includes(part)?1:0};
    return room;
}

for (const automatic of [false,true]) test(`${automatic?'automatic blocked mine':'manual OUT mine'} gets a guard on a non-refresh tick`,()=>{
    const w=world({automatic});
    w.loader.load('creep/population').creepNumberController();
    const [,config]=w.demand();
    assert.equal(config.role,'rdefender');assert.equal(config.spawnPriority,2.5);
    assert.equal(config.bodyProfile.boostTier,0);assert.equal(config.bodyProfile.combatPrimaryParts,2);
    assert.equal(config.bodyProfile.combatHealParts,1);assert.equal(config.bodyProfile.maximumCost,800);
    assert.ok(w.home.memory.creepSpawnQueue.includes(config.name));
    assert.equal(w.actions.some(action=>action[0]==='ordinary-refresh'),false);
});

test('guard demand survives lost vision and the ordinary five-tick catalog reset without multiplying slots',()=>{
    const w=world();w.release();const name=w.demand()[0];
    delete w.game.rooms[w.target.name];w.game.time=105;
    w.loader.load('creep/population').creepNumberController();
    assert.equal(w.demand()[0],name);assert.equal(w.demand()[1].data.remoteInvaderGuard.seenAt,101);
    w.game.time=106;w.release();assert.equal(Object.keys(w.home.memory.creepConfig).length,1);
});

test('a dead guard re-enters the queue immediately without waiting for catalog refresh or duplicating its slot',()=>{
    const w=world();w.release();const creep=w.unit();
    w.home.memory.creepSpawnQueue=[];delete w.game.creeps[creep.name];w.game.time=102;
    w.release();assert.ok(w.home.memory.creepSpawnQueue.includes(creep.name));assert.equal(w.configs.length,1);
    w.demand()[1].spawnPriority=99;w.release();assert.equal(w.demand()[1].spawnPriority,2.5);
});

test('cleared mines, deleted flags and expired unseen threats immediately withdraw pending births',()=>{
    for(const reason of ['clear','flag','expiry']) {
        const w=world();w.release();
        if(reason==='clear')w.target.enemies=[];
        if(reason==='flag')w.game.flags={};
        if(reason==='expiry'){delete w.game.rooms[w.target.name];w.game.time+=1500;}
        w.release();assert.equal(w.demand(),undefined);assert.deepEqual(w.home.memory.creepSpawnQueue,[]);
    }
});

test('local defense and economic rescue precede remote clearing',()=>{
    const w=world();
    for(const [role,priority] of [['manager',0],['harvester',1],['filler',2],['builder',4],['upgrader',5]])
        w.home.memory.creepConfig[role]={role,name:role,data:{},spawnPriority:priority};
    w.release();
    const queue=w.home.memory.creepSpawnQueue;
    assert.deepEqual(queue.slice(0,3),['manager','harvester','filler']);
    assert.ok(queue.indexOf(w.demand()[0])<queue.indexOf('builder'));
    w.home.enemies=[w.invader('local')];w.release();assert.equal(w.demand(),undefined);
});

test('response stays affordable at 500 and 800 capacity and uses current spawn energy in larger rooms',()=>{
    for(const [capacity,available,primary] of [[500,500,1],[800,800,2],[2300,500,1]]) {
        const w=world({capacity,available});w.release();const profile=w.demand()[1].bodyProfile;
        const cost=profile.combatPrimaryParts*200+profile.combatHealParts*300;
        assert.equal(profile.combatPrimaryParts,primary);assert.ok(cost<=available);
    }
    const impossible=world({capacity:300});impossible.release();assert.equal(impossible.demand(),undefined);
});

test('published native guard profiles actually start spawning on the detection tick at 500 and 800 energy',()=>{
    for(const [capacity,available,expectedCost] of [[500,500,500],[800,800,700],[2300,500,500]]) {
        const w=world({capacity,available});
        w.loader.load('creep/population').creepNumberController();
        const name=w.demand()[0];
        const Spawn=w.loader.load('mount/structure/SpawnExtension').default;
        const spawn=Object.assign(new Spawn(),{room:w.home,spawnCreep(body,bornName,options){
            assert.equal(bornName,name);assert.equal(w.game.time,101);
            assert.equal(body.reduce((total,part)=>total+COST[part],0),expectedCost);
            assert.equal(body.filter(part=>part==='heal').length,1);
            assert.ok(body.filter(part=>part==='move').length>=body.length/2);
            assert.equal(options.memory.boostPlan.tier,0);assert.equal(options.memory.boostPlan.steps.length,0);
            w.actions.push(['spawn',bornName]);return 0;
        }});
        spawn.doWork();assert.equal(w.actions.some(action=>action[0]==='spawn'),true);
        assert.equal(w.home.memory.creepSpawnQueue.length,0);
    }
});

test('one native enemy HEAL publishes immediately but waits for a body that can outdamage it',()=>{
    const w=world({capacity:800,available:500});w.target.enemies=[combatInvader(w,'healer',['heal'])];
    w.release();const threat=w.home.memory.remoteInvaderThreats[w.target.name];
    assert.equal(threat.healPower,12);assert.equal(threat.requiredEnergy,700);assert.equal(threat.status,'waiting-energy');
    assert.ok(w.home.memory.creepSpawnQueue.includes(w.demand()[0]));assert.equal(spawnGuard(w),undefined);
    w.home.energyAvailable=700;w.release();const born=spawnGuard(w);
    assert.ok(born.body.filter(part=>part==='ranged_attack').length*10>12);
    assert.equal(born.body.reduce((sum,part)=>sum+COST[part],0),700);
    const creep=w.unit();creep.room=w.target;creep.pos=w.pos(25,28,w.target.name);
    const enemy=w.target.enemies[0],damage=born.body.filter(part=>part==='ranged_attack').length*10;
    creep.rangedAttack=target=>{target.hits=Math.max(0,target.hits-damage);return 0;};
    for(let tick=0;tick<20 && enemy.hits>0;tick++) {
        w.api.runRemoteInvaderGuard(creep,creep.memory.data);
        if(enemy.hits>0)enemy.hits=Math.min(enemy.hitsMax,enemy.hits+12);
    }
    assert.equal(enemy.hits,0,'actual native attack selection clears the healer instead of endlessly matching its recovery');
});

test('all active boosted enemy HEAL is counted and destroyed parts do not inflate the winning body',()=>{
    const w=world({capacity:2150,available:500});
    w.target.enemies=[combatInvader(w,'boosted',[{type:'heal',hits:100,boost:'XLHO2'},{type:'heal',hits:0,boost:'XLHO2'}]),
        combatInvader(w,'support',['heal'])];
    w.release();const threat=w.home.memory.remoteInvaderThreats[w.target.name];
    assert.equal(threat.healPower,60);assert.equal(threat.requiredEnergy,1700);
    assert.equal(w.demand()[1].bodyProfile.combatPrimaryParts,7);assert.equal(spawnGuard(w),undefined);
    delete w.game.rooms[w.target.name];w.game.time=105;
    w.loader.load('creep/population').creepNumberController();
    assert.equal(w.demand()[1].bodyProfile.combatPrimaryParts,7,'lost vision retains the last proved enemy strength');
    w.home.energyAvailable=1700;w.release();const born=spawnGuard(w);
    assert.equal(born.body.filter(part=>part==='ranged_attack').length,7);
    assert.ok(7*10>threat.healPower);assert.equal(born.memory.boostPlan.tier,0);
});

test('living boosted TOUGH requires damage above healing after mitigation, while destroyed or native TOUGH does not',()=>{
    for(const [boost,hits,multiplier,primary,requiredEnergy] of [['XGHO2',100,0.3,5,1300],['XGHO2',0,1,2,700],[undefined,100,1,2,700]]) {
        const w=world({capacity:2150,available:500});
        w.target.enemies=[combatInvader(w,'armoured-healer',[{type:'tough',hits,boost},'heal'])];
        w.home.memory.bodyProfiles={rdefender:{combatToughParts:10,boostTier:3}};
        w.release();const threat=w.home.memory.remoteInvaderThreats[w.target.name];
        assert.equal(threat.damageMultiplier,multiplier);assert.equal(threat.requiredEnergy,requiredEnergy);
        assert.equal(w.demand()[1].bodyProfile.combatPrimaryParts,primary);assert.equal(spawnGuard(w),undefined);
        w.home.energyAvailable=requiredEnergy;w.release();const born=spawnGuard(w);
        assert.equal(born.body.filter(part=>part==='ranged_attack').length,primary);
        assert.equal(born.body.filter(part=>part==='tough').length,0,'room presets cannot add unbudgeted armour to a dedicated native guard');
        assert.ok(primary*10*multiplier>threat.healPower);assert.equal(born.memory.boostPlan.tier,0);
        const creep=w.unit();creep.room=w.target;creep.pos=w.pos(25,28,w.target.name);
        const enemy=w.target.enemies[0];creep.rangedAttack=target=>{target.hits=Math.max(0,target.hits-primary*10*multiplier);return 0;};
        for(let tick=0;tick<100 && enemy.hits>0;tick++) {
            w.api.runRemoteInvaderGuard(creep,creep.memory.data);
            if(enemy.hits>0)enemy.hits=Math.min(enemy.hitsMax,enemy.hits+12);
        }
        assert.equal(enemy.hits,0,'damage still wins under the conservative persistent TOUGH reduction model');
    }
});

test('multiple armoured healers use the strongest live damage reduction and total healing budget',()=>{
    const w=world({capacity:2150,available:500});
    w.target.enemies=[combatInvader(w,'basic',[{type:'tough',hits:100,boost:'GO'},'heal']),
        combatInvader(w,'strong',[{type:'tough',hits:100,boost:'XGHO2'},'heal'])];
    w.release();const threat=w.home.memory.remoteInvaderThreats[w.target.name];
    assert.equal(threat.healPower,24);assert.equal(threat.damageMultiplier,0.3);assert.equal(threat.requiredEnergy,2100);
    w.home.energyAvailable=2100;w.release();const born=spawnGuard(w);
    assert.equal(born.body.filter(part=>part==='ranged_attack').length,9);assert.ok(9*10*0.3>24);
});

test('stronger new Invaders replace a losing paid-for guard without waiting for that fixed name to die',()=>{
    const w=world({capacity:2150,available:500});w.release();const old=w.unit();
    w.home.memory.creepSpawnQueue=[];w.target.enemies.push(combatInvader(w,'healer',['heal']));w.release();
    const [name,config]=w.demand();assert.notEqual(name,old.name);assert.equal(w.home.memory.creepConfig[old.name],undefined);
    assert.equal(config.bodyProfile.combatPrimaryParts,2);assert.ok(w.home.memory.creepSpawnQueue.includes(name));
    assert.equal(w.api.prepareRemoteInvaderGuard(old,old.memory.data),false);
    w.home.energyAvailable=700;w.release();assert.equal(spawnGuard(w).body.filter(part=>part==='ranged_attack').length,2);
});

test('five native enemy ranged parts wait for sufficient physical self-heal instead of birthing a 500-energy casualty',()=>{
    const w=world({capacity:2150,available:500});w.target.enemies=[combatInvader(w,'ranged',Array(5).fill('ranged_attack'))];
    w.release();const threat=w.home.memory.remoteInvaderThreats[w.target.name];
    assert.equal(threat.rangedPower,50);assert.equal(threat.requiredEnergy,1700);assert.equal(spawnGuard(w),undefined);
    w.home.energyAvailable=1700;w.release();const born=spawnGuard(w);
    assert.equal(born.body.filter(part=>part==='heal').length,5);
    assert.ok(born.body.filter(part=>part==='heal').length*12>=50);
    assert.equal(born.body.filter(part=>part==='move').length,born.body.length/2);
    const creep=w.unit();creep.room=w.target;creep.pos=w.pos(25,28,w.target.name);w.actions.length=0;
    w.api.runRemoteInvaderGuard(creep,creep.memory.data);
    assert.ok(w.actions.some(action=>action[0]==='heal'),'self-heal is issued before the first ranged volley even at full health');
});

test('insufficient capacity records a blocked response and never keeps replacing a known losing body',()=>{
    const w=world({capacity:800});w.target.enemies=[combatInvader(w,'healer',['heal','heal'])];
    for(const time of [101,102,105,106]) {
        w.game.time=time;w.loader.load('creep/population').creepNumberController();
        assert.equal(w.demand(),undefined);assert.equal(w.home.memory.creepSpawnQueue.length,0);
        const threat=w.home.memory.remoteInvaderThreats[w.target.name];
        assert.equal(threat.status,'insufficient-capacity');assert.equal(threat.requiredEnergy,900);assert.equal(threat.availableCapacity,800);
    }
    assert.equal(w.configs.length,0);
});

test('a nearby mature room supplies a viable native response to boosted ranged Invaders without requiring its own OUT flag',()=>{
    const w=world({capacity:800});
    w.target.enemies=[combatInvader(w,'boosted-ranged',Array.from({length:5},()=>({type:'ranged_attack',hits:100,boost:'XKHO2'})))];
    const far=addHome(w,'E45N5'),near=addHome(w,'E37N5',12900,5300);
    w.release();assert.equal(w.demand(),undefined);assert.equal(w.demand(far),undefined);
    const [,config]=w.demand(near),threat=w.home.memory.remoteInvaderThreats[w.target.name];
    assert.equal(threat.rangedPower,200);assert.equal(threat.requiredEnergy,5300);assert.equal(threat.rescueRoom,near.name);
    assert.equal(config.data.remoteInvaderGuard.sourceRoom,w.home.name);
    const born=spawnGuard(w,near);assert.equal(born.body.filter(part=>part==='heal').length,17);
    assert.ok(born.body.length<=50);assert.ok(17*12>=200);
    const creep=w.unit(near);assert.equal(w.api.prepareRemoteInvaderGuard(creep,creep.memory.data),true);
    w.api.runRemoteInvaderGuard(creep,creep.memory.data);assert.equal(w.actions.find(action=>action[0]==='move')[1].roomName,w.target.name);
    delete w.game.flags[w.home.name+'_OUT0'];w.release();assert.equal(w.demand(near),undefined);
});

test('nearest ready RCL7 rescue requires actual spawn logistics, while a paid-for guard continues after its home filler dies',()=>{
    const w=world({capacity:800});w.target.enemies=[combatInvader(w,'ranged',Array(5).fill('ranged_attack'))];
    const near=addHome(w,'E37N5',2150,1700,{level:7,logistics:false}),ready=addHome(w,'E40N5',2150,1700,{level:7});
    w.release();assert.equal(w.demand(near),undefined);assert.ok(w.demand(ready));
    assert.equal(w.home.memory.remoteInvaderThreats[w.target.name].rescueRoom,ready.name);
    const born=spawnGuard(w,ready);assert.equal(born.body.filter(part=>part==='heal').length,5);
    const creep=w.unit(ready);delete w.game.creeps[ready.name+'_filler'];w.release();
    assert.ok(ready.memory.creepConfig[creep.name]);assert.equal(w.api.prepareRemoteInvaderGuard(creep,creep.memory.data),true);
});

test('an enemy force beyond the 50-part response limit cannot publish an impossible guard even from an RCL8 room',()=>{
    const w=world({capacity:12900});w.home.controller.level=8;
    w.target.enemies=[combatInvader(w,'ranged',Array(30).fill('ranged_attack'))];w.release();
    assert.equal(w.demand(),undefined);assert.equal(w.home.memory.remoteInvaderThreats[w.target.name].status,'insufficient-capacity');
});

test('player-owned, player-reserved, Keeper and mixed player threats never become automatic wars',()=>{
    for(const reason of ['owned','reserved','keeper','mixed']) {
        const w=world();
        if(reason==='owned')w.target.controller.owner={username:'other'};
        if(reason==='reserved')w.target.controller.reservation={username:'other'};
        if(reason==='keeper')w.target.enemies=[w.invader('keeper','Source Keeper')];
        if(reason==='mixed')w.target.enemies.push(w.invader('player','other'));
        w.release();assert.equal(w.demand(),undefined);
    }
});

test('multiple associations publish only one guard for one invaded room',()=>{
    const w=world({automatic:true});
    w.game.flags[w.home.name+'_OUT0']={pos:w.pos(25,25,w.target.name)};
    const other={...w.home,name:'E41N5',memory:{creepConfig:{},creepSpawnQueue:[]}};
    w.game.rooms[other.name]=other;w.game.flags[other.name+'_OUT0']={pos:w.pos(25,25,w.target.name)};
    w.release();assert.equal(w.configs.length,1);assert.equal(w.configs[0].data.remoteInvaderGuard.homeRoom,w.home.name);
});

test('dedicated ranged guards travel without flags or legacy home-guard pursuit limits and fire only at Invaders',()=>{
    const w=world();w.release();const creep=w.unit();
    const behavior=w.loader.load('role/war/RoleWarDefenderRanged').default(creep.memory.data);
    assert.equal(behavior.prepare(creep),true);behavior.source(creep);
    assert.equal(w.actions.find(action=>action[0]==='move')[1].roomName,w.target.name);
    creep.room=w.target;creep.pos=w.pos(25,28,w.target.name);w.actions.length=0;
    behavior.target(creep);assert.deepEqual(w.actions,[['attack','npc']]);
    w.target.enemies.push(w.invader('player','other'));w.actions.length=0;
    assert.equal(behavior.prepare(creep),false);assert.equal(w.actions.some(action=>action[0]==='attack'),false);
});

test('guards kite close melee, heal injuries and retire after the visible mine is cleared',()=>{
    const w=world();w.release();const creep=w.unit();
    creep.room=w.target;creep.pos=w.pos(25,26,w.target.name);creep.hits=900;
    w.api.runRemoteInvaderGuard(creep,creep.memory.data);
    assert.ok(w.actions.some(action=>action[0]==='attack'));assert.ok(w.actions.some(action=>action[0]==='heal'));
    const move=w.actions.find(action=>action[0]==='move');assert.ok(Math.max(Math.abs(move[1].x-25),Math.abs(move[1].y-25))>1);
    w.target.enemies=[];w.release();creep.room=w.home;creep.pos=w.home.spawns[0].pos;w.actions.length=0;
    assert.equal(w.api.prepareRemoteInvaderGuard(creep,creep.memory.data),false);assert.equal(w.actions[0][0],'recycle');
});

test('ordinary ranged defenders preserve their existing local behavior',()=>{
    const w=world();const behavior=w.loader.load('role/war/RoleWarDefenderRanged').default({targetEnemy:'local'});
    const creep={memory:{},goBoost:()=>true};assert.equal(behavior.prepare(creep),true);
    behavior.source(creep);assert.equal(creep.memory.working,true);behavior.target(creep);
    assert.deepEqual(w.actions,[['local-defense',true]]);
});
