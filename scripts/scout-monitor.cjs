// Read-only live console snapshots. Does not write Memory or issue creep intents.
const WebSocket = require('ws');
const { officialClient } = require('./official-client.cjs');

async function main() {
    const shard = process.argv.find(value => /^shard\d+$/.test(value)) || 'shard3';
    const duration = Math.min(600, Math.max(10, Number(process.argv.find(value => value.startsWith('--watch='))?.split('=')[1]) || 30));
    const client = await officialClient(), me = await client.request('/api/auth/me');
    const expression = 'JSON.stringify({scoutDiagnostics:true,tick:Game.time,bucket:Game.cpu.bucket,scouts:Object.values(Game.creeps).filter(c=>c.memory.role==="sScout").map(c=>({name:c.name,room:c.room.name,x:c.pos.x,y:c.pos.y,ttl:c.ticksToLive,hits:c.hits,fatigue:c.fatigue,done:c.memory.data.done,error:c.memory.data.lastError,hopIndex:c.memory.data.hopIndex,route:c.memory.data.route,revision:c.memory.data.exploration?.revision||c.memory.data.scouting?.revision})),missions:Object.values(Memory.shardMissions||{}).map(m=>({key:m.task.key,state:m.state,generation:m.generation,exploration:m.exploration,scouting:m.scouting,leases:m.leases}))})';
    await new Promise((resolve, reject) => {
        const socket = new WebSocket('wss://screeps.com/socket/websocket');
        let interval, timer, finished = false;
        const finish = () => { if (finished) return; finished = true; clearInterval(interval); clearTimeout(timer); socket.close(); resolve(); };
        const sample = () => client.request('/api/user/console', undefined, { expression, shard }).catch(() => console.log(JSON.stringify({ shard, error: 'Read-only snapshot request failed' })));
        socket.addEventListener('open', () => socket.send(`auth ${client.getToken()}`));
        socket.addEventListener('error', () => { clearInterval(interval); clearTimeout(timer); reject(new Error('Official monitor socket failed')); });
        socket.addEventListener('close', finish);
        socket.addEventListener('message', event => {
            const message = String(event.data);
            if (message.startsWith('auth ok')) {
                socket.send('gzip off'); socket.send(`subscribe user:${me._id}/console`);
                sample(); interval = setInterval(sample, 20000); timer = setTimeout(finish, duration * 1000);
            } else if (message.startsWith('auth failed')) { reject(new Error('Official monitor authentication failed')); socket.close(); }
            else if (message.startsWith('[')) {
                try {
                    const [channel, payload] = JSON.parse(message);
                    if (!channel.endsWith('/console') || (payload.shard !== undefined && payload.shard !== shard)) return;
                    for (const value of payload.messages?.results || []) {
                        const decoded = String(value).replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16))).replace(/&quot;/g, '"').replace(/&amp;/g, '&');
                        try {
                            const result = JSON.parse(decoded);
                            if (result.scoutDiagnostics) {
                                result.missions = result.missions.map(mission => ({ ...mission, exploration: mission.exploration && {
                                    revision: mission.exploration.revision, status: mission.exploration.status,
                                    startedAt: mission.exploration.startedAt, lastShard: mission.exploration.lastShard,
                                    lastRoom: mission.exploration.lastRoom, lastError: mission.exploration.lastError,
                                    retryAt: mission.exploration.retryAt,
                                } }));
                                console.log(JSON.stringify({ capturedAt: new Date().toISOString(), shard, ...result }));
                            }
                        } catch { /* unrelated console result */ }
                    }
                    for (const value of payload.messages?.log || []) {
                        const decoded = String(value).replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
                        if (decoded.startsWith(`[CPU][${shard}]`) || decoded.startsWith('[unit:SSCOUT')) console.log(decoded);
                    }
                } catch { /* never dump unrelated traffic */ }
            }
        });
    });
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
