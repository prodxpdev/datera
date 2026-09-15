# Models — Phase 2, not Phase 1

Empty by design. Spec §9 defines three provider tiers:

1. **Bundled local** (default) — `node-llama-cpp` + a compact instruct model and a small
   embedder. Weights fetched on first run (decision D-08), not shipped in the installer.
2. **Detected local runtimes** — Ollama (`:11434`), LM Studio (`:1234`), and one generic
   OpenAI-compatible endpoint. Detection is best-effort and non-blocking: short-timeout
   probes, never hangs, never hard-fails, never lists a runtime that is not running.
3. **Remote BYO key** — Anthropic / OpenAI, keys in the OS keychain via `SecretStorePort`.

Chat and embedding models are selected **separately**; embeddings stay local by default
even when chat is remote.

Two constraints that shape the code that lands here, recorded now so they are not
discovered late:

- **The trace must name the exact model** — tier, provider, model id, and locality, e.g.
  `Ollama · llama3.1:8b (local · :11434)`. A trace that cannot tell you which model wrote
  the SQL is not an audit log.
- **Datera Server takes its provider from environment config and never auto-detects.** The
  desktop client probes the user's machine; a headless server is told what to use. These
  are two separate mechanisms — a server that port-scans its own container is wrong.

Phase 1's only obligation was to not preclude any of this. `SecretStorePort` already
exists and already holds credentials, so the BYOK tier has its storage seam.
