# @deepseek-ai/dsh-win32-process

English | [中文](README.zh.md)

Low-level Win32 process library consumed by the Windows ACL sandbox. It owns the repository's one Koffi binding table for reusable restricted-process, stdio, and Job Object operations; it is not a Cordis service and does not choose sandbox policy or public child behavior.

## Behavior

- **One reusable ABI owner** — `abi.ts` owns the Win32 constants and x64 layout values consumed by the sandbox process paths. `ffi.ts` lazily loads `kernel32.dll` and `advapi32.dll`, verifies `STARTUPINFOW`, `STARTUPINFOEXW`, and `PROCESS_INFORMATION`, exposes typed operations and error formatting, and lets sandbox policy bind its remaining APIs through the same loaded libraries.
- **Restricted-token creation** — `RestrictedProcessSpawnOptions` requires the sandbox's primary token and uses `CreateProcessAsUserW`. Piped and inherited-stdio paths share command-line quoting, cwd, the inherited environment block, checked return values, and handle cleanup.
- **Piped process primitive** — `spawnPipedProcess()` creates anonymous stdin/stdout/stderr pipes, closes stdin immediately, returns the two read ends, and leaves process waiting and pipe draining to the caller. Every partial failure closes the handles already owned by the operation, and every Koffi out-parameter or struct allocation is freed after its Win32 lifetime.
- **Inherited-stdio Job primitive** — `spawnInheritedJobProcess()` creates one kill-on-close Job, temporarily marks the current stdio handles inheritable, and attaches that Job through `STARTUPINFOEXW` while creating the restricted child. The child is Job-owned before any user code can run; attribute setup or creation failure closes every owned resource, and no successful process creation can leave an unowned child.
- **Explicit settlement ownership** — `waitForProcessExit()` waits and closes the process handle; `drainPipe()` reuses one fixed native out-parameter set while draining and frees it before closing the pipe read handle; `closeHandleChecked()` closes a caller-owned Job or other handle and reports a labelled Win32 error. The sandbox decides when these operations compose into public child settlement and disposal.

The Windows ACL sandbox adds SID, DACL, grant, workspace, and public child policy above these primitives.

## Model Experience

### Process primitives

#### What the model sees

Nothing directly. The package exposes `Win32ProcessBindings` and process primitives to the sandbox, which owns all model-visible tools, output, and diagnostics; this package contributes no prompt text or tool schema.

#### Token effect

None directly. Consumers decide whether process output enters a tool result or later model request.

#### KV Cache effect

The package contributes no stable request prefix, so it does not invalidate model KV caches.

## Known Limitations and Deferred Work

- **Windows-only native loading** — importing the generic types is portable, but resolving the binding table loads Windows DLLs and fails on other hosts. Cross-platform tests inject a binding table instead of loading native APIs.
- **No public process service** — the package intentionally does not wrap its primitives in Cordis or Node streams. A consumer must own its policy, async scheduling, output limits, cancellation, and final handle closure.
- **Inherited environment only** — process creation passes a null environment block. Callers that need environment changes must establish them before invoking the primitive or use their own runner process.
- **Restricted-token consumer only** — ordinary `CreateProcessW`, exact `applicationName`, parent-stdio release, and whole-Job settlement are absent until an ordinary process consumer requires them.
- **Header evidence is architecture-specific** — the committed ABI probe and layout constants cover the repository's current 64-bit Windows targets. A new pointer width or incompatible Windows ABI requires updating the probe before support is claimed.
