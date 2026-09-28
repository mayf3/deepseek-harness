# User actions and agent tools

A user action in plugin UI, such as a button, toggle, slider, or form submission, changes state that the agent works with. The agent must be able to perform the same action and must learn when the user performed it. Confirm the Host entry points and tools you use with `cordis_inspect_query` before relying on them.

## One operation, two callers

1. Implement the operation once in Host code the plugin provides. It returns the result or an explicit status, and a failure carries its reason.
2. The UI action calls it through a Client-callable Host entry point found with inspection, such as a session command that `ctx.remote.commands.execute()` runs, and shows the returned failure.
3. Register one agent tool per action. The tool takes the same parameters, has the same meaning, calls the same operation, and returns its result as the tool result.
4. When the user performed the action, the UI path reports the state change, return value, or failure to the agent with `agent.inject()`, as a user message whose source names the plugin and states that the user made the change. The tool path does not inject: its tool result already reports the change.

An action that grants or confirms authority, such as approving a tool call, answering a question the agent asked, or loosening a policy, stays user-only; the agent receives only its reported result. Every other user action has its tool. These designs leave the agent unaware of what the user did or unable to repeat it:

- The UI action changes only Client state.
- The UI path and the tool carry separate logic, so their results drift apart.
- The user performs the action and nothing reports it to the agent.

## Reporting results

- Report with `agent.inject()`; its timing and waking behavior are in `references/practices.md`. Call `agent.steer()` only when the running turn must react at its next step, and `agent.followup()` only when the result must start its own turn.
- Coalesce continuously fired actions, such as slider drags, per-keystroke input, and bulk toggles, into one injection, for example by enforcing a minimum interval since the last injection. One injection per event fills the agent's context with redundant messages.
- Resolve the agent when the action runs; it can be disposed after the view rendered. When the agent is gone or `agent.inject()` throws, return the failure to the UI instead of dropping it.

## Verification

- Acting as the agent, perform the action through the tool alone and compare the result with the UI action.
- After the user performs the action, wake the agent and check that its next admitted step contains the reported result.
- Trigger the action repeatedly, by dragging, clicking, or bulk changes, and check that the agent receives one coalesced injection and is not woken for each event.
