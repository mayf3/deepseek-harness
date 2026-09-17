---
description: "File-reference prompt evaluation inputs, manual rubrics, and preserved development results for prompt maintainers."
kind: "package-reference"
---

# File-reference prompt evaluation

English | [中文](README.zh.md)

## Summary

This owner-local evaluation compares file-reference guidance using four unchanged development tasks. It preserves A/B/C, the final colon-label revision, eligibility rules, task rubrics, and historical failures. Real-model runs are manual; the existing package tests and Web Session snapshots own keyless product regressions. The runner and aggregator use Python's standard library; the treatment enters the logged system prompt through a regular plugin.

## Table of Contents

- [Run a cohort](#run-a-cohort)
- [Review and summarize](#review-and-summarize)
- [Preserved results](#preserved-results)
- [Dev Note](#dev-note)

<a id="run-a-cohort"></a>
## Run a cohort

Requires Python 3.9+, a POSIX host with `ps`, Node and repository dependencies, and a built checkout (`pnpm run build`). Run from the repository root. Supply the normal DSH environment file with `--env-file`, or inherit its environment; the runner does not read credential values. `--model` is explicit, with the DeepSeek provider and high reasoning effort. Each attempt gets fresh DSH home, agent home, Session, and an archived HEAD workspace; the executable is this checkout's built `dsh --profile headless` launcher.

For one real smoke, set `DSH_EVAL_ENV` to your normal environment-file path and run:

```sh
python3 packages/client/ui-deliverables/evals/file-references/run.py --variant a-colon --case plan --repetitions 1 --model deepseek-flash --env-file "$DSH_EVAL_ENV"
```

Omit `--variant`, `--case`, and `--repetitions` for the original three variants, four tasks, and three repetitions. `--prepare-only` records inputs without calling the API. The default 480-second attempt bound can be shortened with `--timeout`. Runs execute serially and stop at the first failed attempt; no retry or resume replaces an output. The printed directory lives under ignored `.artifacts/file-reference-evals/`, retaining input hashes, source archive, outputs, workspaces, Sessions, and failures. A supplied `--output` must be new and inside `.artifacts/`; missing parent directories are created. The runner reaps the launcher and waits for every process-group member to terminate; zombies awaiting their parent’s reap do not count as running work.

The portable runner uses the normal read-only sandbox and never-approval policy. Evaluator files are removed from the task workspace, but host/runtime/network resources are shared: this is not hermetic isolation. Inspect recorded tool activity for out-of-workspace access. Its controls differ from historical R3's macOS-specific guards and parallel scheduling; compare only within the new cohort, not by pooling it with R3. The archive pins source HEAD while the launcher hash identifies the build; rebuild after runtime changes. Treatment files retain their embedded newline and omit the shipped section’s leading output reminder, so the evaluated text is not byte-identical to the shipped section and cohort numbers do not measure that full section.

<a id="review-and-summarize"></a>
## Review and summarize

Apply [rubric.md](rubric.md) to the full first answer and preserved workspace. Keep evaluators separate from execution; rubric contents are not passed to the model. Occurrence eligibility, unnecessary directories, ambiguity, and factual support require human review. Preserve the occurrence and task ledgers with each run, then write hash-bound `annotation.json` as documented in the rubric. Unreviewed answers remain unreviewed; an absent answer never counts as a perfect response.

The summarizer accepts the printed run directory, or the committed historical observations:

```sh
python3 packages/client/ui-deliverables/evals/file-references/summarize.py packages/client/ui-deliverables/evals/file-references/results/2026-09-16/observations.json
python3 -m unittest discover -s packages/client/ui-deliverables/evals/file-references -p 'test_*.py' -v
```

It validates nonnegative counts, E = L + M + I, duplicate attempts, and fresh-answer hashes. It reports planned/attempted/answered counts, missing audits, valid-link coverage, perfect audited answers, and timeouts. It does not automatically infer missing-file mentions or judge semantic correctness. These keyless Python checks validate the evaluation tools, historical input hashes, and process cleanup in the Linux PR CI job. The package’s normal Vitest suite checks the final colon treatment against the shipped guidance and that guidance in every Web prompt sidecar. No real-API CI job is added.

<a id="preserved-results"></a>
## Preserved results

[The R3 table](results/2026-09-16/metrics.md) retains all 69 original metrics and task rubrics. [Observations](results/2026-09-16/observations.json) reproduce the core counts and include the timeout. [Limitations and later runs](results/2026-09-16/notes.md) keep the colon revisions and guided recording separate. The raw first answers, full Sessions, authentication logs, and original audit ledgers remain in the private experiment archive, not in this package or its npm tarball. Historical aggregate counts support recomputation, not independent re-auditing without those raw records.

<a id="dev-note"></a>
## Dev Note

The [file-preview decision](../../../../../.agents/notes/implemented/feature/2026-09-15-markdown-file-preview-links.md) owns prompt selection. This directory owns reusable evaluation inputs and methods; repository `benchmarks/` owns cross-package performance gates.
