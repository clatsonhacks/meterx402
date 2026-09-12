import { build } from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Build the server
await build({
  entryPoints: [resolve(__dirname, 'src/server.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: resolve(__dirname, 'dist/server.js'),
  external: ['@hono/node-server', 'hono'],
  minify: false,
  sourcemap: true
});

console.log('✅ Universal connector built successfully');
