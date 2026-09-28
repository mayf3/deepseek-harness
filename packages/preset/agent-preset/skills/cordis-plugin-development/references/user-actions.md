# User actions and agent tools

The agent must be able to perform the same operations as the plugin UI. Confirm the Host entry points and tools you use with `cordis_inspect_query` before relying on them.

## One operation, two callers

1. Implement the operation once as a Host service method. It returns the result or an explicit status, and a failure carries its reason.
2. The UI action calls it through a Client-callable Host entry point found with inspection, such as a session command that `ctx.remote.commands.execute()` runs, and shows the returned failure.
3. Register one agent tool per action. The tool takes the same parameters, has the same meaning, calls the same method, and returns its result as the tool result.

An action that grants or confirms authority, such as approving a tool call, answering a question the agent asked, or loosening a policy, stays user-only. Every other user action has its tool. Do not maintain separate operation logic in the UI and tool paths.

UI actions do not automatically inject results into agent context or wake the agent. Tool calls report through their tool results.

## Verification

For actions available to both callers, perform the action through the tool alone and compare its state changes, return values, and failures with the UI action. Verify that UI operations do not automatically inject operation reports or wake the agent. For user-only actions, verify that the agent cannot execute or authorize them.
