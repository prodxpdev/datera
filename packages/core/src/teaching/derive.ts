import type { SourceSchema } from '../schema/introspect.js';
import type { SourceDictionary } from '../dictionary/types.js';
import { DEFAULT_LIFECYCLE, type Lifecycle } from './lifecycle.js';

/**
 * Build a lifecycle from the data actually connected (spec §5, §11.9).
 *
 * The shipped `revenue` example teaches the concept; it does not teach *your* schema. The
 * teaching module's claim is that Datera makes the invisible parts of working with your
 * data visible, so when there is a suitable column it is used.
 *
 * Still **curated, not traced**. The layers above the table — entity, business object,
 * DTO, view — are the standard ones, because Datera has not read anyone's application
 * code and the module must not imply that it has. What is grounded is the *value*: a real
 * column, its real type, and a real value out of the data.
 */

export function deriveLifecycle(
  schemas: readonly SourceSchema[],
  dictionaries: readonly SourceDictionary[],
  sample: { readonly column: string; readonly value: string } | null,
): Lifecycle {
  const chosen = chooseColumn(schemas);
  if (chosen === null) return { ...DEFAULT_LIFECYCLE, grounding: 'generic' };

  const { schema, column } = chosen;
  const dictionary = dictionaries.find((d) => d.sourceName === schema.sourceName);
  const definition = dictionary?.columns.find(
    (c) => c.column === column.name && c.state === 'confirmed',
  );

  const isMinorUnits = /_(cents|cent|pence|minor)$/i.test(column.name);
  const raw = sample?.value ?? (isMinorUnits ? '8900' : column.sampleValues[0] ?? '…');
  const major = isMinorUnits ? formatMajor(raw) : raw;
  const field = toCamelCase(column.name);
  const entity = `${toPascalCase(singular(schema.sourceName))}Entity`;

  const layers = [
    {
      name: 'Table',
      key: schema.sourceName,
      representation: `${column.name} ${column.type} = ${raw}`,
    },
    { name: 'Entity (ORM)', key: entity, representation: `${field}: ${raw}` },
    {
      name: 'Business object',
      key: 'domain',
      representation: isMinorUnits
        ? `${stripUnits(column.name)}: Money(${major}, "USD")`
        : `${stripUnits(column.name)}: ${major}`,
    },
    {
      name: 'DTO',
      key: 'API',
      representation: isMinorUnits
        ? `"${stripUnits(column.name)}": { "amount": "${major}", "currency": "USD" }`
        : `"${stripUnits(column.name)}": "${major}"`,
    },
    {
      name: 'View',
      key: 'UI',
      representation: isMinorUnits ? `"$${major}"` : `"${major}"`,
    },
    { name: 'User', key: 'sees', representation: isMinorUnits ? `$${major}` : major },
  ];

  const transforms = [
    {
      description: `The ORM maps ${column.name} to ${field} (${column.type} → ${jsType(column.type)}). The name still says ${unitWord(column.name)}.`,
      bug: null,
    },
    isMinorUnits
      ? {
          description: `${unitWord(column.name)} become a currency amount: divide by 100 and attach a currency.`,
          bug: `The classic off-by-100. Do the division here or forget to, and every total is wrong by two orders of magnitude while still looking entirely plausible. This is the exact thing your dictionary entry for ${column.name} prevents.`,
        }
      : {
          description: 'Wrapped in a domain type with its own validation.',
          bug: 'A value that was merely a string in the database gains rules here — and rows that predate the rules still violate them.',
        },
    {
      description: 'Serialised for the API.',
      bug: isMinorUnits
        ? 'Never serialise money as a float — 89.00 is not exactly representable, and the error compounds on the way back.'
        : 'Nulls become absent keys. A consumer that cannot tell "absent" from "null" will guess, and guess wrong.',
    },
    {
      description: 'Formatted for the viewer.',
      bug: isMinorUnits
        ? 'A hard-coded "$" is correct until the first user outside the United States.'
        : 'Formatting in the view means the same value renders differently in an export.',
    },
    { description: 'Rendered.', bug: null },
  ];

  const aliasNote =
    definition !== undefined && definition.aliases.length > 0
      ? `Your dictionary says ${column.name} is also called ${definition.aliases.join(', ')}, so a question using those words reaches the right column.`
      : `Define ${column.name} in the Dictionary and questions that use everyday words will reach it.`;

  return {
    label: column.name,
    grounding: 'your data',
    layers,
    transforms,
    lanes: [
      {
        name: 'NL → SQL',
        note: `${aliasNote}${isMinorUnits ? ` The unit — ${unitWord(column.name)} — is what turns "what were my totals" into SUM(${column.name})/100 rather than a number a hundred times too large.` : ''}`,
      },
      {
        name: 'Semantic',
        note:
          column.type.toUpperCase().startsWith('VARCHAR')
            ? `${column.name} is text, so it can be embedded and searched by meaning — that is the other lane.`
            : `${column.name} is a number, so it never takes the vector lane. Only text is embedded, which is why a sheet of amounts is not a semantic search problem.`,
      },
      {
        name: 'MCP',
        note: `An agent querying ${schema.sourceName} reads through the same guards as this UI — read-only, dataset-scoped — and every request leaves a trace.`,
      },
    ],
  };
}

/**
 * Pick the most instructive column available.
 *
 * Minor-unit money first, because it carries the canonical bug. Then any measure, then
 * anything at all — a lifecycle grounded in a boring column still names the user's own
 * table, which is most of the value.
 */
function chooseColumn(
  schemas: readonly SourceSchema[],
): { schema: SourceSchema; column: SourceSchema['columns'][number] } | null {
  for (const schema of schemas) {
    const money = schema.columns.find((c) => /_(cents|cent|pence|minor)$/i.test(c.name));
    if (money !== undefined) return { schema, column: money };
  }

  for (const schema of schemas) {
    const numeric = schema.columns.find((c) => /INT|DECIMAL|DOUBLE|FLOAT|NUMERIC/i.test(c.type));
    if (numeric !== undefined) return { schema, column: numeric };
  }

  for (const schema of schemas) {
    const any = schema.columns[0];
    if (any !== undefined) return { schema, column: any };
  }

  return null;
}

function formatMajor(raw: string): string {
  const n = Number(raw);
  return Number.isFinite(n) ? (n / 100).toFixed(2) : raw;
}

function stripUnits(name: string): string {
  return toCamelCase(name.replace(/_(cents|cent|pence|minor)$/i, ''));
}

function unitWord(name: string): string {
  const match = /_(cents|cent|pence|minor)$/i.exec(name);
  return match?.[1]?.toLowerCase() ?? 'the stored units';
}

function toCamelCase(name: string): string {
  const [first, ...rest] = name.toLowerCase().split('_');
  return (first ?? name) + rest.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

function toPascalCase(name: string): string {
  return name
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

function singular(name: string): string {
  return name.endsWith('s') ? name.slice(0, -1) : name;
}

function jsType(duckdbType: string): string {
  const upper = duckdbType.toUpperCase();
  if (upper.includes('INT')) return 'Int';
  if (upper.includes('DOUBLE') || upper.includes('DECIMAL') || upper.includes('FLOAT')) return 'Number';
  if (upper.includes('BOOL')) return 'Boolean';
  if (upper.includes('TIMESTAMP') || upper.includes('DATE')) return 'Date';
  return 'String';
}
