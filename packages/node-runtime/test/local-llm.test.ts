import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DEFAULT_BUNDLED_MODEL_ID, bundledModel } from '@datera/core';
import { NodeLocalLlm } from '@datera/node-runtime';

/**
 * Fetching a bundled model's weights.
 *
 * The download is the one place the bundled tier touches the network, and the file it
 * produces is executable input — llama.cpp will map and run it. So the interesting tests
 * here are not "does it download" but "what happens when it downloads the wrong thing":
 * verification must reject it, and rejecting must leave nothing behind that a later run
 * could mistake for a model.
 *
 * The real runtime is not exercised here; that needs two gigabytes of weights and lives
 * behind DATERA_BUNDLED_MODEL=1 in local-llm.integration.test.ts.
 */
const spec = bundledModel(DEFAULT_BUNDLED_MODEL_ID);

describe('bundled model download', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'datera-llm-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /** A "download" of exactly these bytes, with a matching content-length. */
  function serve(body: Buffer): typeof fetch {
    return (async () =>
      new Response(Readable.toWeb(Readable.from([body])) as ReadableStream, {
        status: 200,
        headers: { 'content-length': String(body.length) },
      })) as unknown as typeof fetch;
  }

  it('rejects a file whose checksum does not match, and keeps nothing', async () => {
    const llm = new NodeLocalLlm({ directory, fetchImpl: serve(Buffer.from('not the model')) });

    await expect(llm.ensure(spec.id)).rejects.toThrow(/verification/i);

    // No partial, no truncated model, nothing a later run could pick up and load.
    expect(await readdir(directory)).toEqual([]);
  });

  it('says what it expected and what it got, without dumping a 64-character hash twice', async () => {
    const llm = new NodeLocalLlm({ directory, fetchImpl: serve(Buffer.from('wrong')) });

    await expect(llm.ensure(spec.id)).rejects.toThrow(
      new RegExp(`${spec.sha256.slice(0, 12)}`),
    );
  });

  it('reports a failed request as a download failure, not a verification failure', async () => {
    const failing = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
    const llm = new NodeLocalLlm({ directory, fetchImpl: failing });

    await expect(llm.ensure(spec.id)).rejects.toThrow(/503/);
    expect(await readdir(directory)).toEqual([]);
  });

  it('reports what the machine can run, and why not when it cannot', async () => {
    const llm = new NodeLocalLlm({ directory });
    const statuses = await llm.status();

    expect(statuses).toHaveLength(3);
    for (const status of statuses) {
      expect(status.ready).toBe(false);
      expect(status.bytesOnDisk).toBe(0);
      // Either it fits, or there is a reason a person can act on.
      if (status.unavailableReason !== null) {
        expect(status.unavailableReason).toMatch(/memory/i);
      }
    }
  });

  it('treats a file of the right length as present, and skips the download', async () => {
    // Length is what `ready` checks: hashing two gigabytes on every status call would
    // make the model picker take ten seconds to open. The hash is checked once, at the
    // only moment it can change anything — before the file is put into place.
    let called = false;
    const watching = (async () => {
      called = true;
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;

    await writeFile(join(directory, spec.file), Buffer.alloc(spec.sizeBytes > 4096 ? 4096 : 1));
    const short = new NodeLocalLlm({ directory, fetchImpl: watching });
    await expect(short.ensure(spec.id)).rejects.toThrow();
    expect(called).toBe(true);
  });

  it('removes weights on request, because disk is why people uninstall things', async () => {
    const path = join(directory, spec.file);
    await writeFile(path, 'x');

    await new NodeLocalLlm({ directory }).remove(spec.id);

    expect(await readdir(directory)).toEqual([]);
  });
});

describe('a correctly served file', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'datera-llm-ok-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /**
   * The success path, exercised for real.
   *
   * A small file with a known hash, through the same download, verify and rename the
   * two-gigabyte case takes. Testing failure without testing success leaves the half that
   * actually has to work uncovered.
   */
  it('verifies, then puts the file into place under its proper name', async () => {
    const body = Buffer.from('pretend weights');
    const digest = createHash('sha256').update(body).digest('hex');
    const tiny = { ...spec, sha256: digest, sizeBytes: body.length };

    const progress: number[] = [];
    const llm = new NodeLocalLlm({
      directory,
      models: [tiny],
      fetchImpl: (async () =>
        new Response(Readable.toWeb(Readable.from([body])) as ReadableStream, {
          status: 200,
          headers: { 'content-length': String(body.length) },
        })) as unknown as typeof fetch,
    });

    await llm.ensure(tiny.id, (p) => progress.push(p.receivedBytes));

    expect(await readdir(directory)).toEqual([tiny.file]);
    expect(await readFile(join(directory, tiny.file))).toEqual(body);

    const status = (await llm.status()).find((s) => s.modelId === tiny.id);
    expect(status?.ready).toBe(true);
    expect(status?.bytesOnDisk).toBe(body.length);
  });

  it('does not download again once the file is present', async () => {
    const body = Buffer.from('pretend weights');
    const digest = createHash('sha256').update(body).digest('hex');
    const tiny = { ...spec, sha256: digest, sizeBytes: body.length };

    let downloads = 0;
    const counting = (async () => {
      downloads += 1;
      return new Response(Readable.toWeb(Readable.from([body])) as ReadableStream, {
        status: 200,
        headers: { 'content-length': String(body.length) },
      });
    }) as unknown as typeof fetch;

    const llm = new NodeLocalLlm({ directory, models: [tiny], fetchImpl: counting });
    await llm.ensure(tiny.id);
    await llm.ensure(tiny.id);

    expect(downloads).toBe(1);
  });
});
