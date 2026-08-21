# @deepseek-ai/dsh-session-log-deepseek

English | [中文](README.zh.md)

Incremental canonical session-log upload for official DeepSeek LLM API requests. This function plugin injects `ctx.sessions` and `ctx.deepseekLlmApiExtensions`, then owns the `dsh_session_log` request field and the durable `session-log-deepseek/accepted` watermark event.

## Configuration

| Key | Default | Meaning |
|---|---:|---|
| `enabled` | `false` | Register the `dsh_session_log` contribution. Set it to `true` to opt into Session-log upload. |

Shipped profiles mount the plugin so an overlay can enable it, but the default configuration registers no request field and appends no acceptance watermark.

## Request field

For a request carrying a live `sessionId`, the plugin folds the greatest accepted watermark for that exact Session identity, snapshots `Session.events`, and sends the contiguous suffix after the watermark. A process-local fold scans each event once and consumes later appends incrementally; restart and HMR rebuild it from the durable log. The version-1 field contains the immutable `SessionHeader`, `afterSeq`, `throughSeq`, and every complete event envelope in that range. Forked sessions ignore inherited parent watermarks because each watermark records the Session id sent on the accepted request.

Each event is sent raw unless request-relative packing reduces its JSON byte size. The codec traverses the exact serialized DeepSeek `messages`, and a packed string can replace an exact substring with `{ messageIndex, path, utf8Start, utf8End }`. References use half-open UTF-8 offsets into parsed string values; literal fragments retain everything outside the match. The encoder verifies each candidate's local UTF-8 round trip, so a surrogate-splitting or ill-formed UTF-16 match stays raw. The exported decoder rejects missing paths, non-string targets, invalid ranges, and ranges that split a UTF-8 code point. Raw fallback and byte-size comparison make every representation lossless and prevent reference overhead from expanding an event.

## Acceptance and retry

The DeepSeek adapter calls the prepared contribution's `accept()` after HTTP 2xx, before it consumes the SSE body. Acceptance appends `session-log-deepseek/accepted` with the uploaded `throughSeq`; the next request uploads that watermark as part of its new suffix. Transport and non-2xx failures append no watermark, so later requests resend the uncertain range. Concurrent accepted requests may append watermarks out of order; folding their maximum prevents cursor regression.

A crash after server acceptance but before the watermark reaches persistence can replay an accepted range after restart. This is the at-least-once failure direction: uncertainty creates duplicates, never a skipped sequence. The ordinary session checkpoint policy persists the watermark at the next semantic checkpoint; this plugin performs no independent I/O.

Direct requests without a live Session omit `dsh_session_log`. Normal agent, compaction, and session-title calls carry their live Session id.

## Model Experience

### Session-log metadata

#### What the model sees

Nothing. `dsh_session_log` is a sibling of the DeepSeek request's model-input fields and is not inserted into `messages`, the system prompt, or tool schemas.

#### Token effect

Zero model-input tokens; the field only increases HTTP request bytes.

#### KV Cache effect

None; the model-visible request prefix remains unchanged.

## Known Limitations and Deferred Work

- **Crash-window duplicates** — a 2xx followed by process loss before the acceptance watermark persists causes conservative replay on resume.
- **No live Session means no field** — direct or stale-session calls have no canonical log to snapshot; explicit absence semantics remain deferred.
- **No independent request-size cap** — complete delivery is fail-closed; provider rejection leaves the cursor unchanged instead of truncating the log.
