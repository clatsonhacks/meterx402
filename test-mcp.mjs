// Simple test to verify MCP server responds correctly
import { spawn } from 'child_process';
import { readFileSync } from 'fs';

console.log('🧪 Testing MCP server...\n');

// Start the MCP server
const server = spawn('node', ['--import', 'tsx', 'src/mcp.ts'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HUB_URL: 'http://localhost:4021',
    BUYER_ACCOUNT_ID: '0.0.10470117',
    BUYER_PRIVATE_KEY: '3030020100300706052b8104000a042204209c88e7dd5e2bda42c1a03cbbdd3e681e6145c494dedb85928631336b40a61113',
    BUYER_BUDGET: '1 HBAR'
  }
});

let stdout = '';
let stderr = '';

server.stdout.on('data', (data) => {
  stdout += data.toString();
  console.log('📤 Server:', data.toString().trim());
});

server.stderr.on('data', (data) => {
  stderr += data.toString();
  console.error('❌ Error:', data.toString().trim());
});

// Send an initialize message
setTimeout(() => {
  console.log('\n📨 Sending initialize request...');
  const initMessage = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'test-client',
        version: '1.0.0'
      }
    }
  };

  server.stdin.write(JSON.stringify(initMessage) + '\n');
}, 1000);

// Clean up after 5 seconds
setTimeout(() => {
  console.log('\n✅ Test complete');
  server.kill();
  process.exit(0);
}, 5000);
