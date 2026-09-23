import { useCallback, useEffect, useState } from 'react';
import type { ApiEndpoint, ClientId, ConnectConfig } from '@datera/core';
import type { DateraApi, ServingStatus } from '../shared/contract.js';

/**
 * How an agent connects, and what it can call (spec §8).
 *
 * Lifted out of the Serve view: choosing a transport and copying a config is setup, and
 * belongs beside the other setup. What stays in Activity is the part you consult while
 * working — the tools that exist and the requests that ran.
 */
export function Connect({ api }: { readonly api: DateraApi }): JSX.Element {
  const [client, setClient] = useState<ClientId>('claude-desktop');
  const [config, setConfig] = useState<ConnectConfig | null>(null);
  const [endpoints, setEndpoints] = useState<readonly ApiEndpoint[]>([]);
  const [showApi, setShowApi] = useState(false);
  const [serving, setServing] = useState<ServingStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const status = await api.servingStatus();
    setServing(status);

    // The config has to describe what is actually running. While the app is serving, an
    // agent connects over HTTP to this process; the stdio config would tell it to launch
    // a second one, which DuckDB refuses because this app holds the workspace.
    setConfig(
      await api.connectConfig(
        client,
        status.running && status.url !== undefined
          ? { url: status.url, ...(status.token === undefined ? {} : { token: status.token }) }
          : {},
      ),
    );
    setEndpoints(await api.apiEndpoints());
  }, [api, client]);

  const act = useCallback(
    async (fn: () => Promise<ServingStatus>) => {
      setBusy(true);
      try {
        await fn();
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [refresh],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="serve">
      <div className="servetoggle">
        <div>
          <b>Serve this workspace</b>
          <div className="tierdesc">
            {serving?.running === true
              ? 'An agent can reach this workspace while Datera is open. Every request it makes shows up in Activity.'
              : 'Off. Datera is not listening, so an agent can only reach this workspace by launching its own copy — which it cannot do while this app is open, because the database allows one writer at a time.'}
          </div>
        </div>
        <button
          className="primary"
          data-serving-toggle
          disabled={busy || serving === null}
          onClick={() =>
            void act(() => (serving?.running === true ? api.stopServing() : api.startServing()))
          }
        >
          {serving?.running === true ? 'Stop serving' : 'Start serving'}
        </button>
      </div>

      {serving?.error !== undefined && (
        <div className="warn" data-serving-error>
          ● Could not serve: {serving.error}
        </div>
      )}

      {serving?.running === true ? (
        <p className="tierdesc" data-serving-on>
          Listening on <span className="mono">{serving.url}</span> — loopback only, so nothing
          beyond this machine can reach it, and a token is required. Keep the token secret; it
          grants exactly the access this config names.{' '}
          <button className="linkbtn" disabled={busy} onClick={() => void act(() => api.rotateServingToken())}>
            rotate the token
          </button>
        </p>
      ) : (
        <p className="tierdesc">
          <b>stdio</b> launches Datera itself — no port, no token, nothing listening. That is the
          better default for one person on one machine, and it needs this app closed.
        </p>
      )}

      <div className="subnav">
        {(['claude-desktop', 'claude-code', 'cursor'] as const).map((c) => (
          <button key={c} data-client={c} className={client === c ? 'on' : ''} onClick={() => setClient(c)}>
            {c}
          </button>
        ))}
      </div>

      {config !== null && (
        <>
          <pre className="cfg">{config.content}</pre>
          <div className="readonly">● {config.instructions}</div>
        </>
      )}

      <button className="linkbtn" data-toggle-api onClick={() => setShowApi(!showApi)}>
        {showApi ? '− hide' : '+ show'} the HTTP API reference ({endpoints.length} endpoints)
      </button>

      {showApi && (
        <>
          <p className="tierdesc">
            Served by <span className="mono">datera --http &lt;port&gt;</span>. Generated from the
            same definition the server routes from, so it cannot drift — a test fails if an
            endpoint is served but undocumented, or documented but not served.
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
    </div>
  );
}
