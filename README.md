# Datera

**A running, local-first, transparent data tool.** Connect messy data, understand it, ask in plain
language or SQL, get cited answers, and see exactly what happened at every step — then serve it over
API and MCP from infrastructure you control.

Datera is not a code generator and not a hosted platform. It is the **runtime**: the thing that
runs, answers, and shows its work. See [`DATERA-BUILD-SPEC.md`](./DATERA-BUILD-SPEC.md) §0.1–§0.2 for
the identity and the scope filter that governs what gets built.

This is the **public** repository: the portable core engine and the desktop client. `datera-server`
is a separate, private repository.

---

## Status — Phase 1 complete

Phase 1 of the nine-phase build sequence (spec §11) is built and tested: the portable core library,
DuckDB embedded, read-only connect and ingest of the DuckDB-native formats, schema introspection
with inferred types, and the Electron Workspace shell.

**Nothing else is built yet.** There is no NL→SQL, no dictionary, no semantic search, no
copy-on-write, no writes, no MCP or REST serving, and no Datera Server. The nav items for those are
visible but disabled in the app, deliberately — see [`PLAN.md`](./PLAN.md) for what each later phase
contains and what it must satisfy.

| | |
|---|---|
| **Plan of record** | [`PLAN.md`](./PLAN.md) |
| **Source of truth** | [`DATERA-BUILD-SPEC.md`](./DATERA-BUILD-SPEC.md) |
| **Tickets** | GitHub issues, one epic per phase |
| **UX reference** | `datera-app-prototype.html` |

---

## Repository layout

```
packages/core/          @datera/core — the portable engine. No desktop or server dependencies.
packages/node-runtime/  Node implementations of the core's ports (DuckDB driver, fs, clock, logger).
packages/testkit/       Fixtures, the byte-identity harness, the egress guard, fake ports.
apps/desktop/           The Electron client — a thin host over the core.
scripts/                Extension staging.
fixtures/generated/     Test fixtures, generated rather than committed.
```

`packages/cli` is **reserved but not yet created** — the `datera --mcp --workspace …` binary (spec
§8) is a third host over the core and arrives in Phase 7. It is named here so it does not get
smuggled into `apps/desktop`.

### The seam that matters

`@datera/core` has **no runtime dependency** on Electron, on `@duckdb/node-api`, on any HTTP server,
or on `node:fs`. Everything host-specific is an injected port, and DuckDB sits behind a **driver
port**. That is invariant §1.7, and it is enforced by a test
(`packages/core/test/purity.test.ts`) rather than by convention — including a negative control that
proves the guard can actually fail.

It is also what makes the iPad path in spec §2a reachable without a rewrite: a later webview host
supplies a `duckdb-wasm` driver against the same port, and nothing above it changes.

---

## Getting started

Requires Node ≥ 20 and pnpm 10.

```bash
pnpm install              # also stages DuckDB extensions (see below)
pnpm exec tsc -b          # build all packages
pnpm test                 # full suite
pnpm --filter @datera/desktop run build
pnpm --filter @datera/desktop run start
```

### DuckDB extensions are staged, never fetched at query time

`excel`, `sqlite_scanner`, `postgres_scanner` and `mysql_scanner` are not linked into DuckDB. Datera
**never installs an extension at query time** — an extension silently downloaded the first time
somebody opens a spreadsheet would break invariant §1.6 at the worst possible moment: offline, on a
locked-down classroom network, mid-demo.

So they are staged once at install time by `pnpm run stage-extensions`, and the engine runs with
`autoinstall_known_extensions=false` / `autoload_known_extensions=false`. A format whose extension is
missing reports `EXTENSION_UNAVAILABLE` with the fix in the message.

This is asserted, not assumed: the connect path for every format runs in a test with **network
egress blocked**.

### Live Postgres / MySQL tests

They skip **loudly** when no server is reachable — a suite that quietly reports success while testing
nothing is worse than one that is honest. To run them:

```bash
docker run --rm -e POSTGRES_USER=datera -e POSTGRES_PASSWORD=pg_secret_pw \
  -e POSTGRES_DB=datera_test -p 5432:5432 postgres:16

docker run --rm -e MYSQL_ROOT_PASSWORD=root -e MYSQL_USER=datera \
  -e MYSQL_PASSWORD=my_secret_pw -e MYSQL_DATABASE=datera_test -p 3306:3306 mysql:8
```

---

## The invariants

Eight non-negotiables (spec §1). Phase 1 implements and tests the ones it touches:

1. **Read-only by default** — enforced two independent ways: a statement guard using DuckDB's own
   parser, and `READ_ONLY` on every attach.
2. **Copy-on-write** — the source is sacred. Phase 5.
3. **The model proposes; a human confirms** — Phase 3 onward.
4. **Show the work** — Phase 1 ships the beginning: how each source was parsed is recorded and
   displayed, including a warning when DuckDB's CSV sniffer falls back to a bogus delimiter.
5. **Deterministic where facts matter** — row counts, null counts and type inference are computed
   from the data, never guessed.
6. **BYO-key with a bundled local default** — Phase 2. Phase 1 keeps the path clear: no network.
7. **Portable core** — enforced by test.
8. **No lock-in, and it's provable** — "delete Datera and your artifact still runs." Tested from
   Phase 5, where the exports it covers first exist.

---

## Licence

Apache-2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).

"Datera" and the Datera logo are trademarks of ProdXP, LLC; the Apache licence does not grant
permission to use them.
