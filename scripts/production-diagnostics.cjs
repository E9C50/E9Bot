// Read-only live production inspection. Never print credentials or mutate game state.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { officialClient } = require('./official-client.cjs');
const positiveStore = store => store && Object.fromEntries(Object.entries(store).filter(([, amount]) => amount > 0));

async function main() {
    const shard = process.argv[2] || 'shard3';
    if (!/^shard[0-3]$/.test(shard)) throw new Error('Expected shard0..3');
    const client = await officialClient();
    const me = await client.request('/api/auth/me');
    const memory = await client.memory(shard);
    const rooms = await Promise.all(Object.keys(memory.stats?.rooms || {}).map(async name => {
        const response = await client.request('/api/game/room-objects', { room: name, shard });
        const objects = Object.values(response.objects || {});
        const controller = objects.find(o => o.type === 'controller');
        if (controller?.user !== (me._id || me.user?._id)) return null;
        const state = memory.rooms?.[name] || {};
        const structures = objects.filter(o => ['storage', 'terminal', 'factory', 'lab', 'mineral'].includes(o.type));
        const workers = objects.filter(o => o.type === 'creep' && ['manager', 'processer'].includes(memory.creeps?.[o.name]?.role));
        return { name, level: controller.level, powerEnabled: controller.isPowerEnabled,
            structures: structures.map(o => ({ id: o._id, type: o.type, x: o.x, y: o.y, store: positiveStore(o.store),
                mineralType: o.mineralType, mineralAmount: o.mineralAmount, level: o.level, cooldown: o.cooldown, effects: o.effects })),
            lab: state.roomLabConfig, factory: state.factoryProduction, reserves: state.productionReserve,
            boostNeed: state.boostNeed, fillJobs: state.roomFillJob, labJobs: state.labFillJob,
            terminalAmounts: state.terminalAmount, sendJobs: state.terminalSendJob,
            workers: workers.map(o => ({ name: o.name, x: o.x, y: o.y, store: positiveStore(o.store), body: o.body?.map(p => p.type), memory: memory.creeps[o.name] })),
            workerConfigs: Object.fromEntries(Object.entries(state.creepConfig || {}).filter(([, c]) => ['manager', 'processer'].includes(c.role))),
        };
    }));
    let version;
    if (process.argv.includes('--version')) {
        const branches = await client.request('/api/user/branches');
        const active = branches.list?.find(b => b.activeWorld);
        const branch = active?.branch || client.branch;
        const code = await client.request('/api/user/code', { branch });
        const main = code.modules?.main || '';
        const local = fs.readFileSync(path.resolve(__dirname, '../dist/main.js'), 'utf8');
        const hash = value => crypto.createHash('sha256').update(value).digest('hex');
        version = { branch, configuredBranch: client.branch, activeWorld: active?.activeWorld,
            onlineHash: hash(main), localHash: hash(local), matchesLocal: main === local,
            markers: Object.fromEntries(['productionReserve', 'factoryProduction', 'reactionAmount', 'terminalEnergyReserve'].map(s => [s, main.includes(s)])) };
    }
    console.log(JSON.stringify({ capturedAt: new Date().toISOString(), shard, tick: memory.stats?.time,
        cpu: memory.stats?.cpu, recovery: memory.cpuRecovery, version, rooms: rooms.filter(Boolean) }, null, 2));
}
main().catch(error => { console.error(error.message || 'Production diagnostics unavailable'); process.exitCode = 1; });
