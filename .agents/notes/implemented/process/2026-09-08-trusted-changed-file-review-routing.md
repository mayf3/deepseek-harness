# Agent Note: Route reviews from trusted changed-file policy

Status: implemented

English | [中文](2026-09-08-trusted-changed-file-review-routing.zh.md)

## Problem

GitHub's native CODEOWNERS behavior requests reviewers whenever a matching path changes. It cannot apply this repository's distinction between reviewable implementation or documentation files and test-only evidence. A native CODEOWNERS file also makes GitHub, rather than an inspected repository program, responsible for the request decision.

Review routing needs an observable changed-file input, explicit owner rules, complete test exclusions, and a write-capable workflow that remains safe for pull requests from forks.

## Decision

The repository keeps a CODEOWNERS-compatible map at [`.github/review-ownership/CODEOWNERS`](../../../../.github/review-ownership/CODEOWNERS), outside GitHub's native CODEOWNERS locations. The map accepts only explicit absolute directory patterns and individual GitHub users. It rejects wildcards, hidden-directory patterns, teams, duplicate patterns, and duplicate owners. Later matching patterns replace earlier matches.

The policy test counts non-test tracked lines in directories that match an ownership rule. It rejects a map in which `@turtle1999` owns more than one third of that eligible owned codebase.

The [`request-review` workflow](../../../../.github/workflows/request-review.yml) runs on non-draft `pull_request_target` events for opened, synchronized, reopened, and ready-for-review pull requests. Its write-capable job checks out the default branch and executes only the default branch's scanner and ownership map. It does not check out pull-request code or read repository secrets.

The scanner fetches every changed-file record before deciding. It fails if the pull request reports more than GitHub's 3,000-file API limit or if pagination returns an incomplete list. It normalizes repository paths, evaluates old and new paths of a rename independently, and escapes filenames before logging them.

The scanner excludes test-only paths before owner matching. Excluded paths comprise directories named `test`, `tests`, `__tests__`, `__snapshots__`, `benches`, or `stress-tests`; the top-level `benchmarks` and `snapshots` trees; `packages/test-support`; `scripts/fixtures` and `scripts/snapshots`; filenames ending in `.bench.<ext>`, `.corpus.<ext>`, `.e2e.<ext>`, `.perf.<ext>`, `.snapshot.<ext>`, `.spec.<ext>`, `.stress.<ext>`, or `.test.<ext>`; and Python `test_*.py`, `*_test.py`, or `*_tests.py` files. Test infrastructure such as `vitest*.config.ts` and gate implementations remains reviewable because it changes how repository evidence is produced.

The workflow prints the changed non-test paths, excluded test paths, per-file owner matches, and final reviewer list before any review-request mutation. It requests the union of matched individual owners after removing the pull-request author and users who are already requested. A test-only or wholly unmatched change requests nobody.

## Verification

[Scanner tests](../../../../.github/review-ownership/request-review.test.mjs) cover admitted ownership syntax, rejected syntax, each test convention, production-name negative controls, renames, last-match behavior, unmatched files, complete pagination, the 3,000-file limit, log-before-request ordering, author and existing-reviewer filtering, test-only changes, drafts, and API failures. [Workflow tests](../../../../scripts/ci-workflow.spec.ts) pin the event set, least permissions, trusted default-branch checkout, absence of pull-request-head references and secrets, and executed command. The gate graph includes both suites in static CI and `check-all`.

## Alternatives considered

**Use native CODEOWNERS.** Native routing cannot ignore test-only changes and offers no repository-owned decision log before requesting reviewers.

**Run under `pull_request` and check out the pull-request head.** A fork workflow does not receive a write-capable token, while granting a write token to code from an untrusted head is unsafe.

**Execute the pull request's scanner or owner map under `pull_request_target`.** This lets an untrusted pull request choose its own write-capable behavior or owners.

**Infer semantic source changes from patches or language parsers.** GitHub can truncate patches, and the repository spans TypeScript, JavaScript, Python, Rust, YAML, Markdown, and generated evidence. A cross-language semantic classifier would add ambiguous rules without providing a complete input. The scanner therefore uses the complete non-test changed-file list and does not claim to distinguish formatting, comments, or documentation-only edits inside an eligible file.

## Consequences

Reviewer requests are reproducible from a trusted policy and the file list printed in the workflow log. Test-only changes do not request owners. Ownership changes become effective only after merge, so the pull request that changes policy cannot apply its untrusted policy to itself.

The workflow requests every matched owner rather than choosing one owner nondeterministically. Shared ownership on large directories therefore produces multiple requests. GitHub-generated review-request events may not start other workflows that depend on recursively triggered events from `GITHUB_TOKEN`; those workflows must not rely on this request as their only trigger.

Any non-test change under an owned directory remains eligible, including comment-only or formatting-only edits and documentation changes. Unmatched paths are logged and request nobody. Pull requests above the API file limit fail without requesting a partial owner set.
