import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Bundle the MCP server into a single file
await build({
  entryPoints: [resolve(__dirname, '../../src/mcp.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: resolve(__dirname, 'dist/index.js'),
  external: [
    '@hiero-ledger/sdk',
    '@hiero-ledger/proto',
    '@modelcontextprotocol/sdk',
    '@x402/core',
    '@x402/fetch',
    '@x402/hedera',
    '@hashgraphonline/standards-sdk',
    'zod',
    'ws',
    'hono'
  ],
  banner: {
    js: '#!/usr/bin/env node'
  },
  minify: false,
  sourcemap: true
});

// Make the output executable
const outFile = resolve(__dirname, 'dist/index.js');
const content = readFileSync(outFile, 'utf8');
writeFileSync(outFile, content, { mode: 0o755 });

console.log('✅ MCP server built successfully');
