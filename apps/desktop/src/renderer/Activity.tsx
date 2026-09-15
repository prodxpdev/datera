import { useCallback, useEffect, useState } from 'react';
import type { ToolDefinition, TraceRecord } from '@datera/core';
import type { DateraApi } from '../shared/contract.js';

/**
 * Activity — what agents can call, and every request that ran (spec §8, §8a).
 *
 * This stayed in the sidebar when Models, Environments and the connect configs moved into
 * Settings, and the distinction is the point: a request log is something you consult
 * while working, not something you configure. Burying evidence three clicks deep would
 * quietly weaken the only claim that makes the rest of the product checkable.
 *
 * The log is a list over the same trace the answer drawer shows — one record is the glass
 * box, many records are a table over them. No second UI language, no second query stack.
 */
type Tab = 'log' | 'tools';

export function Activity({ api }: { readonly api: DateraApi }): JSX.Element {
  const [tab, setTab] = useState<Tab>('log');
  const [tools, setTools] = useState<readonly ToolDefinition[]>([]);
  const [records, setRecords] = useState<readonly TraceRecord[]>([]);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [minMs, setMinMs] = useState(0);
  const [selected, setSelected] = useState<TraceRecord | null>(null);

  const refresh = useCallback(async () => {
    setTools(await api.listTools());
    setRecords(await api.queryTraceLog({ onlyErrors, minTotalMs: minMs, limit: 200 }));
  }, [api, onlyErrors, minMs]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="serve">
      <div className="subnav">
        <button data-serve="log" className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>
          Traffic log
        </button>
        <button data-serve="tools" className={tab === 'tools' ? 'on' : ''} onClick={() => setTab('tools')}>
          Tools ({tools.length})
        </button>
      </div>

      {tab === 'tools' && (
        <>
          <p className="tierdesc">
            Generated from the datasets that exist right now. A search tool appears only where
            something is embedded, and a write tool only where a grant exists — Datera does not
            advertise a tool that would fail when called.
          </p>
          {tools.map((tool) => (
            <div className="toolcard" key={tool.name}>
              <div className="toolname">{tool.name}</div>
              <div className="tooldesc">{tool.description}</div>
              <div className="toolargs">
                {Object.entries(tool.inputSchema.properties).map(([name, schema]) => (
                  <span className="targ" key={name}>
                    {name}
                    <i>{schema.type}</i>
                    {tool.inputSchema.required.includes(name) && <b>required</b>}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </>
      )}

      {tab === 'log' && (
        <>
          <div className="logbar">
            <label>
              <input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} />
              errors only
            </label>
            <label>
              slower than
              <input
                type="number"
                value={minMs}
                min={0}
                step={100}
                onChange={(e) => setMinMs(Number(e.target.value))}
              />
              ms
            </label>
            <button className="btn" onClick={() => void refresh()}>Refresh</button>
            <span className="logpolicyhint">Retention and payload capture live in Settings → Privacy.</span>
          </div>

          <div className="logtable">
            <table>
              <thead>
                <tr>
                  <th>when</th><th>origin</th><th>route</th><th>question</th>
                  <th>model</th><th>ms</th><th>rows</th><th>cost</th><th />
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id} className={r.ok ? undefined : 'failed'} onClick={() => setSelected(r)}>
                    <td>{r.at.slice(11, 19)}</td>
                    <td>{r.origin}</td>
                    <td>{r.route}</td>
                    <td className="q">{r.question}</td>
                    <td>{r.modelName ?? '—'}</td>
                    <td>{Math.round(r.totalMs)}</td>
                    <td>{r.rowsReturned}</td>
                    <td>{r.costUsd === 0 ? '$0' : `$${r.costUsd.toFixed(4)}`}</td>
                    <td>{r.ok ? '' : '⚠'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {records.length === 0 && <div className="emptyrail">No requests recorded yet.</div>}
          </div>

          {selected !== null && (
            <>
              <div className="scrim show" onClick={() => setSelected(null)} />
              <div className="drawer show">
                <div className="dh">
                  <div className="t">{selected.question}</div>
                  <button className="x" data-close onClick={() => setSelected(null)}>×</button>
                </div>
                <div className="db">
                  <dl className="kv">
                    <dt>when</dt><dd>{selected.at}</dd>
                    <dt>origin</dt><dd>{selected.origin}</dd>
                    <dt>dataset</dt><dd>{selected.datasetId}</dd>
                    <dt>route</dt><dd>{selected.route}</dd>
                    <dt>model</dt><dd>{selected.modelName ?? '—'}</dd>
                    <dt>latency</dt><dd>{Math.round(selected.totalMs)}ms</dd>
                    <dt>tokens</dt><dd>{selected.inputTokens} in / {selected.outputTokens} out</dd>
                    <dt>cost</dt><dd>{selected.costUsd === 0 ? '$0' : `$${selected.costUsd.toFixed(4)}`}</dd>
                    <dt>rows</dt><dd>{selected.rowsReturned}</dd>
                  </dl>
                  {selected.sql !== null && <pre className="sqlblock">{selected.sql}</pre>}
                  {selected.error !== null && <div className="flag">{selected.error}</div>}
                  {selected.payload !== null && (
                    <>
                      <div className="payloadlabel">Captured payload:</div>
                      <pre className="payload">{selected.payload}</pre>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
