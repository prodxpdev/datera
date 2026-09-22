import type { Engine } from '../engine/engine.js';
import { qualified, quoteIdent } from '../engine/sql.js';
import type { SourceSchema } from '../schema/introspect.js';
import type { AuthoredRelationship } from './authoring.js';

/**
 * Propose foreign-key-like links between sources in a dataset (spec §3).
 *
 * Measured, not guessed (§1.5). A candidate pair has to share a name and a compatible
 * type *and* actually overlap in values — because matching on names alone proposes
 * `orders.id → customers.id`, which is confidently wrong and exactly the kind of join
 * that produces plausible nonsense.
 *
 * Every proposal carries the evidence in the form a person can check: how many values on
 * one side were found on the other. §1.3 means the user ratifies this, and ratifying
 * something you cannot evaluate is just clicking OK.
 */

export interface RelationshipProposal extends Omit<AuthoredRelationship, 'id' | 'createdAt'> {
  /** Fraction of non-null left-hand values found on the right. 1 means total containment. */
  readonly matchRatio: number;
  /** A sentence a person can check: "same name and type · 2 of 3 values match". */
  readonly evidence: string;
}

/** Below this, an overlap is more likely coincidence than a key. */
const MIN_MATCH_RATIO = 0.5;
/** Values sampled per side. Bounded so detection on large sources stays interactive. */
const SAMPLE = 20_000;

export async function detectRelationships(
  engine: Engine,
  schemaName: string,
  datasetId: string,
  schemas: readonly SourceSchema[],
): Promise<readonly RelationshipProposal[]> {
  const proposals: RelationshipProposal[] = [];

  for (const left of schemas) {
    for (const right of schemas) {
      if (left.sourceName === right.sourceName) continue;

      for (const leftColumn of left.columns) {
        const rightColumn = right.columns.find(
          (c) => c.name.toLowerCase() === leftColumn.name.toLowerCase(),
        );
        if (rightColumn === undefined) continue;
        if (!compatible(leftColumn.type, rightColumn.type)) continue;

        // A key column is identifier-shaped. Matching on a shared `name` or `status`
        // column would propose links between things that merely share vocabulary.
        if (!looksLikeKey(leftColumn.name)) continue;

        const ratio = await overlap(
          engine,
          qualified(schemaName, left.sourceName),
          leftColumn.name,
          qualified(schemaName, right.sourceName),
          rightColumn.name,
        );

        if (ratio === null || ratio < MIN_MATCH_RATIO) continue;

        proposals.push({
          datasetId,
          fromTable: left.sourceName,
          fromColumn: leftColumn.name,
          toTable: right.sourceName,
          toColumn: rightColumn.name,
          state: 'suggested',
          matchRatio: ratio,
          evidence:
            `Same name and compatible type (${leftColumn.type}). ` +
            `${Math.round(ratio * 100)}% of ${left.sourceName}.${leftColumn.name} values ` +
            `exist in ${right.sourceName}.${rightColumn.name}.`,
        });
      }
    }
  }

  return dedupe(proposals);
}

/**
 * Keep the stronger direction of each pair.
 *
 * A → B and B → A are the same relationship seen from two ends; the side whose values are
 * more completely contained in the other is the foreign key, and the other is the target.
 */
function dedupe(proposals: readonly RelationshipProposal[]): readonly RelationshipProposal[] {
  const best = new Map<string, RelationshipProposal>();

  for (const proposal of proposals) {
    const key = [
      `${proposal.fromTable}.${proposal.fromColumn}`,
      `${proposal.toTable}.${proposal.toColumn}`,
    ]
      .sort()
      .join('~');

    const existing = best.get(key);
    if (existing === undefined || proposal.matchRatio > existing.matchRatio) {
      best.set(key, proposal);
    }
  }

  return [...best.values()].sort((a, b) => b.matchRatio - a.matchRatio);
}

const KEY_HINTS = ['_id', 'id', '_key', '_code', '_no', '_number', 'uuid'] as const;

function looksLikeKey(name: string): boolean {
  const lower = name.toLowerCase();
  return KEY_HINTS.some((hint) => lower === hint || lower.endsWith(hint));
}

function compatible(a: string, b: string): boolean {
  const norm = (t: string): string => {
    const upper = t.toUpperCase();
    if (upper.includes('INT')) return 'INT';
    if (upper === 'UUID' || upper === 'VARCHAR') return 'TEXT';
    return upper;
  };
  // UUID and VARCHAR are treated alike: exported keys routinely lose their type.
  return norm(a) === norm(b);
}

/** Fraction of distinct non-null left values that appear on the right. */
async function overlap(
  engine: Engine,
  leftTable: string,
  leftColumn: string,
  rightTable: string,
  rightColumn: string,
): Promise<number | null> {
  const l = quoteIdent(leftColumn);
  const r = quoteIdent(rightColumn);

  try {
    const result = await engine.executeInternal(
      `WITH lhs AS (
         SELECT DISTINCT CAST(${l} AS VARCHAR) AS v FROM ${leftTable} WHERE ${l} IS NOT NULL LIMIT ${SAMPLE}
       ), rhs AS (
         SELECT DISTINCT CAST(${r} AS VARCHAR) AS v FROM ${rightTable} WHERE ${r} IS NOT NULL LIMIT ${SAMPLE}
       )
       SELECT count(*) AS total, count(rhs.v) AS matched
       FROM lhs LEFT JOIN rhs ON rhs.v = lhs.v`,
    );

    const row = result.rows[0];
    if (row === undefined) return null;

    const total = Number(row[0]);
    const matched = Number(row[1]);
    return total === 0 ? null : matched / total;
  } catch {
    // An incomparable pair is not an error, just not a relationship.
    return null;
  }
}
