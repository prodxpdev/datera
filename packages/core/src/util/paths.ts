/**
 * Minimal path helpers.
 *
 * Deliberately NOT `node:path`: the core must stay loadable in a browser/wasm host
 * (spec §2a — the iPad path). These handle both separators and nothing more.
 */
const SEP_RE = /[\\/]/;

export function joinPath(...parts: string[]): string {
  const cleaned = parts.filter((p) => p.length > 0).map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, '')));
  return cleaned.join('/');
}

export function basename(p: string): string {
  const parts = p.split(SEP_RE);
  return parts[parts.length - 1] ?? p;
}

/** Lowercased extension without the dot; '' when there is none. */
export function extname(p: string): string {
  const base = basename(p);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** Filename with its extension removed — the default display name for a source. */
export function stem(p: string): string {
  const base = basename(p);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? base : base.slice(0, dot);
}

export function normalizeSeparators(p: string): string {
  return p.replace(/\\/g, '/');
}
