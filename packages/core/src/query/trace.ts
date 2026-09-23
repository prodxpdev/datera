import type { ModelDescriptor } from '../models/types.js';

/**
 * The trace — invariant §1.4, "show the work".
 *
 * This is the product, not instrumentation. For any answer the user must be able to
 * inspect the parse, the routing decision, the schema given to the model, exactly what
 * was sent, the generated SQL, the guard verdict, the rows touched, and the cost.
 *
 * Spec §8a will persist these records and make them searchable; the shape is designed for
 * that now — flat stages with a kind, a duration and typed detail fields — so Phase 7
 * writes rows rather than reworking the model.
 */

export type StageKind =
  /**
   * The two hops that happen before Datera is involved at all — the agent that called,
   * and the transport it arrived over.
   *
   * Present only for served requests. A trace that began inside Datera was accurate and
   * incomplete: for an agent-driven call, the interesting question is often what asked
   * and how it got here, and that was the part nobody could see.
   */
  | 'agent'
  | 'transport'
  | 'parse'
  | 'route'
  | 'schema'
  | 'model'
  | 'sql'
  | 'guard'
  | 'execute'
  | 'embed'
  | 'retrieve';

export type Route = 'structured' | 'semantic';

export interface TraceStage {
  readonly kind: StageKind;
  /** Short human-facing label — "Generated SQL", "Sent to model". */
  readonly label: string;
  readonly durationMs: number;
  /** One or two sentences a person can read. */
  readonly detail?: string | undefined;

  /** kind === 'route' */
  readonly route?: Route | undefined;

  /** kind === 'schema' — what the model was told the data looks like. */
  readonly schemaSummary?: string | undefined;

  /** kind === 'model' */
  readonly model?: ModelDescriptor | undefined;
  /** The exact rendering required by spec §9 — tier, provider, id, locality. */
  readonly modelName?: string | undefined;
  /** Verbatim text sent to the model. Schema and dictionary only — never data rows. */
  readonly modelPayload?: string | undefined;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly costUsd?: number | undefined;

  /** kind === 'sql' — the statement, exactly as shown to the user and executed. */
  readonly sql?: string | undefined;

  /** kind === 'execute' */
  readonly rowCount?: number | undefined;
}

export interface Trace {
  readonly id: string;
  readonly startedAt: string;
  readonly datasetId: string;
  readonly question: string;
  readonly route: Route;
  readonly stages: readonly TraceStage[];
  readonly totalMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  /** False when Datera declined to answer. The trace still records why.  */
  readonly answerable: boolean;
}

/**
 * Accumulates stages while a question is being answered.
 *
 * Timings come from a monotonic clock, never the wall clock: a query that reports -40ms
 * because NTP stepped mid-request would undermine the one thing this is for.
 */
export class TraceBuilder {
  private readonly stages: TraceStage[] = [];
  private readonly startedMs: number;
  private lastMs: number;

  constructor(
    readonly id: string,
    readonly datasetId: string,
    readonly question: string,
    readonly startedAt: string,
    private readonly monotonicMs: () => number,
  ) {
    this.startedMs = monotonicMs();
    this.lastMs = this.startedMs;
  }

  /** Record a stage, timing it from the end of the previous one. */
  add(stage: Omit<TraceStage, 'durationMs'>): void {
    const now = this.monotonicMs();
    this.stages.push({ ...stage, durationMs: Math.max(0, now - this.lastMs) });
    this.lastMs = now;
  }

  build(route: Route, answerable: boolean): Trace {
    const totals = this.stages.reduce(
      (acc, s) => ({
        inputTokens: acc.inputTokens + (s.inputTokens ?? 0),
        outputTokens: acc.outputTokens + (s.outputTokens ?? 0),
        costUsd: acc.costUsd + (s.costUsd ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    );

    return {
      id: this.id,
      startedAt: this.startedAt,
      datasetId: this.datasetId,
      question: this.question,
      route,
      stages: [...this.stages],
      totalMs: Math.max(0, this.monotonicMs() - this.startedMs),
      answerable,
      ...totals,
    };
  }
}
