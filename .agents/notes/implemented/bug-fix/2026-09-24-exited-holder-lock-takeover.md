# Agent Note: Taking over a writer lock whose holder exited

Status: implemented

English | [中文](2026-09-24-exited-holder-lock-takeover.zh.md)

## Problem

`withFileLock` in [dsh-atomic-write](../../../../packages/util/atomic-write/README.md) creates `<file>.lock` with exclusive create and removes it in a `finally`. A process that ends without running that `finally` leaves the lock behind, and every later writer of the file times out until someone deletes it by hand. The [original decision](../../archived/architecture/2026-07-30-settings-write-path-integrity.md) accepted this because file age cannot distinguish a crashed holder from a paused one.

The profile package lock (`<profile>/package.json.lock`) made the cost visible. `dsh plugin` installs no signal handler, so Ctrl-C, SIGTERM, or closing its terminal ends the process while pnpm runs, and the lock stays. `dsh` and `dsh web` exit right after application disposal resolves, while a cancelled installation is still restoring files and has not released the lock. A crash, SIGKILL, or out-of-memory kill has the same effect. After any of these, every plugin operation on that profile fails after `lockWaitMs` (two minutes by default) without saying that the holder is gone.

## Decision

- The lock records `{ pid, hostname, nonce }`. The nonce makes each record unique, so a later lock never repeats an exited holder's record.
- A contender that finds a lock reads its record. When the record names this host and a signal probe of the PID fails with `ESRCH`, the holder is proven gone and the lock is taken over. `EPERM` means the process exists under another user and the lock is kept.
- Contenders that read the same record serialize on a claim file, `<file>.lock.takeover-<first 16 hex digits of the record's SHA-256>`, created with `wx`. The claimant re-reads the lock, removes it only if it still holds that record, removes the claim, and retries acquisition at once. The record can change only through another takeover, which needs the same claim, so a claimant never removes a lock that another contender acquired after the exited holder's.
- A record that is empty, unparsable, lacks a hostname, names another host, or names a PID of zero or less is waited for. None of these proves that the holder stopped.
- A PID-only record written by an earlier release is treated as written on this host, so locks left before this change are also taken over.

## Alternatives considered

**Remove a lock older than a fixed age.** Age cannot separate a crashed holder from one running a ten-minute pnpm installation, and the plugin manager legitimately holds the lock that long.

**Kernel-released locks (`flock`, `LockFileEx`).** The kernel releases them when the holder dies, which removes the problem instead of detecting it. The native `flock` entry exists only for POSIX, a Windows binding does not exist, and every `withFileLock` caller would depend on a native addon. This stays the stronger fix if PID reuse or foreign-host records turn out to matter.

**Rename the stale lock aside and restore it when the renamed record differs.** Restoring can race a third contender that acquires the empty path in between, which leaves two holders. The claim file prevents that race without restoring anything.

**Signal handlers in `dsh plugin` only.** This covers one of the paths that leave a lock and leaves crashes, forced exits, and the other lock files behind.

## Testing

| Evidence | Behaviour |
|---|---|
| [atomic-write.spec.ts](../../../../packages/util/atomic-write/tests/atomic-write.spec.ts) | Takeover of an exited holder's current and PID-only records; eight contenders over one exited holder never overlap; live, other-user, other-host, empty, unparsable, hostname-less, and process-group records are waited for; an unreadable lock, a claim held by another contender, and a record replaced after the claim are left in place; a Windows claim refusal is retried, another claim failure surfaces, and a claim that cannot be removed does not fail the operation. |

## Consequences

- Locks left by an exited process on the same host no longer need an operator; the next writer proceeds without waiting for its deadline.
- A PID that a live process reused after a reboot keeps the lock in place until an operator removes it, as before.
- A hostname change between the holder's exit and the next writer, which macOS does when networks change, keeps the lock in place.
- Processes that share a hostname but not a PID namespace, such as containers started with the host's UTS namespace over one volume, can see a live holder as exited. Such deployments are not supported.
- A contender that crashes while it holds a claim leaves that claim, and the named lock is then not taken over automatically.
- A holder that is still alive keeps its lock, so this does not bound how long a live operation holds it.
