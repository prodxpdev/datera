import { useCallback, useEffect, useState } from 'react';
import type { AppliedWrite, Dataset, WriteProposal } from '@datera/core';
import type { DateraApi } from '../shared/contract.js';

/**
 * Edit — the write gate (spec §6, acceptance §12.7).
 *
 * §6 calls the confirm-preview gate "the safety mechanism and the teaching moment", and a
 * gate nobody can see teaches nothing. So this view is built around making the *pause*
 * visible: a proposal appears with its exact row count, its old → new values and its
 * warnings, and stays inert until someone presses confirm.
 *
 * The instruction box accepts either SQL or plain language deliberately. The footgun §6
 * describes — an agent turning a fuzzy instruction into a DELETE — is best taught by
 * letting someone try it and watching the gate catch it.
 */
export function Edit({
  api,
  datasets,
  onChanged,
}: {
  readonly api: DateraApi;
  readonly datasets: readonly Dataset[];
  readonly onChanged: () => void;
}): JSX.Element {
  const writable = datasets.filter((d) => d.kind !== 'connected');
  const [datasetId, setDatasetId] = useState(writable[0]?.id ?? datasets[0]?.id ?? '');
  const [granted, setGranted] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [proposal, setProposal] = useState<WriteProposal | null>(null);
  const [log, setLog] = useState<readonly AppliedWrite[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const dataset = datasets.find((d) => d.id === datasetId);

  const refresh = useCallback(async () => {
    if (dataset === undefined) return;
    setGranted(await api.canWrite(dataset.id));
    setLog(await api.listWrites(dataset.id));
  }, [api, dataset]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (label: string, work: () => Promise<string | null>): Promise<void> => {
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
    <div className="edit">
      {note !== null && <div className="softflag">{note}</div>}
      {error !== null && <div className="err">{error}</div>}

      <div className="pickrow">
        <span className="lb">Dataset</span>
        <select value={datasetId} onChange={(e) => setDatasetId(e.target.value)} data-edit-dataset>
          {datasets.map((d) => (
            <option key={d.id} value={d.id}>{d.name} ({d.kind})</option>
          ))}
        </select>
      </div>

      {dataset?.kind === 'connected' ? (
        <div className="caveat">
          <b>&ldquo;{dataset.name}&rdquo; reads your files directly.</b> Datera never writes to a
          source, so writes cannot be enabled here at all. Derive a working copy in <b>Shape</b>
          first — changes land there, and your originals stay exactly as they are.
        </div>
      ) : (
        <section className="shapebox">
          <h3>Write grant</h3>
          <p>
            Off by default, per dataset, revocable. A grant is a decision, so it survives a
            restart — and revoking it takes effect immediately, including on a proposal that is
            already waiting.
          </p>
          <div className="pickrow">
            <span className={granted ? 'kset' : 'koff'}>
              {granted ? 'writes enabled' : 'writes not enabled'}
            </span>
            {granted ? (
              <button className="btn" disabled={busy} onClick={() => void run('Revoke', async () => {
                await api.revokeWrite(datasetId);
                setProposal(null);
                return 'Writes disabled.';
              })}>
                Revoke
              </button>
            ) : (
              <button className="btn p" data-grant disabled={busy} onClick={() => void run('Grant', async () => {
                await api.grantWrite(datasetId);
                return 'Writes enabled for this dataset.';
              })}>
                Enable writes
              </button>
            )}
          </div>
        </section>
      )}

      {granted && (
        <section className="shapebox">
          <h3>Propose a change</h3>
          <p>
            Write SQL, or describe the change in plain language and let the model write it. Either
            way it is <b>proposed, not applied</b> — you see exactly what it would do first.
          </p>

          <textarea
            value={instruction}
            spellCheck={false}
            placeholder={"UPDATE orders SET product = 'Renamed' WHERE order_id = 'A-1042'\nor: mark the refunded orders as archived"}
            onChange={(e) => setInstruction(e.target.value)}
          />

          <div className="pickrow">
            <button
              className="btn p"
              data-propose
              disabled={busy || instruction.trim().length === 0}
              onClick={() =>
                void run('Propose', async () => {
                  const isSql = /^\s*(update|delete|insert)\b/i.test(instruction);
                  setProposal(
                    isSql
                      ? await api.proposeWrite(datasetId, instruction)
                      : await api.proposeWriteFromQuestion(datasetId, instruction),
                  );
                  return null;
                })
              }
            >
              {busy ? 'Working…' : 'Preview the change'}
            </button>
          </div>
        </section>
      )}

      {proposal !== null && (
        <div className="writepreview">
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
              disabled={busy}
              onClick={() =>
                void run('Apply', async () => {
                  const applied = await api.confirmWrite(proposal.id);
                  setProposal(null);
                  return `Applied — ${applied.rowsChanged} row(s) changed. You can undo this below.`;
                })
              }
            >
              Confirm and apply
            </button>
            <button className="btn" disabled={busy} onClick={() => setProposal(null)}>
              Discard
            </button>
          </div>
        </div>
      )}

      <section className="shapebox">
        <h3>What has been changed</h3>
        <p>Every applied write, with an undo. This is the audit log the trace records too.</p>

        <div className="writelog">
          {log.length === 0 ? (
            <div className="emptyrail">Nothing has been changed in this dataset.</div>
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
