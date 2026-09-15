# Datera — build plan

Status: **all nine phases built and tested, 2026-09-15.** 381 tests pass; 6 skip without database containers. See §J for what was delivered per epic and the one gap that remains.

Governing document: [`DATERA-BUILD-SPEC.md`](./DATERA-BUILD-SPEC.md). Where this plan and the
spec disagree, the spec wins and this plan is wrong. UX reference: `datera-app-prototype.html`.

This repo is the **public** one: shared core engine + desktop client. `datera-server` is a
separate private repo and no server, hosting, multi-tenant, auth-scoping, deploy-orchestration,
or license-enforcement code belongs here.

---

## A. Proposed project structure

**Confirmed: TypeScript monorepo**, pnpm workspaces + TypeScript project references.

```
datera/
├─ packages/
│  ├─ core/                    @datera/core — the portable engine (spec §1.7, §2)
│  │  ├─ src/
│  │  │  ├─ engine/            DuckDB lifecycle, connections, access mode, extensions
│  │  │  ├─ sources/           connect + ingest, format handlers, attach
│  │  │  ├─ schema/            introspection, type inference, sampling
│  │  │  ├─ datasets/          dataset = DuckDB schema (P3), relationships
│  │  │  ├─ dictionary/        semantic layer (P3)
│  │  │  ├─ query/             router, NL→SQL, SQL exec, citations (P2/P4)
│  │  │  ├─ semantic/          embeddings + VSS (P4)
│  │  │  ├─ cow/               copy-on-write, versions, diff, normalize (P5)
│  │  │  ├─ writes/            propose → preview → confirm → txn → undo (P6)
│  │  │  ├─ serve/             MCP + REST *definitions* and handlers (P7)
│  │  │  ├─ transparency/      trace model, stage recording, cost accounting
│  │  │  ├─ models/            chat + embedding providers, BYOK abstraction (P2)
│  │  │  └─ ports/             FileSystem, Clock, Logger, SecretStore, Paths
│  │  └─ test/                 unit + invariant harness + fixtures
│  └─ testkit/                 @datera/testkit — fixtures, byte-identity assertions,
│                              egress guard, fake ports. Shared by core and desktop.
├─ apps/
│  └─ desktop/                 Electron shell (main / preload / renderer)
├─ fixtures/                   canonical sample data (orders.csv, customers.db, …)
├─ .github/workflows/          CI: macOS + Windows + Linux
├─ PLAN.md  DATERA-BUILD-SPEC.md  LICENSE  NOTICE
```

Deliberately **not** in the tree yet, but named so the seams are cut correctly now:

- `packages/cli` — the `datera` binary (`datera --mcp --workspace …`, spec §8). Arrives Phase 7.
  A second thin host on core, exactly like desktop. Reserving the name now stops the CLI from
  being smuggled into `apps/desktop`.
- `packages/mcp` — may split out of `core/serve` at Phase 7 if the transport deps are heavy.

### Why this shape

- **One core, two hosts, two repos** (spec §2) demands the core be a *consumable package*, not a
  directory the desktop app reaches into. pnpm workspaces + a published `@datera/core` gives us
  one artifact that both `apps/desktop` (this repo, via `workspace:*`) and `datera-server`
  (private repo, via a pinned npm version) consume identically.
- **TypeScript throughout** — the desktop shell is Electron (spec §2 decides this), the DuckDB
  bindings are first-class in Node, and a TS core means `datera-server` is a Node service with
  zero FFI seam. A Rust core would be more portable in the abstract and would make the eventual
  Tauri/iPad move easier, but it buys a cross-language boundary we would pay for on every
  transparency payload — and it does not exist in the spec's timeline. Recommend TS; revisit only
  if the Tauri move is promoted from "later option" to a v1 requirement.

### The core/host seam (invariant §1.7) — enforced, not just intended

1. `packages/core/package.json` declares **no** dependency on Electron, on any HTTP server, or on
   anything desktop- or server-specific. Its runtime deps at Phase 1 are `@duckdb/node-api` and
   nothing else of consequence.
2. Everything the core cannot do for itself is a **port** — an interface it is handed, never
   imports: `FileSystem`, `Clock`, `Logger`, `SecretStore`, `Paths`. The desktop supplies Node/
   Electron implementations; `datera-server` will supply container ones (and later object-storage
   ones for `s3://`/`gs://`, spec §14.1) without core changing.
3. A **lint rule + a CI test** fail the build if `packages/core` imports `electron`, `node:http`,
   or anything from `apps/`. The seam is a test, not a convention (ticket P1-03).
4. The core's public surface is one entry point (`@datera/core`) exporting a `Datera` façade.
   Hosts call the façade; they never reach into `@datera/core/src/...`.
5. **Renderer never imports core.** Electron main owns the core instance; the renderer talks to it
   over a typed IPC contract through a `contextIsolation`-safe preload bridge. This keeps the core
   out of a sandboxed browser context and means the same typed contract can later be fulfilled by
   an HTTP client pointed at a remote Datera Server — which is how invariant §12.10 ("the same UI
   drives it") gets satisfied without forking the UI.

### Where `datera-server` (private) attaches

`datera-server` will depend on `@datera/core` as a **published npm package at an exact pinned
version** (`"@datera/core": "0.4.2"`, not a range, not a git URL, not a path). Consequences we
accept from the first commit:

- `@datera/core` is published from this repo's CI on tag. Semver is a contract with a repo we
  cannot see, so breaking changes to the façade get a major bump and a migration note.
- The server adds **only** the things spec §2 reserves to it: auth, per-token/per-dataset scoping,
  deploy orchestration, license enforcement, tenant isolation. If the server ever needs a hook
  into core behavior, the hook lands in core as a *neutral* extension point (e.g. an
  `AuthorizationPort` that defaults to allow-all locally) — never as server logic in this repo.
- The core's serve layer (Phase 7) defines the MCP tools and REST handlers; the server supplies the
  HTTP host, the tokens, and the scope checks around them.

### Stack choices inside the structure

| Concern | Choice | Note |
|---|---|---|
| Package manager | pnpm workspaces | strict node_modules keeps the core's dep hygiene honest |
| Language | TypeScript, ESM, strict | project references for fast incremental builds |
| DuckDB | `@duckdb/node-api` (1.5.5) **behind a driver port** | official Node-API bindings; prebuilt binaries for darwin/win32/linux × x64/arm64; Node-API = **no Electron ABI rebuild**. The port reserves `duckdb-wasm` for the later iPad shell (spec §2a) |
| Test runner | Vitest | unit + integration in one runner |
| E2E | Playwright `_electron` | drives the real shell |
| Renderer | React + Vite, plain CSS using the prototype's design tokens | see decision D-10 |
| Packaging | electron-builder | **macOS (arm64 + x64), Windows (x64), Linux** — all three ship (D-14) |
| License | Apache-2.0 (already committed) | see decision D-09 |

---

## B. The 9-phase build sequence as epics

One epic per spec §11 phase. Acceptance criteria are drawn from §12 (and §14 for Phase 8).
Every phase ships with tests. Phases are sequential; nothing in a later phase is started early.

### Epic 1 — Core foundation *(detailed in section C)*
Portable core library. DuckDB embedded. Connect/ingest the DuckDB-native formats read-only.
Schema introspection + inferred types. Electron Workspace shell listing and previewing sources.

**Acceptance**
- [ ] §12.1 — connecting a source **never modifies it**: file bytes (sha-256), size, and mtime are
      identical after connect + introspect + preview + query. Asserted per format.
- [ ] A live Postgres/MySQL attach is read-only: a write attempt through the attached catalog fails.
- [ ] Schema introspection reports column names, DuckDB types, nullability, and row count for every
      supported format, matching a fixture snapshot.
- [ ] §12.10 (partial) — the client runs standalone with no server present, no network required.
- [ ] `packages/core` has no desktop or server dependency, proven by a failing-build test.

### Epic 2 — Read-only querying + transparency
NL→SQL over the bundled local model with visible cited SQL. The query glass box
(parse → schema → generated SQL → model context → rows → cost). A direct SQL editor.
BYOK config with secure key storage.

**Acceptance**
- [ ] §12.2 — an NL question returns a cited answer with the SQL shown, and the recorded model
      payload contains **schema + dictionary only** — asserted by inspecting the captured payload
      for any fixture data value.
- [ ] §12.3 — a vague/unanswerable question produces an explicit flag, not a fabricated value.
- [ ] §12.8 — with no key configured, the bundled local model answers and **no network egress
      occurs** (asserted by a test-time egress guard, not by inspection).
- [ ] §1.5 — every number in an answer traces to a row the engine returned; prose citing data with
      no backing rows is discarded, asserted on a fixture.
- [ ] BYOK keys are stored in the OS keychain, never written to config in plaintext, never logged
      (assert on the log stream and the config file).
- [ ] Every query produces a complete trace with all stages populated and a cost figure.
- [ ] **Spec §9 three tiers.** Chat and embedding models are selected independently. With Ollama
      running, Datera detects it, lists its installed models, runs a query through the selected one,
      and **the trace names that exact model** (`Ollama · llama3.1:8b (local · :11434)`). With no
      local runtime running, detection fails **silently** and both the bundled tier and the remote
      BYO-key tier still work. Detection is probed with a short timeout and never blocks the UI.
- [ ] No trace entry ever says merely "the local model" — tier, provider, model id, and locality are
      all present, or the assertion fails.

### Epic 3 — Datasets + relationships + dictionary
Datasets as DuckDB schemas. Detected + confirmed relationships. Dictionary auto-draft + confirm,
injected into NL→SQL context. The "what it touched" drill-down.

**Acceptance**
- [ ] §12.4 — sources in different datasets **cannot be joined**: the model is shown only the active
      dataset's schema, and a hand-written cross-dataset join is blocked at execution.
- [ ] §1.3 — a detected relationship is **suggested**, never applied, until a human confirms; the
      same for every dictionary item (state: confirmed / suggested / undefined).
- [ ] The dictionary injection is visible in the transparency drawer's model stage and matches the
      payload actually sent.
- [ ] Defining `revenue_cents` as cents with alias "sales" changes the generated SQL for "what were
      my sales" to divide by 100 — asserted end to end on the fixture.
- [ ] "What it touched" reports, for a sheet, the columns read + rows matched + the matching filter;
      for a join, the tables/columns with their role (join key / filter / group-by / aggregate) and
      the join path.

### Epic 4 — Semantic path
Local embeddings + DuckDB vector store (VSS/HNSW). Structured-vs-semantic routing. Semantic drill-in.

**Acceptance**
- [ ] §12.5 — the router sends structured questions to SQL with **no embeddings computed**, and
      free-text meaning-match questions to semantic, asserted per fixture; the choice and its reason
      are shown.
- [ ] Only the retrieved top-k chunks reach the model — never the whole corpus (assert payload size
      and content against the corpus).
- [ ] Embeddings run locally by default even when the chat model is BYOK (invariant §1.6).
- [ ] A semantic answer cites the matched records, and the drill-in shows the similarity scores.

### Epic 5 — Copy-on-write + versions + normalize + enum promotion
Immutable source → derived dataset → snapshot/export. Single-sheet normalization (propose/confirm).
Version diff view.

**Acceptance**
- [ ] §12.6 — normalizing produces a **derived dataset** and the source is **byte-identical**
      afterward; export writes the snapshot (`.duckdb` / Parquet / CSV); a version diff reports
      which rows/columns/enums/schema changed.
- [ ] §1.3 — the normalization split is proposed with the detected repetition and candidate keys
      shown, is editable, and takes effect only on confirm.
- [ ] Enum promotion proposes the detected value set and lets the user add values absent from the
      sample.
- [ ] The diff is computed in code, not by the model (§1.5).
- [ ] **§12.11 portability (invariant §1.8).** Export a dataset's data + schema + dictionary +
      dataset definition, re-import into a **clean instance**, and assert the round trip is
      **lossless** — same tables, types, relationships, dictionary entries and row counts.
      Exports are open formats only (Parquet / CSV / SQL); nothing requires Datera to read it.

### Epic 6 — Writes
Per-dataset opt-in write grant. Propose → preview → confirm gate. Transaction + undo. Writes in the
audit trace.

**Acceptance**
- [ ] §12.7 — a write is **never executed without an explicit confirm**; the preview reports the
      exact row count and old→new values; undo reverts within the transaction. All three asserted.
- [ ] Write grants are **off by default**, per dataset, and revocable.
- [ ] A write targeting a *source* is impossible on every path (§1.2, §13).
- [ ] An agent/NL-proposed `DELETE` surfaces at the confirm gate and does not execute — the
      footgun test.
- [ ] Every write appears in the trace/audit log.

### Epic 7 — Serve
MCP over stdio + HTTP/SSE. Local REST API. Auto-generated tools. Per-client connect configs.
The end-to-end serving trace.

**Acceptance**
- [ ] §12.9 (client half) — a served MCP/API request emits a **complete trace covering every hop**
      (agent → transport → server → router → model → engine → data → response).
- [ ] Auto-generated tools exist per dataset: `query_<dataset>`, `search_<dataset>`,
      `describe_schema`; mutation tools appear **only** when a write grant is active.
- [ ] Both transports work: stdio (`datera --mcp --workspace …`) and HTTP/SSE with a local token.
- [ ] Generated connect configs for Claude Desktop / Claude Code / Cursor are valid and load.
- [ ] Read-only remains read-only over the wire: no served request can mutate a source.
- [ ] **§12.9a — the trace log is persisted, bounded and searchable (spec §8a).** With tracing
      on, requests persist to a **queryable log dataset**; **retention prunes** past the
      user-set window; **payload capture is off by default** (assert a trace record contains no
      row data unless explicitly enabled); the log is searchable by **both SQL and NL with the
      SQL shown**; and a deployed server does **not** persist verbose traces by default.
- [ ] No logging or search dependency was added — the log is a DuckDB table queried by Datera's
      own engine (assert the dependency graph, same mechanism as the core purity guard).

### Epic 8 — Datera Server + deploy — **PRIVATE REPO, NOT BUILT HERE**
Tracked here only so the sequence is legible. The deliverable in *this* repo is the client's
ability to drive a remote server (spec §12.10) and to push/promote a dataset — client-side code
only. Auth, scoping, deploy orchestration, licensing, and the Dockerfile/compose/deploy recipes of
§14 live in `datera-server`.

**Acceptance (this repo's half only)**
- [ ] §12.10 — the client runs fully standalone with no server, **and** the same UI drives a
      connected Datera Server. Both paths asserted.
- [ ] The environment switcher (Local / Test / Production) and push/promote UI exist and target a
      server over its public API.
- [ ] No server-proprietary code, secret, or license logic appears in this repo — asserted by a
      CI check, same mechanism as the core-purity test.

### Epic 9 — Teaching module
The data-lifecycle view: one value across layers (table → entity/ORM → business object → DTO →
view → user) plus the NL/semantic/MCP lanes, with the transform and the classic bug at each
boundary. Curated / instructor-defined for v1.

**Acceptance**
- [ ] The lifecycle view renders a curated definition and is authorable without a code change.
- [ ] Each boundary shows its transform and its classic bug (the cents→dollars off-by-100).
- [ ] Live tracing of a user's real application code is explicitly **out of scope** for v1.

---

## C. Phase 1 in detail — tickets

Ordering: P1-01 → P1-03 first (they define the seam), then core capability, then the shell.
Every ticket names the tests that prove it. "Done" means the tests pass, not that the code exists.

### P1-01 — Monorepo scaffold and toolchain
pnpm workspaces; `packages/core`, `packages/testkit`, `apps/desktop`; TypeScript strict + project
references; Vitest; ESLint + Prettier; `.github/workflows/ci.yml` running typecheck + lint + test on
macOS, Windows, Linux.
**Tests:** CI green on all three OSes with a trivial test in each package; `pnpm build` produces
`packages/core/dist` consumable by `apps/desktop` via `workspace:*`.

### P1-02 — Core ports and the `Datera` façade
Define `FileSystem`, `Clock`, `Logger`, `SecretStore`, `Paths` interfaces plus the single public
façade surface. Ship Node implementations in `packages/testkit` (fakes) and `apps/desktop` (real).
**Tests:** the façade is fully exercisable with fake ports and zero filesystem access, except where
a test deliberately uses real files.

### P1-03 — Core purity guard (invariant §1.7 as a test)
An ESLint `no-restricted-imports` rule plus a CI test that walks `packages/core`'s resolved
dependency graph and fails on `electron`, any HTTP server package, or any `apps/*` path.
**Tests:** the guard **fails** when a deliberate violating import is added in a fixture, and passes
otherwise. A guard that has never failed is not a guard.

### P1-04 — DuckDB engine lifecycle
Instantiate an embedded DuckDB, open the workspace database, hand out connections, close cleanly.
Configurable access mode. Surface the DuckDB version in the transparency layer's foundations.
**Tests:** open/query/close with no leaked handles; concurrent connections return consistent
results; reopening an existing workspace file preserves its catalog.

### P1-05 — Extension management, offline-capable
Load the extensions the format set needs (`excel`, `sqlite_scanner`, `postgres_scanner`,
`mysql_scanner`, and the `httpfs` stub reserved for later). Extensions must be **bundled or
pre-staged**, not fetched at first use — invariant §1.6's "works out of the box, nothing uploaded"
does not survive a silent extension download.
**Tests:** every supported format connects successfully with **network egress blocked** by the
testkit guard.

### P1-06 — Read-only enforcement layer
Open source attachments in DuckDB read-only mode; reject statements that would write to a source
catalog; deny `COPY … TO` / `EXPORT` whose target resolves to a source path. This is the
code-level expression of invariants §1.1 and §1.2.
**Tests:** a table-driven suite of write attempts per source kind (file and attached DB) — each
must be rejected with a clear, typed error. Includes attempts that route through `ATTACH`,
`COPY TO`, and `INSERT INTO <attached>`.

### P1-07 — Source model and workspace catalog
The `Source` noun (spec §3): id, kind, display name, origin path/DSN, added-at, connect options.
Persisted in the workspace so it survives a restart. Exactly three nouns — no fourth (§13).
**Tests:** add/list/remove sources; catalog round-trips across an engine restart; a source whose
file has moved reports a clear "unavailable" state rather than throwing.

### P1-08 — Connect + ingest: flat files (CSV / TSV / JSON / Parquet)
Read-only registration of file sources via DuckDB's native readers, with detected delimiter,
header, and encoding surfaced (they are transparency inputs, not hidden magic).
**Tests:** per-format fixtures including a quoted-comma CSV, a ragged CSV, an NDJSON file, a nested
JSON file, and a Parquet file with nulls. Each asserts schema, row count, and preview rows.

### P1-09 — Connect + ingest: Excel
`.xlsx` via the `excel` extension, including multi-sheet workbooks — each sheet is addressable.
**Tests:** a multi-sheet fixture; a sheet with a header row and typed columns; assert per-sheet
schema and row counts. `.xls` (legacy binary) behavior is pinned by decision D-07.

### P1-10 — Connect + ingest: SQLite
Attach a `.sqlite`/`.db` file read-only via `sqlite_scanner`; enumerate its tables as sources.
**Tests:** a multi-table fixture; assert table list, schemas, and that the SQLite file is
byte-identical after querying (feeds P1-14).

### P1-11 — Attach live Postgres / MySQL, read-only
`ATTACH` via `postgres_scanner` / `mysql_scanner` with a read-only connection. Credentials handled
per decision D-06. Connection failures surface as typed, actionable errors — not stack traces.
**Tests:** integration tests against Postgres and MySQL containers in CI; assert table enumeration,
schema introspection, a successful read query, and a **rejected write**. Skipped with a loud
notice, never silently, when containers are unavailable locally.

### P1-12 — Schema introspection and type inference
Per source: columns with DuckDB types, nullability, row count, and a small sample of values. Report
the inferred type *and* the evidence for it — the inference is a transparency surface, and Phase 3's
dictionary auto-draft consumes exactly this.
**Tests:** snapshot assertions per fixture; a column of mixed-type values reports the widened type
and flags the ambiguity rather than silently coercing.

### P1-13 — Paged preview reads
Bounded, offset-based preview of any source. Never loads a whole source into memory to show the
first 50 rows.
**Tests:** preview of a large fixture (≥1M rows) returns within a bounded time and bounded memory;
paging is stable across calls.

### P1-14 — Invariant §1.1 harness: the source is byte-identical
**This is the ticket the phase is judged on.** A reusable testkit assertion capturing, for each
fixture: sha-256 of the bytes, byte length, and mtime — before connect and after
connect + introspect + preview + a representative query (including a join and an aggregate).
Runs across **every** supported source kind: CSV, TSV, JSON, Parquet, XLSX, SQLite, and the
attached Postgres/MySQL (where the DB-side assertion is table contents + row counts + no new
objects, since a live DB has no file hash).
**Tests:**
- `sourceUnchanged(fixture)` asserts all three properties for file sources.
- `databaseUnchanged(conn)` asserts row counts, table list, and checksums per table for attached DBs.
- A **negative control**: a deliberate write to a copy is detected by the same harness, proving the
  assertion can fail. An invariant test that cannot fail proves nothing.
- The harness runs over the full fixture matrix in CI on all three OSes.

### P1-15 — Electron shell scaffold
Main / preload / renderer with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
and a restrictive CSP. Main process owns the single core instance. Vite dev server for the renderer.
**Tests:** the app launches and quits cleanly in CI (headless/xvfb); a test asserts the renderer has
no Node integration and cannot reach the core except through the bridge.

### P1-16 — Typed IPC contract (host ↔ core façade)
One typed contract covering Phase 1's operations: list sources, add source, get schema, preview.
Shaped so a future HTTP implementation against a remote Datera Server can satisfy the same
interface (spec §12.10) without touching the UI.
**Tests:** contract-level tests run against both the in-process implementation and a stub remote
implementation, proving the UI is not coupled to in-process.

### P1-17 — Workspace view
The prototype's Workspace IA: the dataset rail (Phase 1 shows the single implicit dataset — see
decision D-04), the source list with kind badge and row count, schema chips with types, the preview
table, and the read-only badge. Add-source flow: file picker for files, a connection form for
Postgres/MySQL.
**Tests:** component tests for each region against fixture state, including the empty state and the
unavailable-source state.

### P1-18 — Electron native-binding smoke test
Prove `@duckdb/node-api` loads and queries **inside a packaged Electron main process** on macOS and
Windows. Node-API should make this a non-event — but "should" is not a test, and discovering this
at Phase 7 packaging time would be expensive.
**Tests:** a packaged-app smoke test that opens DuckDB, runs `SELECT 42`, and reports the DuckDB
version, run in CI on macOS and Windows.

### P1-19 — End-to-end Phase 1 acceptance
Playwright-Electron: launch the app, add a CSV fixture, see its schema, see preview rows, run a
representative query, quit — then assert the fixture file is byte-identical using the P1-14 harness.
This is §12.1 proven through the real shell rather than in a unit test.
**Tests:** as described, in CI on macOS and Linux (Windows if the runner is stable).

### Out of scope for Phase 1 (named so nobody drifts)
NL→SQL, any model call, embeddings, dictionary, user-created datasets, relationship detection,
copy-on-write, versions, normalize, writes, MCP/REST, environments, the teaching module. The
Workspace view is the only UI; other nav items may exist as disabled placeholders or not at all.

---

## D. Decisions and ambiguities — needed before building

**All 15 resolved on 2026-09-15.** Recorded here as decisions, with the adjustments made at
approval. Where a decision changed from the recommendation, it is marked **ADJUSTED**.

**D-01 — "Portable core": how portable?** Invariant §1.7 says no desktop- or server-specific
dependencies. It does not say browser-capable. `@duckdb/node-api` is a native Node addon and will
never run in a browser.
**Decided:** portable = **any Node ≥20 runtime** (desktop main process, container, CLI). DuckDB
access sits behind a **driver port**; `@duckdb/node-api` serves desktop and server, and
**`duckdb-wasm` is reserved for a later iPad webview shell running the same TypeScript core**. This
is the iPad path, and it is why the core is never rewritten in Rust (spec §2a).

**D-02 — Markdown sources.** Spec §3 scopes v1 to the DuckDB-native set and defers
"Markdown-as-tables"; the prototype's Workspace shows `support_notes.md` as a live source feeding
the semantic path.
**Decided:** honor the spec — **no Markdown in v1**. The Phase 4 semantic fixture becomes a text
column inside a CSV/SQLite source, which exercises the same path. Flagging because the prototype
will look wrong until this is settled.

**D-03 — Does Phase 1 copy data, or read in place?** "Connect/ingest" is ambiguous. Copy-on-write
(§1.2) governs *editing*; a read-only connect needs no copy, and copying a 10GB Parquet on connect
would be a bad first impression.
**Decided:** Phase 1 = **zero-copy** — DuckDB views over the source files, read at query time.
Materialized working copies arrive with datasets and copy-on-write (Phases 3/5), where the spec
actually calls for them. This is a storage-layer decision that is expensive to reverse later.

**D-04 — What does Phase 1's Workspace show, given datasets arrive in Phase 3?** The dataset is the
boundary that governs everything (§3), but dataset management is Phase 3.
**Decided:** Phase 1 creates a **single implicit "Ungrouped" dataset**, implemented as one DuckDB
schema, holding every connected source. The boundary mechanism therefore exists from the first
commit; Phase 3 adds creating, naming, and moving between datasets. The alternative — no dataset in
Phase 1 — means retrofitting the governing boundary, which is how §12.4 gets violated by accident.

**D-05 — Workspace location and on-disk format.** `datera-server` takes `DATERA_WORKSPACE`
(§14.1), so the layout is a cross-repo contract.
**Decided:** a **portable workspace directory** — `workspace.duckdb` (catalog, dataset schemas,
later the derived copies) plus a small `workspace.json` (format version, provenance). Default
location `~/Library/Application Support/Datera/workspaces/<name>` on macOS and the platform
equivalents elsewhere, but any directory may be opened. Copying the directory to a server must be
sufficient to serve it.

**D-06 — Where do Postgres/MySQL credentials live in Phase 1?** Secure key storage is scheduled for
Phase 2 (§11.2) but P1-11 needs credentials in Phase 1. Spec §9 forbids plaintext config for model
keys; DB credentials deserve no less.
*Recommend:* pull the OS-keychain `SecretStore` forward into Phase 1 (it is small) and store DB
credentials there from the start. *Alternative if you prefer to keep Phase 1 thin:* Phase 1 accepts
credentials per session in memory only, and connections are re-entered after a restart. Please pick
— I will not write a credential to a config file either way.

**D-07 — Excel scope.** DuckDB's `excel` extension reads `.xlsx`.
**Decided:** **`.xlsx` only** in v1; `.xls` (legacy binary) is rejected with a clear message telling
the user to re-save. Confirm no `.xls` requirement exists for the classroom use case.

**D-08 — The bundled local model: which one?** Spec §9 requires a bundled small model for NL→SQL
plus a small local embedder, working with no key and no network. This is a Phase 2 concern but it
determines installer size and the packaging approach, and packaging is set up in Phase 1.
**Decided:** `node-llama-cpp` with a compact (~1–3B) instruct model for chat and a small local
embedder. **Weights are fetched on first run**, not shipped in the installer — the installer stays
light and first run needs the network once. The "nothing uploaded" promise is about *data*, not
about never downloading a model. Phase 1's only obligation is that packaging does not preclude this.

**D-09 — License.** `LICENSE` is already **Apache-2.0** and `NOTICE` claims trademarks for ProdXP,
LLC. Spec §2 said "permissive or fair-source"; the marketing site says "MIT-spirited, source on
GitHub."
**Decided:** Apache-2.0 stands (it is committed, and its patent grant is the better choice here).
The **marketing copy needs correcting** — "MIT-spirited" is inaccurate for an Apache-2.0 project.
Flagging, not fixing, since the site is outside this plan's scope.

**D-10 — Renderer framework.** The spec is silent; the prototype is vanilla JS with hand-written CSS.
**Decided:** **React + Vite + TypeScript**, with the prototype's CSS custom properties lifted
verbatim as design tokens and plain CSS modules over them. The prototype's visual language survives
intact; we get components and testability for the transparency drawers, which are the most stateful
UI in the product. Say the word if you want the vanilla approach preserved.

**D-11 — The `datera` CLI.** Spec §8 invokes `datera --mcp --workspace …`, so a binary named
`datera` must exist by Phase 7, and it is a host, not part of the desktop app.
**Decided:** reserve `packages/cli` now, binary named **`datera`**, built in Phase 7, in this
public repo.

**D-12 — How strictly is "no network egress" (§12.8) tested?**
**Decided:** a testkit guard that stubs Node's network primitives and **fails the test** on any
outbound connection attempt during a local-model run — not a manual observation. Phase 1 uses the
same guard for P1-05 (extensions must not download).

**D-13 — Remote-control code in the public repo.** §12.10 requires the client to drive a Datera
Server, and the prototype has an Environments view with push/promote. That client-side code is
client code and belongs here; the server it talks to does not.
**Confirmed correct:** the client's remote **client** code lives here
and speaks only to the server's public API. Nothing about auth issuance, scoping enforcement,
deploy orchestration, or licensing appears in this repo.

**D-14 — Target platforms and CI.** Marketing promises Mac and Windows. DuckDB bindings and Electron
both support Linux, and the server is Linux.
**Decided — ADJUSTED:** ship **macOS (arm64 + x64), Windows (x64), and Linux**. Linux is a real
target for this audience, not just a CI runner; the support commitment is accepted. CI runs all
three. iPad is deferred to the webview + `duckdb-wasm` path in spec §2a.

**D-15 — Tickets as GitHub issues.** The repo is `prodxpdev/datera` with issues enabled, and `gh` is
authenticated. Creating ~28 issues in a public repo is visible and awkward to undo, so I have not
done it.
**Decided:** create them. The repo is public and the project is built in public, so visible issues
are a feature. 9 epic issues + 19 Phase 1 issues, labelled by phase.

---

## E. What happens on approval

Phase 1 only — tickets P1-01 through P1-19, with their tests — then an honest report against the
Epic 1 acceptance criteria, naming anything that is scaffolding rather than working.


---

## F. Amendments made at approval (2026-09-15)

**F-1 — Language and shell settled in the spec (§2a).** TypeScript core, Electron desktop. Not
Rust, not Tauri. iPad is reached later as a **webview shell running the same TypeScript core with
`duckdb-wasm` behind the DuckDB driver port** — which is why the driver port (D-01) is a Phase 1
structural requirement and not a nicety. Spec §2a was written to record this and supersedes any
copy of the spec that says "Tauri v2" or "Rust core."

**F-2 — Spec §9 rewritten to three provider tiers.** This plan predated the three-tier model, so
§9 was replaced wholesale:
1. **Bundled local** (default; no key, weights fetched on first run — D-08).
2. **Detected local runtimes** — Ollama (`:11434`, `GET /api/tags`, OpenAI-compatible `/v1`),
   LM Studio (`:1234`), and one generic OpenAI-compatible endpoint path. Detection is best-effort
   and non-blocking: short-timeout probes, never hangs, never hard-fails, never lists a runtime that
   is not running.
3. **Remote BYO key** — Anthropic / OpenAI, keys in the OS keychain.

Chat and embedding models are chosen separately; embeddings stay local by default even on remote
chat. **The transparency stage and the serving trace must name the exact model**, tier, and
locality. Small local models write weaker SQL — stated once, where the choice is made, because it
is exactly why the dictionary and the visible-SQL confirm gate matter more on those tiers.
**Datera Server takes its provider from environment config and never auto-detects** — these are two
separate mechanisms, and a server that port-scans its own container for an Ollama is wrong.

This lands in **Epic 2**, whose acceptance criteria were extended accordingly. Phase 1's only
obligation is to not preclude it: the model layer is a `packages/core/src/models/` directory with
no implementation yet.

**F-3 — Linux is a shipping desktop target**, not just a CI runner (D-14).

**F-4 — `SecretStore` pulled forward into Phase 1** (D-06), so P1-11's database credentials go to
the OS keychain from the first commit rather than living in memory. This adds ticket **P1-20**.

### P1-20 — `SecretStore` on the OS keychain *(added at approval, D-06)*
Implement the core's `SecretStorePort` and a desktop implementation over Electron `safeStorage`
(macOS Keychain, Windows DPAPI, Linux libsecret/kwallet). Postgres/MySQL credentials from P1-11 are
written here, never to `workspace.json`, never to a log. The port shape must also suit Phase 2's
model keys so it is not rebuilt.
**Tests:** a stored credential round-trips; the workspace directory and the log stream are asserted
to contain **no** credential substring after a full connect + query cycle; a fake `SecretStore` in
testkit lets every other test run without touching the real keychain; `safeStorage` unavailability
(headless Linux CI with no keyring) degrades to a clear typed error rather than a silent plaintext
write.


---

## G. Amendments — update 02 (2026-09-15): portability, author-from-intent, platform non-goal

Spec updated first (it is the source of truth), then reflected here. **Phase 1 scope change:
one ticket, P1-21.** Assessed as not material — see G-5.

**G-1 — New invariant §1.8: no lock-in, and it's provable.** Everything exports in open,
portable forms: data (Parquet/CSV/SQL), schema, dictionary, dataset definitions, and — where
Datera generates a backend — the backend as runnable source the user owns. The guarantee is
**"delete Datera and your artifact still runs."** It is an invariant rather than a tagline
because it has to be *tested*: a portability promise nobody executes is one that quietly stops
being true.

**G-2 — New acceptance criterion §12.11.** Export a dataset's data + schema + dictionary +
dataset definition, re-import into a clean instance, assert the round trip is lossless. Once
generation exists, additionally assert the generated backend runs with Datera uninstalled.
**Where it lands:** the dataset/dictionary round trip belongs with **Epic 5** (copy-on-write and
export), because that is where the exports it tests first exist. Epic 5's acceptance criteria
are extended accordingly; the generated-backend half lands with generation, which is
unscheduled.

**G-3 — Spec §3a: two equal entry paths.** A source is one *populator* of a dataset, not the
*definition* of one. Data enters either by connecting a source or by **authoring from intent** —
declared tables/columns/types/relationships, SQL DDL, pasted JSON, or an AI-generated schema.
Both converge on the same internal model. The authoring UI, AI-schema import, and code
generation are **later-phase and explicitly not Phase 1**.

**G-4 — Spec §10 / §13a: push-to-hosted means deploying an owned artifact.** "Push to a hosted
environment" deploys a portable artifact **the user owns onto infrastructure the user
controls**, and it keeps running without Datera. Datera is **not** a hosted multi-tenant
application platform or BaaS — recorded as an explicit non-goal so that platform apparatus
(multi-tenant auth, hosted tenancy, per-end-user management) stays out of the build. The
sanctioned expansion is exactly: **author-from-intent → generate-an-owned-backend →
deploy-to-your-own-infra.** Datera is the workshop and the ship button, not the tenancy.

**G-5 — Phase 1 scope impact: P1-21 only, and it is small.** Assessment as requested rather than
absorbed silently: the seam needed a `relationships` table in the catalog, a structural
`defineTable`/`defineRelationship`/`createDataset` path, and generalising introspection from
"describe this source" to "describe this relation". That last one was the only change that
touched existing code, and it *simplified* it — `introspectSource` now delegates to a
name-addressed `introspectRelation`. Roughly 200 lines plus tests, no rework of anything
already built. **Not material; built rather than re-surfaced.** If it had required reworking the
source/catalog model, the answer would have been different.

### P1-21 — The author-from-intent seam *(added by update 02, spec §3a)*
Extend the core model so a dataset and its tables, columns, types and relationships can be
created **directly and programmatically, with no source attached**. Structural DDL/catalog
authoring in the workspace — explicitly **not** the gated data-write path of §6, which governs
changing rows. No UI, no AI-schema import, no codegen.
**Tests (`packages/core/test/authoring.test.ts`):** create a dataset with nothing connected;
define a typed table and introspect it back with constraints intact; define a relationship and
reject one naming a column that does not exist; prove an authored table is queryable exactly as
a connected source is and is subject to the same read-only guard; survive a restart; reject a
column type rather than interpolating it into DDL; keep authored datasets in separate schemas
so the §12.4 boundary holds for them too.

---

## H. Amendments — update 03 (2026-09-15): the scope filter

A **scope-and-identity correction that removes future scope**. **No Phase-1 change** —
confirmed, and nothing already built was touched.

**H-1 — Spec §0.1: the category.** Datera is a **running, local-first, transparent data tool**,
not an application or code generator. A coding assistant generates code and is done; Datera *is
the thing that runs, answers, and shows its work.* The north star is **education and
visibility** — the teaching value is the product identity, not a side benefit.

**H-2 — Spec §0.2: the scope filter, now the governing test for every future feature.**

> Does it make the running, transparent, local-first data tool better — or does it make Datera a
> worse version of a general coding assistant?

If a feature's honest pitch is "like [a coding assistant], but…", it is the wrong feature.

**H-3 — Spec §13b: integrations/OAuth generation is deferred, as one line, not a plan.** No
design note, no architecting toward it, no phase shaped by it. Reasons recorded in the spec so
the boundary holds when it is re-proposed: it competes where Datera loses, it is the heaviest
maintenance surface, it is furthest from the runtime core, and it worsens the cost story.

**H-4 — What explicitly stays:** Phases 1–7 unchanged; Datera Server / self-host / push-to-own-infra
is on-mission; and the §3a author-from-intent seam stays exactly as built in P1-21. Pasting a
schema to get a live, queryable, transparent backend is Datera being itself with a new front
door. Generating someone's Stripe integration is not adjacent to that.


---

## I. Amendments — update 04 (2026-09-15): the traffic-flow log viewer

Lands with **Epic 7 (serve + trace)**, as an extension of the trace that phase already builds.
**No Phase-1 change** — confirmed; it depends on a trace that does not exist yet.

**I-1 — Spec §8a.** Persist the end-to-end trace records Datera already generates, and make them
queryable over time. Passes the §0.2 scope filter: a coding assistant cannot show traffic
flowing through your stack because it is not present when the traffic happens. Datera is the
runtime. This is **not** a new observability product.

**I-2 — The governing design rule: logs are a dataset.** Trace records land in a DuckDB table and
are searched with the same NL→SQL, visible cited SQL and transparency as any other source.
Datera observes itself with its own tools. **No logging or search dependency** — no bundled
Elasticsearch, Loki or OpenSearch. Adding one would mean building a second, worse query stack
beside the good one. Epic 7's acceptance now asserts this against the dependency graph, using
the same mechanism as the P1-03 purity guard.

**I-3 — Record content is split, deliberately.** Always stored: timestamp, dataset, route,
model provider and name, per-hop timings, latency, token/cost, success/failure, and the
generated SQL. Opt-in only: raw arguments, result rows or samples, retrieved chunk text —
**off by default**, so the log does not quietly become a second copy of the user's data. What a
trace record contains is stated plainly in-product.

**I-4 — Retention is bounded and the user's.** Rolling N days and/or N megabytes, auto-pruned,
never unbounded. On a deployed Datera Server the default is **off or minimal**, under the same
per-token/per-dataset scoping, with its own retention policy.

**I-5 — The viewer reuses the drawer.** A searchable request list; clicking a row opens the exact
hop-by-hop trace drawer already built for a single answer. One record is the existing glass box,
many records are a searchable table over them.

**I-6 — The hard scope line, recorded because it is the one that will erode.** This observes
**Datera's own stack traffic only**. Not a general log ingester for external application logs —
parsing other systems' logs is the drift toward a Datadog-shaped product. **Datera observing
Datera: in. Datera as a general log platform: out.**

**I-7 — Teaching payoff.** After a week, a student can search their own query history: what went
semantic versus SQL, what the model cost, where the slow ones spent their time. The single trace
teaches one request; the log viewer shows patterns across many.


---

## J. Delivered — all nine phases

Built in order, test-first from Phase 2 onward. Each phase committed separately with its
acceptance criteria reported honestly.

| Epic | Acceptance | State |
|---|---|---|
| 1 Core foundation | §12.1 byte-identity across every format | ✅ with a negative control |
| 2 Querying + transparency | §12.2 cited SQL, no rows to model · §12.3 flag not fabricate | ✅ |
| | §12.8 bundled model, no key, no egress | ❌ **tier 1 not built** — [#32](https://github.com/prodxpdev/datera/issues/32) |
| 3 Datasets + dictionary | §12.4 cross-dataset join blocked · §1.3 propose-then-confirm | ✅ |
| 4 Semantic path | §12.5 routing per fixture · top-k only to the model | ✅ |
| 5 Copy-on-write | §12.6 derived dataset, source untouched · §12.11 lossless round trip | ✅ |
| 6 Writes | §12.7 never without confirm · exact counts · undo | ✅ |
| 7 Serve | §12.9 complete trace · §12.9a bounded searchable log | ✅ |
| 8 Server + deploy | §12.10 standalone **and** same interface drives a remote | ✅ client half |
| 9 Teaching module | curated lifecycle, authorable without a code change | ✅ |

### The one gap

**§12.8 is not met.** The bundled local model does not exist: no weights ship, no local
inference runs. Everything around it does — the three-tier architecture, selection,
persistence, exact model naming in traces, cost accounting — so adding it is one new
`ChatModel` implementation. The offline half of §12.8 *is* met and tested: the core cannot
reach the network unless a host hands it an `HttpPort`, and the whole connect path runs with
egress blocked.

### Deliberately not built here

**Datera Server** (Epic 8's substance). Auth, per-token and per-dataset scoping, deploy
orchestration, licence enforcement and tenant isolation belong to the private repo by §2.
A test now fails if any of those concerns appear in this repository, with a negative control
proving the check works.

### Bugs found by tests that would otherwise have shipped

Recorded because they are the argument for the approach, not decoration:

1. **A credential leak** — DuckDB echoes the connection string, password included, in ATTACH
   failures; it flowed into error messages and would have reached logs and UI toasts.
2. **`DELETE` reported as "no SQL produced"** — the extractor filtered writes out, hiding the
   §6 teaching moment entirely.
3. **Extension resolution** wrong outside the test harness, because the test pinned the
   variable it was meant to exercise. The app silently loaded no extensions.
4. **Layout overflow** unreachable, not merely ugly — `1fr` refusing to shrink while the page
   did not scroll.
5. **Retention pruning** compared an injected clock against DuckDB's, deleting everything.
6. **Guard ordering**, twice — a write reported as a scoping failure, and a cross-dataset
   write reported as a bind failure.

### Follow-ups filed

- [#31](https://github.com/prodxpdev/datera/issues/31) — XLSX sheet enumeration (DuckDB exposes no sheet-listing function)
- [#32](https://github.com/prodxpdev/datera/issues/32) — the bundled local model
- [#33](https://github.com/prodxpdev/datera/issues/33) — cold local models: 45s with no feedback, and a flat timeout that a 32b model exceeds
