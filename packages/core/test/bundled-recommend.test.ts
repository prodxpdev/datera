import { describe, expect, it } from 'vitest';
import { BUNDLED_MODELS, recommendBundledModel } from '@datera/core';

/**
 * Which model to propose, from what the machine actually has.
 *
 * The alternative is proposing the same model to everyone, which means proposing the
 * smallest — and handing a 32 GB desktop the 1.5B is the sort of default that makes a
 * product feel worse than it is. Going the other way is worse still: a 7B on an 8 GB
 * laptop swaps, and the user concludes local models do not work.
 */
const GIB = 1024 ** 3;

describe('recommendBundledModel', () => {
  it('proposes the small one on a machine with little memory', () => {
    expect(recommendBundledModel(8 * GIB).id).toContain('1.5b');
    expect(recommendBundledModel(4 * GIB).id).toContain('1.5b');
  });

  it('proposes the default on an ordinary laptop', () => {
    expect(recommendBundledModel(16 * GIB).id).toContain('3b');
  });

  it('proposes the large one only where there is real headroom', () => {
    expect(recommendBundledModel(32 * GIB).id).toContain('7b');
    expect(recommendBundledModel(64 * GIB).id).toContain('7b');
  });

  it('never proposes something the machine cannot hold', () => {
    // From 4 GB up. Below that nothing in the catalogue genuinely fits, and the floor
    // below is the documented behaviour there: propose the smallest and let the status
    // line say why it will struggle, rather than show an empty picker.
    for (const total of [4, 8, 12, 16, 24, 32, 64].map((g) => g * GIB)) {
      const spec = recommendBundledModel(total);
      expect(spec.minFreeMemoryBytes * 1.5, `${total / GIB} GB machine got ${spec.id}`)
        .toBeLessThanOrEqual(total);
    }
  });

  it('still returns something on a machine that can barely run anything', () => {
    // Returning nothing would leave the picker empty with no explanation. The smallest
    // model plus the status line's reason is more use than silence.
    const tiny = recommendBundledModel(1 * GIB);
    expect(BUNDLED_MODELS.some((m) => m.id === tiny.id)).toBe(true);
  });

  it('is a total function over the catalogue', () => {
    for (const total of [0, 1, 7.9, 8, 15.9, 16, 31.9, 32].map((g) => g * GIB)) {
      expect(BUNDLED_MODELS.some((m) => m.id === recommendBundledModel(total).id)).toBe(true);
    }
  });
});
