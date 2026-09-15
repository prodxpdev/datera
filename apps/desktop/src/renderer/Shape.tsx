import { useCallback, useEffect, useState } from 'react';
import type {
  Dataset, EnumProposal, NormalizationProposal, SourceWithStatus, Version, VersionDiff,
} from '@datera/core';
import type { DateraApi } from '../shared/contract.js';

/**
 * Shape — copy-on-write, normalize, versions and export (spec §3, §7, §1.2, §1.8).
 *
 * The engine had all of this from Phase 5 with no way to reach it. The through-line the
 * view has to make obvious is §1.2: **the original is never touched**. So every
 * destructive-sounding action here says where its result lands, and the normalize
 * proposal shows the repetition it measured — §1.3 asks a human to ratify the split, and
 * ratifying what you cannot evaluate is just clicking OK.
 */
export function Shape({
  api,
  datasets,
  sources,
  onChanged,
}: {
  readonly api: DateraApi;
  readonly datasets: readonly Dataset[];
  readonly sources: readonly SourceWithStatus[];
  readonly onChanged: () => void;
}): JSX.Element {
  const [datasetId, setDatasetId] = useState(datasets[0]?.id ?? '');
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '');
  const [proposal, setProposal] = useState<NormalizationProposal | null>(null);
  const [enums, setEnums] = useState<readonly EnumProposal[]>([]);
  const [versions, setVersions] = useState<readonly Version[]>([]);
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const dataset = datasets.find((d) => d.id === datasetId) ?? datasets[0];

  const refreshVersions = useCallback(async () => {
    if (dataset === undefined) return;
    setVersions(await api.listVersions(dataset.id));
  }, [api, dataset]);

  useEffect(() => {
    void refreshVersions();
  }, [refreshVersions]);

  const run = useCallback(
    async (label: string, work: () => Promise<string | null>): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        const message = await work();
        if (message !== null) setNote(message);
        onChanged();
        await refreshVersions();
      } catch (e) {
        setError(`${label}: ${(e as { message?: string }).message ?? String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [onChanged, refreshVersions],
  );

  if (dataset === undefined) return <div className="empty">Connect a source first.</div>;

  return (
    <div className="shape">
      {note !== null && <div className="softflag">{note}</div>}
      {error !== null && <div className="err">{error}</div>}

      <div className="pickrow">
        <span className="lb">Dataset</span>
        <select value={datasetId} onChange={(e) => setDatasetId(e.target.value)} data-shape-dataset>
          {datasets.map((d) => (
            <option key={d.id} value={d.id}>{d.name} ({d.kind})</option>
          ))}
        </select>
      </div>

      <section className="shapebox">
        <h3>1 · Work on a copy</h3>
        <p>
          Editing and modelling happen on a <b>derived copy</b>, never on the files you connected.
          That is not a setting — a dataset that reads your sources directly cannot be granted
          writes at all.
        </p>
        <button
          className="btn p"
          data-derive
          disabled={busy}
          onClick={() =>
            void run('Derive', async () => {
              const result = await api.deriveDataset(dataset.id, { name: `${dataset.name} copy` });
              return `Derived a copy with ${result.tables.length} table(s). The original is untouched.`;
            })
          }
        >
          Derive a working copy
        </button>
        {dataset.kind === 'derived' && (
          <span className="kindnote">This dataset is already a copy of another.</span>
        )}
      </section>

      <section className="shapebox">
        <h3>2 · Find the entities hiding in a flat sheet</h3>
        <p>
          Datera looks for values that actually repeat together and proposes splitting them into
          real tables with keys. You edit the proposal and confirm it; the result lands in a new
          dataset.
        </p>

        <div className="pickrow">
          <span className="lb">Source</span>
          <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button
            className="btn"
            data-propose-normalize
            disabled={busy || sourceId.length === 0}
            onClick={() =>
              void run('Propose', async () => {
                setProposal(await api.proposeNormalization(sourceId));
                setEnums(await api.proposeEnums(sourceId));
                return null;
              })
            }
          >
            Propose a split
          </button>
        </div>

        {proposal !== null && (
          <>
            {proposal.entities.length === 0 ? (
              <div className="emptyrail">
                No repeating entities found — this sheet already looks like one thing per row.
              </div>
            ) : (
              <>
                {/* Nothing is applied yet. §1.3: the evidence is shown so the proposal can
                    actually be evaluated rather than merely accepted. */}
                <div className="softflag">
                  <b>Nothing has been applied.</b> Review the evidence, then confirm.
                </div>

                {proposal.entities.map((entity) => (
                  <div className="entityproposal" key={entity.name}>
                    <div className="epname">
                      {entity.name}
                      <span className="epkey">key: {entity.keyColumn}</span>
                    </div>
                    <div className="epcols">
                      {entity.attributeColumns.map((c) => <span className="alias" key={c}>{c}</span>)}
                    </div>
                    <div className="epevidence">{entity.evidence}</div>
                  </div>
                ))}

                <button
                  className="btn p"
                  data-apply-normalize
                  disabled={busy}
                  onClick={() =>
                    void run('Normalize', async () => {
                      const result = await api.applyNormalization(dataset.id, proposal, {
                        name: `${dataset.name} normalized`,
                      });
                      setProposal(null);
                      return `Created ${result.tables.join(', ')} in a new dataset. The original is untouched.`;
                    })
                  }
                >
                  Confirm and create the tables
                </button>
              </>
            )}
          </>
        )}

        {enums.length > 0 && (
          <div className="enumbox">
            <h4>Columns that look like enums</h4>
            {enums.map((e) => (
              <div className="enumrow" key={e.column}>
                <span className="cn">{e.column}</span>
                <span className="enumvals">{e.values.join(' · ')}</span>
                <span className="epevidence">{e.evidence}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="shapebox">
        <h3>3 · Versions</h3>
        <p>
          A version is a copy at a point in time. Versioning, non-destructive editing and backup
          are one mechanism here, not three features.
        </p>

        <button
          className="btn"
          data-save-version
          disabled={busy}
          onClick={() =>
            void run('Save version', async () => {
              const version = await api.saveVersion(dataset.id, `v${versions.length + 1}`);
              return `Saved ${version.label}.`;
            })
          }
        >
          Save a version
        </button>

        {versions.map((version) => (
          <div className="versionrow" key={version.id}>
            <span className="vlabel">{version.label}</span>
            <span className="vtime">{version.createdAt.slice(0, 19).replace('T', ' ')}</span>
            {versions.length > 1 && version.id !== versions[0]?.id && (
              <button
                className="btn"
                onClick={() =>
                  void run('Diff', async () => {
                    setDiff(await api.diffVersions(versions[0]!.id, version.id));
                    return null;
                  })
                }
              >
                Diff against {versions[0]?.label}
              </button>
            )}
          </div>
        ))}

        {diff !== null && (
          <div className="diffbox">
            <div className="diffline">
              tables added: {diff.tablesAdded.join(', ') || '—'} · removed:{' '}
              {diff.tablesRemoved.join(', ') || '—'}
            </div>
            {diff.rowCountChanges
              .filter((c) => c.before !== c.after)
              .map((c) => (
                <div className="diffline" key={c.table}>
                  {c.table}: {c.before} → {c.after} rows
                </div>
              ))}
            {diff.columnChanges.map((c) => (
              <div className="diffline" key={c.table}>
                {c.table}: +{c.added.join(', ') || '—'} / −{c.removed.join(', ') || '—'}
              </div>
            ))}
            {diff.rowCountChanges.every((c) => c.before === c.after) &&
              diff.columnChanges.length === 0 &&
              diff.tablesAdded.length === 0 && <div className="diffline">No differences.</div>}
          </div>
        )}
      </section>

      <section className="shapebox">
        <h3>4 · Take it elsewhere</h3>
        <p>
          Everything leaves in open formats — data as Parquet or CSV, plus the schema, the
          dictionary and the dataset definition as plain JSON, and a <span className="mono">schema.sql</span>.
          <b> Delete Datera and what you exported still works.</b>
        </p>
        <div className="pickrow">
          {(['parquet', 'csv'] as const).map((format) => (
            <button
              key={format}
              className="btn"
              disabled={busy}
              onClick={() =>
                void run('Export', async () => {
                  const directory = await api.pickDirectory();
                  if (directory === null) return null;
                  const result = await api.exportDataset(dataset.id, directory, { format });
                  return `Exported ${result.files.length} file(s) to ${directory}.`;
                })
              }
            >
              Export as {format}
            </button>
          ))}
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              void run('Import', async () => {
                const directory = await api.pickDirectory();
                if (directory === null) return null;
                const result = await api.importDataset(directory);
                return `Imported ${result.tables.length} table(s).`;
              })
            }
          >
            Import an export
          </button>
        </div>
      </section>
    </div>
  );
}
