# Agent Note: PR-scoped approval delegation

Status: implemented

English | [中文](2026-09-15-pr-approval-delegation.zh.md)

## Problem

A reviewer may trust another reviewer to decide a particular PR while retaining the score associated with their own repository role and code ownership. Counting both the original approval and transferred points would inflate that reviewer's contribution.

## Decision

The [approval policy](../../../../.github/review-ownership/README.md#delegating-points) accepts `/delegate @username` in PR conversation comments. Each eligible sender's points follow the named recipient's effective approval, once, using the sender's weight. Delegation applies only to that PR and only between write-capable accounts other than the PR author. Received points cannot be forwarded. Delegation does not clear either account's blocking review; [blocking-review policy](2026-09-09-blocked-weighted-approvals-remain-pending.md) remains authoritative.

The latest surviving command in comment creation order determines the recipient. A self-delegation or a subsequently submitted review restores the sender's own decision. Comment-only reviews also reclaim the points; pending reviews do not. Equal timestamps favor the review, and subsequent dismissal cannot revive the delegation. A fresh command after the review can delegate again. Edits and deletions recompute from current comments, including restoration of older commands. The trusted publisher subscribes to all PR conversation comment changes, resolves the live PR head, and reads comments as API data. Creating or editing a still-active eligible command requests review from the recipient unless already requested; other requested reviewers remain unchanged. Drafts do not request reviews. Request failures fail evaluation. It preserves the separate [review-workflow validation](2026-09-10-approval-review-workflow-identity.md).

## Alternatives considered

**Count delegation as immediate approval.** This would approve a PR before the chosen reviewer makes a decision.

**Add the sender's score without removing their direct contribution.** This would count one account twice and weaken the approval threshold.

**Forward received points through delegation chains.** This would let a recipient transfer another person's points to an account that person did not name.

**Keep delegation after the sender reviews.** A submitted review expresses the sender's own decision, so continuing to use someone else's approval would disregard it.

**Persist commands separately from comments.** This would require additional storage and reconciliation for edits and deletions; current comments already provide an inspectable record.

## Consequences

Delegation preserves the sender's [production ownership weight](2026-09-11-production-blame-approval-weight.md) and the independent author-credit rule. Each evaluation needs complete comment history and current participant permissions; missing history fails evaluation. Editing an older command does not change its priority, and deleting a newer command may reactivate an older one. Policy tests cover score conservation, review-driven revocation, permission filtering, review requests, blockers, pagination, and failure publication; workflow tests pin trusted execution and shared per-PR concurrency. Native stale-review and latest-push requirements remain GitHub's responsibility.
