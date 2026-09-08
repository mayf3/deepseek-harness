# Automated pull-request reviews

## Summary

The [`request-review` workflow](../workflows/request-review.yml) requests owners for reviewable code. The [`weighted-approval` workflow](../workflows/weighted-approval.yml) publishes an approval score for branch rules. Both workflows execute policy from the trusted default branch.

## Table of Contents

- [Routing](#routing)
- [Approval scoring](#approval-scoring)
- [Review exclusions](#review-exclusions)
- [Security](#security)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="routing"></a>

## Routing

Pull requests run the workflow when opened, synchronized, reopened, marked ready for review, or converted to a draft. The scanner fetches the complete pull-request file list, evaluates both paths of a rename, and fails instead of routing from a partial list. GitHub exposes at most 3,000 files for this API.

For a non-draft pull request, the workflow keeps at most one current individual review request other than `@turtle1999`; an existing request for `@turtle1999` does not consume that slot. Each run adds at most one reviewer. An existing non-turtle request leaves no slot, so the workflow does not add anyone, including `@turtle1999`. Existing individual requests consume the slot even when made by people outside the ownership map. When more candidates remain than the available counted slot can cover, the workflow ranks them by the total GitHub-reported additions plus deletions in reviewable changed-file records that match each owner. A rename contributes its changed LOC once to an owner even when both paths match that owner. Higher changed LOC ranks first, and login order resolves ties.

On every run with current review requests, the workflow reads the pull-request timeline. A current reviewer is workflow-authored only when the latest matching `review_requested` event names `github-actions[bot]` as `review_requester`; a request without an attributable event is preserved. On a non-draft pull request, the workflow cancels workflow-authored reviewers that no longer match the current candidates and excess workflow-authored non-turtle reviewers above the counted limit. Current relevance order decides which matching workflow reviewer remains when the limit shrinks. It then fills any slot left by the planned cancellations. On a draft, it cancels every current workflow-authored request. Requests made by people remain unchanged in both states. An attributable event with invalid provenance fails before mutation, and the workflow also fails without cancellation when the timeline exceeds 3,000 events.

The ownership map accepts explicit absolute directory patterns and one or two individual GitHub users per pattern. It rejects wildcards, hidden-directory patterns, teams, more than two owners, and duplicate patterns or owners. Matching follows CODEOWNERS last-match semantics. The scanner prints the changed code, excluded test, documentation, and comment-only files; per-file owner matches and LOC; the aggregate owner relevance ranking; current individual requests and the available counted slot after planned cancellations; and the reviewers it will request or cancel before it mutates review requests. Unmatched files remain visible in the log. The pull-request author and users who remain requested are omitted from new requests.

The policy test measures non-test tracked lines under matched directories and requires `@turtle1999` to own no more than one third of that eligible owned codebase.

<a id="approval-scoring"></a>

## Approval scoring

The weighted approval workflow publishes the `weighted approval` commit status on the pull request head. Branch rules must require this status context. The status succeeds at two approval points, remains pending below two points or while the pull request is a draft, fails while a write-capable reviewer has an effective `CHANGES_REQUESTED` review, and reports an error when policy evaluation fails.

Reviewers whose calculated base repository permission is `write` or `admin` count. The [approval policy](approval-policy.json) gives `@07akioni`, `@imccyu`, `@tianyicui`, `@tianyicui-bot`, `@turtle1999`, and `@turtle2099` two points each; every other write-capable reviewer gets one point. The pull-request author and reviewers without write permission do not count.

Each reviewer contributes only the latest non-comment `APPROVED` or `CHANGES_REQUESTED` decision that GitHub returns. Comment-only and dismissed review records do not replace an effective decision. The workflow does not invalidate an approval by its review commit; the repository's native pull-request rules own stale-review and latest-push requirements.

The workflow runs when a pull request opens, synchronizes, reopens, becomes ready, or becomes a draft, and when a review is submitted, edited, or dismissed. It fetches every review and resolves current repository permission before publishing the status. Permission changes take effect on the next subscribed pull-request or review event.

<a id="review-exclusions"></a>

## Review exclusions

Review routing excludes the repository's unit, end-to-end, expected-output, snapshot, benchmark, performance, stress, corpus, native, and Python test conventions. This includes `test`, `tests`, `__tests__`, `__snapshots__`, `benches`, and `stress-tests` directories; the top-level `benchmarks` and `snapshots` trees; `packages/test-support`; `scripts/fixtures` and `scripts/snapshots`; recognized test filename suffixes; and Python `test_*.py` or `*_test.py` files.

Test infrastructure that can alter how evidence is produced remains reviewable, including `vitest*.config.ts` and gate implementations under `scripts`. A production file named `test.ts`, `spec.ts`, or `snapshot.ts` is not excluded solely by that name.

Files ending in `.md` or `.yaml`, with case-insensitive extension matching, are documentation and never contribute owners. A `.yml` file remains reviewable unless another exclusion applies.

For a modified file with a supported source extension, the scanner compares the pre-change and post-change text after removing parsed comments. It excludes the file only when GitHub supplies a patch whose counted additions and deletions prove that the patch is complete and the remaining code is identical. The parser recognizes C-style line and block comments, hash comments, SQL comments, CSS block comments, and HTML comments for their declared extensions. Renames, unsupported languages, missing or partial patches, and uncertain comment forms remain reviewable.

<a id="security"></a>

## Security

The write-capable jobs check out only the repository default branch. They do not check out or execute pull-request code and do not use repository secrets. Pull-request filenames and reviews are treated as API data and escaped in logs.

Ownership and approval policy changes take effect only after they merge into the default branch. This prevents an untrusted pull request from changing either program or policy for its own run.

<a id="verification"></a>

## Verification

Run `pnpm run test:request-review` for routing behavior and `pnpm run test:approval-policy` for policy parsing, effective review decisions, pagination, permission filtering, weighted scoring, blockers, drafts, status publication, and API failures. [Workflow tests](../../scripts/ci-workflow.spec.ts) pin both workflows' trusted checkout, permissions, events, and commands. The repository gate graph runs all three checks in CI.

<a id="dev-note"></a>

## Dev Note

The [review-routing decision](../../.agents/notes/implemented/process/2026-09-08-trusted-changed-file-review-routing.md) records the security model, test exclusions, and alternatives.
