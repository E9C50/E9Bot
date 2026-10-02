// Read-only local hauling snapshot. Authentication and unrelated Memory stay in process.
const { officialClient } = require('./official-client.cjs');

function position(object) { return { x: object.x, y: object.y, roomName: object.room }; }

async function main() {
    const shard = process.argv.find(value => /^shard\d+$/.test(value)) || 'shard1';
    const rooms = process.argv.filter(value => /^[WE]\d+[NS]\d+$/.test(value));
    if (!rooms.length) throw new Error('Usage: node scripts/hauler-diagnostics.cjs shard1 E39N5 [other rooms]');
    const client = await officialClient();
    const [memory, ...responses] = await Promise.all([
        client.memory(shard),
        ...rooms.map(room => client.request('/api/game/room-objects', { room, shard })),
    ]);
    const snapshots = rooms.map((roomName, index) => {
        const objects = Object.values(responses[index].objects || {});
        const configs = memory.rooms?.[roomName]?.creepConfig || {};
        return {
            roomName,
            haulers: objects.filter(object => object.type === 'creep' && memory.creeps?.[object.name]?.role === 'filler')
                .map(object => {
                    const state = memory.creeps[object.name];
                    return {
                        name: object.name, pos: position(object), energy: object.store?.energy || 0,
                        capacity: object.storeCapacity, working: state.working, fatigue: object.fatigue,
                        ticksToLive: object.ageTime === undefined ? undefined : object.ageTime - (memory.stats?.time || 0),
                        spawnRoom: state.spawnRoom, data: state.data, developmentHauler: state.developmentHauler,
                        plannedData: configs[object.name]?.data,
                    };
                }),
            plannedHaulers: Object.entries(configs).filter(([, config]) => config.role === 'filler')
                .map(([name, config]) => ({ name, data: config.data, development: config.development })),
            sources: objects.filter(object => object.type === 'source')
                .map(object => ({ id: object._id, pos: position(object), energy: object.energy,
                    capacity: object.energyCapacity, nextRegenerationTime: object.nextRegenerationTime })),
            containers: objects.filter(object => object.type === 'container')
                .map(object => ({ id: object._id, pos: position(object), energy: object.store?.energy || 0, capacity: object.storeCapacity })),
            drops: objects.filter(object => ['energy', 'resource'].includes(object.type) &&
                    (!object.resourceType || object.resourceType === 'energy'))
                .map(object => ({ id: object._id, pos: position(object), energy: object.energy ?? object.amount,
                    resourceType: object.resourceType || 'energy' })),
        };
    });
    console.log(JSON.stringify({ capturedAt: new Date().toISOString(), shard, tick: memory.stats?.time,
        cpu: memory.stats?.cpu, rooms: snapshots }));
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Official hauling diagnostics unavailable'); process.exitCode = 1; });
