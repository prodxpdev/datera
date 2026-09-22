import type { GraphColumn, GraphTable, SchemaGraph } from './schema-graph.js';

/**
 * Starter questions for a dataset, derived from its shape.
 *
 * Someone who has never written a query does not know what their data can answer. An
 * empty box with a blinking cursor is not neutral — it assumes an expertise the product
 * claims not to require.
 *
 * These are built by rule rather than by a model, for the same reason completions are:
 * the schema already knows. That also means they appear instantly, with no key
 * configured, and can never name a column that is not there — the failure mode of a
 * generated suggestion is a question the user cannot ask, which is worse than no
 * suggestion at all.
 *
 * Each one carries `because`, naming the columns behind it. The suggestion is a lesson in
 * what makes a question answerable, not just a shortcut past having to think of one.
 */

export type SuggestionKind = 'count' | 'group' | 'trend' | 'join';

export interface Suggestion {
  readonly question: string;
  readonly kind: SuggestionKind;
  /** Which columns this leans on, and what they mean. Shown under the suggestion. */
  readonly because: string;
}

const MAX = 6;

const NUMERIC = /^(TINY|SMALL|BIG|HUGE)?INT|^DECIMAL|^NUMERIC|^DOUBLE|^FLOAT|^REAL|^UINT/i;
const TEMPORAL = /^DATE|^TIMESTAMP|^TIME\b/i;

export function suggestQuestions(graph: SchemaGraph): readonly Suggestion[] {
  if (graph.tables.length === 0) return [];

  const suggestions: Suggestion[] = [];
  // Largest table first: it is usually the one the dataset is about.
  const tables = [...graph.tables].sort((a, b) => b.rowCount - a.rowCount);
  const main = tables[0]!;

  suggestions.push({
    question: `How many rows are in ${main.name}?`,
    kind: 'count',
    because: `${main.name} has ${main.rowCount.toLocaleString()} rows — the simplest question that proves the connection works.`,
  });

  const measure = measureOf(main);
  const dimension = dimensionOf(main);

  if (measure !== undefined && dimension !== undefined) {
    suggestions.push({
      question: `What is the total ${measure.name} by ${dimension.name}?`,
      kind: 'group',
      because: [
        describe(measure, 'a number, so it can be summed'),
        describe(dimension, 'text, so it can group the rows'),
      ].join(' · '),
    });
  } else if (measure !== undefined) {
    suggestions.push({
      question: `What is the total ${measure.name}?`,
      kind: 'group',
      because: describe(measure, 'a number, so it can be summed'),
    });
  }

  const date = main.columns.find((c) => TEMPORAL.test(c.type));
  if (date !== undefined) {
    const what = measure === undefined ? 'rows' : `total ${measure.name}`;
    suggestions.push({
      question: `How does ${what} change by month, using ${date.name}?`,
      kind: 'trend',
      because: describe(date, 'a date, so rows can be bucketed into months'),
    });
  }

  for (const link of graph.relationships) {
    if (suggestions.length >= MAX) break;
    suggestions.push({
      question: `For each ${link.toTable}, how many matching ${link.fromTable} are there?`,
      kind: 'join',
      because: `${link.fromTable}.${link.fromColumn} was confirmed to match ${link.toTable}.${link.toColumn}. Only confirmed links may be joined.`,
    });
  }

  // A second table with no confirmed link is still worth naming — the honest suggestion
  // there is the one that explains why it cannot be joined yet.
  const unlinked = tables.slice(1).find((t) => !isLinked(graph, t.name));
  if (unlinked !== undefined && suggestions.length < MAX) {
    suggestions.push({
      question: `How many rows are in ${unlinked.name}?`,
      kind: 'count',
      because: `${unlinked.name} has no confirmed relationship to ${main.name} yet, so it can only be asked about on its own. Confirm a link in Dictionary to join them.`,
    });
  }

  return suggestions.slice(0, MAX);
}

function describe(column: GraphColumn, why: string): string {
  return column.meaning.length > 0
    ? `${column.name}: ${column.meaning}`
    : `${column.name} is ${column.type} — ${why}`;
}

/** The first numeric column that is not a key. Summing an id is a classic beginner trap. */
function measureOf(table: GraphTable): GraphColumn | undefined {
  return table.columns.find(
    (c) => NUMERIC.test(c.type) && !c.isKey && !/_?id$/i.test(c.name),
  );
}

function dimensionOf(table: GraphTable): GraphColumn | undefined {
  return table.columns.find((c) => /^VARCHAR|^TEXT|^BOOLEAN|^ENUM/i.test(c.type) && !c.isKey);
}

function isLinked(graph: SchemaGraph, table: string): boolean {
  const lower = table.toLowerCase();
  return graph.relationships.some(
    (r) => r.fromTable.toLowerCase() === lower || r.toTable.toLowerCase() === lower,
  );
}
