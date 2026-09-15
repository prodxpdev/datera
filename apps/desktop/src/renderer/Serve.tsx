import { useCallback, useEffect, useState } from 'react';
import type { ApiEndpoint, ClientId, ConnectConfig, RetentionPolicy, ToolDefinition, TraceRecord } from '@datera/core';
import type { DateraApi } from '../shared/contract.js';

/**
 * Serve — the tools, the connect configs, and the traffic-flow log (spec §8, §8a).
 *
 * The log viewer is deliberately a *list over the same trace* the Ask drawer already
 * shows: one record is the glass box, many records are a searchable table over them. §8a
 * is explicit that this must not become its own pillar, so there is no second UI language
 * here and no second query stack behind it.
 */
type Tab = 'tools' | 'connect' | 'api' | 'log';

export function Serve({ api }: { readonly api: DateraApi }): JSX.Element {
  const [tab, setTab] = useState<Tab>('tools');
  const [tools, setTools] = useState<readonly ToolDefinition[]>([]);
  const [endpoints, setEndpoints] = useState<readonly ApiEndpoint[]>([]);
  const [client, setClient] = useState<ClientId>('claude-desktop');
  const [config, setConfig] = useState<ConnectConfig | null>(null);
  const [records, setRecords] = useState<readonly TraceRecord[]>([]);
  const [retention, setRetention] = useState<RetentionPolicy | null>(null);
  const [capture, setCapture] = useState(false);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [minMs, setMinMs] = useState(0);
  const [selected, setSelected] = useState<TraceRecord | null>(null);

  const refresh = useCallback(async () => {
    setTools(await api.listTools());
    setEndpoints(await api.apiEndpoints());
    setConfig(await api.connectConfig(client));
    setRetention(await api.getTraceRetention());
    setCapture(await api.getTracePayloadCapture());
    setRecords(await api.queryTraceLog({ onlyErrors, minTotalMs: minMs, limit: 200 }));
  }, [api, client, onlyErrors, minMs]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="serve">
      <div className="subnav">
        {(['tools', 'connect', 'api', 'log'] as const).map((t) => (
          <button key={t} data-serve={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t === 'tools' ? 'Tools' : t === 'connect' ? 'Connect' : t === 'api' ? 'API' : 'Traffic log'}
          </button>
        ))}
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

      {tab === 'connect' && config !== null && (
        <>
          <p className="tierdesc">
            Point an agent at this workspace. <b>stdio</b> launches Datera itself — no port, no
            token, nothing listening. That is the better default for one person on one machine.
          </p>
          <div className="subnav">
            {(['claude-desktop', 'claude-code', 'cursor'] as const).map((c) => (
              <button key={c} data-client={c} className={client === c ? 'on' : ''} onClick={() => setClient(c)}>
                {c}
              </button>
            ))}
          </div>
          <pre className="cfg">{config.content}</pre>
          <div className="readonly">● {config.instructions}</div>
        </>
      )}

      {tab === 'api' && (
        <>
          <p className="tierdesc">
            The HTTP surface, served by <span className="mono">datera --http &lt;port&gt;</span>. This
            page is generated from the same definition the server routes from, so it cannot drift
            away from what actually runs — a test fails if an endpoint is served but undocumented,
            or documented but not served.
          </p>

          {endpoints.map((endpoint) => (
            <div className="apicard" key={`${endpoint.method}-${endpoint.path}`}>
              <div className="apihead">
                <span className={`verb ${endpoint.method.toLowerCase()}`}>{endpoint.method}</span>
                <span className="apipath">{endpoint.path}</span>
                {endpoint.requiresAuth ? (
                  <span className="authbadge">token</span>
                ) : (
                  <span className="authbadge open">no auth</span>
                )}
                {endpoint.requiresFlag !== undefined && (
                  <span className="flagbadge">needs {endpoint.requiresFlag}</span>
                )}
              </div>
              <div className="apisummary">{endpoint.summary}</div>
              <div className="apidesc">{endpoint.description}</div>

              {endpoint.body.length > 0 && (
                <table className="apiargs">
                  <tbody>
                    {endpoint.body.map((p) => (
                      <tr key={p.name}>
                        <td className="an">{p.name}</td>
                        <td className="at">{p.type}</td>
                        <td className="ar">{p.required ? 'required' : 'optional'}</td>
                        <td>{p.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <div className="apireturns">returns <code>{endpoint.returns}</code></div>
              <pre className="cfg">{endpoint.example}</pre>
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
            <button className="btn" onClick={() => void api.pruneTraceLog().then(refresh)}>Prune now</button>
          </div>

          <div className="logpolicy">
            {retention !== null && (
              <>
                Keeping the last <b>{retention.maxRecords.toLocaleString()}</b> requests, up to{' '}
                <b>{retention.maxAgeDays}</b> days. Never unbounded.
              </>
            )}
            <label className="capture">
              <input
                type="checkbox"
                checked={capture}
                onChange={(e) => void api.setTracePayloadCapture(e.target.checked).then(refresh)}
              />
              capture full payloads
            </label>
          </div>

          {/* The privacy decision, stated where it is made rather than in a settings page
              nobody opens. Off by default is the whole point. */}
          <div className={capture ? 'caveat' : 'softflag'}>
            {capture ? (
              <>
                <b>Payload capture is ON.</b> Prompts are being stored, and on the semantic path
                those contain real text from your data. Turn this off when you have finished
                debugging.
              </>
            ) : (
              <>
                Records hold shape and metadata only — timings, tokens, cost, the SQL. No rows, no
                arguments, no retrieved text. The log is not a second copy of your data.
              </>
            )}
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
