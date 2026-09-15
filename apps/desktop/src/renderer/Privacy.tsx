import { useCallback, useEffect, useState } from 'react';
import type { Dataset, RetentionPolicy } from '@datera/core';
import type { DateraApi } from '../shared/contract.js';

/**
 * What gets recorded, and what may be changed (spec §8a, §6).
 *
 * Two settings that look unrelated and are not: both answer "what can this program do
 * without asking me again". Payload capture decides whether the log becomes a second copy
 * of your data; a write grant decides whether a dataset can be modified at all.
 *
 * Both are shown with their current state spelled out rather than as a bare toggle — a
 * checkbox tells you its position, not its consequence.
 */
export function Privacy({
  api,
  datasets,
  onChanged,
}: {
  readonly api: DateraApi;
  readonly datasets: readonly Dataset[];
  readonly onChanged: () => void;
}): JSX.Element {
  const [retention, setRetention] = useState<RetentionPolicy | null>(null);
  const [capture, setCapture] = useState(false);
  const [grants, setGrants] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setRetention(await api.getTraceRetention());
    setCapture(await api.getTracePayloadCapture());
    const next = new Map<string, boolean>();
    for (const dataset of datasets) {
      next.set(dataset.id, await api.canWrite(dataset.id));
    }
    setGrants(next);
  }, [api, datasets]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleGrant = useCallback(
    async (dataset: Dataset) => {
      setBusy(true);
      try {
        if (grants.get(dataset.id) === true) await api.revokeWrite(dataset.id);
        else await api.grantWrite(dataset.id);
        await refresh();
        onChanged();
      } catch {
        // The engine refuses a grant on a connected dataset by design; the row below
        // already explains why, so there is nothing useful to add here.
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [api, grants, refresh, onChanged],
  );

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
        <h3>Write grants</h3>
        <p>
          Off by default, per dataset, revocable. A dataset that reads your files directly can
          never be granted writes at all — that is invariant §1.2, not a setting.
        </p>

        {datasets.map((dataset) => (
          <div className="grantrow" key={dataset.id}>
            <span className="gn">{dataset.name}</span>
            <span className="gk">{dataset.kind}</span>
            {dataset.kind === 'connected' ? (
              <span className="gstate off">reads sources — writes impossible</span>
            ) : (
              <>
                <span className={`gstate ${grants.get(dataset.id) === true ? 'on' : 'off'}`}>
                  {grants.get(dataset.id) === true ? 'writes enabled' : 'read-only'}
                </span>
                <button
                  className="btn"
                  data-toggle-grant={dataset.id}
                  disabled={busy}
                  onClick={() => void toggleGrant(dataset)}
                >
                  {grants.get(dataset.id) === true ? 'Revoke' : 'Grant'}
                </button>
              </>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
