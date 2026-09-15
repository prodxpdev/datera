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

## Status — Phases 1 and 2 built

**Phase 1** — the portable core, DuckDB embedded, read-only connect and ingest of the
DuckDB-native formats, schema introspection with inferred types, and the Electron Workspace shell.

**Phase 2** — NL→SQL with visible cited SQL, the query glass box (parse → route → schema →
model → SQL → guard → rows → cost), a direct SQL editor on the same guard, and the spec §9
three-tier model system with keys in the OS keychain.

**One part of Phase 2 is not built: the bundled local model (tier 1).** The provider
architecture, selection, trace and cost accounting are all in place and tested, but no weights
ship and no inference runs locally — so out of the box, with no model configured, Ask reports
`MODEL_UNAVAILABLE` rather than answering. Tiers 2 and 3 work today. See
[the Phase 2 gap](#the-phase-2-gap-the-bundled-model) below.

**Not built at all:** dictionary, semantic search, copy-on-write, versions, normalize, writes,
MCP/REST serving, Datera Server. Those nav items are visible but disabled in the app,
deliberately — see [`PLAN.md`](./PLAN.md).

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
pnpm test                 # full suite: 125 pass, 6 skip without databases
```

### Run the app

```bash
pnpm --filter @datera/desktop run build
pnpm --filter @datera/desktop run start
```

Click **+ Connect data** and pick any CSV, TSV, JSON, Parquet, `.xlsx`, or `.sqlite` file —
your own, or the ones in `fixtures/generated/` after a test run. You get the source list,
the schema with types and null counts, a paged preview, and a **How this source was read**
panel showing exactly what the parser decided.

Your workspace lives in the OS app-data directory and persists between launches. Set
`DATERA_WORKSPACE=/some/path` to put it somewhere else.

### Ask a question

Ask needs a chat model. The quickest path today is Ollama:

```bash
ollama serve                 # in another terminal
ollama pull qwen2.5-coder:7b # a good small SQL model
```

Then open **Models** in the app — the running runtime and its models appear — pick one, and use
**Ask**. Every answer has a **How it was made** button: the routing decision, the schema given to
the model, *exactly* what was sent, the generated SQL, the read-only verdict, the rows, and the
cost. Or add an Anthropic/OpenAI key in the same view; it goes to the OS keychain.

### Poke the core without the app

```bash
pnpm run try fixtures/generated/orders.csv fixtures/generated/customers.sqlite
```

Prints the schema, inference warnings and first rows for each source, then demonstrates the
read-only guard refusing a `DELETE`, a `COPY … TO`, and a statement batch hiding a `DROP`.
Uses a throwaway workspace and never touches your files.

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

### The Phase 2 gap: the bundled model

Spec §9 tier 1 is a bundled local model — no key, no account — with weights fetched on first run
(decision D-08). **That is not implemented.** What exists instead:

- the full provider abstraction, so adding it is a new `ChatModel` and nothing else;
- tier 2, **detected local runtimes** (Ollama, LM Studio, any OpenAI-compatible endpoint), which
  gives the same "no key, nothing uploaded" property to anyone who has one installed;
- tier 3, **remote BYO key**, with keys in the OS keychain.

The consequence is honest and visible in the app: with nothing configured, Ask says no model is
configured rather than silently doing nothing. The Models view marks the bundled tier
unavailable rather than offering something that would fail on use.

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
