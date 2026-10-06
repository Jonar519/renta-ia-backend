export class ApiError extends Error {
  statusCode: number;
  details?: unknown;
  /** Identificador estable para que el cliente reaccione (p. ej. "mfa_enrollment_required"). */
  code?: string;

  constructor(statusCode: number, message: string, details?: unknown, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.code = code;
  }
}
