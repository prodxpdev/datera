import type { SourceSchema } from '../schema/introspect.js';
import type { AuthoredRelationship } from '../datasets/authoring.js';
import { confirmedOnly, type SourceDictionary } from '../dictionary/types.js';

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
  /**
   * Confirmed definitions only. Suggestions are filtered here rather than by the caller,
   * so there is exactly one place where "propose then confirm" could be got wrong (§1.3).
   */
  readonly dictionaries?: readonly SourceDictionary[] | undefined;
  /** Confirmed relationships, so the model knows what may legitimately be joined. */
  readonly relationships?: readonly AuthoredRelationship[] | undefined;
}

const DEFAULT_MAX_COLUMNS = 80;

export function buildSchemaContext(
  schemas: readonly SourceSchema[],
  options: ContextOptions = {},
): string {
  const maxColumns = options.maxColumnsPerSource ?? DEFAULT_MAX_COLUMNS;
  const byName = new Map(
    (options.dictionaries ?? []).map((d) => [d.sourceName, confirmedOnly(d)]),
  );
  const blocks: string[] = [];

  for (const schema of schemas) {
    const dictionary = byName.get(schema.sourceName);
    const definitions = new Map((dictionary?.columns ?? []).map((c) => [c.column, c]));

    // A column marked sensitive is removed entirely — not its values, not its name
    // (§4, hide-from-NL). A column called `patient_ssn` leaks something by existing.
    const visible = schema.columns.filter(
      (c) => definitions.get(c.name)?.sensitivity !== 'hidden',
    );
    const hiddenCount = schema.columns.length - visible.length;

    const shown = visible.slice(0, maxColumns);
    const omitted = visible.length - shown.length;

    const columns = shown
      .map((c) => {
        const definition = definitions.get(c.name);
        const notes: string[] = [];

        if (c.nullCount > 0) notes.push('nullable');
        // The inference caveat is about the type, not any value, so it is safe to pass on
        // — and it materially improves the SQL, since a model told a column is
        // text-holding-numbers will cast rather than sum blindly.
        if (c.inference?.verdict === 'ambiguous') {
          notes.push(`text, but mostly ${c.inference.candidateType}: cast before arithmetic`);
        }
        if (definition !== undefined) {
          if (definition.meaning.length > 0) notes.push(definition.meaning);
          if (definition.unit.length > 0) notes.push(definition.unit);
          if (definition.aliases.length > 0) notes.push(`also called: ${definition.aliases.join(', ')}`);
          if (definition.role.length > 0) notes.push(`role: ${definition.role}`);
          const enums = (definition.enumValues ?? []).filter((e) => e.meaning.length > 0);
          if (enums.length > 0) {
            notes.push(`values: ${enums.map((e) => `${e.value} = ${e.meaning}`).join('; ')}`);
          }
        }

        return `  ${c.name} ${c.type}${notes.length > 0 ? ` -- ${notes.join(' | ')}` : ''}`;
      })
      .join('\n');

    const header =
      dictionary !== undefined && dictionary.entity.state === 'confirmed'
        ? `TABLE ${schema.sourceName} (${schema.rowCount} rows) -- ${dictionary.entity.meaning} ` +
          `Grain: ${dictionary.entity.grain}.` +
          (dictionary.entity.primaryKey.length > 0 ? ` Key: ${dictionary.entity.primaryKey}.` : '')
        : `TABLE ${schema.sourceName} (${schema.rowCount} rows)`;

    blocks.push(
      `${header}\n${columns}` +
        (omitted > 0 ? `\n  -- ${omitted} further columns omitted` : '') +
        (hiddenCount > 0 ? `\n  -- ${hiddenCount} column(s) withheld by the user` : ''),
    );
  }

  const relationships = options.relationships ?? [];
  if (relationships.length > 0) {
    blocks.push(
      'Confirmed relationships (these are the only joins that make sense):\n' +
        relationships
          .map((r) => `  ${r.fromTable}.${r.fromColumn} -> ${r.toTable}.${r.toColumn}`)
          .join('\n'),
    );
  }

  return blocks.join('\n\n');
}

/** A one-line summary for the trace's schema stage. */
export function summariseSchemas(
  schemas: readonly SourceSchema[],
  options: ContextOptions = {},
): string {
  const tables = schemas.length;
  const columns = schemas.reduce((n, s) => n + s.columns.length, 0);
  const names = schemas.map((s) => s.sourceName).join(', ');

  const confirmed = (options.dictionaries ?? [])
    .map((d) => confirmedOnly(d).columns.length)
    .reduce((a, b) => a + b, 0);
  const hidden = (options.dictionaries ?? [])
    .flatMap((d) => confirmedOnly(d).columns)
    .filter((c) => c.sensitivity === 'hidden').length;

  const parts = [
    `${tables} table${tables === 1 ? '' : 's'} (${names}), ${columns} columns`,
    `${confirmed} confirmed dictionary definition${confirmed === 1 ? '' : 's'} included`,
  ];
  if (hidden > 0) parts.push(`${hidden} column(s) withheld as sensitive`);
  parts.push('Schema and definitions only — no data rows were included');

  return `${parts.join('. ')}.`;
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
