import { useCallback, useEffect, useState } from 'react';
import { bundledDescriptor, type BundledModelOffer } from '@datera/core';
import type { DateraApi } from '../shared/contract.js';

/**
 * The offer that stops "no model configured" reading as a broken install.
 *
 * Weights are fetched rather than shipped (decision D-08), which is right — two gigabytes
 * in the installer would be paid by every user including everyone who brings their own
 * key. But the consequence is a first launch where the headline feature does nothing, and
 * an empty state that does not explain itself is indistinguishable from a bug.
 *
 * So: one card, the recommended size for this machine, the download size stated plainly,
 * and the thing that makes it worth it — after this, no key and no network, ever.
 * Dismissible, because someone with an Anthropic key should not have to argue with it.
 *
 * Dismissal lasts the session, not forever, and that is deliberate rather than lazy: the
 * card only appears when *no* chat model is configured at all, which means Ask genuinely
 * cannot work. Configure anything — a key, Ollama, this model — and it never returns.
 * Reminding someone that the headline feature is still unavailable is not an upsell; it
 * is the honest state of the workspace.
 */
export function FirstRun({
  api,
  onDone,
}: {
  readonly api: DateraApi;
  readonly onDone: () => void;
}): JSX.Element | null {
  const [offer, setOffer] = useState<BundledModelOffer | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    void (async () => {
      const catalogue = await api.listModels();
      // Only when there is genuinely nothing to answer with. A configured workspace must
      // never see this.
      if (catalogue.selected !== null) return;
      setOffer(catalogue.bundled.find((m) => m.recommended && !m.ready) ?? null);
    })();
  }, [api]);

  useEffect(
    () => api.onBundledProgress(({ receivedBytes, totalBytes }) => {
      setProgress(totalBytes === 0 ? 0 : receivedBytes / totalBytes);
    }),
    [api],
  );

  const start = useCallback(async () => {
    if (offer === null) return;
    setError(null);
    setProgress(0);
    try {
      await api.downloadBundledModel(offer.modelId);
      await api.setChatModel(bundledDescriptor(offer.spec));
      void api.warmBundledModel();
      onDone();
      setOffer(null);
    } catch (e) {
      setError((e as { message?: string }).message ?? String(e));
    } finally {
      setProgress(null);
    }
  }, [api, offer, onDone]);

  if (offer === null || dismissed) return null;

  const gb = (offer.spec.sizeBytes / 1024 ** 3).toFixed(1);

  return (
    <div className="firstrun" data-firstrun>
      <div className="frbody">
        <div className="frt">Ask questions without a key</div>
        <p>
          Datera can answer in plain language using a model that runs <b>on this machine</b>.
          It needs a one-time <b>{gb} GB</b> download — <b>{offer.spec.label}</b>, the size that
          suits this computer. After that it works with no key, no account and no network at
          all.
        </p>
        <p className="frsub">{offer.spec.tradeoff}</p>

        {error !== null && <div className="err" role="alert">{error}</div>}

        {progress !== null && (
          <div className="dlbar">
            <span style={{ width: `${Math.round(progress * 100)}%` }} />
            <i>{Math.round(progress * 100)}% of {gb} GB</i>
          </div>
        )}
      </div>

      <div className="fracts">
        <button className="btn p" data-firstrun-download disabled={progress !== null} onClick={() => void start()}>
          {progress === null ? `Download ${gb} GB` : 'Downloading…'}
        </button>
        <button className="btn" data-firstrun-dismiss onClick={() => setDismissed(true)}>
          Not now
        </button>
        <span className="frnote">
          SQL, the schema map and completions all work without it.
        </span>
      </div>
    </div>
  );
}
