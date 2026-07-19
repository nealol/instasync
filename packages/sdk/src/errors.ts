/** Error thrown for any non-2xx API response. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** 401 — the token is missing, expired, or revoked. */
export class AuthError extends ApiError {
  constructor(message = "unauthorized") {
    super(401, message);
    this.name = "AuthError";
  }
}

/** 404 — the vault, note, or resource does not exist. */
export class NotFoundError extends ApiError {
  constructor(message = "not found") {
    super(404, message);
    this.name = "NotFoundError";
  }
}

/** 400 — a request failed stable server-side validation. */
export class ValidationError extends ApiError {
  constructor(message = "validation failed") {
    super(400, message);
    this.name = "ValidationError";
  }
}

/** 409 — a mutation conflicts with current Canvas state. */
export class ConflictError extends ApiError {
  constructor(message = "conflict") {
    super(409, message);
    this.name = "ConflictError";
  }
}

/** Map a status + server `{error}` message to the right error class. */
export function errorForStatus(status: number, message: string): ApiError {
  if (status === 401) return new AuthError(message);
  if (status === 400) return new ValidationError(message);
  if (status === 404) return new NotFoundError(message);
  if (status === 409) return new ConflictError(message);
  return new ApiError(status, message);
}
