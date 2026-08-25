# @deepseek-ai/dsh-client-ui-chat

English | [中文](README.zh.md)

The browser Chat target for Conversation assembly. It registers Chat event definitions and snapshot construction, supplies `useChat`, renders transcript nodes and details, and owns Chat-specific stores, actions, localization, and scroll restoration; historical image URLs resolve through the Conversation-owned per-session cache (`ctx.uiConversation.imageUrl`).

## Model Experience

None, as this package renders logged conversation state in the browser and registers nothing model-facing.

#### KV Cache effect

None; Chat presentation does not assemble or mutate provider requests.

## Known Limitations and Deferred Work

- **The view reflects the loaded Session window** — older transcript nodes become available only after Session Controller loads the preceding event page. Turn navigation likewise represents only loaded Turns; loading an earlier page preserves existing Turn marks and redistributes the complete loaded set in a compact rail without an unloaded-history placeholder. Marks stay 10px apart until the loaded set exceeds the available height, then compress to fit.
