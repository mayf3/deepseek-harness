# Agent Note: Weight approvals by changed production-line ownership

Status: implemented

English | [中文](2026-09-11-production-blame-approval-weight.zh.md)

## Problem

A fixed one-point reviewer weight does not reflect authorship of the code a pull request changes. Directory-level ownership can reward unrelated code in the same folder and distort the contribution relevant to the review.

## Decision

The [approval policy](../../../../.github/review-ownership/README.md) scales a one-point approval by `min(2, 1 + 4 × ownedLines / totalLines)` over changed old production lines. Ownership of 0% gives one point, 12.5% gives 1.5 points, and 25% or more gives two points. Scores are not rounded before comparison with the two-point success threshold. The merge base supplies both classification and blame, while GitHub associates blame commits with reviewer accounts. Unlinked authors remain in the denominator. Additions have no prior owner and contribute no lines; an empty denominator produces no boost.

The publisher marks the head pending before evaluation, so an interrupted history fetch cannot preserve an earlier success. It reads complete Git history without checking out PR code. A maintained lexer separates comments from code across the repository’s source languages. Author lookups batch commits and all reviewers share one measurement. Existing [pending-status semantics](2026-09-09-blocked-weighted-approvals-remain-pending.md) and [review-event validation](2026-09-10-approval-review-workflow-identity.md) remain independent requirements.

## Alternatives considered

**A hard 50% cutoff.** A continuous weight reflects partial ownership instead of assigning the same weight to 0% and 49%.

**Directory-weighted ownership.** Code elsewhere in a changed directory does not establish ownership of the lines under review.

**Include newly added lines in the denominator.** Those lines have no merge-base owner and would dilute the authorship signal for existing code.

**Match author names or email strings to reviewer logins.** Display names are not account identifiers, and one account can own commits under multiple emails. GitHub’s commit-author account association supplies that mapping.

## Consequences

History fetching dominates cold execution. On 2026-09-11, local measurements of PR heads `23c77d10aef787df9dfc52b3bd3803122e2ba5bc` and `06be7d3900fd80d28374a5b42442091c55e3f542` against bases `16bf879af2033737b55b24b3896017a388fa974a` and `128bc0784cf9019aba9f5eb0e01865d28b54f241` count 73 and 535 old production lines across 4 and 14 files. Three local runs take 0.31–0.32 seconds and 0.87–0.93 seconds; one batched author query adds approximately one second per PR. A fresh single-branch bare clone of master takes 47 seconds on the same host. These are host observations, not CI time guarantees.

Blame measures last-touch authorship, not review quality or semantic expertise. The production classifier excludes unsupported source locations and file extensions; adding shipped source outside its inventory requires extending that classifier. Lexer classification is lexical rather than a semantic test of executable behavior. Evaluation errors retain the error status instead of silently awarding or withholding the boost.

## Verification

[Policy tests](../../../../.github/review-ownership/check-approval.test.mjs) cover the threshold, zero denominators, blockers, shared measurements, and failed attribution. [Author tests](../../../../.github/review-ownership/blame-ownership.test.mjs) cover batching, account aggregation, and incomplete responses. [Git integration tests](../../../../.github/review-ownership/test_blame_production.py) exercise merge bases, renames, deletions, mixed comment lines, exclusions, shallow history, and fetching without checking out PR code.
