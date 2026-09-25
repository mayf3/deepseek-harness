---
name: diagnose-windows-sandbox-acl
description: 'Use on Windows when the DSH sandbox denies something it promised: cannot write or list in the workspace, or read a path the user should be able to read. Run the bundled script over the failing path and its ancestors; it only reads without a repair switch. It separates an AppContainer package-SID ACE, which it removes under an explicit root, from an unmet ownership or permission precondition, which it repairs with a full-control grant. Never change an owner or edit ACLs outside the script.'
---

# Diagnose Windows sandbox ACL failures

A denial is only worth diagnosing when it contradicts what the active mode promises. Establish that first: repairing a denial the sandbox is supposed to produce means weakening confinement for nothing.

## Step 0 — Decide whether this denial is unexpected

Enter the diagnosis only for these:

| Symptom | Why it contradicts the promise |
|---|---|
| Cannot write inside the workspace (root or any subdirectory) | `workspace-write` promises writes there |
| Cannot enumerate inside the workspace (`dir` prints nothing for a directory that has entries) | same |
| Anything the signed-in user should plainly be able to read cannot be read | reads are never confined in either restricted mode |
| Only the workspace **root** is denied while its subdirectories work normally | points at one object, not at the whole tree |

Strong but not required corroboration: `Test-Path` returns true while reads fail; `dir` reports an empty directory that is not empty; `cmd` cannot read a file that .NET reads fine.

Stop and explain instead of repairing for these — they are the confinement working as documented:

| Symptom | Why it is expected | What to do instead |
|---|---|---|
| Writing or deleting **outside** the workspace under `workspace-write` | the fence is doing its job | escalate that one call, or write inside the workspace |
| Any write under `read-only` | the mode itself | escalate that one call, or switch mode |
| `spawn EPERM` when a confined command captures a grandchild's output through piped stdio | named-pipe opens are denied in both restricted modes (a Win32 default-SD property, not a permission mistake); anonymous pipes and inherited stdio still work | escalate that one call, or restructure the command to avoid piping |
| `Add-Type`, `[System.IO.*]::`, COM, or reflection failing with "only core types" | `read-only` pwsh runs in ConstrainedLanguage | not a permission problem; escalate or use `workspace-write` |

Then split "cannot write in the workspace" by shape, because the two shapes have different causes:

- **Uniformly denied** — the root and every subdirectory fail together: the sandbox could not provision its grant.
- **Only the root denied** — subdirectories are fine: one object carries something that blocks it.

## Step 1 — Diagnose read-only before changing anything

Run the bundled script over the failing path. It reads ACLs with .NET and native `icacls`, changes nothing, and prints machine-parseable lines:

```powershell
pwsh -File scripts/diagnose-windows-sandbox-acl.ps1 -Path <failing-path>
```

It reports every observed allow and deny ACE on the target and its ancestors, including SID, rights, inheritance and propagation flags, plus the native ACL listing, owner, effective `WRITE_DAC` and `WRITE_OWNER`, caller integrity and sandbox marker names. Well-known groups `S-1-15-2-1` and `S-1-15-2-2` are reported but are not individual package ACEs eligible for removal. Access checks open existing objects without changing contents; Windows accounts for group membership, deny ACEs and inheritance. An unreadable or unrecognized value is unknown, not absent.

Every `REPORT` line contains a JSON record with `kind`, `operation`, `path`, `status`, `reason` and `details`. Read observations and reasons alongside the verdict: a deny ACE's presence alone does not prove that it caused the failure. Decisions explain skips and refusals. Actions report `started` before execution and `completed` or `failed` afterward; completion means the operation ran, while a separate verification reports whether the intended result was observed. A final summary lists attempted operations, outcomes and available recovery commands, including after a caught exception. If execution ends before a completion or summary record, treat the result as unconfirmed.

The failing API names the family. DSH's fail-closed errors carry the API and the exact Win32 code, so read the error rather than guessing:

| Error | Meaning |
|---|---|
| `GetNamedSecurityInfoW` … (Win32 5) | the object could not be **read** — either it carries a package SID and the caller is below Medium, or the caller has no access to it at all |
| `SetNamedSecurityInfoW` … (Win32 5) | the object was read but not written — the caller lacks `WRITE_DAC`, `WRITE_OWNER`, or both |
| `grantWrite` succeeded, yet the confined child still cannot use the directory | the grant landed but the child cannot open the object |

The script needs a caller that can open the object. `read-only` pwsh cannot run it at all, because ConstrainedLanguage blocks the .NET calls it needs; under `workspace-write` the confined child cannot open an object carrying a package SID, so the diagnosis comes back `READABLE=False` for the very object that caused the problem. In both modes the diagnosis needs an unconfined caller, so escalate once and run the diagnosis together with any repair in that same call (Step 4) — rather than concluding that the path is unreadable or that the failure is something else.

## Step 2 — Read the verdict

For `UNREADABLE` or `INCOMPLETE`, report the failed observation and its error; do not treat missing evidence as missing permissions or proceed with a repair. `NOT_THIS_CLASS` only rules out the conditions the script inspected, not every cause of the original failure.

| Package SID present | Effective permissions | Verdict | Action |
|---|---|---|---|
| yes | the target has both rights and every affected object has `WRITE_DAC` | package ACE found | remove the ACE (Step 4), then verify the original failure |
| yes | either condition above is unmet | both problems at once | grant full control on the affected object first, then remove the ACE; if `WRITE_DAC` is missing, the user must run the grant from an elevated terminal |
| no | `WRITE_DAC` present, `WRITE_OWNER` missing | a provisioning precondition is unmet | grant full control (Step 4) |
| no | `WRITE_DAC` missing | this caller cannot repair the DACL | hand the user the single command to run from an elevated terminal (Step 4) |
| no | both rights present | not this class | say so and stop; report what was actually found |

## Step 3 — Explain, and apologize

Say what the finding is and what it will cost before doing anything.

Apologize on the harness's behalf, in the language the user is writing in, in one or two sentences, then move to the technical explanation. The gap being owned is ours: the harness neither notices the conflict when it provisions the grant nor gives any direction when the denial surfaces, so the user only sees a bare "Access is denied" and has to guess. Do not apologize before the cause is confirmed, do not repeat it, do not blame another tool in the apology (the cause belongs in the explanation), and do not let it replace the explanation.

Two things must reach the user either way:

- **Which shape this is** — one object carrying a foreign ACE, or a directory whose ownership/DACL does not satisfy DSH's documented precondition.
- **That removing a foreign ACE may be undone** — if whatever tool placed it runs again with this directory as its root, it will place it again. The repair is not a permanent fix.

## Step 4 — Repair, or hand over steps

Two repairs exist, and both run through the same script so that no ACL is edited by hand.

**Remove a conflicting package-SID ACE.** This also removes that package's access, so explain which SID and permissions will be removed:

```powershell
pwsh -File scripts/diagnose-windows-sandbox-acl.ps1 -Path <path> -AllowRoot <containing-root> -Out <dir> -Fix
```

**Grant the current user full control when the precondition is unmet:**

```powershell
pwsh -File scripts/diagnose-windows-sandbox-acl.ps1 -Path <path> -AllowRoot <containing-root> -Out <dir> -GrantFullControl
```

Full control carries both rights this needs: `WRITE_DAC` for the DACL and `WRITE_OWNER` for the mandatory label DSH writes in the same call. **Taking ownership alone does not work** — it yields only `WRITE_DAC`, so the label write still fails. Never change an object's owner, and never "replace permissions on all child objects": that erases deny ACEs somebody set deliberately.

Both modes require `-AllowRoot` to be a containing directory and reject the target or any ancestor if it is a reparse point, including a junction used as `-AllowRoot`. Before mutation they save the native `icacls` listing format, a DACL recovery record, a standalone recovery script and its exact command under `-Out`. The recovery command uses `-Restore` to restore only the original DACL and inheritance protection; it never changes ownership or the mandatory label and remains usable after the session ends. It requires `WRITE_DAC` and enforces the same path restrictions. Run multiple rollback commands in reverse repair order.

After a grant, the script rechecks effective `WRITE_DAC` and `WRITE_OWNER`; after removal it checks that package ACEs disappeared and other `icacls` lines stayed unchanged. Refused or failed repairs exit nonzero. A failed verification does not undo a completed DACL write. Report which operation ran, its reason, what verification observed and the recovery command; the script never rolls back automatically. If the requested repair failed after a write, use its emitted recovery command before trying another repair, and report the recovery result. Both repairs write a DACL, which the confined child cannot do, so run the diagnosis and the repair inside one escalated call rather than spending two approvals on the same directory.

The caller needs effective `WRITE_DAC` to repair the DACL. Ownership often supplies it, but an explicit grant or group grant can also supply it to a non-owner. Follow the script's access result rather than inferring permissions from the owner's name. If the caller lacks `WRITE_DAC`, ask the user to run the exact grant command from an elevated terminal. Elevation does not override every deny or system policy; verify the result.

Do not reach for `sandbox_permissions` to solve a Windows-token permission failure. Escalation gives the script an unconfined caller (Step 1); it does not elevate the Windows token. If the unconfined caller still lacks `WRITE_DAC`, another sandbox escalation cannot supply it.

Do not make the harness trigger UAC either. An agent-initiated `runas` is a privilege-escalation path, the elevated child would run outside both the sandbox and the approval ledger the session log is built from, and a UAC prompt cannot be routed through this harness's approval channel. Hand the user the single exact command to run from an elevated terminal, and say plainly what it changes.

Never recommend running the whole agent elevated instead: that is a downgrade, and the community habit of "just run it as administrator" trades the isolation away for a working prompt.

Also stop short when the directory cannot be repaired this way at all, and say which applies: the owner is a system principal such as `TrustedInstaller`, the path is one the user has no business owning, or the volume is not ACL-capable. Moving the workspace is then the honest answer.

## Step 5 — Verify against the original failure

Re-run the operation that failed, from the same confined context. The repair is only done when that operation succeeds. Whether diagnosis, repair or verification succeeds or fails, tell the user what the script observed, what it changed or left untouched, why it took those actions, and what remains unverified. Keep observations separate from suspected causes. If the original operation still fails, report the new error verbatim rather than starting another round of changes.

## Step 6 — Report recurrence

Tell the user the condition that brings it back, so they can recognize it instead of re-diagnosing it.

## Never

- Never write, create, or delete a file to *test* permissions. Writing to probe is how an existing file gets clobbered, and it answers nothing the read-only diagnosis does not. (This has already happened once in this repository: a probe overwrote a workspace-root `AGENTS.md` that no version control could restore.)
- Never edit ACLs by hand — use the bundled repairs or their generated recovery command. The recovery script writes only the saved DACL; do not replace it with a security-descriptor write that also attempts to change the SACL.
- Never repair anything outside the directory being diagnosed, and never widen `-AllowRoot` beyond the tree that legitimately contains the failing path — its purpose is to keep a repair from reaching a neighbour of the thing that failed.
