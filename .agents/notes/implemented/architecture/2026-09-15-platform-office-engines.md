# Agent Note: One Office engine per platform

Status: implemented

English | [中文](2026-09-15-platform-office-engines.zh.md)

## Problem

Installing WASM beside a usable native engine adds a second LibreOffice payload to application downloads and installed resources. The original fallback policy in [independent kit ownership](2026-09-14-independent-libreoffice-kit.md) requires that extra payload even on fixed-platform Desktop and Python distributions.

## Decision

Harness depends on the kit API and uses its platform-filtered optional engine dependencies. macOS and Windows install their matching ARM64 or x64 native package; Linux installs the shared WASM package. WASM declares Linux as its npm OS. The provider has no direct WASM dependency. Missing native engines on macOS/Windows reject converter creation instead of selecting WASM.

Python sidecar assembly copies only the target engine and its dependency closure. Wheel packaging and runtime lookup require that engine; the relocated conversion smoke checks the selected backend. Desktop carries the ordinary npm installation in application resources. Engine compilation, qualification, and publication remain in the kit repository.

## Alternatives considered

**Keep WASM beside every native engine.** This tolerates a missing optional native package but increases every macOS/Windows installation. Fixed-platform distributions require their native engine to be present and tested instead.

**Remove WASM on every platform.** Linux has no released native engine in this kit family. Keeping the shared WASM package on Linux preserves Office conversion without introducing a new native release target.

**Make the Python Office sidecar optional.** The runtime carries the shared `dsh` CLI and its Web profile as well as the default SDK profile. Requiring the target engine gives the installed wheel a complete shipped profile set and reports an incomplete payload before launch. SDK and headless users also pay the engine download and installed-size cost.

## Consequences

macOS/Windows distributions omit the WASM download and expanded assets. A missing native package becomes an installation defect that must be repaired; conversion does not download an engine. Linux retains its WASM resource and font requirements. The kit’s engine-selection tests and actual npm installation tests cover platform selection; Harness sidecar, wheel, and runtime-resolution tests cover packaging requirements. New package bytes require kit qualification and matching dependency integrity records before publication.

The [public Python release workflow](../../../../.github/workflows/python-release.yml) rejects any wheel at or above 100,000,000 bytes. Selecting one engine reduces payload size but does not establish that a runtime wheel meets this limit; npm engine publication and local conversion are separate from wheel upload eligibility.
