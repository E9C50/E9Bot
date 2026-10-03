// Explicit --upload is required. Print only module names, hashes and verification.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { officialClient } = require('./official-client.cjs');
const { validateBundle } = require('./bundle-validation.cjs');
const hash = text => createHash('sha256').update(text).digest('hex');

async function main() {
    const code = fs.readFileSync(path.resolve(__dirname, '../dist/main.js'), 'utf8');
    const sourceMap = fs.readFileSync(path.resolve(__dirname, '../dist/main.js.map'), 'utf8');
    JSON.parse(sourceMap);
    const modules = { main: code, 'main.js.map': `module.exports = ${sourceMap};` };
    validateBundle(code);
    const client = await officialClient();
    const branches = await client.request('/api/user/branches');
    const branch = branches.list?.find(value => value.branch === client.branch);
    if (!branch) throw new Error('Configured official branch does not exist');
    const before = await client.request('/api/user/code', { branch: client.branch });
    if (!before.modules || typeof before.modules !== 'object') throw new Error('Official module list unavailable');
    const upload = process.argv.includes('--upload');
    console.log(JSON.stringify({ branch: client.branch, activeWorld: branch.activeWorld, upload, modules: Object.keys(modules), previousMainHash: typeof before.modules.main === 'string' ? hash(before.modules.main) : null, localMainHash: hash(code) }));
    if (!upload) {
        console.log(JSON.stringify({ branch: client.branch, verified: Object.entries(modules).every(([name, content]) => before.modules[name] === content) }));
        return;
    }
    await client.request('/api/user/code', undefined, { branch: client.branch, modules: { ...before.modules, ...modules }, _hash: Date.now() });
    const after = await client.request('/api/user/code', { branch: client.branch });
    const verified = Object.entries(modules).every(([name, content]) => after.modules?.[name] === content);
    if (!verified) throw new Error('Official upload verification failed');
    console.log(JSON.stringify({ branch: client.branch, verified, mainHash: hash(after.modules.main), preservedOtherModules: Object.keys(before.modules).filter(name => !Object.hasOwn(modules, name)).length }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
