import { useEffect, useState } from 'react';
import type { Lifecycle } from '@datera/core';
import type { DateraApi } from '../shared/contract.js';

/**
 * Learn — the data-lifecycle view (spec §5, §11.9).
 *
 * A value is followed from the table to the screen, and each boundary shows both the
 * transform and the classic bug that happens there. The bugs are the lesson; without them
 * this is a diagram rather than a teaching tool.
 */
export function Learn({ api }: { readonly api: DateraApi }): JSX.Element {
  const [lifecycle, setLifecycle] = useState<Lifecycle | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.getLifecycle().then(setLifecycle);
  }, [api]);

  if (lifecycle === null) return <div className="empty">Loading…</div>;

  return (
    <div className="learn">
      <p className="tierdesc">
        A value isn&rsquo;t just a table cell — it transforms at every layer, and now flows
        through the NL, semantic and MCP lanes too. Following <b>{lifecycle.label}</b> from the
        row to the screen:
      </p>

      {lifecycle.layers.map((layer, i) => (
        <div key={`${layer.name}-${i}`}>
          <div className="layer">
            <div className="lh">
              <span className="ln">{layer.name}</span>
              <span className="lk">{layer.key}</span>
            </div>
            <div className="rp">{layer.representation}</div>
          </div>

          {i < lifecycle.transforms.length && (
            <div className="tf2">
              <span className="ar">↓</span> {lifecycle.transforms[i]?.description}
              {lifecycle.transforms[i]?.bug !== null && (
                <span className="bug">⚠ {lifecycle.transforms[i]?.bug}</span>
              )}
            </div>
          )}
        </div>
      ))}

      <h3 className="lanesh">The other lanes</h3>
      {lifecycle.lanes.map((lane) => (
        <div className="lane" key={lane.name}>
          <div className="lanename">{lane.name}</div>
          <div className="lanenote">{lane.note}</div>
        </div>
      ))}

      <div className="readonly">
        ● Curated for v1 — an instructor defines this, and Datera does not read your application
        code. Live tracing of real source is a later phase.
      </div>

      <div className="editrow">
        {editing ? (
          <>
            <textarea
              className="lifeedit"
              value={draft}
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
            />
            {error !== null && <div className="err">{error}</div>}
            <div className="pushrow">
              <button
                className="btn p"
                onClick={() => {
                  setError(null);
                  try {
                    const parsed = JSON.parse(draft) as Lifecycle;
                    void api
                      .setLifecycle(parsed)
                      .then(() => api.getLifecycle())
                      .then((next) => {
                        setLifecycle(next);
                        setEditing(false);
                      })
                      .catch((e: { message?: string }) => setError(e.message ?? 'Invalid lifecycle.'));
                  } catch {
                    setError('That is not valid JSON.');
                  }
                }}
              >
                Save
              </button>
              <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
              <button
                className="btn"
                onClick={() => void api.resetLifecycle().then(() => api.getLifecycle()).then((n) => {
                  setLifecycle(n);
                  setEditing(false);
                })}
              >
                Reset to default
              </button>
            </div>
          </>
        ) : (
          <button
            className="btn"
            onClick={() => {
              setDraft(JSON.stringify(lifecycle, null, 2));
              setEditing(true);
            }}
          >
            ✎ Author this lifecycle
          </button>
        )}
      </div>
    </div>
  );
}
