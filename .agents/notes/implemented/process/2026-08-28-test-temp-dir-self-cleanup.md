# Agent Note: Unit tests remove the dsh-* temp dirs they create

Status: implemented

English | [中文](2026-08-28-test-temp-dir-self-cleanup.zh.md)

## Problem

Test processes create `/tmp/dsh-*` directories with `mkdtemp(join(tmpdir(), 'dsh-*'))` and leave them behind. On the self-hosted Linux CI host (32 runner instances sharing one `/tmp`) the residue exhausted the root partition's inode capacity twice (issue #3134, 2026-08-13 and 2026-08-26). The machine-side `dsh-tmp-sweep` timer and the CI lane sweep (kept, unmerged, on branch `fix/ci-tmp-residue-cleanup`) remove residue after the fact but leave the producing defect in place. Human review of #3233 (2026-08-28) rejected the sweep: unit tests must clean up the directories they create instead.

## Decision

Retrofit removal of every `dsh-*` temp dir a spec file creates, at the owning test's teardown:

- Spec files that created dirs without removing any now track each created root in a module-level list and delete the list in `afterEach`/`afterAll` (`rm`/`rmSync` with `recursive: true, force: true`), the convention already used across the session packages. Root-creating helpers (`tmp()`, `tempDir()`, `fakeLauncher()`, harness functions) register the root at creation, so every caller is covered at one point.
- Module-scope fixture dirs shared by a whole file (executor spill dirs) are removed in `afterAll` after the last test.
- The file list came from the observed-residue inventory on the CI host (a template histogram of current `/tmp/dsh-*` dirs): only spec files whose dirs actually appeared were leak sources. Files that already remove their dirs (agent-team, tool-subagent, list-children, hooks coverage cases) were confirmed clean on the normal-exit path and left unchanged.
- Product per-process spill roots (`privateSpillDir` in `dsh-subprocess-local/spawn`, `privateRoot` in `dsh-spill-local/store`) register a `process.once('exit')` handler that removes the memoized directory, so every process that used the spawn/spill path cleans up on normal exit.

## Verification

- Targeted local run of every changed spec (32 files, 700 tests) passed, including the suites that exercise the changed product sources.
- CI runs the changed specs on the Linux and Windows coverage lanes; after a full green run, the fixed files' residue templates (observed at up to ~5,000 dirs per two hours each, e.g. `dsh-profile-`, `dsh-app-boot-`, `dsh-presets-*`, `dsh-upload-index-`) should no longer appear in fresh `/tmp` residue on the CI host.

## Alternatives considered

### Keep the sweep-only approach (rejected in review)

Sweep steps and timers delete residue after it exists; they do not stop local runs from accumulating, and a machine sweep cannot distinguish a dead run's residue from a live one's. The reviewer decision was per-test cleanup, implemented here for the normal-exit path.

### Introduce a shared temp-dir helper package

Not chosen: the files that leak each create roots through their own small helpers, and tracking them at those helpers is a per-file one-point change. A new test-support package would add a dependency without reducing the per-file audit.

## Consequences

- Bought: on normal completion — including failed tests — a spec's `dsh-*` dirs are removed at teardown, and per-process spill roots are removed when their process exits normally.
- Cost: a process killed with SIGKILL (a cancelled run, a timeout kill) cannot run any in-process teardown; its in-flight residue remains. The machine-side timer stays as the backstop for that path.
- Cost: dirs created by a spawned child are covered only when the test knows their paths; product-owned per-process roots are covered by the exit handler in the process that created them.
