import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestWorkspace, testPorts, type TestWorkspace } from '@datera/testkit';

/**
 * A pushed table cannot write outside the workspace.
 *
 * `receiveDataset` staged each table as `<workspace>/.push-inbox/<name>.csv`, with the name
 * taken straight off the wire. joinPath is a deliberately minimal string join with no `..`
 * normalisation — the core must stay loadable in a browser host, so it does not use
 * node:path — and the filesystem port creates missing parents before writing. A name of
 * `../../../../etc/whatever` therefore wrote attacker content to an arbitrary path as the
 * serving user, with only the `.csv` suffix constraining it.
 *
 * Reachable on a server started with --allow-push, which documents itself as accepting a
 * dataset, not as accepting a filesystem write.
 */
describe('receiving a pushed dataset', () => {
  let ws: TestWorkspace;

  beforeEach(async () => {
    ws = await openTestWorkspace({ ports: testPorts() });
  });

  afterEach(async () => {
    await ws.dispose();
  });

  const manifest = JSON.stringify({ dataset: { name: 'pushed', description: '' } });

  it('refuses a table name that would escape the workspace', async () => {
    await expect(
      ws.datera.receivePush(manifest, [
        { name: '../../../../../../tmp/datera-escape', csv: 'a\n1\n' },
      ]),
    ).rejects.toThrow(/name|invalid|refus/i);
  });

  it('refuses a name with a separator in it at all', async () => {
    for (const name of ['sub/dir', 'sub\\dir', '..', '.']) {
      await expect(
        ws.datera.receivePush(manifest, [{ name, csv: 'a\n1\n' }]),
      ).rejects.toThrow(/name|invalid|refus/i);
    }
  });

  it('still accepts an ordinary table name', async () => {
    const result = await ws.datera.receivePush(manifest, [
      { name: 'orders', csv: 'id,total\n1,10\n2,20\n' },
    ]);
    expect(result).toBeDefined();
  });
});
