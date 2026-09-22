import type { Engine } from '../engine/engine.js';
import { qualified, quoteIdent } from '../engine/sql.js';
import type { SourceSchema } from '../schema/introspect.js';

/**
 * Normalize — flat sheet to relational (spec §7).
 *
 * "Loading a sheet as a table is trivial. The valuable feature is normalization": spotting
 * that one flat sheet is really several entities, showing the repetition that proves it,
 * and proposing the split.
 *
 * Everything here is measured. A group of columns is a candidate entity when its values
 * *actually repeat together* across rows — not because the column names look related. The
 * repetition count and the candidate key are reported so a human can evaluate the proposal
 * rather than take it on faith (§1.3).
 *
 * v1 is single-sheet, as §7 scopes it.
 */

export interface EntityProposal {
  /** Suggested table name, derived from the key column. */
  readonly name: string;
  /** The column that identifies the entity — repeats across rows. */
  readonly keyColumn: string;
  /** Columns that travel with the key, always taking the same value for a given key. */
  readonly attributeColumns: readonly string[];
  /** Distinct values of the key. */
  readonly distinctValues: number;
  /** Rows in the sheet. */
  readonly totalRows: number;
  /** Evidence a person can check. */
  readonly evidence: string;
}

export interface NormalizationProposal {
  readonly sourceName: string;
  readonly entities: readonly EntityProposal[];
  /** Columns that stay on the fact table. */
  readonly factColumns: readonly string[];
  readonly factName: string;
}

/** A column repeating fewer times than this is probably already a key, not an entity. */
const MIN_REPETITION = 2;
/** Above this ratio of distinct values to rows, there is no meaningful repetition. */
const MAX_DISTINCT_RATIO = 0.6;

export async function proposeNormalization(
  engine: Engine,
  schemaName: string,
  schema: SourceSchema,
): Promise<NormalizationProposal> {
  const target = qualified(schemaName, schema.sourceName);
  const totalRows = schema.rowCount;

  const entities: EntityProposal[] = [];
  const claimed = new Set<string>();

  for (const candidate of schema.columns) {
    if (claimed.has(candidate.name)) continue;

    const distinct = await countDistinct(engine, target, candidate.name);
    if (distinct === 0 || distinct === totalRows) continue;
    if (totalRows / distinct < MIN_REPETITION) continue;
    if (distinct / totalRows > MAX_DISTINCT_RATIO) continue;

    // A column is an attribute of this candidate when, for every value of the candidate,
    // it takes exactly one value. That is functional dependency, measured directly — and
    // it is the thing that actually justifies pulling the pair into their own table.
    const attributes: string[] = [];
    for (const other of schema.columns) {
      if (other.name === candidate.name || claimed.has(other.name)) continue;
      if (await isFunctionallyDependent(engine, target, candidate.name, other.name)) {
        attributes.push(other.name);
      }
    }

    if (attributes.length === 0) continue;

    claimed.add(candidate.name);
    for (const attribute of attributes) claimed.add(attribute);

    entities.push({
      name: entityNameFor(candidate.name, attributes),
      keyColumn: candidate.name,
      attributeColumns: attributes,
      distinctValues: distinct,
      totalRows,
      evidence:
        `${candidate.name} has ${distinct} distinct values across ${totalRows} rows ` +
        `(each repeats about ${(totalRows / distinct).toFixed(1)} times), and ` +
        `${attributes.join(', ')} ${attributes.length === 1 ? 'always takes' : 'always take'} ` +
        `the same value for a given ${candidate.name}.`,
    });
  }

  const factColumns = schema.columns
    .map((c) => c.name)
    .filter((name) => !claimed.has(name) || entities.some((e) => e.keyColumn === name));

  return {
    sourceName: schema.sourceName,
    entities,
    factColumns,
    factName: schema.sourceName,
  };
}

/**
 * Apply a confirmed proposal into a derived dataset.
 *
 * The caller supplies the target schema, which is always a *derived* dataset — §1.2 means
 * the source is never restructured in place, and this function has no way to reach it.
 */
export async function applyNormalization(
  engine: Engine,
  fromSchema: string,
  toSchema: string,
  proposal: NormalizationProposal,
): Promise<readonly string[]> {
  const created: string[] = [];
  const source = qualified(fromSchema, proposal.sourceName);

  for (const entity of proposal.entities) {
    const columns = [entity.keyColumn, ...entity.attributeColumns].map(quoteIdent).join(', ');
    await engine.executeInternal(
      `CREATE OR REPLACE TABLE ${qualified(toSchema, entity.name)} AS
       SELECT DISTINCT ${columns} FROM ${source} WHERE ${quoteIdent(entity.keyColumn)} IS NOT NULL`,
    );
    created.push(entity.name);
  }

  // The fact table keeps its own columns plus the foreign keys, and drops the attributes
  // that now live on the entities — which is what makes this normalization rather than
  // copying.
  const factColumns = proposal.factColumns.map(quoteIdent).join(', ');
  await engine.executeInternal(
    `CREATE OR REPLACE TABLE ${qualified(toSchema, proposal.factName)} AS
     SELECT ${factColumns} FROM ${source}`,
  );
  created.push(proposal.factName);

  return created;
}

/** Enum promotion (§7): the values present, plus room for ones that should exist. */
export interface EnumProposal {
  readonly column: string;
  readonly values: readonly string[];
  readonly distinctValues: number;
  readonly evidence: string;
}

const MAX_ENUM_VALUES = 24;

export async function proposeEnums(
  engine: Engine,
  schemaName: string,
  schema: SourceSchema,
): Promise<readonly EnumProposal[]> {
  const target = qualified(schemaName, schema.sourceName);
  const proposals: EnumProposal[] = [];

  for (const column of schema.columns) {
    const type = column.type.toUpperCase();
    if (!type.startsWith('VARCHAR') && !type.startsWith('BOOLEAN')) continue;

    const distinct = await countDistinct(engine, target, column.name);
    if (distinct === 0 || distinct > MAX_ENUM_VALUES) continue;
    if (distinct === schema.rowCount) continue;

    const result = await engine.executeInternal(
      `SELECT DISTINCT CAST(${quoteIdent(column.name)} AS VARCHAR) AS v FROM ${target}
       WHERE ${quoteIdent(column.name)} IS NOT NULL ORDER BY 1`,
    );

    proposals.push({
      column: column.name,
      values: result.rows.map((row) => String(row[0])),
      distinctValues: distinct,
      evidence:
        `Only ${distinct} distinct value${distinct === 1 ? '' : 's'} across ${schema.rowCount} rows. ` +
        `Add any value that should exist but does not appear in this data — that is the ` +
        `difference between the values you have and the values you allow.`,
    });
  }

  return proposals;
}

async function countDistinct(engine: Engine, target: string, column: string): Promise<number> {
  const result = await engine.executeInternal(
    `SELECT count(DISTINCT ${quoteIdent(column)}) FROM ${target}`,
  );
  return Number(result.rows[0]?.[0] ?? 0);
}

/** True when `dependent` takes exactly one value for every value of `determinant`. */
async function isFunctionallyDependent(
  engine: Engine,
  target: string,
  determinant: string,
  dependent: string,
): Promise<boolean> {
  const result = await engine.executeInternal(
    `SELECT max(n) FROM (
       SELECT count(DISTINCT ${quoteIdent(dependent)}) AS n
       FROM ${target}
       WHERE ${quoteIdent(determinant)} IS NOT NULL
       GROUP BY ${quoteIdent(determinant)}
     )`,
  );
  const worst = Number(result.rows[0]?.[0] ?? 0);
  return worst === 1;
}

/**
 * Name the entity after what its columns are all about.
 *
 * `customer_email` + `customer_name` + `customer_city` share the prefix `customer`, which
 * is a far better name than anything derivable from the key alone — stripping a suffix
 * off `customer_email` yields `customer_emails`, a table of emails, which is wrong about
 * what the table contains.
 */
function entityNameFor(keyColumn: string, attributes: readonly string[]): string {
  const prefix = commonPrefixSegments([keyColumn, ...attributes]);
  const base =
    prefix.length > 0
      ? prefix
      : keyColumn.replace(/_(id|sku|code|key|email|no|number)$/i, '').replace(/^id_/i, '');

  const singular = base.length > 0 ? base : keyColumn;
  return singular.endsWith('s') ? singular : `${singular}s`;
}

/** Longest shared leading run of underscore-separated segments. */
function commonPrefixSegments(names: readonly string[]): string {
  if (names.length < 2) return '';

  const split = names.map((n) => n.toLowerCase().split('_'));
  const first = split[0] ?? [];
  const shared: string[] = [];

  for (let i = 0; i < first.length; i += 1) {
    const segment = first[i];
    if (segment === undefined) break;
    if (!split.every((parts) => parts[i] === segment)) break;
    // The whole name being the prefix would leave nothing to distinguish the entity.
    if (split.some((parts) => parts.length === i + 1)) break;
    shared.push(segment);
  }

  return shared.join('_');
}
