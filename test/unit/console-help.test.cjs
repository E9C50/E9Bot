const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');
const { createSourceLoader } = require('../helpers/load-typescript.cjs');

const sourceRoot = path.resolve(__dirname, '../../src');
function source(file) {
    const full = path.join(sourceRoot, file);
    return ts.createSourceFile(full, fs.readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true);
}
function findNode(file, predicate) {
    let result;
    const visit = node => {
        if (result) return;
        if (predicate(node)) result = node;
        else ts.forEachChild(node, visit);
    };
    visit(file);
    assert.ok(result, 'Expected source node missing');
    return result;
}
// Read actual literal settings without evaluating unrelated native-resource constants.
function literalSetting(file, name) {
    const ast = source(file);
    const declaration = findNode(ast, node => ts.isVariableDeclaration(node) && node.name.getText(ast) === name);
    return vm.runInNewContext(`(${declaration.initializer.getText(ast)})`);
}
function failAction() { throw new Error('help executed an application action'); }
const deniedWorld = new Proxy({}, { get() { throw new Error('help read live Game/Memory'); }, set: failAction });
function world() {
    const modules = {
        'settings/roomPolicy': { roomPolicy: literalSetting('settings/roomPolicy.ts', 'roomPolicy') },
        'settings/creep': { spawnPriority: literalSetting('settings/creep.ts', 'spawnPriority') },
        'settings/structures': { structurePolicy: {} },
        'settings/labs': { reactionSource: {} },
        'shard/controller': { createShardTask: failAction, listShardTasks: failAction, listShardPortals: failAction, setShardTaskState: failAction },
        'runtime/profiling': { getCpuProfile: failAction, getCpuProfileWindow: failAction, resetCpuProfile: failAction },
        'creep/bodyConsole': { configureBody: failAction, previewBodies: failAction },
        'combat/missions': { createCombatTask: failAction, listCombatTasks: failAction, cancelCombatTask: failAction },
        'creep/haulerRelay': { getHaulerRelayStatus: failAction },
    };
    const loader = createSourceLoader({ globals: { Game: deniedWorld, Memory: deniedWorld }, modules });
    const catalog = loader.load('console/help');
    const ConsoleExtension = loader.load('mount/extension/ConsoleExtension').default;
    return { ...catalog, console: new ConsoleExtension(), policy: modules['settings/roomPolicy'].roomPolicy };
}

test('every mounted business command has one help entry and a working individual lookup', () => {
    const { helpSections, console } = world();
    const ast = source('mount/extension/ConsoleExtension.ts');
    const klass = findNode(ast, ts.isClassDeclaration);
    const names = klass.members.filter(ts.isMethodDeclaration).map(node => node.name.getText(ast));
    const entries = helpSections.flatMap(section => section.entries);
    assert.ok(names.length >= 24);
    for (const name of names) {
        const matches = entries.filter(entry => entry.name === name);
        assert.equal(matches.length, 1, `${name} must be documented exactly once`);
        const detailed = console.help(name, 'text');
        assert.ok(detailed.includes(matches[0].signature));
        assert.ok(!detailed.includes('未找到'), `${name} cannot be queried`);
    }
    assert.ok(console.help().startsWith('<div'));
});

test('all configured flags and every public BetterMove callable are inventoried', () => {
    const { helpSections, policy, renderHelp } = world();
    const flags = helpSections.find(section => section.topic === 'flags').entries;
    for (const name of Object.values(policy.flags)) {
        assert.equal(flags.filter(entry => entry.name === name).length, 1, name);
        assert.ok(renderHelp(name, 'text').includes(name));
    }
    const ast = source('utils/BetterMove.ts');
    const assignment = findNode(ast, node => ts.isBinaryExpression(node) && node.left.getText(ast) === 'global.BetterMove');
    const names = assignment.right.properties.filter(node => ts.isMethodDeclaration(node) ||
        ts.isPropertyAssignment(node) && ts.isArrowFunction(node.initializer)).map(node => node.name.getText(ast));
    const entries = helpSections.find(section => section.topic === 'movement').entries;
    assert.equal(entries.length, names.length);
    for (const name of names) assert.ok(entries.some(entry => entry.name === `BetterMove.${name}`), name);
});

test('task and body option descriptions cover their actual input interfaces', () => {
    const { helpSections } = world();
    const entries = helpSections.flatMap(section => section.entries);
    for (const [file, interfaceName, command] of [
        ['shard/missions.ts', 'ShardTaskInput', 'shardTask'],
        ['combat/types.ts', 'CombatTaskOptions', 'combatTask'],
        ['interface/creeps.ts', 'CreepBodyProfile', 'bodyConfig'],
    ]) {
        const ast = source(file);
        const input = findNode(ast, node => ts.isInterfaceDeclaration(node) && node.name.text === interfaceName);
        const entry = entries.find(entry => entry.name === command);
        const text = [entry.signature, entry.summary, ...(entry.details || [])].join('\n');
        for (const member of input.members.filter(ts.isPropertySignature)) {
            assert.ok(text.includes(member.name.getText(ast)), `${command} missing option ${member.name.getText(ast)}`);
        }
    }
});

test('resource display helpers remain covered as the mounted helper object evolves', () => {
    const { helpSections } = world();
    const entries = helpSections.flatMap(section => section.entries);
    const ast = source('utils/RoomResource.ts');
    const pro = findNode(ast, node => ts.isVariableDeclaration(node) && node.name.getText(ast) === 'pro');
    const names = pro.initializer.properties.filter(node => ts.isMethodDeclaration(node) ||
        ts.isPropertyAssignment(node) && ts.isArrowFunction(node.initializer)).map(node => node.name.getText(ast));
    for (const name of names) assert.ok(entries.some(entry => entry.name === `HelperRoomResource.${name}`), name);
});

test('overview includes the complete inventory and details remain queryable without live world access', () => {
    const { helpSections, renderHelp } = world();
    const overview = renderHelp(undefined, 'text');
    for (const section of helpSections) {
        assert.ok(overview.includes(`help("${section.topic}")`));
        const detailed = renderHelp(section.topic === 'overview' ? '帮助' : section.topic, 'text');
        for (const entry of section.entries) {
            assert.ok(overview.includes(entry.signature));
            assert.ok(detailed.includes(entry.signature));
            for (const example of entry.examples || []) assert.ok(detailed.includes(example));
        }
    }
    assert.equal(renderHelp('全部', 'text'), renderHelp('all', 'text'));
    assert.equal(renderHelp('  旗子  ', 'text'), renderHelp('flags', 'text'));
    assert.equal(renderHelp('SHARDTASK', 'text'), renderHelp('shardTask', 'text'));
    assert.equal(renderHelp('E31N2_OUT0', 'text'), renderHelp('OUT', 'text'));
    assert.equal(renderHelp('E31N2_RF_T19', 'text'), renderHelp('RF', 'text'));
    assert.equal(renderHelp('PC_myPowerCreep', 'text'), renderHelp('PC', 'text'));
});

test('help examples are valid JavaScript and merely displayed even for demolition and launching', () => {
    const { helpSections, console } = world();
    for (const section of helpSections) for (const entry of section.entries) for (const example of entry.examples || []) {
        assert.doesNotThrow(() => new vm.Script(example), `${entry.name}: ${example}`);
    }
    assert.ok(console.help('removeWalls', 'text').includes('removeWalls("E31N2")'));
    assert.ok(console.help('launchNuke', 'text').includes('Game.rooms.E31N2.launchNuke()'));
    assert.ok(console.help('all', 'text').includes('占领'));
});

test('HTML escapes names and code, invalid topic input cannot inject HTML or execute a command', () => {
    const { renderHelp } = world();
    const html = renderHelp('all');
    assert.ok(html.includes('&lt;home&gt;'));
    assert.ok(html.includes('&quot;E31N2&quot;'));
    assert.ok(!html.includes('<home>'));
    assert.ok(!/<script\b|on\w+=|javascript:/i.test(html));
    for (const query of ['__proto__', 'constructor', 'toString', '<script>alert(1)</script>', 'x'.repeat(100000), 42, {}, null]) {
        const result = renderHelp(query);
        assert.ok(result.startsWith('<div'));
        assert.ok(!result.includes('<script>'));
        assert.ok(result.length < 25000);
    }
});

test('actual configured flag names and index bounds flow into help instead of staying hardcoded', () => {
    const roomPolicy = literalSetting('settings/roomPolicy.ts', 'roomPolicy');
    roomPolicy.flags.layoutPreview = 'previewCustom';
    const populationPolicy = literalSetting('settings/population.ts', 'populationPolicy');
    populationPolicy.maximumRemoteRooms = 4;
    populationPolicy.maximumJobFlags = 6;
    const loader = createSourceLoader({ modules: {
        'settings/roomPolicy': { roomPolicy },
        'settings/population': { populationPolicy },
        'settings/creep': { spawnPriority: literalSetting('settings/creep.ts', 'spawnPriority') },
    } });
    const { renderHelp } = loader.load('console/help');
    assert.ok(renderHelp('previewCustom', 'text').includes('createFlag("previewCustom")'));
    assert.ok(renderHelp('OUT', 'text').includes('i=0..3'));
    assert.ok(renderHelp('RF', 'text').includes('i=0..5'));
    assert.ok(renderHelp('RB', 'text').includes('i=0..5'));
});
