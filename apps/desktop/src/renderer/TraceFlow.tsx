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
function layerOf(kind: string): 'datera' | 'model' | 'engine' {
  if (kind === 'model' || kind === 'embed') return 'model';
  if (kind === 'execute' || kind === 'retrieve') return 'engine';
  return 'datera';
}

const WHERE: Partial<Record<StageKind | string, string>> = {
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

  return (
    <div className="traceflow" data-traceflow>
      <div className="tfhead">
        <span className="tft">{Math.round(totalMs)}ms end to end</span>
        <span className="tfs">{stages.length} hops</span>
      </div>

      {stages.map((stage, i) => {
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
          list, and it is where the row count belongs. */}
      <div className="tfhop back">
        <div className="tfrail"><span className="tfdot" /></div>
        <div className="tfbody">
          <div className="tfrow"><span className="tfname">Back to you</span></div>
        </div>
      </div>
    </div>
  );
}
