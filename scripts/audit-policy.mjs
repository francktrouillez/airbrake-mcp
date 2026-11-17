// Pure policy logic for the CI dependency audit. The rules are documented in
// README → "Dependency audit"; scripts/audit.mjs is the CLI around this.

const BLOCKING = new Set(['high', 'critical']);
const GHSA_IN_URL = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/;
const GHSA_ID = new RegExp(`^${GHSA_IN_URL.source}$`);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Longest an allowlist entry may be set to live, counted from today. */
export const MAX_DAYS = Object.freeze({ dev: 180, runtime: 90 });

/**
 * @typedef {{ id: string, packages: string[], title: string, severity: string, url: string }} Advisory
 * @typedef {{ id: string, package: string, scope: 'dev' | 'runtime', reason: string, expires: string }} AllowEntry
 * @typedef {Advisory & { runtime: boolean }} Finding
 * @typedef {AllowEntry & { problem: 'expired' | 'too-far' | 'stale' }} EntryProblem
 * @typedef {{ ok: boolean, blocked: Finding[], allowed: Finding[], entryProblems: EntryProblem[] }} AuditResult
 */

function isValidDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

// GitHub advisories are reported by URL; fall back to npm's numeric source id
// so two advisories without a GHSA URL never collapse into one.
function advisoryId(via) {
  const match = GHSA_IN_URL.exec(String(via.url ?? ''));
  return match ? match[0] : `npm-advisory-${via.source ?? 'unknown'}`;
}

/**
 * High/critical advisories in an `npm audit --json` (v2) report, keyed by id.
 * Fails loudly on format drift instead of reading it as a clean tree: npm's
 * summary counts must be present, and every package npm marks high/critical
 * must be explained by a parsed advisory or a reference to another package.
 * @param {unknown} report
 * @returns {Map<string, Advisory>}
 */
export function collectAdvisories(report) {
  const counts = report?.metadata?.vulnerabilities;
  if (report?.auditReportVersion !== 2 || !counts || typeof counts !== 'object') {
    throw new Error(
      `expected npm audit --json output (auditReportVersion 2 with metadata), got: ${JSON.stringify(report).slice(0, 200)}`,
    );
  }
  const found = new Map();
  for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
    const vias = vuln.via ?? [];
    let explained = vias.some((via) => typeof via === 'string');
    for (const via of vias) {
      // String entries point at another vulnerable package; objects are advisories.
      if (typeof via !== 'object' || !BLOCKING.has(via.severity)) continue;
      explained = true;
      const id = advisoryId(via);
      const adv = found.get(id) ?? {
        id,
        packages: [],
        title: via.title,
        severity: via.severity,
        url: via.url,
      };
      if (!adv.packages.includes(via.name)) adv.packages.push(via.name);
      found.set(id, adv);
    }
    if (BLOCKING.has(vuln.severity) && !explained) {
      throw new Error(
        `npm audit marks ${name} ${vuln.severity} but no advisory parsed — report format changed?`,
      );
    }
  }
  return found;
}

/**
 * Validate the shape of the allowlist file. Date windows are policy and are
 * checked in evaluate().
 * @param {unknown} raw
 * @returns {AllowEntry[]}
 */
export function parseAllowlist(raw) {
  const fail = (msg) => {
    throw new Error(`invalid audit allowlist: ${msg}`);
  };
  if (!Array.isArray(raw)) fail('expected a JSON array of entries');
  const seen = new Set();
  return raw.map((e, i) => {
    const where = `entry ${i}`;
    if (!e || typeof e !== 'object') fail(`${where} is not an object`);
    if (typeof e.id !== 'string' || !GHSA_ID.test(e.id)) fail(`${where}: id must be a GHSA id`);
    if (seen.has(e.id)) fail(`${where}: duplicate id ${e.id}`);
    seen.add(e.id);
    if (typeof e.package !== 'string' || e.package.trim() === '') {
      fail(`${where}: package required`);
    }
    if (e.scope !== 'dev' && e.scope !== 'runtime')
      fail(`${where}: scope must be "dev" or "runtime"`);
    if (typeof e.reason !== 'string' || e.reason.trim() === '') fail(`${where}: reason required`);
    if (!isValidDate(e.expires)) fail(`${where}: expires must be a real YYYY-MM-DD date`);
    return { id: e.id, package: e.package, scope: e.scope, reason: e.reason, expires: e.expires };
  });
}

function mergeReports(full, runtime) {
  const all = new Map();
  for (const adv of [...full.values(), ...runtime.values()]) {
    const prev = all.get(adv.id);
    const packages = [...new Set([...(prev?.packages ?? []), ...adv.packages])];
    all.set(adv.id, { ...adv, packages });
  }
  return all;
}

/**
 * Apply the policy (see README → "Dependency audit").
 * @param {{ full: unknown, runtime: unknown, allowlist: AllowEntry[], today: string }} input
 * @returns {AuditResult}
 */
export function evaluate({ full, runtime, allowlist, today }) {
  if (!isValidDate(today)) throw new Error(`today must be YYYY-MM-DD, got: ${today}`);
  const runtimeFound = collectAdvisories(runtime);
  const all = mergeReports(collectAdvisories(full), runtimeFound);
  const byId = new Map(allowlist.map((e) => [e.id, e]));

  const blocked = [];
  const allowed = [];
  const used = new Set();
  for (const adv of all.values()) {
    const isRuntime = runtimeFound.has(adv.id);
    const entry = byId.get(adv.id);
    // The entry must name every package the advisory hits, and a dev entry
    // may never cover a finding that ships to users.
    const covers =
      entry !== undefined &&
      adv.packages.every((p) => p === entry.package) &&
      (entry.scope === 'runtime' || !isRuntime);
    if (covers) used.add(entry.id);
    (covers ? allowed : blocked).push({ ...adv, runtime: isRuntime });
  }

  const entryProblems = allowlist.flatMap((e) => {
    if (e.expires < today) return [{ ...e, problem: 'expired' }];
    if (e.expires > addDays(today, MAX_DAYS[e.scope])) return [{ ...e, problem: 'too-far' }];
    if (!used.has(e.id)) return [{ ...e, problem: 'stale' }];
    return [];
  });

  return {
    ok: blocked.length === 0 && entryProblems.length === 0,
    blocked,
    allowed,
    entryProblems,
  };
}

const PROBLEM_TEXT = {
  expired: (e) => `expired ${e.expires}; re-assess, then fix or extend`,
  'too-far': (e) =>
    `expires ${e.expires}, more than ${MAX_DAYS[e.scope]} days out for a ${e.scope} entry`,
  stale: (e) => `covers nothing (fixed, or wrong package/scope); remove or correct it`,
};

/**
 * Human-readable CI output.
 * @param {AuditResult} result
 * @returns {string}
 */
export function formatResult(result) {
  const row = (tag, id, rest) => `${tag.padEnd(8)} ${id}  ${rest}`;
  const where = (f) =>
    `${f.packages.join(', ')} (${f.severity}, ${f.runtime ? 'runtime' : 'dev-only'})`;
  const lines = [
    ...result.blocked.flatMap((f) => [
      row('BLOCKED', f.id, `${where(f)}: ${f.title}`),
      `${' '.repeat(9)}${f.url}`,
    ]),
    ...result.entryProblems.map((e) =>
      row(e.problem.toUpperCase(), e.id, `${e.package}: ${PROBLEM_TEXT[e.problem](e)}`),
    ),
    ...result.allowed.map((f) => row('allowed', f.id, where(f))),
  ];
  if (!result.ok) {
    lines.push(
      'audit: FAILED. Fix the dependency, or add a reviewed entry to audit-allowlist.json (README → Dependency audit).',
    );
  } else if (result.allowed.length > 0) {
    lines.push(
      `audit: ok — ${result.allowed.length} allow-listed advisory(ies), nothing else high or critical.`,
    );
  } else {
    lines.push('audit: no high or critical advisories.');
  }
  return lines.join('\n');
}
