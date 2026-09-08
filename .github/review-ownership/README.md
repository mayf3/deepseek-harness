# Automated review requests

English | [中文](README.zh.md)

## Summary

The [`request-review` workflow](../workflows/request-review.yml) reads the CODEOWNERS-compatible [ownership map](CODEOWNERS) from the trusted default branch. It prints the complete changed non-test file list, matches those files to owners, and then requests the missing reviewers. The ownership map is outside GitHub's native CODEOWNERS locations, so GitHub does not apply it directly.

## Table of Contents

- [Routing](#routing)
- [Test exclusion](#test-exclusion)
- [Security](#security)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="routing"></a>

## Routing

Non-draft pull requests run the workflow when opened, synchronized, reopened, or marked ready for review. The scanner fetches the complete pull-request file list, evaluates both paths of a rename, and fails instead of routing from a partial list. GitHub exposes at most 3,000 files for this API.

The ownership map accepts explicit absolute directory patterns and individual GitHub users. It rejects wildcards, hidden-directory patterns, teams, and duplicate patterns or owners. Matching follows CODEOWNERS last-match semantics. The scanner prints `Changed code files`, `Excluded test files`, `Owners by changed file`, and `Reviewers to request` before it sends the review request. Unmatched files remain visible in the log. The pull-request author and users who are already requested are omitted.

The policy test measures non-test tracked lines under matched directories and requires `@turtle1999` to own no more than one third of that eligible owned codebase.

<a id="test-exclusion"></a>

## Test exclusion

Review routing excludes the repository's unit, end-to-end, expected-output, snapshot, benchmark, performance, stress, corpus, native, and Python test conventions. This includes `test`, `tests`, `__tests__`, `__snapshots__`, `benches`, and `stress-tests` directories; the top-level `benchmarks` and `snapshots` trees; `packages/test-support`; `scripts/fixtures` and `scripts/snapshots`; recognized test filename suffixes; and Python `test_*.py` or `*_test.py` files.

Test infrastructure that can alter how evidence is produced remains reviewable, including `vitest*.config.ts` and gate implementations under `scripts`. A production file named `test.ts`, `spec.ts`, or `snapshot.ts` is not excluded solely by that name.

<a id="security"></a>

## Security

The write-capable `pull_request_target` job checks out only the repository default branch. It does not check out or execute pull-request code and does not use repository secrets. Pull-request filenames are treated as API data and escaped in logs.

Ownership changes take effect only after they merge into the default branch. This prevents an untrusted pull request from changing the routing program or its owner assignments for its own run.

<a id="verification"></a>

## Verification

Run `pnpm run test:request-review` for ownership parsing, test classification, pagination, logging order, reviewer filtering, and API behavior. [Workflow tests](../../scripts/ci-workflow.spec.ts) pin the trusted checkout, permissions, events, and command. The repository gate graph runs both checks in CI.

<a id="dev-note"></a>

## Dev Note

The [review-routing decision](../../.agents/notes/implemented/process/2026-09-08-trusted-changed-file-review-routing.md) records the security model, test exclusions, and alternatives.
