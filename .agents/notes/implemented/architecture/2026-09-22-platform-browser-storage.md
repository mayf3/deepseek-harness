# Agent Note: Account-scoped Platform browser storage

Status: implemented

English | [中文](2026-09-22-platform-browser-storage.zh.md)

## Problem

Embedded Platform notices store dismissal in localStorage. Disposable browser partitions lose that preference whenever the view closes.

## Decision

Desktop partitions browser storage by a SHA-256 hash of the Platform origin and stable account ID. Persistent partitions retain page preferences across view and application lifetimes, including sign-out and later sign-in to the same account. Raw account IDs and tokens do not appear in partition names. Without an account ID, the view uses disposable storage.

Closing a view destroys its document and detaches credential-bearing request interceptors. It flushes DOM storage and clears cookies, HTTP authentication, and connections. Reopening waits for cleanup; a cleanup failure prevents opening another document. Host-only credentials still enter the trusted page through the existing preload and are not written to browser storage by the bridge.

## Alternatives considered

One shared partition mixes account preferences. Token-derived names discard preferences when credentials change. A notice-specific native API would duplicate Platform preference ownership and require coordinated frontend changes.

## Consequences

Preferences remain local to this Desktop browser-data directory and are not synchronized across devices. Platform scripts remain trusted to handle the credential they receive; persistent site storage is not a credential vault. The account profile lookup may delay the first prepared Platform session. The real Electron regression checks notice dismissal across view recreation, account switches, and process restart.
