# @deepseek-ai/dsh-web-fetch-approval-policy

English | [中文](README.zh.md)

A `tools/pre-execute` policy for one-shot `web_fetch` permission decisions. It combines the calling session's sandbox mode with its approval policy and uses [`dsh-web-fetch-http`](../web-fetch-http/README.md) to reject non-public destinations before asking the user.

## Decisions

| Sandbox mode | Approval policy | `web_fetch` decision |
|---|---|---|
| `danger-full-access` | any | Delegate without asking. |
| `read-only` or `workspace-write` | `ask` | Resolve and require a public destination, then request one-shot approval. |
| `read-only` or `workspace-write` | `never` | Deny without DNS or a prompt. |

An agentless restricted call is denied because it has no session for policy lookup or approval audit. Malformed arguments delegate to the tool's own schema validation. This plugin never grants a call itself: unrestricted calls delegate to later policies, and restricted calls preserve any downstream `ask` or `deny` result.

The approval request carries the exact tool `callId` and a reason containing the complete normalized URL, sandbox mode, and single-call scope. Only the existing `allowed-once` outcome permits execution; rejection, cancellation, or an unavailable answerer fails closed. Session/domain persistence and permanent grants are outside this package.

## SSRF separation

Permission preflight parses the URL and resolves its complete address set before displaying a prompt. A non-public destination is always rejected and cannot be authorized through `allowed-once`.

Preflight is not a network authorization token. The HTTP provider resolves the hostname again immediately before each connection, rejects any non-public answer, pins the validated addresses, and repeats the check for every followed same-origin redirect. Cross-origin redirects require a new `web_fetch` call and a new permission decision.

## Model Experience

Indirectly, through `dsh-tools` and `dsh-user-approval`, which pause restricted calls for one-shot approval and return denial through the existing tool-error path.

#### KV Cache effect

None. The policy changes execution, not model-visible schemas or prompt text.

## Known Limitations and Deferred Work

- There is no session- or domain-scoped persistent grant.
- `plan` is collaboration state, not a sandbox mode. Products that want plan work to use restricted web access compose it with `read-only` or `workspace-write` and approval policy `ask`.
