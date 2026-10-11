export class RouterSdkError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RouterSdkError';
    this.code = code;
    this.status = details.status ?? null;
    this.requestId = details.requestId ?? null;
    this.retryable = details.retryable === true;
    if (Number.isFinite(details.retryAfterMs) && details.retryAfterMs >= 0) this.retryAfterMs = details.retryAfterMs;
  }
}

export function invalid(message = 'Invalid router SDK input.') {
  throw new RouterSdkError('INVALID_INPUT', message);
}
