# Agent Note: Trusted native tool policy

Status: implemented

English | [中文](2026-10-28-trusted-native-tool-policy.zh.md)

## Problem

`ToolRuntime.restrict()` filters inherited tools for a scope, then overlays that scope's own registrations outside the filter; the reserved `run_code` transport also sits outside the filterable tool layer. Those composition rules are useful for delegated child tools, but they cannot enforce an opt-in read-only policy for a whole trusted Agent process. A model-visible role instruction or declared capability list is not a dispatch control.

The paired Agent Core Spec `AGENT_CORE_TRUSTED_NATIVE_TOOL_POLICY_V1` defines the trusted startup field and binds it to an exact `agentId` and policy digest. This Note owns only the DSH-side receipt, projection, and dispatch behavior.

## Decision

When a trusted Agent Core initialization request carries the supported native-tool-policy version, DSH validates the exact `agentId`, policy digest, and allowlist before admitting any model request. It rejects an invalid or unsupported policy without falling back to unrestricted behavior. An initialization request without the field retains existing behavior. The SDK JSON-RPC server acknowledges the version, `agentId`, and digest; the TypeScript client requires that exact acknowledgement for opted-in requests.

For an opted-in Agent, DSH applies one exact positive allowlist to the model-visible native tool view and to every native dispatch. The final check runs before a tool handler and covers deployment-global registrations, ancestor registrations, scope-local registrations, direct `tools.execute()` calls, and Code Mode transport and nested calls. It denies an absent or mismatched Agent scope, an unlisted tool, an unlisted operation, `run_code` under the read-only policy, and every other request that cannot be matched exactly. Hiding a schema is not authorization.

The policy is bound to the DSH ToolRuntime for the lifetime of the process generation. Every Agent scope uses that process policy; no scope can widen it or exempt its own registrations. Final authorization runs on the effective resolved call, including scope-local overrides, and denies every selector absent from the trusted allowlist. Selector names must be registered when initialization validates the policy (the reserved `run_code` name is always recognized); a later scope-local override of a registered name remains subject to the same selector. The contract matches the exact tool name and, where applicable, exact operation; it does not claim to distinguish two trusted registrations that intentionally expose the same selector. Plugin code and registration composition remain within the cooperative trust domain.

Selectors are exact tool names, optionally paired with `argumentEquals`, which matches named top-level own-properties of call arguments using RFC 8785 canonical JSON value equality. Extra argument properties are permitted only when the registered tool contract declares those selector keys to fully determine the operation; otherwise the selector must match the complete argument object or be rejected. Selector keys must be reliable operation discriminators in the existing tool contract. Missing, ambiguous, malformed, or unsupported operation selectors fail closed. Policy validation rejects duplicate or overlapping selectors for the same tool name. Selectors do not accept wildcard names or inferred role labels. “Read-only” describes local file/process capabilities; it does not prohibit business Broker operations such as a workflow transition or assistance-open when the trusted policy explicitly selects that exact operation. Existing Broker gateway authorization still applies.

The ToolRuntime policy helper projects the allowlist into schemas and enforces it at the final native dispatch guard. Under an opted-in policy, dispatch identity and argument properties are immutable across the pre-execute waterfall, so a listener cannot rewrite a denied operation into an allowed one. The implementation does not add generic IAM, an OS sandbox, or a new permission-provider abstraction.

## Alternatives considered

**Use `tools.restrict()` by itself.** It cannot name the reserved `run_code` transport and intentionally leaves scope-local registrations visible, so it does not meet the dispatch requirement.

**Use prompts, tool descriptions, or `read-only` filesystem mode as the policy.** These affect model guidance or one filesystem backend; they do not stop direct dispatch, Code Mode, shell tools, or scoped registrations.

**Build a generic permission service or per-Agent process sandbox.** That is wider than a native tool-call allowlist and conflicts with the current cooperative shared-host trust model. Trusted plugin code and direct in-process service calls remain outside this proposal.

## Consequences

- DSH validates the supported version, exact policy digest, tool-name registration, selector shape, and selector overlap before model work; Core owns the resolver identity and process-reuse binding, while DSH echoes the accepted identity and digest for Core to verify.
- An opted-in policy permits only its exact configured native calls and refuses every unlisted call before the handler executes, regardless of whether it is global, inherited, or scope-local. A task policy may explicitly allow a required workflow transition/open operation while still denying unconfigured local write, edit, shell, and arbitrary-code tools.
- `write`, `edit`, `bash`, `run_code`, unlisted Broker operations, and newly registered tools are rejected unless an explicitly different trusted policy admits them; the read-only policy never admits them. Unknown selector names fail initialization.
- Direct dispatcher calls and Code Mode direct/nested entry paths cannot bypass the final check. A tool schema being absent is not the only assertion.
- Missing policy preserves legacy behavior. A separate trusted Owner configuration can admit an explicitly named repair tool; no display name, prompt, or model role triggers that configuration.
- Tests use real ToolRuntime dispatch with fake handler side-effect counters; no model, service, credential, or production run is required.

## Risks

This is enforcement for calls routed through DSH `ToolRuntime`. It does not sandbox trusted plugins, direct service access, native modules, arbitrary Node code, or operating-system processes. The configured tool set and installed plugin composition remain in the cooperative trust domain. `run_code` is denied unless explicitly listed; other policies must state their own exact allowlist rather than inheriting read-only behavior.

The current Code Mode `run_code` is a reserved presentation transport outside `ToolRestriction`; focused tests prove direct dispatch is denied before its program body starts when the policy omits it. The guard evaluates the effective resolved call after scope resolution. Tool registration remains trusted; this Note does not promise to isolate malicious plugins or distinguish intentionally same-named registrations.
