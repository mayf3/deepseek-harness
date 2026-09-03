# Agent Note: A preset takes a user patch layer, and patch files get one home

Status: implemented

English | [中文](2026-09-04-preset-user-patch-layer-and-patch-file-writer.zh.md)

## Problem

A shipped agent preset was read-only in every sense: to switch one of its rows off or add a tool to it, a person copied the whole preset and edited the copy, which then drifted from the shipped one on every upgrade. The profile already had the shape that solves this — a base composition plus a `cordis.patch.yml` user layer applied over it — and the preset had nothing of the kind. Separately, that file format had one parser in `dsh-app-boot` and no writer: a program that wanted to switch a row off had to rewrite the whole file, losing the author's comments and any `!!js` gate it did not understand.

## Decision

**A preset's user layer is `cordis.patch.yml` in its slot.** Beside the composition for a locally authored preset; alone in the user root's directory of the same id (`$DSH_HOME/.agent-presets/<id>/cordis.patch.yml`) for a shipped one, whose install stays untouched. Discovery attaches the layer to the preset that wins the id, judges it with the composition (an unparsable layer, a malformed insert, or an inserted row naming a module that cannot resolve makes the preset broken with that reason), and reports a layer whose id no root supplies as a broken slot rather than hiding it. The mount hands the parsed layer to the include as its runtime patches, so it applies with the Loader's own patch semantics. The composition inventory applies it before flattening and marks each row `source: 'preset' | 'user'` and, when off, `disabledBy: 'composition' | 'user'`. A copy carries the layer in beside the new composition; `removeOverlay` deletes it and an emptied slot.

**Generations follow the layer's content.** The standing mount's stamp now covers the composition file's stat and a digest of the layer's text. A changed layer starts the next generation for sessions created afterwards, as an edited composition always did; a layer edited back to a content an earlier generation composed returns to that generation, so switching a row off and on again does not stack a third live subtree.

**`dsh-patch-file` owns the format.** `parsePatchList` moved out of `dsh-app-boot` and is the one parser (js-yaml with the include's `!!js` dialect, relative names anchored to the file); `PatchDocument` edits a file at the key level through the `yaml` package's comment-preserving document, which keeps an unresolved `!!js` tag on its scalar and prints it back verbatim; `mutatePatchFile` takes the `dsh-atomic-write` lock, reads, edits, replaces atomically when the document is dirty, and parses the written text back. A removed row's comment block moves to its neighbour or the document's trailing comment instead of vanishing.

**`dsh-global-tool-mask` is `tools.restrict()` as a row.** A preset's layer can add rows but could not subtract a host tool; this scope-only row masks named global tools for the sessions of one preset and rejects an unscoped mount, an empty mask, and a name the host does not register.

## Alternatives considered

**A settings namespace per preset for enablement.** Rejected earlier in the design: enablement is composition, not preference, and the profile's own user layer is already a patch file; a preset's should be the same file in the same format.

**Editing the shipped composition in place.** Rejected: an upgrade overwrites it, and a session already running would be the one reading a half-written file.

**A second parser in `dsh-agent-presets` to avoid a dependency on `dsh-app-boot`.** Rejected: two parsers of one format drift; the format got its own package instead, which both depend on.

## Consequences

A person hides a tool from `standard` with three lines under `.agent-presets/standard/` and keeps the shipped composition; the plugin manager writes the same file for them. A layer applies to the sessions created after it changes, never to running ones. The layer addresses rows by the composition's own ids, so an id the composition leaves anonymous cannot be targeted.

## Testing

`packages/preset/agent-presets/tests/overlay.spec.ts` pins discovery (attach, own layer, orphan slot, unparsable, malformed, unresolvable insert, composition verdict first), the mount applying the layer, generations across edits with the retired generation reused, the inventory's `source` and `disabledBy` from the file and from a mount, the layer path for shipped and authored presets, copy carrying the layer, and removal. `packages/util/patch-file/tests/patch-file.spec.ts` pins the parser, the document edits with comments and `!!js` intact, and the locked atomic mutation with readback. `packages/preset/global-tool-mask/tests/global-tool-mask.spec.ts` pins the row's scoping and refusals.
