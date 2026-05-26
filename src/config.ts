export interface Config {
  userToken: string;
  projectKeys: Record<string, string>;
  host: string;
  timeoutMs: number;
  maxRetries: number;
}

function parseInt(name: string, raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${name} must be an integer, got: ${raw}`);
  }
  if (n < min) {
    throw new Error(`${name} must be >= ${min}, got: ${n}`);
  }
  return n;
}

// Validate AIRBRAKE_HOST is a parseable http(s) URL. Without this, a typo
// or attacker-controlled env (e.g. AIRBRAKE_HOST=http://internal) silently
// ships the bearer token to a non-HTTPS host. We warn on http:// rather than
// reject because self-hosted Errbit in dev environments is a legitimate use.
function parseHost(raw: string | undefined): string {
  const value = raw ?? 'https://api.airbrake.io';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`AIRBRAKE_HOST is not a valid URL: ${value}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`AIRBRAKE_HOST must use http: or https:, got: ${url.protocol}`);
  }
  if (url.protocol === 'http:') {
    process.stderr.write(
      'airbrake-mcp: warning: AIRBRAKE_HOST uses http: — bearer token will be sent in plaintext\n',
    );
  }
  return value.replace(/\/+$/, '');
}

function parseProjectKeys(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`AIRBRAKE_PROJECT_KEYS is not valid JSON`);
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.values(parsed as Record<string, unknown>).some((v) => typeof v !== 'string')
  ) {
    throw new Error(
      `AIRBRAKE_PROJECT_KEYS must be a JSON object mapping project_id to notifier key strings`,
    );
  }
  return parsed as Record<string, string>;
}

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Config {
  return {
    userToken: env.AIRBRAKE_USER_TOKEN ?? '',
    projectKeys: parseProjectKeys(env.AIRBRAKE_PROJECT_KEYS),
    host: parseHost(env.AIRBRAKE_HOST),
    // timeoutMs must be positive — `setTimeout(abort, 0)` aborts every request.
    timeoutMs: parseInt('AIRBRAKE_TIMEOUT_MS', env.AIRBRAKE_TIMEOUT_MS, 15000, 1),
    // maxRetries may be zero (disable retries) but not negative.
    maxRetries: parseInt('AIRBRAKE_MAX_RETRIES', env.AIRBRAKE_MAX_RETRIES, 2, 0),
  };
}
