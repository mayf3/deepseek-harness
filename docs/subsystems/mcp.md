# MCP

English | [中文](mcp.zh.md)

## Summary

Model Context Protocol (MCP) connects the model to tools supplied by external servers. Each configured server contributes ordinary harness tools with cancellation, permission checks, recorded results, and supported image output. The official SDK negotiates modern or supported legacy protocol revisions. This reference covers the MCP package group's responsibilities, scope, and composition choices; the [client README](../../packages/mcp/mcp-client/README.md) owns server configuration.

## Table of Contents

- [Configuration](#configuration)
- [Responsibilities and scope](#responsibilities-and-scope)
- [Protocol and results](#protocol-and-results)
- [Limits](#limits)
- [Further reading](#further-reading)

-----

<a id="configuration"></a>
## Configuration

MCP is opt-in. Mount one `@deepseek-ai/dsh-mcp-client` entry for each server in the intended Cordis scope. The composition supplies the [tool registry](tools.md); the MCP client owns its connection and discovered tools.

| Choice | Configuration owner |
|---|---|
| Server identity, local process or HTTP endpoint, credentials, and process environment | [Client configuration](../../packages/mcp/mcp-client/README.md#use-this-package) |
| Tool-call timeout, startup failure policy, and reconnection | [Client configuration](../../packages/mcp/mcp-client/README.md#use-this-package) |
| Permission decisions and supported image output | [Tool execution](tools.md) and [attachments](attachment.md) |

Protocol negotiation follows the SDK's supported revisions; there is no product setting that forces a protocol revision. The [configuration catalog](../config-catalog.md#deepseek-aidsh-mcp-client) lists accepted client fields and defaults.

-----

<a id="responsibilities-and-scope"></a>
## Responsibilities and scope

The client is a per-server connection plugin and a consumer of the harness tool registry. It does not publish a shared `ctx.mcp` service. The external server implements MCP operations; the SDK owns protocol exchange; the client adapts discovered tools to harness execution.

Configured `serverName` identifies a server in its registration scope. Two entries in that scope cannot reserve the same name; separate Agent scopes can reuse it. Public tool names include the configured server name, so equally named tools from different servers remain distinct. Registration effects own names and discovered tools; plugin disposal closes the connection and removes its contributions.

The [native Cua Driver provider](../../packages/experimental/computer-use-cua-driver-native/README.md) shares the client's exported result adapter without opening an MCP connection. Desktop provider selection belongs to the [computer-use subsystem](computer-use.md).

-----

<a id="protocol-and-results"></a>
## Protocol and results

Both stdio and Streamable HTTP use the official SDK's negotiation, discovery, protocol validation, and cancellation. Tool-list changes trigger discovery through legacy notifications or a modern subscription. A failed refresh retains the previous tool generation; connection recovery follows the [client lifecycle](../../packages/mcp/mcp-client/README.md#use-this-package).

The result adapter retains canonical MCP JSON for programmatic callers and prepares ordinary tool content. Supported images use the attachment system; unsupported rich content produces explicit text diagnostics. The tool registry remains authoritative for policy failures and replaced results. The [tool contracts](tools.md) own recording and final presentation; the [client result reference](../../packages/mcp/mcp-client/README.md#use-this-package) owns MCP-specific projection details.

-----

<a id="limits"></a>
## Limits

This composition exposes server tools. It does not expose MCP resources, server instructions, prompt templates, human-input elicitation, or task-based execution. Servers without a tools capability connect with an empty tool set. Connection and discovery timeouts follow the SDK; the client has no separate settings for them.

-----

<a id="further-reading"></a>
## Further reading

- [MCP package group](../../packages/mcp/README.md) — package entry points.
- [Third-party memory servers](../user/guide/mcp-memory.md) — product configuration guide.
- [Protocol negotiation decision](../../.agents/notes/implemented/feature/2026-09-12-mcp-sdk-protocol-negotiation.md) — SDK ownership and compatibility decisions.
