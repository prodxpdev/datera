import { useCallback, useEffect, useState } from 'react';
import type { Dataset, RetentionPolicy } from '@datera/core';
import type { DateraApi } from '../shared/contract.js';

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

  const refresh = useCallback(async () => {
    setRetention(await api.getTraceRetention());
    setCapture(await api.getTracePayloadCapture());
    const writable: string[] = [];
    for (const dataset of datasets) {
      if (await api.canWrite(dataset.id)) writable.push(dataset.name);
    }
    setGranted(writable);
  }, [api, datasets]);

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
    </div>
  );
}
