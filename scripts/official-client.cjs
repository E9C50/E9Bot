// Keep credentials and authentication responses in process; never log them.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

async function officialClient() {
    const account = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../screeps.json'), 'utf8')).main;
    if (!account || account.hostname !== 'screeps.com' || account.protocol !== 'https' || (account.path && account.path !== '/')) throw new Error('Official main profile required');
    let token = account.token;
    async function request(endpoint, params, body) {
        const url = new URL(endpoint, 'https://screeps.com');
        for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, String(value));
        const headers = token ? { 'X-Token': token, 'X-Username': token } : {};
        if (body) headers['Content-Type'] = 'application/json';
        let response;
        try {
            // Bundled code plus source maps can exceed the ordinary small API response budget.
            response = await fetch(url, { method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body),
                signal: AbortSignal.timeout(endpoint === '/api/user/code' ? 180000 : 20000) });
        } catch { throw new Error('Official API connection failed'); }
        if (!response.ok) throw new Error(`Official API HTTP ${response.status}`);
        token = response.headers.get('x-token') || token;
        const data = await response.json();
        if (data.ok !== 1) throw new Error('Official API rejected request' +
            (endpoint === '/api/user/console' && typeof data.error === 'string' ? ': ' + data.error.slice(0, 120) : ''));
        return data;
    }
    if (!token) token = (await request('/api/auth/signin', undefined, { email: account.email, password: account.password })).token;
    if (!token) throw new Error('Official authentication unavailable');
    async function memory(shard) {
        const response = await request('/api/user/memory', { shard });
        const value = typeof response.data === 'string' && response.data.startsWith('gz:')
            ? zlib.gunzipSync(Buffer.from(response.data.slice(3), 'base64')).toString('utf8') : response.data;
        return typeof value === 'string' ? JSON.parse(value) : value;
    }
    return { request, memory, branch: account.branch || 'default', getToken: () => token };
}

module.exports = { officialClient };
