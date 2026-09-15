import { useCallback, useEffect, useState } from 'react';
import type { Dataset, EnvironmentStatus } from '@datera/core';
import type { DateraApi } from '../shared/contract.js';

/**
 * Environments — Local, and deployed Datera Servers (spec §10, §12.10).
 *
 * Entirely client-side. Nothing here issues a token, evaluates a scope, or deploys
 * anything: those belong to the private `datera-server` repo, and this view only ever
 * talks to a server's public API.
 */
export function Environments({
  api,
  datasets,
}: {
  readonly api: DateraApi;
  readonly datasets: readonly Dataset[];
}): JSX.Element {
  const [statuses, setStatuses] = useState<readonly EnvironmentStatus[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ id: '', name: '', url: '', token: '' });
  const [pushFrom, setPushFrom] = useState(datasets[0]?.id ?? '');
  const [pushTo, setPushTo] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const next = await api.environmentStatuses();
    setStatuses(next);
    setPushTo((current) => current || next.find((s) => s.kind === 'remote')?.id || '');
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = useCallback(async () => {
    if (form.id.length === 0 || form.url.length === 0) return;
    setBusy(true);
    try {
      await api.addEnvironment({
        id: form.id,
        name: form.name.length > 0 ? form.name : form.id,
        url: form.url,
        ...(form.token.length > 0 ? { token: form.token } : {}),
      });
      // Cleared immediately: a token has no reason to sit in component state once it has
      // reached the keychain.
      setForm({ id: '', name: '', url: '', token: '' });
      setAdding(false);
      await refresh();
    } catch (e) {
      setNote((e as { message?: string }).message ?? 'Could not add that environment.');
    } finally {
      setBusy(false);
    }
  }, [api, form, refresh]);

  const push = useCallback(async () => {
    if (pushFrom.length === 0 || pushTo.length === 0) return;
    setBusy(true);
    setNote(null);
    try {
      await api.pushDataset(pushFrom, pushTo);
      setNote(`Pushed to ${pushTo}.`);
    } catch (e) {
      setNote((e as { message?: string }).message ?? 'Push failed.');
    } finally {
      setBusy(false);
    }
  }, [api, pushFrom, pushTo]);

  return (
    <div className="envs">
      <p className="tierdesc">
        Datera is your local environment and works entirely on its own. When you want others to
        reach your data&rsquo;s API and MCP, push a dataset to a <b>Datera Server</b> you run.
        Same engine, deployed to infrastructure you control.
      </p>

      {note !== null && <div className="softflag">{note}</div>}

      <div className="envgrid">
        {statuses.map((environment) => (
          <div className={`envcard ${environment.kind}`} key={environment.id}>
            <div className="eh">
              <div className="en">
                {environment.kind === 'local' ? '💻' : '☁'} {environment.name}
              </div>
              <span className={`kind ${environment.kind}`}>{environment.kind}</span>
            </div>
            <div className="st">
              <span className={`dot ${environment.reachable ? 'run' : 'off'}`} />
              {environment.reachable ? 'reachable' : (environment.reason ?? 'not reachable')}
            </div>
            <div className="rowk">
              <span>URL</span>
              <span className="v">{environment.url ?? 'this machine'}</span>
            </div>
            {environment.kind === 'remote' && (
              <button className="btn" onClick={() => void api.removeEnvironment(environment.id).then(refresh)}>
                Forget
              </button>
            )}
          </div>
        ))}
      </div>

      {adding ? (
        <div className="pushbox">
          <h3>Add a Datera Server</h3>
          <div className="pushrow">
            <span className="lb">Id</span>
            <input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="test" />
            <span className="lb">Name</span>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Test" />
          </div>
          <div className="pushrow">
            <span className="lb">URL</span>
            <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://datera-test.example" />
            <span className="lb">Token</span>
            <input type="password" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} placeholder="dtra_…" />
          </div>
          <div className="pushrow">
            <button className="btn p" onClick={() => void add()} disabled={busy}>Add</button>
            <button className="btn" onClick={() => setAdding(false)}>Cancel</button>
            <span className="embedstat">The token goes to the OS keychain, never to a config file.</span>
          </div>
        </div>
      ) : (
        <button className="btn" onClick={() => setAdding(true)}>+ Add a Datera Server</button>
      )}

      <div className="pushbox">
        <h3>Push a dataset</h3>
        <p>
          Promote a dataset from here to a deployed environment — like shipping from dev to test.
          Push reuses the same export as &ldquo;take my data elsewhere&rdquo;, so it cannot be
          lossy in a way an export is not.
        </p>
        <div className="pushrow">
          <span className="lb">Dataset</span>
          <select value={pushFrom} onChange={(e) => setPushFrom(e.target.value)}>
            {datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <span className="lb">To</span>
          <select value={pushTo} onChange={(e) => setPushTo(e.target.value)}>
            {statuses.filter((s) => s.kind === 'remote').map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <button className="btn p" onClick={() => void push()} disabled={busy || pushTo.length === 0}>
            ⇧ Push
          </button>
        </div>
        {statuses.every((s) => s.kind === 'local') && (
          <div className="emptyrail">
            No server configured yet. Run <span className="mono">datera --http 7391 --workspace …
            --allow-push</span> somewhere, then add it above.
          </div>
        )}
      </div>
    </div>
  );
}
