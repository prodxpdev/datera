import { useCallback, useEffect, useState } from 'react';
import type { ColumnDefinition, SourceDictionary, SourceWithStatus } from '@datera/core';
import type { DateraApi } from '../shared/contract.js';

/**
 * The Dictionary view (spec §4).
 *
 * The interaction is the invariant: Datera proposes, and nothing takes effect until a
 * human confirms it (§1.3). So drafting fills the form but changes nothing, and each row
 * shows its own state.
 *
 * What §1.3 does *not* require is that ratification happen one row at a time. It used to,
 * and worse: reloading after each confirm cleared the draft, so accepting twelve columns
 * meant drafting twelve times. The draft now survives a confirm, and "Confirm all" accepts
 * the batch a human has just read — reviewing a set and saying yes to it is ratification;
 * re-deriving the set after every click was only a bug.
 */
export function Dictionary({
  api,
  sources,
}: {
  readonly api: DateraApi;
  readonly sources: readonly SourceWithStatus[];
}): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(sources[0]?.id ?? null);
  const [dictionary, setDictionary] = useState<SourceDictionary | null>(null);
  const [draft, setDraft] = useState<SourceDictionary | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Re-read what is stored. Deliberately leaves the draft alone: confirming one row must
   * not discard the proposals for the others.
   */
  const load = useCallback(async () => {
    if (selectedId === null) return;
    setDictionary(await api.getDictionary(selectedId));
  }, [api, selectedId]);

  // Switching sources *does* drop the draft — it belongs to the source it was drafted from.
  useEffect(() => {
    setDraft(null);
  }, [selectedId]);

  useEffect(() => {
    void load();
  }, [load]);

  const autoDraft = useCallback(async () => {
    if (selectedId === null) return;
    setBusy(true);
    try {
      setDraft(await api.draftDictionary(selectedId));
    } finally {
      setBusy(false);
    }
  }, [api, selectedId]);

  const confirm = useCallback(
    async (definition: ColumnDefinition) => {
      if (selectedId === null) return;
      await api.confirmColumn(selectedId, { ...definition, state: 'confirmed' });
      await load();
    },
    [api, selectedId, load],
  );

  const confirmAll = useCallback(
    async (definitions: readonly ColumnDefinition[]) => {
      if (selectedId === null) return;
      setBusy(true);
      try {
        await api.confirmColumns(
          selectedId,
          definitions.map((d) => ({ ...d, state: 'confirmed' as const })),
        );
        await load();
      } finally {
        setBusy(false);
      }
    },
    [api, selectedId, load],
  );

  const hide = useCallback(
    async (definition: ColumnDefinition) => {
      if (selectedId === null) return;
      const next = definition.sensitivity === 'hidden' ? 'normal' : 'hidden';
      await api.confirmColumn(selectedId, { ...definition, sensitivity: next, state: 'confirmed' });
      await load();
    },
    [api, selectedId, load],
  );

  if (sources.length === 0) {
    return <div className="empty">Connect a source first — the dictionary describes its columns.</div>;
  }
  if (dictionary === null) return <div className="empty">Loading…</div>;

  // The draft, where one exists, supplies proposed values for rows still undefined.
  const proposals = new Map((draft?.columns ?? []).map((c) => [c.column, c]));
  const rows = dictionary.columns.map((stored) => {
    const proposed = proposals.get(stored.column);
    return stored.state === 'undefined' && proposed !== undefined ? proposed : stored;
  });

  const entity = draft !== null && dictionary.entity.state === 'undefined' ? draft.entity : dictionary.entity;

  // Rows that have something to accept: a meaning, and no confirmation yet.
  const pending = rows.filter((r) => r.state !== 'confirmed' && r.meaning.length > 0);

  return (
    <>
      <div className="dcpick">
        {sources.map((s) => (
          <button
            key={s.id}
            className={`dcsrc ${s.id === selectedId ? 'on' : ''}`}
            data-dictsrc={s.id}
            onClick={() => setSelectedId(s.id)}
          >
            {s.name}
          </button>
        ))}
        <button className="btn" style={{ marginLeft: 'auto' }} data-autodraft onClick={() => void autoDraft()} disabled={busy}>
          {busy ? 'Drafting…' : '✦ Auto-draft meanings'}
        </button>
      </div>

      {pending.length > 0 && (
        <div className="softflag">
          {draft !== null && (
            <>Drafted from column names, types and the values actually present. </>
          )}
          <b>Nothing is saved yet</b> — {pending.length} column{pending.length === 1 ? '' : 's'} awaiting
          your agreement. Read them, then confirm the ones you agree with, or accept the batch.
          <button
            className="btn p"
            style={{ marginLeft: 12 }}
            data-confirm-all
            disabled={busy}
            onClick={() => void confirmAll(pending)}
          >
            Confirm all {pending.length}
          </button>
        </div>
      )}

      <div className="entcard">
        <div>
          <div className="entn">
            {dictionary.sourceName} <span className={`mst ${stateClass(entity.state)}`}>{entity.state}</span>
          </div>
          <div className="entd">{entity.meaning.length > 0 ? entity.meaning : 'Not defined yet — auto-draft to get started.'}</div>
        </div>
        <div className="entmeta">
          <span>grain: <b>{entity.grain.length > 0 ? entity.grain : '—'}</b></span>
          <span>key: <b>{entity.primaryKey.length > 0 ? entity.primaryKey : '—'}</b></span>
          {entity.state !== 'confirmed' && entity.meaning.length > 0 && (
            <button
              className="btn"
              onClick={() => void api.confirmEntity(selectedId!, { ...entity, state: 'confirmed' }).then(load)}
            >
              Confirm
            </button>
          )}
        </div>
      </div>

      <div className="dicttbl">
        <table>
          <thead>
            <tr>
              <th>Column</th>
              <th>Meaning</th>
              <th>Also called</th>
              <th>Unit</th>
              <th>Role</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.column} className={row.sensitivity === 'hidden' ? 'hiddenrow' : undefined}>
                <td className="cn">{row.column}</td>
                <td>
                  {row.meaning.length > 0 ? row.meaning : <span className="ph">— no meaning yet —</span>}
                  {(row.enumValues ?? []).length > 0 && (
                    <div className="enums">
                      {(row.enumValues ?? []).map((e) => (
                        <span className="enum" key={e.value}>
                          <b>{e.value}</b> {e.meaning}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td>
                  {row.aliases.length > 0
                    ? row.aliases.map((a) => <span className="alias" key={a}>{a}</span>)
                    : <span className="ph">—</span>}
                </td>
                <td className="mono2">{row.unit.length > 0 ? row.unit : '—'}</td>
                <td>{row.role}</td>
                <td>
                  <span className={`mst ${stateClass(row.state)}`}>{row.state}</span>
                </td>
                <td className="rowacts">
                  {row.state !== 'confirmed' && row.meaning.length > 0 && (
                    <button className="btn" data-confirm-row onClick={() => void confirm(row)}>Confirm</button>
                  )}
                  <button
                    className="btn"
                    title="Hide this column from the model entirely — not even its name is sent"
                    onClick={() => void hide(row)}
                  >
                    {row.sensitivity === 'hidden' ? 'Unhide' : 'Hide from NL'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="dcpay">
        <b>Why this matters.</b> Confirmed definitions are injected into the model&rsquo;s context for
        NL→SQL. Because <span className="mono">revenue_cents</span> is defined as money in minor units
        and <i>also called</i> &ldquo;sales&rdquo;, the question <i>&ldquo;what were my sales?&rdquo;</i>{' '}
        becomes <span className="mono">SUM(revenue_cents)/100</span> rather than a number a hundred times
        too large that looks entirely plausible. You can watch the injection happen in{' '}
        <b>Ask → How it was made</b>. Only <i>confirmed</i> rows are sent — a suggestion is not a fact.
      </div>
    </>
  );
}

function stateClass(state: string): string {
  if (state === 'confirmed') return 'ok';
  if (state === 'suggested') return 'sg';
  return 'un';
}
