---
description: "Account consumers read stored login state, start or cancel a browser login, and sign out without editing API keys. Host model consumers resolve account credentials only for the provider-configured inference origin."
kind: "package-reference"
---

# @deepseek-ai/dsh-deepseek-account

English | [中文](README.zh.md)

getPlatformSession returns a Host-only origin/token snapshot for native Platform embedding, or null when signed out. It is absent from account-controller RPC and Client state. Consumers destroy documents holding a snapshot when the account changes.

`desktopClientHeaders` maps the native `darwin` and `win32` platforms to the shared Desktop account and update-policy request header; `null` adds no header.

`rejectToken` accepts a Host inference request’s rejected token and removes only the matching current login; a late rejection cannot clear a replacement credential.

`AccountView.signOutReason` identifies a server-expired credential separately from explicit sign-out; it is absent while signed in.

## Summary

Account consumers read stored login state, start or cancel a browser login, and sign out without editing API keys. Host model consumers resolve account credentials only for the provider-configured inference origin.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

`AccountProfile.avatarUrl` is an optional profile image URL; null or absence means no avatar.

Successful local sign-out emits `deepseek-account/signed-out`. The platform provider installs the account-owned cancellation listener, which checks running Agents against `session.requestContext().provider` and cancels account tasks while retaining inboxes. The account controller uses the same predicate for its confirmation dialog. No additional Agent state is maintained. Before a new turn binds its first request, this predicate still sees the previous turn’s provider.

The service defines account operations and reconnectable state snapshots. The platform provider owns the protocol and stored grant. Credentials are Host-only; the API controller exports state and commands without resolveToken.

Account model failures with `ACCOUNT_SIGN_IN_REQUIRED` emit `deepseek-account/model-sign-in-required`; the Client receives this live event for sign-in guidance. Other request errors do not emit it.

<a id="understand-the-implementation"></a>
## Understand the implementation

The service defines account operations without maintaining a second credential index; no invariant companion is published. The provider owns persistence and login lifecycle checks.

<a id="further-exploration"></a>
## Further Exploration

The [credentials subsystem](../../../docs/subsystems/credentials.md) owns storage APIs; the [architecture](../../../docs/architecture.md) explains application composition.

A ready AccountDetails.balance keeps recharge wallets in value and bonus wallets in bonusWallets; both arrays preserve decimal strings and currency. Query failure supplies neither amount.

<a id="model-experience"></a>
## Model Experience

None, as account credentials affect HTTP authentication and never enter model prompts, Session logs, or tool results.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Account tokens have no expiry or refresh flow. Sign-out removes the local grant before background provider revocation; remote logout failures never restore local login. Profile and balance query failures retain the stored grant. getProfile / getBalance reports profile and balance query outcomes independently.

<a id="dev-note"></a>
### Dev Note

The [desktop login decision](../../../.agents/notes/implemented/architecture/2026-09-14-deepseek-account-login.md) records cancellation and storage ownership.

PlatformSession may carry Host-only requestHeaders from Host to Electron main: deployment headers plus the provider's x-client-platform. Consumers must exclude those headers from renderer bootstrap and restrict them to the configured origin. mergePlatformCookies preserves unrelated cookie pairs while replacing matching names.
