// Optional context (e.g. why a request was not retried), appended in parentheses.
function withHint(message: string, hint: string | undefined): string {
  return hint ? `${message} (${hint})` : message;
}

export class AirbrakeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly body: unknown,
    hint?: string,
  ) {
    super(
      withHint(`Airbrake API error ${status} on ${method} ${path}: ${JSON.stringify(body)}`, hint),
    );
    this.name = 'AirbrakeApiError';
  }
}

export class AirbrakeNetworkError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly cause: unknown,
    hint?: string,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(withHint(`Airbrake network error on ${method} ${path}: ${reason}`, hint));
    this.name = 'AirbrakeNetworkError';
  }
}

export class AirbrakeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AirbrakeConfigError';
  }
}
