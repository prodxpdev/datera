/**
 * Remove credentials from anything on its way into an error, a log line, or a trace.
 *
 * Provider errors quote your request back at you with some regularity — a 401 body
 * containing the key that failed is common. That text then flows into an error message
 * and a UI toast, so the key has to be stripped at the boundary rather than trusted not
 * to travel.
 */
const KEY_SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\b(api[-_]?key|authorization|x-api-key)\s*[:=]\s*["']?[A-Za-z0-9_\-.]{8,}["']?/gi,
  /\bBearer\s+[A-Za-z0-9_\-.]{8,}/gi,
  // A connection string with credentials in it, in either spelling. Neither was matched
  // before, so a Postgres error quoting its DSN put the password in the trace log.
  /\b(postgres(?:ql)?|mysql|mongodb):\/\/[^\s:@/]+:[^\s@]+@/gi,
  /\bpassword\s*=\s*[^\s;'"]+/gi,
];

export function redactSecrets(text: string, ...known: readonly (string | null | undefined)[]): string {
  let out = text;

  // Exact known values first — the most reliable removal available.
  for (const secret of known) {
    if (secret !== null && secret !== undefined && secret.length >= 6) {
      out = out.split(secret).join('«redacted»');
    }
  }

  for (const shape of KEY_SHAPES) out = out.replace(shape, '«redacted»');
  return out;
}
