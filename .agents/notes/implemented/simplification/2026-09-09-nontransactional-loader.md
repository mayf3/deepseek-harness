# Agent Note: Keep Loader mutations non-transactional

Status: implemented

English | [中文](2026-09-09-nontransactional-loader.zh.md)

## Problem

Transactional config reload preserves an old plugin generation after a failed edit, but requires Loader to own candidate imports, lifecycle settlement, rollback, option identity, and Include serialization. These changes make the vendored implementation substantially different from its pinned sources. Application startup and profile patch watching also depend on that settlement implicitly.

## Decision

Revert the five commits in [#932](https://github.com/deepseek-harness/deepseek-harness/pull/932), resolving package moves and retaining independent later behavior. The reported merge commit belongs to the larger #936 dependency chain; reverting its first-parent diff would remove unrelated repository-plugin support. The [vendor ledger](../../../../vendor/README.md#local-modifications) records every retained source change against the unchanged pins.

Loader changes entry options eagerly. EntryGroup starts siblings concurrently and logs application failures; EntryTree waits for outstanding work without rejecting failed fibers. Neither restores a previous plugin or configuration. Include retains parse validation and patch reapplication, but plugin failures can leave a partially applied tree.

Application consumers own their completion checks. The CLI waits for its fallback HMR service before installing live patch watchers. The directory chooser checks the entries it mounts. The chooser and browser package runner capture the first fiber-disposal result before removing the entry, then await it before reporting teardown complete. Preset mounting waits for its subtree and reports import, activation, and missing-service failures. [App boot](../../../../packages/boot/app-boot/README.md) owns exact patch-file watching, activation audits, and partial-context cleanup. These adaptations are separate from the reverse patch.

The small update-result extension forwards asynchronous restart failures through Fiber and Entry updates. The detached import-completion observer handles both fiber outcomes; the fiber still retains its failure for an explicit audit. Durable Include writes drain before and after child removal so a later teardown write cannot erase an earlier terminal write failure. Missing-file initialization waits for its write and rereads the file before mounting initial entries.

## Alternatives considered

**Keep transactional Loader updates.** They provide automatic recovery from a rejected plugin candidate, but retain the vendored lifecycle machinery being removed. Parse failures can be contained without plugin rollback.

**Restore every vendored file verbatim.** This would also remove lazy injected config evaluation, conditional disabled entries, lifecycle disposal fixes, durable writes, and module-loader compatibility. Those changes have independent consumers and remain recorded in the vendor ledger.

**Move generic rollback into app boot.** This would retain the same candidate-generation and restoration obligations under another owner. Applications instead report failures and allow a later valid edit to recover.

## Consequences

A plugin activation failure can leave the new options and a failed fiber in place. Callers that require active plugins must audit after settlement; awaiting `Loader.create()` alone does not establish activation. Automatic plugin rollback requires a separate future decision with evidence that its recovery benefit warrants the additional lifecycle implementation.

[Live-patch tests](../testing/2026-09-09-user-patch-hmr-test-delivery.md) retain controlled event delivery and native watcher coverage, while asserting failure reporting without rollback. The [terminal-release policy](../bug-fix/2026-07-31-fail-loud-releases-the-terminal.md) remains applicable to fatal errors and partial boot teardown. Web preset composition and a real CLI webhook-created model Session provide the application-level verification beyond hand-mounted plugins.
