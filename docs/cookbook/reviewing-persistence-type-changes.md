---
description: "Generate, acknowledge, and verify Session persistence-type changes locally before opening a pull request."
---

# Cookbook: reviewing persistence-type changes

English | [中文](reviewing-persistence-type-changes.zh.md)

## Summary

Use this tutorial after changing a declared Session persistence type in a contributor checkout with dependencies installed. You will inspect the structural differences, record their compatibility decision, and run the same check locally that CI runs. The [record reference](../persistence-changes/README.md) explains the files and automatic rules. All comparison inputs live in the checkout; no base branch or network access is required.

## Table of Contents

- [1. Generate the current inventory](#generate)
- [2. Create the acknowledgement](#acknowledge)
- [3. Explain and verify the change](#verify)
- [4. Resolve competing records](#competing-records)
- [Dev Note](#dev-note)

-----

<a id="generate"></a>
## 1. Generate the current inventory

Run from the repository root after editing the type and its consumers:

```sh
pnpm run gen-persistence-catalog
pnpm run verify-persistence-changes
```

Review the generated [catalog](../persistence-catalog.md) and [schema inventory](../persistence-schema.json). A nested referenced type can affect several event digests; inspect all reported roots. Regeneration does not acknowledge a change. Until the history covers the new schemas, verification reports the changed paths and fails.

<a id="acknowledge"></a>
## 2. Create the acknowledgement

Choose the decision from the [compatibility rules](../persistence-changes/README.md#compatibility-rules). For an optional body addition, use a date and descriptive slug in place of the example id:

```sh
pnpm run persistence-changes --record 2026-09-11-optional-display-metadata --decision same-version
```

The command creates English and Chinese record drafts and a generated schema companion in [persistence-changes](../persistence-changes/README.md). Each affected root references its latest recorded predecessor. The after schemas and digests come from source; do not edit them by hand.

For a change requiring a bump, first follow [adding a Session format version](adding-a-session-format-version.md), then use `--decision version-bump`. The record must include its own increasing `SessionHeader.version` transition. An unrelated historical bump cannot authorize this change. Do not create another baseline for routine changes.

<a id="verify"></a>
## 3. Explain and verify the change

Replace the generated compatibility and verification placeholders in both languages. Keep the machine declarations identical. Explain only the reported type changes, and record actual focused test results. For optional additions, review whether old records can omit the data and older readers can ignore it without changing replay; automatic classification cannot prove that explanation.

Update the catalog's Chinese counterpart with the generated English changes. Confirm both pairs, then verify:

```sh
pnpm run verify-translation-pairing --write docs/persistence-catalog.md
pnpm run verify-translation-pairing --write docs/persistence-changes/2026-09-11-optional-display-metadata.md
pnpm run verify-persistence-catalog
pnpm run verify-persistence-changes
```

Use your actual record id in the pairing command. Verification succeeds when generated files match source, every transition satisfies its classification, and every current root matches its terminal history state. Include the generated files, record pair, and both consistency sidecars in the PR. Run the other checks selected by the changed code; this check does not replace behavior tests or migration validation.

<a id="competing-records"></a>
## 4. Resolve competing records

When integration reports two successors to one root's predecessor, keep the accepted record and recreate the unaccepted record against it using a new id. Reassess the resulting combined type change and rerun the checks. An unrelated root's record does not need refreshing.

If source changes after a draft was generated, discard only that unaccepted draft and its companions, regenerate the inventory, and create the replacement record. Preserve accepted history. A later type edit must not retain an acknowledgement of a different digest. The [mechanism decision](../../.agents/notes/implemented/process/2026-09-11-persistence-type-history.md) explains why complete snapshots and per-root predecessors are retained.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
