import { useCallback, useState } from 'react';
import type { QueryResult } from '@datera/core';
import type { DateraApi } from '../shared/contract.js';

/**
 * The direct SQL editor.
 *
 * Same engine and the same read-only guard as Ask — deliberately, and the note in the UI
 * says so. If hand-written SQL took a different path, "the SQL Datera showed you is the
 * SQL that ran" would stop being true the moment someone edited it.
 */
export function SqlView({
  api,
  datasetId,
  datasetName,
}: {
  readonly api: DateraApi;
  readonly datasetId: string;
  readonly datasetName: string;
}): JSX.Element {
  const [sql, setSql] = useState('SELECT * FROM orders LIMIT 20;');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.query(datasetId, sql));
    } catch (e) {
      const err = e as { code?: string; message?: string };
      setError({ code: err.code ?? 'UNKNOWN', message: err.message ?? String(e) });
    } finally {
      setBusy(false);
    }
  }, [api, datasetId, sql]);

  return (
    <>
      <div className="qscope">
        SQL runs against <b>{datasetName}</b> only — the sources in this dataset&rsquo;s schema.
        Same engine as Ask, and the same read-only guard.
      </div>

      <div className="card sqled">
        <div className="sqlhead">
          <span>DuckDB SQL · read-only</span>
          <button className="btn p" data-runsql onClick={() => void run()} disabled={busy}>
            {busy ? 'Running…' : '▶ Run'}
          </button>
        </div>
        <textarea value={sql} onChange={(e) => setSql(e.target.value)} spellCheck={false} />
      </div>

      <div className="sqlres">
        {error !== null && (
          <div className="err" role="alert">
            <code>{error.code}</code> — {error.message}
          </div>
        )}

        {result !== null && (
          <>
            <div className="prev">
              <table>
                <thead>
                  <tr>{result.columns.map((c) => <th key={c.name}>{c.name}</th>)}</tr>
                </thead>
                <tbody>
                  {result.rows.slice(0, 200).map((row, i) => (
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
            <div className="readonly">
              ● {result.rows.length} rows · {result.durationMs.toFixed(0)}ms · read-only ·{' '}
              {result.statementKinds.join(', ')}
            </div>
          </>
        )}
      </div>
    </>
  );
}
