# Agent Note: Derive the shipped preset root per composition

Status: implemented

English | [中文](2026-08-20-derive-shipped-preset-root-per-composition.zh.md)

## Problem

`composeProfile` delivered the shipped agent-preset root by pushing a boot-time overlay whose `config` spread the composed roster row and then hard-set `roots` to the shipped root alone. Because an id-targeted patch replaces the whole `config` value, the overlay squashed every root the profile's `cordis.patch.yml` (or the home layer, or a `--patch` overlay) had configured: a deployment pointing `agent-presets` at a shared preset directory booted with only the shipped root plus the roster's own writable home root, and every custom preset vanished from the Web picker. `dsh --dump-config` composes only the file-backed layers, so the dump showed the configured roots intact while the boot dropped them — the include's own contract that a dump can never drift from what boots was broken by a patch the dump never saw. Externally reported with an accurate root cause in discussion #3636.

The overlay also sat in `ComposedProfile.overlays`, the fixed top layers a live reload replays above fresh user layers. Overlays exist so a user edit cannot displace launcher facts, which is right for `--patch` files and the telemetry switch — but the roster patch had captured the whole boot-time `config`, so after boot no `cordis.patch.yml` edit to the row (`default`, `includeUserRoot`, `roots`) could take effect until restart.

## Decision

The shipped root is a derivation, not an overlay. `resolveShippedPresetPatch(rows)` builds the roster patch from one composed row set: it keeps every configured key and prepends the shipped root (`system` trust) to the composition's `roots`, so the shipped presets always mount and win a duplicate id while configured roots stay live. `composeProfilePatches(layers)` appends that patch to the flattened stack and is the builder boot and the live user-layer reloads share — a reload derives from the current user layers instead of replaying a boot snapshot. The config dump shares the derivation rather than the builder: `renderConfigDump` needs one labeled layer per source, so `runDumpConfig` appends `resolveShippedPresetPatch`'s output as its own layer (labeled `dsh launcher (shipped agent-preset root)`) and composes the roster row exactly as it boots. The telemetry switch stays a boot-only overlay: it is an environment fact of the booting process, carries no config snapshot, and outranking user edits is its purpose.

A `roots` value the launcher cannot statically rewrite — a `!!js` expression or any non-array — now fails loud with a `TypeError` naming the constraint, instead of being silently replaced. The plugin's own contract is untouched: `config.roots` scanned in order, the writable home root appended by `dsh-agent-presets` itself.

## Testing

`shipped-preset-root.spec.ts` covers the derivation directly: prepend order, key preservation, absence without a roster row, per-call derivation, the fail-loud rejections, and the squash regression through a full `composeEntries` application. The Web composition e2e now obtains the shipped root through the real `composeProfilePatches` instead of hand-writing the launcher's patch (three boots had replicated it literally, one admitting "exactly what `composeProfile` supplies"), and adds a configured-roots boot: a shared root's preset lists beside the shipped four, a directory claiming a shipped id is shadowed by it, and a configured-root preset composes an agent. The built-bin dump acceptance asserts the derived layer's label and the shipped-before-configured root order. No keyless snapshot changes: default compositions produce byte-identical stacks, and the snapshot harness has no custom-profile lane — the real-composition e2e is the assembled-application evidence here.

## Alternatives considered

**The reporter's fix: prepend inside the boot-time overlay.** Correct on the squash and the priority order, and kept as the shape of the derived patch. Rejected as-is because the overlay would still freeze the whole boot-time `config` above every later reload, leaving the row's live edits dead until restart.

**Provide the shipped root out of band (a launcher-provided context value the plugin prepends).** Cleanest hot-reload story — no config rewriting at all — but it moves an assembly fact into the plugin's service contract, adds a launcher-coupled provide key to a package that otherwise only reads config, and makes the effective roots invisible to the config dump. The derived patch keeps the roster's inputs entirely in the composition.

## Consequences

Configured preset roots survive boot, live edits to the roster row take effect without restart, and the dump, the live tree, and the boot compose the row identically. The launcher constrains the roster row's `config`/`roots` to literal values; a composition that generated them with `!!js` would previously have had the expression silently discarded and now must materialize the array in a patch layer instead.
