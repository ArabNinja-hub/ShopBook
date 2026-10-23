export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class BadRequestError extends ApiError {
  constructor(message: string, code = 'BAD_REQUEST') {
    super(400, code, message);
    this.name = 'BadRequestError';
  }
}

export class AuthenticationError extends ApiError {
  constructor(message = 'Authentication required.', code = 'UNAUTHENTICATED') {
    super(401, code, message);
    this.name = 'AuthenticationError';
  }
}

export class ForbiddenError extends ApiError {
  constructor(
    message = 'You do not have permission to access this shop.',
    code = 'FORBIDDEN'
  ) {
    super(403, code, message);
    this.name = 'ForbiddenError';
  }
}

export class ConflictError extends ApiError {
  constructor(message: string, code = 'CONFLICT') {
    super(409, code, message);
    this.name = 'ConflictError';
  }
}

export class RateLimitError extends ApiError {
  public readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, message = 'Too many attempts. Please wait and try again.') {
    super(429, 'RATE_LIMITED', message);
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
