import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  completionsAt, referencedTables, starterSql, suggestQuestions,
  type AskResult, type CompletionResult, type QueryResult, type SchemaGraph,
  type Suggestion, type TraceRecord, type TraceStage,
} from '@datera/core';
import type { DateraApi } from '../shared/contract.js';
import { SchemaMap } from './SchemaMap.js';

/**
 * Query — one surface, two ways in (spec §5, §12.1).
 *
 * Ask and SQL were separate views running the same engine through the same read-only
 * guard onto the same result table. Two nav items described one activity, and the
 * generated SQL — the thing that makes an answer checkable — lived in a drawer you had to
 * open.
 *
 * So the natural-language path now *writes into the editor*. The SQL is the default view
 * of what happened, and the obvious next move (edit it, run it again) is available
 * instead of merely described. That is invariant §1.4 made operational rather than
 * asserted.
 *
 * Completions come from the schema, never a model: completing a column name is a lookup,
 * and on the local tier a model would take forty-five seconds to suggest a word already
 * half-typed. See core/query/schema-graph.ts.
 */
const EMPTY: CompletionResult = { replacing: '', items: [] };

export function Query({
  api,
  datasetId,
  datasetName,
}: {
  readonly api: DateraApi;
  readonly datasetId: string;
  readonly datasetName: string;
}): JSX.Element {
  const [graph, setGraph] = useState<SchemaGraph | null>(null);
  const [sql, setSql] = useState('');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AskResult | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [history, setHistory] = useState<readonly TraceRecord[]>([]);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [busy, setBusy] = useState<'ask' | 'run' | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showMap, setShowMap] = useState(true);
  const [completions, setCompletions] = useState<CompletionResult>(EMPTY);
  const [highlighted, setHighlighted] = useState(0);
  const editor = useRef<HTMLTextAreaElement | null>(null);

  const loadHistory = useCallback(async () => {
    setHistory(await api.queryTraceLog({ datasetId, limit: 25 }));
  }, [api, datasetId]);

  // The schema is re-read per dataset, so switching groups switches everything that
  // depends on it: the starter query, the completions, the map and the suggestions.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await api.schemaGraph(datasetId);
      if (cancelled) return;
      setGraph(next);
      setSql(starterSql(next));
      setAnswer(null);
      setResult(null);
      setError(null);
      await loadHistory();
    })();
    return () => {
      cancelled = true;
    };
  }, [api, datasetId, loadHistory]);

  const suggestions = useMemo(
    () => (graph === null ? [] : suggestQuestions(graph)),
    [graph],
  );

  const active = useMemo(
    () => (graph === null ? [] : referencedTables(sql, graph.tables.map((t) => t.name))),
    [graph, sql],
  );

  const report = (e: unknown): void => {
    const err = e as { code?: string; message?: string };
    setError({ code: err.code ?? 'UNKNOWN', message: err.message ?? String(e) });
  };

  const ask = useCallback(
    async (text: string) => {
      if (text.trim().length === 0) return;
      setBusy('ask');
      setError(null);
      setAnswer(null);
      setResult(null);
      try {
        const next = await api.ask(datasetId, text);
        setAnswer(next);
        // The whole point of the merge: the generated SQL lands in the editor, where it
        // can be read and changed, rather than behind a button.
        if (next.sql !== null) setSql(next.sql);
      } catch (e) {
        report(e);
      } finally {
        setBusy(null);
        await loadHistory();
      }
    },
    [api, datasetId, loadHistory],
  );

  const run = useCallback(async () => {
    setBusy('run');
    setError(null);
    setResult(null);
    setAnswer(null);
    try {
      setResult(await api.query(datasetId, sql));
    } catch (e) {
      report(e);
    } finally {
      setBusy(null);
      await loadHistory();
    }
  }, [api, datasetId, sql, loadHistory]);

  const recompute = useCallback(
    (text: string, cursor: number) => {
      if (graph === null) return;
      setCompletions(completionsAt(graph, text, cursor));
      setHighlighted(0);
    },
    [graph],
  );

  const accept = useCallback(
    (index: number) => {
      const item = completions.items[index];
      const element = editor.current;
      if (item === undefined || element === null) return;

      const cursor = element.selectionStart;
      const start = cursor - completions.replacing.length;
      const next = `${sql.slice(0, start)}${item.insert}${sql.slice(cursor)}`;
      setSql(next);
      setCompletions(EMPTY);

      // Put the caret after what was inserted, so typing continues naturally.
      const at = start + item.insert.length;
      requestAnimationFrame(() => {
        element.focus();
        element.setSelectionRange(at, at);
      });
    },
    [completions, sql],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void run();
      return;
    }
    if (e.key === ' ' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      recompute(sql, e.currentTarget.selectionStart);
      return;
    }
    if (completions.items.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((h) => (h + 1) % completions.items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((h) => (h - 1 + completions.items.length) % completions.items.length);
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      accept(highlighted);
    } else if (e.key === 'Escape') {
      setCompletions(EMPTY);
    }
  };

  return (
    <div className="query">
      <div className="qscope">
        Querying <b>{datasetName}</b>. Ask in words or write SQL — both go through the same engine
        and the same read-only guard, on this machine.
      </div>

      <div className="askbar">
        <input
          placeholder="Ask about your data…"
          value={question}
          data-ask-input
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void ask(question);
          }}
        />
        <button className="btn p" data-ask onClick={() => void ask(question)} disabled={busy !== null}>
          {busy === 'ask' ? 'Asking…' : 'Ask'}
        </button>
      </div>

      {suggestions.length > 0 && answer === null && result === null && (
        <div className="suggestions" data-suggestions>
          <div className="sughead">
            Not sure what to ask? These come from your schema — no model involved, so they can
            only name things that are actually there.
          </div>
          {suggestions.map((s) => (
            <Suggested key={s.question} suggestion={s} onPick={() => { setQuestion(s.question); void ask(s.question); }} />
          ))}
        </div>
      )}

      {history.length > 0 && (
        <details className="history" data-history>
          <summary>Past questions in {datasetName} ({history.length})</summary>
          {history.map((r) => (
            <button
              key={r.id}
              className={`histrow ${r.ok ? '' : 'failed'}`}
              title={r.sql ?? undefined}
              onClick={() => {
                setQuestion(r.question);
                if (r.sql !== null) setSql(r.sql);
              }}
            >
              <span className="hq">{r.question}</span>
              <span className="hm">
                {r.route} · {Math.round(r.totalMs)}ms · {r.rowsReturned} rows
                {r.ok ? '' : ' · failed'}
              </span>
            </button>
          ))}
          <div className="histnote">
            This is the request log, not a separate copy — the same records Activity shows.
          </div>
        </details>
      )}

      <div className="card sqled">
        <div className="sqlhead">
          <span>DuckDB SQL · read-only{answer?.sql !== undefined && answer.sql !== null ? ' · written by the model, yours to edit' : ''}</span>
          <button className="linkbtn" data-toggle-map onClick={() => setShowMap(!showMap)}>
            {showMap ? '− hide schema' : '+ show schema'}
          </button>
          <button className="btn p" data-runsql onClick={() => void run()} disabled={busy !== null}>
            {busy === 'run' ? 'Running…' : '▶ Run'}
          </button>
        </div>

        <div className="sqlwrap">
          <textarea
            ref={editor}
            value={sql}
            spellCheck={false}
            data-sql
            onChange={(e) => {
              setSql(e.target.value);
              recompute(e.target.value, e.target.selectionStart);
            }}
            onKeyDown={onKeyDown}
            onBlur={() => setTimeout(() => setCompletions(EMPTY), 120)}
          />

          {completions.items.length > 0 && (
            <div className="acbox" data-completions>
              {completions.items.slice(0, 10).map((item, i) => (
                <button
                  key={`${item.kind}-${item.label}`}
                  className={`acitem ${i === highlighted ? 'on' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    accept(i);
                  }}
                >
                  <span className={`ack ${item.kind}`}>{item.kind}</span>
                  <span className="acl">{item.label}</span>
                  <span className="acd">{item.detail}</span>
                </button>
              ))}
              <div className="achint">↑↓ to move · Tab to accept · Esc to dismiss · ⌃Space to reopen</div>
            </div>
          )}
        </div>
        <div className="sqlfoot">⌘↵ runs. Completions come from your schema, not a model.</div>
      </div>

      {showMap && graph !== null && (
        <div className="mapbox">
          <div className="maptitle">
            {datasetName} — {graph.tables.length} table(s),{' '}
            {graph.relationships.length} confirmed relationship(s).
            {active.length > 0 && <> Lit: what your query names right now.</>}
          </div>
          <SchemaMap
            graph={graph}
            active={active}
            onPick={(table, column) => {
              const element = editor.current;
              if (element === null) return;
              const at = element.selectionStart;
              const insert = `${table}.${column}`;
              setSql(`${sql.slice(0, at)}${insert}${sql.slice(at)}`);
            }}
          />
        </div>
      )}

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
          {answer.flag !== null && <div className="softflag">{answer.flag}</div>}

          {answer.rows.length > 0 && (
            <ResultTable columns={answer.columns.map((c) => c.name)} rows={answer.rows} />
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
            <span className={`pathmini ${answer.trace.route}`}>{answer.trace.route}</span>
            <span className="tmini">
              {answer.trace.totalMs.toFixed(0)}ms ·{' '}
              {answer.trace.costUsd === 0 ? '$0' : `$${answer.trace.costUsd.toFixed(4)}`}
            </span>
          </div>
        </div>
      )}

      {result !== null && (
        <div className="sqlres">
          <ResultTable columns={result.columns.map((c) => c.name)} rows={result.rows} />
          <div className="readonly">
            ● {result.rows.length} rows · {result.durationMs.toFixed(0)}ms · read-only ·{' '}
            {result.statementKinds.join(', ')}
          </div>
        </div>
      )}

      {answer !== null && drawerOpen && (
        <>
          <div className="scrim show" onClick={() => setDrawerOpen(false)} />
          <TraceDrawer answer={answer} onClose={() => setDrawerOpen(false)} />
        </>
      )}
    </div>
  );
}

function Suggested({
  suggestion, onPick,
}: {
  readonly suggestion: Suggestion;
  readonly onPick: () => void;
}): JSX.Element {
  return (
    <button className="sugg" data-suggestion onClick={onPick}>
      <span className={`sugk ${suggestion.kind}`}>{suggestion.kind}</span>
      <span className="sugq">{suggestion.question}</span>
      {/* The reason is the teaching part: it names the columns and why their types make
          the question answerable. */}
      <span className="sugw">{suggestion.because}</span>
    </button>
  );
}

function ResultTable({
  columns, rows,
}: {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
}): JSX.Element {
  return (
    <div className="prev">
      <table>
        <thead>
          <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.slice(0, 200).map((row, i) => (
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
          <span>{answer.trace.inputTokens} in / {answer.trace.outputTokens} out</span>
          <span>
            {answer.trace.costUsd === 0 ? '$0 — runs on this machine' : `$${answer.trace.costUsd.toFixed(4)}`}
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
