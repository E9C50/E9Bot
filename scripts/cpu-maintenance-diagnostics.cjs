// Read-only official snapshots; print only maintenance and CPU aggregates.
const { officialClient } = require('./official-client.cjs');

async function main() {
    const shard = process.argv.find(value => /^shard\d+$/.test(value)) || 'shard3';
    const rooms = process.argv.filter(value => /^[WE]\d+[NS]\d+$/.test(value));
    if (!rooms.length) throw new Error('Expected one or more room names');
    const client = await officialClient();
    const memory = await client.memory(shard);
    const snapshots = await Promise.all(rooms.map(async room => {
        const response = await client.request('/api/game/room-objects', { room, shard });
        const objects = Object.values(response.objects || {});
        const roads = objects.filter(object => object.type === 'road');
        const damaged = roads.filter(object => object.hits < object.hitsMax);
        const deficit = object => object.hitsMax - object.hits;
        return { room, roads: roads.length, damaged: damaged.length,
            minorDamage: damaged.filter(object => deficit(object) < Math.min(200, object.hitsMax * 0.05)).length,
            maximumMissing: Math.max(0, ...damaged.map(deficit)),
            critical: damaged.filter(object => object.hits <= object.hitsMax / 2).length,
            towers: objects.filter(object => object.type === 'tower').map(object => ({ x: object.x, y: object.y, energy: object.store?.energy })),
            storageEnergy: objects.find(object => object.type === 'storage')?.store?.energy,
            powerSpawns: objects.filter(object => object.type === 'powerSpawn').map(object => ({ energy: object.store?.energy, power: object.store?.power })),
            barriers: objects.filter(object => ['rampart', 'constructedWall'].includes(object.type)).reduce((result, object) => ({
                count: result.count + 1, minimumHits: Math.min(result.minimumHits, object.hits),
                critical: result.critical + (object.hits <= 100000 ? 1 : 0),
            }), { count: 0, minimumHits: Infinity, critical: 0 }),
        };
    }));
    console.log(JSON.stringify({ capturedAt: new Date().toISOString(), shard, tick: memory.stats?.time, cpu: memory.stats?.cpu, rooms: snapshots }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
