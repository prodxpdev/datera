import { useCallback, useState } from 'react';
import type { Dataset, SchemaProposal } from '@datera/core';
import type { DateraApi } from '../shared/contract.js';

/**
 * Author from intent — the second entry path (spec §3a).
 *
 * §3a says data enters Datera two ways and both are first-class: connect a source you
 * have, or declare the shape you have in mind. Phase 1 built the seam and nothing above
 * it, so for a long time the path existed and could not be reached.
 *
 * The paste is what makes this useful rather than a form with an Add Column button.
 * "Ask an assistant for a schema for X" and drop the result here — SQL DDL or JSON, since
 * those are what assistants produce.
 *
 * It proposes rather than creates. §1.3's propose-then-confirm applies to structure as
 * much as to meaning, and a schema someone pasted without reading deserves a look before
 * it becomes real. It is *not* the §6 write gate: declaring that a customers table exists
 * is a different act from changing 1,203 rows in one, and §3a warns that conflating them
 * leaves that gate guarding schema edits instead of writes.
 */
const EXAMPLE = `CREATE TABLE customers (
  id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  region VARCHAR
);

CREATE TABLE orders (
  order_id VARCHAR PRIMARY KEY,
  customer_id VARCHAR REFERENCES customers(id),
  total_cents BIGINT,
  ordered_at DATE
);`;

export function Author({
  api,
  datasets,
  datasetId,
  onCreated,
}: {
  readonly api: DateraApi;
  readonly datasets: readonly Dataset[];
  readonly datasetId: string;
  readonly onCreated: () => void;
}): JSX.Element {
  const [text, setText] = useState('');
  const [target, setTarget] = useState(datasetId);
  const [proposal, setProposal] = useState<SchemaProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const read = useCallback(async () => {
    setBusy(true);
    setError(null);
    setProposal(null);
    try {
      setProposal(await api.proposeSchema(text));
    } catch (e) {
      // The database's own parser error, verbatim: it names the position and the problem,
      // which nothing written here could improve on.
      setError((e as { message?: string }).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }, [api, text]);

  const apply = useCallback(async () => {
    if (proposal === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.applySchema(target, proposal);
      setNote(
        `Created ${result.tables.join(', ')}${
          result.relationships > 0 ? ` and ${result.relationships} relationship(s)` : ''
        }. They are queryable now — empty, but real.`,
      );
      setProposal(null);
      setText('');
      onCreated();
    } catch (e) {
      setError((e as { message?: string }).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }, [api, target, proposal, onCreated]);

  return (
    <div className="author">
      {note !== null && <div className="softflag">{note}</div>}
      {error !== null && <div className="err" role="alert">{error}</div>}

      <p className="tierdesc">
        No data yet? Describe the shape instead. Paste <b>SQL DDL</b> or <b>JSON</b> — including
        whatever an assistant gives you when you ask for a schema — and Datera turns it into the
        same tables, types and relationships a connected file would have produced. Nothing is
        created until you say so.
      </p>

      <div className="pickrow">
        <span className="lb">Create in</span>
        <select value={target} data-author-dataset onChange={(e) => setTarget(e.target.value)}>
          {datasets.filter((d) => d.kind !== 'system').map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
        <button className="linkbtn" data-author-example onClick={() => setText(EXAMPLE)}>
          use an example
        </button>
      </div>

      <textarea
        value={text}
        spellCheck={false}
        data-author-sql
        placeholder={'CREATE TABLE customers (\n  id VARCHAR PRIMARY KEY,\n  name VARCHAR NOT NULL\n);\n\nor {"tables":[{"name":"customers","columns":[…]}]}'}
        onChange={(e) => setText(e.target.value)}
      />

      <div className="pickrow">
        <button
          className="btn p"
          data-author-read
          disabled={busy || text.trim().length === 0}
          onClick={() => void read()}
        >
          {busy ? 'Reading…' : 'Read it'}
        </button>
        <span className="frnote">
          Read by DuckDB itself, not by pattern-matching — so the types and errors are the real
          ones. Only table definitions are accepted.
        </span>
      </div>

      {proposal !== null && (
        <div className="proposalbox" data-schema-proposal>
          <div className="softflag">
            <b>Nothing has been created.</b> Read {proposal.source === 'sql' ? 'as SQL' : 'as JSON'}:{' '}
            {proposal.tables.length} table(s)
            {proposal.relationships.length > 0 && `, ${proposal.relationships.length} relationship(s)`}.
          </div>

          {proposal.tables.map((table) => (
            <div className="entityproposal" key={table.name}>
              <div className="epname">{table.name}</div>
              <table className="changetable">
                <thead>
                  <tr><th>column</th><th>type</th><th>null</th><th>key</th></tr>
                </thead>
                <tbody>
                  {table.columns.map((column) => (
                    <tr key={column.name}>
                      <td className="cn">{column.name}</td>
                      <td>{column.type}</td>
                      <td>{column.nullable === false ? 'required' : 'optional'}</td>
                      <td>{column.primaryKey === true ? 'primary' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          {proposal.relationships.map((link) => (
            <div className="epevidence" key={`${link.fromTable}.${link.fromColumn}`}>
              {link.fromTable}.{link.fromColumn} → {link.toTable}.{link.toColumn}
            </div>
          ))}

          <div className="pickrow">
            <button className="btn p" data-author-apply disabled={busy} onClick={() => void apply()}>
              Create {proposal.tables.length} table{proposal.tables.length === 1 ? '' : 's'}
            </button>
            <button className="btn" disabled={busy} onClick={() => setProposal(null)}>
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
