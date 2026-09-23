import { DateraError } from '../errors.js';
import { maskIdentifiersKept, maskLiterals } from '../engine/scan-sql.js';
import type { Engine } from '../engine/engine.js';
import { qualified, quoteIdent } from '../engine/sql.js';
import type { DuckDBConnectionPort, StatementKind } from '../ports/duckdb.js';
import { extractTableReferences } from '../query/scope.js';
import { CATALOG_SCHEMA } from '../workspace/catalog.js';
import type { Trace } from '../query/trace.js';

/**
 * Writes — opt-in, gated, per dataset (spec §6).
 *
 * The shape is the safety mechanism: the model (or the user) **proposes**, Datera
 * **previews** exactly what would change, a human **confirms**, and only then does
 * anything execute — inside a transaction, with undo. §6 calls the gate "the teaching
 * moment", and that is why a proposal is a stored object with a preview rather than a
 * callback someone could forget to await.
 *
 * Scope for v1, per §6: writes land on a **derived** dataset only. Write-back to a live
 * connected source is explicitly a later, more deliberate phase.
 */

export type WriteKind = 'UPDATE' | 'DELETE' | 'INSERT';

export interface RowChange {
  /** The row as it is now. Empty for an INSERT. */
  readonly before: Readonly<Record<string, unknown>>;
  /** The columns this statement would set. Empty for a DELETE. */
  readonly after: Readonly<Record<string, unknown>>;
}

export interface WriteProposal {
  readonly id: string;
  readonly datasetId: string;
  readonly sql: string;
  readonly statementKind: WriteKind;
  readonly table: string;
  /** Counted by running the statement's own predicate — not estimated. */
  readonly rowsAffected: number;
  /** A sample of the actual rows, with old and new values. */
  readonly changes: readonly RowChange[];
  readonly warnings: readonly string[];
  readonly proposedAt: string;
  /** Present when the proposal came from a question rather than typed SQL. */
  readonly trace?: Trace | undefined;
}

export interface AppliedWrite {
  readonly id: string;
  readonly datasetId: string;
  readonly sql: string;
  readonly rowsChanged: number;
  readonly confirmedAt: string;
  readonly undoneAt: string | null;
}

/** Rows shown in the preview. Enough to see what is happening, bounded so it stays fast. */
const PREVIEW_ROWS = 20;

export async function migrateWrites(engine: Engine): Promise<void> {
  await engine.executeInternal(`
    CREATE TABLE IF NOT EXISTS ${CATALOG_SCHEMA}.write_grants (
      dataset_id VARCHAR PRIMARY KEY,
      granted_at VARCHAR NOT NULL
    )`);
  await engine.executeInternal(`
    CREATE TABLE IF NOT EXISTS ${CATALOG_SCHEMA}.write_log (
      id VARCHAR PRIMARY KEY,
      dataset_id VARCHAR NOT NULL,
      sql VARCHAR NOT NULL,
      rows_changed BIGINT NOT NULL,
      undo_schema VARCHAR NOT NULL,
      undo_table VARCHAR NOT NULL,
      target_table VARCHAR NOT NULL,
      confirmed_at VARCHAR NOT NULL,
      undone_at VARCHAR
    )`);
}

export async function isGranted(engine: Engine, datasetId: string): Promise<boolean> {
  const result = await engine.executeInternal(
    `SELECT count(*) FROM ${CATALOG_SCHEMA}.write_grants WHERE dataset_id = ?`,
    [datasetId],
  );
  return Number(result.rows[0]?.[0] ?? 0) > 0;
}

export async function grant(engine: Engine, datasetId: string, at: string): Promise<void> {
  await engine.executeInternal(
    `INSERT OR REPLACE INTO ${CATALOG_SCHEMA}.write_grants (dataset_id, granted_at) VALUES (?, ?)`,
    [datasetId, at],
  );
}

export async function revoke(engine: Engine, datasetId: string): Promise<void> {
  await engine.executeInternal(
    `DELETE FROM ${CATALOG_SCHEMA}.write_grants WHERE dataset_id = ?`,
    [datasetId],
  );
}

const WRITE_KINDS: ReadonlySet<StatementKind> = new Set<StatementKind>(['UPDATE', 'DELETE', 'INSERT']);

/**
 * Classify a proposed statement and refuse anything that is not a single write.
 *
 * Reuses the driver's parser-level classification, so the rules are the same ones the
 * read-only guard applies — there is one notion of "what kind of statement is this" in
 * the codebase, not two that could drift apart.
 */
export async function classifyWrite(conn: DuckDBConnectionPort, sql: string): Promise<WriteKind> {
  const classification = await conn.classify(sql);

  if (classification.statements.length !== 1) {
    throw new DateraError('INVALID_ARGUMENT', 'Propose one statement at a time.', {
      sql,
      statementCount: classification.statements.length,
    });
  }

  const statement = classification.statements[0];
  const kind = statement?.kind;

  // 'UNKNOWN' means DuckDB parsed it but could not bind it — almost always a table or
  // column that does not exist. Saying "this is a UNKNOWN" would be useless; the bind
  // error is the actual answer.
  if (kind === 'UNKNOWN') {
    throw new DateraError(
      'INVALID_ARGUMENT',
      `That statement does not match this dataset: ${statement?.bindError ?? 'it could not be resolved.'}`,
      { sql, bindError: statement?.bindError ?? null },
    );
  }

  if (kind === undefined || !WRITE_KINDS.has(kind as StatementKind)) {
    throw new DateraError(
      'INVALID_ARGUMENT',
      `Only UPDATE, DELETE and INSERT can be proposed as writes. This is a ${String(kind)}.` +
        (kind === 'SELECT' ? ' Use the query path for reads.' : ''),
      { sql, kind: String(kind) },
    );
  }

  return kind as WriteKind;
}

/**
 * Build the preview.
 *
 * The row count comes from running the statement's **own** WHERE clause as a SELECT, so
 * "this will change 1,203 rows" is measured against the same predicate that would run —
 * not estimated, and not taken from the model's description of its own SQL (§1.5).
 */
export async function previewWrite(options: {
  readonly engine: Engine;
  readonly schemaName: string;
  readonly sql: string;
  readonly kind: WriteKind;
}): Promise<{ table: string; rowsAffected: number; changes: readonly RowChange[]; warnings: string[] }> {
  const { engine, schemaName, sql, kind } = options;

  const table = extractTargetTable(sql, kind);
  const target = qualified(schemaName, table);
  const where = extractWhere(sql);
  const predicate = where === null ? 'true' : where;

  const warnings: string[] = [];

  const totalResult = await engine.executeInternal(`SELECT count(*) FROM ${target}`);
  const total = Number(totalResult.rows[0]?.[0] ?? 0);

  if (kind === 'INSERT') {
    return { table, rowsAffected: 1, changes: [], warnings };
  }

  const countResult = await engine.executeInternal(
    `SELECT count(*) FROM ${target} WHERE ${predicate}`,
  );
  const rowsAffected = Number(countResult.rows[0]?.[0] ?? 0);

  if (where === null) {
    warnings.push(
      `This statement has no WHERE clause, so it affects every row — all ${total} of them.`,
    );
  } else if (rowsAffected === total && total > 0) {
    warnings.push(`This matches every row in ${table} — all ${total} of them.`);
  }
  if (rowsAffected === 0) {
    warnings.push('This matches no rows. Confirming it would change nothing.');
  }

  const sample = await engine.executeInternal(
    `SELECT * FROM ${target} WHERE ${predicate} LIMIT ${PREVIEW_ROWS}`,
  );
  const columns = sample.columns.map((c) => c.name);

  // For an UPDATE, evaluate the SET expressions against the matched rows so the preview
  // shows the *actual* new values rather than the expression text.
  const assignments = kind === 'UPDATE' ? extractAssignments(sql) : [];
  let afterRows: readonly (readonly unknown[])[] = [];
  if (assignments.length > 0) {
    const projection = assignments.map((a) => `${a.expression} AS ${quoteIdent(a.column)}`).join(', ');
    const afterResult = await engine.executeInternal(
      `SELECT ${projection} FROM ${target} WHERE ${predicate} LIMIT ${PREVIEW_ROWS}`,
    );
    afterRows = afterResult.rows;
  }

  const changes: RowChange[] = sample.rows.map((row, i) => {
    const before = Object.fromEntries(columns.map((name, c) => [name, row[c]]));
    const after =
      assignments.length === 0
        ? {}
        : Object.fromEntries(assignments.map((a, c) => [a.column, afterRows[i]?.[c]]));
    return { before, after };
  });

  return { table, rowsAffected, changes, warnings };
}

/**
 * Apply a write, keeping enough to undo it.
 *
 * The table is snapshotted before the change. That is more storage than tracking
 * individual rows, and it is chosen deliberately: an undo that reconstructs rows from a
 * diff is a second implementation of "what changed", and if it is subtly wrong the user
 * finds out at the moment they most need it to be right.
 */
export async function applyWrite(options: {
  readonly engine: Engine;
  readonly schemaName: string;
  readonly undoSchema: string;
  readonly undoTable: string;
  readonly table: string;
  readonly sql: string;
}): Promise<number> {
  const { engine, schemaName, undoSchema, undoTable, table, sql } = options;

  await engine.executeInternal(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(undoSchema)}`);
  await engine.executeInternal(
    `CREATE TABLE ${qualified(undoSchema, undoTable)} AS SELECT * FROM ${qualified(schemaName, table)}`,
  );

  const beforeResult = await engine.executeInternal(
    `SELECT count(*) FROM ${qualified(schemaName, table)}`,
  );
  const before = Number(beforeResult.rows[0]?.[0] ?? 0);

  await engine.executeInternal('BEGIN TRANSACTION');
  try {
    await engine.executeInternal(`SET search_path = ${quoteIdent(schemaName)}`);
    await engine.executeInternal(sql);
    await engine.executeInternal('COMMIT');
  } catch (e) {
    await engine.executeInternal('ROLLBACK').catch(() => undefined);
    await engine
      .executeInternal(`DROP TABLE IF EXISTS ${qualified(undoSchema, undoTable)}`)
      .catch(() => undefined);
    throw e;
  }

  const afterResult = await engine.executeInternal(
    `SELECT count(*) FROM ${qualified(schemaName, table)}`,
  );
  const after = Number(afterResult.rows[0]?.[0] ?? 0);

  // For a DELETE the row delta is the answer; for an UPDATE the count is unchanged and the
  // matched count from the preview is the honest figure, which the caller supplies.
  return Math.abs(before - after);
}

export async function restore(options: {
  readonly engine: Engine;
  readonly schemaName: string;
  readonly undoSchema: string;
  readonly undoTable: string;
  readonly table: string;
}): Promise<void> {
  const { engine, schemaName, undoSchema, undoTable, table } = options;

  await engine.executeInternal('BEGIN TRANSACTION');
  try {
    await engine.executeInternal(
      `CREATE OR REPLACE TABLE ${qualified(schemaName, table)} AS SELECT * FROM ${qualified(undoSchema, undoTable)}`,
    );
    await engine.executeInternal('COMMIT');
  } catch (e) {
    await engine.executeInternal('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

/**
 * The table a write targets.
 *
 * Text extraction rather than the AST, because `json_serialize_sql` handles SELECT only —
 * the same limitation the scope guard works around. The statement has already been
 * classified by DuckDB's parser, so the shape is known; this only has to find the name.
 */
function extractTargetTable(sql: string, kind: WriteKind): string {
  // Quoted names are matched on the original, since the mask blanks their contents — but
  // the keyword search happens on the mask so an UPDATE inside a comment cannot win.
  const patterns: Record<WriteKind, RegExp> = {
    UPDATE: /\bUPDATE\s+(?:"([^"]+)"|([A-Za-z_][\w$]*))/i,
    DELETE: /\bDELETE\s+FROM\s+(?:"([^"]+)"|([A-Za-z_][\w$]*))/i,
    INSERT: /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+(?:"([^"]+)"|([A-Za-z_][\w$]*))/i,
  };

  const match = patterns[kind].exec(sql);
  const name = match?.[1] ?? match?.[2];
  if (name === undefined) {
    throw new DateraError('INVALID_ARGUMENT', 'Could not determine which table this write targets.', { sql });
  }
  return name;
}

function extractWhere(sql: string): string | null {
  // Searched against the mask, sliced out of the original. A WHERE inside a string literal
  // is not a WHERE clause, and reading it as one let a full-table UPDATE preview itself as
  // matching nothing.
  const masked = maskLiterals(sql);
  const match = /\bWHERE\b([\s\S]*?)(\bRETURNING\b|$)/i.exec(masked);
  if (match?.index === undefined) return null;

  const start = match.index + match[0].toUpperCase().indexOf('WHERE') + 'WHERE'.length;
  const end = match[2] !== undefined && match[2].length > 0
    ? match.index + match[0].length - match[2].length
    : match.index + match[0].length;

  const body = sql.slice(start, end).trim();
  return body.length === 0 ? null : body;
}

/** `SET a = expr, b = expr` → the column names and their expressions. */
function extractAssignments(sql: string): readonly { column: string; expression: string }[] {
  const masked = maskLiterals(sql);
  const match = /\bSET\b([\s\S]*?)(\bWHERE\b|\bRETURNING\b|$)/i.exec(masked);
  if (match?.index === undefined) return [];

  const start = match.index + match[0].toUpperCase().indexOf('SET') + 'SET'.length;
  const end = match[2] !== undefined && match[2].length > 0
    ? match.index + match[0].length - match[2].length
    : match.index + match[0].length;

  const body = sql.slice(start, end);
  // The mask again for the split: a comma or a bracket inside a value is data. Without
  // this, "Smith, John" split the assignment list into invalid SQL.
  const maskedBody = masked.slice(start, end);

  const out: { column: string; expression: string }[] = [];
  let depth = 0;
  let current = '';

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i] as string;
    const structural = maskedBody[i];
    if (structural === '(') depth += 1;
    if (structural === ')') depth -= 1;
    if (structural === ',' && depth === 0) {
      out.push(...parseAssignment(current));
      current = '';
      continue;
    }
    current += char;
  }
  out.push(...parseAssignment(current));
  return out;
}

function parseAssignment(text: string): readonly { column: string; expression: string }[] {
  const at = text.indexOf('=');
  if (at === -1) return [];
  const column = text.slice(0, at).trim().replace(/^"|"$/g, '');
  const expression = text.slice(at + 1).trim();
  return column.length > 0 && expression.length > 0 ? [{ column, expression }] : [];
}

/** A write must stay inside its dataset, exactly as a read must. */
export async function assertWriteInDataset(
  conn: DuckDBConnectionPort,
  sql: string,
  activeSchema: string,
  datasetName: string,
): Promise<void> {
  // The AST path only works for SELECT, so the check here is over the statement text.
  // A qualified name that is not the active schema is refused.
  //
  // Two bugs lived in the previous version of this. It scanned the raw text, so a value
  // containing a dot — an email address, a hostname — tripped a false refusal; and it only
  // matched bare identifiers, so `UPDATE "ds_other"."customers"` walked straight past the
  // one guard standing between a proposed write and another dataset. Both are the same
  // mistake: reading the statement without knowing which parts are data.
  //
  // Quoted and bare spellings are both matched now, against a mask where literals and
  // comments are blank but identifier *quotes* are preserved.
  void (await extractTableReferences(conn, sql));

  const masked = maskIdentifiersKept(sql);
  const qualifiedNames = [
    ...masked.matchAll(/(?:"([^"]+)"|\b([A-Za-z_][\w$]*))\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*)/g),
  ];
  const offending = qualifiedNames
    .map((m) => (m[1] ?? m[2]) as string)
    .filter((schema) => schema.toLowerCase() !== activeSchema.toLowerCase());

  if (offending.length > 0) {
    throw new DateraError(
      'CROSS_DATASET_ACCESS',
      `This write names ${[...new Set(offending)].join(', ')}, which is outside "${datasetName}".`,
      { sql, activeDataset: datasetName, offending: [...new Set(offending)] },
    );
  }
}
