// Reviewed bundler options only. Runtime secrets are never substituted into
// source: no define/inject/env plugin, no .env loader, and no source maps.
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] || '');
const staging = path.dirname(output);
if (path.basename(output) !== '_worker.js' || path.dirname(staging) !== root ||
    !path.basename(staging).startsWith('.pages-build-')) {
  console.error('Worker output must be inside the project build staging directory.');
  process.exitCode = 1;
} else {
  try {
    const {build} = await import('esbuild');
    await build({
      absWorkingDir: root,
      entryPoints: ['cloudflare/edge-worker.mjs'],
      outfile: output,
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      sourcemap: false,
      legalComments: 'none',
      logLevel: 'silent',
    });
  } catch {
    console.error('Worker bundle failed. Check source imports and locked build dependencies.');
    process.exitCode = 1;
  }
}
