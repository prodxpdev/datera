import { useCallback, useEffect, useState } from 'react';
import type { Dataset, RetentionPolicy } from '@datera/core';
import type { DateraApi, StorageItem } from '../shared/contract.js';

/** Bytes, at the precision a person reading a storage panel actually wants. */
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * What gets recorded, and what may be changed (spec §8a, §6).
 *
 * Retention and payload capture live here: they are set once and revisited rarely, which
 * is what Settings is for. Write grants do not — they moved to Data, beside the datasets
 * they apply to. What remains of them here is a read-only summary, because "what can
 * currently change my data" is a privacy question even when the switch is elsewhere.
 *
 * Each setting is shown with its consequence spelled out rather than as a bare toggle: a
 * checkbox tells you its position, not what it means.
 */
export function Privacy({
  api,
  datasets,
}: {
  readonly api: DateraApi;
  readonly datasets: readonly Dataset[];
}): JSX.Element {
  const [retention, setRetention] = useState<RetentionPolicy | null>(null);
  const [capture, setCapture] = useState(false);
  const [granted, setGranted] = useState<readonly string[]>([]);
  const [storage, setStorage] = useState<readonly StorageItem[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removed, setRemoved] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRetention(await api.getTraceRetention());
    setCapture(await api.getTracePayloadCapture());
    const writable: string[] = [];
    for (const dataset of datasets) {
      if (await api.canWrite(dataset.id)) writable.push(dataset.name);
    }
    setGranted(writable);
    setStorage(await api.storageUsage());
  }, [api, datasets]);

  /**
   * Remove one thing, having asked first.
   *
   * Every one of these is irreversible, and one of them is irreversible in the way that
   * matters — so the confirmation names what is about to go rather than asking "are you
   * sure?", which is a question nobody reads.
   */
  const remove = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        const { remaining } = await api.removeStorage(id);
        // Files the app has open cannot be deleted while it runs — normal on Windows, and
        // true of Chromium's caches everywhere. Saying so beats reporting a clean removal
        // that the size column then contradicts.
        setRemoved(
          remaining > 0
            ? 'Removed what could be removed. Some files are still in use and will go when ' +
              'Datera next starts.'
            : 'Removed.',
        );
      } finally {
        setBusy(false);
        setConfirming(null);
        await refresh();
      }
    },
    [api, refresh],
  );

  const removeEverything = useCallback(async () => {
    setBusy(true);
    try {
      let leftover = 0;
      for (const item of storage) leftover += (await api.removeStorage(item.id)).remaining;
      await api.resetSettings();
      const instruction = await api.removalInstruction();
      setRemoved(
        leftover > 0
          ? `${instruction} A few files are still in use and will go when Datera closes.`
          : instruction,
      );
    } finally {
      setBusy(false);
      setConfirming(null);
      await refresh();
    }
  }, [api, refresh, storage]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="privacy">
      <section className="shapebox">
        <h3>The request log</h3>
        {retention !== null && (
          <p>
            Keeping the last <b>{retention.maxRecords.toLocaleString()}</b> requests, up to{' '}
            <b>{retention.maxAgeDays}</b> days. Never unbounded — the log is a rolling window, not
            an archive.
          </p>
        )}

        <label className="capture">
          <input
            type="checkbox"
            data-capture
            checked={capture}
            onChange={(e) => void api.setTracePayloadCapture(e.target.checked).then(refresh)}
          />
          capture full payloads
        </label>

        <div className={capture ? 'caveat' : 'softflag'}>
          {capture ? (
            <>
              <b>Payload capture is ON.</b> Prompts are being stored, and on the semantic path those
              contain real text from your data. Turn this off when you have finished debugging.
            </>
          ) : (
            <>
              Records hold shape and metadata only — timings, tokens, cost, the SQL. No rows, no
              arguments, no retrieved text. The log is not a second copy of your data.
            </>
          )}
        </div>

        <button className="btn" onClick={() => void api.pruneTraceLog().then(refresh)}>
          Prune the log now
        </button>
      </section>

      <section className="shapebox">
        <h3>What may change your data</h3>
        <p>
          Write grants live in <b>Data → Write access</b>, beside the datasets they apply to and
          the change log they produce. A permission belongs where its effect is visible; listing
          it here as well would make three places to look and two of them stale.
        </p>
        {granted.length === 0 ? (
          <div className="softflag">
            Nothing in this workspace can be changed right now — every dataset is read-only.
          </div>
        ) : (
          <div className="caveat">
            <b>{granted.length} dataset(s) can be changed:</b> {granted.join(', ')}. Changes are
            still previewed and confirmed one at a time.
          </div>
        )}
      </section>

      <section data-storage-panel>
        <h3>What Datera has stored on this machine</h3>
        <p>
          Every one of these is on your disk and nowhere else. Removing the application does
          not remove them — no operating system does that for you, which is why it is here.
        </p>

        <table className="storagetable">
          <tbody>
            {storage.map((item) => (
              <tr key={item.id} data-storage-item={item.id}>
                <td className="sname">
                  {item.label}
                  <div className="tierdesc">{item.description}</div>
                </td>
                <td className="ssize" data-storage-size={item.id}>{size(item.bytes)}</td>
                <td className="sact">
                  {confirming === item.id ? (
                    <>
                      <button
                        className="danger"
                        data-storage-confirm={item.id}
                        disabled={busy}
                        onClick={() => void remove(item.id)}
                      >
                        {item.destroysData ? 'Yes, delete my work' : 'Yes, remove'}
                      </button>
                      <button className="linkbtn" onClick={() => setConfirming(null)}>cancel</button>
                    </>
                  ) : (
                    <button
                      className="btn"
                      data-storage-remove={item.id}
                      disabled={busy || item.bytes === 0}
                      onClick={() => setConfirming(item.id)}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {removed !== null && <div className="readonly" data-storage-done>● {removed}</div>}

        <h3>Start over, or leave</h3>
        <p>
          <b>Reset settings</b> puts every preference back to its default — the model you chose,
          how long requests are kept, whether Datera serves agents — and leaves your datasets
          exactly where they are.
        </p>
        <button className="btn" data-reset-settings disabled={busy} onClick={() => void (async () => {
          setBusy(true);
          try {
            await api.resetSettings();
            setRemoved('Settings are back to their defaults. Your data was not touched.');
          } finally {
            setBusy(false);
            await refresh();
          }
        })()}>
          Reset settings to default
        </button>

        <div className="caveat">
          <b>Remove everything</b> deletes all of the above, including your datasets and
          everything you have taught Datera about them. It cannot be undone, and there is one
          step afterwards that Datera cannot do for itself — it will tell you what it is.
          {' '}
          <b>Export anything you want to keep first</b> (Data → Export): your data leaves in
          Parquet or CSV with its schema and dictionary beside it.
        </div>

        {confirming === 'everything' ? (
          <>
            <button className="danger" data-remove-all-confirm disabled={busy} onClick={() => void removeEverything()}>
              Yes, remove everything
            </button>
            <button className="linkbtn" onClick={() => setConfirming(null)}>cancel</button>
          </>
        ) : (
          <button className="danger" data-remove-all disabled={busy} onClick={() => setConfirming('everything')}>
            Remove everything Datera has stored
          </button>
        )}
      </section>
    </div>
  );
}
