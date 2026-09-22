---
description: "Single file-extension to syntax-highlighting language table shared by the Client code surfaces and the Host read card."
kind: "package-library"
---

# dsh-util-code-language

English | [中文](README.zh.md)

## Summary

The repository's one file-extension to syntax-highlighting language table, shared by the Client's document Code preview and diff review and by the Host read tool's persisted `lang` hint. `languageForPath` maps a path to a canonical grammar id case-insensitively, recognizing both path separators and treating a leading dot as the separator (`.env` is `dotenv`); `CODE_HIGHLIGHT_EXTENSIONS` lists every suffix for a preview registry. `readLangHintForPath` projects the read card's persisted `lang` onto short ids: the suffixes the old read table recognized keep their historical value byte-identical, and every later suffix uses its language's short name (`powershell` to `ps1`, `hcl` to `tf`). The package is browser-safe, stateless, and leaves tokenization to the Client highlighter.

## Table of Contents

- [Language selection](#language-selection)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="language-selection"></a>
## Language selection

The table lives in [`src/index.ts`](src/index.ts). Each key is a canonical language id — the grammar id the Client highlighter resolves — and each value is the lowercase extensions without the dot that select it. `languageForPath(path)` takes the text after the last dot of the final path segment, lowercases it, and looks it up in a `Map`; a `Map` keeps a filename such as `foo.constructor` from resolving an `Object.prototype` member. An unlisted dotfile (`.gitignore`), an absent extension, a trailing dot, and an unknown suffix all return `undefined`, which every consumer renders as plain text; a leading dot is still the separator, so `.env` resolves to `dotenv`. Both `/` and `\` separate path segments, so a Windows path resolves like a POSIX one.

The set is curated for common source, config, script, data, and markup extensions rather than mirroring a full language registry. Extensions with no matching grammar map to the nearest one (`properties` to `ini`, whose registration carries the `properties` alias); certificate and lock extensions (`pem`, `crt`, `key`, `cer`, `lock`) stay unlisted, and `csv` stays unlisted because the Spreadsheet preview declares the suffix and must keep it, so the earlier Code registration cannot claim it. `readLangHintForPath` is a projection over this table: a suffix the pre-unification read table recognized returns its old short id, a suffix present only here returns the language's short name (`powershell` to `ps1`, `hcl` to `tf`), and an unrecognized suffix returns `undefined` — so the persisted field holds one style, a short id, never a canonical grammar id. A consumer that needs the Client highlighter to actually tokenize a language still depends on that grammar being registered there — an id without a loaded grammar renders as plain text rather than failing.

-----

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Extension-only matching** — `languageForPath` reads a suffix, so names recognized without one (`Dockerfile`, `Makefile`, `.gitignore`, `.editorconfig`) stay unlisted. Filename rules are deferred.
- **No content sniffing** — a file with an absent or unknown extension stays plain text even when its bytes are unambiguous; the table never inspects content.
- **Curated, not exhaustive** — the table is smaller than Shiki's grammar catalog and GitHub linguist; adding a language means adding both the extension entry and the Client grammar registration.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This utility owns no mutable runtime relationship.
