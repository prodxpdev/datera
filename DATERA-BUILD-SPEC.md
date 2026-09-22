# DATERA — build specification (Claude Code kickoff)

**Paste target:** Claude Code, operating on two repos:
- `datera` — public, open-source. The client app **and the shared core engine**.
- `datera-server` — private, proprietary. The deployable server, built on the core.

**Companion:** the navigable prototypes (`datera-app-prototype.html`, `datera-marketing-site.html`). They show the intended UX; this document is the source of truth for behavior.

**Read this whole file first. Then propose a build plan as tickets/issues before writing code — do not start implementing until the plan is confirmed.** Match verbs to reality (don't claim "done" for scaffolding). Every phase ships with tests.

---

## 0. What Datera is

A **local-first, bring-your-own-key desktop tool that makes any local data queryable, understandable, and shareable — and shows exactly what it does at every step.** You connect spreadsheets, files, and databases; ask in natural language or SQL; get cited answers; and can see the whole pipeline (parse → schema → generated SQL or embeddings → model call → rows → cost). It exposes your data over MCP and a local API. Its identity is **transparency** — nothing is a black box — which makes it both trustworthy and a teaching tool for data/database courses.

### 0.1 What Datera is — and the category it is not in

**Datera is a running, local-first, transparent data tool. It is not an application or code
generator.** Its value is being the **runtime**: the thing that connects to messy data,
understands it, answers with visible cited SQL, shows exactly what the AI did, teaches with
that, and serves the result over API + MCP. A coding assistant generates code and is done.
Datera *is the thing that runs, answers, and shows its work.* Different category.

**The north star is education and visibility.** Datera is a **foundation for learning and
working with databases and data access, with visibility into how it all works** — see the SQL,
see the rows it touched, see the layers, see the NL / semantic / MCP lanes. That teaching value
is not a side benefit bolted onto a data tool; it **is the product identity**, and it is exactly
what a general coding assistant does not provide. It is also a more defensible place to stand
than full application authoring.

### 0.2 The scope filter — apply this to every proposed feature

> **Does it make the running, transparent, local-first data tool better — or does it make
> Datera a worse version of a general coding assistant?**

If a feature's honest one-line pitch is *"like [a coding assistant], but…"*, it is the wrong
feature and it does not belong in Datera. This test governs everything added from here on, and
it is the reason for the deferral in §13b.

Two shipped pieces:
- **Datera (client)** — full-featured, runs standalone on a laptop, and doubles as the control-plane UI for remote servers. Open source.
- **Datera Server** — the same core, headless, deployable to a container/VM/cloud, exposing API + MCP to other people. Proprietary, paid.

---

## 1. Non-negotiable invariants (these are correctness, not polish)

1. **Read-only by default.** Datera reads sources; it never writes to them unless writes are explicitly enabled on a dataset (§6). The connected database or file is never mutated by a read.
2. **Copy-on-write. The original is sacred.** All editing/modeling/writing happens on a *derived copy*, never the source file or the source database. "Operate on a copy, export the copy."
3. **The model proposes; a human confirms.** Schema relationships, normalization splits, dictionary meanings, and every write mutation are *proposed* by the model and *ratified* by a human before they take effect. Never auto-execute a mutation.
4. **Show the work — transparency is the product.** For any answer, the user can inspect: the parse, the inferred schema, the routing decision (structured vs semantic), the generated SQL (or the embeddings + similarity), exactly what was sent to the model (schema/definitions/text — never silently the raw data), the rows touched, and the token/cost. For any served request, a full end-to-end trace (agent → transport → server → router → model → engine → data → response) that **doubles as the audit log**.
5. **Deterministic where facts matter.** Grouping, routing, SQL execution, joins, version diffs, row counts, and timings are computed in code, not by the model. The model writes SQL and prose over facts the engine supplies; prose referencing data with no backing query/rows is discarded. Never fabricate a value, a column, or a citation.
6. **BYO-key, with a bundled local default.** Works out of the box with a bundled local model (no key, nothing uploaded). Users can configure their own Anthropic/OpenAI key for stronger NL→SQL. Chat model and embedding model are chosen **separately**; embeddings default to local even when chat is BYOK.
7. **Portable core.** The engine (DuckDB, NL→SQL + embeddings, transparency, datasets, dictionary, copy-on-write, MCP/API definitions) is a standalone library in the `datera` repo with **no desktop- or server-specific dependencies**. The desktop client and Datera Server are thin hosts on top of it. Decide this on the first commit; do not bake the engine into the desktop app.
8. **No lock-in, and it's provable.** The user is never trapped in Datera. Everything leaves in open, portable forms: **data** (Parquet / CSV / SQL), the **schema**, the **dictionary**, the **dataset definitions**, and — where Datera generates a backend — **the backend as runnable source the user owns**. The guarantee, stated plainly: **delete Datera and your artifact still runs.** This is an invariant rather than a marketing line because it must be *tested* (§12.11), not asserted: a round-trip export/re-import must be lossless, and a generated backend must run with Datera uninstalled. Any feature that can only be used from inside Datera, or that produces an artifact Datera alone can read, violates this.

---

## 2. Architecture: one core, two hosts, two repos

- **`datera/core`** (public) — the portable engine library. Everything in §1.7. This is the open value.
- **`datera/desktop`** (public) — the desktop client shell. **Electron for v1** (fastest to ship, Node ecosystem you already work in). Wraps the core; adds the UI (the prototype's IA). See **§2a** for how iPad is reached without a rewrite.
- **`datera-server`** (private) — headless host on the same core, exposing API + MCP over HTTP/SSE, plus the proprietary layer: auth, per-token/per-dataset scoping, deploy orchestration, license enforcement, multi-tenant isolation. **Depends on the public core; adds nothing the core already does.**

### 2a. Language and shell — decided, and how iPad is reached

- **The core is TypeScript.** Not Rust. A Rust core would buy a cross-language boundary that we
  would pay for on *every transparency payload* — and the transparency payload is the product.
  One language across core, desktop, CLI, and `datera-server` means no FFI seam anywhere.
- **The desktop shell is Electron.** Not Tauri.
- **iPad/iOS is reachable later without a rewrite**, via the DuckDB driver port required by §1.7: a **webview
  shell** (Capacitor, or Tauri-mobile as a webview host only) running **the same TypeScript core**
  with **`duckdb-wasm` behind the DuckDB driver port**. `@duckdb/node-api` serves desktop and
  server; `duckdb-wasm` serves the tablet. The core above the port does not change.
- **Therefore: never a Rust core, and Tauri is not the desktop plan.** If any copy of this
  specification says "Tauri v2" or "Rust core," that edit was wrong — this section supersedes it.
- **Shipping desktop targets for v1: macOS (arm64 + x64), Windows (x64), and Linux.** Linux is a
  real target for this audience, not merely a CI runner. CI runs all three.

**On-mission check (§0.2) for the two hosts.** The client is the runtime on a laptop; Datera
Server is the same runtime somewhere the user controls. Running a served, traceable backend on
your own infrastructure is not something a coding assistant does, so both sit inside the scope
filter rather than needing an exception to it.

**Licensing:** `datera` under a permissive or fair-source license (LICENSE in the first public commit). `datera-server` proprietary / source-available with a **no-reselling-as-a-hosted-service** clause. Keep secrets and server-proprietary internals out of the public repo entirely (two repos, not a monorepo, precisely to keep this boundary clean).

---

## 3. Data model — the spine (everything keys to this)

Three nouns, no more (resist a fourth):

**Source (immutable input).** A connected file or database Datera reads read-only. Never mutated. CSV / TSV / JSON / Excel / Parquet / SQLite via DuckDB natively or via extensions; live Postgres/MySQL via DuckDB attach. (XML and Markdown-as-tables are later; scope v1 to the DuckDB-native set.)

> **A source is one *populator* of a dataset, not the *definition* of one.** See §3a: a dataset can be authored into existence with no source attached at all. Do not build anything that assumes a dataset originates from a file — that assumption is the thing §3a exists to prevent.

**Dataset (a working, scoped copy).** A named group of related sources that belong together. **The one boundary that governs everything:** join scope, query scope, write permission, transaction scope, and version scope. Implement each dataset as **its own DuckDB schema (or attached database)** — so sources in a dataset join naturally, sources in *different* datasets can never be joined by accident, and the NL→SQL model is only ever shown the active dataset's schema (better quality, no nonsense joins). A dataset holds: its member sources (as read-only copies), detected+confirmed **relationships** (foreign-key-like links), and a **dictionary** (§4). Unrelated files live in separate datasets or ungrouped — explicitly *not* joinable.

**Version (a named snapshot of a dataset).** Because the source is immutable and edits land on a copy, a version is just a copy at a point in time. Save = snapshot; export = write that snapshot out (`.duckdb` / Parquet / CSV). Versioning, non-destructive editing, and backup are **one mechanism** (copy-on-write), not three features. "Compare to original / previous version" is a visible diff (which rows/columns/enums/schema changed). For live connected databases, "operate on a copy" means pulling a working snapshot into Datera — Datera does not version someone's production Postgres.

---

### 3a. Two equal entry paths — connect a source, or author from intent

Data enters Datera two ways, and **both are first-class**. They converge on the same internal
model (datasets, tables, columns, types, relationships, dictionary) and feed the same query,
serve, and transparency machinery.

1. **Connect a source** — the path in §3. You have data; Datera reads it.
2. **Author from intent** — you have a *shape in mind* and no data yet. Define the model
   directly: declare tables/columns/types/relationships in the UI, write SQL DDL, paste JSON,
   or drop in an **AI-generated schema** ("ask Claude or ChatGPT for a schema for X" → paste
   it). Datera turns that into the same dataset, dictionary and relationships a connected
   source would have produced.

The second path is what makes Datera a tool for *building* something rather than only for
inspecting what already exists — and it is the front half of the sanctioned expansion in §13a:
**author-from-intent → generate-an-owned-backend → deploy-to-your-own-infra.**

**Phasing — read this before building anything here.** Authoring is a **later-phase
capability**; it needs the write path (§6) and the serve path (§8) underneath it. **Do not
build the authoring UI, AI-schema import, or code generation in Phase 1.**

**What Phase 1 owes it is a seam, not a feature** — the same kind of structural decision as
the ports and the DuckDB driver port (§1.7, §2a). Concretely: the core data model must let a
dataset and its tables/columns/types/relationships be **created and defined directly and
programmatically**, with **no source attached**. Phase 1 already creates an empty schema for
the implicit "Ungrouped" dataset; the model must extend to authoring schema objects into a
dataset that has no source. Phase 1 proves this with a core-level test — create a dataset,
define a typed table and a relationship with nothing connected, introspect it back — and **no
UI**. Keep the implementation minimal; it exists to prove the model is not coupled to
"a dataset comes from a file."

**This is structural (DDL/catalog) authoring inside the workspace, and it is not the gated
data-write path of §6.** Defining that a `customers` table exists is not the same act as
changing 1,203 rows in one, and the confirm-preview gate belongs to the second. Keep them
separate or the §6 gate will end up guarding schema edits and not the writes it was built for.

## 4. Dictionary — the semantic layer

Per source within a dataset: an **entity definition** (what it is, grain, primary key) and per-**column** metadata: a plain-language **meaning**, **aliases** for NL ("sales, rev" → `revenue_cents`), **unit/format** (`cents → USD ÷100`), **role** (measure / dimension / id / time / flag / text), **sensitivity** (normal / hide-from-NL), and **enum value meanings** for categorical/boolean columns.

- Datera **auto-drafts** this from column names, types, and sample values; the user **confirms** each (propose-then-confirm). State per item: confirmed / suggested / undefined.
- The dictionary is **injected into the model's context** for NL→SQL and semantic search, and the injection is **visible in the transparency drawer** (the model stage shows the definitions it was given). Vague/missing meanings are the top cause of bad NL→SQL — this layer is the fix.

---

## 5. Query & transparency

**Routing.** Structured questions (aggregations/filters over columns) → **NL→SQL** over the dataset schema, no embeddings. Free-text meaning-match → **semantic search** (embed the query, cosine search over embedded text columns). The router's choice and reason are shown.

**Structured path:** model generates DuckDB SQL from schema + dictionary + question; the SQL is **shown before it runs**; executed read-only locally; results returned **with citations** (which columns/rows). Only schema + dictionary + question go to the model — never raw data rows.

**Semantic path:** chunk + embed text columns; store vectors in DuckDB (VSS/HNSW); retrieve top-k by cosine; only the retrieved chunks (not the whole corpus) go to the model; answer cites the matched records.

**"What it touched" drill-down.** For any answer, visualize the physical data touched: for a spreadsheet, the **columns read + rows matched** (with the filter that matched them); for a database/join, the **tables + columns involved with their role** (join key / filter / group-by / aggregate) and the **join path**.

**Data-lifecycle teaching module.** Follow one value across layers (table → entity/ORM → business object → DTO → view → user) plus the NL/semantic/MCP lanes, with the transform and the classic bug at each boundary. Curated/instructor-defined for v1 (live tracing of a user's real app code is a later phase).

---

## 6. Write operations (opt-in, gated, per dataset)

Writes are an **explicit, per-dataset, revocable grant — off by default.** Two tiers by blast radius:

- **v1 (safe, buildable):** writes to a **derived dataset** (copy-on-write) — never the source. Every mutation: model **proposes** the change → Datera **previews** it (the generated `UPDATE`/`INSERT`/`DELETE`, the exact rows matched, old→new values, the count: "this will change 1,203 rows") → human **confirms** → executed inside a **transaction** with **undo**. Every write is in the trace/audit log.
- **Later (higher risk, deliberate):** write-back to a live connected database, and write grants over a deployed Datera Server. On the server, write grants are **per-dataset AND per-token, off by default**, and agent-proposed mutations **surface for human approval, never auto-execute** (an NL/agent `DELETE` from a fuzzy instruction is a footgun; the confirm gate defuses it).

The confirm-preview gate *is* the safety mechanism and the teaching moment ("the AI tried to delete everything and the gate caught it").

---

## 7. Normalize — flat sheet → relational

Loading a sheet as a table is trivial (DuckDB). The valuable feature is **normalization**: detect that one flat sheet is really several entities (repeating `customer_email`+`name` → a Customer entity; repeating product/category → Product), **propose** the split into tables with foreign keys, show the **repetition it detected** and the candidate keys, let the user **edit and confirm**, then generate the modeled tables — as a **derived dataset** (source untouched). Includes **enum promotion**: detect a column's small value set, propose promoting it to a defined enum, and let the user add values that *should* exist but aren't in the sample. v1 = **single-sheet** normalization, proposed-and-confirmed; multi-sheet reconciliation is a later phase.

---

## 8. Serve — API + MCP

The core exposes the active dataset(s) as:
- An **MCP server** — two transports: **stdio** (agent launches `datera --mcp --workspace …`) and **HTTP/SSE** (serves a URL + bearer token; used locally and by Datera Server). Auto-generated tools: `query_<dataset>(sql)`, `search_<dataset>(text,k)`, `describe_schema(source)`, and (when write is granted) gated mutation tools.
- A local **REST API** — same capabilities over HTTP with a local token.
- Per-client connect config generated for Claude Desktop / Claude Code / Cursor.

Every served request produces the end-to-end **trace** (§1.4) = the audit log.

### 8a. The traffic-flow log viewer — persisted, searchable traces

Datera already generates the end-to-end hop record (agent → transport → server → router → model
→ engine → data → response) that §14 calls the audit log. This **persists those records and
makes them queryable over time.** It passes the §0.2 scope filter cleanly: a coding assistant
cannot show traffic flowing through your stack, because it is not present when the traffic
happens. Datera is the runtime, so this is the runtime doing more of the only thing a runtime
can do. It is **not** a new observability product.

**The governing design rule: logs are a dataset, queried by Datera's own engine.** Trace records
land in a DuckDB table and are searched, filtered and aggregated with the same NL→SQL, the same
visible cited SQL, and the same transparency as any other source. *Datera observes itself with
its own tools.*
- **Do not add a logging or search dependency** — no bundled Elasticsearch, Loki, or OpenSearch.
  The engine already does this, and adding one would be building a second, worse query stack
  next to the good one.
- "Show every request that hit the orders dataset and took over 500ms yesterday" is just a query
  over the log table, with the SQL shown like anything else.

**Record content — the privacy-sensitive split, and it is deliberate.**
- **Always stored (shape + metadata):** timestamp, dataset, route (structured / semantic), model
  provider and name, per-hop timings, total latency, token and cost, success/failure with the
  error, and the generated SQL. This is what makes the flow history searchable.
- **Opt-in only (payloads):** raw arguments, full result rows or row samples, and retrieved chunk
  text. **Off by default.** Someone actively debugging turns it on; otherwise **the log must not
  become a second copy of the user's data** — which would quietly undo the local-first,
  minimum-exposure posture the rest of the product maintains. State plainly, in-product, what a
  trace record actually contains.

**Retention — bounded, and the user's choice.** A retention window the user sets (rolling N days
and/or N megabytes), with old records rolling off automatically. **Never unbounded** — an
audit log that grows forever becomes both a disk problem and a liability.

**On a deployed Datera Server the default is off or minimal.** Persisting other people's request
data is opt-in-to-verbose, governed by the same per-token/per-dataset scoping as everything
else, with its own retention policy. Do not persist verbose traces on a server by default.

**The viewer — reuse, do not reinvent.** A searchable request list (filter and sort by dataset,
model, latency, cost, error, route) where **clicking any row opens the exact hop-by-hop trace
drawer already built for a single answer.** One record is the existing glass box; many records
are a searchable table over them. Because it is a dataset, the search is largely free.

**Hard scope line — write this down because it is the one that will erode.** This observes
**Datera's own stack traffic only.** It is **not** a general log ingester for arbitrary external
application logs. The moment it parses other systems' logs it drifts toward a general
observability/APM tool, which is a different and much heavier product. **Datera observing
Datera: in. Datera as a general log platform: out.**

**The teaching payoff** (§0.1): after a week of use a student can **search their own query
history** — which questions went semantic and which went to SQL, what the model cost, where the
slow ones spent their time. The single-request trace teaches how one request works; the log
viewer shows the patterns across many. Same "visibility into how it all works" identity,
extended across time.

---

## 9. Models — three provider tiers

Chat model and embedding model are chosen **separately**, always. Embeddings default to **local**
even when chat is a remote BYO key (invariant §1.6).

**Tier 1 — Bundled local (the default).** A small instruct model for NL→SQL plus a small local
embedder. No key, no account, no data uploaded. The right default for a classroom and for private
data. Weights are **fetched on first run** to keep the installer light; that one download is the
only network the local tier ever needs. The "nothing uploaded" promise is about *your data*, not
about never downloading a model.

**Tier 2 — Detected local runtimes.** Datera **auto-discovers models already installed on the
machine** and lists them alongside the bundled default:
- **Ollama** — probe `:11434`, enumerate via `GET /api/tags`, call through its OpenAI-compatible
  `/v1` surface; embeddings via an installed embedding model (e.g. `nomic-embed-text`).
- **LM Studio** — probe `:1234`, same OpenAI-compatible shape.
- **Any OpenAI-compatible endpoint** — one "custom endpoint (+ optional model list)" path covers
  llama.cpp servers, vLLM, LocalAI, and anything else speaking that protocol.

Detection is **best-effort and non-blocking**: probe with a short timeout, never hang the UI, never
hard-fail, and **never list a runtime that is not currently running**. A runtime that disappears
between selection and use produces a clear error, not a silent fallback to a different model.

**Tier 3 — Remote BYO key.** Anthropic or OpenAI with the user's own key, for stronger NL→SQL on
messy schemas. Keys are stored in the **OS keychain**, never in plaintext config, never logged.

**Requirements across all three tiers**
- **The transparency stage and the serving trace must name the exact model**, including its tier and
  locality — e.g. `Ollama · llama3.1:8b (local · :11434)`, `Anthropic · claude-sonnet-4-5 (remote ·
  your key)`, `Bundled · qwen2.5-coder-1.5b (local)`. "The local model" is not an acceptable trace
  entry; a trace that cannot tell you which model wrote the SQL is not an audit log.
- **State the quality trade-off honestly, once, where the choice is made:** small local models write
  weaker SQL than frontier models. That is exactly why the dictionary (§4) and the visible-SQL
  confirm gate (§5) matter more, not less, on the local tiers.
- **Datera Server configures its provider from the environment, not by auto-detection.** The desktop
  client probes the user's machine; a headless server is told what to use via config. Model these as
  two separate mechanisms — a server that port-scans its container for an Ollama is wrong.
- On a shared Datera Server, decide per-caller-key vs deployer-key-with-quotas explicitly (don't let
  a hosted instance silently bleed inference cost).

**Acceptance:** with Ollama running, Datera detects it, lists its installed models, runs a query
through the selected one, and the trace names that exact model; with no local runtime running,
detection fails **silently** and both the bundled tier and the remote BYO-key tier still work.

## 10. Datera Server & deploy

- **Container-first.** `docker run datera-server`, pointed at data (mounted volume or object storage — DuckDB reads CSV/Parquet from S3/GCS via httpfs). Natural targets: Cloud Run, ECS, a VM. **Pure serverless is a constrained option** (stateless read-only over Parquet in object storage), not the default — DuckDB's warm state and live connections fight ephemeral functions.
- **Push/promote from the client.** The Datera client is the "local dev" environment; a user **pushes** a dataset (with its chosen exposed tools + read/write scope) to a Datera Server **environment** (Local → Test → Production). Same core, deployed; the client also acts as the UI for the remote server.
- **What "push to a hosted environment" means (and does not).** It means **deploying a portable artifact the user owns onto infrastructure the user controls** — their VM, their container, their cloud account. The artifact **keeps running without Datera** (invariant §1.8), and the user can walk away from Datera without redeploying, rewriting, or exporting anything under pressure. It explicitly does **not** mean Datera becoming their runtime or their tenancy (§13a). The ship button points at *their* infrastructure.
- **Security (this is a network-exposed data service — treat it as one):** authentication; **per-token, per-dataset read/write scoping** (off by default; expose *views*, not raw tables, for shared read); rate limits; tenant isolation; encrypted DB credentials at rest (KMS) with a least-privilege read-only DB user; **the trace as the audit log**; an abuse/takedown path if it ever serves public content. Writes over the network are categorically higher-risk than reads — gate them hardest.
- **Self-host-to-share is the primary mode.** A multi-tenant SaaS you *operate* for strangers is a separate, larger decision — do not architect it in by default.

---

## 11. Build sequence (each phase ships with tests; confirm as tickets first)

1. **Core foundation.** Portable core lib. DuckDB embedded; connect/ingest the DuckDB-native formats read-only; schema introspection + inferred types. Desktop shell (Electron) with the Workspace view.
2. **Read-only querying + transparency.** NL→SQL (bundled local model) with **visible cited SQL**; the query glass-box (parse → schema → SQL → model-context → rows → cost); direct SQL editor. BYOK config + secure key storage.
3. **Datasets + relationships + dictionary.** Datasets as DuckDB schemas; detected+confirmed relationships; the dictionary (auto-draft + confirm) injected into NL→SQL context; the "what it touched" drill-down.
4. **Semantic path.** Embeddings (local) + DuckDB vector store; structured-vs-semantic routing; semantic drill-in.
5. **Copy-on-write + versions + normalize + enum promotion.** Immutable source → derived dataset → snapshot/export; single-sheet normalization (propose/confirm); the version diff view.
6. **Writes.** Per-dataset opt-in write grant; propose→preview→confirm gate; transaction + undo; writes in the audit trace.
7. **Serve.** MCP (stdio + HTTP/SSE) + REST over a dataset; auto-generated tools; connect configs; the end-to-end serving trace. Plus **§8a**: persist those trace records to a queryable log dataset, a user-set retention window, and the searchable log viewer over them. Small on top of the trace that already exists — it must not become its own pillar.
8. **Datera Server + deploy.** Headless host; container target; push/promote from client to environments; auth + per-token/per-dataset scoping + audit. (Private repo.)
9. **Teaching module.** The data-lifecycle view (curated/instructor-defined).

**Where §3a authoring lands.** The authoring UI, AI-schema import, and backend generation sit
**after writes (6) and serve (7)**, because they need both underneath. They are deliberately
not given a number here yet — the sequence above is the committed path, and authoring is
committed in *direction* (§3a, §13a) rather than in schedule. **Phase 1's only obligation is
the structural seam in §3a**, proven by a core-level test with no UI. Portability (§1.8,
§12.11) is likewise built where the exports it tests actually exist — the dataset/dictionary
round trip belongs with copy-on-write and export (5), the generated-backend half with
generation.

---

## 12. Acceptance criteria (write harness/test assertions for each)

1. Connecting a source **never modifies it** (assert file/DB unchanged after read + query).
2. NL→SQL returns a **cited** answer with the **SQL shown**, and **no raw data rows are sent to the model** (assert the model payload contains schema/dictionary only).
3. A vague question that can't be answered honestly produces a flag, **not a fabricated value** (assert on a fixture).
4. Sources in different datasets **cannot be joined** (assert the model is only shown the active dataset's schema; assert a cross-dataset join fails/blocks).
5. Structured questions route to SQL (no embeddings); free-text routes to semantic (assert the router decision per fixture).
6. Editing/normalizing produces a **derived dataset**; the **source is byte-identical** afterward (copy-on-write assert). Export writes the snapshot; a version **diff** reports the changes.
7. A write is **never executed without an explicit confirm**; the preview reports the **exact row count and old→new values**; undo reverts within the transaction (assert all three).
8. Bundled local model answers with **no key configured and no network egress** (assert offline works).
9. A served MCP/API request emits a complete **trace** covering every hop; on the server, a **read-only token cannot write** and a token scoped to dataset A **cannot touch dataset B** (assert both).
9a. **The trace log is persisted, bounded and searchable (§8a).** With tracing on, requests are persisted to a **queryable log dataset**; **retention prunes** records past the window; **payload capture is off** unless explicitly enabled (assert a trace record contains no row data by default); and the log is searchable by **both SQL and NL, with the SQL shown**. Assert too that a deployed server does **not** persist verbose traces by default.
10. The client runs fully standalone with **no server**; when connected to a Datera Server, the same UI drives it (assert both paths).
11. **No lock-in is provable (invariant §1.8).** Export a dataset's **data + schema + dictionary + dataset definition**, re-import into a **clean instance**, and assert the round trip is **lossless** — same tables, types, relationships, dictionary entries and row counts. Once generate/serve exist, additionally assert the **generated backend runs standalone with Datera uninstalled**. Bake "no lock-in" into a test, not into copy: a portability promise nobody executes is a promise that quietly stops being true.

---

## 13. What NOT to do

- Do not bake the engine into the desktop app — the core is a standalone lib both hosts import.
- Do not mutate a source, ever, on any path.
- Do not auto-execute writes, joins across datasets, or model-proposed schema changes without confirmation.
- Do not send raw data rows to the model on the structured path — schema + dictionary only.
- Do not put server-proprietary code, secrets, or license logic in the public `datera` repo.
- Do not architect a multi-tenant SaaS by default; self-host-to-share is v1.
- Do not add a fourth top-level noun beyond source / dataset / version.
- Do not build a **hosted multi-tenant application platform** — see §13a. This is the biggest scope risk in the project and it is out of bounds by decision, not by omission.
- Do not produce an artifact only Datera can read, or a capability only usable from inside Datera (invariant §1.8).
- Do not build the authoring UI, AI-schema import, or backend code generation in Phase 1 — Phase 1 owes §3a a **seam**, nothing more.

### 13a. Explicit v1 NON-GOAL — a hosted runtime application platform

**Datera is not a hosted multi-tenant application platform or a BaaS.** It does not host other
people's production applications, does not own their auth or their end users, and does not
become the runtime a stranger's business depends on. Someone else's uptime is not our product.

This is recorded as a non-goal for a practical reason: platform apparatus — multi-tenant auth,
hosted tenancy, per-end-user management, billing for other people's traffic — is enormous,
arrives disguised as a series of small reasonable features, and would quietly become the
project. Naming it as out of bounds is what keeps it out of the build.

**The sanctioned expansion of "build your own stuff" is exactly this and nothing more:**

> **author-from-intent (§3a) → generate-an-owned-backend → deploy-to-your-own-infra (§10).**

Generation is **generate-and-hand-over**: the user receives a real, runnable backend they own —
schema + API + MCP server, exportable to Python / Go / Node — which they run wherever they
like and which keeps working with Datera deleted. **Datera is the workshop and the ship
button. It is not the tenancy.**

---

### 13b. Deferred until user-demanded — generated integrations and business logic

> *Deferred until user-demanded: generated business logic, third-party integrations, and OAuth
> flows compiled into the user's owned backend. Revisit only if real Datera users, once the
> product ships, repeatedly pull for it — and even then, only as generate-and-hand-over (the
> client's backend runs and holds all secrets/tokens; Datera never has custody).*

**This is a single deferred line, not a plan.** Do not write a design note for it, do not
architect toward it, and do not let it shape any phase. Recorded reasons, so the boundary holds
when it gets re-proposed:

- **(a)** Generating application and integration code is precisely where Datera would start
  competing with general coding assistants — a competition it will not win, by §0.2.
- **(b)** It is the heaviest ongoing maintenance surface in the entire idea space: every
  provider is a pile of edge cases, and they change underneath you.
- **(c)** It is the furthest thing from the runtime-data-tool core.
- **(d)** It burns far more tokens per use than the core's data operations, which makes the
  cost story worse for a product whose pitch includes being cheap to run.

**What is NOT deferred:** author-from-intent (§3a) stays. Pasting a schema — typed, SQL DDL,
JSON, or AI-generated — to get a *live, queryable, transparent* backend is Datera being itself
with a new front door. It feeds the runtime tool, so it is on-mission and cheap. Generating
someone's Stripe integration is not the same thing and is not adjacent to it.

## 14. Deploying Datera Server + Datera's own hosting

### 14.1 What to build for deploy (this is a selling point — make self-host trivial)

- **Dockerfile** for `datera-server` — small base (distroless/alpine), **multi-arch (amd64 AND arm64** so it runs on the cheapest ARM VMs), DuckDB + required extensions baked in, non-root user, `HEALTHCHECK`.
- **docker-compose.yml** — the server + a **Caddy** reverse proxy for automatic HTTPS (Let's Encrypt). This is the one-command, TLS-included path for any VM. Volume mounts for the workspace/data and for the config/token store.
- **Config entirely via env** (no secrets in the image): `DATERA_LICENSE_KEY`, `DATERA_TOKENS` (or a tokens file), `DATERA_WORKSPACE`, `DATERA_DATA` (a local path **or** `s3://` / `gs://` — DuckDB reads CSV/Parquet from object storage via httpfs), `DATERA_ALLOW_WRITE` (per-dataset, default **off**), `PORT`, `DATERA_TLS_DOMAIN`. Keys come from env/secret store, are never baked into a layer, never logged.
- **Deploy recipes shipped as docs** (the concrete self-host story for buyers):
  - **A VM (Hetzner / DigitalOcean / any):** `docker compose up -d` behind Caddy → HTTPS on your domain. The cheapest, most portable path — and the one Datera's own demo uses.
  - **Fly.io / Render:** a `fly.toml` / `render.yaml`; `fly deploy` or connect-the-repo. Hobby-tier friendly.
  - **Google Cloud Run** (for enterprise buyers): `gcloud run deploy` from the image — but set `min-instances=1` and mount a volume / use GCS for warm state, because DuckDB is stateful; do **not** rely on scale-to-zero for the connected experience.
  - **AWS ECS/Fargate:** a task definition; EFS or S3 for data.
- **Ops:** `/healthz` + `/readyz`; structured logs; the request **trace persisted as the audit log**; graceful shutdown; documented backup = "export the dataset version."
- **Security baked into deploy** (network-exposed data service): TLS required for HTTP/SSE; bearer-token auth **on by default**; **per-token, per-dataset read/write scope** (writes off by default; prefer exposing views for shared read); rate limits; least-privilege read-only DB user for connected sources.

**Acceptance:** (a) `docker run` / `compose up` serves API + MCP over HTTPS (Caddy) and answers a query against a mounted dataset; (b) the image runs on **arm64**; (c) a read-only token cannot write and a dataset-A token cannot reach dataset B; (d) no secret appears in any image layer; (e) starts with only env config, no code edits.

### 14.2 Datera's own hosting (decided — cheapest viable)

- **Marketing site, docs, build-in-public blog → Cloudflare Pages** (free). Deploy the static site straight from the `datera` repo; free SSL + global edge, no bill.
- **Domain + DNS → Cloudflare Registrar** for `datera.app` (at cost, ~$12–14/yr; free DNS + SSL, no markup).
- **Live demo Datera Server → one Hetzner Cloud VM**, cheapest available shared/ARM instance (CX23 / CAX11-class, ~€5–6/mo when available; CPX12 ~€12/mo if the entry plans are unavailable in-region — check at order time), running the compose file above behind Caddy on `demo.datera.app`. ARM (CAX11) is cheapest and fine for DuckDB.
- **Total footprint:** ~$12–14/yr domain + ~$5–13/mo VM ≈ **$70–170/yr, no per-request cloud bill.** No GCP/AWS needed.
- **Do NOT** operate a multi-tenant Datera Server for strangers — that's the only path that creates a real hosting bill and a support queue. Server is something customers run; Datera's footprint stays a static site + one small demo box.

Confirm the plan as tickets before implementing.
