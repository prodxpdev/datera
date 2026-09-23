import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  completionsAt, explainRefusal, referencedTables, starterSql, suggestQuestions,
  type AskResult, type CompletionResult, type QueryResult, type RefusalExplanation,
  type SchemaGraph, type Suggestion, type TouchedSummary, type TraceRecord, type TraceStage,
  type WriteProposal,
} from '@datera/core';
import type { DateraApi } from '../shared/contract.js';
import { SchemaMap } from './SchemaMap.js';
import { TraceFlow } from './TraceFlow.js';

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
  datasetKind,
  onChanged,
  environment,
}: {
  readonly api: DateraApi;
  readonly datasetId: string;
  readonly datasetName: string;
  /** 'connected' can never be granted writes (§1.2); 'derived' can. */
  readonly datasetKind: string;
  readonly onChanged: () => void;
  /**
   * Set when the selected dataset lives on a Datera Server (§12.10).
   *
   * The same editor, the same result table, the same guard — enforced on the server,
   * which is what makes it a guarantee rather than advice. What changes is where the
   * statement runs, and the scope line says so rather than letting it look local.
   */
  readonly environment?: { id: string; name: string } | undefined;
}): JSX.Element {
  const [graph, setGraph] = useState<SchemaGraph | null>(null);
  const [sql, setSql] = useState('');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AskResult | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [history, setHistory] = useState<readonly TraceRecord[]>([]);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [refusal, setRefusal] = useState<RefusalExplanation | null>(null);
  const [proposal, setProposal] = useState<WriteProposal | null>(null);
  const [writable, setWritable] = useState(false);
  /** Said after an apply: the change is gone from the screen, so say what happened to it. */
  const [trailer, setTrailer] = useState<string | null>(null);
  const [touched, setTouched] = useState<TouchedSummary | null>(null);
  const [busy, setBusy] = useState<'ask' | 'run' | null>(null);
  /** Seconds since the current request started, so a slow model does not look like a hang. */
  const [elapsed, setElapsed] = useState(0);
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
      // A server exposes datasets and queries, not the local schema graph — so remote
      // work gets an empty graph and the features that depend on it (completions, the
      // map, suggestions) stand down rather than showing something invented.
      const next = environment === undefined
        ? await api.schemaGraph(datasetId)
        : { datasetId, tables: [], relationships: [] };
      if (cancelled) return;
      setGraph(next);
      setSql(environment === undefined ? starterSql(next) : `SELECT * FROM ${datasetId} LIMIT 20;`);
      setWritable(environment === undefined ? await api.canWrite(datasetId) : false);
      setAnswer(null);
      setResult(null);
      setError(null);
      setProposal(null);
      await loadHistory();
    })();
    return () => {
      cancelled = true;
    };
  }, [api, datasetId, environment, loadHistory]);

  // A local model can take tens of seconds on a cold load (#33), and a button that says
  // "Asking…" for forty seconds is indistinguishable from one that has stopped working.
  // A ticking count is the cheapest honest answer: it says the wait is real and measured.
  useEffect(() => {
    if (busy === null) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);

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
    // A refusal is the best teaching moment the product gets — it arrives exactly when
    // someone tried the dangerous thing. Spending it on an error code wastes it.
    setRefusal(explainRefusal(e));
  };

  const ask = useCallback(
    async (text: string) => {
      if (text.trim().length === 0) return;
      setBusy('ask');
      setError(null);
      setRefusal(null);
      setTouched(null);
      setAnswer(null);
      setResult(null);
      try {
        const next = await api.ask(datasetId, text);
        setAnswer(next);
        // The whole point of the merge: the generated SQL lands in the editor, where it
        // can be read and changed, rather than behind a button.
        if (next.sql !== null) {
          setSql(next.sql);
          setTouched(await describe(api, datasetId, next.sql, next.rows.length));
        }
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
    setRefusal(null);
    setTouched(null);
    setResult(null);
    setAnswer(null);
    setProposal(null);
    setTrailer(null);
    try {
      if (environment !== undefined) {
        // Straight to the server. Its guard refuses a write there, which is the point:
        // a client-side check would be advice, and the server enforcing it is the
        // guarantee §12.10 is about.
        const remote = await api.remoteQuery(environment.id, datasetId, sql);
        setResult({
          datasetId,
          sql,
          statementKinds: ['SELECT'],
          columns: remote.columns,
          rows: remote.rows,
          durationMs: remote.durationMs,
        } as QueryResult);
        return;
      }

      // Read fresh rather than trusting the cached flag: a grant can be revoked from Data
      // while this view is open, and a stale "writable" would send a refused statement
      // down the propose path and report the wrong reason for stopping.
      const mayWrite = await api.canWrite(datasetId);
      setWritable(mayWrite);

      // Which core call to make, not whether the statement is safe. The engine classifies
      // through DuckDB's parser and refuses anything it cannot prove is a read — this
      // text check only decides whether to ask for a preview or a result, and getting it
      // wrong produces a refusal rather than an unguarded write.
      if (mayWrite && /^\s*(update|delete|insert)\b/i.test(sql)) {
        setProposal(await api.proposeWrite(datasetId, sql));
        return;
      }

      const next = await api.query(datasetId, sql);
      setResult(next);
      setTouched(await describe(api, datasetId, sql, next.rows.length));
    } catch (e) {
      report(e);
    } finally {
      setBusy(null);
      await loadHistory();
    }
  }, [api, datasetId, sql, environment, loadHistory]);

  const grantHere = useCallback(async () => {
    setBusy('run');
    try {
      // May land on a working copy rather than this dataset — that is the mechanism §1.2
      // requires, and the trailer says so rather than moving the user silently.
      const { datasetId: landed, derived } = await api.enableWrites(datasetId);
      setWritable(landed === datasetId);
      setRefusal(null);
      setError(null);
      setTrailer(
        derived
          ? `Made a working copy of ${datasetName} and enabled writes on it. Switch to it in the Dataset picker above to make changes there; ${datasetName} and the files behind it are untouched.`
          : `Writes enabled on ${datasetName}. Run the statement again to see what it would do.`,
      );
      onChanged();
    } catch (e) {
      report(e);
    } finally {
      setBusy(null);
    }
  }, [api, datasetId, datasetName, onChanged]);

  const recompute = useCallback(
    (text: string, cursor: number, trigger: 'typing' | 'explicit' = 'typing') => {
      if (graph === null) return;
      setCompletions(completionsAt(graph, text, cursor, { trigger }));
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
      recompute(sql, e.currentTarget.selectionStart, 'explicit');
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
      <div className="qscope" data-scope>
        {environment === undefined ? (
          <>
            Querying <b>{datasetName}</b>. Ask in words or write SQL — both go through the same
            engine and the same read-only guard, on this machine.
          </>
        ) : (
          <>
            Querying <b>{datasetName}</b> on <b>{environment.name}</b> — a Datera Server you run.
            Same engine, same read-only guard, enforced there rather than here. Completions and
            the schema map are local features and stand down.
          </>
        )}
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
          {busy === 'ask' ? `Asking… ${elapsed}s` : 'Ask'}
        </button>
      </div>

      {/* Said only once it is actually slow, and said for the reason it is slow. A hint
          shown immediately would be noise; one shown at ten seconds is an explanation. */}
      {busy === 'ask' && elapsed >= 10 && (
        <div className="softflag" data-slow>
          Still working — {elapsed}s. A model running on this machine loads its weights the
          first time it is used, which can take a minute on a laptop. It is much faster after
          that, and Datera warms it when you pick it.
        </div>
      )}

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
            {busy === 'run' ? `Running… ${elapsed}s` : '▶ Run'}
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
              {completions.items.map((item, i) => (
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
        <div className="sqlfoot">⌘↵ runs · ⌃Space for the full list. Completions come from your schema, not a model.</div>
      </div>

      {error !== null && (
        <div className="err" role="alert">
          <code>{error.code}</code> — {error.message}
        </div>
      )}

      {refusal !== null && (
        <div className="refusal" data-refusal>
          <div className="rfh">What that would have done</div>
          <p className="rfw">This statement would {refusal.whatItWouldHaveDone}</p>
          <div className="rfh">What to do instead</div>
          <p className="rfw">{refusal.whatToDoInstead}</p>

          {/* The fix offered where the refusal happened. Sending someone to hunt for a
              setting is how a safety mechanism turns into an obstacle. */}
          {datasetKind !== 'connected' && !writable && (
            <p className="rfw">
              <b>Writes are not enabled on {datasetName}.</b> Enabling them does not apply
              anything — every change is still previewed with its exact row count and confirmed
              by you first.{' '}
              <button className="btn p" data-grant-here disabled={busy !== null} onClick={() => void grantHere()}>
                Enable writes on {datasetName}
              </button>
            </p>
          )}
          {datasetKind === 'connected' && (
            <p className="rfw">
              <b>{datasetName} reads your files directly</b>, and Datera never writes to a file you
              connected. Enabling writes makes a <b>working copy</b> and enables them there —
              your originals stay exactly as they are.{' '}
              <button className="btn p" data-grant-here disabled={busy !== null} onClick={() => void grantHere()}>
                Make a working copy and enable writes
              </button>
            </p>
          )}
        </div>
      )}

      {proposal !== null && (
        <div className="writepreview" data-writepreview>
          <div className="wphead">
            <span className={`verb ${proposal.statementKind.toLowerCase()}`}>{proposal.statementKind}</span>
            <span className="wpcount">
              {proposal.rowsAffected} row{proposal.rowsAffected === 1 ? '' : 's'} in {proposal.table}
            </span>
            <span className="wpnot">not applied</span>
          </div>

          <pre className="sqlblock">{proposal.sql}</pre>

          {proposal.warnings.map((warning) => (
            <div className="writewarn" key={warning}>⚠ {warning}</div>
          ))}

          {proposal.changes.length > 0 && (
            <table className="changetable">
              <thead>
                <tr><th>column</th><th>now</th><th>would become</th></tr>
              </thead>
              <tbody>
                {proposal.changes.slice(0, 8).flatMap((change, i) =>
                  Object.keys(change.after).length === 0
                    ? [
                        <tr key={`del-${i}`} className="deleted">
                          <td colSpan={3}>
                            row {i + 1} would be deleted — {Object.entries(change.before).slice(0, 4)
                              .map(([k, v]) => `${k}=${String(v)}`).join(', ')}
                          </td>
                        </tr>,
                      ]
                    : Object.entries(change.after).map(([column, next]) => (
                        <tr key={`${i}-${column}`}>
                          <td className="cn">{column}</td>
                          <td className="was">{String(change.before[column])}</td>
                          <td className="will">{String(next)}</td>
                        </tr>
                      )),
                )}
              </tbody>
            </table>
          )}

          <div className="pickrow">
            <button
              className="btn p"
              data-confirm-write
              disabled={busy !== null}
              onClick={() =>
                void (async () => {
                  setBusy('run');
                  try {
                    const applied = await api.confirmWrite(proposal.id);
                    setProposal(null);
                    setError(null);
                    onChanged();
                    await loadHistory();
                    setResult(null);
                    setTouched(null);
                    setTrailer(`Applied — ${applied.rowsChanged} row(s) changed. Undo it in Data → Write access.`);
                  } catch (e) {
                    report(e);
                  } finally {
                    setBusy(null);
                  }
                })()
              }
            >
              Confirm and apply
            </button>
            <button className="btn" disabled={busy !== null} onClick={() => setProposal(null)}>
              Discard
            </button>
          </div>
        </div>
      )}

      {trailer !== null && <div className="softflag" data-applied>{trailer}</div>}

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

      {/* The result comes straight after the editor: it is what Run was pressed for.
          The explanation of what it touched sits under it, annotating a number already
          on screen, and the schema map — a reference, not an answer — goes last. All
          three used to precede the result, which pushed it below the fold. */}
      {touched !== null && touched.shape !== 'none' && <Touched summary={touched} />}

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

      {answer !== null && drawerOpen && (
        <>
          <div className="scrim show" onClick={() => setDrawerOpen(false)} />
          <TraceDrawer answer={answer} onClose={() => setDrawerOpen(false)} />
        </>
      )}
    </div>
  );
}

/**
 * What the query actually read — asked of the engine, not inferred from the text.
 *
 * A result table shows numbers. It does not show that two tables were joined on a key, or
 * which rows a filter let through, and those are exactly the two places a plausible wrong
 * answer comes from. Naming them turns the result into something checkable.
 */
function Touched({ summary }: { readonly summary: TouchedSummary }): JSX.Element {
  return (
    <div className="touched" data-touched>
      <div className="tch">
        {summary.shape === 'join'
          ? `This joined ${summary.tables.length} tables.`
          : 'This read one table.'}
      </div>

      {summary.joinPath.length > 0 && (
        <p className="tcw">
          Joined on {summary.joinPath.join(', ')}. A row appears in the result only where both
          sides matched — anything without a match on the other side is silently absent, which is
          the usual reason a joined total comes out lower than expected.
        </p>
      )}

      {summary.filter !== null && (
        <p className="tcw">
          Filtered by <span className="mono">{summary.filter}</span>
          {summary.rowsScanned !== null && (
            <> — {summary.rowsScanned.toLocaleString()} rows were examined and{' '}
            {summary.rowsReturned.toLocaleString()} matched.</>
          )}
        </p>
      )}

      <div className="tcc">
        {summary.tables.map((table) => (
          <span className="tct" key={table.table}>
            {table.table}
            <i>
              {table.columns
                .filter((c) => c.role !== null)
                .map((c) => `${c.column} (${c.role})`)
                .join(' · ')}
            </i>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Ask the engine what a statement touched. Never fatal: it is an explanation, not a result. */
async function describe(
  api: DateraApi, datasetId: string, sql: string, rows: number,
): Promise<TouchedSummary | null> {
  try {
    return await api.explainTouched(datasetId, sql, rows);
  } catch {
    return null;
  }
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

        {/* The journey first — which hop the time went to — then each stage in full,
            including the exact bytes sent to the model. */}
        <TraceFlow stages={answer.trace.stages} totalMs={answer.trace.totalMs} />

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
