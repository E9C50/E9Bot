// Read-only official resource/production snapshot. Credentials remain inside official-client.
const { officialClient } = require('./official-client.cjs');
const T3 = ['XUH2O', 'XUHO2', 'XKH2O', 'XKHO2', 'XLH2O', 'XLHO2', 'XZH2O', 'XZHO2', 'XGH2O', 'XGHO2'];
const targets = Object.fromEntries([...T3.map(r => [r, 20000]), ...['H', 'O', 'U', 'L', 'K', 'Z', 'X', 'G'].map(r => [r, 10000]), ['ops', 5000]]);

async function main() {
    const specified = process.argv.slice(2);
    if (specified.some(s => !/^shard[0-3]$/.test(s))) throw new Error('Usage: node scripts/resource-diagnostics.cjs [shard0 shard1 shard2 shard3]');
    const shards = specified.length ? specified : ['shard0', 'shard1', 'shard2', 'shard3'];
    const client = await officialClient(), me = await client.request('/api/auth/me');
    const userId = me._id || me.user?._id;
    if (!userId) throw new Error('Cannot verify room ownership');
    const snapshots = await Promise.all(shards.map(async shard => {
        const memory = await client.memory(shard);
        const rooms = await Promise.all(Object.keys(memory.stats?.rooms || {}).map(async name => {
            const response = await client.request('/api/game/room-objects', { room: name, shard });
            const objects = Object.values(response.objects || {}), controller = objects.find(o => o.type === 'controller');
            const owned = controller?.user === userId;
            const stock = objects.filter(o => ['storage', 'terminal', 'factory', 'lab'].includes(o.type));
            const storage = stock.find(o => o.type === 'storage'), terminal = stock.find(o => o.type === 'terminal');
            const factory = stock.find(o => o.type === 'factory'), state = memory.rooms?.[name] || {};
            const resources = {};
            for (const object of stock) for (const [resource, amount] of Object.entries(object.store || {})) if (amount > 0)
                resources[resource] = (resources[resource] || 0) + amount;
            const warehouse = owned && !!controller?.isPowerEnabled && storage?.storeCapacity >= 8000000;
            return { name, owned, level: controller?.level || 0, warehouse, powerEnabled: !!controller?.isPowerEnabled,
                storageCapacity: storage?.storeCapacity, storageEnergy: storage?.store?.energy || 0,
                terminalEnergy: terminal?.store?.energy || 0, resources,
                shortages: owned && terminal && !warehouse ? Object.fromEntries(Object.entries(targets)
                    .filter(([r, target]) => (resources[r] || 0) < target).map(([r, target]) => [r, target - (resources[r] || 0)])) : {},
                jobs: state.terminalSendJob || {}, labReaction: state.roomLabConfig?.labReactionConfig,
                labPlan: state.roomLabConfig?.productionPlan, labCount: objects.filter(o => o.type === 'lab').length,
                factory: factory && { level: factory.level || 0, cooldown: factory.cooldown || 0, store: factory.store },
                factoryPlan: state.factoryProduction,
                managers: objects.filter(o => o.type === 'creep' && memory.creeps?.[o.name]?.role === 'manager')
                    .map(o => ({ name: o.name, bodyParts: o.body?.length || 0 })),
            };
        }));
        return { shard, tick: memory.stats?.time, legacyCenter: memory.centerStorage, rooms };
    }));
    console.log(JSON.stringify({ capturedAt: new Date().toISOString(), shards: snapshots }, null, 2));
}
main().catch(() => { console.error('Read-only resource diagnostics unavailable'); process.exitCode = 1; });
