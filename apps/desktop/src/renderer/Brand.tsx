/**
 * The Datera mark, from the logo kit.
 *
 * Inlined as SVG rather than loaded as a file so it renders before first paint and costs
 * no request — and inlined *verbatim from the kit* rather than approximated in CSS, which
 * is what it used to be: a gradient square that looked close enough until you put it
 * beside the real one.
 *
 * The gradient ids are namespaced because SVG defs are document-global. Two copies of a
 * plain `id="g"` on one page and the second silently borrows the first's gradient.
 */
export function Mark({ size = 18 }: { readonly size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label="Datera"
      className="mark"
    >
      <defs>
        <linearGradient id="dtr-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4f46e5" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
        <linearGradient id="dtr-gloss" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity=".18" />
          <stop offset=".55" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="96" height="96" rx="26" fill="url(#dtr-mark)" />
      <rect x="2" y="2" width="96" height="96" rx="26" fill="url(#dtr-gloss)" />
      {/* Three bars receding into transparency: data, and the glass box. */}
      <rect x="24" y="30" width="52" height="11" rx="5.5" fill="#fff" opacity=".95" />
      <rect x="24" y="47" width="40" height="11" rx="5.5" fill="#fff" opacity=".66" />
      <rect x="24" y="64" width="28" height="11" rx="5.5" fill="#fff" opacity=".42" />
    </svg>
  );
}
