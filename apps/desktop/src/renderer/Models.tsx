import { useCallback, useEffect, useState } from 'react';
import type { ModelCatalogue, ModelDescriptor } from '@datera/core';
import type { DateraApi } from '../shared/contract.js';

/**
 * Model selection — spec §9's three tiers.
 *
 * Two things here are requirements rather than copy:
 *
 *  - **The quality caveat is stated once, where the choice is made.** Small local models
 *    write weaker SQL. Hiding that would make the local default feel broken rather than
 *    understood, and it is exactly why the dictionary and the visible-SQL gate matter
 *    more on those tiers, not less.
 *  - **A runtime that is not running is not listed.** Offering a model that will fail the
 *    moment it is used moves the error to the worst possible place.
 */
const REMOTE_PROVIDERS: readonly { id: string; label: string; hint: string }[] = [
  { id: 'anthropic', label: 'Anthropic', hint: 'sk-ant-…' },
  { id: 'openai', label: 'OpenAI', hint: 'sk-…' },
];

export function Models({
  api,
  datasetId,
}: {
  readonly api: DateraApi;
  readonly datasetId: string;
}): JSX.Element {
  const [catalogue, setCatalogue] = useState<ModelCatalogue | null>(null);
  const [keys, setKeys] = useState<Record<string, boolean>>({});
  const [entry, setEntry] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [embedded, setEmbedded] = useState<{ chunks: number; columns: readonly string[] } | null>(null);
  const [embedding, setEmbedding] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const next = await api.listModels();
      setCatalogue(next);
      const present: Record<string, boolean> = {};
      for (const provider of REMOTE_PROVIDERS) {
        present[provider.id] = await api.hasApiKey(provider.id);
      }
      setKeys(present);
      setEmbedded(await api.embeddingStatus(datasetId));
    } finally {
      setBusy(false);
    }
  }, [api, datasetId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const choose = useCallback(
    async (model: ModelDescriptor) => {
      await api.setChatModel(model);
      setNote(`Chat model set to ${model.id}.`);
      await refresh();
    },
    [api, refresh],
  );

  const saveKey = useCallback(
    async (provider: string) => {
      const value = entry[provider] ?? '';
      if (value.length === 0) return;
      await api.setApiKey(provider, value);
      // Cleared from component state the moment it is stored: there is no reason for a
      // key to sit in a React state tree after it has reached the keychain.
      setEntry((prev) => ({ ...prev, [provider]: '' }));
      setNote(`${provider} key saved to the OS keychain.`);
      await refresh();
    },
    [api, entry, refresh],
  );

  if (catalogue === null) return <div className="empty">Looking for models…</div>;

  const selectedId = catalogue.selected?.id ?? null;

  return (
    <div className="models">
      {note !== null && <div className="softflag">{note}</div>}

      <div className="tiernote">
        Chat and embedding models are chosen separately. Embeddings stay on this machine even
        when chat is remote.
      </div>

      <section className="tier">
        <h3>1 · Bundled local</h3>
        <p className="tierdesc">
          No key, no account, nothing uploaded. Weights are fetched once on first run.
        </p>
        <div className="opt off">
          <span className="radio" />
          <div>
            <div className="ot">Bundled model</div>
            <div className="od">Not available in this build — see the Phase 2 notes in the README.</div>
          </div>
          <span className="tg free">no key</span>
        </div>
      </section>

      <section className="tier">
        <h3>2 · Local runtimes on this machine</h3>
        <p className="tierdesc">
          Detected by probing the usual ports. Nothing is listed unless it is running right now.
        </p>

        {catalogue.detected.length === 0 ? (
          <div className="emptyrail">
            No local runtime detected. Start Ollama (<span className="mono">ollama serve</span>) or LM
            Studio and refresh.
          </div>
        ) : (
          catalogue.detected.map((runtime) =>
            runtime.models.map((model) => (
              <div
                key={`${runtime.provider}-${model.id}`}
                className={`opt ${selectedId === model.id ? 'on' : ''}`}
                onClick={() => void choose(model)}
              >
                <span className="radio" />
                <div>
                  <div className="ot">{model.id}</div>
                  <div className="od">
                    {runtime.provider} · {runtime.baseUrl.replace(/^https?:\/\//, '')}
                  </div>
                </div>
                <span className="tg free">local</span>
              </div>
            )),
          )
        )}

        <button className="btn" onClick={() => void refresh()} disabled={busy}>
          {busy ? 'Looking…' : 'Refresh'}
        </button>
      </section>

      <section className="tier">
        <h3>3 · Your own API key</h3>
        <p className="tierdesc">
          Stronger SQL on messy schemas. Keys go to the OS keychain — never to a config file, never
          to a log, never into a trace.
        </p>

        {REMOTE_PROVIDERS.map((provider) => (
          <div className="keyrow" key={provider.id}>
            <span className="klabel">{provider.label}</span>
            {keys[provider.id] === true ? (
              <>
                <span className="kset">key stored</span>
                <button className="btn" onClick={() => void api.clearApiKey(provider.id).then(refresh)}>
                  Forget
                </button>
              </>
            ) : (
              <>
                <input
                  type="password"
                  placeholder={provider.hint}
                  value={entry[provider.id] ?? ''}
                  onChange={(e) => setEntry((prev) => ({ ...prev, [provider.id]: e.target.value }))}
                />
                <button className="btn" onClick={() => void saveKey(provider.id)}>
                  Save
                </button>
              </>
            )}
          </div>
        ))}

        {catalogue.remote.map((model) => (
          <div
            key={model.id}
            className={`opt ${selectedId === model.id ? 'on' : ''}`}
            onClick={() => void choose(model)}
          >
            <span className="radio" />
            <div>
              <div className="ot">{model.id}</div>
              <div className="od">{model.provider} · your key</div>
            </div>
            <span className="tg key">BYOK</span>
          </div>
        ))}
      </section>

      <section className="tier">
        <h3>Embeddings — chosen separately</h3>
        <p className="tierdesc">
          The semantic path embeds your <b>text</b>, where the SQL path only ever sends the schema.
          That difference is why this is a separate choice and never follows the chat model.
        </p>

        {catalogue.embeddingCandidates.length === 0 ? (
          <div className="emptyrail">
            No local embedding model detected. With Ollama:{' '}
            <span className="mono">ollama pull nomic-embed-text</span>
          </div>
        ) : (
          catalogue.embeddingCandidates.map((model) => (
            <div
              key={`embed-${model.id}`}
              className={`opt ${catalogue.selectedEmbedding?.id === model.id ? 'on' : ''}`}
              onClick={() => void api.setEmbeddingModel(model).then(refresh)}
            >
              <span className="radio" />
              <div>
                <div className="ot">{model.id}</div>
                <div className="od">{model.provider} · embeddings</div>
              </div>
              <span className="tg free">local</span>
            </div>
          ))
        )}

        {catalogue.selectedEmbedding !== null && (
          <div className="embedrow">
            <button
              className="btn p"
              data-buildembed
              disabled={embedding}
              onClick={() => {
                setEmbedding(true);
                void api
                  .buildEmbeddings(datasetId)
                  .then((r) => setNote(`Embedded ${r.chunksEmbedded} new chunk(s); reused ${r.chunksReused}.`))
                  .catch((e: { message?: string }) => setNote(e.message ?? 'Embedding failed.'))
                  .finally(() => {
                    setEmbedding(false);
                    void refresh();
                  });
              }}
            >
              {embedding ? 'Embedding…' : 'Build embeddings for this dataset'}
            </button>
            <span className="embedstat">
              {embedded === null || embedded.chunks === 0
                ? 'nothing embedded yet'
                : `${embedded.chunks} chunks across ${embedded.columns.join(', ')}`}
            </span>
          </div>
        )}
      </section>

      <div className="caveat">
        <b>A note on local models.</b> Smaller local models write weaker SQL than frontier models —
        they misread vague questions and occasionally invent a column. That is not a reason to avoid
        them; it is why Datera always shows you the SQL before running it, and why a good dictionary
        (coming in Phase 3) matters more on this tier, not less.
      </div>

      {catalogue.selectedName !== null && (
        <div className="readonly">● Current chat model: {catalogue.selectedName}</div>
      )}
    </div>
  );
}
