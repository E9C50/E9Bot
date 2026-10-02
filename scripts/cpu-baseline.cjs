// Official-server read-only diagnostics. Credentials stay in screeps.json/in-process.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const WebSocket = require('ws');

async function main() {
    const shard = process.argv.find(value => /^shard\d+$/.test(value)) || 'shard3';
    const duration = Math.min(300, Math.max(0, Number(process.argv.find(value => value.startsWith('--listen='))?.split('=')[1]) || 0));
    const account = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../screeps.json'), 'utf8')).main;
    if (!account || account.hostname !== 'screeps.com' || account.protocol !== 'https' || (account.path && account.path !== '/')) throw new Error('Official main profile required');
    let token = account.token;
    async function request(endpoint, params, body) {
        const url = new URL(endpoint, 'https://screeps.com');
        for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, value);
        const headers = token ? { 'X-Token': token, 'X-Username': token } : {};
        if (body) headers['Content-Type'] = 'application/json';
        const response = await fetch(url, { method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error(`Official API HTTP ${response.status}`);
        token = response.headers.get('x-token') || token;
        const data = await response.json();
        if (data.ok !== 1) throw new Error('Official API rejected request');
        return data;
    }
    if (!token) {
        const auth = await request('/api/auth/signin', undefined, { email: account.email, password: account.password });
        token = auth.token;
    }
    if (!token) throw new Error('Official authentication unavailable');
    const response = await request('/api/user/memory', { shard });
    const text = typeof response.data === 'string' && response.data.startsWith('gz:')
        ? zlib.gunzipSync(Buffer.from(response.data.slice(3), 'base64')).toString('utf8') : response.data;
    const memory = typeof text === 'string' ? JSON.parse(text) : text;
    const bytes = value => Buffer.byteLength(JSON.stringify(value ?? null));
    const rooms = Object.values(memory.rooms || {}), creeps = Object.values(memory.creeps || {});
    const roles = {};
    for (const creep of creeps) roles[creep.role || 'unknown'] = (roles[creep.role || 'unknown'] || 0) + 1;
    const intel = memory.shardPortalIntel || {};
    console.log(JSON.stringify({ capturedAt: new Date().toISOString(), shard,
        tick: memory.stats?.time, cpu: memory.stats?.cpu, memoryBytes: bytes(memory),
        sections: Object.entries(memory).map(([name, value]) => ({ name, bytes: bytes(value) })).sort((a, b) => b.bytes - a.bytes).slice(0, 12),
        rooms: rooms.length, ownedRoomStats: Object.keys(memory.stats?.rooms || {}).length, creepMemoryByRole: roles,
        portals: Object.keys(intel.portals || {}).length, scannedRooms: Object.keys(intel.scannedRooms || {}).length,
        terminalJobs: rooms.reduce((sum, room) => sum + Object.keys(room.terminalSendJob || {}).length, 0),
        blueprints: rooms.filter(room => room.roomBlueprint).length,
    }, null, 2));
    if (!duration) return;
    const me = await request('/api/auth/me');
    await new Promise((resolve, reject) => {
        const socket = new WebSocket('wss://screeps.com/socket/websocket');
        const reports = [];
        let observedErrors = 0;
        let authenticated = false;
        const timer = setTimeout(() => { socket.close(); finish(); }, duration * 1000);
        let finished = false;
        function finish() {
            if (finished) return;
            finished = true; clearTimeout(timer);
            console.log(JSON.stringify({ shard, authenticated, reportsCaptured: reports.length,
                observedErrors,
                lastReportSumAverage: reports.length ? Number(/sumAvg=([\d.]+)/.exec(reports[reports.length - 1])?.[1]) || null : null,
            }));
            resolve();
        }
        socket.addEventListener('open', () => socket.send(`auth ${token}`));
        socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Official diagnostics socket failed')); });
        socket.addEventListener('close', finish);
        socket.addEventListener('message', event => {
            const message = String(event.data);
            if (message.startsWith('auth ok')) {
                authenticated = true; socket.send('gzip off');
                socket.send(`subscribe user:${me._id}/console`);
            } else if (message.startsWith('auth failed')) {
                clearTimeout(timer); socket.close(); reject(new Error('Official diagnostics socket authentication failed'));
            } else if (message.startsWith('[')) {
                try {
                    const [channel, payload] = JSON.parse(message);
                    if (channel.endsWith('/console') && (payload.shard === shard || payload.shard === undefined)) {
                        for (const error of payload.messages?.error || []) {
                            observedErrors++;
                            console.log(JSON.stringify({ shard, error: String(error).slice(0, 600) }));
                        }
                        for (const log of payload.messages?.log || []) if (/CPU limit|timed out|TypeError|ReferenceError|^\[unit:|^\[stage:|^\[tick:/.test(String(log))) {
                            observedErrors++;
                            console.log(JSON.stringify({ shard, error: String(log).slice(0, 600) }));
                        }
                        for (const log of payload.messages?.log || []) if (String(log).startsWith(`[CPU][${shard}]`)) {
                            const decoded = String(log).replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
                            reports.push(decoded); console.log(decoded);
                        }
                    }
                } catch { /* Ignore unrelated socket traffic; never print raw responses. */ }
            }
        });
    });
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Official diagnostics unavailable'); process.exitCode = 1; });
