# Pull-request approval policy

## Summary

The [`weighted-approval` workflow](../workflows/weighted-approval.yml) publishes an approval score for branch rules. Reviewer selection and review requests remain manual.

## Table of Contents

- [Approval scoring](#approval-scoring)
- [Security](#security)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="approval-scoring"></a>

## Approval scoring

The weighted approval workflow exposes two pull-request checks. The `weighted approval publisher` Actions job reports whether evaluation and status publication completed, while the `weighted approval` commit status carries the approval decision on the pull request head. Branch rules must require only the commit status with GitHub Actions as its expected source; a context-only requirement can accept a same-named status from another integration. The publisher marks the head pending before Python setup or lexer installation, so failed setup or an interrupted history fetch cannot leave a previous success in place. Setup and evaluation failures publish an error status. A completed evaluation returns `pending` below two approval points, while the pull request is a draft, or while a write-capable reviewer has an effective `CHANGES_REQUESTED` review; the blocker keeps the status pending even when counted approvals reach the threshold. It returns `success` only when the threshold is met, the pull request is ready, and no such blocker exists. If evaluation fails, the publisher writes an `error` status.

Reviewers whose calculated base repository permission is `write` or `admin` count. The [approval policy](approval-policy.json) gives `@07akioni`, `@imccyu`, `@tianyicui`, `@tianyicui-bot`, `@turtle1999`, and `@turtle2099` two points each; every other write-capable reviewer gets one point. The pull-request author’s own review and reviewers without write permission do not count.

The PR author contributes `min(0.6, mergedPRCount / 250)` points: 0 merged PRs → 0 points, 100 → 0.4, and 150 or more → 0.6. The publisher counts only merged PRs in this repository using the author’s immutable account ID, excluding the current PR. It stops at 150 matches and rejects incomplete history responses. Counts refresh at the next subscribed evaluation event. Author credit is separate from reviewer approvals and cannot satisfy the two-point requirement alone; the author’s own review remains excluded. Human and bot authors, including Dependabot, use the same rule. Drafts, blocking reviews, and sufficient reviewer points skip history lookup; logs mark credit as not evaluated. Otherwise, logs show author credit and the capped count separately. Below the cap, counting may scan the repository’s entire merged history; a failed required lookup publishes an error.

A one-point approval receives weight `min(2, 1 + 4 × ownedLines / totalLines)` from modified or deleted old production-code lines, attributed by `git blame` at the merge base of the live base branch and exact reviewed head. Ownership of 0%, 12.5%, and 25% gives 1, 1.5, and 2 points; higher ownership remains capped at 2. The success threshold remains 2 total points, without rounding the score. New lines do not enter the denominator, and an empty denominator gives no boost. Existing two-point weights remain unchanged. GitHub commit-author accounts identify reviewers across author emails; unlinked authors remain in the denominator without contributing to a reviewer. The publisher logs measured ownership. It skips attribution when reviewer points plus author credit already meet the threshold or a blocking review exists. Displayed scores use at most three decimal places; the decision uses unrounded scores with a tolerance of `1e-12` points for floating-point error. The curve endpoints come from the policy’s default and required points.

Production source means supported code files under `src/` in `packages/`, `apps/`, `python/`, and `native/`, plus the Desktop renderer, Python interpreter scripts, and committed runtime/packer launchers. The [classifier](blame-production.py) excludes documentation, tests, fixtures, snapshots, test support (including `src/testing/` and `src/testing.ts`), examples, generated source, dependencies, vendored code, declarations, comments, and blank lines. Pygments lexers distinguish comments from strings; mixed code/comment lines count, as do C preprocessor directives. Classification uses the old path and content, so changes to the PR’s file locations or generated headers cannot remove old lines from the denominator. Pure renames have no changed lines; renames with edits use the old path for blame.

Each reviewer contributes only the current `APPROVED` or `CHANGES_REQUESTED` decision that GitHub returns. A `DISMISSED` record clears that reviewer's standing decision, including earlier approvals. Comment-only and pending records do not replace a decision. Reviews from deleted accounts and reviewers without current repository access do not count. The workflow does not invalidate an approval by its review commit; the repository's native pull-request rules own stale-review and latest-push requirements.

The publisher runs when a pull request opens, synchronizes, reopens, becomes ready, becomes a draft, or is edited, including a base-branch change. Pull-request and review events share one concurrency group per PR. Review submissions, edits, and dismissals run the no-permission [`weighted-approval-review-event` workflow](../workflows/weighted-approval-review-event.yml); its validated run title supplies the pull-request number to the default-branch publisher. The publisher validates the current head, fetches every review, and resolves current repository permission before publishing the status. Permission changes take effect on the next subscribed pull-request or review event.

<a id="security"></a>

## Security

All actions in the status-writing job are pinned to commit SHAs. The job checks out only the repository default branch. It does not check out or execute pull-request code and does not use repository secrets. Only when there is no blocker, reviewer points plus author credit are insufficient, and an approval has the policy’s default weight, it fetches complete history using the job token, passes Git objects to the trusted classifier as data, and resolves commit authors in batches of 50. Fetch credentials exist only in the Git child environment. Missing history, parsing failures, or incomplete author queries fail evaluation rather than producing a partial score. The review-event workflow has no `GITHUB_TOKEN` permissions and passes only a decimal pull-request number in its run title. The publisher accepts only successful `pull_request_review` runs from the review-event workflow file, identified by `workflow_run.path`; GitHub can populate `workflow_run.name` with the expanded run title. The publisher rejects an invalid run title and a number that does not resolve to the workflow run's current pull-request head. Pull-request reviews are treated as API data and escaped in logs.

Approval policy changes take effect only after they merge into the default branch. This prevents an untrusted pull request from changing the program or policy for its own run.

<a id="verification"></a>

## Verification

Run `pnpm run test:approval-policy` for policy parsing, effective review decisions, review-event validation, merged-history pagination and account matching, lazy author credit, permission filtering, weighted scoring, blockers, drafts, status publication, and API failures. [Workflow tests](../../scripts/ci-workflow.spec.ts) pin the trusted checkout, no-permission review handoff, permissions, events, and commands. The repository gate graph runs the approval policy and workflow tests in CI. The Python SDK job runs `uv run --python 3.10 --with-requirements .github/review-ownership/requirements.txt python -m unittest discover -s .github/review-ownership -p 'test_*.py'` for real Git histories, lexers, renames, shallow-history rejection, and the publisher’s fetch/analysis integration.

<a id="dev-note"></a>

## Dev Note

[Production blame weighting](../../.agents/notes/implemented/process/2026-09-11-production-blame-approval-weight.md) records the scoring rationale and measured costs.
