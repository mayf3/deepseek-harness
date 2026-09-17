# Agent Note: Account provider and active request cancellation

Status: implemented

English | [中文](2026-09-17-account-provider-signout.zh.md)

## Problem

Selecting credentials from login state changes the billing identity of an existing provider route. Sign-out also needs to stop account-dependent work without classifying requests from settings that may have changed while a request or tool is still running.

## Decision

`deepseek-official` and `deepseek-account` are independent routes sharing the DeepSeek protocol implementation and validated connection settings. Each adapter has exactly one credential resolver and authentication header mode. Neither route falls back to the other credential. The account service retains the origin and issuer validation defined by the [login decision](2026-09-14-deepseek-account-login.md).

The Agent running phase owns `activeProvider`, the final provider returned by request preparation. The value remains through tools and retry preparation, changes when the next request binds, and clears before `turn/end`. It is undefined during a turn’s first preparation. A missing account credential still rejects the first request before transport. Token resolution checks local sign-out in progress; no login-level signal, credential lease, or synchronization protocol covers the short token-read/send interval.

Successful local sign-out publishes an account event. The DeepSeek plugin enumerates the live Agent registry and cancels matching account routes through `Agent.cancel`, preserving inboxes. Each registered child is classified independently; existing parent-owned cancellation still applies to children whose lifetime is attached to a cancelled parent. Independent API-key agents continue. The existing HTTP signal carries cancellation to the transport.

## Alternatives considered

A historical set of providers wrongly cancels a turn after it switches to an API-key route. Current settings misclassify an older in-flight request. A module-global map duplicates Agent lifecycle ownership, while making the account service manage every provider reverses the service dependency. A login-level cancellation signal duplicates the existing Agent and HTTP cancellation chain.

## Consequences

Model selection exposes both routes, and choosing an account route requires login even when an API key exists. The account route shares its model catalog and connection settings with the API-key route. Cancellation preserves queued input without waking it automatically. The recorded hook reason produces a localized conversation notice without changing durable event types.

Behavior tests cover credential separation, first preparation, tool-stage cancellation, and route replacement. The SDK account-provider-signout scenario boots the shipped profile and records interrupted output plus the cancellation cause.
