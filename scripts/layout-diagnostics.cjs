// Read-only official room snapshot. Authentication and unrelated Memory stay in process.
const { officialClient } = require('./official-client.cjs');

async function main() {
    const shard = process.argv.find(value => /^shard\d+$/.test(value)) || 'shard1';
    const roomName = process.argv.find(value => /^[WE]\d+[NS]\d+$/.test(value));
    if (!roomName) throw new Error('Usage: node scripts/layout-diagnostics.cjs shard1 E39N5');
    const client = await officialClient();
    const [memory, response] = await Promise.all([
        client.memory(shard), client.request('/api/game/room-objects', { room: roomName, shard }),
    ]);
    const roomMemory = memory.rooms?.[roomName] || {};
    const blueprint = roomMemory.roomBlueprint;
    const objects = Object.values(response.objects || {});
    const controller = objects.find(value => value.type === 'controller');
    const roomStats = memory.stats?.rooms?.[roomName];
    console.log(JSON.stringify({
        capturedAt: new Date().toISOString(), shard, roomName, tick: memory.stats?.time,
        cpu: memory.stats?.cpu, controller: controller && {
            level: controller.level, progress: controller.progress, x: controller.x, y: controller.y,
            progressTotal: controller.progressTotal || roomStats?.controllerProgressTotal,
        }, autoLayout: roomMemory.autoLaylout !== false, state: roomMemory.roomBlueprintState,
        blueprint: blueprint && {
            origin: blueprint.origin, createdAt: blueprint.createdAt,
            controllerContainer: blueprint.controllerContainer,
            containers: blueprint.structures?.container,
            counts: Object.fromEntries(Object.entries(blueprint.structures || {}).map(([type, positions]) => [type, positions.length])),
        },
        spawns: objects.filter(value => value.type === 'spawn').map(value => ({ name: value.name, x: value.x, y: value.y })),
        containers: objects.filter(value => value.type === 'container').map(value => ({ x: value.x, y: value.y, energy: value.store?.energy || 0 })),
        sites: objects.filter(value => value.type === 'constructionSite').map(value => ({
            type: value.structureType, x: value.x, y: value.y, progress: value.progress, progressTotal: value.progressTotal,
        })),
        workers: objects.filter(value => value.type === 'creep').map(value => ({
            name: value.name, role: memory.creeps?.[value.name]?.role, x: value.x, y: value.y,
        })),
    }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
