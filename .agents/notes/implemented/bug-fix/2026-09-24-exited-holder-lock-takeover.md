# Agent Note: Taking over a writer lock whose holder exited

Status: implemented

English | [中文](2026-09-24-exited-holder-lock-takeover.zh.md)

## Problem

`withFileLock` in [dsh-atomic-write](../../../../packages/util/atomic-write/README.md) creates `<file>.lock` with exclusive create and removes it in a `finally`. A process that ends without running that `finally` leaves the lock behind, and every later writer of the file times out until someone deletes it by hand. The [original decision](../../archived/architecture/2026-07-30-settings-write-path-integrity.md) accepted this because file age cannot distinguish a crashed holder from a paused one.

The profile package lock (`<profile>/package.json.lock`) made the cost visible. `dsh plugin` installs no signal handler, so Ctrl-C, SIGTERM, or closing its terminal ends the process while pnpm runs, and the lock stays. `dsh` and `dsh web` exit right after application disposal resolves, while a cancelled installation is still restoring files and has not released the lock. A crash, SIGKILL, or out-of-memory kill has the same effect. After any of these, every plugin operation on that profile fails after `lockWaitMs` (two minutes by default) without saying that the holder is gone.

## Decision

- The lock keeps the `<pid>\n` record earlier releases wrote, so locks left before this change are taken over and processes of both releases interoperate.
- A contender that finds a lock reads its record. When a signal probe of the PID fails with `ESRCH`, the holder is proven gone and the lock is taken over. `EPERM` means the process exists under another user and the lock is kept.
- Contenders that read the same record serialize on a claim file, `<file>.lock.takeover-<first 16 hex digits of the record's SHA-256>`, created with `wx`. The claimant re-reads the lock, removes it only if it still holds that record, removes the claim, and retries acquisition at once. The record can change only through another takeover, which needs the same claim, or through a new holder that reused the exited PID between the claimant's two reads; the latter requires the PID space to wrap within that moment, so a claimant does not remove a lock that another contender acquired after the exited holder's.
- A record that is empty, incomplete, not a decimal PID, or names PID 0 is waited for. None of these proves that the holder stopped.
- The probe runs on the contender's host. Writers on several hosts sharing one `DSH_HOME` over a network filesystem are unsupported; the `flock` that guards Session files does not reliably exclude them either.

## Alternatives considered

**Remove a lock older than a fixed age.** Age cannot separate a crashed holder from one running a ten-minute pnpm installation, and the plugin manager legitimately holds the lock that long.

**Kernel-released locks.** The kernel releases them when the holder dies, which removes the problem instead of detecting it. The [Session write lease](../../../../packages/session/session-persistence-jsonl/src/lease.ts) already holds one on both platforms: `flock` through `@deepseek-ai/node-addon-system` on POSIX and a named semaphore through `koffi` on Windows. Moving `withFileLock` onto it would give the zero-dependency `dsh-atomic-write` both dependencies, and processes of earlier releases still exclude each other only through `<file>.lock`, so a transition would have to hold both locks. This stays the stronger fix if PID reuse or shared-filesystem deployments turn out to matter.

**Rename the stale lock aside and restore it when the renamed record differs.** Restoring can race a third contender that acquires the empty path in between, which leaves two holders. The claim file prevents that race without restoring anything.

**Record the hostname and a nonce.** A hostname would keep a writer on another host from probing a PID that is not its own, but no supported deployment shares these files across hosts, and macOS changes its hostname when networks change, which would leave locks from before the change in place. A nonce would make each record unique, but the only race it closes needs the PID space to wrap between two reads.

**Signal handlers in `dsh plugin` only.** This covers one of the paths that leave a lock and leaves crashes, forced exits, and the other lock files behind.

## Testing

| Evidence | Behaviour |
|---|---|
| [atomic-write.spec.ts](../../../../packages/util/atomic-write/tests/atomic-write.spec.ts) | Takeover of an exited holder's record; eight contenders over one exited holder never overlap; live, other-user, empty, incomplete, non-PID, process-group, and out-of-range records are waited for; an unreadable lock, a claim held by another contender, and a record replaced after the claim are left in place; a Windows claim refusal is retried, another claim failure surfaces, and a claim that cannot be removed does not fail the operation. |

## Consequences

- Locks left by an exited process, including those written before this change, no longer need an operator; the next writer proceeds without waiting for its deadline.
- A PID that a live process reused after a reboot keeps the lock in place until an operator removes it, as before.
- Processes that share the lock file but not a PID namespace, such as containers over one volume or hosts over a network filesystem, can see a live holder as exited. Such deployments are not supported.
- A contender that crashes while it holds a claim leaves that claim, and the named lock is then not taken over automatically.
- A holder that is still alive keeps its lock, so this does not bound how long a live operation holds it.
