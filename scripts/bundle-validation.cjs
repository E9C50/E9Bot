// Inspect JavaScript statically: never execute a bundle or load account settings.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function validateBundle(code, { allowedModules = ['main.js.map'], filename = 'main.js' } = {}) {
    if (typeof code !== 'string') throw new TypeError('Bundle code must be a string');
    // Keep the virtual source name platform-neutral; filename is only a label.
    const source = ts.createSourceFile('bundle.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (source.parseDiagnostics.length) {
        throw new Error(`Invalid bundle JavaScript: ${ts.flattenDiagnosticMessageText(source.parseDiagnostics[0].messageText, ' ')}`);
    }
    // A source-only program supplies lexical binding, including hoisted variables,
    // destructuring, catch bindings and nested function parameters named require.
    const host = {
        getSourceFile: name => name === source.fileName ? source : undefined,
        getDefaultLibFileName: () => '',
        writeFile() {},
        getCurrentDirectory: () => '',
        getDirectories: () => [],
        fileExists: name => name === source.fileName,
        readFile: name => name === source.fileName ? code : undefined,
        getCanonicalFileName: name => name,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => '\n',
    };
    const program = ts.createProgram([source.fileName], { allowJs: true, checkJs: true, noLib: true, noResolve: true }, host);
    const checker = program.getTypeChecker();
    const allowed = new Set(allowedModules);
    const dependencies = new Set();
    const errors = [];
    const location = node => {
        const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
        return `${filename}:${pos.line + 1}:${pos.character + 1}`;
    };
    const unparenthesized = node => {
        while (ts.isParenthesizedExpression(node)) node = node.expression;
        return node;
    };
    const visit = node => {
        if (ts.isCallExpression(node)) {
            const callee = unparenthesized(node.expression);
            // Deliberately inspect direct global calls only, not obj.require,
            // locally bound loaders, or aliases obtained through arbitrary code.
            // TypeScript synthesizes a CommonJS require symbol without a
            // declaration. Actual lexical bindings have source declarations.
            const binding = ts.isIdentifier(callee) && callee.text === 'require' ? checker.getSymbolAtLocation(callee) : undefined;
            if (ts.isIdentifier(callee) && callee.text === 'require' && !binding?.declarations?.length) {
                const argument = node.arguments.length === 1 ? unparenthesized(node.arguments[0]) : undefined;
                if (!argument || !(ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
                    errors.push(`${location(node)} dynamic global require cannot be validated`);
                } else {
                    dependencies.add(argument.text);
                    if (!allowed.has(argument.text)) errors.push(`${location(node)} undeployed module ${JSON.stringify(argument.text)}`);
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    if (errors.length) throw new Error(`Bundle module validation failed:\n${errors.join('\n')}`);
    return [...dependencies].sort();
}

module.exports = { validateBundle };

if (require.main === module) {
    try {
        const filename = path.resolve(process.argv[2] || path.join(__dirname, '../dist/main.js'));
        const requires = validateBundle(fs.readFileSync(filename, 'utf8'), { filename });
        console.log(JSON.stringify({ valid: true, requires }));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
