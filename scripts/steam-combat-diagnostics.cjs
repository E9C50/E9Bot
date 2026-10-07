// Read-only inspection through the Steam private server's loopback management CLI.
const net = require('node:net');
const username = process.argv[2] || 'E9C50';
const expression = `storage.db.users.findOne({username:${JSON.stringify(username)}}).then(u=>{if(!u)throw Error('User not found');return Promise.all([
storage.env.get(storage.env.keys.MEMORY+u._id),storage.env.get(storage.env.keys.GAMETIME),
storage.db['users.code'].findOne({user:u._id,activeWorld:true}),storage.db['rooms.objects'].find({user:u._id})
]).then(([raw,time,code,objects])=>{const m=JSON.parse(raw||'{}');const cm=o=>(m.creeps||{})[o.name]||{};
const energy=o=>o.store?.energy??o.energy??0;
const capacity=o=>o.storeCapacityResource?.energy??o.energyCapacity??o.storeCapacity??0;
const report={
snapshot:true,capturedAt:new Date().toISOString(),username:u.username,gameTime:time,branch:code.branch,
memoryTime:m.stats&&m.stats.time,cpu:{limit:u.cpu,available:u.cpuAvailable,stats:m.stats&&m.stats.cpu},warMode:m.warMode,
tasks:Object.values(m.combatTasks||{}).map(t=>({id:t.id,shard:t.shard,phase:t.phase,reason:t.reason,generation:t.generation,
homeRoom:t.homeRoom,targetRoom:t.targetRoom,options:t.options,createdAt:t.createdAt,lastPlanAt:t.lastPlanAt,updatedAt:t.updatedAt,
wave:t.wave,spent:t.spent,names:t.names,memberNames:t.memberNames,intel:t.intel,plan:t.plan&&{formation:t.plan.formation,energy:t.plan.energy,
members:t.plan.members.map(p=>({role:p.role,profile:p.profile,energy:p.energy,tier:p.boostPlan&&p.boostPlan.tier}))}})),
rooms:Object.entries(m.rooms||{}).filter(([name])=>objects.some(o=>o.room===name&&o.type==='controller')).map(([name,r])=>({name,
energyAvailable:objects.filter(o=>o.room===name&&['spawn','extension'].includes(o.type)).reduce((n,o)=>n+energy(o),0),
energyCapacity:objects.filter(o=>o.room===name&&['spawn','extension'].includes(o.type)).reduce((n,o)=>n+capacity(o),0),
queue:r.creepSpawnQueue,fillJobs:r.roomFillJob,configs:Object.entries(r.creepConfig||{}).map(([name,c])=>({name,role:c.role,priority:c.spawnPriority,
task:c.combatTaskId,job:c.combatJob,generation:c.combatGeneration,profile:c.bodyProfile})),lab:r.roomLabConfig,
structures:objects.filter(o=>o.room===name&&['storage','terminal','spawn','controller'].includes(o.type)).map(o=>({type:o.type,name:o.name,
x:o.x,y:o.y,level:o.level,store:o.store,spawning:o.spawning}))})),
creeps:objects.filter(o=>o.type==='creep'&&(cm(o).combatTaskId||
['integrate','attacker','healer','dismantler'].includes(cm(o).role))).map(o=>({name:o.name,room:o.room,x:o.x,y:o.y,
bodyParts:o.body.length,memory:cm(o)})),
logistics:objects.filter(o=>o.type==='creep'&&['filler','manager','processer','processor','repairer'].includes(cm(o).role))
.map(o=>({name:o.name,room:o.room,x:o.x,y:o.y,store:o.store,bodyParts:o.body.length,memory:cm(o)}))};
return {[Symbol.for('nodejs.util.inspect.custom')]:()=>JSON.stringify(report)};});})`;
const socket = net.createConnection({host:'::1',port:21026});
let text='',sent=false,finished=false;
function fail(message) {
    if (finished) return;
    finished=true;clearTimeout(timer);socket.destroy();console.error(message);process.exitCode=1;
}
const timer=setTimeout(()=>fail('Steam private-server CLI timeout'),10000);
socket.on('data',data=>{
    text+=data;
    if(!sent&&text.includes('<')){sent=true;socket.write(expression.replace(/\n/g,'')+'\n');text='';return;}
    while(text.includes('\n')&&!finished){
        const end=text.indexOf('\n');
        const line=text.slice(0,end).trim().replace(/^<\s*/, '');text=text.slice(end+1);
        if(line.startsWith('{')){
            try{
                const value=JSON.parse(line);
                if(value.snapshot!==true) continue;
                console.log(JSON.stringify(value,null,2));finished=true;clearTimeout(timer);socket.end();
            }catch{fail('Steam private-server CLI response could not be decoded');}
        }else if(/^(?:\w*Error):/.test(line)){
            fail('Steam private-server CLI query failed');
        }
    }
});
socket.on('error',()=>fail('Steam private-server CLI unavailable'));
socket.on('end',()=>{if(!finished)fail('Steam private-server CLI closed before the snapshot was received');});
