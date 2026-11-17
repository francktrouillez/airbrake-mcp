// Shared fixtures shaped like `npm audit --json` (auditReportVersion 2):
// advisories are the object entries of `vulnerabilities[pkg].via`; string
// entries reference another vulnerable package.

export const PICO = 'GHSA-fc5q-39xc-vjpf';
export const ZOD = 'GHSA-mrhx-c7xc-m3w5';
export const TODAY = '2026-11-17';

export interface Via {
  source: number;
  name: string;
  title: string;
  url: string | undefined;
  severity: string;
}

export function advisory(pkg: string, ghsa: string, severity = 'high'): Via {
  return {
    source: 1,
    name: pkg,
    title: `${pkg} is vulnerable`,
    url: `https://github.com/advisories/${ghsa}`,
    severity,
  };
}

/** One vulnerable package per advisory, with npm's metadata counts filled in. */
export function report(...vias: Via[]) {
  const vulnerabilities: Record<string, { name: string; severity: string; via: unknown[] }> = {};
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const via of vias) {
    vulnerabilities[via.name] = { name: via.name, severity: via.severity, via: [via] };
    counts[via.severity as keyof typeof counts]++;
    counts.total++;
  }
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: counts } };
}

export function entry(id: string, pkg: string, scope: 'dev' | 'runtime', expires = '2027-01-31') {
  return { id, package: pkg, scope, reason: 'documented reason', expires };
}

/** The committed allowlist's shape against today's tree. */
export const CURRENT = {
  full: report(advisory('picomatch', PICO), advisory('zod', ZOD)),
  runtime: report(advisory('zod', ZOD)),
  allowlist: [
    entry(PICO, 'picomatch', 'dev', '2027-02-17'),
    entry(ZOD, 'zod', 'runtime', '2027-01-17'),
  ],
};
