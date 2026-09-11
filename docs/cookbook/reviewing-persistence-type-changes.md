---
description: "Generate, acknowledge, and verify Session persistence-type changes locally before opening a pull request."
---

# Cookbook: reviewing persistence-type changes

English | [中文](reviewing-persistence-type-changes.zh.md)

## Summary

Use this tutorial after changing a declared Session persistence type in a contributor checkout with dependencies installed. You will inspect the structural differences, supply a bilingual compatibility explanation, and run the same check locally that CI runs. The [record reference](../persistence-changes/README.md) explains the files and automatic rules. All comparison inputs live in the checkout; no base branch or network access is required.

## Table of Contents

- [1. Inspect the change](#generate)
- [2. Supply the explanation and create a record](#acknowledge)
- [3. Verify the result](#verify)
- [4. Update an unaccepted record](#competing-records)
- [Dev Note](#dev-note)

-----

<a id="generate"></a>
## 1. Inspect the change

Run from the repository root after editing the type and its consumers:

```sh
pnpm --silent run verify-persistence-changes --json
```

Read the reported root, path, change kind, and version requirement. A referenced type can affect several event digests; inspect every affected root. Until the history covers the new schemas, verification fails. A stale generated inventory also fails verification; the recording command refreshes it. If only presentation details changed and `changes` is empty, run `pnpm run gen-persistence-catalog`; no new acknowledgement is needed.

<a id="acknowledge"></a>
## 2. Supply the explanation and create a record

Choose the decision from the [compatibility rules](../persistence-changes/README.md#compatibility-rules). Write a local JSON file containing `en` and `zh`, each with `summary`, `compatibility`, and `verification` strings. The following input describes an exercised required-to-optional hook audit field change. Replace the explanation and test evidence with facts about your change; the CLI does not establish these claims.

Save the input as `.artifacts/persistence-change.prose.json`, creating the ignored directory if needed:

```json
{
  "en": {
    "summary": "Makes the persisted hook audit decision optional.",
    "compatibility": "Existing records remain valid. Hook execution consumes HookOutput instead of replaying this audit field. Producers still write decisions, and absence does not imply pass.",
    "verification": "pnpm exec vitest run packages/hooks/hook-protocol/tests/events.spec.ts: 10 tests passed."
  },
  "zh": {
    "summary": "将持久化的钩子审计决策改为可选。",
    "compatibility": "已有记录仍然有效。钩子执行消费 HookOutput，不回放此审计字段。写入方仍然记录决策，缺失不代表 pass。",
    "verification": "pnpm exec vitest run packages/hooks/hook-protocol/tests/events.spec.ts：10 个测试通过。"
  }
}
```

Use a date and descriptive slug in place of this example id:

```sh
pnpm --silent run persistence-changes --record 2026-09-11-poc-optional --decision same-version --prose .artifacts/persistence-change.prose.json --json
```

The command creates the record pair and complete after schemas, updates both generated catalogs and the machine inventory, and records bilingual pairing. Review the authored explanations and generated diff before committing the files reported in `files`. The prose input is an authoring file; the resulting documents retain the explanation. Omitting `--prose` creates unfinished drafts that verification rejects until their explanations are completed.

For a change requiring a bump, first follow [adding a Session format version](adding-a-session-format-version.md), then use `--decision version-bump`. The record must include its own increasing `SessionHeader.version` transition. An unrelated historical bump cannot authorize this change. Routine changes never create another baseline.

<a id="verify"></a>
## 3. Verify the result

The same check runs locally and in CI:

```sh
pnpm --silent run verify-persistence-changes --json
```

Success reports `ok: true` when the generated inventory matches source, each transition satisfies its classification, and current roots match their terminal history states. Failure reports `ok: false` and exits with code 1; do not treat parseable JSON as success. The response includes `operation`, `message`, structured `changes`, per-root before/after digests in `roots`, generated `files`, and a failure `code` when applicable. Each change has a stable `kind`; automation does not need to parse the description.

Run the other checks selected by the changed code, including documentation checks for accompanying authored pages. Record generation owns its catalog and record pairs; edits to a package README or other bilingual page still follow their normal pairing workflow. Persistence-type checks do not replace behavior tests or migration validation.

<a id="competing-records"></a>
## 4. Update an unaccepted record

If source changes after recording, review the compatibility explanation and refresh the same unaccepted terminal record:

```sh
pnpm --silent run persistence-changes --update 2026-09-11-poc-optional --decision same-version --prose .artifacts/persistence-change.prose.json --json
```

The command refreshes the machine declaration, schemas, catalogs, and pairing. Without `--prose`, it preserves the existing explanation. Update refuses the initial baseline and records that another record depends on. The tree cannot identify which records were accepted in review: preserve accepted history and create a successor instead.

When integration creates competing terminal records, update the unaccepted record against the remaining history, then reassess the resulting diff. An unrelated root's acknowledgement does not need refreshing. The [mechanism decision](../../.agents/notes/implemented/process/2026-09-11-persistence-type-history.md) explains why complete snapshots and per-root predecessors are retained.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
