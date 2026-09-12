# Agent Note: MCP SDK protocol negotiation

Status: implemented

English | [中文](2026-09-12-mcp-sdk-protocol-negotiation.zh.md)

## Problem

MCP servers use different protocol revisions. A tool bridge that implements discovery and execution around an older SDK can omit modern request headers, subscription setup, or protocol validation.

## Decision

`dsh-mcp-client` uses the official TypeScript client 2.0.0 with automatic protocol negotiation. The SDK owns modern discovery and legacy initialization, transport-specific negotiation, list-change subscriptions, pagination, request headers, cancellation, and output validation. The bridge uses high-level `listTools` and `callTool`, passing the complete discovered definition to each call.

The bridge retains server-qualified names, atomic registration, and durable image admission. Servers without a tools capability publish no tools. Discovery failures preserve the last successful registration; duplicate names still reject the new generation. Malformed cursor chains follow SDK behavior, including stopping at a repeated cursor; the bridge does not add a parallel pagination implementation.

The shared result adapter passes the original `ToolExecution` to each provider callback, preserving its Agent identity and cancellation. Native Cua Driver results use the SDK's public spec-type validation before canonical projection; the adapter does not accept a separate permissive result format.

The [tool bridge note](2026-07-07-mcp-client-plugin.md) retains the independent naming, scope, and image decisions. This note changes its SDK realization without replacing those decisions.

## Alternatives considered

**Keep raw requests for compatibility.** This preserves permissive malformed-result handling but bypasses SDK-owned modern headers and schema validation. Protocol-valid outputs take priority over legacy `toolResult` substitutes.

**Implement modern protocol behavior in the bridge.** This duplicates maintained SDK behavior and creates an additional compatibility implementation.

## Consequences

Stdio negotiation may start a disposable probe process. The SDK bounds discovery with its page limit, and malformed results fail before projection. Valid text, canonical JSON, image admission, cancellation, and registration ownership remain bridge contracts. Elicitation, resources, prompts, and task execution remain unsupported.
