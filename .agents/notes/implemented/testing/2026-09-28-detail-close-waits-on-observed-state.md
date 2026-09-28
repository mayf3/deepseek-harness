# Agent Note: The task-detail close waits on the observed state

Status: implemented

English | [中文](2026-09-28-detail-close-waits-on-observed-state.zh.md)

## Problem

`packages/client/ui-schedule/tests/task-manager-page.client.spec.tsx`, case "keeps details after a refresh failure and closes them after a successful retry", failed intermittently on the `node 24 / coverage` lane's `thread-safe` partition with `AssertionError: expected <aside aria-label="Task details" …> to be null` at its final assertion. The case and the whole 269-case file pass in local runs; the lane's coverage instrumentation changes only how often the window between the two commits below is observed.

The case's last step retries a failed catalog read after a confirmed deletion, awaits `screen.findByText(en['list.empty'])`, and then reads `screen.queryByRole('complementary')` once. The empty list and the removed detail are separate commits:

- `packages/client/ui-schedule/src/client/catalog-source.ts:108-110` publishes the read's `records: []` together with `status: 'ready'` in one snapshot, so `TaskManagerPage.tsx:153-159` renders the `list.empty` status region in that commit.
- `TaskDetail` derives `deleted = deletionConfirmed && !authoritative` (`TaskDetail.tsx:462`) in the same commit, and closes through the passive effect at `TaskDetail.tsx:463-465`. That effect calls `onDeleted` → `closeDetails` (`TaskManagerPage.tsx:95-97`, wired at `TaskManagerPage.tsx:208`), which sets `selectedId` to null.
- Only the following render drops `<TaskDetail>` (`TaskManagerPage.tsx:204`), and with it the `complementary` region.

`findByText` resolves on the commit that renders the empty list; the close is scheduled by that commit's passive effect and its render lands after it, so a single read issued on the resolution of the first signal can still see the panel. The page-level effect at `TaskManagerPage.tsx:89-93` also closes a selection whose record left an authoritative ready snapshot, but it does not fire in this case: `useTaskDetail` keeps the confirmed deletion's task as its draft (`TaskDetail.tsx:378`), so `selected` stays defined through the frame in which the row disappears.

## Decision

The final assertion waits for the state it asserts: `await waitFor(() => { expect(screen.queryByRole('complementary')).toBeNull() })`. The `findByText` await stays as the case's check that the list fell back to its empty state; it is not treated as a signal that the close has already been committed.

The product behavior is unchanged. The close is a post-commit effect by design: while a deletion is confirmed or a save failed, the panel must survive a refresh that removes its row, so it cannot be derived away during the render that drops the row (`TaskDetail.tsx:459-461`).

## Alternatives considered

**Read the panel once after a longer wait, or retry the read outside the assertion.** Rejected: the assertion's subject is the DOM after the close, and `waitFor` polls exactly that state with a bounded default. A longer single read only moves the window, and any retry that is not tied to the asserted condition can pass on a panel that never closes.

**Close the detail during render instead of in an effect.** Rejected: the detail must stay mounted while a deletion is confirmed or a save failed, including through refreshes that no longer report the row, so that its failure notice and its saved records remain reachable. Deriving the selection from the catalog would unmount it on the first refresh that drops the row, which is the state this case's earlier assertions pin as retained.

**Assert that `onDelete` settled instead of asserting the DOM.** Rejected: the case's subject is that the panel left the page. A settled callback does not prove the region was removed, and the deferred close is what the case exists to cover.

## Consequences

The case now observes the commit that closes the detail rather than the commit before it, and its cost is bounded by `waitFor`'s default timeout only when the panel genuinely does not close.

The case pins the close in both directions. With coverage instrumentation, which is the CI condition this failure appeared under, the pre-fix single read failed 1 of 5 local runs of the case with the CI message, and the waiting assertion passed 10 of 10 runs of the same command. A 25 ms `setTimeout` inserted between the `deleted` condition and `onDeleted` in `TaskDetail.tsx` makes the pre-fix single read fail at the same assertion while the waiting assertion stays green under the same delay; with the close path disabled (`if (deleted) void onDeleted`), the waiting assertion fails at that assertion, so a panel that never closes is still reported. The case ran 10 more times under `-t` and the whole 269-case file 3 times, with no failure.
