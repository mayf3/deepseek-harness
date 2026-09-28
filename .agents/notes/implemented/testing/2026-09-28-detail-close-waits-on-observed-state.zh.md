# Agent Note: 任务详情关闭断言等待它所观测的状态

Status: implemented

[English](2026-09-28-detail-close-waits-on-observed-state.md) | 中文

## Problem

`packages/client/ui-schedule/tests/task-manager-page.client.spec.tsx` 的用例 "keeps details after a refresh failure and closes them after a successful retry" 在 `node 24 / coverage` lane 的 `thread-safe` 分区上间歇失败，失败点是它最后一条断言：`AssertionError: expected <aside aria-label="Task details" …> to be null`。该用例与本文件全部 269 个用例在本地都通过；该 lane 的覆盖率插桩只改变下面两个 commit 之间那个窗口被观测到的概率。

该用例最后一步在一次已确认删除之后重试失败的目录读取，`await screen.findByText(en['list.empty'])`，然后只读一次 `screen.queryByRole('complementary')`。空列表与被移除的详情并不在同一个 commit：

- `packages/client/ui-schedule/src/client/catalog-source.ts:108-110` 把这次读取的 `records: []` 与 `status: 'ready'` 发布在同一个快照里，因此 `TaskManagerPage.tsx:153-159` 在这个 commit 渲染 `list.empty` 状态区域。
- `TaskDetail` 在同一个 commit 计算出 `deleted = deletionConfirmed && !authoritative`（`TaskDetail.tsx:462`），并通过 `TaskDetail.tsx:463-465` 的被动 effect 关闭。该 effect 调用 `onDeleted` → `closeDetails`（`TaskManagerPage.tsx:95-97`，接线在 `TaskManagerPage.tsx:208`），后者把 `selectedId` 置为 null。
- 只有下一次渲染才移除 `<TaskDetail>`（`TaskManagerPage.tsx:204`），`complementary` 区域随之消失。

`findByText` 在渲染空列表的那个 commit 上返回；关闭由该 commit 的被动 effect 排入，其渲染落在其后，因此在第一个信号返回时就发出的单次读取仍可能看到面板。`TaskManagerPage.tsx:89-93` 的页面级 effect 也会在记录离开权威 ready 快照时关闭选区，但它在本用例中不触发：`useTaskDetail` 把已确认删除的任务保留为草稿（`TaskDetail.tsx:378`），于是 `selected` 在行消失的那一帧里仍然有定义。

## Decision

最后一条断言等待它所要断言的状态：`await waitFor(() => { expect(screen.queryByRole('complementary')).toBeNull() })`。`findByText` 的等待保留，作为该用例对「列表回退到空状态」的检查；它不再被当作「关闭已经提交」的信号。

产品行为不变。关闭按设计是提交后 effect：删除已确认或一次保存失败时，面板必须在该行消失的刷新过程中保留，因此它不能在丢弃该行的同一次渲染里被推导掉（`TaskDetail.tsx:459-461`）。

## Alternatives considered

**在更长的等待之后只读一次面板，或在断言之外重试该读取。** 不采纳：该断言的对象是关闭之后的 DOM，而 `waitFor` 轮询的正是这个状态，且带有有界默认值。更长的单次读取只是把窗口挪走；任何不与被断言条件绑定的重试都可能在永不关闭的面板上通过。

**把详情关闭改为渲染期推导，而不是放在 effect 里。** 不采纳：删除已确认或保存失败期间，详情必须在刷新不再报告该行时继续挂载，这样它的失败提示与已保存记录仍然可达。把选区从目录推导出来，会在第一次丢弃该行的刷新就卸载它，而该用例前面的断言固定的正是「保留」这一状态。

**断言 `onDelete` 已结算，而不是断言 DOM。** 不采纳：该用例的对象是面板离开了页面。回调已结算并不能证明该区域已被移除，而延迟的关闭正是这个用例存在的原因。

## Consequences

该用例现在观测的是关闭详情的那个 commit，而不是它之前的一个 commit；只有面板真的不关闭时，它才付出 `waitFor` 默认超时的代价。

该用例在两个方向上都能固定这次关闭。在覆盖率插桩下（也正是该失败出现的 CI 条件），修前的单次读取在 5 次本地运行中有 1 次以 CI 的消息失败，而等待式断言在同一命令的 10 次运行中全部通过。在 `TaskDetail.tsx` 中把 `deleted` 条件与 `onDeleted` 之间插入 25 毫秒的 `setTimeout`，修前的单次读取会在同一断言处失败，而同一延迟下等待式断言为绿；把关闭路径停用（`if (deleted) void onDeleted`）时，等待式断言在同一断言处失败，因此永不关闭的面板仍会被报告。改动后又用 `-t` 跑了 10 次、整文件 269 个用例跑了 3 次，均未失败。
