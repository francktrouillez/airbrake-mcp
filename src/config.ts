export interface Config {
  userToken: string;
  projectKeys: Record<string, string>;
  host: string;
  timeoutMs: number;
  maxRetries: number;
}

function parseInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${name} must be an integer, got: ${raw}`);
  }
  return n;
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
  const host = (env.AIRBRAKE_HOST ?? 'https://api.airbrake.io').replace(/\/+$/, '');
  return {
    userToken: env.AIRBRAKE_USER_TOKEN ?? '',
    projectKeys: parseProjectKeys(env.AIRBRAKE_PROJECT_KEYS),
    host,
    timeoutMs: parseInt('AIRBRAKE_TIMEOUT_MS', env.AIRBRAKE_TIMEOUT_MS, 15000),
    maxRetries: parseInt('AIRBRAKE_MAX_RETRIES', env.AIRBRAKE_MAX_RETRIES, 2),
  };
}
