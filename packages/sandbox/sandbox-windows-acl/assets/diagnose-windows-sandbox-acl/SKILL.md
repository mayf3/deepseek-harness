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

It reports, for the target and every ancestor: any AppContainer package SID (`S-1-15-2-*`) as explicit or inherited, other `S-1-15-*` SIDs (reported but inert), the owner, whether the current user holds `WRITE_DAC` and `WRITE_OWNER`, whether the ACL could be read at all, and the caller's integrity level plus any sandbox markers in the environment.

The failing API names the family. DSH's fail-closed errors carry the API and the exact Win32 code, so read the error rather than guessing:

| Error | Meaning |
|---|---|
| `GetNamedSecurityInfoW` … (Win32 5) | the object could not be **read** — either it carries a package SID and the caller is below Medium, or the caller has no access to it at all |
| `SetNamedSecurityInfoW` … (Win32 5) | the object was read but not written — the caller lacks `WRITE_DAC`, `WRITE_OWNER`, or both |
| `grantWrite` succeeded, yet the confined child still cannot use the directory | the grant landed but the child cannot open the object |

The script needs a caller that can open the object. `read-only` pwsh cannot run it at all, because ConstrainedLanguage blocks the .NET calls it needs; under `workspace-write` the confined child cannot open an object carrying a package SID, so the diagnosis comes back `READABLE=False` for the very object that caused the problem. In both modes the diagnosis needs an unconfined caller, so escalate once and run the diagnosis together with any repair in that same call (Step 4) — rather than concluding that the path is unreadable or that the failure is something else.

## Step 2 — Read the verdict

| Package SID present | Owner is the current user | Verdict | Action |
|---|---|---|---|
| yes | yes | a foreign AppContainer ACE is the blocker | remove the ACE (Step 4) |
| yes | no | both problems at once | grant full control first, then remove the ACE; the grant needs Windows elevation |
| no | yes, and the DACL lacks `WRITE_OWNER` | a precondition DSH documents is unmet | grant full control (Step 4); ownership already carries `WRITE_DAC`, so no elevation is needed |
| no | no | a precondition this caller cannot repair | hand the user the single command to run from an elevated terminal (Step 4) |
| no | yes and the DACL is complete | not this class | say so and stop; report what was actually found |

## Step 3 — Explain, and apologize

Say what the finding is and what it will cost before doing anything.

Apologize on the harness's behalf, in the language the user is writing in, in one or two sentences, then move to the technical explanation. The gap being owned is ours: the harness neither notices the conflict when it provisions the grant nor gives any direction when the denial surfaces, so the user only sees a bare "Access is denied" and has to guess. Do not apologize before the cause is confirmed, do not repeat it, do not blame another tool in the apology (the cause belongs in the explanation), and do not let it replace the explanation.

Two things must reach the user either way:

- **Which shape this is** — one object carrying a foreign ACE, or a directory whose ownership/DACL does not satisfy DSH's documented precondition.
- **That removing a foreign ACE may be undone** — if whatever tool placed it runs again with this directory as its root, it will place it again. The repair is not a permanent fix.

## Step 4 — Repair, or hand over steps

Two repairs exist, and both run through the same script so that no ACL is edited by hand.

**Remove a foreign package-SID ACE.** It grants nothing to anyone yet blocks every reader below Medium:

```powershell
pwsh -File scripts/diagnose-windows-sandbox-acl.ps1 -Path <path> -AllowRoot <containing-root> -Out <dir> -Fix
```

**Grant the current user full control when the precondition is unmet:**

```powershell
pwsh -File scripts/diagnose-windows-sandbox-acl.ps1 -Path <path> -AllowRoot <containing-root> -Out <dir> -GrantFullControl
```

Full control carries both rights this needs: `WRITE_DAC` for the DACL and `WRITE_OWNER` for the mandatory label DSH writes in the same call. **Taking ownership alone does not work** — it yields only `WRITE_DAC`, so the label write still fails. Never change an object's owner, and never "replace permissions on all child objects": that erases deny ACEs somebody set deliberately.

Both modes require `-AllowRoot` and refuse any target outside it, are dry-run unless the repair switch is passed, write a native `icacls` backup plus a rollback command to `-Out`, and re-read the object to confirm both that the intended change landed and that every other ACE — the mandatory label included — survived unchanged. Both also write a DACL, which the confined child cannot do, so run the diagnosis and the repair inside one escalated call rather than spending two approvals on the same directory.

When the caller owns the directory, the missing piece is only `WRITE_OWNER`: ownership already carries `WRITE_DAC`, so the script repairs it unelevated. Windows elevation is needed only when the owner is somebody else, because an unelevated caller cannot write the DACL of a directory it does not own; the script reports that case as a failed grant together with the one command to run.

Do not reach for `sandbox_permissions` to solve that token problem. Escalation is the right lever for giving the script an unconfined caller (Step 1) and the wrong one for writing a DACL the caller has no right to write, because it widens the sandbox and not the Windows token. Even at `danger-full-access` the harness still runs unelevated with `Administrators` marked deny-only, so it has no `WRITE_DAC` on a directory owned by Administrators, and asking for the escalation only spends an approval on the wrong lever.

Do not make the harness trigger UAC either. An agent-initiated `runas` is a privilege-escalation path, the elevated child would run outside both the sandbox and the approval ledger the session log is built from, and a UAC prompt cannot be routed through this harness's approval channel. Hand the user the single exact command to run from an elevated terminal, and say plainly what it changes.

Never recommend running the whole agent elevated instead: that is a downgrade, and the community habit of "just run it as administrator" trades the isolation away for a working prompt.

Also stop short when the directory cannot be repaired this way at all, and say which applies: the owner is a system principal such as `TrustedInstaller`, the path is one the user has no business owning, or the volume is not ACL-capable. Moving the workspace is then the honest answer.

## Step 5 — Verify against the original failure

Re-run the operation that failed, from the same confined context. The repair is only done when that operation succeeds. If it still fails, report the new error verbatim rather than starting another round of changes.

## Step 6 — Report recurrence

Tell the user the condition that brings it back, so they can recognize it instead of re-diagnosing it.

## Never

- Never write, create, or delete a file to *test* permissions. Writing to probe is how an existing file gets clobbered, and it answers nothing the read-only diagnosis does not. (This has already happened once in this repository: a probe overwrote a workspace-root `AGENTS.md` that no version control could restore.)
- Never edit ACLs by hand — no `Set-Acl` from a constructed SDDL, no `icacls` surgery outside the bundled script. A hand-built security descriptor also marks the SACL for writing, which fails with a privilege error that looks like a bug.
- Never repair anything outside the directory being diagnosed, and never widen `-AllowRoot` beyond the tree that legitimately contains the failing path — its purpose is to keep a repair from reaching a neighbour of the thing that failed.
