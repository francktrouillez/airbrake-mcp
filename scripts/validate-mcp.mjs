#!/usr/bin/env node
// Validate the built MCP server against MCP / Claude tool-schema constraints.
//
// Spawns `dist/bin.js` as a child process, performs the MCP handshake,
// requests `tools/list`, and checks every tool's `inputSchema` for:
//   1. top-level `type: "object"`
//   2. no top-level `anyOf` / `oneOf` / `allOf` / `$ref`
//   3. `properties` is an object when present
//   4. `required`, if present, is a string[]
//
// Exit codes: 0 = all tools valid, 1 = validation failures, 2 = setup error.
//
// Usage: node scripts/validate-mcp.mjs [expectedToolCount]

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.resolve(__dirname, '..', 'dist', 'bin.js');
const RPC_TIMEOUT_MS = 5000;

const expectedCount = process.argv[2] ? Number(process.argv[2]) : null;

function validateSchema(schema) {
  const issues = [];
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    issues.push('inputSchema is not a JSON object');
    return issues;
  }
  if (schema.type !== 'object') {
    issues.push(`top-level type must be "object" (got ${JSON.stringify(schema.type)})`);
  }
  for (const forbidden of ['anyOf', 'oneOf', 'allOf', '$ref']) {
    if (forbidden in schema) {
      issues.push(`top-level "${forbidden}" is not allowed by MCP`);
    }
  }
  if ('properties' in schema) {
    const p = schema.properties;
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      issues.push('"properties" must be a JSON object when present');
    }
  }
  if ('required' in schema) {
    const r = schema.required;
    if (!Array.isArray(r) || r.some((x) => typeof x !== 'string')) {
      issues.push('"required" must be an array of strings');
    }
  }
  return issues;
}

class RpcClient {
  constructor(child) {
    this.child = child;
    this.buffer = '';
    this.waiters = new Map();
    child.stdout.on('data', (chunk) => this._onData(chunk));
    child.on('exit', (code, signal) => {
      const err = new Error(`server exited unexpectedly (code=${code}, signal=${signal})`);
      for (const { reject, timer } of this.waiters.values()) {
        clearTimeout(timer);
        reject(err);
      }
      this.waiters.clear();
    });
  }

  _onData(chunk) {
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && this.waiters.has(msg.id)) {
        const { resolve, timer } = this.waiters.get(msg.id);
        clearTimeout(timer);
        this.waiters.delete(msg.id);
        resolve(msg);
      }
    }
  }

  call(method, params, id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`RPC timeout: ${method} (id ${id})`));
      }, RPC_TIMEOUT_MS);
      this.waiters.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
}

async function main() {
  const child = spawn('node', [SERVER_PATH], {
    env: { ...process.env, AIRBRAKE_USER_TOKEN: 'validate' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const rpc = new RpcClient(child);
  try {
    const init = await rpc.call(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'validate-mcp', version: '0.1.0' },
      },
      1,
    );
    if (init.error) throw new Error(`initialize: ${JSON.stringify(init.error)}`);
    rpc.notify('notifications/initialized');

    const list = await rpc.call('tools/list', {}, 2);
    if (list.error) throw new Error(`tools/list: ${JSON.stringify(list.error)}`);
    const tools = list.result?.tools;
    if (!Array.isArray(tools)) throw new Error('tools/list returned no tools array');

    let failures = 0;
    for (const t of tools) {
      const issues = validateSchema(t.inputSchema);
      if (issues.length) {
        console.error(`✗ ${t.name}`);
        for (const i of issues) console.error(`    - ${i}`);
        failures++;
      } else {
        console.log(`✓ ${t.name}`);
      }
    }

    console.log(`\n${tools.length - failures}/${tools.length} tools valid`);
    if (expectedCount !== null && tools.length !== expectedCount) {
      console.error(`expected ${expectedCount} tools, got ${tools.length}`);
      failures++;
    }
    process.exit(failures === 0 ? 0 : 1);
  } catch (err) {
    console.error('validator error:', err instanceof Error ? err.message : String(err));
    process.exit(2);
  } finally {
    child.kill();
  }
}

main();
