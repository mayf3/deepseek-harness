# Agent Note: Omit the filesystem payload-only invariant companion

Status: proposed

English | [中文](2026-09-19-omit-fs-payload-invariant.zh.md)

## Problem

The [filesystem invariant](../../../../packages/fs/fs/src/invariant.ts) checks non-empty target strings, a non-empty present version, and an observation discriminant. It reads one dispatch payload, retains no history, and compares no provider, policy, filesystem, or independently mutable state. Its [tests](../../../../packages/fs/fs/tests/invariant.spec.ts) construct malformed payloads directly. Publishing this check costs a companion module, export/build wiring, invariant dependencies, compiler references, and dedicated tests.

The [package rules](../../../../packages/AGENTS.md) require observations that can independently diverge, and the [runtime-invariant reference](../../../../packages/runtime-diagnostics/invariants/README.md) describes event-stream or mutable-data relationships rather than single-payload validation. This companion supplies no such comparison. Retaining it would require an explicit exception to the current rule.

## Proposal

Apply the independent-observation criterion to this concrete companion and remove it. The event producers are independent plugins, but checking the format of each single payload does not compare their observations. Keep typed filesystem events and the real [observation-policy consumer](../../../../packages/fs/fs-observation-policy/src/index.ts), along with parser, wire, read, edit, and write validation at their existing owners.

Remove the 48-line companion, its 55-line dedicated test, `./invariant` export/publication, invariant-only dependencies and compiler references. Add the package-specific omission reason to both fs READMEs. Preserve the other relational checks and shared invariant registration machinery.

## Alternatives considered

**Keep payload validation as an explicit policy exception.** It can detect malformed third-party emissions early, but this would deliberately broaden the stated independent-observation criterion. The proposal prefers input validation at its owner and reserves companions for relational checks.

**Add a second state source to justify the companion.** Rejected without a concrete missing invariant. Duplicating policy state or exposing new API solely to retain this diagnostic increases the maintenance burden.

## Acceptance criteria

- Resolve whether single-payload diagnostics warrant an explicit policy exception before removing the companion; document the package-specific rationale while preserving relational checks.
- No companion source, test, export, artifact entry, invariant-only dependency, or compiler reference remains; package topology checks accept the explained omission.
- Real file-tool and observation-policy tests retain stale-version, absent-target, alias, actor-routing, and world-state assertions. The events and consumers remain.
- Run focused fs and observation-policy tests, relevant file-tool integration checks, source/built invariant-topology checks, build/hygiene, doc-sync, and lint. Do not replace the module with equivalent generic payload-validation machinery.

## Risks

Malformed trusted-plugin emissions lose this opt-in early diagnostic. The check's removal does not justify weakening validation of external data, nor removing other companions that compare lifecycle, durable history, or independently assembled values. If payload-format diagnostics are intentionally part of the companion policy, retain this module and clarify that exception instead.
