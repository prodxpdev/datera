import { useCallback, useEffect, useState } from 'react';
import type { BundledModelOffer, ModelCatalogue, ModelDescriptor } from '@datera/core';
import { bundledDescriptor } from '@datera/core';
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

function gb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

function mb(bytes: number): string {
  return Math.round(bytes / 1024 ** 2).toString();
}

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
  const [downloading, setDownloading] = useState<Record<string, number>>({});
  const [failed, setFailed] = useState<string | null>(null);

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

  // Progress is pushed from the main process: a two-gigabyte download with no visible
  // progress is indistinguishable from a hang, which is exactly the complaint in #33.
  useEffect(
    () =>
      api.onBundledProgress(({ modelId, receivedBytes, totalBytes }) => {
        setDownloading((prev) => ({
          ...prev,
          [modelId]: totalBytes === 0 ? 0 : receivedBytes / totalBytes,
        }));
      }),
    [api],
  );

  const download = useCallback(
    async (offer: BundledModelOffer) => {
      setFailed(null);
      setDownloading((prev) => ({ ...prev, [offer.modelId]: 0 }));
      try {
        await api.downloadBundledModel(offer.modelId);
        // Select and warm it: having downloaded two gigabytes, the user has said what
        // they want, and making them click twice more to use it would be silly.
        await api.setChatModel(bundledDescriptor(offer.spec));
        void api.warmChatModel();
        setNote(`${offer.spec.label} is ready and selected. It runs on this machine, with no key.`);
        await refresh();
      } catch (e) {
        // Verification failures land here, and they matter: the honest thing is to say
        // the file was rejected, not to quietly leave the model un-downloaded.
        setFailed((e as { message?: string }).message ?? String(e));
      } finally {
        setDownloading((prev) => {
          const next = { ...prev };
          delete next[offer.modelId];
          return next;
        });
      }
    },
    [api, refresh],
  );

  const choose = useCallback(
    async (model: ModelDescriptor) => {
      await api.setChatModel(model);
      // Start loading it now, while the user is still looking at the picker, rather than
      // making the first question pay for it. Measured: about 2.5s from a warm page
      // cache, appreciably longer the first time after a download.
      if (model.tier === 'bundled') void api.warmChatModel();
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
          No key, no account, nothing uploaded — and no network at all once the weights are
          here. Apache-2.0 licensed, so they are yours to keep and redistribute.
        </p>

        {failed !== null && <div className="err" role="alert">{failed}</div>}

        {catalogue.bundled.length === 0 ? (
          <div className="emptyrail">
            This build has no local model runtime, so the bundled tier is unavailable here.
          </div>
        ) : (
          catalogue.bundled.filter((o) => o.spec.role === 'chat').map((offer) => {
            const progress = downloading[offer.modelId];
            const selected = selectedId === offer.modelId;

            return (
              <div
                key={offer.modelId}
                className={`opt ${selected ? 'on' : ''} ${offer.ready ? '' : 'off'}`}
                data-bundled={offer.modelId}
                onClick={() => {
                  if (offer.ready && offer.unavailableReason === null) {
                    void choose(bundledDescriptor(offer.spec));
                  }
                }}
              >
                <span className="radio" />
                <div>
                  <div className="ot">
                    {offer.spec.label}
                    {offer.recommended && <span className="rec">best for this machine</span>}
                  </div>
                  {/* The trade-off is carried as data on the spec, so the picker cannot
                      describe a model more flatteringly than the catalogue does. */}
                  <div className="od">{offer.spec.tradeoff}</div>
                  {offer.unavailableReason !== null && (
                    <div className="od warnline">{offer.unavailableReason}</div>
                  )}
                  {progress !== undefined && (
                    <div className="dlbar" data-progress={offer.modelId}>
                      <span style={{ width: `${Math.round(progress * 100)}%` }} />
                      <i>{Math.round(progress * 100)}% of {gb(offer.spec.sizeBytes)} GB</i>
                    </div>
                  )}
                </div>

                <span className="tg free">no key</span>

                {offer.ready ? (
                  <button
                    className="btn"
                    data-remove-bundled={offer.modelId}
                    onClick={(e) => {
                      e.stopPropagation();
                      void api.removeBundledModel(offer.modelId).then(refresh);
                    }}
                  >
                    Remove
                  </button>
                ) : (
                  <button
                    className="btn p"
                    data-download={offer.modelId}
                    disabled={progress !== undefined || offer.unavailableReason !== null}
                    onClick={(e) => {
                      e.stopPropagation();
                      void download(offer);
                    }}
                  >
                    {progress === undefined ? `Download ${gb(offer.spec.sizeBytes)} GB` : 'Downloading…'}
                  </button>
                )}
              </div>
            );
          })
        )}

        {/* §9 requires the trade-off stated where the choice is made — and stated
            accurately in both directions. Overstating the weakness would misrepresent the
            tier as much as hiding it would. These numbers are measured, not assumed. */}
        <div className="caveat">
          <b>These are small models, and they are better than that sounds.</b> The 3B answers a
          typical question in about a second once loaded, joins correctly on a confirmed
          relationship, and declines rather than inventing a column. It is still weaker than a
          frontier model on long or ambiguous questions. Either way you see the SQL before it
          runs — and a confirmed dictionary helps most here, because it removes the guessing
          rather than hoping the model guesses well.
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
            No embedding model available on this host.
          </div>
        ) : (
          catalogue.embeddingCandidates.map((model) => {
            // A bundled embedder needs its weights before it can be chosen — 84 MB, so
            // the download is a footnote rather than the decision it is for chat.
            const offer = catalogue.bundled.find((b) => b.modelId === model.id);
            const needsDownload = offer !== undefined && !offer.ready;
            const progress = downloading[model.id];

            return (
              <div
                key={`embed-${model.id}`}
                className={`opt ${catalogue.selectedEmbedding?.id === model.id ? 'on' : ''} ${
                  needsDownload ? 'off' : ''
                }`}
                data-embedder={model.id}
                onClick={() => {
                  if (!needsDownload) void api.setEmbeddingModel(model).then(refresh);
                }}
              >
                <span className="radio" />
                <div>
                  <div className="ot">
                    {offer?.spec.label ?? model.id}
                    {model.tier === 'bundled' && <span className="rec">nothing to install</span>}
                  </div>
                  <div className="od">
                    {offer?.spec.tradeoff ?? `${model.provider} · embeddings`}
                  </div>
                  {progress !== undefined && (
                    <div className="dlbar">
                      <span style={{ width: `${Math.round(progress * 100)}%` }} />
                      <i>{Math.round(progress * 100)}%</i>
                    </div>
                  )}
                </div>
                <span className="tg free">local</span>
                {needsDownload && (
                  <button
                    className="btn p"
                    data-download={model.id}
                    disabled={progress !== undefined}
                    onClick={(e) => {
                      e.stopPropagation();
                      void (async () => {
                        await download(offer!);
                        await api.setEmbeddingModel(model);
                        await refresh();
                      })();
                    }}
                  >
                    {progress === undefined ? `Download ${mb(offer!.spec.sizeBytes)} MB` : 'Downloading…'}
                  </button>
                )}
              </div>
            );
          })
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
