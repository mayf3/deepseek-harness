# Agent Note: Published dependency faces and bounded peer relays

Status: implemented

English | [中文](2026-08-26-published-dependency-faces.zh.md)

## Problem

A package may contain a browser bundle, a Host entry, shared TypeScript declarations, and Cordis injection metadata. Encoding all of those relationships as required npm peers made the published CLI expensive to install: npm installs peers automatically and repeatedly evaluates placement through deep, converging peer paths. Changing ranges or making the peers optional did not remove that traversal.

The package that chooses a Client build input is the shipped profile, while a Host value import is loaded by Node from the importing package. Those relationships need different npm sections. Applying one rule to every Host package would reduce the graph but would also create a large migration with no corresponding installation benefit.

## Decision

### Package selection

[`verify-package-dependencies`](../../../../scripts/verify-package-dependencies.ts) owns dependency-section policy. It always covers packages under `packages/client/` and every non-experimental package that declares `dsh.client`. The directory includes static Client inputs without a dynamic row, while `dsh.client` identifies dynamically loaded packages outside it; a `"./client"` export alone is an API and does not select npm dependency policy. Every selected package's Host entry is scanned, including entries under `packages/client/`.

[`package-dependency-policy.ts`](../../../../scripts/package-dependency-policy.ts) provides explicit Client-face include and exclude lists. An include handles an exceptional package without `dsh.client`, while an exclude removes an automatically discovered dual-face package outside `packages/client/`. The verifier rejects unknown, stale, redundant, duplicate, overlapping, and ineffective entries. The include list is empty; the exclude list contains `@deepseek-ai/dsh-api-session-controller`, because adding it back would migrate nine more Host edges while its five-run candidate retest improved median resolution by only 0.15 seconds.

Host-only packages join the same policy through a separate explicit list. The list contains `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-session`; source imports do not expand it.

### Dependency sections

Every covered package keeps `@deepseek-ai/cordis` in matching `peerDependencies` and `devDependencies`. Cordis is the shared plugin runtime whose identity the application controls.

A workspace package reached by a runtime value import from the Host entry closure belongs only in `dependencies`. Workspace imports used by the Client bundle, type-only imports, module augmentations, `dsh.client.inject`, invariant companions, and existing metadata-only peers belong only in `devDependencies`. Existing third-party dependencies outside these managed relationships keep their declared section. Workspace references use `workspace:^`.

The verifier reads source manifests and source files, so it runs on a clean tree without built `lib/`. Its `--fix` mode performs only the section and range changes implied by this classification and removes stale peer metadata.

### Performance verification

[`benchmark-next-package-dependency`](../../../../scripts/benchmark-next-package-dependency.ts) applies the current policy to an in-memory local registry, measures the current CLI graph, and tries every reachable unconfigured Host package one at a time. Concurrent runs provide a coarse shortlist; finalists run serially because npm's peer-placement search can take different paths when metadata request completion order changes.

The benchmark is manual rather than a CI gate. It performs metadata-only installs in fresh consumers, so its relative results identify peer relays without measuring registry latency or archive downloads.

## Alternatives considered

**Keep internal relationships as peers.** npm must place and validate each required peer along converging ancestry paths, which recreates the reported install-time failure even when all internal versions are compatible.

**Use the `"./client"` export as the Client-face roster.** A package may publish Client-facing types or a browser API without contributing a dynamically loaded row. Selecting that package broadens the migration to unrelated Host packages such as Goal, Session Title, and Todo. `dsh.client` identifies dynamic rows, while the `packages/client/` directory independently covers static Client inputs.

**Flatten every Host package.** This removes more peer work but expands the migration to packages whose individual benchmark result is negligible. The explicit Host list preserves the remaining peer contracts until measurement justifies another entry.

**Move every Client-related declaration to development-only.** A dual-face package's Host value imports remain real Node loads. Omitting them from the published dependency graph makes the package depend on accidental hoisting by a profile.

**Enforce a wall-clock threshold in CI.** Resolver time varies with machine load and metadata completion order. Deterministic manifest classification belongs in CI; timing remains a maintainer benchmark.

## Consequences

The published dependency graph follows artifact ownership instead of source-directory coupling. Client bundles and shipped profiles provide browser identities, Host modules install the values they load, and only Cordis remains a repository-wide peer for covered packages.

Moving a public type-only relationship to `devDependencies` means a standalone TypeScript consumer must install the referenced type package when it consumes that declaration. The shipped profiles install the complete supported package family; supporting independently assembled TypeScript consumers would require a different policy.

The explicit overrides and Host list are reviewable decisions. Adding an exception changes the installed graph and requires the focused verifier tests plus a fresh next-package benchmark. The metadata-only benchmark is diagnostic evidence, not a release-time performance promise.
