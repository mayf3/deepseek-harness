# Agent Note: Client build-time dependencies stay out of the install face

Status: proposed

English | [中文](2026-08-14-client-build-time-deps.zh.md)

## Problem

A browser artifact resolves nothing on the user's machine:

- A `ui-*` plugin package's browser artifact is `lib/client.js`, where tsdown inlines every non-platform specifier (`noExternal` in `packages/client/tsdown.client.ts`). The specifiers that survive are answered by the loader's frozen module table, because `require` inside that bundle is a parameter the loader injects, not Node's.
- Platform modules (`PLATFORM_MODULES`) come from the shell `dist`, never from Node resolution.
- The shell's own imports are inlined by Vite into `@deepseek-ai/dsh-web-frontend`'s published `dist`; that package ships `dist` alone and has no `.` export.

Every browser code path is therefore a build product, served as an asset or baked into `dist`. Yet the packages those artifacts are built from — react, react-dom, shiki, katex, clsx, the micromark and mdast families — sit in `dependencies` and non-optional `peerDependencies`, which npm installs for every consumer of the published package. Across the repository that is 79 such external declarations in 38 packages, downloaded by users who never load them.

## Proposal

### The rule

**An external package only a browser artifact reaches belongs in `devDependencies`.** Two deliberate omissions are as much part of the rule:

- **External packages only.** A `@deepseek-ai/*` name stays where its manifest puts it. Such a declaration also states which package supplies an injected service, which Remote contribution an assembly mounts, or which Loader row must resolve; [verify-runtime-closure](../../../../scripts/verify-runtime-closure.ts) and the Loader read it, and the app installs the package regardless — so moving one removes meaning without removing a download.
- **Anything the node half reaches stays**, an erased type import included.

Faces are walked from the entries a manifest publishes, not by a directory rule, so a module under `src/` that only the browser entry reaches counts as browser source:

| kind | test | host face entries |
| --- | --- | --- |
| `bundle-half` | has a `./client` export | every export target except `./client` |
| `browser-library` | under `packages/client/` with no `./client` export | `src/invariant.ts` alone — the companion the host mounts; `.` is browser code |
| `prebuilt-dist` | no `.` export, ships a `dist` | none: the package offers Node no entry |

### The gate: `scripts/verify-client-runtime-deps.ts`

Wired into `pnpm run hygiene`, about 35 seconds — the cost of two bound Programs, the same order as `verify-optional-dependency-imports` in that lane. It reuses the repository's tooling rather than growing its own: `TypeScriptProject` (`scripts/ts-project.ts`) binds the host and client compiler faces separately (that file states why the two cannot share one program — the cordis Context merges collide), `ts.resolveModuleName` resolves relative specifiers, and the walk stops at the package boundary.

Three findings decided the mechanism, after a first pass that scanned string literals:

1. A package name must match as a name: the `react` substring inside `'@deepseek-ai/dsh-client-web-react'` silently swallowed react.
2. Whether `./client` is the tsdown browser bundle is keyed on the **artifact path** (`./lib/client.js`), not the subpath name — `dsh-goal` publishes `./client` as `./lib/types/client.js`, a plain tsc-emitted browser-shared module.
3. `require`, `require.resolve`, and dynamic `import()` on a literal each reach a package; `require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')` is a real host resolution path.

Two classes, both reported per entry:

| class | count | test |
| --- | --- | --- |
| `browser` | 74 | only a browser artifact reaches it |
| `nothing` | 5 | no reference names it: `client-runtime`'s `react` (which contradicts its own React-free layering red line), the peer `react` of `ui-settings` and `ui-theme`, `ui-trajectory`'s peer `react-dom`, and `ui-primitives`' `@types/mdast` |

Each conservative rule below answers a false report or a semantic loss observed while building it:

- **A type reference from the node half keeps its declaration.** `import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'` in `src/invariant.ts` is erased at run time, yet it states which package supplies the service that companion registers — `verify-runtime-closure`'s relation.
- **A package publishing a Node entry with no source counterpart is skipped whole, and named in the output.** `dsh-goal`'s `./typert -> ./lib/typert.host.js` is emitted by the typert generator and carries its own `import { z } from 'zod'`, which no source states. Getting this test right removed four false reports, among them `api-gateway`'s `typert-registry`.
- A `cordis*.yml` the package owns counts as host face: a Loader row names its plugin instead of importing it.
- `@deepseek-ai/cordis` is exempt — check-workspace-constraints requires it as both peer and dev everywhere.

`--json` output feeds the bulk edit and the install measurement.

### What leaves an install

Measured against a real `npm install` of the published CLI, with tarball bytes read from an isolated cache: 103 external tarballs stop being downloaded, 6.05 MB in total.

| group | packages | saved |
| --- | --- | --- |
| syntax highlighting and math (shiki family, oniguruma family, katex) | 16 | 3.93 MB |
| react and view libraries (react, react-dom, scheduler, immer, zustand, `@tanstack/*`, clsx, use-sync-external-store) | 11 | 1.47 MB |
| markdown and ansi pipeline plus odds and ends (micromark, mdast, hast families, anser, a few `@types/*`) | 76 | 0.65 MB |

Our own six browser-library packages (ui-primitives, ui-slots, web-react, ui-attachment, schema-form, client-web — 0.20 MB together) stay installed: code names them, and the rule above leaves those declarations alone.

### How it lands, split by nature

1. **Documentation first**: a declaration section in `packages/client/AGENTS.md`, and one clause in the new-plugin-package checklist.
2. **The gate**: `scripts/verify-client-runtime-deps.ts`, its `package.json` script, its place in `hygiene`, and a counterexample spec.
3. **The manifests**: 79 entries in 38 packages. 50 need a new `devDependencies` entry; the rest already carry one, so the change is a deleted line.
4. **Re-measure after the next release** with the same method, confirming the 103 tarballs stay gone.

## Alternatives considered

- **Scanning string literals**: the first implementation, rejected by the three findings above — the react-inside-web-react substring had already produced a silent miss.
- **Reading built artifacts (`lib/**/*.js`) instead of source**: that is Node's own view, but the gate would then depend on `pnpm run build`, and it still cannot judge a browser-library's `lib/index.js` (node platform, browser content), so the face test stays either way.
- **Asking the checker whether a binding is used in a value position** (what `verify-optional-dependency-imports` does): tried, and it also judged 83 node-face type-only declarations movable — no download saved for a real loss of meaning, 53 of them `dsh-invariants`. This gate needs to know whether a reference exists, not whether it is a value.
- **Also clearing our own six browser-library packages from the install face**, on the test that no install loads one: another 0.20 MB, at the price of deleting 74 workspace declarations that code genuinely names. Ruled out (2026-08-14): keep what the code names. The cleaner end state is to stop publishing those six packages, which is its own proposal.
- **`peerDependenciesMeta.optional` instead of `devDependencies`**: npm does skip an optional peer, but the meaning is "a consumer may supply this", and there is no run-time consumer at all. The repository must install it to build, which is what `devDependencies` says.
- **Leaving it to knip**: out of scope for knip, which reports a declared package nothing imports. These specifiers are imported; a bundler inlines them. The evidence is that they persisted on master with knip green. Only the five `nothing` entries overlap.
- **`optionalDependencies`**: wrong meaning — it says "skip this if it cannot be installed".

## Acceptance criteria

- `pnpm run hygiene` includes `verify-client-runtime-deps` and passes; a counterexample spec proves one `dependencies.react` is rejected.
- `pnpm run build`, `pnpm run test:gui`, and `DSH_SNAPSHOT=replay pnpm run test:web` pass — the move changes no build input, so artifacts stay byte-identical.
- A real install after the next release no longer downloads the 103 tarballs above.

## Risks

- **The six browser-library packages that stay installed carry bare imports nothing resolves**: `ui-primitives/lib/index.js` is a rolldown artifact and still reads `from "anser"`, while anser is now dev-only. It is inert — only our Vite build reads that file, and no loader exists for it on a user's machine (verified: only browser code imports those packages, never the host). Retiring their publication is the way to erase it; see Alternatives.
- **`@types/*` go unreported**: source never names them, so the rule cannot see them. `@types/mdast` was caught only because nothing referenced it either. They belong in dev regardless, and closing that gap is follow-up work.
- **A skipped package is unprotected**: `dsh-goal` is skipped whole for its generated entry, so its browser-side declarations are now nobody's business. Reading a generated artifact's own run-time imports is what would let the exemption be withdrawn.
- **A false report would delete a declaration something needs at run time**: three defenses hold that line — literal arguments to `require`, `require.resolve`, and dynamic `import()` count as references; a package's own `cordis*.yml` counts as host face; and no `@deepseek-ai/*` name is subject at all.
