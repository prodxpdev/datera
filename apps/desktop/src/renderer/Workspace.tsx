import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Dataset,
  ModelCatalogue,
  EngineInfo,
  PreviewResult,
  SourceSchema,
  SourceWithStatus,
} from '@datera/core';
import type { DateraApi } from '../shared/contract.js';
import { Query } from './Query.js';
import { Dictionary } from './Dictionary.js';
import { Activity } from './Activity.js';
import { Learn } from './Learn.js';
import { Shape } from './Shape.js';
import { WriteAccess } from './WriteAccess.js';
import { Settings } from './Settings.js';
import { Mark } from './Brand.js';
import { FirstRun } from './FirstRun.js';

/**
 * The application shell.
 *
 * The sidebar used to carry one item per build phase — Workspace, Ask, SQL, Models,
 * Dictionary, Shape, Edit, Serve, Environments, Learn, which is phases one through nine
 * in order. It read as a record of how the product was made rather than a map of what you
 * do with it, and nobody works in that order.
 *
 * Five items now, grouped by intent. Setup — models, servers, connect configs, retention,
 * write grants — moved into Settings, because none of it is a place you work. Ask and SQL
 * merged, because they were always one activity running one engine.
 *
 * The dataset switcher lives in the chrome rather than being re-asked by four views. The
 * dataset is the boundary the product guarantees — sources in different datasets can
 * never be joined — and a guarantee that strong should be visible at all times, not
 * rediscovered per screen.
 */

const KIND_LABEL: Record<string, string> = {
  csv: 'CSV', tsv: 'TSV', json: 'JSON', parquet: 'PARQ', xlsx: 'XLSX',
  sqlite: 'DB', postgres: 'PG', mysql: 'MYSQL',
};

type NavId = 'data' | 'query' | 'meaning' | 'learn' | 'activity';
type DataTab = 'sources' | 'shape' | 'access';

interface NavItem {
  readonly id: NavId;
  readonly icon: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly title: string;
  readonly subtitle: string;
}

/** Five destinations, named for what you are trying to do. */
const NAV: readonly NavItem[] = [
  { id: 'data', icon: '▤', label: 'Data', enabled: true, title: 'Data', subtitle: 'sources, groups, working copies, and what may change them' },
  { id: 'query', icon: '◇', label: 'Query', enabled: true, title: 'Query', subtitle: 'ask in words or write SQL — reads run, changes are previewed first' },
  { id: 'meaning', icon: '⌗', label: 'Meaning', enabled: true, title: 'Meaning', subtitle: 'what your columns mean — the layer NL and search read' },
  // Kept as a destination rather than folded in as a tab. It is the product's stated
  // reason to exist in a classroom, and a tab gets clicked a fraction as often.
  { id: 'learn', icon: '◎', label: 'Learn', enabled: true, title: 'Learn', subtitle: 'how a value actually reaches the screen, and what breaks on the way' },
  { id: 'activity', icon: '⇄', label: 'Activity', enabled: true, title: 'Activity', subtitle: 'what agents can call, and every request that ran' },
];

const PAGE_SIZE = 50;

interface Loaded {
  readonly engine: EngineInfo;
  readonly datasets: readonly Dataset[];
  readonly sources: readonly SourceWithStatus[];
  readonly models: ModelCatalogue;
  /** Datasets that may currently be written to. Usually empty, and that is the point. */
  readonly writable: readonly string[];
}

export function Workspace({ api }: { readonly api: DateraApi }): JSX.Element {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [schema, setSchema] = useState<SourceSchema | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [nav, setNav] = useState<NavId>('data');
  const [dataTab, setDataTab] = useState<DataTab>('sources');
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The governing boundary, held once for the whole app instead of re-asked per view.
  const [datasetId, setDatasetId] = useState<string | null>(null);
  const [newDataset, setNewDataset] = useState(false);
  const [newName, setNewName] = useState('');

  const report = useCallback((e: unknown) => {
    const err = e as { code?: string; message?: string };
    setError({ code: err.code ?? 'UNKNOWN', message: err.message ?? String(e) });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [engine, datasets, sources, models] = await Promise.all([
        api.engineInfo(), api.listDatasets(), api.listSources(), api.listModels(),
      ]);
      const grants = await Promise.all(
        datasets.map(async (d) => ((await api.canWrite(d.id)) ? d.id : null)),
      );
      setLoaded({
        engine, datasets, sources, models,
        writable: grants.filter((id): id is string => id !== null),
      });
      setDatasetId((current) =>
        current !== null && datasets.some((d) => d.id === current) ? current : datasets[0]?.id ?? null,
      );
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

  // ⌘, is where every desktop application on this machine puts its settings.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

  const createDataset = async (): Promise<void> => {
    if (newName.trim().length === 0) return;
    try {
      await api.createDataset({ name: newName.trim() });
      setNewName('');
      setNewDataset(false);
      await refresh();
    } catch (e) {
      report(e);
    }
  };

  const moveTo = async (sourceId: string, datasetId: string): Promise<void> => {
    try {
      await api.moveSource(sourceId, datasetId);
      await refresh();
    } catch (e) {
      report(e);
    }
  };

  const removeDataset = async (datasetId: string): Promise<void> => {
    try {
      await api.deleteDataset(datasetId);
      await refresh();
    } catch (e) {
      report(e);
    }
  };

  if (loaded === null) {
    return <div className="empty">Opening the workspace…</div>;
  }

  const dataset = loaded.datasets.find((d) => d.id === datasetId) ?? loaded.datasets[0];
  // Only connected datasets can hold a source. A derived dataset owns materialised tables
  // copied from somewhere else, so moving a file into one would be meaningless.
  const groupable = loaded.datasets.filter((d) => d.kind !== 'derived');
  const activeId = dataset?.id ?? 'ungrouped';
  const current = NAV.find((n) => n.id === nav) ?? NAV[0]!;

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand"><Mark /><span className="bt">Datera</span></div>
        <div className="grp">Client</div>
        {NAV.map((item) => (
          <div
            key={item.id}
            className={`nav ${item.enabled ? (nav === item.id ? 'on' : 'idle') : 'off'}`}
            title={item.enabled ? item.label : `${item.label} — ${item.subtitle}`}
            data-nav={item.id}
            onClick={() => {
              if (item.enabled) setNav(item.id);
            }}
          >
            <span className="ic">{item.icon}</span>
            <span className="tx">{item.label}</span>
          </div>
        ))}
        <div
          className="nav idle settingsnav"
          data-nav="settings"
          title="Settings (⌘,)"
          onClick={() => setSettingsOpen(true)}
        >
          <span className="ic">⚙</span>
          <span className="tx">Settings</span>
          <span className="kbd">⌘,</span>
        </div>

        <div className="foot">
          <span>DuckDB {loaded.engine.duckdbVersion}</span>
          <span>{loaded.engine.driver}</span>
        </div>
      </aside>

      <div className="mainwrap">
        {/* The consequences of the current configuration, stated where the work happens.
            Settings is where you change these; a settings page is not where anyone
            learns what they mean. */}
        <div className={loaded.writable.length > 0 ? 'banner writable' : 'banner'}>
          <span>● Data on this machine.</span>
          <span>
            {loaded.models.selectedName === null ? (
              <>No model chosen — <b>Ask</b> needs one; SQL and completions do not.</>
            ) : loaded.models.selected?.locality === 'local' ? (
              <>Questions answered by <b>{loaded.models.selectedName}</b>, running here. No data leaves, nothing is billed.</>
            ) : (
              <>
                Questions answered by <b>{loaded.models.selectedName}</b> — your schema is sent to
                {' '}{loaded.models.selected?.provider}, billed to your key. Never your rows.
              </>
            )}
          </span>
          <span>
            {loaded.writable.length === 0 ? (
              <>Read-only: nothing here can change your data.</>
            ) : (
              <>
                <b>Writes enabled</b> on {loaded.writable.length} dataset(s) — changes still need
                confirming in Changes.
              </>
            )}
          </span>
        </div>
        <div className="mtop">
          <h1>{current.title}</h1>
          <span className="desc">{current.subtitle}</span>

          {/* The boundary, always on screen. Sources in different datasets can never be
              joined, and a guarantee that strong should not be a per-view dropdown. */}
          <label className="dspick" title="Everything below is scoped to this dataset">
            <span className="dspl">Dataset</span>
            <select
              data-dataset-switch
              value={dataset?.id ?? ''}
              onChange={(e) => setDatasetId(e.target.value)}
            >
              {loaded.datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {loaded.sources.filter((x) => x.datasetId === d.id).length} source(s)
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="pane">
          {/* Shown only while nothing can answer a question. A configured workspace never
              sees it, and it is dismissible for anyone bringing their own key. */}
          <FirstRun api={api} onDone={() => void refresh()} />

          {error !== null && (
            <div className="err" role="alert">
              <code>{error.code}</code> — {error.message}
            </div>
          )}

          {nav === 'query' && (
            <Query
              key={activeId}
              api={api}
              datasetId={activeId}
              datasetName={dataset?.name ?? 'Ungrouped'}
              datasetKind={dataset?.kind ?? 'connected'}
              onChanged={() => void refresh()}
            />
          )}

          {nav === 'meaning' && (
            <Dictionary api={api} sources={loaded.sources.filter((s) => s.datasetId === activeId)} />
          )}

          {nav === 'learn' && <Learn api={api} />}

          {nav === 'activity' && <Activity api={api} />}

          {nav === 'data' && (
            <div className="subnav">
              <button
                data-data="sources"
                className={dataTab === 'sources' ? 'on' : ''}
                onClick={() => setDataTab('sources')}
              >
                Sources
              </button>
              <button
                data-data="shape"
                className={dataTab === 'shape' ? 'on' : ''}
                onClick={() => setDataTab('shape')}
              >
                Shape &amp; export
              </button>
              {/* Enabling writes is a property of a dataset, and so is the history of what
                  changed it — both belong beside the data, next to the copy-on-write step
                  that makes writing possible at all. */}
              <button
                data-data="access"
                className={dataTab === 'access' ? 'on' : ''}
                onClick={() => setDataTab('access')}
              >
                Write access
              </button>
            </div>
          )}

          {nav === 'data' && dataTab === 'access' && (
            <WriteAccess
              api={api}
              datasets={loaded.datasets}
              onChanged={() => void refresh()}
              onSwitchTo={setDatasetId}
            />
          )}

          {nav === 'data' && dataTab === 'shape' && (
            <Shape api={api} datasets={loaded.datasets} sources={loaded.sources} onChanged={() => void refresh()} />
          )}

          {nav === 'data' && dataTab === 'sources' && (loaded.sources.length === 0 ? (
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
                  <span className="railacts">
                    <button className="linkbtn" data-newds onClick={() => setNewDataset(true)}>
                      + group
                    </button>
                    <button className="linkbtn" onClick={() => void addSources()} disabled={busy}>
                      + data
                    </button>
                  </span>
                </div>

                {newDataset && (
                  <div className="newds">
                    <input
                      autoFocus
                      value={newName}
                      placeholder="Store exports"
                      onChange={(e) => setNewName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void createDataset();
                        if (e.key === 'Escape') setNewDataset(false);
                      }}
                    />
                    <button className="btn p" onClick={() => void createDataset()}>Create</button>
                    <button className="btn" onClick={() => setNewDataset(false)}>Cancel</button>
                    <div className="newdshint">
                      Group sources that share a key so they can be queried together. Sources in
                      different datasets can never be joined — that is the guarantee.
                    </div>
                  </div>
                )}
                {loaded.datasets.map((d) => (
                  <div key={d.id} className={`dsgroup ${d.id === activeId ? 'on' : ''}`}>
                    <div className="dsh" data-pick-dataset={d.id} onClick={() => setDatasetId(d.id)}>
                      <span className="dsn">{d.name}</span>
                      <span className="dsc" title={d.kind === 'derived' ? 'a working copy' : undefined}>
                        {d.kind === 'derived'
                          ? 'copy'
                          : loaded.sources.filter((s) => s.datasetId === d.id).length}
                        {!d.isDefault && (
                          <button
                            className="linkbtn dsdel"
                            title="Delete this dataset (it must be empty first)"
                            onClick={() => void removeDataset(d.id)}
                          >
                            ×
                          </button>
                        )}
                      </span>
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
                          <div className="srcbody">
                            <div className="nm" title={s.name}>{s.name}</div>
                            <div className="ct">
                              {s.status.availability === 'unavailable' ? 'unavailable' : s.kind}
                            </div>
                          </div>

                          {/* A labelled picker, not a ⇄ that reveals a list of buttons.
                              Moving a source between groups is the main thing this rail is
                              for, and it was the least discoverable control on the screen. */}
                          {groupable.length > 1 && (
                            <select
                              className="movesel"
                              data-move={s.id}
                              value={d.id}
                              title={`"${s.name}" is in ${d.name}. Choose another group to move it.`}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => void moveTo(s.id, e.target.value)}
                            >
                              {groupable.map((t) => (
                                <option key={t.id} value={t.id}>
                                  {t.id === d.id ? `in ${t.name}` : `move to ${t.name}`}
                                </option>
                              ))}
                            </select>
                          )}
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
                  <span className="scope">
                    {loaded.sources.filter((s) => s.datasetId === activeId).length} source(s) in scope
                  </span>
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
          ))}
        </div>
      </div>

      {settingsOpen && (
        <Settings
          api={api}
          datasets={loaded.datasets}
          datasetId={activeId}
          onClose={() => setSettingsOpen(false)}
          onChanged={() => void refresh()}
        />
      )}
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
