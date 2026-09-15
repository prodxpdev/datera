import type { Engine } from '../engine/engine.js';
import { quoteIdent } from '../engine/sql.js';

/**
 * A caveat about an inferred type.
 *
 * `ambiguous` — the column widened to VARCHAR because *some* values fit a narrower type
 * and some do not. This is the interesting case: it usually means dirty data (a stray
 * "N/A", a thousands separator, a footer row) and it is the thing a user most needs told,
 * because silently treating the column as text is how a revenue total comes out wrong.
 *
 * `narrowable` — every value fits a narrower type, but the column is still VARCHAR
 * (common with quoted CSV columns). Informational, not a problem.
 */
export type InferenceVerdict = 'ambiguous' | 'narrowable';

export interface InferenceNote {
  readonly verdict: InferenceVerdict;
  /** The narrower type the values point at — e.g. 'BIGINT'. */
  readonly candidateType: string;
  readonly sampledRows: number;
  readonly nonNullSampled: number;
  readonly matching: number;
  /** A sentence a user can act on. */
  readonly evidence: string;
  /** Up to a few values that did not fit — the actual offenders. */
  readonly counterExamples: readonly string[];
}

/** Narrower types tried in order; the first that explains the data wins. */
const CANDIDATE_TYPES = ['BIGINT', 'DOUBLE', 'BOOLEAN', 'DATE', 'TIMESTAMP'] as const;

/** Fraction of non-null values that must fit before we call a mismatch "ambiguous". */
const AMBIGUITY_FLOOR = 0.5;
const MAX_COUNTER_EXAMPLES = 3;

/**
 * Decide whether a VARCHAR column is really something narrower, and say so with evidence.
 *
 * Only VARCHAR columns are analysed: any other type means DuckDB already committed to a
 * narrow type and there is nothing ambiguous to report. Computed in code from actual
 * values, never guessed by a model (invariant §1.5).
 */
export async function analyseColumn(
  engine: Engine,
  target: string,
  columnName: string,
  columnType: string,
  sampleRows: number,
): Promise<InferenceNote | null> {
  if (columnType.toUpperCase() !== 'VARCHAR') return null;

  const col = quoteIdent(columnName);
  const sample = `(SELECT ${col} AS v FROM ${target} WHERE ${col} IS NOT NULL LIMIT ${sampleRows})`;

  const totals = await engine.executeInternal(`SELECT count(*) FROM ${sample}`);
  const nonNullSampled = Number(totals.rows[0]?.[0] ?? 0);
  if (nonNullSampled === 0) return null;

  for (const candidate of CANDIDATE_TYPES) {
    const result = await engine.executeInternal(
      `SELECT count(TRY_CAST(v AS ${candidate})) FROM ${sample}`,
    );
    const matching = Number(result.rows[0]?.[0] ?? 0);
    if (matching === 0) continue;

    const ratio = matching / nonNullSampled;

    if (ratio === 1) {
      return {
        verdict: 'narrowable',
        candidateType: candidate,
        sampledRows: sampleRows,
        nonNullSampled,
        matching,
        evidence: `All ${nonNullSampled} sampled values parse as ${candidate}, but the column was read as VARCHAR.`,
        counterExamples: [],
      };
    }

    if (ratio >= AMBIGUITY_FLOOR) {
      const counterExamples = await findCounterExamples(engine, sample, candidate);
      return {
        verdict: 'ambiguous',
        candidateType: candidate,
        sampledRows: sampleRows,
        nonNullSampled,
        matching,
        evidence:
          `${matching} of ${nonNullSampled} sampled values parse as ${candidate}; ` +
          `${nonNullSampled - matching} do not. The column was widened to VARCHAR rather than ` +
          `dropping those values — check them before treating this column as a number.`,
        counterExamples,
      };
    }
  }

  return null;
}

async function findCounterExamples(
  engine: Engine,
  sample: string,
  candidate: string,
): Promise<readonly string[]> {
  const result = await engine.executeInternal(
    `SELECT DISTINCT v FROM ${sample} WHERE TRY_CAST(v AS ${candidate}) IS NULL LIMIT ${MAX_COUNTER_EXAMPLES}`,
  );
  return result.rows.map((row) => String(row[0]));
}
