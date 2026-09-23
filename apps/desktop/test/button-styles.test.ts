import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every button class has a style.
 *
 * `className="primary"` shipped with no `.primary` rule anywhere, so the one affirmative
 * button in Settings → Serving rendered as raw browser chrome next to properly styled
 * controls. Nothing failed: a missing CSS rule is not an error in any tool in this
 * repo, and the app looks fine in a diff.
 *
 * Buttons specifically, rather than every class: an unstyled wrapper div is invisible and
 * often deliberate, while an unstyled button is always wrong — it falls back to the
 * platform's own appearance, which is the one thing a designed surface never wants.
 */
const renderer = resolve(fileURLToPath(import.meta.url), '..', '..', 'src', 'renderer');

function stylesheet(): string {
  return ['app.css', 'tokens.css']
    .map((f) => readFileSync(join(renderer, f), 'utf8'))
    .join('\n');
}

/** Class names appearing on a <button ... className="..."> in any renderer source. */
function buttonClasses(): ReadonlyMap<string, string> {
  const found = new Map<string, string>();

  for (const file of readdirSync(renderer).filter((f) => f.endsWith('.tsx'))) {
    const source = readFileSync(join(renderer, file), 'utf8');

    // A <button …> open tag, up to the closing angle bracket, with a literal className.
    for (const tag of source.matchAll(/<button\b[^>]*>/g)) {
      const literal = /className=["`]([^"`{]+)["`]/.exec(tag[0]);
      if (literal === null) continue;
      for (const name of literal[1]!.split(/\s+/).filter(Boolean)) {
        if (!found.has(name)) found.set(name, file);
      }
    }
  }
  return found;
}

describe('button styling', () => {
  it('finds the buttons at all, so a passing run means something', () => {
    const classes = buttonClasses();
    expect(classes.size).toBeGreaterThan(3);
    // The ones this test was written for.
    expect([...classes.keys()]).toContain('primary');
    expect([...classes.keys()]).toContain('danger');
  });

  it('has a rule for every class a button is given', () => {
    const css = stylesheet();
    const orphans: string[] = [];

    for (const [name, file] of buttonClasses()) {
      // Any rule mentioning the class counts — plain, compound, descendant or state.
      const rule = new RegExp(`\\.${name.replace(/-/g, '\\-')}[\\s,{:.\\[>]`);
      if (!rule.test(css)) orphans.push(`.${name} (used in ${file})`);
    }

    expect(orphans, `Buttons with no style will render as raw browser chrome:\n${orphans.join('\n')}`)
      .toEqual([]);
  });
});
