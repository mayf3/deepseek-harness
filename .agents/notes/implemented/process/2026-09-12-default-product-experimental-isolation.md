# Agent Note: Keep experimental packages outside the default product

Status: implemented

English | [中文](2026-09-12-default-product-experimental-isolation.zh.md)

## Problem

Public npm availability does not make an experimental package part of the default product. Direct manifest checks miss dependency aliases, transitive installation paths, runtime imports declared only for development, and plugins loaded by configuration. The release smoke installs every tarball together, so the presence of experimental packages in its consumer directory does not identify what the default product requires.

## Decision

[`verify-default-product-isolation`](../../../../scripts/verify-default-product-isolation.ts) runs in static CI and package hygiene. It follows runtime dependencies, optional dependencies, and peers from every app and the Python runtime, resolves workspace and npm aliases, and identifies experimental packages by their npm prefix or repository directory. Publication denylist membership has no effect on this classification.

The source check also reads runtime imports in the selected packages, installation-owned profile bundle lists, bundle patches, shipped agent presets, and declared configuration trees. Loader groups, inserts, Include patches, and disabled plugin rows remain checked. Ordinary plugin configuration data is not interpreted as another Loader entry list. Missing default roots fail the check.

The default Web source graph starts at the module scripts in its actual HTML entry, including inline modules and locally referenced Worker entries. The separate experimental preview can exist without joining this graph. Importing it from the default entry fails the check. Source references to Cordis configuration files include the Desktop patch in the same proof.

[`verify-packed-install`](../../../../scripts/release/verify-packed-install.ts) follows the installed dependency graph from `@deepseek-ai/dsh`, using resolved manifest names to detect aliases and external transitive dependencies. Development dependencies and unrelated tarballs installed beside the product are excluded. Missing required dependencies fail; omitted optional dependencies remain allowed unless they name an experimental package.

This check enforces the existing [experimental dependency isolation rules](../architecture/2026-08-18-experimental-agent-teams-packages.md). The [publication policy](2026-09-12-experimental-publication-denylist.md) independently determines which experimental packages explicit consumers may install.

## Alternatives considered

**Check only direct dependency names.** Aliases, runtime source imports, and configuration-loaded plugins can bypass that check.

**Reject every installed experimental tarball.** The release smoke intentionally installs the whole release family, including opt-in packages. Only the default entry's dependency graph answers whether those packages ship as product requirements.

**Scan every Web source as a default entry.** This would reject the separate experimental preview even when the default HTML and runtime imports never reach it.

## Consequences

Experimental packages may publish without joining default installations or compositions. The source proof covers declared and literal runtime references; the installed check additionally validates the package-manager-resolved dependency graph. Arbitrary runtime-generated module names remain subject to composition review and runtime tests rather than static evaluation.
