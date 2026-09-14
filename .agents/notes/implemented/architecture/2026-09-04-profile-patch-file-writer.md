# Agent Note: Profile patch files share one parser and writer

Status: implemented

English | [中文](2026-09-04-profile-patch-file-writer.zh.md)

## Problem

The launcher and plugin manager consume the same profile patch format. Separate parsers can disagree about accepted rows or relative module paths, and rewriting a YAML document as plain objects loses comments and unresolved `!!js` expressions.

## Decision

`dsh-app-boot/patch-file` owns patch parsing and editing. The boot entry delegates to its parser; management operations use its comment-preserving YAML document and locked atomic writer. Relative plugin names resolve from the patch file's directory. Editing a row preserves unrelated fields, comments and expression text; deleting a row preserves its comments on a neighbour or the document.

## Alternatives considered

**Independent parsers or whole-document serialization.** Both let a file accepted by one consumer change meaning in another. A shared parser defines accepted input, while the YAML document editor retains syntax that plain object serialization discards.

## Consequences

Global row operations edit the profile user layer without modifying bundle files. A write holds the file lock across read, mutation and atomic replacement, then parses the written result. Unchanged documents are not rewritten.

## Testing

`packages/boot/app-boot/tests/patch-file.spec.ts` covers parsing, relative module paths, comments, `!!js`, row edits, locking and write failures. Plugin-manager tests exercise global row changes through real profile files.
