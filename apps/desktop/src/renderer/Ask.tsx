import { useCallback, useState } from 'react';
import type { AskResult, TraceStage } from '@datera/core';
import type { DateraApi } from '../shared/contract.js';

/**
 * The Ask view and the glass box (spec §5, invariant §1.4).
 *
 * The drawer is not a debugging aid bolted onto an answer — it is the thing that makes
 * the answer worth trusting, and the reason Datera is usable as a teaching tool. So the
 * stages are rendered from the trace verbatim, including the exact model payload, rather
 * than being summarised into a reassuring paragraph.
 */
export function Ask({
  api,
  datasetId,
  datasetName,
}: {
  readonly api: DateraApi;
  readonly datasetId: string;
  readonly datasetName: string;
}): JSX.Element {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AskResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const submit = useCallback(async () => {
    if (question.trim().length === 0) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      setAnswer(await api.ask(datasetId, question));
    } catch (e) {
      const err = e as { code?: string; message?: string };
      setError({ code: err.code ?? 'UNKNOWN', message: err.message ?? String(e) });
    } finally {
      setBusy(false);
    }
  }, [api, datasetId, question]);

  return (
    <>
      <div className="qscope">
        Asking <b>{datasetName}</b>. Datera writes the SQL, shows it before it runs, and runs it
        read-only on this machine.
      </div>

      <div className="askbar">
        <input
          placeholder="Ask about your data…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
        <button className="btn p" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Asking…' : 'Ask'}
        </button>
      </div>

      {error !== null && (
        <div className="err" role="alert">
          <code>{error.code}</code> — {error.message}
        </div>
      )}

      {answer !== null && !answer.answerable && (
        <div className="flag" role="status">
          <b>Datera did not answer this.</b>
          {answer.flag}
          <button className="drillbtn" data-how="1" onClick={() => setDrawerOpen(true)}>
            ◐ How it was made
          </button>
        </div>
      )}

      {answer !== null && answer.answerable && (
        <div className="card ans">
          <div className="aq">{answer.question}</div>

          {answer.sql !== null && (
            <pre className="ansql">{answer.sql}</pre>
          )}

          {answer.flag !== null && <div className="softflag">{answer.flag}</div>}

          {answer.rows.length > 0 && (
            <div className="ansrows">
              <table>
                <thead>
                  <tr>{answer.columns.map((c) => <th key={c.name}>{c.name}</th>)}</tr>
                </thead>
                <tbody>
                  {answer.rows.slice(0, 50).map((row, i) => (
                    <tr key={i}>
                      {row.map((v, j) => (
                        <td key={j} className={v === null ? 'null' : undefined}>
                          {v === null ? 'NULL' : String(v)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="cites">
            {answer.citations.sources.map((s) => (
              <span className="cite" key={`s-${s}`}>✓ {s}</span>
            ))}
            <span className="cite">✓ {answer.citations.rowCount} rows</span>
            {answer.citations.columns.slice(0, 6).map((c) => (
              <span className="cite" key={`c-${c}`}>✓ {c}</span>
            ))}
          </div>

          <div className="af">
            <button className="drillbtn" data-how="1" onClick={() => setDrawerOpen(true)}>
              ◐ How it was made
            </button>
            <span className="pathmini structured">{answer.trace.route}</span>
            <span className="tmini">
              {answer.trace.totalMs.toFixed(0)}ms ·{' '}
              {answer.trace.costUsd === 0 ? '$0' : `$${answer.trace.costUsd.toFixed(4)}`}
            </span>
          </div>
        </div>
      )}

      {answer !== null && drawerOpen && (
        <>
          <div className="scrim show" onClick={() => setDrawerOpen(false)} />
          <TraceDrawer answer={answer} onClose={() => setDrawerOpen(false)} />
        </>
      )}
    </>
  );
}

function TraceDrawer({ answer, onClose }: { readonly answer: AskResult; readonly onClose: () => void }): JSX.Element {
  return (
    <div className="drawer show">
      <div className="dh">
        <div className="t">{answer.question}</div>
        <button className="x" data-close onClick={onClose}>×</button>
      </div>

      <div className="db">
        <div className="tracetop">
          <span className={`pbadge ${answer.trace.route}`}>{answer.trace.route}</span>
          <span>{answer.trace.totalMs.toFixed(0)}ms total</span>
          <span>
            {answer.trace.inputTokens} in / {answer.trace.outputTokens} out
          </span>
          <span>
            {answer.trace.costUsd === 0
              ? '$0 — runs on this machine'
              : `$${answer.trace.costUsd.toFixed(4)}`}
          </span>
        </div>

        {answer.trace.stages.map((stage, i) => (
          <Stage key={`${stage.kind}-${i}`} index={i + 1} stage={stage} />
        ))}
      </div>
    </div>
  );
}

function Stage({ index, stage }: { readonly index: number; readonly stage: TraceStage }): JSX.Element {
  return (
    <div className={`stage stage-${stage.kind}`}>
      <div className="sl">
        {index}. {stage.label}
        <span className="k">{stage.kind}</span>
        <span className="ms">{stage.durationMs.toFixed(0)}ms</span>
      </div>

      {stage.modelName !== undefined && <div className="modelname">{stage.modelName}</div>}
      {stage.schemaSummary !== undefined && <div className="ss">{stage.schemaSummary}</div>}

      {stage.sql !== undefined && <pre className="sqlblock">{stage.sql}</pre>}

      {/* The exact bytes that went to the model. Shown in full, because "trust me, it was
          only the schema" is precisely the claim the drawer exists to let you check. */}
      {stage.modelPayload !== undefined && (
        <>
          <div className="payloadlabel">Exactly what was sent:</div>
          <pre className="payload">{stage.modelPayload}</pre>
        </>
      )}

      {stage.detail !== undefined && stage.kind !== 'schema' && <div className="ss">{stage.detail}</div>}
    </div>
  );
}
