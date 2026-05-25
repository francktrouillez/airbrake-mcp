import { describe, it, expect } from 'vitest';
import {
  AirbrakeApiError,
  AirbrakeNetworkError,
  AirbrakeConfigError,
} from '../../src/client/errors.js';

describe('AirbrakeApiError', () => {
  it('includes status, path, and body in message', () => {
    const err = new AirbrakeApiError(404, 'GET', '/api/v4/projects/999', { message: 'not found' });
    expect(err.status).toBe(404);
    expect(err.method).toBe('GET');
    expect(err.path).toBe('/api/v4/projects/999');
    expect(err.body).toEqual({ message: 'not found' });
    expect(err.message).toMatch(/404/);
    expect(err.message).toMatch(/GET \/api\/v4\/projects\/999/);
  });
});

describe('AirbrakeNetworkError', () => {
  it('wraps an underlying cause', () => {
    const cause = new Error('ECONNRESET');
    const err = new AirbrakeNetworkError('GET', '/api/v4/projects', cause);
    expect(err.cause).toBe(cause);
    expect(err.message).toMatch(/network/i);
  });
});

describe('AirbrakeConfigError', () => {
  it('formats missing-env errors actionably', () => {
    const err = new AirbrakeConfigError('AIRBRAKE_USER_TOKEN is required for this tool');
    expect(err.message).toMatch(/AIRBRAKE_USER_TOKEN/);
  });
});
