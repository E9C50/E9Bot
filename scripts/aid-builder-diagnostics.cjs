// Read-only aid worker snapshot. Authentication and unrelated Memory stay in process.
const { officialClient } = require('./official-client.cjs');

async function main() {
    const shard = process.argv.find(value => /^shard\d+$/.test(value)) || 'shard1';
    const roomName = process.argv.find(value => /^[WE]\d+[NS]\d+$/.test(value));
    if (!roomName) throw new Error('Usage: node scripts/aid-builder-diagnostics.cjs shard1 E39N5');
    const client = await officialClient();
    const [memory, response] = await Promise.all([
        client.memory(shard), client.request('/api/game/room-objects', { room: roomName, shard }),
    ]);
    const objects = Object.values(response.objects || {});
    console.log(JSON.stringify({
        capturedAt: new Date().toISOString(), shard, roomName, tick: memory.stats?.time,
        cpu: memory.stats?.cpu, war: memory.warMode?.[roomName] === true,
        workers: objects.filter(object => object.type === 'creep' && ['sBuilder', 'rBuilder'].includes(memory.creeps?.[object.name]?.role))
            .map(object => {
                const state = memory.creeps[object.name];
                return {
                    name: object.name, role: state.role, x: object.x, y: object.y,
                    energy: object.store?.energy || 0, capacity: object.storeCapacity, working: state.working,
                    fatigue: object.fatigue, ticksToLive: object.ageTime - (memory.stats?.time || 0),
                    phase: state.data?.phase, collection: state.aidBuilderEnergy,
                    body: (object.body || []).reduce((counts, part) => { counts[part.type] = (counts[part.type] || 0) + 1; return counts; }, {}),
                };
            }),
        energy: objects.filter(object => ['source', 'container', 'energy', 'resource'].includes(object.type))
            .map(object => ({ id: object._id, type: object.type, x: object.x, y: object.y, energy: object.store?.energy ?? object.energy ?? object.amount, resourceType: object.resourceType })),
        sites: objects.filter(object => object.type === 'constructionSite')
            .map(object => ({ type: object.structureType, x: object.x, y: object.y, progress: object.progress, total: object.progressTotal })),
    }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
