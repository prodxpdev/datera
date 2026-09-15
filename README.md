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

## Status — all nine phases built

Every phase of the build sequence (spec §11) is implemented and tested. **381 tests pass**,
6 skip without database containers.

| Phase | What it is | State |
|---|---|---|
| 1 | Portable core, DuckDB, read-only connect + ingest, Workspace shell | ✅ |
| 2 | NL→SQL, the glass box, §9 three-tier models | ✅ except the bundled model — [#32](https://github.com/prodxpdev/datera/issues/32) |
| 3 | Datasets, the enforced boundary, relationships, dictionary, "what it touched" | ✅ |
| 4 | Embeddings, vector search, structured-vs-semantic routing | ✅ |
| 5 | Copy-on-write, versions, normalize, enum promotion, portable export | ✅ |
| 6 | Gated writes: propose → preview → confirm → undo | ✅ |
| 7 | Serve over MCP (stdio + HTTP) and REST; the persisted trace log | ✅ |
| 8 | Environments, remote client, push — **client half only** | ✅ |
| 9 | The data-lifecycle teaching module | ✅ |

**Phase 8's server is not here and will not be.** `datera-server` — auth, per-token and
per-dataset scoping, deploy orchestration, licence enforcement, tenant isolation — is a
separate private repository (spec §2). What this repo contains is the client's ability to
drive one, and a test that fails if server-proprietary concerns appear here.

### The one real gap

**The bundled local model (spec §9 tier 1) is not implemented.** The provider architecture,
selection, trace naming and cost accounting are all in place and tested, but no weights ship
and no local inference runs. With nothing configured, Ask says so rather than failing
obscurely. Tiers 2 and 3 — a detected local runtime such as Ollama, or your own API key —
both work today. See [#32](https://github.com/prodxpdev/datera/issues/32).

## Repository layout

```
packages/core/          @datera/core — the portable engine. No desktop or server dependencies.
packages/node-runtime/  Node implementations of the core's ports (DuckDB driver, fs, http, clock).
packages/cli/           The `datera` binary — MCP over stdio and HTTP, plus REST.
packages/testkit/       Fixtures, the byte-identity harness, the egress guard, fake ports.
apps/desktop/           The Electron client — a thin host over the core.
scripts/                Extension staging.
fixtures/generated/     Test fixtures, generated rather than committed.
```

`packages/cli` is the `datera` binary — a third host over the core, serving MCP over stdio and
HTTP plus a small REST surface:

```bash
datera --mcp --workspace ~/data                    # stdio, for Claude Desktop / Cursor
datera --http 7391 --workspace ~/data              # local HTTP
datera --http 7391 --host 0.0.0.0 --token <token>  # reachable; a token is required
```

It refuses to bind beyond loopback without a token, and receiving pushed datasets is a separate
opt-in (`--allow-push`).

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
pnpm test                 # full suite: 381 pass, 6 skip without databases
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
2. **Copy-on-write** — the source is sacred. Derived datasets hold real tables; writes only
   ever land there, and a connected dataset cannot be granted writes at all.
3. **The model proposes; a human confirms** — relationships, dictionary entries,
   normalization splits and every write. Only *confirmed* definitions reach a model.
4. **Show the work** — Phase 1 ships the beginning: how each source was parsed is recorded and
   displayed, including a warning when DuckDB's CSV sniffer falls back to a bogus delimiter.
5. **Deterministic where facts matter** — row counts, null counts and type inference are computed
   from the data, never guessed.
6. **BYO-key with a bundled local default** — tiers 2 and 3 work; tier 1 is the open gap.
   Embeddings are chosen separately and never follow the chat model.
7. **Portable core** — enforced by test, with a negative control.
8. **No lock-in, and it's provable** — export data, schema, dictionary and dataset definition
   in open formats, and re-import losslessly into a clean instance. Tested, not asserted.

---

## Licence

Apache-2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).

"Datera" and the Datera logo are trademarks of ProdXP, LLC; the Apache licence does not grant
permission to use them.
