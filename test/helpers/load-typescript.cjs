const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

/**
 * Load source modules in an isolated Screeps world without bundling or uploading.
 * Each test owns its module cache, Memory, Game, and dependency substitutes.
 */
function createSourceLoader({ globals = {}, modules = {} } = {}) {
    const sourceRoot = path.resolve(__dirname, '../../src');
    const cache = new Map();
    const context = vm.createContext({ console, ...globals });
    context.global = context;

    function resolveSource(specifier, parent) {
        const candidate = specifier.startsWith('.')
            ? path.resolve(path.dirname(parent), specifier)
            : path.resolve(sourceRoot, specifier);
        return [candidate, `${candidate}.ts`, path.join(candidate, 'index.ts')]
            .find(file => fs.existsSync(file) && fs.statSync(file).isFile());
    }

    function load(file) {
        const absoluteFile = path.resolve(file);
        if (cache.has(absoluteFile)) return cache.get(absoluteFile).exports;
        const module = { exports: {} };
        cache.set(absoluteFile, module);
        const javascript = ts.transpileModule(fs.readFileSync(absoluteFile, 'utf8'), {
            fileName: absoluteFile,
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2018,
                experimentalDecorators: true,
                esModuleInterop: true
            }
        }).outputText;
        const sourceRequire = specifier => {
            if (Object.prototype.hasOwnProperty.call(modules, specifier)) return modules[specifier];
            const sourceFile = resolveSource(specifier, absoluteFile);
            return sourceFile ? load(sourceFile) : require(specifier);
        };
        const wrapper = new vm.Script(`(function (exports, require, module, __filename, __dirname) {\n${javascript}\n})`, {
            filename: absoluteFile
        }).runInContext(context);
        wrapper(module.exports, sourceRequire, module, absoluteFile, path.dirname(absoluteFile));
        return module.exports;
    }

    return {
        load: specifier => {
            const file = resolveSource(specifier, path.join(sourceRoot, 'main.ts'));
            if (!file) throw new Error(`Source module not found: ${specifier}`);
            return load(file);
        },
        globals: context
    };
}

module.exports = { createSourceLoader };
