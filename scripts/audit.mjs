#!/usr/bin/env node
// CI dependency audit gate. Rules: README → "Dependency audit"; logic:
// scripts/audit-policy.mjs. Audits the lockfile only (--package-lock-only), so
// CI runs it before `npm ci` and no dependency code can tamper with it.
//
// Usage: node scripts/audit.mjs [--allowlist <file>]
//   Test-only: [--full <file>] [--runtime <file>] [--today YYYY-MM-DD]
// Exit codes: 0 = pass, 1 = policy failure, 2 = could not run the audit.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { evaluate, formatResult, parseAllowlist } from './audit-policy.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const AUDIT_TIMEOUT_MS = 120_000;

// Pin every dependency type explicitly: NODE_ENV=production, .npmrc `omit`,
// or npm_config_omit would otherwise silently shrink what gets audited.
export const AUDIT_ARGS = Object.freeze({
  full: [
    'audit',
    '--json',
    '--package-lock-only',
    '--include=dev',
    '--include=optional',
    '--include=peer',
  ],
  runtime: [
    'audit',
    '--json',
    '--package-lock-only',
    '--omit=dev',
    '--include=optional',
    '--include=peer',
  ],
});

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

// `npm audit` exits non-zero whenever it finds anything, so judge success by
// whether stdout is JSON rather than by the exit status.
function runNpmAudit(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', args, {
      cwd: ROOT,
      timeout: AUDIT_TIMEOUT_MS,
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (err) =>
      reject(new Error(`npm ${args.join(' ')} failed to run: ${err.message}`)),
    );
    child.on('close', (code, signal) => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(
          new Error(
            `npm ${args.join(' ')} produced no JSON (exit ${code ?? signal}): ${stderr.slice(0, 500)}`,
          ),
        );
      }
    });
  });
}

async function main() {
  try {
    const { values } = parseArgs({
      strict: true,
      options: {
        allowlist: { type: 'string', default: `${ROOT}audit-allowlist.json` },
        full: { type: 'string' },
        runtime: { type: 'string' },
        today: { type: 'string', default: new Date().toISOString().slice(0, 10) },
      },
    });
    const allowlist = parseAllowlist(readJson(values.allowlist));
    const [full, runtime] = await Promise.all([
      values.full ? readJson(values.full) : runNpmAudit(AUDIT_ARGS.full),
      values.runtime ? readJson(values.runtime) : runNpmAudit(AUDIT_ARGS.runtime),
    ]);
    const result = evaluate({ full, runtime, allowlist, today: values.today });
    (result.ok ? process.stdout : process.stderr).write(`${formatResult(result)}\n`);
    return result.ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(`audit: error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
