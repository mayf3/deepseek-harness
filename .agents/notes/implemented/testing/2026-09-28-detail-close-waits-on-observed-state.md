# Agent Note: The task-detail close waits on the observed state

Status: implemented

English | [中文](2026-09-28-detail-close-waits-on-observed-state.zh.md)

## Problem

`packages/client/ui-schedule/tests/task-manager-page.client.spec.tsx`, case "keeps details after a refresh failure and closes them after a successful retry", failed intermittently on the `node 24 / coverage` lane's `thread-safe` partition with `AssertionError: expected <aside aria-label="Task details" …> to be null` at its final assertion. The case and the whole 269-case file pass in local runs; the lane's coverage instrumentation changes only how often the window between the two commits below is observed.

The case's last step retries a failed catalog read after a confirmed deletion, awaits `screen.findByText(en['list.empty'])`, and then reads `screen.queryByRole('complementary')` once. The empty list and the removed detail are separate commits:

- `catalog-source.ts` publishes the read's `records: []` together with `status: 'ready'` in one snapshot, so `TaskManagerPage` renders the `list.empty` status region in that commit.
- `TaskDetail` derives `deleted = deletionConfirmed && !authoritative` in the same commit and closes through its passive effect. That effect calls `onDeleted` → `closeDetails`, wired at the page's `<TaskDetail>` element, which sets `selectedId` to null.
- Only the following render drops `<TaskDetail>`, and with it the `complementary` region.

`findByText` resolves on the commit that renders the empty list; the close is scheduled by that commit's passive effect and its render lands after it, so a single read issued on the resolution of the first signal can still see the panel. The page-level effect that also closes a selection whose record left an authoritative ready snapshot does not fire in this case: `useTaskDetail` keeps the confirmed deletion's task as its draft, so `selected` stays defined through the frame in which the row disappears.

## Decision

The final assertion waits for the state it asserts: `await waitFor(() => { expect(screen.queryByRole('complementary')).toBeNull() })`. The `findByText` await stays as the case's check that the list fell back to its empty state; it is not treated as a signal that the close has already been committed.

The product behavior is unchanged. The close is a post-commit effect by design: while a deletion is confirmed or a save failed, the panel must survive a refresh that removes its row, so it cannot be derived away during the render that drops the row.

## Alternatives considered

**Read the panel once after a longer wait, or retry the read outside the assertion.** Rejected: the assertion's subject is the DOM after the close, and `waitFor` polls exactly that state with a bounded default. A longer single read only moves the window, and any retry that is not tied to the asserted condition can pass on a panel that never closes.

**Drive the retry through a `Promise.withResolvers` deferred and one `await act(...)`, as the neighboring refresh-ordering cases do.** Not chosen here: those cases hold both the deletion's and the refresh's promises because their subject is the ordering between the two, while this case's subject is the state the retry button's own path settles into. A deferred retry would hand the case the refresh's resolution and flush the close into the same act boundary, replacing the user-visible `list.retry` path with a hand-driven one. Polling keeps that path, and the negative control under Consequences shows the failure still lands on the assertion when the panel never closes.

**Close the detail during render instead of in an effect.** Rejected: the detail must stay mounted while a deletion is confirmed or a save failed, including through refreshes that no longer report the row, so that its failure notice and its saved records remain reachable. Deriving the selection from the catalog would unmount it on the first refresh that drops the row, which is the state this case's earlier assertions pin as retained.

**Assert that `onDelete` settled instead of asserting the DOM.** Rejected: the case's subject is that the panel left the page. A settled callback does not prove the region was removed, and the deferred close is what the case exists to cover.

## Consequences

The case now observes the commit that closes the detail rather than the commit before it, and its cost is bounded by `waitFor`'s default timeout only when the panel genuinely does not close.

The case pins the close in both directions. With coverage instrumentation, which is the CI condition this failure appeared under, the pre-fix single read failed 1 of 5 local runs of the case with the CI message, and the waiting assertion passed 10 of 10 runs of the same command. A 25 ms `setTimeout` inserted between the `deleted` condition and `onDeleted` in `TaskDetail` makes the pre-fix single read fail at the same assertion while the waiting assertion stays green under the same delay; with the close call removed from that effect (`if (deleted) onDeleted`, which references the function without invoking it), the waiting assertion fails at that assertion, so a panel that never closes is still reported. The case ran 10 more times under `-t` and the whole 269-case file 3 times, with no failure.

## Related

- [Windows-lane observations wait on the state they read](2026-09-27-observation-waits-on-observed-state.md) states the rule this case applies: an observation waits on the state it reads, not on a wall-clock window or an earlier signal.
- [Web lane assertions name their input state](2026-09-27-web-lane-assertions-name-their-input-state.md) records the same class on the web e2e lane, where five assertions sampled state a preceding action had not settled. This note stays separate because the lane, the committing mechanism (a passive effect), and the negative control differ.
