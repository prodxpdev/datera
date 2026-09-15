import type { SourceSchema } from '../schema/introspect.js';

/**
 * Builds the context the model is given — and nothing else.
 *
 * This is the enforcement point for invariant §1.4 and acceptance §12.2: **only schema
 * and (from Phase 3) dictionary definitions reach the model. Never data rows.**
 *
 * That is why this module takes `SourceSchema` rather than a source id or a connection.
 * It structurally cannot reach a value: there is nothing here to read rows *with*. A
 * function that took a `Datera` and "used just the schema" would be one careless edit
 * away from sending someone's customer list to a third party.
 *
 * `sampleValues` on ColumnSchema is deliberately not used. Samples are real data, useful
 * for the dictionary auto-draft in Phase 3 — which runs locally — but they are still
 * cells out of the user's file and they do not go into a model payload.
 */

export interface ContextOptions {
  /** Cap, so a 400-column warehouse table cannot produce an unusable prompt. */
  readonly maxColumnsPerSource?: number | undefined;
}

const DEFAULT_MAX_COLUMNS = 80;

export function buildSchemaContext(
  schemas: readonly SourceSchema[],
  options: ContextOptions = {},
): string {
  const maxColumns = options.maxColumnsPerSource ?? DEFAULT_MAX_COLUMNS;
  const blocks: string[] = [];

  for (const schema of schemas) {
    const shown = schema.columns.slice(0, maxColumns);
    const omitted = schema.columns.length - shown.length;

    const columns = shown
      .map((c) => {
        const notes: string[] = [];
        if (c.nullCount > 0) notes.push('nullable');
        // The inference caveat is about the *type*, not about any value, so it is safe to
        // pass on — and it materially improves the SQL, since a model told a column is
        // text-holding-numbers will cast rather than sum blindly.
        if (c.inference?.verdict === 'ambiguous') {
          notes.push(`text, but mostly ${c.inference.candidateType}: cast before arithmetic`);
        }
        return `  ${c.name} ${c.type}${notes.length > 0 ? ` -- ${notes.join('; ')}` : ''}`;
      })
      .join('\n');

    blocks.push(
      `TABLE ${schema.sourceName} (${schema.rowCount} rows)\n${columns}` +
        (omitted > 0 ? `\n  -- ${omitted} further columns omitted` : ''),
    );
  }

  return blocks.join('\n\n');
}

/** A one-line summary for the trace's schema stage. */
export function summariseSchemas(schemas: readonly SourceSchema[]): string {
  const tables = schemas.length;
  const columns = schemas.reduce((n, s) => n + s.columns.length, 0);
  const names = schemas.map((s) => s.sourceName).join(', ');
  return `${tables} table${tables === 1 ? '' : 's'} (${names}), ${columns} columns. Schema only — no data rows were included.`;
}

export const SYSTEM_PROMPT = [
  'You translate questions into a single DuckDB SQL SELECT statement.',
  '',
  'Rules:',
  '- Return ONLY SQL. No prose, no explanation.',
  '- Exactly one statement. Never more than one.',
  '- SELECT only. Never INSERT, UPDATE, DELETE, CREATE, DROP, COPY, or ATTACH.',
  '- Use only the tables and columns given below. Never invent a column.',
  '- If the question cannot be answered from these tables and columns, reply with',
  '  exactly: CANNOT_ANSWER: <short reason>',
  '- Money stored in a *_cents column is in minor units; divide by 100.0 for display.',
].join('\n');

export function buildUserPrompt(question: string, schemaContext: string): string {
  return [
    'Tables available:',
    '',
    schemaContext,
    '',
    `Question: ${question}`,
    '',
    'SQL:',
  ].join('\n');
}
