# Agent Note: Localize bilingual document links

Status: implemented

English | [中文](2026-08-18-localized-bilingual-links.zh.md)

## Problem

GitHub resolves repository Markdown links directly, without the documentation website's locale projector. Requiring both sides of a bilingual pair to retain the same raw `.md` destination therefore sends readers from Chinese source files to English pages even when a reviewed `.zh.md` sibling exists. The website masks this error by routing ordinary links through the current locale, so the repository source and the published site previously produced different navigation results.

## Decision

A repository-relative document link follows the source file's locale when the target has an English/Chinese sibling pair: English sources use the target `.md`, and Chinese sources use its `.zh.md`. Both sides retain the same semantic target and exact query/fragment suffix. External URLs, images, pure in-page fragments, and targets without a Chinese sibling remain unchanged. The language switcher is the explicit cross-locale exception.

The pairing core resolves relative paths against the repository tree, including extensionless and directory-index aliases, and normalizes paired locale paths to one English-sibling identity for structural comparison. `verify-translation-pairing` separately rejects a wrong-locale target with the source file, line, actual URL, and expected URL. The merge driver and mechanical translation briefing use the same semantic comparison, so they accept locale-correct path differences without weakening any other structural requirement.

The Cordis subsystem-region generator renders one catalog model, then projects paired document destinations for the Chinese output. Generated-region comparison normalizes only these paired locale paths; markers, prose, ordering, code, non-document URLs, and query/fragment suffixes remain byte-equal.

Existing active bilingual sources use the locale-correct target. A Chinese target that lacks an English fragment id exposes an explicit `<a id>` alias before the corresponding translated heading, so both source files keep one stable fragment suffix without a separate translation map. Pair consistency records name the migrated contents.

## Verification

Pairing tests cover English and Chinese locale selection, targets without a sibling, switcher exclusion, exact query/fragment retention, directory-index resolution, definitions, rewrites, and diagnostics. Merge-driver, translation-brief, Cordis generator, and documentation-site tests cover their respective consumers. Corpus checks require zero wrong-locale links, resolvable fragments, fresh generated regions, current pair records, and a successful documentation-site build.

## Alternatives considered

**Keep `.md` destinations on both sides.** This preserves raw target equality but makes GitHub navigation leave the Chinese corpus. Website rewriting cannot repair repository rendering.

**Use translated heading fragments.** Locale-specific fragments require each link producer to know a translated heading and create a second mapping whose lifecycle can drift. One shared suffix plus an explicit target alias keeps the stable identifier with the target document.

**Maintain a locale-link manifest.** The file naming convention and repository tree already determine the target sibling. A second registry would duplicate identity and require updates for every move or new pair.

**Rewrite links only during publication.** The website already does this, but GitHub and other repository renderers consume the source files directly. Correct source paths are the user-visible behavior.

## Consequences

GitHub readers remain in the language they selected when a translated target exists, and future regressions fail in the same corpus-wide pairing check that owns bilingual structure. Pair sides intentionally differ in paired document path spelling, while every other link property stays aligned. Stable English fragment aliases add small permanent identifiers to translated targets, and generators that own both outputs must project locale paths before recording the pair.
