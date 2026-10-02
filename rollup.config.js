"use strict";

import typescript from 'rollup-plugin-typescript2';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';

import copy from 'rollup-plugin-copy'
import clear from 'rollup-plugin-clear';
import screeps from 'rollup-plugin-screeps';

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
    resolve({ rootDir: "src" }),

    commonjs(),
    typescript(),

    terser(),

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
