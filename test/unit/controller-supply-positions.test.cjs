const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

function world(level = 6) {
    const calls = [], units = [], structures = [], objects = new Map();
    const counts = { my: 0, terrain: 0 };
    class Position {
        constructor(x,y,roomName='E39N5'){Object.assign(this,{x,y,roomName});}
        getRangeTo(value){const p=value.pos||value;return this.roomName===p.roomName?Math.max(Math.abs(this.x-p.x),Math.abs(this.y-p.y)):Infinity;}
        isNearTo(value){return this.getRangeTo(value)<=1;}
        isEqualTo(value){return this.getRangeTo(value)===0;}
        inRangeTo(value,n){return this.getRangeTo(value)<=n;}
    }
    const p = (x,y)=>new Position(x,y);
    const room = { name:'E39N5', memory:{}, controller:{id:'controller',my:true,level,pos:p(25,25)}, sources:[], links:[], containers:[], structures, constructionSites:[],
        getTerrain:()=>({get(){counts.terrain++;return 0;}}),
        find(type){if(type==='my'){counts.my++;return units;}if(type==='structures')return structures;if(type==='power')return [];return units;},
        lookForAt(type,x,y){return (type==='structures'?structures:units).filter(item=>item.pos.x===x&&item.pos.y===y);}
    };
    const game={time:100,shard:{name:'shard1'},rooms:{[room.name]:room},creeps:{},flags:{},getObjectById:id=>objects.get(id)||null};
    const store=(energy,capacity)=>({energy,getCapacity:()=>capacity,getFreeCapacity(){return capacity-this.energy;},getUsedCapacity(){return this.energy;}});
    function structure(id,type,x,y,energy=0,capacity=2000){
        const item={id,structureType:type,pos:p(x,y),my:true,isActive:()=>true,store:store(energy,capacity)};
        structures.push(item);room[type==='link'?'links':'containers'].push(item);objects.set(id,item);return item;
    }
    function unit(name,x,y,energy=20,capacity=50){
        const creep={name,id:name,room,pos:p(x,y),my:true,spawning:false,fatigue:0,store:store(energy,capacity),memory:{role:'upgrader',data:{}},getActiveBodyparts:()=>2,
            moveTo(target,options){calls.push({type:'move',name,target,options});return 0;},
            upgradeController(){calls.push({type:'upgrade',name});return 0;},
            withdraw(target,resource,amount){calls.push({type:'withdraw',name,target,amount});return 0;},
            transfer(target,resource,amount){calls.push({type:'transfer',name,target,amount});return 0;}
        };
        units.push(creep);game.creeps[name]=creep;objects.set(name,creep);return creep;
    }
    const loader=createSourceLoader({globals:{Game:game,Memory:{},RoomPosition:Position,WORK:'work',RESOURCE_ENERGY:'energy',
        FIND_MY_CREEPS:'my',FIND_CREEPS:'creeps',FIND_POWER_CREEPS:'power',FIND_STRUCTURES:'structures',LOOK_STRUCTURES:'structures',LOOK_CREEPS:'creeps',LOOK_POWER_CREEPS:'power',
        TERRAIN_MASK_WALL:1,STRUCTURE_ROAD:'road',STRUCTURE_CONTAINER:'container',STRUCTURE_LINK:'link',STRUCTURE_RAMPART:'rampart',OK:0,ERR_NOT_IN_RANGE:-9
    },modules:{utils:{getDistance:(a,b)=>a.getRangeTo(b),getClosestTarget:(pos,list)=>list[0]}}});
    return {calls,units,structures,objects,counts,game,room,p,unit,structure,
        supply:loader.load('creep/controllerSupplyPositions').controllerSupplyPosition,
        logistics:loader.load('creep/developmentLogistics'),
        relay:loader.load('creep/controllerEnergyRelay'),
        role:loader.load('role/base/RoleBaseUpgrader').default};
}

test('a stocked Container gets one coverage root without moving other productive Link workers',()=>{
    const w=world(), link=w.structure('link','link',22,25,200,800), container=w.structure('container','container',25,28,1500);
    w.room.controllerLink=link;
    const far=w.unit('a',23,25), other=w.unit('b',24,25), root=w.unit('c',24,26);
    assert.equal(w.supply(far).buffer.id,container.id);
    assert.equal(w.supply(root).requireAdjacent,true);
    assert.equal(w.supply(other).requireAdjacent,false);
    w.role({sourceId:link.id}).target(far);
    w.role({sourceId:link.id}).target(root);
    const moves=w.calls.filter(call=>call.type==='move');
    assert.equal(moves.length,1);assert.equal(moves[0].name,root.name);
    assert.equal(moves[0].target.isNearTo(container),true);
    assert.equal(w.calls.some(call=>call.type==='upgrade'&&call.name===far.name),true);
    assert.equal(w.counts.my,1,'selection and relay share a single native worker index per tick');
});

test('covered Container keeps settled workers and still uses a relay cached first with Link',()=>{
    const w=world(), link=w.structure('link','link',22,25,0,800), container=w.structure('container','container',25,28,1500);
    w.room.controllerLink=link;
    const root=w.unit('root',24,27), hungry=w.unit('hungry',23,26,0);
    w.relay.prepareControllerEnergyRelay(w.room,link);
    assert.equal(w.supply(hungry).buffer.id,container.id);
    assert.equal(w.supply(root).requireAdjacent,false);
    assert.equal(w.supply(hungry).requireAdjacent,false);
    w.role({sourceId:link.id}).source(hungry);
    assert.equal(w.calls.some(call=>call.type==='move'),false,'a genuinely supplied connected worker keeps its station');
    assert.equal(w.calls.some(call=>call.type==='withdraw'&&call.target.id===container.id),true);
});

test('a fatigued travelling Container root remains assigned until covered, then assignments release',()=>{
    const w=world(), link=w.structure('link','link',22,25,0,800), container=w.structure('container','container',25,28,1500);
    w.room.controllerLink=link;
    const root=w.unit('root',24,26), other=w.unit('other',23,25);
    assert.equal(w.supply(root).requireAdjacent,true);
    root.fatigue=4;other.pos=w.p(24,26);w.game.time++;
    assert.equal(w.supply(other).requireAdjacent,false);
    assert.equal(w.supply(root).requireAdjacent,true,'fatigue must not dispatch a new worker every tick');
    root.pos=w.p(24,27);w.game.time++;
    assert.equal(w.supply(root).requireAdjacent,false);
    assert.equal(w.supply(other).requireAdjacent,false);
});

test('a live root taking a detour outside upgrade range keeps its coverage assignment',()=>{
    const w=world(), link=w.structure('link','link',22,25,100,800), container=w.structure('container','container',25,28,1500);
    w.room.controllerLink=link;
    const root=w.unit('root',24,26), other=w.unit('other',23,25);
    assert.equal(w.supply(root).requireAdjacent,true);
    root.pos=w.p(29,26);other.pos=w.p(24,26);w.game.time++;
    assert.equal(w.supply(other).requireAdjacent,false,'a detour must not dispatch another root');
    assert.equal(w.supply(root).requireAdjacent,true);
    root.memory.boostPlan={tier:3,completed:false,failed:false};w.game.time++;
    assert.equal(w.supply(other).requireAdjacent,true,'a worker waiting for boosts cannot reserve the supply root');
});

test('a dead coverage root is replaced and empty Container falls back to the native Link',()=>{
    const w=world(), link=w.structure('link','link',22,25,300,800), container=w.structure('container','container',25,28,1500);
    w.room.controllerLink=link;
    const root=w.unit('root',24,26), replacement=w.unit('replacement',23,25);
    assert.equal(w.supply(root).requireAdjacent,true);
    w.units.splice(w.units.indexOf(root),1);delete w.game.creeps[root.name];w.game.time++;
    assert.equal(w.supply(replacement).requireAdjacent,true);
    container.store.energy=0;w.game.time++;
    assert.equal(w.supply(replacement).buffer.id,link.id);
    assert.equal(w.supply(replacement).requireAdjacent,false,'the existing Link root is already covered');
});

test('occupied Container approaches do not trigger a shuffle and recover when a seat opens',()=>{
    const w=world(), link=w.structure('link','link',22,25,300,800), container=w.structure('container','container',25,28,1500);
    w.room.controllerLink=link;
    const root=w.unit('root',24,26);
    for(const seat of w.logistics.controllerUpgradeSeats(w.room,container))if(Math.max(Math.abs(seat.x-container.pos.x),Math.abs(seat.y-container.pos.y))<=1){
        const blocker=w.unit('block-'+seat.x+'/'+seat.y,seat.x,seat.y,0);blocker.memory.role='filler';
    }
    w.role({sourceId:link.id}).target(root);
    assert.equal(w.calls.some(call=>call.type==='move'),false);
    assert.equal(w.calls.some(call=>call.type==='upgrade'),true);
    const block=w.units.find(unit=>unit.memory.role==='filler');
    w.units.splice(w.units.indexOf(block),1);delete w.game.creeps[block.name];w.game.time++;w.calls.length=0;
    w.role({sourceId:link.id}).target(root);
    const move=w.calls.find(call=>call.type==='move');assert.ok(move);assert.equal(move.target.isNearTo(container),true);
});

test('RCL8 and opted-out rooms bypass supply planning without any new creep or terrain scan',()=>{
    for(const disabled of ['rcl8','optout']){
        const w=world(disabled==='rcl8'?8:6), unit=w.unit('root',24,26);
        if(disabled==='optout')w.room.memory.fastUpgrade=false;
        Object.defineProperty(w.room,'controllerLink',{get(){throw Error('disabled supply selection must not inspect Link');}});
        assert.equal(w.supply(unit).buffer,undefined);
        assert.equal(w.supply(unit).requireAdjacent,false);
        assert.equal(w.counts.my,0);assert.equal(w.counts.terrain,0);
    }
});


test('a mineral-only Container with no energy key cannot become the preferred energy supplier',()=>{
    const w=world(), link=w.structure('link','link',22,25,0,800), container=w.structure('mineral','container',25,28,0);
    w.room.controllerLink=link;
    delete container.store.energy;container.store.H=1000;
    const unit=w.unit('root',23,25);
    assert.equal(w.supply(unit).buffer.id,link.id);
    assert.equal(w.supply(unit).requireAdjacent,false);
    w.role({sourceId:link.id}).target(unit);
    assert.equal(w.calls.some(call=>call.type==='withdraw'&&call.target.id===container.id),false);
});
