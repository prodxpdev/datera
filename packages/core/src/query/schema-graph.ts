/**
 * The dataset's shape, in one structure.
 *
 * Feeds three things that must agree: the schema visualisation, the SQL editor's
 * completions, and the starter query. Deriving them from one graph means the picker
 * cannot offer a column the diagram does not show, and neither can offer one the model
 * context withholds.
 */

export interface GraphColumn {
  readonly name: string;
  readonly type: string;
  /** Participates in a confirmed relationship. */
  readonly isKey: boolean;
  readonly nullCount: number;
  /** Confirmed dictionary meaning, if any. Shown in completions and on hover. */
  readonly meaning: string;
}

export interface GraphTable {
  readonly name: string;
  readonly rowCount: number;
  readonly columns: readonly GraphColumn[];
  /** How many columns were withheld as sensitive, so the omission is visible. */
  readonly hiddenColumns: number;
}

export interface GraphRelationship {
  readonly fromTable: string;
  readonly fromColumn: string;
  readonly toTable: string;
  readonly toColumn: string;
}

export interface SchemaGraph {
  readonly datasetId: string;
  readonly tables: readonly GraphTable[];
  readonly relationships: readonly GraphRelationship[];
}

/**
 * A query to open the editor with, built from the schema that actually exists.
 *
 * Replaces a hardcoded `SELECT * FROM orders LIMIT 20`, which greeted anyone whose data
 * did not happen to contain a table called `orders` with a catalog error.
 */
export function starterSql(graph: SchemaGraph): string {
  const table = graph.tables[0];
  if (table === undefined) {
    return '-- No sources in this dataset yet. Connect one in Workspace.';
  }

  const columns = table.columns.slice(0, 6).map((c) => c.name);
  const projection = columns.length === 0 || columns.length === table.columns.length
    ? '*'
    : columns.join(', ');

  return `SELECT ${projection}\nFROM ${quoteIfNeeded(table.name)}\nLIMIT 20;`;
}

function quoteIfNeeded(name: string): string {
  return /^[A-Za-z_][\w$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/**
 * Which known tables a (possibly half-typed) query mentions.
 *
 * A tolerant text scan, **deliberately** — unlike the dataset-boundary guard, which walks
 * DuckDB's parse tree because it is a correctness boundary. This runs on every keystroke
 * against SQL that usually does not parse yet, and it only drives highlighting. Being
 * approximately right about which box to outline is fine; being approximately right about
 * what a query may read is not.
 */
export function referencedTables(sql: string, tableNames: readonly string[]): readonly string[] {
  const withoutStrings = sql.replace(/'(?:[^']|'')*'?/g, ' ');
  const found: string[] = [];

  for (const name of tableNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Word-bounded and quote-tolerant, so `orders_archive` does not match `orders`.
    if (new RegExp(`(^|[^\\w"])"?${escaped}"?($|[^\\w"])`, 'i').test(withoutStrings)) {
      found.push(name);
    }
  }

  return found;
}
