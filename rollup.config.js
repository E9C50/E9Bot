"use strict";

import typescript from 'rollup-plugin-typescript2';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';

import copy from 'rollup-plugin-copy'
import clear from 'rollup-plugin-clear';
import screeps from 'rollup-plugin-screeps';
const { validateBundle } = require('./scripts/bundle-validation.cjs');

let cfg;
// 普通 build 是纯本地构建，即使环境中遗留 DEST 也不会上传或复制。
const buildOnly = process.env.SCREEPS_BUILD_ONLY === 'true';
const copyLocal = !buildOnly && process.env.COPY_LOCAL === 'true';
const localScriptsDirectory = process.env.SCREEPS_LOCAL_SCRIPTS;
if (copyLocal && !localScriptsDirectory) {
  throw new Error('Set SCREEPS_LOCAL_SCRIPTS before running copy-local');
}
const dest = buildOnly || copyLocal ? undefined : process.env.DEST;
if (!dest) {
  console.log("No destination specified - code will be compiled but not uploaded");
} else if ((cfg = require("./screeps.json")[dest]) == null) {
  throw new Error("Invalid upload destination");
}

export default {
  input: "src/main.ts",
  output: {
    format: "cjs",
    file: "dist/main.js",
    sourcemap: true,
  },

  plugins: [
    clear({ targets: ["dist"] }),
    // 旧解析插件遇到 jssha 的双模块声明入口时，显式使用运行时代码。
    {
      name: 'jssha-runtime',
      resolveId(id) {
        if (id === 'jssha') return require.resolve('jssha');
      }
    },
    resolve({ rootDir: "src" }),

    commonjs(),
    // 显式匹配扩展名，避免默认 extglob 过滤器漏掉 TypeScript 文件。
    typescript({ include: /\.tsx?$/, exclude: /\.d\.ts$/ }),

    terser(),

    {
      name: 'screeps-module-validation',
      generateBundle(_options, bundle) {
        for (const artifact of Object.values(bundle)) {
          if (artifact.type === 'chunk') validateBundle(artifact.code, { filename: artifact.fileName });
        }
      }
    },

    ...(cfg ? [screeps({ config: cfg })] : []),

    ...(copyLocal ? [copy({
      targets: [
        {
          src: 'dist/main.js',
          dest: localScriptsDirectory,
        },
        {
          src: 'dist/main.js.map',
          dest: localScriptsDirectory,
          rename: name => name + '.map.js',
          transform: contents => `module.exports = ${contents.toString()};`
        }
      ],
      hook: 'writeBundle',
      verbose: true
    })] : [])
  ]
}
