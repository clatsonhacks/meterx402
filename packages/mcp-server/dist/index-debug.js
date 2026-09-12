#!/usr/bin/env node
import { writeFileSync, appendFileSync } from 'fs';
import { spawn } from 'child_process';

const logFile = 'C:\\Users\\abise\\mcp-debug.log';

function log(message) {
  const timestamp = new Date().toISOString();
  appendFileSync(logFile, `[${timestamp}] ${message}\n`);
}

try {
  writeFileSync(logFile, `=== MCP Server Debug Log ===\n`);
  log('Starting MCP server...');
  log(`HUB_URL: ${process.env.HUB_URL}`);
  log(`BUYER_ACCOUNT_ID: ${process.env.BUYER_ACCOUNT_ID}`);
  log(`CWD: ${process.cwd()}`);

  // Start the actual MCP server
  const server = spawn('node', ['./index.js'], {
    cwd: import.meta.dirname,
    env: process.env,
    stdio: ['inherit', 'inherit', 'inherit']
  });

  server.on('error', (err) => {
    log(`ERROR: ${err.message}`);
  });

  server.on('exit', (code) => {
    log(`Server exited with code: ${code}`);
  });

  log('Server process started');
} catch (error) {
  log(`FATAL ERROR: ${error.message}`);
  log(error.stack);
}
