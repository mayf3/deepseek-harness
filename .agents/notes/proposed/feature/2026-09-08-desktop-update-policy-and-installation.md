# Agent Note: Desktop update policy and installation

Status: proposed

English | [中文](2026-09-08-desktop-update-policy-and-installation.zh.md)

## Problem

Desktop usually runs a local dsh server, so remote business errors cannot reliably deliver mandatory-update policy. Users need automatic discovery, user-initiated downloads, visible preparation state, and separate restart approval that accounts for running tasks.

## Proposal

This is the review entry for the initial Desktop update design, not a statement that the feature or backend integration has shipped. The documents below contain the complete proposal; review and implementation do not require local planning folders, mobile repository checkouts, screenshots in temporary folders, backup patches, or machine-specific configuration.

| Document | Owns |
|---|---|
| This proposal | Initial scope, regular and mandatory interaction, versioning, publication, implementation order, verification |
| [Mandatory-update API](2026-09-08-desktop-mandatory-update-api.md) | Request and response fields, server policy requirements, backend integration checklist |
| [Deferred extensions](2026-09-08-desktop-update-extensions.md) | Independent Desktop revisions, channel switching, automatic installation, replacement of pending updates |

### Initial scope

The [mandatory client decision](../../implemented/feature/2026-09-11-desktop-mandatory-update-client.md) and [local verification record](../../../../apps/desktop/tests/README.md) describe implemented client behavior and its evidence. Release qualification, backend integration, and unresolved product choices keep this proposal active.

Regular updates follow check → offer update → user starts download → verification and preparation → separate installation approval → installation and restart → confirmation that the new version started. Every initial download, including retries and mandatory-update downloads, requires user action; checks never authorize predownloads. Mandatory updates use remote policy checks and a blocking dialog. The intended integration reuses the regular updater after real-package qualification, while retaining the configured official download page as a fallback. Before qualification, the page path remains usable without claiming in-app installation works.

All initial clients use fixed Nightly because Desktop follows the dsh CLI release line, whose initial versions are prereleases. There is no channel selector, automatic-installation setting, installation on ordinary quit or next launch, or required stop-download button. No Desktop release has been distributed, so existing npm dsh releases do not require a Desktop channel bridge. Independent npm installations are outside this update flow; additional pre-upgrade plugin compatibility checks and post-update What's New are not initial requirements. Existing profile validation and startup recovery remain active.

### Version and publication rules

Desktop, the bundled dsh, and the private Host keep the single release version required by [release packaging](../../../../apps/desktop/src/release.ts). Compare complete SemVer values and install only higher versions; never sort lexically or discard prerelease identifiers. Independent `.dsk.N` revisions are deferred, not an exception to the initial equality rule.

| dsh | Desktop | Channel |
|---|---|---|
| `0.1.3-alpha.2` | `0.1.3-alpha.2` | `nightly` |
| `0.1.3-rc.2` | `0.1.3-rc.2` | `nightly` |
| `0.1.3` | `0.1.3` | `nightly` |

Configure `detectUpdateChannel = false` and publish `nightly.yml` on Windows and `nightly-mac.yml` on macOS explicitly. Nightly carries alpha, rc, and subsequent stable releases. Once shared stable versions are published, also publish `latest.yml` / `latest-mac.yml` with the same signed stable artifacts. Creating that stable feed does not switch existing Nightly clients or introduce a selector. Runtime selection must keep `allowDowngrade = false` after selecting the channel; a missing Nightly feed must not silently select another channel.

Use the generic provider with a configured HTTPS update source. Windows uses a signed NSIS package; macOS uses signed and notarized ZIP update payloads, with DMG retained for manual distribution. Channel YAML points to the latest version and carries file URLs, SHA-512, sizes, and update information; it is not a chain of mandatory intermediate versions. The mandatory-policy page URL is never an updater feed.

For each platform, validate the shared version and target, build and sign the artifacts, generate metadata, upload immutable versioned packages and blockmaps, verify remote availability and hashes, and only then publish the mutable channel YAML. Use no-cache or short-cache policy for YAML. Do not publish credentials, certificate paths, token PINs, or developer-specific bucket settings in design documents.

### Regular checks

| Trigger | Rule |
|---|---|
| Startup | Check asynchronously after basic initialization; do not delay opening the app |
| Foreground or system resume | Best effort; check only when the configured interval has elapsed |
| Continuous operation | Initially every 10 minutes, configurable; the final default remains pending |
| Top application menu | Check immediately, joining an existing check rather than issuing another |
| Network recovery | No trigger |

One main-process coordinator owns updater checks and downloads across all windows. At most one updater check is in flight. Manual requests bypass the interval but not in-flight deduplication, and retain manual feedback when joining an automatic request. An active download must not be started again or retargeted by another trigger. Mandatory-policy requests have a separate schedule and in-flight request; the updater interval does not set backend policy frequency.

Automatic checks with no update or a check failure remain silent and leave the app usable. A manual check displays a checking dialog, then no-update feedback with the actual installed version, a failure dialog with retry, or the update flow. No known result must not be presented as already up to date.

### Download, preparation, and UI

On discovery of an applicable newer version, offer a download action without fetching its package. Keep `autoDownload = false` and `autoInstallOnAppQuit = false`. Only an explicit download or retry action authorizes the coordinator to call `downloadUpdate()` for the selected target. Startup, periodic checks, manual checks, restored state, and mandatory-policy responses do not authorize new downloads. These are implementation requirements, not a claim that the current coordinator already implements the proposed flow.

Use `download-progress` for real progress and wait for `update-downloaded` plus any required platform preparation before offering installation. Download reaching 100% is not readiness or installation progress. Show phase text rather than a download percentage during verification or preparation. The main process sends state to the UI through restricted IPC; the renderer does not choose arbitrary download URLs or execute installation commands.

| State or action | Required presentation; approved Chinese copy |
|---|---|
| Manual checking | Dialog: “正在检查更新” |
| Manual check finds no update | Dialog: “当前暂无可用更新”; “当前版本：Vx.x.x” uses the real installed version |
| Manual check fails | Failure dialog with retry and persistent lower-left error indicator; final wording pending |
| Available, not downloaded | Lower-left “检查到新版本” entry starts downloading on click, without another confirmation; a manual-check result offers “下载更新” |
| Downloading | Lower-left account row, spinner and real percentage such as “58%...” |
| Verification or preparation | “正在校验更新文件”; no fabricated percentage or premature “安装中” |
| Ready | Download completion automatically opens “安装并重启” confirmation; deferring retains a blue lower-left entry that reopens confirmation |
| Download, preparation, or observable installation failure | Persistent red icon/dot and “重试更新”; hover or keyboard focus shows the failure and recovery tip; do not display ready |
| Installation approved | Lock target and show applicable preparation state; no promise of in-app progress after exit |

The menu and lower-left states are sufficient for the initial flow; do not add a settings-page check entry. Backend connection feedback has priority in the shared account-row status position; its recovery interaction remains owned by the connection UI. Preserve update state and cache while hidden. Do not label updater failures as backend connection errors. A collapsed sidebar shows the update dot on its top expand button, red on failure. Dialogs use the centered white card, rounded corners, black primary action, and dimmed, blurred background from [Figma](https://www.figma.com/design/jRBBK7zBgcszdVWQ0Fh5J8/Harness?node-id=2351-18426). Release-note placement remains a design follow-up.

Errors must remain discoverable in the lower-left entry, not only in a transient toast. Tips distinguish network/timeout, insufficient disk space, hash/signature rejection, and observable preparation or installation errors; retry is user-initiated and never bypasses validation. Automatic check failures remain silent; manual check failures retain their requested dialog feedback. A mandatory dialog takes priority over ordinary feedback; retain its block and show error/retry feedback inside it as well, since the sidebar is inaccessible. Do not stack an ordinary error dialog. Installer handoff or a failed new-version launch may prevent the old UI from reporting anything; no automatic recovery or rollback is promised. Route client-owned copy through locale dictionaries; server content is plain text.

### Installation and task safety

Download approval is separate from installation approval. The first download click starts transfer and preparation; readiness automatically opens restart confirmation, so installation still requires a second click. Deferring retains readiness without repeatedly opening the dialog; the update entry lets users reopen it. A complete reusable cache still requires confirmation. Inspect unfinished tasks before presenting the confirmation and recheck at handoff. With no affected tasks, the user confirms “安装并重启”; with affected tasks, use the following confirmed Chinese copy. English wording remains subject to localization review.

| Element | Chinese copy |
|---|---|
| Title | 仍有进行中的任务 |
| Body | 重启更新可能中断这些任务，是否要继续更新。 |
| Defer | 稍后更新 |
| Confirm | 停止任务并更新 |

Task protection uses live local-server state, not transcript wording. The [Session Controller types](../../../../packages/api/session-controller/src/types.ts) expose session `running` and background-job status, and [session-list construction](../../../../packages/api/session-controller/src/list.ts) derives `running` from the agent lifecycle. Include live running sessions, their in-flight approval/question waits, and affected running or stopping managed jobs. The [question tool](../../../../packages/interaction/tool-ask-user/src/index.ts) awaits an answer before returning; this differs from a completed turn merely inviting the next user message. If the API reports no active work or pending interaction, do not infer an unfinished task from such prose. Missing or failed state reads are unknown, not completed; report the failure and defer installation. Implementation must verify coverage across all local sessions and managed resources rather than relying only on the selected session.

Do not stop tasks before confirmation. Deferring keeps tasks and valid download cache. At installation handoff, lock the target, reject new managed tasks, and recheck affected resources so tasks started during confirmation are not silently terminated. Save necessary state and stop application-owned dsh processes and other affected managed resources. Stop or save failures abort handoff and return a recoverable error; approval is not permission to proceed after failed cleanup.

After successful preparation, the intended call is `quitAndInstall(true, true)` for silent Windows installation followed by relaunch; macOS replacement and restart require separate platform qualification. Calling the API is not evidence of successful installation. After restart, verify the actual new Desktop version and complete runtime-bound profile reconciliation and Host startup before showing the product UI. The shell loading window may appear immediately. Use the existing in-place profile and recovery flow; do not reinstall a core seed, introduce a second health-check Host, or add automatic profile rollback. Download completion, ordinary quit, process termination, and a later app launch do not independently authorize installation.

### Cache and target ownership

Reuse a complete cached artifact only after validating its identity, metadata, and integrity; persisted UI state is insufficient. Incomplete transfers may restart after a new user download action, with no promise of resumable downloads. A complete package may still need extraction or native preparation after app restart; preparation does not authorize installation or a replacement download.

Pending product confirmation, the proposed conservative rule retains A while A downloads or is ready, even if a check finds C. Never silently turn confirmation to install A into installation of C. A mandatory response does not independently select or invalidate the updater target. Automatic target replacement is deferred. Handle defective releases by publishing a higher fixed version and updating the feed, not an artifact revocation list or a pre-install revocation interception. Publishing a newer version does not guarantee that an already downloaded or staged older package cannot install; hash and signature checks still apply.

### Mandatory policy and blocking

The [API proposal](2026-09-08-desktop-mandatory-update-api.md) owns all wire fields. Query it independently of local dsh requests at startup, on configurable periodic ticks, on manual checks, and best effort on foreground or resume after the minimum interval. Coalesce matching requests, apply configurable jitter and failure backoff, and bind responses to the requesting app identity, version, platform, architecture, and channel. Old responses cannot overwrite a changed context. Do not query on network recovery or suppress queries because a dialog was already shown. Continue querying while blocked to receive the current mandatory decision and content; this query is not an artifact revocation check.

A valid mandatory response immediately blocks subsequent Desktop operations without stopping existing tasks or the dsh process. Users cannot bypass the dialog with cancellation, Esc, or its backdrop, but may exit the app. This is a Desktop UI restriction, not a claim to prevent independent CLI clients from accessing the local server.

The dialog renders the server title and detail as plain text, with locale-owned defaults when absent. Product previews use ordinary copy; literal HTML-tag inputs belong in dedicated safety tests. The approved normal flow uses one persistent modal without a close control, raw URL, or permanent refresh, browser, copy, and quit button grid. Application exit remains available through the operating system or application menu. The following presentation and background-attention decisions are implemented by the client; the implemented client decision and verification record distinguish local evidence from outstanding installed-platform acceptance.

| Mandatory normal state | Content and action; approved Chinese copy |
|---|---|
| Checking for an artifact | “正在检查可用更新…”; loading state without duplicate submission |
| Available | Target version and “下载更新”; this click authorizes the download |
| Downloading | Real progress such as “正在下载更新，58%”; no stop-download requirement |
| Verifying update files, including preparation | “正在校验更新文件…”; no separate preparation stage, fabricated percentage, or installation action |
| Ready, no affected tasks | “更新已准备就绪，安装后将重新启动应用。” and “安装并重启” |
| Ready, affected tasks | The approved task-impact warning, “停止任务并更新”, and secondary “稍后更新” |
| Installation approved | “正在准备重启”; show “正在安全结束应用中的任务。” only while stopping affected tasks, otherwise “应用即将重启，请稍候。”; no duplicate submission while preparing handoff |

File verification and required package preparation share one user-visible stage. Both must finish before the dialog offers installation; combining their presentation does not remove either operation. Task-stopping feedback follows actual affected tasks, not pending read-only requests.

Readiness changes the existing mandatory modal into installation confirmation; it does not replace the modal or add an identical confirmation after the install click. Task inspection must finish before that click can authorize installation. Unknown task state is not idle. The usual flow has one download click and one installation click; new tasks discovered at handoff still require renewed approval. Deferral retains the modal, existing tasks, and valid cache without repeatedly presenting task confirmation. The user can request confirmation again from the retained ready state. Keyboard focus must not move onto an installation button automatically, and a held key or the click that started downloading cannot confirm a later installation state.

### Background installation attention

Approved scope: mandatory updating when readiness requires a second user decision while neither the product window nor its mandatory modal is focused. Update the same modal without restoring a minimized window, switching applications or desktops, or stealing focus. Windows requests attention on the parent taskbar window using [flashFrame](https://www.electronjs.org/docs/latest/api/browser-window#winflashframeflag); macOS requests a short [informational Dock bounce](https://www.electronjs.org/docs/latest/api/dock#dockbouncetype), not a continuous critical bounce. Returning to the confirmation clears the outstanding attention request.

Also attempt one silent system notification per readiness episode. Suggested copy is “更新已准备就绪” / “返回应用确认安装并重启。”, with no task contents. A notification click only returns to the current modal; it never downloads, stops tasks, or installs. Recheck current state on click so an old notification cannot confirm an obsolete target. Repeated state publication, polling, task-count changes, foreground/background switches, and deferral do not send another notification for the same readiness episode. Policy clearance, installation, and disposal clear owned reminders. Errors and renewed reminder scheduling are not part of this approved readiness trigger.

[Electron notification platform requirements](https://www.electronjs.org/docs/latest/tutorial/notifications#platform-considerations) require installed Windows application identity/shortcut configuration and signed macOS notification qualification. Notification permissions, system focus modes, and OS preferences can suppress visible reminders; requesting attention is not proof that a user saw it. Notifications must not become a prerequisite for upgrading or trigger repeated permission prompts. Keep the ready modal available when the user returns. Verify this behavior on installed Windows and macOS applications, including minimized/hidden windows, denied notifications, system focus modes, and stale notification clicks; API documentation is not platform acceptance evidence.

### Mandatory failure recovery and browser fallback

The failure layout keeps a localized reason and stage-specific retry inside the same blocking modal, with sanitized technical details collapsed by default. Artifact-check failure or no applicable release offers another check; transfer or preparation failure offers explicit download/preparation retry; unknown task state or failed task shutdown requires a fresh task inspection and installation confirmation. A background policy-refresh failure must not discard an applicable active download or valid ready package. Neither retry nor external navigation authorizes installation or clears mandatory policy. Installer handoff can prevent the old application from reporting later failures.

Before in-app qualification, retain the page-only fallback. In the integrated design, show “前往官网下载” when the updater is unavailable, times out, has no applicable release, or cannot complete download/preparation; do not keep it beside the normal ready action. The main process validates the configured HTTPS destination against allowed download origins before either opening or copying it. Missing or disallowed links cannot be opened or copied. The page is never a command or an updater feed; opening it does not clear the block.

Browser-recovery interaction: immediately after the user requests the website, offer “若页面未打开，可复制下载链接”, “复制下载链接”, and “重新打开”, regardless of whether the OS reports an error. Keep the raw URL hidden unless copying fails. The [Electron shell implementation](https://raw.githubusercontent.com/electron/electron/main/shell/common/api/electron_api_shell.cc) resolves or rejects from the platform open callback; it does not observe the external browser's page loading. Handle an explicit rejection with “无法打开浏览器，请复制下载链接后手动打开。”; a resolved request must not produce “页面已打开”. Do not infer success from app blur, browser process presence, or a separate HTTP probe. Navigation outcome stays separate from updater errors, and copy success only changes its own feedback. Verification must include a resolved open request whose page never loads, a rejected request, a pending request with usable copy recovery, and failed copying.

Copy-failure recovery: show “复制失败，请手动选择下方地址复制。” followed by the complete validated download URL in a read-only, keyboard-selectable field. Wrap long addresses without ellipsis. Keep copy retry available; successful copying hides the manual-copy field. Revealing the address neither confirms browser navigation nor releases the mandatory-update block.

Without a known mandatory policy, background policy-check failure leaves business operations available; manual failure is visible. With a known policy, request failure, malformed data, browser navigation, download completion, and installer invocation do not clear the block. Only a fresh successful no-force response for the current client conditions clears it; after upgrading, query using the actual new version. Persisting this block across same-version offline restarts remains a proposed behavior awaiting product confirmation.

When the regular updater is qualified for in-app mandatory updating, show the blocking dialog before asynchronous updater checking and bound the check so a stalled request reaches browser fallback. `40005` determines that upgrading is mandatory; updater metadata determines the actual version and artifact under the shared version, cache, and target rules. Do not add a separate client-side mandatory-version check or artifact revocation check. Reuse suitable user-initiated in-flight downloads or verified complete cache; otherwise offer “下载更新” and wait for a click. Expose installation only after verification and separate restart approval, preserving task-impact confirmation. Timeout, no available update, or download/preparation failure retains the blocking dialog, error/retry feedback, and official-page fallback. Release owners publish a resolving updater release before enabling the corresponding mandatory requirement.

### Diagnostics and implementation order

Record trigger, channel, current and candidate versions, failure phase, and policy result without tokens or signing credentials. Candidate analytics names are `update_window_show` and `update_window_update`; a state refresh or polling response must not count as another dialog display. There is no mandatory-dialog cancel event.

Implement in order: (1) the independently configured policy client and response tests; (2) the blocking page-link dialog and task-preserving behavior; (3) regular check/download/install separation, menu and sidebar UI, and task-impact confirmation; (4) real package qualification on every release target, then reuse the qualified updater in the mandatory dialog while retaining the page fallback. Backend origins, page allowlists, and signing secrets remain deployment inputs, never copied from a developer machine. Fixtures permit client development before backend integration, not claims of successful live integration.

The [packaging decision](../../implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.md) retains signing, release identity, and publication integrity. The [bundled-runtime decision](../../implemented/architecture/2026-09-08-desktop-bundled-runtime-and-external-plugins.md), [in-place profile decision](../../implemented/architecture/2026-09-09-desktop-in-place-profile.md), and [immediate-window decision](../../implemented/architecture/2026-09-09-desktop-immediate-window-and-direct-start.md) own resource layout, profile reconciliation, and startup recovery. This proposal changes update interaction and policy delivery without replacing those mechanisms. Deferred release and automatic-installation choices remain in the [extension proposal](2026-09-08-desktop-update-extensions.md).

## Alternatives considered

**Automatic package predownload.** This consumes bandwidth before the user requests a download. Automatic discovery remains useful, but every initial transfer and retry requires user action independently of later installation approval.

**Automatic restart or installation on ordinary quit.** This bypasses explicit task-impact approval. Automatic installation requires separate product authorization and platform verification.

**One remote API controlling all updates.** Mandatory policy and ordinary artifact discovery have different responsibilities. Keep the policy page separate from updater metadata and reuse only the installation coordinator when qualified.

## Acceptance criteria

- Isolated fixtures with controlled clocks prove startup, interval, manual, foreground/resume, no network-recovery trigger, request merging, download reuse, and cleanup without late publications.
- Owner-local UI expectations cover the menu, not-downloaded entry, separate download and restart actions, verification text, lower-left progress/readiness and persistent red error/retry tips, approved Chinese copy, locale routing, silent automatic checks, and visible manual failures.
- Startup, periodic and manual checks, policy responses, failures, and app restarts never start a package transfer without a user download/retry action. Mandatory failures retain blocking. Invalid hashes or signatures prevent installation; no independent artifact-revocation check is required.
- Blocking a policy preserves existing tasks. Installation only stops affected tasks after approval; include approval/question waits and background jobs, completed turns without active work, unknown task state, new-task races, save/stop failures, and target changes.
- Complete-cache validation and repeated triggers do not duplicate download. No initial install is authorized by quit, restart, or download completion alone.
- Release tests prove shared versions, fixed Nightly metadata, full SemVer ordering, artifact-before-metadata publication, and rejection of wrong signatures or hashes.
- Real signed Windows x64 and macOS x64/arm64 packages demonstrate discovery, download, verification, process shutdown, install, restart, actual new-version Host startup, and runtime-bound profile reconciliation. A source-mode test is insufficient.
- Backend integration validates guest access, forced and no-force responses, errors, and the API proposal's platform matrix; fixtures do not substitute for this evidence.

## Risks

| Open item | Current review position |
|---|---|
| Updater frequency | Configurable 10-minute starting point; final default pending |
| Mandatory-policy frequency and origins | Backend integration inputs; independent from updater interval |
| Offline restart after a mandatory response | Persistence is proposed, not confirmed |
| Ready A followed by newer C | Retain A is a conservative proposal; automatic replacement is deferred |
| Collapsed sidebar, English copy, release notes, preparation visuals | Require product/design follow-up |
| Plugin compatibility | Additional pre-upgrade checks for minimum supported dsh versions are deferred; preserve existing peer validation and explicit startup recovery, without automatically disabling plugins to repair an installer failure |
| Restart-only experience | Requires real signed-package qualification; not established by this document |
