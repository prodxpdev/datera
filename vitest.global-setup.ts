import { generateFixtures } from './packages/testkit/dist/index.js';

/**
 * Fixtures are generated once per run rather than committed.
 *
 * Tests assert on file mtimes, so every suite must see files this run created — a stale
 * committed fixture with a decade-old mtime would make the §12.1 assertion pass for the
 * wrong reason.
 */
export async function setup(): Promise<void> {
  const paths = await generateFixtures();
  process.env.DATERA_FIXTURES = paths.root;
}
