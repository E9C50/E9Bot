// Read-only task/scout diagnostics; no account details or full Memory dumps.
const { officialClient } = require('./official-client.cjs');

async function main() {
    const client = await officialClient();
    const shards = process.argv.filter(value => /^shard\d+$/.test(value));
    for (const shard of shards.length ? shards : ['shard3', 'shard2', 'shard1', 'shard0']) {
        try {
            const memory = await client.memory(shard);
            const scouts = Object.entries(memory.creeps || {}).filter(([, creep]) => creep.role === 'sScout');
            const rooms = new Set();
            for (const [, creep] of scouts) {
                const data = creep.data || {};
                const position = data.exploration?.lastPosition || data.scouting?.lastPosition;
                if (position?.shard === shard) rooms.add(position.roomName);
            }
            const positions = [];
            for (const room of rooms) {
                const response = await client.request('/api/game/room-objects', { room, shard });
                for (const object of Object.values(response.objects || {})) {
                    if (object.type === 'creep' && scouts.some(([name, creep]) => name === object.name || creep.displayName === object.name)) positions.push({ name: object.name, room, x: object.x, y: object.y, ageTime: object.ageTime, fatigue: object.fatigue, hits: object.hits });
                }
            }
            console.log(JSON.stringify({ capturedAt: new Date().toISOString(), shard, tick: memory.stats?.time, cpu: memory.stats?.cpu,
                missions: memory.shardMissions, arrivals: memory.shardArrivals,
                scouts: scouts.map(([memoryKey, creep]) => ({ memoryKey, displayName: creep.displayName, role: creep.role, data: creep.data })), positions,
                queuedScouts: Object.entries(memory.rooms || {}).flatMap(([room, value]) => Object.entries(value.creepConfig || {}).filter(([, config]) => config.role === 'sScout').map(([name, config]) => ({ room, name, missionId: config.data?.missionId, revision: config.data?.exploration?.revision || config.data?.scouting?.revision, queued: (value.creepSpawnQueue || []).includes(name) }))),
            }, null, 2));
        } catch (error) { console.log(JSON.stringify({ shard, error: error.message })); }
    }
    const branches = await client.request('/api/user/branches');
    console.log(JSON.stringify({ configuredBranch: client.branch, branches: branches.list?.map(value => ({ branch: value.branch, activeWorld: value.activeWorld })) }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
