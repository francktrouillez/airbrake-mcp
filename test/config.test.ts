import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('loads user token from env', () => {
    const cfg = loadConfig({ AIRBRAKE_USER_TOKEN: 'tok_abc' });
    expect(cfg.userToken).toBe('tok_abc');
  });

  it('defaults host to https://api.airbrake.io', () => {
    const cfg = loadConfig({ AIRBRAKE_USER_TOKEN: 'x' });
    expect(cfg.host).toBe('https://api.airbrake.io');
  });

  it('respects AIRBRAKE_HOST override', () => {
    const cfg = loadConfig({
      AIRBRAKE_USER_TOKEN: 'x',
      AIRBRAKE_HOST: 'https://errbit.example.com',
    });
    expect(cfg.host).toBe('https://errbit.example.com');
  });

  it('strips trailing slash from host', () => {
    const cfg = loadConfig({ AIRBRAKE_USER_TOKEN: 'x', AIRBRAKE_HOST: 'https://h.example.com/' });
    expect(cfg.host).toBe('https://h.example.com');
  });

  it('parses AIRBRAKE_PROJECT_KEYS json map', () => {
    const cfg = loadConfig({
      AIRBRAKE_USER_TOKEN: 'x',
      AIRBRAKE_PROJECT_KEYS: '{"123":"key_abc","456":"key_def"}',
    });
    expect(cfg.projectKeys).toEqual({ '123': 'key_abc', '456': 'key_def' });
  });

  it('throws on malformed AIRBRAKE_PROJECT_KEYS', () => {
    expect(() =>
      loadConfig({ AIRBRAKE_USER_TOKEN: 'x', AIRBRAKE_PROJECT_KEYS: 'not-json' }),
    ).toThrow(/AIRBRAKE_PROJECT_KEYS/);
  });

  it('throws if AIRBRAKE_PROJECT_KEYS is not an object map of strings', () => {
    expect(() =>
      loadConfig({ AIRBRAKE_USER_TOKEN: 'x', AIRBRAKE_PROJECT_KEYS: '["a","b"]' }),
    ).toThrow(/AIRBRAKE_PROJECT_KEYS/);
  });

  it('defaults timeoutMs to 15000 and maxRetries to 2', () => {
    const cfg = loadConfig({ AIRBRAKE_USER_TOKEN: 'x' });
    expect(cfg.timeoutMs).toBe(15000);
    expect(cfg.maxRetries).toBe(2);
  });

  it('reads numeric overrides', () => {
    const cfg = loadConfig({
      AIRBRAKE_USER_TOKEN: 'x',
      AIRBRAKE_TIMEOUT_MS: '5000',
      AIRBRAKE_MAX_RETRIES: '5',
    });
    expect(cfg.timeoutMs).toBe(5000);
    expect(cfg.maxRetries).toBe(5);
  });

  it('throws on non-numeric AIRBRAKE_TIMEOUT_MS', () => {
    expect(() => loadConfig({ AIRBRAKE_USER_TOKEN: 'x', AIRBRAKE_TIMEOUT_MS: 'abc' })).toThrow(
      /AIRBRAKE_TIMEOUT_MS/,
    );
  });

  it('userToken may be empty if not provided (deferred validation)', () => {
    const cfg = loadConfig({});
    expect(cfg.userToken).toBe('');
  });
});
