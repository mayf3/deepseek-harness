# Agent Note: Persistence schema policy and review

Status: implemented

English | [中文](2026-09-17-persistence-schema-review.zh.md)

## Problem

Structural fingerprints identify changed persistence types, but a fingerprint alone cannot explain a shared change or distinguish a declared reader promise from an assumption about runtime behavior. Names derived from union positions and traversal paths also change when unrelated siblings are added, obscuring the fields a reviewer needs to inspect.

## Decision

Inventory format 2 records supported compatibility metadata with the affected property. The metadata names its binding, policy version, literal discriminator, unknown-kind preservation promise, and qualified attribution kinds. Policy-bearing graphs use a separate fingerprint domain; graphs without a bound policy retain format-1 normalization and fingerprints. Inventory versions describe schema tooling, independently of Session format versions.

The extractor accepts explicit source bindings only at the core-owned source declaration and requires a literal user or developer role at each use. Producer annotations qualify complete wire-kind groups. The classifier permits a qualified new attribution kind only when both saved schemas carry matching promises. Existing kinds remain subject to structural comparison; removals, retroactive qualification, reserved identities, and unrelated breaking changes retain strict classification. Runtime owners establish and test the promised preservation behavior before activating a binding.

Current inventories retain authored names and source locations as descriptive metadata. Structural digests identify types and provide catalog anchors. Catalogs group source alternatives by literal `kind` and retain every `form` alternative, required field, index signature, and link to its complete definition. Bounded array labels describe their elements instead of inheriting the first event that reached the array. Historical references retain their frozen rendering.

The read-only `persistence-review` command accepts explicit before and after inventories. It matches unchanged schemas by digest and changed alternatives only when literal discriminators identify them uniquely. Ambiguous alternatives remain separate additions and removals. Shared structural evidence lists every affected root, while a separate section preserves the authoritative classifier diagnostics. The [history mechanism](2026-09-11-persistence-type-history.md) continues to own acknowledgement and version requirements.

## Alternatives considered

**Ignore all source changes.** A source can carry replay or validation meaning. Explicit, fingerprinted opt-ins constrain the supported exception and leave other changes visible.

**Use traversal paths as type identities.** Union positions and first-owner paths describe one walk through a graph. Unrelated insertions and shared references can change them without changing the persisted type.

**Infer renames from similar fields.** Several alternatives can have the same discriminator or similar structure. Keeping ambiguous additions and removals avoids presenting an unsupported correspondence as fact.

**Replace compatibility checks with a readable diff.** Review explanations group evidence for a human reader. They cannot relax the classifier or replace the in-tree acknowledgement history.

## Consequences

Declared compatibility promises participate in fingerprints and remain available when comparing historical snapshots. The tooling does not infer or enforce runtime preservation; the owner of an activated binding supplies that behavior. Ordinary comments, labels, and source locations remain outside structural identity.

Complete nested schema graphs remain stored in each inventory. Stable labels and grouped review output reduce presentation noise without changing that storage encoding or rewriting frozen historical records. The [cookbook](../../../../docs/cookbook/reviewing-persistence-type-changes.md) describes the review command and acknowledgement workflow.
