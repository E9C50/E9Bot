// Bounded read-only console verification; no Memory writes or game intents.
const WebSocket = require('ws');
const { officialClient } = require('./official-client.cjs');

async function main() {
    const shard = process.argv[2] || 'shard1';
    if (!/^shard\d+$/.test(shard)) throw new Error('Expected shard name');
    const client = await officialClient(), me = await client.request('/api/auth/me');
    const logisticsRoom = process.argv.find(value => /^[WE]\d+[NS]\d+$/.test(value)) || 'E31N2';
    const secondsArgument = process.argv.indexOf('--seconds');
    const windowSeconds = secondsArgument < 0 ? 45 : Number(process.argv[secondsArgument + 1]);
    if (!Number.isInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 300) throw new Error('--seconds must be between 1 and 300');
    const expression = process.argv.includes('--miners')
        ? 'JSON.stringify({developmentSnapshot:true,tick:Game.time,bucket:Game.cpu.bucket,miners:Object.values(Game.creeps).filter(c=>c.memory.role==="harvester").map(c=>({name:c.name,room:c.room.name,x:c.pos.x,y:c.pos.y,energy:c.store.energy,capacity:c.store.getCapacity(RESOURCE_ENERGY),ready:c.memory.ready,working:c.memory.working,parts:c.body.reduce((a,p)=>{const key=p.type+(p.boost?":"+p.boost:"");a[key]=(a[key]||0)+1;return a},{}),boostPlan:c.memory.boostPlan,source:(()=>{const s=Game.getObjectById(c.memory.data.sourceId);return s&&{x:s.pos.x,y:s.pos.y,energy:s.energy,regen:s.ticksToRegeneration}})()}))})'
        : process.argv.includes('--flow')
        ? 'JSON.stringify({developmentSnapshot:true,tick:Game.time,bucket:Game.cpu.bucket,room:(()=>{const r=Game.rooms[' + JSON.stringify(logisticsRoom) + '];if(!r)return null;return {name:r.name,level:r.controller.level,progress:r.controller.progress,energy:r.energyAvailable,capacity:r.energyCapacityAvailable,spawns:r.spawns.map(s=>s.spawning&&{name:s.spawning.name,remaining:s.spawning.remainingTime}),containers:r.containers.map(s=>({x:s.pos.x,y:s.pos.y,energy:s.store.energy})),drops:r.droppedResource.filter(s=>s.resourceType===RESOURCE_ENERGY).map(s=>({x:s.pos.x,y:s.pos.y,energy:s.amount})),sites:r.constructionSites.length,events:r.getEventLog().filter(e=>e.event===EVENT_HARVEST||e.event===EVENT_UPGRADE_CONTROLLER).map(e=>({name:Game.getObjectById(e.objectId)?.name,event:e.event,data:e.data}))}})()})'
        : process.argv.includes('--cpu')
        ? 'JSON.stringify({developmentSnapshot:true,tick:Game.time,bucket:Game.cpu.bucket,limit:Game.cpu.limit,tickLimit:Game.cpu.tickLimit,used:Game.cpu.getUsed(),profile:typeof cpuProfile==="function"?(()=>{const p=JSON.parse(cpuProfile(undefined,256));return {...p,stages:p.stages.map(s=>({name:s.name,count:s.count,sampledTicks:s.sampledTicks,sampledAvg:s.sampledAverage,avg:s.rollingAverage,max:s.rollingMax,current:s.current}))}})():null,rooms:Object.values(Game.rooms).filter(r=>r.controller&&r.controller.my).length,roles:Object.values(Game.creeps).reduce((a,c)=>{a[c.memory.role]=(a[c.memory.role]||0)+1;return a},{}),combatTasks:Object.values(Memory.combatTasks||{}).map(t=>({id:t.id,phase:t.phase,mode:t.mode}))})'
        : process.argv.includes('--maintenance')
        ? 'JSON.stringify({developmentSnapshot:true,tick:Game.time,bucket:Game.cpu.bucket,used:Game.cpu.getUsed(),rooms:Object.values(Game.rooms).filter(r=>r.controller&&r.controller.my).map(r=>{const ids=new Set(r.towers.map(t=>t.id));const repairs=r.getEventLog().filter(e=>e.event===EVENT_REPAIR&&ids.has(e.objectId));return {name:r.name,repairs:repairs.map(e=>({type:Game.getObjectById(e.data.targetId)?.structureType,hits:e.data.amount})),towerRepairs:repairs.length,sites:r.find(FIND_MY_CONSTRUCTION_SITES).length,lastInspection:r.memory.roomBlueprintState?.lastBuildTick}})})'
        : process.argv.includes('--builders')
        ? 'JSON.stringify({developmentSnapshot:true,tick:Game.time,bucket:Game.cpu.bucket,builders:Object.values(Game.creeps).filter(c=>c.memory.role==="sBuilder"||c.memory.role==="rBuilder").map(c=>({name:c.name,room:c.room.name,x:c.pos.x,y:c.pos.y,energy:c.store.energy,capacity:c.store.getCapacity(RESOURCE_ENERGY),working:c.memory.working,ttl:c.ticksToLive,collection:c.memory.aidBuilderEnergy})),sites:Object.values(Game.constructionSites).map(s=>({room:s.pos.roomName,type:s.structureType,x:s.pos.x,y:s.pos.y,progress:s.progress,total:s.progressTotal}))})'
        : process.argv.includes('--haulers')
        ? 'JSON.stringify({developmentSnapshot:true,tick:Game.time,bucket:Game.cpu.bucket,workers:Object.values(Game.creeps).filter(c=>c.room.name===' + JSON.stringify(logisticsRoom) + '&&c.memory.role==="filler").map(c=>({name:c.name,x:c.pos.x,y:c.pos.y,energy:c.store.energy,capacity:c.store.getCapacity(RESOURCE_ENERGY),working:c.memory.working,data:c.memory.data,state:c.memory.developmentHauler})),room:(()=>{const r=Game.rooms[' + JSON.stringify(logisticsRoom) + '];return r&&{name:r.name,energy:r.energyAvailable,capacity:r.energyCapacityAvailable,containers:r.containers.map(s=>({id:s.id,x:s.pos.x,y:s.pos.y,energy:s.store.energy})),drops:r.droppedResource.filter(s=>s.resourceType===RESOURCE_ENERGY).map(s=>({id:s.id,x:s.pos.x,y:s.pos.y,energy:s.amount}))}})()})'
        : process.argv.includes('--logistics')
        ? 'JSON.stringify({developmentSnapshot:true,tick:Game.time,bucket:Game.cpu.bucket,workers:Object.values(Game.creeps).filter(c=>c.room.name===' + JSON.stringify(logisticsRoom) + '&&(c.memory.role==="filler"||c.memory.role==="manager")).map(c=>({name:c.name,role:c.memory.role,x:c.pos.x,y:c.pos.y,store:c.store,working:c.memory.working,dontPullMe:c.memory.dontPullMe,ttl:c.ticksToLive})),room:(()=>{const r=Game.rooms[' + JSON.stringify(logisticsRoom) + '];return r&&{name:r.name,energy:r.energyAvailable,capacity:r.energyCapacityAvailable,fillJobs:r.memory.roomFillJob}})()})'
        : process.argv.includes('--combat')
        ? 'JSON.stringify({developmentSnapshot:true,tick:Game.time,bucket:Game.cpu.bucket,combatApi:{create:typeof combatTask,list:typeof combatTasks,cancel:typeof combatTaskCancel},tasks:Object.values(Memory.combatTasks||{}).map(t=>({id:t.id,phase:t.phase,mode:t.mode,reason:t.reason,spent:t.spent})),cpu:typeof cpuProfile==="function"?JSON.parse(cpuProfile(undefined,256)).stages.filter(s=>s.name==="tick:combat"||s.name==="tick:teams"||s.name==="room:enemy"||s.name==="tick:creeps").map(s=>({name:s.name,average:s.rollingAverage,current:s.current})):[],rooms:Object.values(Game.rooms).filter(r=>r.controller&&r.controller.my).map(r=>({name:r.name,level:r.controller.level,developmentDemands:Object.values(r.memory.creepConfig||{}).filter(c=>c.development).length,combatDemands:Object.values(r.memory.creepConfig||{}).filter(c=>c.combatTaskId).length,war:!!Memory.warMode[r.name]}))})'
        : process.argv.includes('--bodies')
        ? 'JSON.stringify({developmentSnapshot:true,tick:Game.time,bucket:Game.cpu.bucket,bodyApi:typeof bodyPreview,previews:typeof bodyPreview==="function"&&Game.rooms.E41N8?["harvester","upgrader","sHauler"].map(role=>{const p=JSON.parse(bodyPreview("E41N8",role));return {role,profiles:p.profiles.map(v=>({tier:v.tier,parts:v.parts,energy:v.energy,canPrepare:v.canPrepare,resources:v.minerals.map(m=>m.resource)}))}}):[],newBodies:Object.values(Game.creeps).filter(c=>c.memory.boostPlan).slice(0,20).map(c=>({name:c.name,role:c.memory.role,room:c.room.name,spawning:c.spawning,parts:c.body.reduce((a,p)=>{a[p.type]=(a[p.type]||0)+1;return a},{}),tier:c.memory.boostPlan.tier,completed:c.memory.boostPlan.completed,failed:c.memory.boostPlan.failed})),rooms:Object.values(Game.rooms).filter(r=>r.controller&&r.controller.my).map(r=>({name:r.name,level:r.controller.level,spawns:r.spawns.length,developmentDemands:Object.values(r.memory.creepConfig||{}).filter(c=>c.development).length}))})'
        : 'JSON.stringify({developmentSnapshot:true,tick:Game.time,bucket:Game.cpu.bucket,rooms:Object.values(Game.rooms).filter(r=>r.controller&&r.controller.my).map(r=>({name:r.name,level:r.controller.level,progress:r.controller.progress,spawns:r.spawns.length,capacity:r.energyCapacityAvailable,developmentDemands:Object.values(r.memory.creepConfig||{}).filter(c=>c.development).length,localRoles:Object.values(Game.creeps).filter(c=>c.room.name===r.name).reduce((a,c)=>{a[c.memory.role]=(a[c.memory.role]||0)+1;return a},{}),automaticRemotes:r.memory.developmentRemotes&&r.memory.developmentRemotes.selectedRooms}))})';
    const expressions = [expression];
    if (process.argv.includes('--flow')) expressions.push('JSON.stringify({developmentSnapshot:true,snapshotKind:"workers",tick:Game.time,workers:Object.values(Game.creeps).filter(c=>c.room.name===' + JSON.stringify(logisticsRoom) + '&&["harvester","upgrader","sBuilder","rBuilder"].includes(c.memory.role)).map(c=>({name:c.name,role:c.memory.role,x:c.pos.x,y:c.pos.y,energy:c.store.energy,capacity:c.store.getCapacity(RESOURCE_ENERGY),work:c.getActiveBodyparts(WORK),working:c.memory.working,dontPullMe:c.memory.dontPullMe,sourceId:c.memory.data.sourceId,ttl:c.ticksToLive,planned:c.room.memory.creepConfig[c.name]?.development}))})');
    await new Promise((resolve, reject) => {
        const socket = new WebSocket('wss://screeps.com/socket/websocket');
        let timer, interval, finished = false, errors = 0, samples = 0;
        const finish = () => {
            if (finished) return;
            finished = true; clearTimeout(timer); clearInterval(interval); socket.close();
            console.log(JSON.stringify({ shard, samples, observedErrors: errors, windowSeconds })); resolve();
        };
        const sample = async () => {
            for (const expression of expressions) {
                try { await client.request('/api/user/console', undefined, { expression, shard }); }
                catch (error) { errors++; console.log(JSON.stringify({ shard, error: 'Read-only snapshot request failed: ' + error.message })); }
            }
        };
        socket.addEventListener('open', () => socket.send(`auth ${client.getToken()}`));
        socket.addEventListener('error', () => { clearTimeout(timer); clearInterval(interval); reject(new Error('Official monitor socket failed')); });
        socket.addEventListener('close', finish);
        socket.addEventListener('message', event => {
            const message = String(event.data);
            if (message.startsWith('auth ok')) {
                socket.send('gzip off'); socket.send(`subscribe user:${me._id}/console`);
                sample(); interval = setInterval(sample, 20000); timer = setTimeout(finish, windowSeconds * 1000);
            } else if (message.startsWith('auth failed')) {
                reject(new Error('Official monitor authentication failed')); socket.close();
            } else if (message.startsWith('[')) {
                try {
                    const [channel, payload] = JSON.parse(message);
                    if (!channel.endsWith('/console') || (payload.shard !== undefined && payload.shard !== shard)) return;
                    const decode = value => String(value).replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
                        .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
                    for (const value of payload.messages?.results || []) {
                        try { const result = JSON.parse(decode(value)); if (result.developmentSnapshot) { samples++; console.log(JSON.stringify({ shard, ...result })); } } catch {}
                    }
                    for (const value of payload.messages?.error || []) { errors++; console.log(JSON.stringify({ shard, error: decode(value) })); }
                    for (const value of payload.messages?.log || []) {
                        const line = decode(value);
                        if (line.startsWith(`[CPU][${shard}]`)) console.log(line);
                        else if (/^\[unit:|^\[stage:|^\[tick:|^\[boost:|^\[combat[^\]]+\].*Error|TypeError|ReferenceError|SyntaxError|CPU limit|timed out/.test(line)) { errors++; console.log(JSON.stringify({ shard, error: line })); }
                    }
                } catch { /* Never dump unrelated console traffic. */ }
            }
        });
    });
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Official monitor unavailable'); process.exitCode = 1; });
