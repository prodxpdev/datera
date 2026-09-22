import { DateraError } from '../errors.js';
import type { Engine } from '../engine/engine.js';
import { quoteIdent, quoteLiteral } from '../engine/sql.js';
import type { AuthoredColumn, AuthoredTable } from './authoring.js';

/**
 * Turning a paste into a schema proposal (spec §3a).
 *
 * §3a's second entry path is "you have a shape in mind and no data yet" — declare it,
 * write DDL, paste JSON, or drop in a schema an assistant produced. The paste is what
 * makes it useful rather than a form with an Add Column button.
 *
 * ## Why the database parses the DDL
 *
 * A regex over CREATE TABLE would have to understand `DECIMAL(10,2)`, `VARCHAR[]`,
 * `TIMESTAMP WITH TIME ZONE`, quoted identifiers, and inline constraints — and would get
 * one of them wrong. DuckDB already has a parser, so the DDL is executed in a throwaway
 * schema and the *result* is introspected. What comes back is exactly what would be
 * created, with the database's own error message when it will not parse.
 *
 * `json_serialize_sql` would be the obvious alternative and cannot help: it refuses
 * anything that is not a SELECT.
 *
 * ## Why executing a paste is safe here
 *
 * The text may be something the user has not read, quite possibly written by a model. So
 * every statement is classified first and only CREATE survives — no reads, no writes, no
 * COPY (which writes a file), no ATTACH (which reaches another database). It runs in a
 * scratch schema that is dropped either way, and nothing reaches the user's dataset until
 * they apply the proposal (§1.3).
 */

export interface SchemaRelationshipDraft {
  readonly fromTable: string;
  readonly fromColumn: string;
  readonly toTable: string;
  readonly toColumn: string;
}

export interface SchemaProposal {
  readonly tables: readonly AuthoredTable[];
  readonly relationships: readonly SchemaRelationshipDraft[];
  /** How it was read, so the UI can say so rather than guess. */
  readonly source: 'sql' | 'json';
}

/** Scratch schemas are named per attempt so two pastes cannot collide. */
const SCRATCH_PREFIX = '_datera_draft_';

export async function proposeSchemaFrom(
  engine: Engine,
  text: string,
  makeId: () => string,
): Promise<SchemaProposal> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new DateraError('INVALID_ARGUMENT', 'Nothing to read — paste a schema first.');
  }

  return trimmed.startsWith('{') || trimmed.startsWith('[')
    ? fromJson(trimmed)
    : fromDdl(engine, trimmed, makeId);
}

/**
 * The shape an assistant tends to produce when asked for a schema as JSON.
 *
 * Forgiving about what it accepts — `required` as a synonym for not-null, `pk` for
 * primary key — because the text is generated and the alternative is a user editing a
 * model's output to satisfy a parser.
 */
function fromJson(text: string): SchemaProposal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new DateraError(
      'INVALID_ARGUMENT',
      `That is not valid JSON: ${(e as Error).message}`,
    );
  }

  const root = Array.isArray(parsed) ? { tables: parsed } : (parsed as Record<string, unknown>);
  const rawTables = root['tables'];
  if (!Array.isArray(rawTables) || rawTables.length === 0) {
    throw new DateraError(
      'INVALID_ARGUMENT',
      'Expected a "tables" array — for example {"tables":[{"name":"books","columns":[{"name":"isbn","type":"VARCHAR"}]}]}.',
    );
  }

  const tables: AuthoredTable[] = rawTables.map((raw) => {
    const table = raw as Record<string, unknown>;
    const name = String(table['name'] ?? '');
    const rawColumns = table['columns'];
    if (!Array.isArray(rawColumns) || rawColumns.length === 0) {
      throw new DateraError('INVALID_ARGUMENT', `Table "${name}" has no columns.`);
    }

    const columns: AuthoredColumn[] = rawColumns.map((rawColumn) => {
      const column = rawColumn as Record<string, unknown>;
      const primaryKey = column['primaryKey'] === true || column['pk'] === true;
      const nullable =
        column['nullable'] === false || column['required'] === true || primaryKey ? false : true;
      return {
        name: String(column['name'] ?? ''),
        type: String(column['type'] ?? 'VARCHAR'),
        nullable,
        primaryKey,
      };
    });

    return { name, columns };
  });

  const rawLinks = root['relationships'];
  const relationships: SchemaRelationshipDraft[] = Array.isArray(rawLinks)
    ? rawLinks.map((raw) => {
        const link = raw as Record<string, unknown>;
        return {
          fromTable: String(link['fromTable'] ?? ''),
          fromColumn: String(link['fromColumn'] ?? ''),
          toTable: String(link['toTable'] ?? ''),
          toColumn: String(link['toColumn'] ?? ''),
        };
      })
    : [];

  return { tables, relationships, source: 'json' };
}

async function fromDdl(
  engine: Engine,
  sql: string,
  makeId: () => string,
): Promise<SchemaProposal> {
  const statements = splitStatements(sql);
  if (statements.length === 0) {
    throw new DateraError('INVALID_ARGUMENT', 'No statements found in that paste.');
  }

  const scratch = `${SCRATCH_PREFIX}${makeId().replace(/[^a-z0-9]/gi, '').slice(0, 12)}`;
  const conn = engine.classificationConnection();

  try {
    await engine.executeInternal(`CREATE SCHEMA ${quoteIdent(scratch)}`);
    await engine.executeInternal(`SET search_path = ${quoteIdent(scratch)}`);

    // Classified and executed one at a time, in order, because classification *binds*:
    // `CREATE TABLE orders (customer_id VARCHAR REFERENCES customers(id))` cannot be
    // classified until `customers` exists. Running the earlier statements first is what
    // makes the later ones classifiable — and keeps the check DuckDB's rather than a
    // regex's, which is the whole point of doing it this way.
    for (const statement of statements) {
      const classified = await conn.classify(statement);
      const kinds = classified.statements.map((st) => st.kind);

      if (kinds.length !== 1 || kinds[0] !== 'CREATE') {
        throw new DateraError(
          'INVALID_ARGUMENT',
          `A schema is made of CREATE TABLE statements. Refused: ${
            kinds.filter((k) => k !== 'CREATE').join(', ') || 'a statement that could not be read as one'
          }.`,
          { offending: kinds },
        );
      }

      await engine.executeInternal(statement);
    }

    return {
      tables: await introspectScratch(engine, scratch),
      relationships: await foreignKeysIn(engine, scratch),
      source: 'sql',
    };
  } finally {
    // Dropped whatever happened. A failed paste that left a scratch schema behind would
    // collide with the next attempt, and the user would see a stranger error than the
    // one they caused.
    await engine.executeInternal(`DROP SCHEMA IF EXISTS ${quoteIdent(scratch)} CASCADE`)
      .catch(() => undefined);
  }
}

/**
 * Split a paste into statements on semicolons that are not inside a literal, an
 * identifier or a comment.
 *
 * Lexical, not semantic: this decides where one statement ends, and DuckDB still decides
 * what each one *is*. That distinction is why a scanner is acceptable here when it would
 * not be for classification.
 */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      current += ch;
      i += 1;
      while (i < sql.length) {
        current += sql[i];
        if (sql[i] === quote) {
          // A doubled quote is an escape, not the end.
          if (sql[i + 1] === quote) {
            current += sql[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === ';') {
      if (current.trim().length > 0) statements.push(current.trim());
      current = '';
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  if (current.trim().length > 0) statements.push(current.trim());
  return statements;
}

async function introspectScratch(engine: Engine, scratch: string): Promise<readonly AuthoredTable[]> {
  const result = await engine.executeInternal(
    `SELECT table_name, column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = ${quoteLiteral(scratch)}
     ORDER BY table_name, ordinal_position`,
  );

  const keys = await primaryKeysIn(engine, scratch);
  const byTable = new Map<string, AuthoredColumn[]>();

  for (const row of result.rows) {
    const table = String(row[0]);
    const column = String(row[1]);
    const columns = byTable.get(table) ?? [];
    columns.push({
      name: column,
      // The type DuckDB resolved, verbatim — DECIMAL(10,2) stays DECIMAL(10,2).
      type: String(row[2]),
      nullable: String(row[3]).toUpperCase() === 'YES',
      primaryKey: keys.has(`${table}.${column}`),
    });
    byTable.set(table, columns);
  }

  return [...byTable.entries()].map(([name, columns]) => ({ name, columns }));
}

async function primaryKeysIn(engine: Engine, scratch: string): Promise<ReadonlySet<string>> {
  const result = await engine.executeInternal(
    `SELECT table_name, constraint_column_names
     FROM duckdb_constraints()
     WHERE schema_name = ${quoteLiteral(scratch)} AND constraint_type = 'PRIMARY KEY'`,
  );

  const keys = new Set<string>();
  for (const row of result.rows) {
    for (const column of asStringArray(row[1])) keys.add(`${String(row[0])}.${column}`);
  }
  return keys;
}

/**
 * Foreign keys, as proposed relationships.
 *
 * Read from the scratch schema and then discarded with it: Datera records relationships
 * in its own catalog rather than as database constraints (see authoring.ts), because a
 * relationship between two *sources* is a view over a file and cannot carry one.
 */
async function foreignKeysIn(
  engine: Engine,
  scratch: string,
): Promise<readonly SchemaRelationshipDraft[]> {
  const result = await engine.executeInternal(
    `SELECT table_name, constraint_column_names, referenced_table, referenced_column_names
     FROM duckdb_constraints()
     WHERE schema_name = ${quoteLiteral(scratch)} AND constraint_type = 'FOREIGN KEY'`,
  );

  const links: SchemaRelationshipDraft[] = [];
  for (const row of result.rows) {
    const from = asStringArray(row[1]);
    const to = asStringArray(row[3]);
    // Composite keys are not represented here. Datera's relationship model is
    // single-column, so a composite one is dropped rather than silently halved.
    if (from.length !== 1 || to.length !== 1) continue;
    links.push({
      fromTable: String(row[0]),
      fromColumn: from[0]!,
      toTable: String(row[2]),
      toColumn: to[0]!,
    });
  }
  return links;
}

/**
 * A DuckDB LIST column, as JavaScript.
 *
 * The driver hands lists back as `{ items: [...] }` rather than as an array, which is the
 * kind of detail that silently produces an empty result: primary keys were simply never
 * detected until this handled that shape.
 */
function asStringArray(value: unknown): string[] {
  const raw = ((): string[] => {
    if (Array.isArray(value)) return value.map((v) => String(v));

    if (typeof value === 'object' && value !== null && 'items' in value) {
      const items = (value as { items: unknown }).items;
      if (Array.isArray(items)) return items.map((v) => String(v));
    }

    if (typeof value === 'string') {
      return value.replace(/^[[{]|[\]}]$/g, '').split(',').map((v) => v.trim());
    }
    return [];
  })();

  // The driver renders list members with their quotes, so a column arrives as
  // `'customer_id'` — which then fails to match any real column, with an error naming a
  // column that looks almost right.
  return raw
    .map((item) => item.replace(/^['"]|['"]$/g, '').trim())
    .filter((item) => item.length > 0);
}
