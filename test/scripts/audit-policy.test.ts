import { describe, expect, it } from 'vitest';
import {
  collectAdvisories,
  evaluate,
  formatResult,
  parseAllowlist,
} from '../../scripts/audit-policy.mjs';
import { advisory, CURRENT, entry, PICO, report, TODAY, ZOD } from './audit-fixtures.js';

const run = (overrides: Partial<Parameters<typeof evaluate>[0]> = {}) =>
  evaluate({ ...CURRENT, today: TODAY, ...overrides });

describe('collectAdvisories', () => {
  it('keeps only high/critical advisories and merges packages per id', () => {
    const r = report(
      advisory('picomatch', PICO),
      advisory('qs', 'GHSA-aaaa-bbbb-cccc', 'moderate'),
    );
    r.vulnerabilities.tinyglobby = {
      name: 'tinyglobby',
      severity: 'high',
      via: ['picomatch', advisory('picomatch', PICO)],
    };
    const found = collectAdvisories(r);
    expect([...found.keys()]).toEqual([PICO]);
    expect(found.get(PICO)).toMatchObject({ packages: ['picomatch'], severity: 'high' });
  });

  it('includes critical advisories', () => {
    const found = collectAdvisories(report(advisory('x', 'GHSA-1111-2222-3333', 'critical')));
    expect([...found.keys()]).toEqual(['GHSA-1111-2222-3333']);
  });

  it('keeps advisories without a GHSA URL distinct, keyed by npm source id', () => {
    const r = report(
      { ...advisory('a', 'x'), url: undefined, source: 101 },
      { ...advisory('b', 'x'), url: '', source: 102 },
    );
    expect([...collectAdvisories(r).keys()]).toEqual(['npm-advisory-101', 'npm-advisory-102']);
  });

  it('returns nothing for a clean report', () => {
    expect(collectAdvisories(report()).size).toBe(0);
  });

  it.each([
    ['not npm audit v2 JSON', { error: { code: 'ENOLOCK' } }],
    ['missing metadata counts', { auditReportVersion: 2, vulnerabilities: {} }],
  ])('rejects a report that is %s', (_label, raw) => {
    expect(() => collectAdvisories(raw)).toThrow(/npm audit --json output/);
  });

  it('fails loudly when one high package has no parseable advisory (partial format drift)', () => {
    const drifted = report(advisory('zod', ZOD));
    drifted.vulnerabilities.newpkg = {
      name: 'newpkg',
      severity: 'critical',
      via: [{ name: 'newpkg', level: 'critical' }],
    };
    expect(() => collectAdvisories(drifted)).toThrow(/newpkg critical but no advisory parsed/);
  });
});

describe('parseAllowlist', () => {
  it('accepts the committed shape', () => {
    expect(parseAllowlist(CURRENT.allowlist)).toHaveLength(2);
  });

  it.each([
    ['non-array', {}],
    ['bad id', [{ ...entry(PICO, 'picomatch', 'dev'), id: 'CVE-2024-1' }]],
    ['bad scope', [{ ...entry(PICO, 'picomatch', 'dev'), scope: 'prod' }]],
    ['non-string scope', [{ ...entry(PICO, 'picomatch', 'dev'), scope: ['runtime'] }]],
    ['empty reason', [{ ...entry(PICO, 'picomatch', 'dev'), reason: ' ' }]],
    ['bad date', [{ ...entry(PICO, 'picomatch', 'dev'), expires: '2027-13-01' }]],
    ['duplicate id', [entry(PICO, 'picomatch', 'dev'), entry(PICO, 'picomatch', 'runtime')]],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseAllowlist(raw)).toThrow(/invalid audit allowlist/);
  });
});

describe('evaluate', () => {
  it('passes when every finding is allow-listed in the right scope', () => {
    const result = run();
    expect(result.ok).toBe(true);
    expect(result.allowed.map((a) => a.id).sort()).toEqual([PICO, ZOD].sort());
  });

  it('blocks an advisory that is not allow-listed', () => {
    const result = run({ allowlist: [CURRENT.allowlist[0]!] });
    expect(result.ok).toBe(false);
    expect(result.blocked.map((a) => a.id)).toEqual([ZOD]);
  });

  it('never lets a dev-scoped entry cover a runtime finding', () => {
    const result = run({ allowlist: [CURRENT.allowlist[0]!, entry(ZOD, 'zod', 'dev')] });
    expect(result.blocked).toEqual([expect.objectContaining({ id: ZOD, runtime: true })]);
  });

  it('lets a runtime entry keep covering a finding that became dev-only', () => {
    expect(run({ runtime: report() }).ok).toBe(true);
  });

  it('requires the entry to name every package the advisory hits', () => {
    const mislabeled = run({ allowlist: [CURRENT.allowlist[0]!, entry(ZOD, 'lodash', 'runtime')] });
    expect(mislabeled.blocked.map((a) => a.id)).toEqual([ZOD]);

    const twoPackages = report(advisory('zod', ZOD), advisory('zod-mini', ZOD));
    const partial = run({ full: twoPackages, runtime: twoPackages });
    expect(partial.blocked).toEqual([
      expect.objectContaining({ id: ZOD, packages: ['zod', 'zod-mini'] }),
    ]);
  });

  it('unions packages across the full and runtime reports', () => {
    const result = run({
      full: report(advisory('picomatch', PICO), advisory('zod', ZOD), advisory('zod-dev', ZOD)),
    });
    expect(result.blocked).toEqual([
      expect.objectContaining({ id: ZOD, packages: ['zod', 'zod-dev'] }),
    ]);
  });

  it.each([
    ['expired', '2026-11-16', 'expired'],
    ['beyond the 90-day runtime horizon', '2027-02-16', 'too-far'],
  ])('fails on an entry that is %s', (_label, expires, problem) => {
    const result = run({
      allowlist: [CURRENT.allowlist[0]!, entry(ZOD, 'zod', 'runtime', expires)],
    });
    expect(result.ok).toBe(false);
    expect(result.entryProblems).toEqual([expect.objectContaining({ id: ZOD, problem })]);
  });

  it('accepts the exact boundaries: expiry day itself, and exactly 180/90 days out', () => {
    expect(
      run({
        allowlist: [entry(PICO, 'picomatch', 'dev', TODAY), entry(ZOD, 'zod', 'runtime', TODAY)],
      }).ok,
    ).toBe(true);
    expect(
      run({
        allowlist: [
          entry(PICO, 'picomatch', 'dev', '2027-05-16'),
          entry(ZOD, 'zod', 'runtime', '2027-02-15'),
        ],
      }).ok,
    ).toBe(true);
  });

  it('fails on a stale entry so fixed advisories get removed from the list', () => {
    const result = run({ full: report(advisory('picomatch', PICO)), runtime: report() });
    expect(result.entryProblems).toEqual([expect.objectContaining({ id: ZOD, problem: 'stale' })]);
  });

  it('rejects an invalid today instead of silently disabling the expiry checks', () => {
    expect(() => run({ today: '' })).toThrow(/today must be YYYY-MM-DD/);
  });

  it('passes a clean tree with an empty allowlist', () => {
    expect(run({ full: report(), runtime: report(), allowlist: [] }).ok).toBe(true);
  });
});

describe('formatResult', () => {
  it('names blocked findings and each entry problem with an actionable hint', () => {
    const text = formatResult(
      run({
        full: report(advisory('picomatch', PICO), advisory('qs', 'GHSA-4444-5555-6666')),
        runtime: report(advisory('qs', 'GHSA-4444-5555-6666')),
        allowlist: [entry(PICO, 'picomatch', 'dev', '2026-01-01'), entry(ZOD, 'zod', 'runtime')],
      }),
    );
    expect(text).toMatch(/BLOCKED +GHSA-4444-5555-6666 +qs \(high, runtime\)/);
    expect(text).toMatch(/EXPIRED +GHSA-fc5q-39xc-vjpf +picomatch: expired 2026-01-01/);
    expect(text).toMatch(/STALE +GHSA-mrhx-c7xc-m3w5 +zod: covers nothing/);
    expect(text).toMatch(/audit: FAILED/);
  });

  it('summarises passing runs', () => {
    expect(formatResult(run())).toMatch(/audit: ok — 2 allow-listed/);
    expect(formatResult(run({ full: report(), runtime: report(), allowlist: [] }))).toMatch(
      /no high or critical advisories/,
    );
  });
});
