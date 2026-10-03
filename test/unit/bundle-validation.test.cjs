const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { validateBundle } = require('../../scripts/bundle-validation.cjs');

test('rejects unbundled Node builtins and project modules before deployment', () => {
    for (const name of ['console/help', 'console', 'node:fs', 'runtime/consoleHelp', 'source-map', 'missing']) {
        assert.throws(() => validateBundle(`const dependency = require(${JSON.stringify(name)});`), /undeployed module/);
    }
});

test('allows the deployable source-map module and returns unique dependencies', () => {
    assert.deepEqual(validateBundle('require("main.js.map"); require(`main.js.map`);'), ['main.js.map']);
    assert.deepEqual(validateBundle('exports.loop = () => {};'), []);
    assert.deepEqual(validateBundle('require("worker");', { allowedModules: ['worker'] }), ['worker']);
    assert.deepEqual(validateBundle('require("main.js.map");', { filename: 'C:\\workspace\\dist\\main.js' }), ['main.js.map']);
});

test('ignores properties, strings and comments that resemble global require', () => {
    const code = 'obj.require("console/help"); obj["require"]("missing"); ' +
        'const text = "require(\\"missing\\")"; /* require("missing") */ // require("missing")\n';
    assert.deepEqual(validateBundle(code), []);
});

test('uses lexical binding to ignore shadowed require without hiding outside calls', () => {
    const code = `
        function parameter(require) { require("console/help"); }
        function hoisted() { require("console/help"); var require; }
        function destructured({require}) { require("console/help"); }
        function nested(require) { return () => require("console/help"); }
        { require("console/help"); let require; }
        try {} catch (require) { require("console/help"); }
        require("main.js.map");
    `;
    assert.deepEqual(validateBundle(code), ['main.js.map']);
    assert.throws(() => validateBundle('function nested(require) { require("local"); } require("console/help");'), /undeployed module/);
    assert.deepEqual(validateBundle('const require = localLoader; require("console/help");'), []);
});

test('rejects dynamic global require and checks parenthesized calls', () => {
    for (const code of ['require(name);', 'require("main.js." + "map");', 'require();', 'require("main.js.map", extra);']) {
        assert.throws(() => validateBundle(code), /dynamic global require/);
    }
    assert.throws(() => validateBundle('(require)("console/help");'), /undeployed module/);
    assert.deepEqual(validateBundle('(require)(("main.js.map"));'), ['main.js.map']);
});

test('only parses code and reports syntax errors without executing side effects', () => {
    assert.deepEqual(validateBundle('throw new Error("must not run"); require("main.js.map");'), ['main.js.map']);
    assert.throws(() => validateBundle('function {'), /Invalid bundle JavaScript/);
});

test('official upload rejects missing modules before account access or any request', async () => {
    const scripts = path.resolve(__dirname, '../../scripts');
    const uploader = fs.readFileSync(path.join(scripts, 'official-upload.cjs'), 'utf8');
    async function attempt(bundle) {
        let accountAccesses = 0;
        const errors = [];
        const processState = { argv: ['node', 'official-upload.cjs', '--upload'], exitCode: 0 };
        vm.runInNewContext(uploader, {
            __dirname: scripts,
            process: processState,
            console: { log() {}, error: message => errors.push(message) },
            require(name) {
                if (name === 'node:fs') return { readFileSync(file) {
                    if (file.endsWith('main.js')) return bundle;
                    if (file.endsWith('main.js.map')) return '{}';
                    throw new Error('Unexpected file access');
                } };
                if (name === './official-client.cjs') return { async officialClient() {
                    accountAccesses++;
                    throw new Error('Mock account access reached');
                } };
                if (name === './bundle-validation.cjs') return { validateBundle };
                if (name === 'node:path' || name === 'node:crypto') return require(name);
                throw new Error('Unexpected require');
            },
        });
        await new Promise(resolve => setImmediate(resolve));
        return { accountAccesses, errors, exitCode: processState.exitCode };
    }
    const rejected = await attempt('require("console/help");');
    assert.equal(rejected.accountAccesses, 0);
    assert.equal(rejected.exitCode, 1);
    assert.match(rejected.errors[0], /undeployed module/);
    const accepted = await attempt('require("main.js.map");');
    assert.equal(accepted.accountAccesses, 1);
    assert.match(accepted.errors[0], /Mock account access reached/);
});
