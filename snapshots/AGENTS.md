# AGENTS.md — Recorded-session snapshots

This tree contains only tests whose committed session JSONL is replay input and expected persisted output. Keep non-session ARIA, geometry, generator, CLI, and unit expected output with its owning app, script, or package as a golden.

Every process under test starts through the `dsh` CLI with a shipped profile and optional scenario patches. Test clients may drive a public protocol or browser interface; do not add another application entrypoint, hidden CLI mode, or executable scenario driver.

Each scenario owns or explicitly references one primary `session.jsonl` plus contiguous child files. The owner alone records or refreshes it. For an ordinary one-shot case, derive the user task and replay script from that JSONL; do not duplicate them in an `input.json`. Shared references are read-only, acyclic, and used only when another interface intentionally renders the same recorded behavior.

Committed sessions are normalization fixed points. Replace volatile identities with typed relationship-preserving tokens, replace request system prompts and tool schemas with tokens, and keep exactly one readable sidecar owner per header class. Never redact arbitrary user or tool text merely because it resembles an identifier.

Workspace seeds stay scenario-local. A scenario that mutates the workspace commits and compares its expected final workspace; model prose and tool-result text do not prove the external effect.

`pnpm run test:snapshot` replays without writes. Recording and refresh use the explicit snapshot scripts, and every resulting JSONL, prompt, schema, protocol, UI, and workspace diff is reviewed before commit.
