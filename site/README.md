# The Datera marketing site

Plain HTML, no build step, no JavaScript. Deployed to Cloudflare Pages from this directory
(spec §14.2).

## Why it looks like this

The tokens at the top of `index.html` are the same ones the desktop app uses
(`apps/desktop/src/renderer/tokens.css`), so the site and the product cannot drift into
looking like two different things. Copied rather than imported: Pages serves this directory
alone, and a build step to share one file would cost more than it saves for a page this size.

## Deploying

Cloudflare Pages, connected to this repository through the dashboard — no API token in CI,
nothing to leak:

- **Build command:** none
- **Build output directory:** `site`
- **Framework preset:** none

`datera.app` is registered at Cloudflare Registrar, so adding it as a custom domain needs no
DNS work.

## The claims are tested

`packages/core/test/site-claims.test.ts` asserts the checkable ones against the repo: that
every source format named here is really supported, that Datera Server is not offered for
sale while `PLAN.md` says it is unbuilt, that the licence stated matches `LICENSE`, and that
the Mac download is not promised to hardware no longer built for.

Marketing copy drifts in a way code does not — nothing breaks when a format is dropped or a
product slips, so nobody notices. On a site whose entire pitch is that Datera does not hide
things, an overstated claim is a worse failure than a missing feature.
