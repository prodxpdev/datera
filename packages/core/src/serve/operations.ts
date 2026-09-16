import { DateraError } from '../errors.js';
import { quoteLiteral } from '../engine/sql.js';

/**
 * Authored operations — named, typed, parameterised statements (spec §8, §3a).
 *
 * The generated tools are `query_<dataset>(sql)` and `propose_write_<dataset>(sql)`: an
 * agent can do anything, or nothing, and a workspace has no way to say "this is the shape
 * of a thing you may do here". An authored operation is that shape — a saved statement
 * with a name, typed arguments and a description, served as its own MCP tool and its own
 * REST endpoint.
 *
 * ## Where the boundary is
 *
 * This is deliberately *not* the generated business logic §13b defers. Nothing is
 * compiled, no provider is integrated, no code is emitted: an operation is one SQL
 * statement plus the metadata needed to call it safely. It feeds the runtime tool, which
 * is the §0.2 test.
 *
 * ## Three rules that are not negotiable
 *
 *  1. **Arguments are bound, never interpolated.** An operation that pasted its arguments
 *     into SQL would turn every one of them into an injection hole, and Datera would be
 *     shipping the vulnerability rather than the guard.
 *  2. **The kind is measured, not declared.** DuckDB's parser decides whether an operation
 *     reads or writes. Someone naming a DELETE `create_order` must not get it treated as
 *     a read, and a name is not evidence.
 *  3. **A write proposes; it does not apply.** §6 says a write is never executed without
 *     an explicit confirm, and an agent cannot confirm. Calling a write operation returns
 *     a proposal for a human to ratify — the same gate as every other write path, reached
 *     through a different door.
 */

export type OperationParameterType = 'string' | 'number' | 'boolean' | 'date';

export interface OperationParameter {
  readonly name: string;
  readonly type: OperationParameterType;
  readonly required: boolean;
  readonly description: string;
}

export interface AuthoredOperation {
  readonly id: string;
  readonly datasetId: string;
  readonly name: string;
  readonly description: string;
  /** Parameterised with `$name` placeholders, bound at call time. */
  readonly sql: string;
  readonly parameters: readonly OperationParameter[];
  /** Measured from the statement, never taken from the caller. */
  readonly kind: 'read' | 'write';
  readonly createdAt: string;
}

export interface CreateOperationInput {
  readonly datasetId: string;
  readonly name: string;
  readonly description: string;
  readonly sql: string;
  readonly parameters: readonly OperationParameter[];
}

/**
 * Tool names must be identifier-ish for MCP clients, and this one also becomes a URL
 * path segment. Anything else is refused at authoring time rather than producing a tool
 * no client can call.
 */
const OPERATION_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function assertOperationName(name: string): void {
  if (!OPERATION_NAME.test(name)) {
    throw new DateraError(
      'INVALID_ARGUMENT',
      `"${name}" is not a usable operation name. Use lower-case letters, digits and ` +
        `underscores, starting with a letter or underscore (63 characters max) — it becomes ` +
        `both an MCP tool name and a URL path.`,
      { name },
    );
  }
}

/**
 * The `$name` placeholders a statement actually binds.
 *
 * String literals are stripped first, so `WHERE note = '$100 refund'` does not register a
 * parameter called `100`.
 */
export function placeholdersIn(sql: string): readonly string[] {
  const withoutStrings = sql.replace(/'(?:[^']|'')*'?/g, ' ');
  const found = new Set<string>();
  for (const match of withoutStrings.matchAll(/\$([a-z_][a-z0-9_]*)/gi)) {
    found.add(match[1]!);
  }
  return [...found];
}

/**
 * Declared parameters and bound placeholders must agree exactly.
 *
 * A declared parameter the SQL never binds is a silent no-op; a placeholder nobody
 * declared is a call that always fails. Both are far better caught while authoring than
 * by an agent at three in the morning.
 */
export function assertParametersMatch(
  sql: string,
  parameters: readonly OperationParameter[],
): void {
  const bound = new Set(placeholdersIn(sql));
  const declared = new Set(parameters.map((p) => p.name));

  const undeclared = [...bound].filter((p) => !declared.has(p));
  const unused = [...declared].filter((p) => !bound.has(p));

  if (undeclared.length > 0) {
    throw new DateraError(
      'INVALID_ARGUMENT',
      `The statement uses ${undeclared.map((p) => `$${p}`).join(', ')}, which ${
        undeclared.length === 1 ? 'is not a declared parameter' : 'are not declared parameters'
      }.`,
      { undeclared },
    );
  }

  if (unused.length > 0) {
    throw new DateraError(
      'INVALID_ARGUMENT',
      `Declared parameter${unused.length === 1 ? '' : 's'} ${unused
        .map((p) => `"${p}"`)
        .join(', ')} ${unused.length === 1 ? 'is' : 'are'} never used by the statement, so ` +
        `passing ${unused.length === 1 ? 'it' : 'them'} would do nothing.`,
      { unused },
    );
  }
}

/**
 * Turn a call's arguments into positional bind values, in the order the SQL uses them.
 *
 * Returns the rewritten SQL as well: DuckDB binds by position, so `$name` placeholders
 * are replaced with `?` and the values ordered to match. The rewrite touches only
 * placeholders found outside string literals, which is the same scan `placeholdersIn`
 * uses — the point being that a value can never become part of the statement.
 */
export function bindArguments(
  operation: AuthoredOperation,
  args: Readonly<Record<string, unknown>>,
): { sql: string; values: readonly (string | number | boolean)[] } {
  const values: (string | number | boolean)[] = [];
  assertRequiredPresent(operation, args);

  // Replace placeholders in the order they appear, outside string literals, collecting
  // the matching value for each occurrence. A parameter used twice binds twice.
  const sql = rewrite(operation.sql, (name) => {
    const parameter = operation.parameters.find((p) => p.name === name)!;
    values.push(coerce(args[name], parameter, operation.name));
    return '?';
  });

  return { sql, values };
}

/**
 * The same binding, rendered as SQL literals instead of placeholders.
 *
 * Used for **write** operations only, and the reason is the write preview: it re-runs
 * fragments of the statement — the target table, the WHERE clause — to report the exact
 * row count and old → new values before anything is applied. Splitting one positional
 * value list across a statement and the several derived queries its preview builds is
 * precisely the index-juggling that produces a silent mis-binding, and a mis-bound
 * preview would show a human the wrong rows in the one place they are asked to approve.
 *
 * So a write operation's values are escaped rather than bound. `quoteLiteral` doubles
 * single quotes and refuses a null byte — the standard-safe escape, and what the rest of
 * the codebase already uses. The statement then travels the *unchanged* write path:
 * boundary check, classification, preview, confirm gate, undo. That is worth more than
 * the theoretical purity of binding.
 *
 * Reads keep true binding, where none of this applies.
 */
export function inlineArguments(
  operation: AuthoredOperation,
  args: Readonly<Record<string, unknown>>,
): string {
  assertRequiredPresent(operation, args);

  return rewrite(operation.sql, (name) => {
    const parameter = operation.parameters.find((p) => p.name === name)!;
    const value = coerce(args[name], parameter, operation.name);
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    return quoteLiteral(value);
  });
}

function assertRequiredPresent(
  operation: AuthoredOperation,
  args: Readonly<Record<string, unknown>>,
): void {
  for (const parameter of operation.parameters) {
    const provided = args[parameter.name];
    if ((provided === undefined || provided === null) && parameter.required) {
      throw new DateraError(
        'INVALID_ARGUMENT',
        `"${operation.name}" needs a value for "${parameter.name}" (${parameter.type}).`,
        { operation: operation.name, parameter: parameter.name },
      );
    }
  }
}

/**
 * Walk the statement, applying `replace` to each `$name` outside a string literal.
 *
 * Written as an explicit scanner rather than a regular expression because it decides what
 * is and is not part of the statement, and a clever one-liner is the wrong thing to have
 * to re-read when asking "could a value end up here". DuckDB doubles a quote to escape it
 * inside a literal (`'it''s'`), so a quote immediately following a quote continues the
 * string rather than closing it.
 */
function rewrite(sql: string, replace: (name: string) => string): string {
  let out = '';
  let i = 0;
  let inString = false;

  while (i < sql.length) {
    const ch = sql[i]!;

    if (inString) {
      if (ch === "'" && sql[i + 1] === "'") {
        out += "''";
        i += 2;
        continue;
      }
      if (ch === "'") inString = false;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === "'") {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '$') {
      const match = /^\$([a-z_][a-z0-9_]*)/i.exec(sql.slice(i));
      if (match !== null) {
        out += replace(match[1]!);
        i += match[0].length;
        continue;
      }
    }

    out += ch;
    i += 1;
  }

  return out;
}

function coerce(
  value: unknown,
  parameter: OperationParameter,
  operationName: string,
): string | number | boolean {
  if (value === undefined || value === null) {
    // Optional and absent. NULL is the honest binding, and DuckDB compares it as NULL
    // rather than as an empty string.
    return null as unknown as string;
  }

  switch (parameter.type) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) throw badValue(operationName, parameter, value);
      return n;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      throw badValue(operationName, parameter, value);
    case 'date':
    case 'string':
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      throw badValue(operationName, parameter, value);
  }
}

function badValue(operationName: string, parameter: OperationParameter, value: unknown): DateraError {
  return new DateraError(
    'INVALID_ARGUMENT',
    `"${operationName}" expects ${parameter.type} for "${parameter.name}", got ${typeof value}.`,
    { operation: operationName, parameter: parameter.name },
  );
}

/**
 * An authored operation as an MCP tool.
 *
 * The shape of the call is the operation's own parameters — not a `sql` string. That is
 * the difference between "here is a database, do as you like" and "here is what this
 * workspace offers", and it is the whole point of authoring one.
 */
export function operationTool(operation: AuthoredOperation): {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  datasetId: string;
} {
  const properties: Record<string, { type: string; description: string }> = {};
  for (const parameter of operation.parameters) {
    properties[parameter.name] = {
      type: parameter.type === 'date' ? 'string' : parameter.type,
      description:
        parameter.description.length > 0
          ? parameter.description
          : `${parameter.name} (${parameter.type})`,
    };
  }

  return {
    name: operation.name,
    description:
      operation.kind === 'write'
        ? // Said in the description because an agent reads this and nothing else. A tool
          // that silently proposed instead of applying would look broken to a caller who
          // was not told.
          `${operation.description} This PROPOSES a change and does not apply it — ` +
          `it returns a preview with the exact row count, which a person must confirm.`
        : operation.description,
    inputSchema: {
      type: 'object',
      properties,
      required: operation.parameters.filter((p) => p.required).map((p) => p.name),
    },
    datasetId: operation.datasetId,
  };
}
