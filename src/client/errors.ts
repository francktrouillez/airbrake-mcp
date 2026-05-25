export class AirbrakeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly body: unknown,
  ) {
    super(`Airbrake API error ${status} on ${method} ${path}: ${JSON.stringify(body)}`);
    this.name = 'AirbrakeApiError';
  }
}

export class AirbrakeNetworkError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly cause: unknown,
  ) {
    super(
      `Airbrake network error on ${method} ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'AirbrakeNetworkError';
  }
}

export class AirbrakeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AirbrakeConfigError';
  }
}
