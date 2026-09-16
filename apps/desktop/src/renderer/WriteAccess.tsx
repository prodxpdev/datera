import { useCallback, useEffect, useState } from 'react';
import type { AppliedWrite, Dataset } from '@datera/core';
import type { DateraApi } from '../shared/contract.js';

/**
 * Write enablement and change history, beside the data (spec §6, §1.2).
 *
 * Enabling writes is a property of a dataset, and so is the record of what has changed
 * it. Both used to live in a nav item of their own, which put three steps of one flow in
 * three places: derive a working copy here, enable writes there, see what changed
 * somewhere else. They are one story and belong in one place.
 *
 * What did *not* move is the gate. Proposing and confirming a change is writing a
 * statement, so it happens in the editor with every other statement — see Query.
 */
export function WriteAccess({
  api,
  datasets,
  onChanged,
  onSwitchTo,
}: {
  readonly api: DateraApi;
  readonly datasets: readonly Dataset[];
  readonly onChanged: () => void;
  /** Point the app at the dataset writes actually landed on — silently moving would be worse. */
  readonly onSwitchTo: (datasetId: string) => void;
}): JSX.Element {
  const [grants, setGrants] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [log, setLog] = useState<readonly AppliedWrite[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const next = new Map<string, boolean>();
    const entries: AppliedWrite[] = [];
    for (const dataset of datasets) {
      next.set(dataset.id, await api.canWrite(dataset.id));
      entries.push(...(await api.listWrites(dataset.id)));
    }
    setGrants(next);
    setLog(entries.sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt)));
  }, [api, datasets]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (label: string, work: () => Promise<string | null>) => {
      setBusy(true);
      setError(null);
      try {
        const message = await work();
        if (message !== null) setNote(message);
        await refresh();
        onChanged();
      } catch (e) {
        setError(`${label}: ${(e as { message?: string }).message ?? String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [refresh, onChanged],
  );

  return (
    <div className="writeaccess">
      {note !== null && <div className="softflag">{note}</div>}
      {error !== null && <div className="err">{error}</div>}

      <section className="shapebox">
        <h3>Which datasets may be changed</h3>
        <p>
          <b>Off by default, per dataset, revocable.</b> A grant is a decision, so it survives a
          restart — and revoking it takes effect immediately, including on a change already
          waiting to be confirmed.
        </p>
        <p>
          Datera never writes to a file you connected. Enabling writes on a connected dataset
          therefore makes a <b>working copy</b> and enables writes on that — you do not have to
          make one yourself. Your originals stay exactly as they are, byte for byte.
        </p>

        {datasets.map((dataset) => (
          <div className="grantrow" key={dataset.id}>
            <span className="gn">{dataset.name}</span>
            <span className="gk">{dataset.kind}</span>

            {dataset.kind === 'connected' ? (
              <>
                <span className="gstate off">reads your sources — never written to</span>
                {/* Copy-on-write is the mechanism, not the user's errand. Asking for
                    writes here makes the working copy and grants on that. */}
                <button
                  className="btn"
                  data-grant={dataset.id}
                  disabled={busy}
                  onClick={() => void run('Enable writes', async () => {
                    const { datasetId, derived } = await api.enableWrites(dataset.id);
                    onSwitchTo(datasetId);
                    return derived
                      ? `Made a working copy of ${dataset.name} and enabled writes on it. ${dataset.name} itself is untouched, and so are the files behind it.`
                      : `Enabled writes on the existing working copy of ${dataset.name}.`;
                  })}
                >
                  Enable writes
                </button>
              </>
            ) : (
              <>
                <span className={`gstate ${grants.get(dataset.id) === true ? 'on' : 'off'}`}>
                  {grants.get(dataset.id) === true ? 'writes enabled' : 'read-only'}
                </span>
                {grants.get(dataset.id) === true ? (
                  <button
                    className="btn"
                    data-revoke={dataset.id}
                    disabled={busy}
                    onClick={() => void run('Revoke', async () => {
                      await api.revokeWrite(dataset.id);
                      return `Writes disabled for ${dataset.name}.`;
                    })}
                  >
                    Revoke
                  </button>
                ) : (
                  <button
                    className="btn p"
                    data-grant={dataset.id}
                    disabled={busy}
                    onClick={() => void run('Grant', async () => {
                      await api.enableWrites(dataset.id);
                      onSwitchTo(dataset.id);
                      return `Writes enabled for ${dataset.name}. Changes still need confirming.`;
                    })}
                  >
                    Enable writes
                  </button>
                )}
              </>
            )}
          </div>
        ))}
      </section>

      <section className="shapebox">
        <h3>What has been changed</h3>
        <p>Every applied write, with an undo. This is the same record the trace shows.</p>

        <div className="writelog">
          {log.length === 0 ? (
            <div className="emptyrail">Nothing has been changed in this workspace.</div>
          ) : (
            log.map((entry) => (
              <div className={`logrow ${entry.undoneAt === null ? '' : 'undone'}`} key={entry.id}>
                <div className="lsql">{entry.sql}</div>
                <div className="lmeta">
                  {entry.rowsChanged} row(s) · {entry.confirmedAt.slice(0, 19).replace('T', ' ')}
                  {entry.undoneAt !== null && <span className="undonetag">undone</span>}
                </div>
                {entry.undoneAt === null && (
                  <button
                    className="btn"
                    data-undo
                    disabled={busy}
                    onClick={() => void run('Undo', async () => {
                      await api.undoWrite(entry.id);
                      return 'Reverted.';
                    })}
                  >
                    Undo
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
