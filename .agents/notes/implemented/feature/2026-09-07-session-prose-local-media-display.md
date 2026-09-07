# Agent Note: Session prose local media paths display through a same-origin file route

Status: implemented

English | [中文](2026-09-07-session-prose-local-media-display.zh.md)

## Problem

Assistant prose sometimes references an image by its local filesystem path (markdown `![](/Users/.../x.png)`). The Web renderer only allowed absolute HTTP(S) image destinations, so such references fell back to inert alt text: the browser cannot read Host files, and nothing served them. Searches of the formal and external issue trackers found no existing record, and issue #3662 logged the gap (Web cannot display local-path images referenced by agent answers).

## Decision

Local media paths in session prose render through one same-origin file route, with the rewrite vocabulary and the serving policy each owned where the repo's seams say they belong.

- **Renderer seam (`ui-primitives`)**: `MarkdownText` gained a `MarkdownPathImages` vocabulary (`pathImages` prop) with the same settled-only gate as `fileMentions`: while a message streams, frozen cached blocks never bake in a vocabulary handler; the settled pass rewrites image destinations that fail the remote-URL allowlist, and a rewritten destination is emitted only when it is an absolute `http(s)`/`blob`/`data` URL. Without a vocabulary the renderer output is byte-identical to before.
- **Chat wiring (`ui-chat`)**: `AssistantMarkdown` supplies a page-stable vocabulary (`localPathMediaUrl`, module-private in the same file) mapping absolute POSIX paths to same-origin `/api/file?path=…` GETs; non-HTTP transports (Electron `file://`) and relative/protocol-relative destinations stay inert. Windows-style host paths (`C:\...`) are deliberately inert on the client side and are recorded as a limitation in Consequences.
- **Host route (`session-controller`)**: `SessionMediaReferences`, a plugin contribution registered beside `SessionFileReferences`, mounts `GET|HEAD /api/file` on the shared authenticated `connection.fetch` channel (same trust fence and browser authentication as `/api` RPC). Per request it fail-closes: the path must be absolute, its `realpath` must lie inside a registered workspace root (path-component containment, including a filesystem-root workspace), the file must be regular, and its MIME type must belong to the served categories image/video/audio (resolved by the `mime-types` package, excluding `image/svg+xml`); media bytes are never sniffed on this route. Regular-file checks run before opening (a named pipe or device node is refused instead of blocking the open); reading binds to the opened file, and a stat-identity comparison with the pre-open stat narrows, but does not fully close, a concurrent replacement window. Responses stream with HTTP range support parsed by the `range-parser` package: single-range `bytes` requests answer 206, malformed/unknown-unit/multi-range headers are ignored for a full 200 body, HEAD never opens a file stream, and an aborted client destroys the stream. Responses carry `private, no-store` and `nosniff`. The contribution activates only where `connection` and `workspaceRegistry` are composed (pending-until-composed, like the package's other optional contributions).

The route is presentational and stateless: it never writes, follows no redirects, and returns 400/403/404/415/416 instead of approximating another file-serving behavior.

## Alternatives considered

- **Register on the Typert gateway**: the gateway owns Remote RPC dispatch (endpoint claims, WebSocket mux, forwarded events), not file serving; placing the route there put HTTP presentation of workspace files into the RPC transport layer. Rejected and fully reverted.
- **Register under `workspace-controller`**: that package owns workspace registry lifecycle (CRUD, ordering, feed), and shares only the registry as a policy data source. Rejected and fully reverted.
- **Fetch bytes over the session RPC and show blob/data URLs**: attachment images already do this, but markdown rewriting needs a deterministic synchronous URL at render time (streaming freeze caches, memoization); an async round trip cannot be the render seam. Rejected.
- **A per-image or image-only route**: media types share one path-and-contain policy; video/audio need range streaming anyway. One `/api/file` route with an extension allowlist covers all current and next media types. Rejected as narrower alternatives.
- **Byte-signature checks on image extensions**: rejected. The identical check already ships inside `fs/tool-fs`'s `read_image` tool, the repository's cross-file duplication gate forbids cloning it here, and no shared owner exists without widening the attachment package's public API for one helper. The extension allowlist already keeps non-media content out, and a corrupt image payload fails in the browser, not on the route.
- **Per-request interactive authorization, client-negotiated endpoints, or arbitrary host paths**: the rewrite is presentation; the route re-validates every request and limits readable bytes to registered workspace roots and allowlisted media, and the same-origin endpoint is a fixed channel contract rather than a negotiated capability. Rejected for security and determinism reasons.

## Consequences

- Assistant prose that references workspace-contained image files now displays them in Web chat; previously inert alt text disappears only where the host can serve the bytes.
- Policy is enforced host-side per request; the client vocabulary never expands what the route allows. Media typing trusts the MIME category allowlist; byte-signature validation stays with the `read_image` tool that owns it.
- Existence disclosure: an authenticated same-origin client can tell an existing-but-outside-workspace path (403) from a nonexistent one (404). Readable bytes stay confined to workspace roots, so the impact is limited to existence probing, and the distinct statuses are kept intentionally.
- Windows-host limitation: the client vocabulary rewrites only absolute POSIX paths, so a Windows-style `C:\...` destination stays inert alt text even though the route's own `isAbsolute` would accept it; serving such references is deferred.
- Scope is deliberately narrow: only files under registered workspace roots with allowlisted media types are served; anything else keeps the authored fallback. Trajectory and tool-card markdown consumers do not pass a vocabulary yet, and video/audio markdown nodes are not rendered as `<video>`/`<audio>` yet — the URL layer already supports them.
- The client hardcodes the `/api/file` endpoint as a same-origin channel contract; this is stable by construction because the page is served by the same host that mounts the route.
- Related history: the archived note [model-readable image paths](../../archived/feature/2026-08-21-model-readable-image-paths.md) decided the model-facing side of local image paths; this note owns the user-facing display side and does not supersede it.

## Testing

Unit coverage: the renderer seam (settled and streaming gates, reference-style images, protocol re-checks), the chat vocabulary and component wiring, and the host route policy exercised through the registered route (containment incl. symlinks and filesystem-root workspaces, MIME category allowlist, single/multi-range and 416 answers, HEAD without a stream, client-abort destruction, unregister-on-dispose). `media-references.ts` sits at 100% statements/branches/functions/lines. Local gates at this state: typecheck, oxlint, duplication, translation pairing, and the touched suites all pass. Deferred to the PR follow-up: keyless recorded-session replay for the end-to-end GUI path and the browser demo GIF the GUI PR evidence chain requires.
