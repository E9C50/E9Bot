// Read-only official diagnostics; credentials and full Memory remain in-process.
const { officialClient } = require('./official-client.cjs');

async function main() {
    const shard = process.argv[2] || 'shard1';
    if (!/^shard\d+$/.test(shard)) throw new Error('Expected shard name');
    const client = await officialClient();
    const memory = await client.memory(shard);
    const rooms = Object.entries(memory.stats?.rooms || {}).map(([name, stats]) => {
        const state = memory.rooms?.[name] || {};
        const configs = Object.values(state.creepConfig || {});
        const roles = {};
        for (const config of configs) roles[config.role] = (roles[config.role] || 0) + 1;
        const remote = state.developmentRemotes;
        return { name, level: stats.controllerLevel, progress: stats.controllerProgress,
            capacity: stats.energyCapacityAvailable, storageEnergy: stats.storageEnergy,
            fastUpgrade: state.fastUpgrade !== false, demandByRole: roles,
            developmentDemands: configs.filter(config => config.development).length,
            automaticRemotes: remote && { enabled: remote.enabled !== false, selectedRooms: remote.selectedRooms,
                scoutTarget: remote.scoutTarget, intel: Object.entries(remote.intel || {}).map(([room, intel]) =>
                    ({ room, status: intel.status, age: memory.stats.time - intel.seenAt,
                        sources: intel.sources?.map(source => ({ id: source.id, travelTicks: source.travelTicks, energyPerTick: source.energyPerTick })) })) } };
    });
    console.log(JSON.stringify({ capturedAt: new Date().toISOString(), shard, tick: memory.stats?.time,
        cpu: memory.stats?.cpu, rooms }, null, 2));
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Official diagnostics unavailable'); process.exitCode = 1; });
