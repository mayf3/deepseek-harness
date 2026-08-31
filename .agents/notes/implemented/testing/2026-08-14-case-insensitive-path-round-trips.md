# Agent Note: Case-insensitive path round-trips in test expectations

Status: implemented

English | [中文](2026-08-14-case-insensitive-path-round-trips.zh.md)

## Problem

[`packages/session/session-persistence-jsonl/tests/jsonl.spec.ts`](../../../../packages/session/session-persistence-jsonl/tests/jsonl.spec.ts) proves that a relative `root` is resolved before a session is located. It handed the plugin `relative(process.cwd(), absoluteRoot)` and built its expectation from `resolve(absoluteRoot)` — two different starting points for the same directory.

On a case-insensitive filesystem those starting points can disagree on spelling. `path.relative()` on Windows compares case-insensitively and returns a path with the shared prefix removed, so the casing of that prefix is gone; `path.resolve()` then rebuilds it from `process.cwd()`. When the prefix `tmpdir()` and `process.cwd()` share is spelled with different casing in each, the plugin's resolved root carries the `cwd` spelling while the expectation carries the `tmpdir()` spelling, and `toEqual` compares two strings that name the same file.

A host reaches that state when `tmpdir()` and `process.cwd()` share a path prefix but spell it differently — for example when `TMP` is mapped into the runner work tree under one spelling while the workspace path uses another. Sharing the tree is not enough on its own: if both spell the prefix alike, the round-trip returns the same string. The case fails there and passes everywhere else, which reads as a flake rather than as a fixed disagreement between two spellings.

## Decision

The expectation resolves the same relative root the plugin receives. Both sides pass through one `resolve(cwd, relative)` call, so the case-insensitive round-trip cannot place two spellings on the two sides of the comparison.

This is a test-only change. The platform treats both spellings as the same file, so storage behaviour does not depend on which spelling `resolve()` produces. The string itself stays observable: hook payloads carry it as `transcript_path` and the shell contributor exports it as `DSH_SESSION_JSONL`, so a consumer that compares those strings can still see the difference. Composition fixtures set a relative session root — but the plugin resolves whatever it receives before use, so a relative root reaches disk as one spelling rather than two.

The case still asserts what it names: with the plugin's `resolve(config.root)` reduced to `config.root`, so a relative root is no longer resolved, the case fails.

The neighbouring decision about constructing paths with the host `node:path` API lives in [cross-platform test fixtures](2026-07-22-cross-platform-test-fixtures.md); this note covers a different mechanism, the `relative()`/`resolve()` round-trip under a case-insensitive filesystem.

## Alternatives considered

**Compare the two paths case-insensitively.** This keeps the assertion green on the affected runners but accepts a real configuration disagreement as normal, and it would spread to every future path assertion rather than staying in the one case that round-trips through `relative()`.

**Re-register the runners so `workFolder` matches the directory casing.** That repairs the underlying inconsistency, but `.runner` also carries the agent identity, pool, and server URLs, so hand-editing it risks a registration mismatch, and the test would remain fragile for any other host whose temp directory and working directory disagree on casing.

**Normalize through `realpath()` in the expectation.** `realpath()` returns the on-disk casing, which is the `cwd` spelling here, so the case would pass; it also resolves symlinks, which changes what the assertion covers on hosts where the temp directory is a link.

## Consequences

The relative-root case now depends on `resolve()` alone rather than on the two spellings agreeing, so it passes on hosts whose temp directory and working directory disagree on casing. The underlying runner registration is untouched: a `workFolder` whose spelling differs from the directory on disk stays that way, so any future assertion that compares a `tmpdir()`-derived absolute path against a `cwd`-derived one will meet the same disagreement.

The changed case passes, and the whole `session-persistence-jsonl` suite passes at 242 cases. The mechanism was reproduced away from Windows with `path.win32`: `relative()` on two differently-cased spellings of one directory returns a prefix-free relative path, `resolve()` rebuilds it from the `cwd` spelling, and the two absolute strings differ; with both sides spelled alike the same code matches. The regression check above — removing `resolve()` from the plugin — turns the case red while the fixture root and the working directory share a drive letter. Across drives `relative()` returns an absolute path, so both spellings already agree and the check cannot go red; the fixture roots come from `tmpdir()`, so the check only goes red where that path and the working directory share a drive.
