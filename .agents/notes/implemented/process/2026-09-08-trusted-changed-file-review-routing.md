# Agent Note: Route reviews from trusted changed-file policy

Status: implemented

English | [中文](2026-09-08-trusted-changed-file-review-routing.zh.md)

## Problem

GitHub's native CODEOWNERS behavior requests reviewers whenever a matching path changes. It cannot apply this repository's distinction between reviewable implementation or documentation files and test-only evidence. A native CODEOWNERS file also makes GitHub, rather than an inspected repository program, responsible for the request decision.

Review routing needs an observable changed-file input, explicit owner rules, complete test exclusions, and a write-capable workflow that remains safe for pull requests from forks.

## Decision

The repository keeps a CODEOWNERS-compatible map at [`.github/review-ownership/CODEOWNERS`](../../../../.github/review-ownership/CODEOWNERS), outside GitHub's native CODEOWNERS locations. The map accepts only explicit absolute directory patterns with one or two individual GitHub users. It rejects wildcards, hidden-directory patterns, teams, more than two owners, duplicate patterns, and duplicate owners. Later matching patterns replace earlier matches.

The policy test counts non-test tracked lines in directories that match an ownership rule. It rejects a map in which `@turtle1999` owns more than one third of that eligible owned codebase.

The [`request-review` workflow](../../../../.github/workflows/request-review.yml) runs on `pull_request_target` events for opened, synchronized, reopened, ready-for-review, and converted-to-draft pull requests. Its write-capable job checks out the default branch and executes only the default branch's scanner and ownership map. It does not check out pull-request code or read repository secrets.

The scanner fetches every changed-file record before deciding. It fails if the pull request reports more than GitHub's 3,000-file API limit or if pagination returns an incomplete list. It normalizes repository paths, evaluates old and new paths of a rename independently, and escapes filenames before logging them.

The scanner excludes test-only paths before owner matching. Excluded paths comprise directories named `test`, `tests`, `__tests__`, `__snapshots__`, `benches`, or `stress-tests`; the top-level `benchmarks` and `snapshots` trees; `packages/test-support`; `scripts/fixtures` and `scripts/snapshots`; filenames ending in `.bench.<ext>`, `.corpus.<ext>`, `.e2e.<ext>`, `.perf.<ext>`, `.snapshot.<ext>`, `.spec.<ext>`, `.stress.<ext>`, or `.test.<ext>`; and Python `test_*.py`, `*_test.py`, or `*_tests.py` files. Test infrastructure such as `vitest*.config.ts` and gate implementations remains reviewable because it changes how repository evidence is produced. The [comment-only routing decision](2026-09-08-comment-only-review-routing.md) owns the additional documentation and comment exclusions.

The workflow prints the changed code paths, each exclusion class, per-file owner matches, and final reviewer action before any review-request mutation. For a non-draft pull request, it removes the pull-request author and users who are already requested from the login-sorted union of matched individual owners, then fills at most two current individual review-request slots. Existing individual requests consume slots even when they do not match the ownership map. Login order deterministically selects candidates when the available slots cannot cover the remaining union. The workflow does not remove requests from a non-draft pull request. For a draft, it reads the complete review-request timeline and cancels current requests whose latest requester is `github-actions[bot]`; requests made by people remain unchanged.

## Verification

[Scanner tests](../../../../.github/review-ownership/request-review.test.mjs) cover admitted ownership syntax, rejected syntax, each exclusion class, production-name negative controls, renames, last-match behavior, unmatched files, complete pagination, the 3,000-file limits, log-before-mutation ordering, author and existing-reviewer filtering, draft cancellation provenance, and API failures. [Workflow tests](../../../../scripts/ci-workflow.spec.ts) pin the event set, least permissions, trusted default-branch checkout, absence of pull-request-head references and secrets, and executed command. The gate graph includes both suites in static CI and `check-all`.

## Alternatives considered

**Use native CODEOWNERS.** Native routing cannot ignore test-only changes and offers no repository-owned decision log before requesting reviewers.

**Run under `pull_request` and check out the pull-request head.** A fork workflow does not receive a write-capable token, while granting a write token to code from an untrusted head is unsafe.

**Execute the pull request's scanner or owner map under `pull_request_target`.** This lets an untrusted pull request choose its own write-capable behavior or owners.

**Infer arbitrary semantic source changes from patches or language parsers.** GitHub can omit or truncate patches, and the repository spans many languages. The scanner does not try to prove that two programs behave identically. The later [comment-only routing decision](2026-09-08-comment-only-review-routing.md) adds a narrow lexical comparison only when changed-line counts prove that GitHub supplied the complete patch.

## Consequences

Reviewer mutations are reproducible from a trusted policy, the file classifications printed in the workflow log, and review-request provenance in the pull-request timeline. Excluded changes do not request owners, and draft pull requests do not retain workflow-authored requests. Ownership changes become effective only after merge, so the pull request that changes policy cannot apply its untrusted policy to itself.

The workflow requests every matched owner rather than choosing one owner nondeterministically. Shared ownership therefore produces at most two requests for each changed module. GitHub-generated review-request events may not start other workflows that depend on recursively triggered events from `GITHUB_TOKEN`; those workflows must not rely on this request as their only trigger.

Any change that does not match an explicit exclusion remains eligible under an owned directory. Unmatched paths are logged and request nobody. Pull requests above the file or timeline API limit fail without applying a partial reviewer mutation.
