import { useCallback, useEffect, useMemo, useState } from 'react';
import { placeholdersIn, type AuthoredOperation, type Dataset, type OperationParameter } from '@datera/core';
import type { DateraApi } from '../shared/contract.js';

/**
 * Authoring named operations (spec §8).
 *
 * The generated tools let an agent run any SQL or none. An operation is the middle
 * ground a workspace actually wants to express: *this* is a thing you may do here, these
 * are its arguments, and this is what it means.
 *
 * Two decisions worth stating. The parameter list is **derived from the statement** — you
 * write `$product` and the row appears — because a hand-maintained list that disagrees
 * with the SQL is the failure the core refuses at authoring time anyway, and making the
 * user discover that by error message would be rude.
 *
 * And a write operation is labelled as proposing rather than applying, everywhere it is
 * shown. That is not a caveat, it is what the operation does: §6's gate is reached
 * through this door like any other.
 */
export function Operations({
  api,
  datasets,
  datasetId,
}: {
  readonly api: DateraApi;
  readonly datasets: readonly Dataset[];
  readonly datasetId: string;
}): JSX.Element {
  const [operations, setOperations] = useState<readonly AuthoredOperation[]>([]);
  const [target, setTarget] = useState(datasetId);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sql, setSql] = useState('');
  const [types, setTypes] = useState<Record<string, OperationParameter['type']>>({});
  const [optional, setOptional] = useState<Record<string, boolean>>({});
  const [hints, setHints] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setOperations(await api.listOperations());
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Derived from the statement, so the two can never disagree.
  const parameters = useMemo<readonly OperationParameter[]>(
    () =>
      placeholdersIn(sql).map((parameter) => ({
        name: parameter,
        type: types[parameter] ?? 'string',
        required: optional[parameter] !== true,
        description: hints[parameter] ?? '',
      })),
    [sql, types, optional, hints],
  );

  const create = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await api.createOperation({
        datasetId: target, name: name.trim(), description: description.trim(), sql: sql.trim(), parameters,
      });
      setNote(
        created.kind === 'write'
          ? `Created "${created.name}". It is a write, so calling it proposes a change rather than applying one.`
          : `Created "${created.name}". Agents can call it now.`,
      );
      setName('');
      setDescription('');
      setSql('');
      await refresh();
    } catch (e) {
      setError((e as { message?: string }).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }, [api, target, name, description, sql, parameters, refresh]);

  return (
    <div className="operations">
      {note !== null && <div className="softflag">{note}</div>}
      {error !== null && <div className="err" role="alert">{error}</div>}

      <p className="tierdesc">
        <b>Things you decide an agent may do, beyond running arbitrary SQL.</b> A named,
        typed statement this workspace offers — served as its own MCP tool and as{' '}
        <span className="mono">POST /api/operations</span>. Write <span className="mono">$name</span>{' '}
        in the SQL and it becomes an argument.
      </p>

      <section className="shapebox">
        <h3>Existing operations</h3>
        {operations.length === 0 ? (
          <div className="emptyrail">None yet. Agents can still query and search; an operation
            narrows that to something specific you are willing to offer.</div>
        ) : (
          operations.map((operation) => (
            <div className="opcard" key={operation.id} data-operation={operation.name}>
              <div className="ophead">
                <span className="opn">{operation.name}</span>
                <span className={`opk ${operation.kind}`}>{operation.kind}</span>
                <span className="opds">
                  {datasets.find((d) => d.id === operation.datasetId)?.name ?? operation.datasetId}
                </span>
                <button
                  className="linkbtn"
                  data-delete-operation={operation.name}
                  onClick={() => void api.deleteOperation(operation.id).then(refresh)}
                >
                  remove
                </button>
              </div>
              <div className="opdesc">{operation.description}</div>
              <pre className="sqlblock">{operation.sql}</pre>
              <div className="opargs">
                {operation.parameters.length === 0 ? (
                  <span className="targ">no arguments</span>
                ) : (
                  operation.parameters.map((p) => (
                    <span className="targ" key={p.name}>
                      {p.name}
                      <i>{p.type}</i>
                      {p.required && <b>required</b>}
                    </span>
                  ))
                )}
              </div>
              {operation.kind === 'write' && (
                <div className="softflag">
                  Calling this <b>proposes</b> a change with its exact row count. Nothing is
                  applied until a person confirms it.
                </div>
              )}
              {operation.parameters.length === 0 && (
                <button
                  className="btn"
                  data-try={operation.name}
                  onClick={() =>
                    void api
                      .callOperation(operation.datasetId, operation.name)
                      .then((r) => setTried(JSON.stringify(r.rows ?? r.proposal, null, 2)))
                      .catch((e: { message?: string }) => setTried(e.message ?? String(e)))
                  }
                >
                  Try it
                </button>
              )}
            </div>
          ))
        )}
        {tried !== null && <pre className="payload" data-tried>{tried}</pre>}
      </section>

      <section className="shapebox">
        <h3>Define one</h3>

        <div className="pickrow">
          <span className="lb">Dataset</span>
          <select value={target} data-operation-dataset onChange={(e) => setTarget(e.target.value)}>
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>

        <div className="pickrow">
          <span className="lb">Name</span>
          <input
            value={name}
            data-operation-name
            placeholder="revenue_for_product"
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="pickrow">
          <span className="lb">Description</span>
          <input
            value={description}
            data-operation-description
            placeholder="Total revenue for one product."
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <textarea
          value={sql}
          spellCheck={false}
          data-operation-sql
          placeholder={'SELECT sum(revenue_cents) AS revenue\nFROM orders\nWHERE product = $product'}
          onChange={(e) => setSql(e.target.value)}
        />

        {parameters.length > 0 && (
          <div className="paramlist">
            <div className="sughead">
              Arguments, taken from the statement. Their descriptions are what an agent reads
              to decide what to pass.
            </div>
            {parameters.map((parameter) => (
              <div className="paramrow" key={parameter.name}>
                <span className="mono">${parameter.name}</span>
                <select
                  value={parameter.type}
                  data-param-type={parameter.name}
                  onChange={(e) =>
                    setTypes((prev) => ({
                      ...prev,
                      [parameter.name]: e.target.value as OperationParameter['type'],
                    }))
                  }
                >
                  {(['string', 'number', 'boolean', 'date'] as const).map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                <input
                  value={parameter.description}
                  placeholder="what this means"
                  onChange={(e) =>
                    setHints((prev) => ({ ...prev, [parameter.name]: e.target.value }))
                  }
                />
                <label className="capture">
                  <input
                    type="checkbox"
                    checked={!parameter.required}
                    onChange={(e) =>
                      setOptional((prev) => ({ ...prev, [parameter.name]: e.target.checked }))
                    }
                  />
                  optional
                </label>
              </div>
            ))}
          </div>
        )}

        <button
          className="btn p"
          data-create-operation
          disabled={busy || name.trim().length === 0 || sql.trim().length === 0}
          onClick={() => void create()}
        >
          {busy ? 'Checking…' : 'Create operation'}
        </button>

        <p className="frsub">
          Datera checks the statement before saving it: that it parses, stays inside its
          dataset, is exactly one statement, and that its arguments match what it uses. Whether
          it reads or writes is measured from the statement, not taken from the name.
        </p>
      </section>
    </div>
  );
}
