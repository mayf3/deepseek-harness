# Sign-in pre-commit checklist

English | [中文](sign-in-readiness.zh.md)

This checklist covers DSH login on the welcome branch, Platform authorization pages, and their integration. It records unfinished or insufficiently verified work as of 2026-09-15.

## Commit restriction

On 2026-09-16, the user explicitly requested committing and pushing the current branch as a progress checkpoint. This authorizes that checkpoint despite the pending acceptance items below; those items remain unchecked and release acceptance is not complete.

Before committing these changes, reread this checklist and confirm every item is complete with verifiable evidence. Do not commit while any item is unchecked. Deleting items, moving them to other TODOs, recording only “awaiting product confirmation,” or substituting mock tests for real integration does not clear the checklist. Removing a requirement requires an explicit user decision recorded before checking it off. This restriction also covers separate commits of this checklist and its accompanying documentation.

Keep completed items and their evidence; do not delete the checklist. Before committing, inspect related DSH and Platform TODOs again and add any newly discovered unfinished work here.

## Pending work and completion criteria

- [x] **Loopback address policy (DSH / Platform / backend)**: User confirmed on 2026-09-15 that the backend supports localhost. Preserve the hostname and browser-visible port without conversion to an IP. DSH, Platform, and mock validation now accept exact localhost and reject lookalike domains. Evidence on 2026-09-15: 40 DSH account tests and lint passed; 72 Platform tests, two type checks, and lint passed, including successful exchange with the original URI and rejection after conversion to an IP. The callback validator also accepts [::1] and requires an explicit port under the updated backend protocol; real IPv6 listener/forwarding acceptance remains pending.
- [ ] **Real authorization API integration (backend / both applications)**: Verify auth_init client_type binding, authorize business codes, exchange token/authorized_url, auth_cancel verifier validation and idempotency, and invalidation of canceled requests and unexchanged codes against the real backend. Verify exchange cannot override desktop/web origin type. Mock implementation is not evidence of backend completion.
- [ ] **Real DSH token usage and logout (backend / DSH)**: Verify current, balance, inference, and file endpoints with a real DSH token; account credentials must still accompany inference/file requests only at allowed api.deepseek.com destinations. Verify restart restoration, explicit Platform logout, local credential deletion, and remote revocation outcomes. Use a dedicated test account to avoid revoking a shared daily-use dev token.
- [ ] **Latest Web tab integration (both applications)**: At localhost:8081, verify new-tab authorization, automatic closure on success and exchange failure, original-tab failure feedback, and explicit retry. Cover timeout, cancellation, blocked automatic closure, manually copied links, and localhost access through SSH with different local/remote ports and IPv4/IPv6 listener configurations. Confirm no second Web UI opens and Web completion has no desktop button.
- [ ] **Native client and installer acceptance (DSH)**: With current artifacts, verify Host readiness before login, workspace loading after login, failure/timeout recovery, and window focus. Verify installed dsh://open registration, cold launch, and activation of an existing app on supported release platforms. Earlier manual checks do not replace acceptance of the latest changes.
- [ ] **Business-error product decisions (product / both applications)**: Business codes already exist; do not request them again. Confirm English/Chinese copy and terminal versus retryable behavior for each business failure, then implement pages and snapshots. Other codes and HTTP errors retain the default fallback. Resolve corresponding product-error-ui TODOs.
- [ ] **Platform production localization (Platform / product)**: Add temporary harnessCopy text to the official translation sheet, generate resources, and replace temporary lookup. Include cancellation, Web completion, and manual-close messages; confirm English absent from Figma and resolve corresponding i18n TODOs.
- [ ] **Browser cancellation feedback requirement (product)**: Decide whether showing CANCELED only when the user next attempts approval is acceptable after DSH cancellation. If immediate feedback is required, implement and verify notification or querying. Neither choice may allow local acceptance of late authorization results.
- [ ] **Login-help link decision (product / Platform)**: Confirm the original requirement. If needed, supply and connect its destination; otherwise remove related placeholders or TODOs. An unconfirmed link is not automatically a required feature.
- [ ] **Final review and checks (both applications)**: Inspect final differences across related tasks and both workspaces, excluding unrelated files and private credentials. Complete code review, relevant behavior tests/snapshots, type/lint/build and documentation checks, record actual results, and resolve all blockers. Completing this item does not waive any item above.
- [ ] **Development launcher early exit (DSH)**: Investigate start:desktop exiting successfully during primary-runtime preparation without launching Electron. Restore and verify the supported launcher; direct use of already prepared runtime artifacts is only a preview workaround.

- [ ] **Embedded usage and top-up (DSH / Platform)**: Account buttons, the native 48px return bar, and Platform embedded layout from Figma node 2554:28786 are implemented. Verify the real Electron/Platform initialization, return navigation, reload, failure, and sign-out paths. TemPad succeeded after narrowing to child nodes on 2026-09-16. Verify payment navigation before enabling top-up; the native view blocks cross-origin document navigation and opens HTTPS popup links in the system browser without credentials. The usage filter resolves tracking IDs from get_api_keys entries with key_type=DSH; verify charts, details and exports share that restriction and never fall back to all keys. The private IPC and synchronous getter after preload initialization have focused tests, not end-to-end acceptance.

- [ ] **Shared device identity for embedded Platform (DSH / Platform / backend)**: Reuse the device ID persisted by DSH Host for authorization exchange, DSH requests and embedded Platform requests. Pass deviceId/deviceModel with the token in the existing Electron preload initialization snapshot and expose a synchronous window.dsh.getDeviceInfo() getter. Embedded Platform reads this information through its deviceProvider; ordinary browsers retain their localStorage UUID. The backend confirms auth_exchange registers the device; initial sign-in needs no additional auth_token/check_device registration. Verify consistent x-device-id/x-device-model headers and no second browser device ID for the embedded page.

## Implemented baseline

Account details and balance, sidebar logout, private Platform URL configuration, shared Host callback port, PKCE, authoritative local cancellation, auth_cancel, Electron timeout, Web login dialogs, and signed-out Settings are implemented. Closing the new tab on Web failure and distinguishing desktop/web origins are also implemented. The pending items above cover final integration and release acceptance, not duplicate development requirements.

## Acceptance evidence

When completing an item, append the date, implementation location, and test commands/results or explicit product decision to that item. The address-policy item includes completion evidence; other items remain pending.

2026-09-16: macOS development `Harness Dev.app` was registered and verified through the real Platform completion-page button in Chrome. Both opening an already running window and cold-starting after quitting succeeded, preserving the account display. This does not replace installed release-platform acceptance.

- [ ] **Completion-page context (backend / both applications)**: The supplied backend auth_init schema does not store client_type (desktop/web) or locale. Confirm how authorized_url selects desktop open-app versus Web close-tab behavior and language. DSH continues sending both fields until a replacement is agreed; sending them alone does not prove backend support.
