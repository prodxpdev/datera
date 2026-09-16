import type { Engine } from '../engine/engine.js';
import { redactSecrets } from '../models/redact.js';
import type { Trace } from '../query/trace.js';
import { CATALOG_SCHEMA } from '../workspace/catalog.js';

/**
 * The persisted, searchable trace log (spec §8a).
 *
 * The governing design rule: **logs are a dataset, queried by Datera's own engine.** These
 * records land in a DuckDB table and are searched with the same engine as everything else.
 * No Elasticsearch, no Loki — adding a search stack here would mean building a second,
 * worse query engine next to the good one.
 *
 * The record content is split deliberately. Shape and metadata are always stored, because
 * that is what makes the history searchable and auditable. **Payloads are opt-in and off
 * by default**, because a log that keeps every row and every retrieved chunk is a second
 * copy of the user's data, quietly undoing the minimum-exposure posture the rest of the
 * product maintains.
 */

export type TraceOrigin = 'ask' | 'tool' | 'sql';

/** One step of a recorded request, as it happened. */
export interface TraceStageRecord {
  readonly kind: string;
  readonly label: string;
  readonly durationMs: number;
  readonly detail?: string | undefined;
  readonly modelName?: string | undefined;
  readonly schemaSummary?: string | undefined;
  readonly sql?: string | undefined;
}

export interface TraceRecord {
  readonly id: string;
  readonly at: string;
  readonly origin: TraceOrigin;
  readonly datasetId: string;
  readonly question: string;
  readonly route: string;
  readonly modelName: string | null;
  readonly sql: string | null;
  readonly totalMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly rowsReturned: number;
  readonly ok: boolean;
  readonly error: string | null;
  /** Null unless payload capture is explicitly on. */
  readonly payload: string | null;
  /** Every hop, in order. Empty for records written before this was kept. */
  readonly stages: readonly TraceStageRecord[];
}

export interface RetentionPolicy {
  readonly maxRecords: number;
  readonly maxAgeDays: number;
}

/**
 * Defaults, so the log is bounded from the first request.
 *
 * §8a: "never unbounded". An audit log that grows forever becomes both a disk problem and
 * a liability, and the moment to decide that is before anyone has a large one.
 */
export const DEFAULT_RETENTION: RetentionPolicy = { maxRecords: 5_000, maxAgeDays: 30 };

export interface TraceQuery {
  readonly datasetId?: string | undefined;
  readonly route?: string | undefined;
  readonly origin?: TraceOrigin | undefined;
  readonly minTotalMs?: number | undefined;
  readonly onlyErrors?: boolean | undefined;
  readonly limit?: number | undefined;
}

export async function migrateTraceLog(engine: Engine): Promise<void> {
  await engine.executeInternal(`
    CREATE TABLE IF NOT EXISTS ${CATALOG_SCHEMA}.trace_log (
      id VARCHAR PRIMARY KEY,
      -- Named occurred_at rather than at: AT is reserved in DuckDB (time travel).
      occurred_at VARCHAR NOT NULL,
      origin VARCHAR NOT NULL,
      dataset_id VARCHAR NOT NULL,
      question VARCHAR NOT NULL,
      route VARCHAR NOT NULL,
      model_name VARCHAR,
      sql VARCHAR,
      total_ms DOUBLE NOT NULL,
      input_tokens BIGINT NOT NULL,
      output_tokens BIGINT NOT NULL,
      cost_usd DOUBLE NOT NULL,
      rows_returned BIGINT NOT NULL,
      ok BOOLEAN NOT NULL,
      error VARCHAR,
      payload VARCHAR,
      -- The stage-by-stage sequence, as JSON.
      --
      -- Stages were read for the model name and the SQL and then discarded, so the
      -- execution sequence existed only in the live answer drawer: the moment you looked
      -- at a past request, the thing the product is built to show you was gone. §12.9
      -- asks for "a complete trace covering every hop", which a summary row is not.
      --
      -- Model payloads are NOT in here: they stay behind the capture flag in the payload
      -- column, because those carry prompt text and this column does not.
      stages VARCHAR
    )`);

  // An existing workspace has the table without the column. Asked for rather than
  // guessed, and failing loudly if it cannot be added — a half-migrated catalog that
  // still opens is how a user ends up unable to use their workspace at all.
  const columns = await engine.executeInternal(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'trace_log'`,
    [CATALOG_SCHEMA],
  );
  const present = new Set(columns.rows.map((row) => String(row[0]).toLowerCase()));
  if (present.size > 0 && !present.has('stages')) {
    await engine.executeInternal(`ALTER TABLE ${CATALOG_SCHEMA}.trace_log ADD COLUMN stages VARCHAR`);
  }
}

export interface RecordOptions {
  readonly origin: TraceOrigin;
  readonly rowsReturned: number;
  readonly ok: boolean;
  readonly error?: string | null;
  /** When false, the payload column stays null however verbose the trace was. */
  readonly capturePayloads: boolean;
  /** Known secrets to scrub, belt-and-braces alongside the generic patterns. */
  readonly secrets?: readonly (string | null)[];
}

export async function recordTrace(
  engine: Engine,
  trace: Trace,
  options: RecordOptions,
): Promise<void> {
  const modelStage = trace.stages.find((s) => s.kind === 'model');
  const sqlStage = trace.stages.find((s) => s.kind === 'sql');

  // Payloads carry the prompt, which for the semantic path contains real text from the
  // user's data. Captured only when asked for, and scrubbed of credentials either way —
  // the log is persisted and later searchable, so a leak here is a durable one.
  const payload = options.capturePayloads
    ? redactSecrets(
        trace.stages
          .filter((s) => s.modelPayload !== undefined)
          .map((s) => s.modelPayload ?? '')
          .join('\n\n---\n\n'),
        ...(options.secrets ?? []),
      )
    : null;

  // Everything except the model payload, which is governed by the capture flag above.
  // Detail and schema summaries are schema, not rows — the same material §1.4 already
  // permits a model to see.
  const stages = redactSecrets(
    JSON.stringify(
      trace.stages.map((stage) => ({
        kind: stage.kind,
        label: stage.label,
        durationMs: stage.durationMs,
        ...(stage.detail === undefined ? {} : { detail: stage.detail }),
        ...(stage.modelName === undefined ? {} : { modelName: stage.modelName }),
        ...(stage.schemaSummary === undefined ? {} : { schemaSummary: stage.schemaSummary }),
        ...(stage.sql === undefined ? {} : { sql: stage.sql }),
      })),
    ),
    ...(options.secrets ?? []),
  );

  await engine.executeInternal(
    `INSERT INTO ${CATALOG_SCHEMA}.trace_log
      (id, occurred_at, origin, dataset_id, question, route, model_name, sql, total_ms,
       input_tokens, output_tokens, cost_usd, rows_returned, ok, error, payload, stages)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      trace.id,
      trace.startedAt,
      options.origin,
      trace.datasetId,
      redactSecrets(trace.question, ...(options.secrets ?? [])),
      trace.route,
      modelStage?.modelName ?? null,
      sqlStage?.sql ?? null,
      trace.totalMs,
      trace.inputTokens,
      trace.outputTokens,
      trace.costUsd,
      options.rowsReturned,
      options.ok,
      options.error === undefined || options.error === null
        ? null
        : redactSecrets(options.error, ...(options.secrets ?? [])),
      payload,
      stages,
    ],
  );
}

export async function queryTraceLog(
  engine: Engine,
  query: TraceQuery,
): Promise<readonly TraceRecord[]> {
  const clauses: string[] = [];
  const params: (string | number | boolean)[] = [];

  if (query.datasetId !== undefined) {
    clauses.push('dataset_id = ?');
    params.push(query.datasetId);
  }
  if (query.route !== undefined) {
    clauses.push('route = ?');
    params.push(query.route);
  }
  if (query.origin !== undefined) {
    clauses.push('origin = ?');
    params.push(query.origin);
  }
  if (query.minTotalMs !== undefined) {
    clauses.push('total_ms >= ?');
    params.push(query.minTotalMs);
  }
  if (query.onlyErrors === true) clauses.push('ok = false');

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(10_000, Math.trunc(query.limit ?? 200)));

  const result = await engine.executeInternal(
    `SELECT id, occurred_at, origin, dataset_id, question, route, model_name, sql, total_ms,
            input_tokens, output_tokens, cost_usd, rows_returned, ok, error, payload, stages
     FROM ${CATALOG_SCHEMA}.trace_log ${where} ORDER BY occurred_at DESC LIMIT ${limit}`,
    params,
  );

  return result.rows.map((row) => ({
    id: String(row[0]),
    at: String(row[1]),
    origin: String(row[2]) as TraceOrigin,
    datasetId: String(row[3]),
    question: String(row[4]),
    route: String(row[5]),
    modelName: row[6] === null ? null : String(row[6]),
    sql: row[7] === null ? null : String(row[7]),
    totalMs: Number(row[8]),
    inputTokens: Number(row[9]),
    outputTokens: Number(row[10]),
    costUsd: Number(row[11]),
    rowsReturned: Number(row[12]),
    ok: row[13] === true,
    error: row[14] === null ? null : String(row[14]),
    payload: row[15] === null ? null : String(row[15]),
    // Records written before stages were kept simply have none. An empty sequence is the
    // honest representation of "we did not save this", and the viewer says so.
    stages: parseStages(row[16]),
  }));
}

function parseStages(value: unknown): readonly TraceStageRecord[] {
  if (value === null || value === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(String(value));
    return Array.isArray(parsed) ? (parsed as TraceStageRecord[]) : [];
  } catch {
    return [];
  }
}

/**
 * Drop records past the window. Both limbs, because either alone can be the binding one.
 *
 * `now` comes from the caller's ClockPort rather than DuckDB's `now()`. They are not the
 * same clock: records are stamped with the port's time, so pruning against the database's
 * wall clock compares two different notions of "now" — which quietly deleted everything
 * the first time a test ran with an injected clock.
 */
export async function pruneTraceLog(
  engine: Engine,
  policy: RetentionPolicy,
  now: Date,
): Promise<number> {
  const before = await countTraces(engine);

  const cutoff = new Date(now.getTime() - Math.max(1, policy.maxAgeDays) * 86_400_000).toISOString();
  await engine.executeInternal(
    `DELETE FROM ${CATALOG_SCHEMA}.trace_log WHERE occurred_at < ?`,
    [cutoff],
  );

  await engine.executeInternal(
    `DELETE FROM ${CATALOG_SCHEMA}.trace_log WHERE id IN (
       SELECT id FROM ${CATALOG_SCHEMA}.trace_log
       ORDER BY occurred_at DESC OFFSET ${Math.max(0, Math.trunc(policy.maxRecords))}
     )`,
  );

  return before - (await countTraces(engine));
}

async function countTraces(engine: Engine): Promise<number> {
  const result = await engine.executeInternal(`SELECT count(*) FROM ${CATALOG_SCHEMA}.trace_log`);
  return Number(result.rows[0]?.[0] ?? 0);
}
