import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BUNDLED_MODEL_ID, bundledModel } from '@datera/core';
import { NodeLocalLlm } from '@datera/node-runtime';

/**
 * Weights shipped inside the installer.
 *
 * The default build fetches on demand — a 2.1 GB file cannot even be a GitHub release
 * asset, and bundling would charge every user for a tier some of them never touch. But a
 * classroom with no per-student internet cannot download anything, and that is a stated
 * use (§11). So there is a second artifact with the weights inside it.
 *
 * What that needs from the runtime is small and worth getting exactly right: a read-only
 * seed location, checked before the writable one, that never has to be copied. An app
 * bundle is not writable, so treating the seed as a cache to fill would fail on the one
 * machine this exists for.
 */
const spec = bundledModel(DEFAULT_BUNDLED_MODEL_ID);

describe('seeded weights', () => {
  let writable: string;
  let seed: string;

  beforeEach(async () => {
    writable = await mkdtemp(join(tmpdir(), 'datera-writable-'));
    seed = await mkdtemp(join(tmpdir(), 'datera-seed-'));
  });

  afterEach(async () => {
    await rm(writable, { recursive: true, force: true });
    await rm(seed, { recursive: true, force: true });
  });

  it('reports a seeded model as ready without anything being downloaded', async () => {
    await writeFile(join(seed, spec.file), Buffer.alloc(spec.sizeBytes > 0 ? 8 : 0));

    const tiny = { ...spec, sizeBytes: 8 };
    const llm = new NodeLocalLlm({ directory: writable, seedDirectory: seed, models: [tiny] });

    const status = (await llm.status()).find((s) => s.modelId === tiny.id);
    expect(status?.ready).toBe(true);
  });

  it('does not try to download one that is already seeded', async () => {
    await writeFile(join(seed, spec.file), Buffer.alloc(8));
    const tiny = { ...spec, sizeBytes: 8 };

    let attempted = false;
    const llm = new NodeLocalLlm({
      directory: writable,
      seedDirectory: seed,
      models: [tiny],
      fetchImpl: (async () => {
        attempted = true;
        return new Response(null, { status: 500 });
      }) as unknown as typeof fetch,
    });

    await llm.ensure(tiny.id);
    expect(attempted).toBe(false);
  });

  it('leaves the seed alone rather than copying it into the writable directory', async () => {
    // An app bundle is read-only and a copy would double 2 GB of disk for no gain. The
    // seed is read in place.
    await writeFile(join(seed, spec.file), Buffer.alloc(8));
    const tiny = { ...spec, sizeBytes: 8 };

    await new NodeLocalLlm({ directory: writable, seedDirectory: seed, models: [tiny] }).ensure(tiny.id);

    expect(await readdir(writable)).toEqual([]);
    expect(await readdir(seed)).toEqual([tiny.file]);
  });

  it('lets a downloaded model sit alongside a seeded one', async () => {
    // The real upgrade path: the installer ships the small model, and someone with the
    // disk for it downloads the large one. Both end up usable, from different places.
    //
    // (An earlier version of this test had the seed and the download be the *same* model
    // at the same size, which cannot happen — ensure() correctly does nothing when the
    // weights are already present, whichever directory they are in.)
    const seededSpec = { ...spec, id: 'seeded-small', file: 'seeded-small.gguf', sizeBytes: 8 };
    await writeFile(join(seed, seededSpec.file), Buffer.alloc(8));

    const body = Buffer.from('downloaded');
    const downloadedSpec = {
      ...spec,
      id: 'fetched-large',
      file: 'fetched-large.gguf',
      sha256: createHash('sha256').update(body).digest('hex'),
      sizeBytes: body.length,
    };

    const llm = new NodeLocalLlm({
      directory: writable,
      seedDirectory: seed,
      models: [seededSpec, downloadedSpec],
      fetchImpl: (async () =>
        new Response(body as unknown as BodyInit, {
          status: 200,
          headers: { 'content-length': String(body.length) },
        })) as unknown as typeof fetch,
    });

    await llm.ensure(downloadedSpec.id);

    const statuses = await llm.status();
    expect(statuses.find((s) => s.modelId === 'seeded-small')?.ready).toBe(true);
    expect(statuses.find((s) => s.modelId === 'fetched-large')?.ready).toBe(true);
    expect(await readdir(writable)).toEqual([downloadedSpec.file]);
  });

  it('works with no seed directory at all, which is the normal build', async () => {
    const llm = new NodeLocalLlm({ directory: writable });
    expect((await llm.status()).every((s) => !s.ready)).toBe(true);
  });
});
