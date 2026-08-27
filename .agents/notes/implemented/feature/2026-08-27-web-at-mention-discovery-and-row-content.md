# Agent Note: Web @ mention discovery cost and row content

Status: implemented

English | [中文](2026-08-27-web-at-mention-discovery-and-row-content.zh.md)

## Problem

Typing after `@` in the Web composer was slow, and the menu it filled was padded with text that distinguished nothing. Three defects sat behind that, all reachable from one keystroke.

Session discovery read every persisted session's whole log. `listCandidates` sliced to the candidate limit only for an empty query; a non-empty one called `readTitleSnapshots` over the entire corpus, and folding a title there costs one full log read per session. `DEFAULT_PREPARED_SESSION_CACHE_SIZE` is 5, so any real corpus evicts faster than it fills and every keystroke pays the cold price again. Measured against a 342-session store: 1139 ms of multi-frame zstd decompression and JSON parsing per keystroke, at concurrency 4 with a warm page cache. That is the shape users reported — `@` alone was tolerable at roughly 160 ms because it sliced first; one typed character was not.

The file index was truncating half of a workspace. `WorkspaceFileSearch` fills breadth-first under `maxEntries`, so a cap reached at depth four or five drops everything deeper. This repository holds 19 764 entries against a 10 000 cap, of which 8 148 (41%) were `lib/` build output that the two default exclusions (`.git`, `node_modules`) did not cover. `@AssistantMarkdown` returned nothing for a file that exists; `@MenuView` returned its spec file and not `MenuView.tsx`. Separately, any `tool/result` invalidated the whole index, so a read-only tool put a full traversal in front of the next caret.

Row content repeated itself. A workspace-root file rendered `reference.txt reference.txt`, because the description was the full path and the name was its basename. A session row rendered its title, its full session id, its full cwd, and a raw `toISOString()` timestamp. A drilled directory listing had no way back except deleting characters, and every row in it named the same parent.

Web e2e could not see any of this: its scaffold pins an isolated `DSH_HOME` holding two sessions.

## Decision

**Discovery cost tracks projection-cache coverage.** `SessionReferenceResolver` labels candidates from `ctx.sessionProjectionCache.cachedSnapshot(header, ['title'])`, a synchronous in-memory read that `api-session.list` already uses. A session the cache has checkpointed costs no log read. Every other session is folded once and memoized on the resolver for the process lifetime, keyed by the header's creation facts so a reused id cannot inherit a stale title; a session that is attached again is never memoized, because its log is still growing. A non-empty query folds the uncheckpointed remainder before filtering, because the filter reads labels — deferring that fold to the capped page would make a session unfindable by its own title. An empty query filters nothing, so its unresolved tail waits for the page.

The cache is optional, and without it the previous fold path stands unchanged, including its limitation that an unfiltered listing folds only its cwd-ranked head.

**An invalidated file index keeps answering while its replacement builds.** `invalidate()` bumps a counter instead of discarding the traversal. A bare query serves the settled entries and starts a background rebuild that swaps in atomically; only a workspace's first bare query ever waits. A failed refresh leaves the stale entries and the counter behind, so the next query retries. `DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES` grows from two names to sixteen — version-control and dependency stores plus the build-output basenames of the ecosystems this harness runs in — and `DEFAULT_FILE_SEARCH_MAX_ENTRIES` rises to 50 000. Both remain `excludedDirectories` and `maxEntries` config fields a deployment overrides.

**Rows carry only what distinguishes them.** A file names its parent directory and nothing at the workspace root. A drilled directory listing names no parent, because its breadcrumb does. A session names its workspace only when `SessionReferenceCandidate.sameWorkspace` is false — the host computes that, since it already holds both working directories for ranking — and is dated with the relative-time bucket the session list uses, so one session reads the same age on both surfaces. `relativeTime` moves from `ui-workspace`'s `tree.ts` to `ui-primitives`; the words stay in each plugin's own dictionary, per locale-owned copy. The session id leaves the row: it is already the label a session without a title falls back to.

**A drill publishes a breadcrumb; typing a path does not.** `InputTriggerSource` gains an optional synchronous `header(session, req)` hook returning crumbs, re-polled on every hit with the live query and a pipeline-owned `drilled` flag that says whether a drill or typing produced it. `CandidateRequest` carries the same flag. Crumbs ride their own snapshot store beside the menu store, so the frozen menu reducer stays unaware of them, and a crumb pick routes through `onPick` with `action: 'drill'` — returning to a step and descending into one are one outcome. `MenuView` renders the header above its scrolling viewport and moves `role="listbox"` onto that viewport, because a breadcrumb is not an option and a listbox may not carry one.

The zh composer placeholder says `文件或对话`, matching the `对话` section title the same menu already shows.

## Alternatives considered

**Trust the projection cache outright: no cache row means no title.** Rejected by measurement and then by a test. Only 154 of 342 sessions in a real store carry a cache record, and 111 of those a title; the rest predate the cache or never checkpointed. Web e2e caught it immediately — a seeded cold session became unfindable by the title in its own log.

**Fold the uncheckpointed titles only for the capped page.** Rejected: the filter runs before the page exists, so a title-substring query would skip exactly the sessions whose titles were deferred. The page-only fold survives for the empty-query path, where nothing is filtered.

**Debounce the candidate fetch.** Rejected. The reducer already resets every group to pending on each hit, so a trailing debounce extends the skeleton state and reads as *slower* while typing. With the fold removed, the round trip no longer justifies the timer; keeping the previous rows visible under a new generation is a separate decision with pick-safety consequences, and is not taken here.

**Read `.gitignore` to bound the index.** Rejected for now: it adds an ignore-file parser and a git dependency to a path that must stay synchronous and cheap. A basename list covers the measured 41% and stays a config field. A workspace that keeps sources under one of those basenames must override `excludedDirectories`.

**Let `MenuView` recognize the `@` trigger and draw the breadcrumb itself.** Rejected: `MenuView` is shared with `/`, and hardcoding file-reference semantics there crosses the package boundary the source registry exists to hold.

**Add a `drilled` flag to `CandidateRequest` as optional.** Rejected: the pipeline always knows it, and an optional field invites a source to read `undefined` as "not drilled" for a request that simply predates the field. Required, with every call site updated, matches the pre-release stance.

## Consequences

A deployment without `session-projection-cache` composed keeps the old cost and the old head-only fold. With it composed, a first query over a corpus the cache has not covered still reads those logs once; the memo makes that a per-log cost rather than a per-keystroke one. A dedicated title index would remove the remainder, and the session-reference README now names that as the open path.

The file index is one invalidation stale: a bare query answered immediately after a tool result reflects the tree as of the previous traversal, and the following query sees the rebuild. Sources kept under an excluded basename need an `excludedDirectories` override.

`aria` goldens change shape: the listbox role now sits on an inner element, and rows carry a relative-time bucket that advances while a suite runs. `normalizeAria` collapses that vocabulary to `{{age}}` before the duration rules, anchored on an aria label's closing quote.

The reference row content is now derived from what the neighbouring chrome already shows — the breadcrumb for a drilled listing, the current workspace for a session. A future surface that renders these candidates without that chrome would show less than it should, and must ask the source for a different projection rather than re-deriving paths.

## Testing

Package tests cover the checkpoint path (a filtered query that reads no log), the memoized cold fold and its identity invalidation, the uncheckpointed-tail fold that keeps title filtering complete, stale-while-revalidate including a failed refresh, and the breadcrumb contract from both ends. `reference-composer.e2e.ts` covers the shipped composition: the refreshed menu golden shows the trimmed rows, and a new case drills into a folder, asserts the breadcrumb appears only then, and clicks the root crumb back to a bare `@`.

The 1139 ms figure is a measured floor for the server-side I/O against a real store, not an instrumented end-to-end UI latency; the web e2e scaffold's isolated `DSH_HOME` cannot reproduce the corpus that produces it.
