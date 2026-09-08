---
description: "The boot package group: how dsh app bins start — environment loading, profile and patch layers, clear startup failures, and app-owned command lines."
kind: "package-group"
---

# boot/ — shared app-bin boot glue

English | [中文](README.zh.md)

## Summary

The boot group provides what every dsh app bin needs to start and to manage what it starts: `app-boot` turns a `cordis.yml` plus your environment and patch layers into a running app with clear failure messages, `cmdline` lets the app own its command-line flags and `--help`, and `plugin-manager` installs, enables, and edits a profile's plugins for the `dsh plugin` command and the Web host alike. All three are libraries imported by `apps/cli`, host packages, and test-only Loader fixtures, never plugins a composition loads; each package README owns its contract.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`app-boot`](app-boot/README.md) | Boots a dsh app from a `cordis.yml`: loads `.env`, applies profile and patch layers, and reports startup failures clearly | (library for the bins) |
| [`cmdline`](cmdline/README.md) | Lets the app own its flags, `--help`, and exit code; passes everything after the launcher's flags through verbatim | `cmdlineArgs`, `appExit` |
| [`plugin-manager`](plugin-manager/README.md) | Installs and probes packages without booting, and enables, disables, retries, and edits user-layer rows over the booted profile; the `dsh plugin` command and the Web host's `plugins` Remote share it | (library for the bins and the host) |

<a id="related-documentation"></a>
## Related documentation

- [dsh app](../../apps/cli/README.md) — the `dsh` bin that consumes these helpers for its boot sequence.
- [Profile bundles](../bundle/README.md) — installable patch layers that `dsh --profile` compositions mount.
- [dsh-home-paths](../util/home-paths/README.md) — the harness-home resolver both packages build on.
- [dsh-cmdline](cmdline/README.md) — how an app owns its flag family instead of the launcher.

<a id="dev-note"></a>
## Dev Note

None.
