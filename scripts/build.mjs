import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/index.mjs'], outfile: 'dist/index.js', bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external', sourcemap: true });
await build({ entryPoints: ['src/client.jsx'], outfile: 'dist/client.js', bundle: true, platform: 'browser', target: 'es2022', format: 'cjs', external: ['react', 'react-dom', 'react/jsx-runtime'], sourcemap: true,
  banner: { js: "window.__ModuleLoader__.load({ id: 'dsh-context-snapshot', factory: (require) => { var module = { exports: {} }; var exports = module.exports;" },
  footer: { js: 'return module.exports; } });' } });
