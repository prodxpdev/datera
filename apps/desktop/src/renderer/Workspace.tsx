import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Dataset,
  EngineInfo,
  PreviewResult,
  SourceSchema,
  SourceWithStatus,
} from '@datera/core';
import type { DateraApi } from '../shared/contract.js';

/**
 * P1-17 — the Workspace view.
 *
 * The prototype's information architecture, limited to what Phase 1 actually does: the
 * dataset rail, the source list, schema chips with types, a paged preview, and the
 * read-only badge. Dictionary, Ask, SQL, Serve, Environments and Learn are shown disabled
 * rather than hidden — a user should be able to see where the product is going, and a
 * missing nav item reads as a bug in a way a greyed one does not.
 */

const KIND_LABEL: Record<string, string> = {
  csv: 'CSV', tsv: 'TSV', json: 'JSON', parquet: 'PARQ', xlsx: 'XLSX',
  sqlite: 'DB', postgres: 'PG', mysql: 'MYSQL',
};

const NAV: readonly (readonly [string, string, boolean])[] = [
  ['▤', 'Workspace', true],
  ['⌗', 'Dictionary', false],
  ['◇', 'Ask', false],
  ['›_', 'SQL', false],
  ['⇄', 'Serve · API/MCP', false],
  ['☁', 'Environments', false],
  ['◎', 'Learn', false],
];

const PAGE_SIZE = 50;

interface Loaded {
  readonly engine: EngineInfo;
  readonly datasets: readonly Dataset[];
  readonly sources: readonly SourceWithStatus[];
}

export function Workspace({ api }: { readonly api: DateraApi }): JSX.Element {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [schema, setSchema] = useState<SourceSchema | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const report = useCallback((e: unknown) => {
    const err = e as { code?: string; message?: string };
    setError({ code: err.code ?? 'UNKNOWN', message: err.message ?? String(e) });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [engine, datasets, sources] = await Promise.all([
        api.engineInfo(), api.listDatasets(), api.listSources(),
      ]);
      setLoaded({ engine, datasets, sources });
      setSelectedId((current) =>
        current !== null && sources.some((s) => s.id === current) ? current : sources[0]?.id ?? null,
      );
    } catch (e) {
      report(e);
    }
  }, [api, report]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = useMemo(
    () => loaded?.sources.find((s) => s.id === selectedId) ?? null,
    [loaded, selectedId],
  );

  useEffect(() => {
    setOffset(0);
  }, [selectedId]);

  useEffect(() => {
    if (selected === null) {
      setSchema(null);
      setPreview(null);
      return;
    }
    let cancelled = false;

    void (async () => {
      // An unavailable source has nothing to show. Reporting its status is the honest
      // response; asking the engine for a schema would just produce an error.
      if (selected.status.availability === 'unavailable') {
        if (!cancelled) {
          setSchema(null);
          setPreview(null);
        }
        return;
      }
      try {
        const [s, p] = await Promise.all([
          api.getSchema(selected.id),
          api.preview(selected.id, { limit: PAGE_SIZE, offset }),
        ]);
        if (!cancelled) {
          setSchema(s);
          setPreview(p);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) report(e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api, selected, offset, report]);

  const addSources = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const paths = await api.pickFiles();
      for (const path of paths) {
        const isSqlite = /\.(sqlite|sqlite3|db)$/i.test(path);
        await api.addSource(isSqlite ? { type: 'sqlite', path } : { type: 'file', path });
      }
      if (paths.length > 0) await refresh();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }, [api, refresh, report]);

  if (loaded === null) {
    return <div className="empty">Opening the workspace…</div>;
  }

  const dataset = loaded.datasets[0];

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand"><span className="m" />Datera</div>
        <div className="grp">Client</div>
        {NAV.map(([icon, label, enabled]) => (
          <div key={label} className={`nav ${enabled ? 'on' : 'off'}`} title={enabled ? undefined : 'Not in Phase 1'}>
            <span className="ic">{icon}</span>
            <span>{label}</span>
          </div>
        ))}
        <div className="foot">
          <span>DuckDB {loaded.engine.duckdbVersion}</span>
          <span>{loaded.engine.driver}</span>
        </div>
      </aside>

      <div className="mainwrap">
        <div className="banner">
          ● Working locally — data on this machine, read-only, nothing exposed.
        </div>
        <div className="mtop">
          <h1>Workspace</h1>
          <span className="desc">your local data sources</span>
        </div>

        <div className="pane">
          {error !== null && (
            <div className="err" role="alert">
              <code>{error.code}</code> — {error.message}
            </div>
          )}

          {loaded.sources.length === 0 ? (
            <div className="empty">
              <h2>No sources connected</h2>
              <p>
                Connect a CSV, TSV, JSON, Parquet, Excel workbook, or SQLite database. Datera reads
                it in place and never writes to it.
              </p>
              <button className="btn p" onClick={() => void addSources()} disabled={busy}>
                {busy ? 'Connecting…' : '+ Connect data'}
              </button>
            </div>
          ) : (
            <div className="wsgrid">
              <div className="card">
                <div className="railhead">
                  <span>Datasets</span>
                  <button
                    className="btn"
                    style={{ padding: '2px 8px', fontSize: 11 }}
                    onClick={() => void addSources()}
                    disabled={busy}
                  >
                    + add
                  </button>
                </div>
                {loaded.datasets.map((d) => (
                  <div key={d.id} className="dsgroup">
                    <div className="dsh">
                      <span className="dsn">{d.name}</span>
                      <span className="dsc">{loaded.sources.filter((s) => s.datasetId === d.id).length}</span>
                    </div>
                    {loaded.sources
                      .filter((s) => s.datasetId === d.id)
                      .map((s) => (
                        <div
                          key={s.id}
                          className={`srcitem ${s.id === selectedId ? 'on' : ''} ${
                            s.status.availability === 'unavailable' ? 'gone' : ''
                          }`}
                          onClick={() => setSelectedId(s.id)}
                        >
                          <span className="ic">{KIND_LABEL[s.kind] ?? s.kind.toUpperCase()}</span>
                          <div>
                            <div className="nm">{s.name}</div>
                            <div className="ct">
                              {s.status.availability === 'unavailable' ? 'unavailable' : s.kind}
                            </div>
                          </div>
                        </div>
                      ))}
                  </div>
                ))}
              </div>

              <div>
                <div className="dsbar">
                  <div>
                    <div className="dsbn">{dataset?.name ?? 'Ungrouped'}</div>
                    <div className="dsbd">{dataset?.description ?? ''}</div>
                  </div>
                  <span className="scope">single-source only</span>
                </div>

                {selected === null ? (
                  <div className="empty">Select a source.</div>
                ) : selected.status.availability === 'unavailable' ? (
                  <div className="warn">
                    <b>{selected.name} is unavailable</b>
                    {selected.status.reason ?? 'Unknown reason.'}
                  </div>
                ) : (
                  <SourceDetail source={selected} schema={schema} preview={preview} offset={offset} onPage={setOffset} />
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SourceDetail({
  source, schema, preview, offset, onPage,
}: {
  readonly source: SourceWithStatus;
  readonly schema: SourceSchema | null;
  readonly preview: PreviewResult | null;
  readonly offset: number;
  readonly onPage: (n: number) => void;
}): JSX.Element {
  const warnings = source.detection.warnings ?? [];

  return (
    <>
      {warnings.map((w) => (
        <div className="warn" key={w}>
          <b>How this file was read</b>
          {w}
        </div>
      ))}

      {schema !== null && (
        <div className="schips">
          {schema.columns.map((c) => (
            <span
              key={c.name}
              className={`schip ${c.inference?.verdict === 'ambiguous' ? 'flagged' : ''}`}
              title={c.inference?.evidence ?? undefined}
            >
              {c.name} <span className="ty">{c.type}</span>
              {c.nullCount > 0 && <span className="nulls"> · {c.nullCount} null</span>}
              {c.inference?.verdict === 'ambiguous' && ' ⚠'}
            </span>
          ))}
        </div>
      )}

      {preview !== null && (
        <>
          <div className="prev">
            <table>
              <thead>
                <tr>{preview.columns.map((c) => <th key={c.name}>{c.name}</th>)}</tr>
              </thead>
              <tbody>
                {preview.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((value, j) => (
                      <td key={j} className={value === null ? 'null' : undefined}>
                        {value === null ? 'NULL' : String(value)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="pager">
            <button className="btn" disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - PAGE_SIZE))}>
              ← prev
            </button>
            <button className="btn" disabled={!preview.hasMore} onClick={() => onPage(offset + PAGE_SIZE)}>
              next →
            </button>
            <span>
              rows {offset + 1}–{offset + preview.rows.length}
              {schema !== null && ` of ${schema.rowCount.toLocaleString()}`}
            </span>
          </div>
        </>
      )}

      <div className="readonly">
        ● {source.name} · read-only · Datera reads this source in place and never writes to it
      </div>

      <div className="detail">
        <h3>How this source was read</h3>
        <dl className="kv">
          <dt>origin</dt>
          <dd>{source.origin}</dd>
          <dt>method</dt>
          <dd>{source.detection.method}</dd>
          {Object.entries(source.detection.settings).map(([k, v]) => (
            <Fragment2 key={k} k={k} v={v} />
          ))}
        </dl>
      </div>
    </>
  );
}

/** Small helper so the definition list stays flat rather than nesting fragments inline. */
function Fragment2({ k, v }: { readonly k: string; readonly v: string }): JSX.Element {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}
