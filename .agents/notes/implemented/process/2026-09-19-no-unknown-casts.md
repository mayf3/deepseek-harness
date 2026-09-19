# Agent Note: Prohibit new assertions to unknown

Status: implemented

English | [中文](2026-09-19-no-unknown-casts.zh.md)

## Problem

An assertion through `unknown` removes TypeScript's compatibility check between the original value and a subsequent asserted type. Production code can hide an incorrect interface, and tests can claim that an incomplete fixture satisfies a service. Existing uses also include legitimate widening of untyped parser results, which can use explicit `unknown` declarations instead.

The repository contains assertions across many independent package and test owners. Removing all of them in one change would combine the enforcement decision with unrelated type and fixture redesigns, making the behavior of each replacement harder to review.

## Decision

New direct assertions to `unknown` are prohibited in first-party JavaScript and TypeScript, including tests, fixtures, benchmarks, and scripts. Both `as unknown` and `<unknown>` syntax are covered, including a parenthesized target type. An `unknown` declaration remains valid: external data can enter as `const value: unknown = JSON.parse(text)` and reach its declared parser before use. Typed in-process values retain the existing rule against unnecessary runtime validation.

The [checker](../../../../scripts/verify-no-unknown-casts.ts), exposed as `pnpm run verify-no-unknown-casts`, uses the TypeScript syntax tree. It scans tracked source files and non-ignored untracked source files; vendored sources and frozen archived Agent Notes retain their ownership exclusions. Comments, strings, and declarations of `unknown` are not assertions.

Existing assertions have an exact baseline keyed by repository-relative path, a SHA-256 digest of the assertion's syntax tokens, and occurrence count. Maintainers may only reduce this baseline. New or changed assertions and stale baseline entries fail the check; a file-wide allowance or a count budget cannot authorize replacement debt. `--prune` only removes entries or reduces counts and refuses to write while new violations exist. There is no command that adds new exceptions.

The checker participates in CI static and primary modes and the local `hygiene` and `check-all` profiles in [the gate runner](../../../../scripts/run-gates.ts). Existing casts remain visible debt for their owners to remove with suitable type, parser, or fixture changes.

## Alternatives considered

**Remove every existing assertion before enforcing the rule.** Rejected because the cleanup spans unrelated services, wire parsers, and test doubles. Exact existing exceptions let enforcement begin without treating a bulk substitution as a type-safety improvement.

**Allow whole files or a repository-wide count.** Rejected because either permits a new assertion to replace a removed one. The baseline identifies each existing assertion and rejects increased occurrence counts.

**Search text for `as unknown`.** Rejected because comments and strings can contain the phrase, while whitespace, comments between tokens, and angle-bracket syntax can conceal an actual assertion from a text pattern.

## Consequences

Owners must resolve a cast before changing or moving its assertion into an unlisted form or file. Formatting whitespace and comments do not change the recorded tokens. Removing a cast also requires pruning its baseline entry, so obsolete allowances cannot silently accumulate.

Passing this check establishes absence of unlisted direct assertions to `unknown`. It does not establish general type safety or follow type aliases; `unknown[]`, `Promise<unknown>`, and other containing types are outside this syntactic rule. Replacing a cast with `any`, another unchecked assertion, or a helper that merely hides the conversion does not resolve the underlying typing problem.
