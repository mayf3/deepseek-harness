---
description: "Right-Sidebar browser tabs for isolated HTTPS pages and opt-in loopback services."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-browser

English | [中文](README.zh.md)

## Summary

Browse HTTPS pages and opt-in loopback HTTP services inside independent right-Sidebar tabs. The current carrier is an iframe with application-managed history in both Web and Desktop. The package never injects Electron or Node access into visited content.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The shipped Web and Desktop compositions already mount this package. Open **Browser** from the right-Sidebar guide, then enter an HTTPS URL or a host name that should become HTTPS. Disable that tab's sandbox before opening a loopback HTTP URL. Each guide action creates another Browser tab.

### When to choose it

Choose Browser for a Web page that should remain beside the current Session. Choose [Document Preview](../ui-sidebar-documentpreview/README.md) for local files, and use the explicit external-browser action when a site refuses iframe embedding or needs browser capabilities this package withholds.

### Minimal configuration

The package has no configuration. A custom Web composition mounts its Host companion; the Client loader then discovers the browser entry declared by the package manifest:

```yaml
- id: ui-sidebar-browser
  name: '@deepseek-ai/dsh-client-ui-sidebar-browser'
```

Client plugins can open a tab through `ctx.sidebarRight.openTab('browser', { params: { url } })`. The optional URL passes the same validation as address-bar input before navigation.

The toolbar provides Back, Forward, Reload, Go, Open in system browser, and a rightmost per-tab sandbox toggle. Disabling the sandbox is temporary, displays a warning, and permits controller-directed loopback navigation. The external action accepts a known HTTPS or loopback HTTP target. The tab title is the Web host.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Protocol policy

The address parser accepts HTTPS and HTTP only for `localhost`, `[::1]`, and `127.0.0.0/8`. The controller permits those loopback targets only while the current tab's sandbox is disabled. It rejects public HTTP, `file:` URLs, script/data/blob input, embedded credentials, the DSH application origin, and malformed addresses. Document Preview owns local-file rendering.

### Iframe carrier

Web and Desktop use `sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"` by default, without download or top-navigation capability. Popups leave the sandbox. The visited origin can use its own cookies and Web storage but a cross-origin target cannot read DSH DOM, storage, or API responses. The iframe sends no referrer and adds no package-owned Permissions Policy, so browser defaults and user grants apply. The toolbar can remove the sandbox for the current tab occurrence; the choice is not persisted. An unsandboxed page that reaches the DSH origin can access that origin's Web data. The package does not proxy or probe remote pages.

Web records toolbar submissions and typed tab opens. A navigation state machine treats the first iframe load for each controlled revision as known and a later load as proof that the page changed to an unreadable URL. In that unknown state the address is marked, Back, Forward, and external-open are disabled, and Reload returns to the last controlled URL. A remounted body reloads the latest application-known URL and uses its optional initial URL only before the first controlled target. History API and fragment changes that emit no iframe load remain invisible.

### Controller

Each tab receives one `BrowserController` class. Its public commands are `loadUrl`, `goBack`, `goForward`, and `reload`; address validation and history mutation stay behind that object. Its `BrowserNavigation` class owns the serializable URL state machine. The `BrowserFrame` interface owns transient sandbox and document state plus carrier operations, and `IframeImpl` implements that interface for the current iframe carrier. Slot injection exposes keyed frame state through `useBrowserFrame` and supplies plain callbacks, so the React body receives neither the controller nor an observable source; it keeps only the editable draft and iframe DOM.

The controller interface does not depend on iframe APIs. A future `ElectronWebViewImpl` can implement `BrowserFrame` while owning `<webview>` attachment and target identity. That deferred carrier is documented in the same Sidebar Browser decision, but is not registered or tested today.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Right Sidebar](../../../docs/subsystems/sidebar-right.md) — tab composition, navigation, and lifecycle.
- [Document Preview](../ui-sidebar-documentpreview/README.md) — local source, Markdown, images, HTML, and PDF rendering.
- [Sidebar Browser decision](../../../.agents/notes/implemented/feature/2026-09-16-sidebar-browser.md) — current iframe behavior, controller ownership, and deferred Electron carrier.

-----

<a id="model-experience"></a>
## Model Experience

None, as Browser tabs are user-facing presentation state and register no tool, prompt section, or Session event.

#### KV Cache effect

None; browsing does not enter a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The isolation policy deliberately gives up some browser compatibility:

- Many sites refuse iframe embedding or need downloads or top-level navigation withheld by the default sandbox. Disabling the sandbox trades those restrictions for compatibility and permits controller-directed loopback navigation. It does not isolate the visited origin's cookies per Browser tab and cannot prevent an in-frame page from choosing its own next URL.
- A later iframe load reveals that navigation occurred but not the new cross-origin URL. History API and fragment changes may remain invisible; Web Back and Forward are unavailable after the state becomes unknown.
- Local files are rejected and remain owned by Document Preview.
- The proposed Electron `<webview>` carrier, per-tab cookie partitions, native history, and target-specific CDP connection are not implemented.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. `BrowserNavigation` is the sole URL-state writer; the store receives its immutable snapshots, and focused controller and component tests exercise publication and cleanup directly.
