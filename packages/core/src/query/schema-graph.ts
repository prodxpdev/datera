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

export type CompletionKind = 'table' | 'column' | 'keyword' | 'join';

export interface CompletionItem {
  readonly label: string;
  readonly kind: CompletionKind;
  /** Type, dictionary meaning, or which table a column came from. */
  readonly detail: string;
  /** What to insert, when it differs from the label (join conditions). */
  readonly insert: string;
}

export interface CompletionOptions {
  /**
   * 'typing' — the picker is appearing on its own, so it must earn the interruption.
   * 'explicit' — the user pressed ⌃Space and asked for the whole list.
   */
  readonly trigger?: 'typing' | 'explicit' | undefined;
}

export interface CompletionResult {
  /** The partial word the items replace, so the editor knows what to overwrite. */
  readonly replacing: string;
  readonly items: readonly CompletionItem[];
}

const EMPTY: CompletionResult = { replacing: '', items: [] };

/** More than fits without scrolling is a list you read instead of typing past. */
const MAX_ITEMS = 12;

/**
 * Keywords are held back until two characters. There are thirty of them and one letter
 * matches a third of the alphabet's worth — they are also the part a user is least likely
 * to need help spelling.
 */
const MIN_KEYWORD_PREFIX = 2;

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'JOIN',
  'LEFT JOIN', 'INNER JOIN', 'ON', 'AS', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN',
  'MAX', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'NOT', 'NULL', 'BETWEEN',
  'IN', 'LIKE', 'ASC', 'DESC', 'WITH', 'UNION', 'EXPLAIN',
];

/**
 * What could come next at `cursor`, from the schema alone.
 *
 * No model. Completing a column name is a lookup, not a judgement — the answer is sitting
 * in the graph, exact and free. Asking a model would be slower, occasionally wrong, and on
 * the local tier would spend forty-five seconds suggesting a word the user already
 * half-typed. It also means the editor keeps working with no key configured and no
 * network, which is the point of the product.
 */
export function completionsAt(
  graph: SchemaGraph,
  sql: string,
  cursor: number,
  options: CompletionOptions = {},
): CompletionResult {
  const explicit = options.trigger === 'explicit';
  const before = sql.slice(0, cursor);
  if (insideStringLiteral(before)) return EMPTY;

  const word = /[\w$]*$/.exec(before)?.[0] ?? '';
  const prefix = before.slice(0, before.length - word.length);

  // `alias.` or `table.` — only that table's columns, and nothing else.
  const qualifier = /([\w$]+|"[^"]+")\s*\.\s*$/.exec(prefix);
  if (qualifier !== null) {
    const table = resolveQualifier(graph, sql, unquote(qualifier[1]!));
    if (table === undefined) return { replacing: word, items: [] };
    return capped(word, table.columns.map(columnItem(table)).filter(matches(word)));
  }

  const clause = lastKeyword(prefix);

  // These three positions ask a specific question with few possible answers, so the
  // picker is welcome even with nothing typed.
  if (clause === 'FROM' || clause === 'JOIN') {
    return capped(word, graph.tables.map(tableItem).filter(matches(word)));
  }

  if (clause === 'ON') {
    const joins = joinConditions(graph, sql).filter(matches(word));
    if (joins.length > 0) return capped(word, joins);
  }

  // Everywhere else the cursor could be almost anything, so the picker has to earn the
  // interruption. Uninvited, it waits for a prefix: a list that opens on a space covers
  // the query being written, and its highlighted first entry is one Tab from insertion.
  if (!explicit && word.length === 0) return EMPTY;

  // Columns of the tables this query has actually named — offering every column in the
  // dataset would bury the five that can be typed here under the forty that cannot.
  const columns = tablesInScope(graph, sql).flatMap((t) => t.columns.map(columnItem(t)));

  const keywords =
    explicit || word.length >= MIN_KEYWORD_PREFIX
      ? KEYWORDS.map((k): CompletionItem => ({ label: k, kind: 'keyword' as const, detail: '', insert: k }))
      : [];

  // Columns first: they are what the schema knows and what a keyword cannot be guessed
  // from. Keywords are the fallback, not the headline.
  return capped(word, [...columns, ...keywords].filter(matches(word)));
}

function capped(word: string, items: readonly CompletionItem[]): CompletionResult {
  return { replacing: word, items: items.slice(0, MAX_ITEMS) };
}

function matches(word: string): (item: CompletionItem) => boolean {
  if (word.length === 0) return () => true;
  const lower = word.toLowerCase();
  return (item) => item.label.toLowerCase().startsWith(lower);
}

function tableItem(table: GraphTable): CompletionItem {
  const hidden = table.hiddenColumns > 0 ? `, ${table.hiddenColumns} hidden` : '';
  return {
    label: table.name,
    kind: 'table',
    detail: `${table.rowCount.toLocaleString()} rows · ${table.columns.length} columns${hidden}`,
    insert: quoteIfNeeded(table.name),
  };
}

function columnItem(table: GraphTable): (column: GraphColumn) => CompletionItem {
  return (column) => ({
    label: column.name,
    kind: 'column',
    // The confirmed meaning first when there is one: it is the thing that stops
    // `revenue_cents` being summed as if it were dollars.
    detail: column.meaning.length > 0
      ? `${column.meaning} · ${column.type} · ${table.name}`
      : `${column.type} · ${table.name}`,
    insert: quoteIfNeeded(column.name),
  });
}

/**
 * Confirmed relationships between the tables this query names, as ready-made conditions.
 * After ON, the join a human already ratified is the suggestion worth making.
 */
function joinConditions(graph: SchemaGraph, sql: string): CompletionItem[] {
  const named = new Set(tablesInScope(graph, sql).map((t) => t.name.toLowerCase()));

  return graph.relationships
    .filter((r) => named.has(r.fromTable.toLowerCase()) && named.has(r.toTable.toLowerCase()))
    .map((r) => {
      const text = `${r.fromTable}.${r.fromColumn} = ${r.toTable}.${r.toColumn}`;
      return { label: text, kind: 'join' as const, detail: 'confirmed relationship', insert: text };
    });
}

function tablesInScope(graph: SchemaGraph, sql: string): GraphTable[] {
  const names = referencedTables(sql, graph.tables.map((t) => t.name));
  return graph.tables.filter((t) => names.includes(t.name));
}

/**
 * Which table a qualifier refers to — either its own name, or an alias bound by
 * `FROM t alias` / `JOIN t AS alias`.
 */
function resolveQualifier(graph: SchemaGraph, sql: string, qualifier: string): GraphTable | undefined {
  const direct = graph.tables.find((t) => t.name.toLowerCase() === qualifier.toLowerCase());
  if (direct !== undefined) return direct;

  const bindings = /\b(?:FROM|JOIN)\s+("[^"]+"|[\w$]+)(?:\s+AS)?\s+("[^"]+"|[\w$]+)/gi;
  for (const match of sql.matchAll(bindings)) {
    const alias = unquote(match[2]!);
    if (alias.toLowerCase() !== qualifier.toLowerCase()) continue;
    // `FROM orders WHERE` binds no alias — `WHERE` is a keyword, not a name.
    if (KEYWORDS.includes(alias.toUpperCase())) continue;
    const table = unquote(match[1]!);
    return graph.tables.find((t) => t.name.toLowerCase() === table.toLowerCase());
  }
  return undefined;
}

/** The clause keyword governing the cursor, if the cursor sits directly after one. */
function lastKeyword(prefix: string): string | undefined {
  const trailing = /(?:^|[\s(,])([A-Za-z]+)\s+$/.exec(prefix);
  if (trailing === null) return undefined;
  const word = trailing[1]!.toUpperCase();
  return word === 'FROM' || word === 'JOIN' || word === 'ON' ? word : undefined;
}

/** An odd number of unescaped quotes before the cursor means we are inside a literal. */
function insideStringLiteral(before: string): boolean {
  return (before.replace(/''/g, '').match(/'/g) ?? []).length % 2 === 1;
}

function unquote(name: string): string {
  return name.startsWith('"') ? name.slice(1, -1).replace(/""/g, '"') : name;
}
