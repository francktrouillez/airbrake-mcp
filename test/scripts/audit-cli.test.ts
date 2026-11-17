// End-to-end: spawn the real CLI (`node scripts/audit.mjs`) the way CI runs it.
// Policy scenarios live in audit-policy.test.ts; this file proves the wiring:
// argument parsing, exit codes 0/1/2, and the npm arguments the live path uses.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { AUDIT_ARGS } from '../../scripts/audit.mjs';
import { advisory, CURRENT, report, ZOD } from './audit-fixtures.js';

const CLI = fileURLToPath(new URL('../../scripts/audit.mjs', import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), 'audit-cli-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function file(content: unknown): string {
  const p = path.join(dir, `f${n++}.json`);
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
}

function cli(args: string[]) {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 10_000 });
  return { code: res.status, out: res.stdout + res.stderr };
}

function run(
  opts: { full?: unknown; runtime?: unknown; allowlist?: unknown; today?: string } = {},
) {
  return cli([
    '--full',
    file(opts.full ?? CURRENT.full),
    '--runtime',
    file(opts.runtime ?? CURRENT.runtime),
    '--allowlist',
    file(opts.allowlist ?? CURRENT.allowlist),
    '--today',
    opts.today ?? '2026-11-17',
  ]);
}

describe('scripts/audit.mjs (CLI)', () => {
  it('exits 0 for the current tree with the committed allowlist shape', () => {
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out).toMatch(/audit: ok — 2 allow-listed/);
  });

  it('exits 1 on a policy failure', () => {
    const qs = advisory('qs', 'GHSA-6rw7-vpxm-498p');
    const { code, out } = run({
      full: report(
        ...Object.values(CURRENT.full.vulnerabilities).map((v) => v.via[0] as never),
        qs,
      ),
      runtime: report(advisory('zod', ZOD), qs),
    });
    expect(code).toBe(1);
    expect(out).toMatch(/BLOCKED +GHSA-6rw7-vpxm-498p +qs \(high, runtime\)/);
  });

  it.each([
    ['a bad --today', () => run({ today: '' }), /today must be YYYY-MM-DD/],
    ['an unknown flag', () => cli(['--alowlist', 'x.json']), /alowlist/],
    ['a malformed allowlist', () => run({ allowlist: {} }), /invalid audit allowlist/],
    ['a non-audit report', () => run({ full: '{"error":"ENOLOCK"}' }), /npm audit --json output/],
  ])('exits 2 (not 1) on %s', (_label, invoke, message) => {
    const { code, out } = invoke();
    expect(code).toBe(2);
    expect(out).toMatch(/audit: error: /);
    expect(out).toMatch(message);
  });
});

describe('live npm audit arguments', () => {
  it.each(['full', 'runtime'] as const)(
    '%s audit reads only the lockfile and pins optional + peer deps',
    (scope) => {
      expect(AUDIT_ARGS[scope]).toEqual(
        expect.arrayContaining([
          'audit',
          '--json',
          '--package-lock-only',
          '--include=optional',
          '--include=peer',
        ]),
      );
    },
  );

  it('the full audit forces dev deps in; the runtime audit leaves them out', () => {
    expect(AUDIT_ARGS.full).toContain('--include=dev');
    expect(AUDIT_ARGS.full).not.toContain('--omit=dev');
    expect(AUDIT_ARGS.runtime).toContain('--omit=dev');
    expect(AUDIT_ARGS.runtime).not.toContain('--include=dev');
  });
});
