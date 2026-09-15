/**
 * Typed errors. Every failure a host can reasonably act on gets a code, because
 * "something went wrong" is not a transparency story (spec §1.4).
 */
export type DateraErrorCode =
  | 'READ_ONLY_VIOLATION'
  | 'CROSS_DATASET_ACCESS'
  | 'UNSUPPORTED_FORMAT'
  | 'SOURCE_UNAVAILABLE'
  | 'SOURCE_NOT_FOUND'
  | 'DATASET_NOT_FOUND'
  | 'DUPLICATE_NAME'
  | 'WORKSPACE_FORMAT_UNSUPPORTED'
  | 'EXTENSION_UNAVAILABLE'
  | 'SECRET_STORE_UNAVAILABLE'
  | 'CONNECTION_FAILED'
  | 'SQL_ERROR'
  | 'MODEL_CALL_FAILED'
  | 'MODEL_UNAVAILABLE'
  | 'CANNOT_ANSWER'
  | 'WRITE_NOT_PERMITTED'
  | 'INVALID_ARGUMENT';

export class DateraError extends Error {
  readonly code: DateraErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: DateraErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DateraError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  static is(e: unknown, code?: DateraErrorCode): e is DateraError {
    return e instanceof DateraError && (code === undefined || e.code === code);
  }
}

/** Wrap an unknown thrown value as a DateraError without losing the original message. */
export function asDateraError(
  e: unknown,
  code: DateraErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): DateraError {
  const cause = e instanceof Error ? e.message : String(e);
  return new DateraError(code, `${message}: ${cause}`, { ...details, cause });
}
