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

/** Map a status + server `{error}` message to the right error class. */
export function errorForStatus(status: number, message: string): ApiError {
  if (status === 401) return new AuthError(message);
  if (status === 404) return new NotFoundError(message);
  return new ApiError(status, message);
}
