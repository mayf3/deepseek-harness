# Agent Note: Guided plugin installation

Status: implemented

English | [中文](2026-09-15-guided-plugin-installation.zh.md)

## Problem

The install dialog put a spec straight into `pnpm add` and showed pnpm's terminal as the whole story: a typo, an installed package, a missing path, and a registry outage all ended in the same red exit code, the person read pnpm's output to learn which, and nothing could be stopped once started. Enabling was a checkbox to tick before knowing what would be installed, and a finished install left the new package somewhere in the list. Refusals such as a running session sat on the page until dismissed.

## Decision

**The Host reads a spec before installing it.** `PluginInstaller.inspect` sorts the spec — registry name, absolute path, git address, tarball — with `parseInstallSpec`, refuses what pnpm or the registry would refuse, and asks the registry through `pnpm view` or the directory through its `package.json` for the name, version, description, title, and bundle declaration. `pnpm view` runs in the profile directory so the registry and proxy settings match the install. `plugins/inspect-rejected` carries one of six problems; the client renders each as a sentence under the field and keeps the spec editable. The dialog refuses a name the list already shows without asking the Host.

**A failed run is classified where the facts are.** `classifyInstallFailure` reads how the run ended and what pnpm printed — its `ERR_PNPM_*` codes and Node's errno names — into a `kind` on `plugins/install-failed`. The client shows the kind as one line and folds pnpm's output behind the details. Parsing the log is confined to this one function with a fixture-driven test.

**Cancellation is the manager's, not the signal's.** A run is stopped through `plugins/cancelInstall` with the request id the dialog generated, and the dialog waits for the Host's answer before offering the spec again; [the manager note](2026-09-04-plugin-manager-over-the-profile-runtime.md) records why an aborted RPC is not a confirmation. Only the check takes a trailing `AbortSignal`: going back or closing drops a registry lookup, whose settlement nothing waits for.

**Enabling comes after the fact.** The finished screen offers **Enable now** for the bundles the run added; the dialog closes and the list scrolls to the first of them. Nothing is enabled before the person has seen what was installed.

**Refusals of the moment are toasts.** `plugins/busy` and `plugins/agents-running` return the dialog to the spec and toast; every other notice on the page is a toast too. The restart banner stays, because it describes state rather than an event.

## Alternatives considered

**Validate specs on the client.** Rejected: the rules are pnpm's, the registry's, and the profile's, and the client cannot import the Host package that owns them.

**Look the package up over HTTP instead of `pnpm view`.** Rejected: the registry, proxy, and auth settings that decide whether the install can succeed live in pnpm's configuration, which `pnpm view` reads and a direct fetch would have to reimplement.

**Stop the run by aborting the add RPC.** Rejected: a dropped RPC does not say whether pnpm stopped or the manifest is back, so the dialog would offer the spec again over a run still writing to the profile. The manager's `cancelInstall` answers only after cleanup, and the dialog waits for it.

## Consequences

`plugins/inspect` and `plugins/inspect-rejected` join the Remote; `plugins/install-failed` gains `kind`; the host config gains `inspectTimeoutMs`. The dialog is four screens over one subject card. The non-pack dependency group folds by default and names what it holds.

## Testing

`packages/boot/plugin-manager/tests/install-spec.spec.ts` pins the spec forms and the failure classifier's inputs; `plugin-manager.spec.ts` drives `inspect` against a fake `pnpm view` and a real directory and checks each kind; `packages/host/plugin-manager/tests` relays `inspect` with its signal. `packages/client/ui-plugin-manager/tests` cover the store's phases, Host-confirmed cancellation, post-install enabling, toasts, and the page's four screens; `apps/web/tests/plugin-manager.e2e.ts` refuses an installed name, a missing path, and a bad name through the real Host, and `plugin-install-cancel.e2e.ts` stops a real child from the dialog and gets the spec back.
