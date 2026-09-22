import { DateraError } from '../errors.js';

const NUL = '\u0000';

/** Quote an identifier for DuckDB. Doubling embedded quotes is the whole escape rule. */
export function quoteIdent(name: string): string {
  if (name.includes(NUL)) {
    throw new DateraError('INVALID_ARGUMENT', 'Identifier contains a null byte', { name });
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quote a string literal for DuckDB. Prefer a bound parameter; use this only where DuckDB forbids one. */
export function quoteLiteral(value: string): string {
  if (value.includes(NUL)) {
    throw new DateraError('INVALID_ARGUMENT', 'String literal contains a null byte', {});
  }
  return `'${value.replace(/'/g, "''")}'`;
}

export function qualified(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

/**
 * Reduce an arbitrary string to a safe SQL identifier body.
 * Used for schema names and attachment aliases, which cannot be parameterised.
 */
export function slugifyIdent(input: string, fallback = 'x'): string {
  const s = input
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}_]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  const body = s.length > 0 ? s : fallback;
  return /^[0-9]/.test(body) ? `_${body}` : body;
}
