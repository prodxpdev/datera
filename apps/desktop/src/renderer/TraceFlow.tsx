import { useCallback, useEffect, useRef, useState } from 'react';
import type { StageKind } from '@datera/core';

/**
 * A request as a journey: agent → transport → Datera → model → engine → data → back.
 *
 * The information was already all there — every stage, with its duration — rendered as a
 * flat list of cards. What that lost was the *shape*: which hop the time actually went
 * to, where the request crossed a boundary, and that it comes back. A list answers "what
 * happened"; this answers "where did it go, and what did it cost", which is the question
 * someone opens a trace with.
 *
 * Bars are proportional to real durations rather than a fixed scale, because the honest
 * story of almost every request is that one hop dominates — usually the model — and a
 * chart that flattened that would be a prettier lie.
 */
export interface FlowStage {
  readonly kind: string;
  readonly label: string;
  readonly durationMs: number;
  readonly detail?: string | undefined;
  readonly modelName?: string | undefined;
  readonly sql?: string | undefined;
}

/**
 * Which part of the stack a hop belongs to.
 *
 * Three groups, because they are three different kinds of cost: time on a network, time
 * in a model, and time in Datera itself. Colouring by exact stage would be decoration;
 * this distinction is the one that changes what you would do about a slow request.
 */
function layerOf(kind: string): 'caller' | 'datera' | 'model' | 'engine' {
  // The hops before Datera, present only on a served request.
  if (kind === 'agent' || kind === 'transport') return 'caller';
  if (kind === 'model' || kind === 'embed') return 'model';
  if (kind === 'execute' || kind === 'retrieve') return 'engine';
  return 'datera';
}

const WHERE: Partial<Record<StageKind | string, string>> = {
  agent: 'outside Datera',
  transport: 'on the way in',
  parse: 'in Datera',
  route: 'in Datera',
  schema: 'in Datera',
  model: 'at the model',
  embed: 'at the embedder',
  sql: 'in Datera',
  guard: 'in Datera',
  execute: 'in DuckDB',
  retrieve: 'in DuckDB',
};

/** How long each hop lingers when stepping through. The prototype's pace, kept. */
const STEP_MS = 230;

export function TraceFlow({
  stages,
  totalMs,
}: {
  readonly stages: readonly FlowStage[];
  readonly totalMs: number;
}): JSX.Element {
  // Against the slowest hop, not the total: the total includes time between stages, and
  // scaling to it makes every bar look short enough to be unremarkable.
  const slowest = Math.max(1, ...stages.map((s) => s.durationMs));

  /**
   * How many hops are shown.
   *
   * The trace arrives complete, which is the right default — you opened it to read it,
   * not to wait for it. Stepping through is opt-in, and it is what made the prototype's
   * version legible to someone who does not already know the pipeline: you watch the
   * request travel instead of decoding a finished diagram.
   */
  const [revealed, setRevealed] = useState(stages.length);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A different trace in the same drawer must not inherit the previous one's progress.
  useEffect(() => {
    setRevealed(stages.length);
  }, [stages]);

  const stop = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  // Unmounting mid-step must not leave a timer setting state on a gone component.
  useEffect(() => stop, [stop]);

  const replay = useCallback(() => {
    stop();

    // Someone who has asked not to be shown motion gets the trace, not a refusal to
    // animate dressed up as a feature.
    const reduced =
      typeof globalThis.matchMedia === 'function' &&
      globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setRevealed(stages.length);
      return;
    }

    setRevealed(1);
    const step = (n: number): void => {
      if (n > stages.length) return;
      timer.current = setTimeout(() => {
        setRevealed(n);
        step(n + 1);
      }, STEP_MS);
    };
    step(2);
  }, [stages.length, stop]);

  return (
    <div className="traceflow" data-traceflow data-revealed={revealed}>
      <div className="tfhead">
        <span className="tft">{Math.round(totalMs)}ms end to end</span>
        <span className="tfs">{stages.length} hops</span>
        <button className="linkbtn" data-trace-replay onClick={replay}>
          ▶ Trace a request
        </button>
      </div>

      {stages.slice(0, revealed).map((stage, i) => {
        const layer = layerOf(stage.kind);
        const share = stage.durationMs / slowest;

        return (
          <div className={`tfhop ${layer}`} key={`${stage.kind}-${i}`} data-hop={stage.kind}>
            <div className="tfrail">
              <span className="tfdot" />
              {i < stages.length - 1 && <span className="tfline" />}
            </div>

            <div className="tfbody">
              <div className="tfrow">
                <span className="tfname">{stage.label}</span>
                <span className="tfkind">{stage.kind}</span>
                <span className="tfwhere">{WHERE[stage.kind] ?? ''}</span>
                <span className="tfms">{Math.round(stage.durationMs)}ms</span>
              </div>

              <div className="tfbar">
                <span style={{ width: `${Math.max(share * 100, 1.5)}%` }} />
              </div>

              {stage.modelName !== undefined && <div className="tfmodel">{stage.modelName}</div>}
              {stage.detail !== undefined && stage.kind !== 'schema' && (
                <div className="tfdetail">{stage.detail}</div>
              )}
              {stage.sql !== undefined && <pre className="sqlblock">{stage.sql}</pre>}
            </div>
          </div>
        );
      })}

      {/* The journey returns. Saying so is most of what makes this a flow rather than a
          list, and it is where the row count belongs. Held back while stepping through:
          announcing the arrival before the request has got there is the one thing that
          would make the step-through lie. */}
      {revealed >= stages.length && (
      <div className="tfhop back">
        <div className="tfrail"><span className="tfdot" /></div>
        <div className="tfbody">
          <div className="tfrow"><span className="tfname">Back to you</span></div>
        </div>
      </div>
      )}
    </div>
  );
}
