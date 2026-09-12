#!/usr/bin/env node
// Simplest possible MCP server for testing

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server({
  name: 'test-simple',
  version: '1.0.0'
}, {
  capabilities: {
    tools: {}
  }
});

server.setRequestHandler('tools/list', async () => {
  return {
    tools: [{
      name: 'test_tool',
      description: 'A simple test tool',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    }]
  };
});

await server.connect(new StdioServerTransport());
console.error('Simple MCP server started');
