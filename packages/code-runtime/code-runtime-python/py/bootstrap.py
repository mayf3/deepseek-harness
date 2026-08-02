"""CPython bootstrap for dsh-code-runtime-python.

Reads a :class:`BootMessage` on fd 3, applies resource limits and log capture,
reads a :class:`RunMessage`, runs the model program as the body of an async
function (top-level ``await`` and ``return`` both work; the returned value is
the completion), and posts a terminal :class:`DoneMessage`. The program calls
host functions through the ``tools`` (or other namespace) proxy, whose attribute
and subscript access return awaitables that ride binding messages over fd 3.

This module runs under ``python3 -I`` with an empty environment and
``sys.path`` containing only its own directory.
"""

from __future__ import annotations

import asyncio
import ast
import io
import json
import math
import os
import re
import resource
import signal
import sys
import threading
import traceback
from decimal import Decimal
from pathlib import Path
from typing import Any

# ``python3 -I`` (isolated) drops the script directory from ``sys.path`` so
# the sibling ``protocol.py`` is invisible by default. Restore it explicitly
# before importing.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from protocol import PROTOCOL_FD, log_truncation_marker  # noqa: E402

# Read size for the async fd-3 reader. One `os.read` returns whatever the pipe
# holds, so this only bounds a single syscall's copy, not a frame: a larger frame
# simply takes more reads. 64 KiB matches the usual pipe capacity.
_READ_CHUNK_BYTES = 65536

# Code-unit ceiling on the exception class name interpolated into the LAST-resort
# failure diagnostic. A metaclass `__name__` property can return any length, and
# that construction runs outside the guard that would otherwise absorb a
# MemoryError, so the name is sliced before it is copied. Generous enough that no
# real class name is touched.
_MAX_FALLBACK_NAME_CHARS = 200


# ---------------------------------------------------------------------------
# Log buffer — Python-side ledger for captured text.
# ---------------------------------------------------------------------------


class LogBuffer:
    """Ordered text capture under one shared byte budget.

    Once the budget is exhausted the buffer emits exactly one in-band
    truncation marker via ``sink`` and silently drops everything after. The
    cap is a blast-radius bound; "how much was lost" intentionally stays
    unmeasured.
    """

    def __init__(self, max_bytes: int, sink) -> None:
        self._max_bytes = max_bytes
        self._remaining = max_bytes
        self._truncated = False
        # Re-entrant so a caller may hold it across a compound read-modify-write
        # (``_LogStream.write`` reads ``remaining`` several times and then calls
        # ``push`` while still holding it). One lock is shared by this buffer and
        # every stream that funnels into it: model code may start daemon threads
        # that keep calling ``print`` after the program body returns, and the
        # settlement ``flush_line`` on the main coroutine reads and mutates the
        # same ``_pending``/ledger state. Without a shared lock the flush could
        # interleave with a concurrent ``write`` — dropping or double-counting a
        # line, or costing the ``done`` frame on a mangled ledger. Fixing which
        # callable runs (binding ``out_stream.flush_line``) does not fix what it
        # reads.
        self._lock = threading.RLock()
        # ``sink(text, truncated=False)``. The marker is emitted with
        # ``truncated=True`` so the host can stop its own capture at the same
        # point rather than treating the marker as ordinary program output: the
        # two ledgers exhaust independently, and one entry larger than
        # ``max_bytes`` sends only the marker while the host budget is still
        # nearly empty.
        self._sink = sink

    @property
    def lock(self) -> "threading.RLock":
        """The shared re-entrant lock guarding this ledger and its streams' buffers."""

        return self._lock

    @property
    def remaining(self) -> int:
        """Serialized bytes still admissible; zero once truncated (streams use this to bound their own buffering, where a character count is a valid lower bound)."""

        return 0 if self._truncated else self._remaining

    def push(self, text: str) -> None:
        with self._lock:
            self._push_locked(text)

    def _push_locked(self, text: str) -> None:
        if self._truncated:
            return
        # Cheap lower bound FIRST: one char is at least one UTF-8 byte and the
        # JSON form adds two quotes plus the separator, so a single print() far
        # above the budget truncates without ever encoding it — the full encode
        # would allocate a second equally large string and could turn a
        # truncatable log into an RLIMIT_AS death.
        if len(text) + 3 > self._remaining:
            self._truncated = True
            self._sink(log_truncation_marker(self._max_bytes), truncated=True)
            return
        # A model print() can emit a lone surrogate; strict UTF-8 throws on it
        # here. Replace it rather than escaping it the way :func:`_dump_string`
        # preserves one inside a completion VALUE: log text is already a
        # truncatable, substituting channel (the byte cap replaces the tail with
        # a marker), and the ledger below charges the RAW UTF-8 bytes, which
        # would undercharge the six-byte escape by half. Bounded: the text
        # passed the length check, so this encodes at most ~4x remaining.
        try:
            raw = text.encode("utf-8")
        except UnicodeEncodeError:
            raw = text.encode("utf-8", errors="replace")
            text = raw.decode("utf-8")
        # Charge the SERIALIZED cost — the JSON string form's bytes plus one
        # separator byte — exactly as the host ledger does. Charging the raw
        # UTF-8 length instead undercharges control-heavy text, whose JSON
        # escaping expands it up to sixfold (a NUL costs one raw byte but six
        # as its ``\uXXXX`` escape): a NUL flood sized to fit ``maxLogBytes``
        # raw would serialize to roughly six times the shared cap, and the child
        # could then die on RLIMIT_AS (reported host-side as ``worker-exit``)
        # instead of emitting the truncation marker. The +1 also floors an empty
        # entry above zero, so a flood of blank ``print()`` lines exhausts the
        # budget instead of emitting unbounded zero-cost log frames.
        cost = _json_string_cost(raw) + 1
        if cost > self._remaining:
            self._truncated = True
            self._sink(log_truncation_marker(self._max_bytes), truncated=True)
            return
        self._remaining -= cost
        self._sink(text)


class _LogStream(io.TextIOBase):
    """A newline-coalescing text stream backed by a :class:`LogBuffer`.

    Installed as ``sys.stdout`` / ``sys.stderr`` before executing the model
    program. ``print(...)`` calls ``write`` once per argument, separator, and
    newline, so a raw one-push-per-write stream would emit
    ``["a", " ", "b", "\\n"]`` for ``print("a", "b")`` — and Code Mode renders
    ``logs`` with ``join('\\n')``, turning that into spurious blank lines. This
    stream instead buffers writes and pushes one LogBuffer entry per completed
    LINE (the text up to each ``\\n``, newline stripped), so the rendered join
    reproduces ``a b``. Any unterminated tail is flushed by :meth:`flush_line`
    after the program settles.
    """

    def __init__(self, logs: LogBuffer) -> None:
        super().__init__()
        self._logs = logs
        # list-of-chunks, joined only at a newline or flush: repeated
        # ``print("x", end="")`` must not concatenate quadratically.
        self._pending: list[str] = []
        self._pending_chars = 0

    def writable(self) -> bool:  # noqa: D401 -- inherited contract
        return True

    def write(self, text: str) -> int:  # noqa: D401 -- inherited contract
        # Serialize the whole read-modify-write against the settlement flush and
        # any other thread's write: model code may spawn daemon threads that keep
        # printing after the program body returns, and this method reads
        # ``remaining`` and mutates ``_pending``/the ledger across many steps. The
        # lock is the buffer's and is re-entrant, so the ``push`` calls below
        # (which re-acquire it) do not deadlock.
        with self._logs.lock:
            return self._write_locked(text)

    def _write_locked(self, text: str) -> int:
        # Drop an empty write instead of buffering it. An empty chunk adds no
        # character, so the budget check below can never fire on it:
        # ``while True: sys.stdout.write("")`` would append one list slot per
        # call with `_pending_chars` pinned at 0, growing unbounded long after
        # the log ledger was exhausted (about 3.7 M slots per CPU second here)
        # until RLIMIT_AS turned the allocation into a MemoryError — reported as
        # the program's own exception rather than the intended bounded-log
        # behavior. Returning here also keeps `flush_line` from pushing a
        # spurious empty log entry for a program whose only writes were empty.
        if not text:
            return 0
        if "\n" in text:
            # Scan `text` in place; the buffered chunks are joined ONLY into the
            # first line. Joining the pending chunks with the whole write first
            # made a second copy of that write, which an over-budget write
            # cannot afford (measured under a 400 MiB addressSpaceMb: one
            # buffered character followed by a 340 MiB write died on MemoryError
            # inside the join, reported as the program's own exception, and the
            # retained chunks made the settlement `flush_line` fail the same way
            # — costing the `done` frame and turning the run into a wall-clock
            # timeout instead of the promised truncation marker).
            length = len(text)
            pos = 0
            if self._pending:
                newline = text.index("\n")
                if self._pending_chars + newline + 3 > self._logs.remaining:
                    # The reconstructed first line cannot fit the ledger, so
                    # LogBuffer would reject it whole: copy only the prefix that
                    # fails its cheap bound and drop the chunks. The slice is
                    # bounded HERE, not inside the helper: `text[:newline]` on a
                    # 340 MiB newline-terminated write is the same full copy the
                    # join was (measured: MemoryError inside `sys.stdout.write`
                    # under a 400 MiB addressSpaceMb), and `remaining + 4`
                    # characters are all the helper can use.
                    self._push_bounded_prefix(text[: min(newline, self._logs.remaining + 4)])
                else:
                    self._pending.append(text[:newline])
                    line = "".join(self._pending)
                    self._pending = []
                    self._pending_chars = 0
                    self._logs.push(line)
                pos = newline + 1
            # Scan by offset and STOP once the ledger is exhausted: a single
            # write of many newlines (``print("\n" * 1000000)``) would otherwise
            # re-slice the tail once per line and keep pushing long after
            # LogBuffer truncated, burning the CPU budget on discarded lines.
            # `remaining` reads 0 the instant the buffer truncates, so the loop
            # exits immediately; the unscanned tail is simply dropped.
            while pos < length and self._logs.remaining > 0:
                newline = text.find("\n", pos)
                if newline < 0:
                    break
                # Bound the SLICE the same way LogBuffer bounds the encode: a
                # first line far above the ledger would be copied whole before
                # push could reject it, and that copy is the allocation an
                # over-budget write cannot afford. Copy only a budget-sized
                # prefix, which push still rejects on its own cheap bound (the
                # prefix is longer than `remaining`), so the marker is emitted
                # and the oversized line is never materialized.
                if newline - pos + 3 > self._logs.remaining:
                    self._logs.push(text[pos:pos + self._logs.remaining + 4])
                    break
                self._logs.push(text[pos:newline])
                pos = newline + 1
            if pos < length:
                if self._logs.remaining > 0:
                    tail = text[pos:]
                    self._pending.append(tail)
                    self._pending_chars = len(tail)
                else:
                    # The ledger ran out with text still unscanned, so that text
                    # IS being dropped and the run must say so. One push is
                    # enough and is bounded: `remaining` is 0, so LogBuffer's
                    # cheap length lower bound rejects immediately, emits the
                    # marker, and never encodes the tail — and a push after the
                    # marker is already out returns without emitting a second.
                    # Reaching 0 EXACTLY (65 one-character lines against the
                    # default 3-byte-per-entry serialized charge) leaves
                    # `_truncated` unset, so without this the tail vanished with
                    # no marker at all. Sliced to a budget-sized prefix, not the
                    # whole tail: the tail can be hundreds of megabytes and the
                    # copy would be the RLIMIT_AS death this bound exists to
                    # avoid, while push only needs enough characters to fail its
                    # own cheap length check.
                    self._logs.push(text[pos:pos + self._logs.remaining + 4])
        else:
            self._pending.append(text)
            self._pending_chars += len(text)
        # A newline-free flood must hit the budget while running, not at
        # settlement: once the buffered tail alone can no longer fit the
        # ledger (chars lower-bound the serialized cost), push it through — LogBuffer
        # truncates, emits the marker once, and swallows everything after.
        if self._pending_chars > self._logs.remaining:
            self._push_bounded_prefix()
        return len(text)

    def _push_bounded_prefix(self, extra: str = "") -> None:
        # Reached only when the buffered characters already exceed what the
        # ledger admits, so LogBuffer is certain to reject on its cheap length
        # bound and emit the marker. Copy a budget-sized PREFIX rather than the
        # joined whole: ``sys.stdout.write("x")`` followed by one newline-free
        # 340 MiB write leaves two chunks whose join is a second copy of the
        # payload, and under a tight addressSpaceMb that join raises MemoryError
        # from inside `write` — surfacing as the program's own exception, or,
        # while the oversized chunks stayed retained, again from `flush_line`
        # after the program settled, which cost the `done` frame and turned the
        # run into a wall-clock timeout instead of the promised truncation
        # marker.
        #
        # The chunks are dropped BEFORE the push so neither this call nor the
        # settlement flush can repeat the allocation, and dropping the text is
        # exactly what the marker reports. `remaining + 4` is the shortest
        # prefix that still fails LogBuffer's ``len(text) + 3 > remaining``
        # check; the accumulation stops there, so the copy is bounded by the log
        # budget however large the pending chunks are.
        limit = self._logs.remaining + 4
        parts: list[str] = []
        total = 0
        for chunk in (*self._pending, extra):
            parts.append(chunk[: limit - total])
            total += len(parts[-1])
            if total >= limit:
                break
        self._pending = []
        self._pending_chars = 0
        self._logs.push("".join(parts))

    def flush(self) -> None:  # noqa: D401 -- inherited contract
        # ``TextIOBase.flush`` is a no-op, so without this override an explicit
        # ``print(..., flush=True)`` or ``sys.stdout.flush()`` left the text in
        # `_pending` with nothing to drain it except `flush_line` after the
        # program settles. A run that then hangs or is killed never reaches that
        # call: ``print("before hang", end="", flush=True)`` followed by an
        # infinite loop returned `logs: []`, losing the one diagnostic the
        # program deliberately committed. Forwarding makes an explicit flush emit
        # the pending entry immediately, which is what the caller asked for; a
        # newline-terminated write already emitted on its own.
        self.flush_line()

    def flush_line(self) -> None:
        """Push any buffered text not terminated by a newline (also serves explicit flushes)."""

        # Same shared, re-entrant lock as ``write``: the settlement flush on the
        # main coroutine and a daemon thread's concurrent ``write`` both touch
        # ``_pending`` and the ledger, so this read-and-clear must be atomic
        # against them.
        with self._logs.lock:
            if self._pending:
                self._logs.push("".join(self._pending))
                self._pending = []
                self._pending_chars = 0


# ---------------------------------------------------------------------------
# Fd-3 channel — line-framed JSON.
# ---------------------------------------------------------------------------


class ProtocolChannel:
    """Blocking readers and synchronous writers over the fd-3 protocol pipe.

    Writes are unbuffered and go straight to the fd, so ``send_sync`` is safe
    from inside model code (which may run outside an asyncio task) and from
    background tasks alike. The single writer is serialized by CPython's GIL
    plus one os.write per frame (POSIX guarantees atomicity for writes below
    ``PIPE_BUF``, and our frames are short JSON lines).
    """

    def __init__(self, fd: int) -> None:
        # Unbuffered binary I/O so we never lose frames to an idle flush.
        self._reader = os.fdopen(fd, "rb", buffering=0, closefd=False)
        self._fd = fd
        # Residual bytes read past a frame's newline. Held here, not in the
        # reading coroutine: the reply pump is cancelled once `done` is posted,
        # and read-ahead sitting in a local would be lost with it.
        self._pending = bytearray()
        # Serializes writers: os.write releases the GIL, and a frame larger
        # than PIPE_BUF is neither atomic nor guaranteed fully consumed by one
        # call — without the lock, model-created threads printing while a big
        # completion frame drains could interleave bytes mid-frame.
        self._write_lock = threading.Lock()

    def read_frame(self) -> dict[str, Any] | None:
        """Read one JSON-line frame (iteratively decoded). ``None`` on EOF.

        Blocking. Used for the two frames read BEFORE the model program starts
        (``boot`` and ``run``), where blocking is what the handshake wants. Reply
        frames arriving during the program go through :meth:`read_frame_async`,
        which must not occupy a thread.
        """

        line = self._reader.readline()
        if not line:
            return None
        return _decode_json_plain(line.decode("utf-8"))

    async def read_frame_async(self) -> dict[str, Any] | None:
        """Await one JSON-line frame without occupying a thread. ``None`` on EOF.

        ``loop.run_in_executor(None, read_frame)`` was the obvious spelling and
        the wrong one: the default executor spins up its first thread the moment
        the program awaits a binding, and on Linux/glibc that thread's 8 MiB
        stack plus a 64 MiB per-thread malloc arena reservation are charged to
        ``RLIMIT_AS`` — measured, the child's mappings went from 30.34 MiB to
        102.39 MiB across one ``await tools.*``. Since the limit is already in
        force, that ~72 MiB comes straight out of the run's ``addressSpaceMb``:
        under a small limit the thread cannot start at all and a legitimate
        binding call hangs to ``maxWallMs``, and under a larger one an allocation
        that should have fit dies as ``MemoryError``. This is the same accounting
        the settlement-time CPU recheck was designed around, where a sampling
        thread cost the same 72 MiB.
        `loop.add_reader` watches the fd instead, so no thread exists.

        Bytes past a frame's newline belong to the next frame, so the residual
        lives on the CHANNEL rather than in this coroutine: the pump is cancelled
        once ``done`` is posted, and a local buffer would discard whatever it had
        read ahead.
        """

        loop = asyncio.get_event_loop()
        while True:
            newline = self._pending.find(b"\n")
            if newline >= 0:
                line = bytes(self._pending[:newline])
                del self._pending[: newline + 1]
                return _decode_json_plain(line.decode("utf-8"))
            ready = loop.create_future()
            # `add_reader` only reports readability; the read itself happens here,
            # and `os.read` returns whatever is buffered without waiting for more.
            loop.add_reader(self._fd, lambda: ready.done() or ready.set_result(None))
            try:
                await ready
            finally:
                loop.remove_reader(self._fd)
            chunk = os.read(self._fd, _READ_CHUNK_BYTES)
            if not chunk:
                # EOF. Any partial line is dropped, matching how the host drops a
                # frame that never completed.
                return None
            self._pending.extend(chunk)

    def send_sync(self, message: dict[str, Any]) -> None:
        """Post one frame synchronously.

        Encoded with the iterative :func:`_encode_json_plain` (not
        ``json.dumps``, whose per-level recursion would raise
        ``RecursionError`` on a deeply nested completion or call argument the
        depth-unbounded ``CodeJsonValue`` contract admits). NaN/Infinity still
        raise ``ValueError`` — they would serialize as non-standard tokens
        that Node's ``JSON.parse`` rejects, silently dropping the frame, and a
        call would then hang until the wall clock instead of failing fast.
        Callers turn the ``ValueError`` into their own contract error
        (dispatch raises the lossless-JSON message).
        """

        payload = (_encode_json_plain(message) + "\n").encode("utf-8")
        # Full-write loop under the writer lock: one os.write may consume only
        # part of a frame beyond PIPE_BUF (64 KiB logs / 32 KiB completions /
        # uncapped call args exceed it), and a partial or interleaved frame is
        # dropped host-side as malformed JSON — the run would then hang to the
        # wall clock.
        with self._write_lock:
            view = memoryview(payload)
            while view:
                view = view[os.write(self._fd, view):]


# ---------------------------------------------------------------------------
# Tools proxy — turns ``await tools.name(args)`` into a fd-3 call frame.
# ---------------------------------------------------------------------------


class _Namespace:
    """A proxy for one binding namespace: every declared name routes to the bridge.

    Names arrive from :class:`BootMessage.namespaces`. Both attribute access
    (``tools.name``) and subscript access (``tools["my-tool"]`` — the SDK's
    escape hatch for exotic or reserved names, which are legal function names
    on the wire) return a coroutine factory that posts a ``call`` frame and
    awaits the matching ``reply``. An undeclared name raises ``AttributeError``
    (attribute) or ``KeyError`` (subscript), matching the worker backend's
    own-property discipline.

    ``__getattribute__`` (not ``__getattr__``) intercepts attribute access so a
    declared name ALWAYS reaches the bridge — even one that collides with an
    inherited attribute like ``__class__``, which ordinary lookup would resolve
    on ``object`` before ``__getattr__`` ever ran. Internal state lives under
    name-mangled ``_Namespace__*`` attributes; a declared binding with such a
    name still wins (declared-names check runs first).
    """

    def __init__(self, global_name: str, names: list[str], dispatch) -> None:
        self.__global = global_name
        self.__names = set(names)
        self.__dispatch = dispatch

    def __call_for(self, name: str):
        dispatch = object.__getattribute__(self, "_Namespace__dispatch")
        global_name = object.__getattribute__(self, "_Namespace__global")

        async def call(args: Any) -> Any:
            return await dispatch(global_name, name, args)

        return call

    def __getattribute__(self, name: str):
        # Declared names route to the bridge unconditionally — before Python
        # can resolve an inherited attribute (``__class__``) or our own
        # internals. Everything else falls through to normal lookup so the
        # proxy machinery itself keeps working.
        names = object.__getattribute__(self, "_Namespace__names")
        if name in names:
            return object.__getattribute__(self, "_Namespace__call_for")(name)
        return object.__getattribute__(self, name)

    def __getattr__(self, name: str):
        # Reached only when normal lookup found nothing (declared names were
        # already intercepted above), so this is always an undeclared tool.
        raise AttributeError(
            f"tool {name!r} is not declared in namespace "
            f"{object.__getattribute__(self, '_Namespace__global')!r}"
        )

    def __getitem__(self, name: str):
        names = object.__getattribute__(self, "_Namespace__names")
        if name not in names:
            raise KeyError(
                f"tool {name!r} is not declared in namespace "
                f"{object.__getattribute__(self, '_Namespace__global')!r}"
            )
        return object.__getattribute__(self, "_Namespace__call_for")(name)


class _BindingRejection(Exception):
    """Internal reply-pump rejection, converted by ``dispatch`` into the
    namespace's declared error class (or ``RuntimeError``) so the marker type
    itself never reaches model code."""


def _make_error_class(name: str, member_name_property: str) -> type:
    """Mint one program-visible rejection class per the seam's
    ``CodeBindingErrorClass`` contract: instances carry the failed member name
    under ``member_name_property`` and render as their message."""

    def __init__(self, member_name: str, message: str) -> None:  # noqa: N807
        Exception.__init__(self, message)
        setattr(self, member_name_property, member_name)

    return type(name, (Exception,), {"__init__": __init__})


def _clamped(which: int, soft: int, hard: int) -> tuple[int, int]:
    """Bound a requested (soft, hard) rlimit pair by BOTH inherited limits.

    An unprivileged process may lower a hard limit but never raise it, so a
    harness already started under a tighter ceiling (``ulimit -v`` below
    ``addressSpaceBytes``, or a CPU cap below ``cpuSeconds`` + 1) would make
    ``setrlimit`` raise ``ValueError`` and fail every run — despite the
    inherited limit being STRONGER than the one requested. Clamping keeps the
    stricter of the two, which still satisfies the containment contract.

    Both inherited bounds matter, not just the hard one. A deployment that
    inherited a soft limit BELOW what is requested (e.g. inherited ``(100, 200)``,
    requested ``(150, 160)``) must keep the stricter soft — returning the
    requested ``150`` would RAISE the effective soft limit, loosening RLIMIT_AS
    memory or deferring the RLIMIT_CPU SIGXCPU, the opposite of "strictest of
    configured and inherited". So each side is clamped against its inherited
    counterpart. ``RLIM_INFINITY`` compares as -1, so an infinite inherited bound
    imposes no ceiling and the requested value stands.
    """
    inherited_soft, inherited_hard = resource.getrlimit(which)
    clamped_soft = soft if inherited_soft == resource.RLIM_INFINITY else min(soft, inherited_soft)
    clamped_hard = hard if inherited_hard == resource.RLIM_INFINITY else min(hard, inherited_hard)
    # setrlimit requires soft <= hard. Clamping the two sides independently can
    # invert them (a finite inherited soft below the clamped hard is fine, but a
    # requested hard below the inherited soft would leave soft > hard), so pin
    # soft under hard as the final step; the stricter hard ceiling wins.
    return (min(clamped_soft, clamped_hard), clamped_hard)


# ---------------------------------------------------------------------------
# Main.
# ---------------------------------------------------------------------------


async def _run(channel: ProtocolChannel) -> None:
    # 1. Boot handshake.
    boot = channel.read_frame()
    if boot is None or boot.get("type") != "boot":
        raise RuntimeError("bootstrap: expected boot frame on fd 3")

    # A limit that cannot be applied must fail the run as a diagnosable done
    # frame, not a bare traceback + exit(1): running the program UNCAPPED would
    # silently void the containment contract, and the host can only relay what
    # rides the protocol.
    try:
        # SIGXCPU's default disposition (how the soft CPU limit stops the child)
        # dumps core, and the child inherits the host's RLIMIT_CORE — a CPU
        # timeout would otherwise write a large memory-bearing core file into
        # the workspace. Forbid core dumps first so the timeout path leaves none.
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        # Soft limit at cpuSeconds fires SIGXCPU (its default disposition
        # terminates the child; the host classifies that close as a timeout).
        # Hard limit at +1s is a SIGKILL backstop for a program that traps
        # SIGXCPU and keeps burning CPU.
        cpu_soft, cpu_hard = _clamped(
            resource.RLIMIT_CPU, boot["cpuSeconds"], boot["cpuSeconds"] + 1
        )
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_soft, cpu_hard))
        # Darwin maps the multi-GB dyld shared cache into every process at
        # exec, so any practical RLIMIT_AS cap sits below current usage and
        # the kernel rejects it — the child would die here on every run. Skip
        # the address-space cap there; RLIMIT_CPU and the host's wall-clock
        # ceiling still bound the run.
        if sys.platform != "darwin":
            addr_bytes = int(boot["addressSpaceBytes"])
            resource.setrlimit(
                resource.RLIMIT_AS, _clamped(resource.RLIMIT_AS, addr_bytes, addr_bytes)
            )
    except BaseException as exc:  # noqa: BLE001 -- report every failure to host
        channel.send_sync(
            {
                "type": "done",
                "error": {
                    "kind": "exception",
                    # Exception-only rendering: format_exc() would embed the
                    # absolute installed bootstrap.py path in model-visible
                    # durable output, leaking host paths into transcripts.
                    "message": "bootstrap: applying resource limits failed\n"
                    + "".join(
                        traceback.format_exception_only(type(exc), exc)
                    ),
                },
            }
        )
        return

    logs = LogBuffer(
        int(boot["maxLogBytes"]),
        sink=lambda text, truncated=False: channel.send_sync(
            {"type": "log", "text": text, **({"truncated": True} if truncated else {})}
        ),
    )

    # 2. Wire the tools proxies and the ack.
    #
    # Each entry records the reply Future AND the loop it was created on. Model
    # code may call a binding from a THREAD it started, spelled
    # ``asyncio.run(tools.x(...))`` or its own new loop in that thread, so a
    # Future here can belong to a loop other than the one ``_pump_replies`` runs
    # on. ``asyncio.Future`` is not thread-safe: completing it from another
    # thread does not wake its own loop, so the pump schedules the completion on
    # the owning loop via ``call_soon_threadsafe`` (see ``_pump_replies``) rather
    # than calling ``set_result`` directly.
    pending: dict[int, tuple[asyncio.AbstractEventLoop, asyncio.Future[Any]]] = {}
    next_id = 0
    # Serializes the id claim + write + counter advance in ``dispatch`` against
    # both other binding-calling threads and the pump's ``pop``. ``dispatch`` may
    # run concurrently on several loops/threads, and the host answers a ``call``
    # only when its id is the exact successor of the last one — so ids must reach
    # the wire in the order they are claimed. Holding this lock across the write
    # (not just the counter arithmetic) is what keeps two threads' frames from
    # interleaving on fd 3 out of id order, which the host would reject.
    pending_lock = threading.Lock()

    error_classes: dict[str, type] = {}

    async def dispatch(global_name: str, name: str, args: Any) -> Any:
        nonlocal next_id
        error_class = error_classes.get(global_name)

        def call_failure(message: str) -> BaseException:
            # The namespace's declared rejection contract (e.g. Code Mode's
            # ToolCallError with .toolName) when present; RuntimeError keeps
            # the pre-errorClass behavior for namespaces that declared none.
            if error_class is not None:
                return error_class(name, message)
            return RuntimeError(message)

        # Validate the argument shape before claiming an id, so a rejected call
        # leaves no gap in the sequence the host checks. json.dumps would coerce
        # a non-string dict key or non-finite float rather than raise (allow_nan
        # is off, but key coercion still slips through), silently corrupting what
        # the tool receives. Reject up front through the call's error contract.
        violation = _lossless_json_violation(args)
        if violation is not None:
            raise call_failure(f"binding arguments must be lossless JSON ({violation})")
        # Ids are consecutive from 0 with NO gaps: the host answers a `call` only
        # when its id is the exact successor of the last one, which bounds the
        # state it retains to a single number. A frame that never reaches the
        # host must therefore not consume an id, so the counter advances only
        # once the write has succeeded.
        #
        # The whole claim-write-advance runs under ``pending_lock`` because a
        # binding may be called from more than one thread/loop at once (the model
        # can start a thread that runs ``asyncio.run(tools.x(...))``). Without
        # the lock two callers could claim the same id, or write their frames to
        # fd 3 in an order that does not match their ids — either of which the
        # host rejects as an out-of-sequence call. The Future's own loop is
        # captured here so ``_pump_replies`` can complete it thread-safely.
        loop = asyncio.get_event_loop()
        with pending_lock:
            call_id = next_id
            fut: asyncio.Future[Any] = loop.create_future()
            pending[call_id] = (loop, fut)
            try:
                channel.send_sync(
                    {
                        "type": "call",
                        "id": call_id,
                        "global": global_name,
                        "name": name,
                        "args": args,
                    }
                )
            except (TypeError, ValueError) as exc:
                pending.pop(call_id, None)
                raise call_failure(
                    f"binding arguments must be lossless JSON: {exc}"
                ) from exc
            next_id += 1
        try:
            return await fut
        except _BindingRejection as exc:
            raise call_failure(str(exc)) from None

    namespaces: dict[str, Any] = {}
    for entry in boot["namespaces"]:
        namespaces[entry["global"]] = _Namespace(
            entry["global"], entry["names"], dispatch
        )
        declared = entry.get("errorClass")
        if declared:
            error_class = _make_error_class(
                declared["name"], declared["memberNameProperty"]
            )
            error_classes[entry["global"]] = error_class
            # The class is program-visible under its own name so model code
            # can `except ToolCallError as e:` and read the member property.
            namespaces[declared["name"]] = error_class

    channel.send_sync({"type": "boot-ack"})

    # 3. Start a reply-pump task before the run message: replies can arrive
    # interleaved with the run's own binding traffic.
    reply_task = asyncio.get_event_loop().create_task(
        _pump_replies(channel, pending, pending_lock)
    )

    # 4. Read the run message.
    run = channel.read_frame()
    if run is None or run.get("type") != "run":
        reply_task.cancel()
        raise RuntimeError("bootstrap: expected run frame on fd 3")

    program: str = run["program"]

    # 5. Install log capture — ``print``, tracebacks, and ordinary ``sys.stdout``
    # writes funnel into the LogBuffer. The real fds stay open (host uses
    # stderr for stray-byte accounting) but the Python-visible streams point
    # at the buffer.
    sys.stdout = _LogStream(logs)  # type: ignore[assignment]
    sys.stderr = _LogStream(logs)  # type: ignore[assignment]
    out_stream, err_stream = sys.stdout, sys.stderr

    # 6. Compile the program as the body of an async function, matching the
    # seam contract (`CodeRunRequest.program` is an async-function body: top-level
    # `await` and `return` both work, and the returned value is the completion).
    # AST-splicing the parsed body into an `async def` keeps every statement's
    # original line number, so a traceback points at the model's own source.
    ns: dict[str, Any] = {
        "__name__": "__main__",
        "__builtins__": __builtins__,
        **namespaces,
    }
    # Read the enforcement callable and its budget into this frame's locals
    # BEFORE the program runs: model code can rebind this module's globals
    # (the bootstrap IS ``__main__``), and a frame local is not a module
    # attribute, so a later ``__main__._DIE_IF_CPU_EXHAUSTED = ...`` cannot
    # change which callable the post-check below invokes. This defeats the
    # one-line rebind, not a determined `sys._getframe` walk; the unforgeable
    # bounds are the RLIMIT_CPU hard limit and the host wall clock
    # (see _make_cpu_enforcer).
    die_if_cpu_exhausted = _DIE_IF_CPU_EXHAUSTED
    cpu_seconds = int(boot["cpuSeconds"])
    # Same capture, same reason, for the failure path and the send that follows
    # it. The reporter was a module-global lookup inside the `except` block, so
    # ``import __main__; __main__._SAFE_MODEL_TRACEBACK = ...`` put model code
    # there with no guard around it; the flush and send were attribute lookups
    # on the stream and channel CLASSES, which ``__main__._LogStream.flush_line
    # = ...`` rebinds just as easily. All four run AFTER the handler, where a
    # throw costs the `done` frame and the host reports a wall-clock timeout
    # instead of the model's exception. Binding the callables now fixes what
    # runs; what they in turn reach is closed over in _make_failure_reporter.
    safe_model_traceback = _SAFE_MODEL_TRACEBACK
    flush_out = out_stream.flush_line
    flush_err = err_stream.flush_line
    send_done = channel.send_sync
    max_value_bytes = int(boot["maxValueBytes"])
    done: dict[str, Any]
    try:
        module = ast.parse(program)
        wrapper = ast.AsyncFunctionDef(
            name="__dsh_main__",
            args=ast.arguments(
                posonlyargs=[], args=[], vararg=None,
                kwonlyargs=[], kw_defaults=[], kwarg=None, defaults=[],
            ),
            body=module.body or [ast.Pass()],
            decorator_list=[],
            returns=None,
        )
        # Anchor the synthetic wrapper on the first real statement (or line 1 for
        # an empty program) so fix_missing_locations does not stamp it at 0.
        anchor = module.body[0] if module.body else ast.parse("pass").body[0]
        ast.copy_location(wrapper, anchor)
        wrapped = ast.Module(body=[wrapper], type_ignores=[])
        ast.fix_missing_locations(wrapped)
        code = compile(wrapped, "<model>", "exec")
        exec(code, ns)  # noqa: S102 -- defines __dsh_main__; executing model code is the point
        value = await ns["__dsh_main__"]()
        die_if_cpu_exhausted(cpu_seconds)
        done = _done_with_value(value, max_value_bytes)
    except BaseException as exc:  # noqa: BLE001 -- report every failure to host
        done = {
            "type": "done",
            "error": {
                "kind": "exception",
                # Cap the diagnostic BEFORE it crosses the wire: a program can
                # raise with a gigabytes-long message, and formatting/sending
                # it whole would allocate on both sides before the host's own
                # cap runs. Byte-cap at maxValueBytes with the host's marker
                # text so the truncated diagnostic reads identically wherever
                # the cap was applied. The rendering is wrapped because the
                # `done` send below sits outside this handler: a throw while
                # formatting would skip it and strand the host on fd 3 until
                # maxWallMs (see _make_failure_reporter).
                "message": safe_model_traceback(exc, max_value_bytes),
            },
        }

    # Flush any print output not terminated by a newline (a traceback always
    # ends in one, but `print(x, end="")` or a bare write may not), so the
    # final partial line is not silently dropped.
    flush_out()
    flush_err()
    reply_task.cancel()
    send_done(done)


async def _pump_replies(
    channel: ProtocolChannel,
    pending: dict[int, tuple[asyncio.AbstractEventLoop, asyncio.Future[Any]]],
    pending_lock: "threading.Lock",
) -> None:
    """Background task: read reply frames and settle pending futures.

    Cancelled after ``done`` is posted. Unknown ids and post-settlement replies
    are ignored (mirrors the worker backend's hostile-peer stance, though here
    the host is the trusted side; the guards defend against races).

    A pending Future may belong to a loop other than this pump's — the model can
    call a binding from a thread running its own loop (``asyncio.run(tools.x())``).
    ``asyncio.Future`` is not thread-safe, so the completion is scheduled on the
    Future's OWN loop via ``call_soon_threadsafe`` rather than mutated here; a
    direct ``set_result`` would never wake the waiting loop and the call would
    hang to the wall clock. The ``pop`` shares ``pending_lock`` with ``dispatch``
    so a reply cannot race the claim that registers its id.
    """

    def complete(fut: asyncio.Future[Any], ok: bool, value: Any, message: Any) -> None:
        # Runs on the Future's own loop. `done()` re-checked here because
        # cancellation or a duplicate reply may have settled it between the pop
        # and this callback.
        if fut.done():
            return
        if ok:
            fut.set_result(value)
        else:
            fut.set_exception(_BindingRejection(str(message)))

    while True:
        frame = await channel.read_frame_async()
        if frame is None:
            return
        if frame.get("type") != "reply":
            continue
        with pending_lock:
            entry = pending.pop(frame.get("id"), None)
        if entry is None:
            continue
        loop, fut = entry
        ok = bool(frame.get("ok"))
        value = frame.get("value")
        message = frame.get("message")
        loop.call_soon_threadsafe(complete, fut, ok, value, message)


_SCALAR_RE = re.compile(
    r'"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null'
)


def _decode_json_plain(text: str) -> Any:
    """Parse one JSON document iteratively (no per-level recursion).

    ``json.loads`` recurses per nesting level and raises ``RecursionError``
    around ~10k levels, but a binding reply is depth-unbounded by the seam
    contract — the host's iterative encoder happily produces documents
    ``json.loads`` cannot read back. Scalars (numbers, strings with escapes)
    are delegated to ``json.loads`` one token at a time, so their grammar and
    semantics stay CPython's own; only the container structure is parsed here
    with an explicit stack. Raises ``ValueError`` on malformed input; frames
    come from the TRUSTED host, so strictness mirrors ``json.loads`` without
    extra hostile-input hardening.
    """

    length = len(text)

    def skip_ws(i: int) -> int:
        while i < length and text[i] in " \t\n\r":
            i += 1
        return i

    def scalar(i: int):
        match = _SCALAR_RE.match(text, i)
        if match is None:
            raise ValueError(f"invalid JSON at offset {i}")
        return json.loads(match.group(0)), match.end()

    def string_key(i: int):
        key, end = scalar(i)
        if not isinstance(key, str):
            raise ValueError(f"object key must be a string at offset {i}")
        end = skip_ws(end)
        if end >= length or text[end] != ":":
            raise ValueError(f"expected ':' at offset {end}")
        return key, skip_ws(end + 1)

    # Frames: a list, or (dict, pending key). `value`/`have_value` carry each
    # completed value up to its parent frame.
    stack: list[Any] = []
    value: Any = None
    have_value = False
    i = skip_ws(0)
    while True:
        if not have_value:
            ch = text[i] if i < length else ""
            if ch == "[":
                i = skip_ws(i + 1)
                if i < length and text[i] == "]":
                    i += 1
                    value, have_value = [], True
                else:
                    stack.append([])
                    continue
            elif ch == "{":
                i = skip_ws(i + 1)
                if i < length and text[i] == "}":
                    i += 1
                    value, have_value = {}, True
                else:
                    key, i = string_key(i)
                    stack.append(({}, key))
                    continue
            else:
                value, i = scalar(i)
                have_value = True
        if not stack:
            i = skip_ws(i)
            if i != length:
                raise ValueError(f"trailing data at offset {i}")
            return value
        top = stack[-1]
        i = skip_ws(i)
        ch = text[i] if i < length else ""
        if isinstance(top, list):
            top.append(value)
            if ch == ",":
                i = skip_ws(i + 1)
                have_value = False
            elif ch == "]":
                i += 1
                stack.pop()
                value = top
            else:
                raise ValueError(f"expected ',' or ']' at offset {i}")
        else:
            container, key = top
            container[key] = value
            if ch == ",":
                key, i = string_key(skip_ws(i + 1))
                stack[-1] = (container, key)
                have_value = False
            elif ch == "}":
                i += 1
                stack.pop()
                value = container
            else:
                raise ValueError(f"expected ',' or '}}' at offset {i}")


def _encode_json_plain(value: Any) -> str:
    """Encode JSON-plain data iteratively, byte-identical to compact ``json.dumps``.

    ``json.dumps`` recurses one Python frame per nesting level and raises
    ``RecursionError`` a few thousand levels deep, but the seam's
    ``CodeJsonValue`` has no depth limit — a valid deeply nested completion or
    call argument below the byte budget must cross intact (the host uses the
    same iterative idiom in ``protocol.ts``). Accepts what the callers already
    validated or constructed: ``None``/``bool``/``int``/finite ``float``/
    ``str``, exact ``list``/``tuple``, and exact ``dict`` with ``str`` keys.
    Scalar encoding delegates to ``json.dumps`` (string escaping, float repr)
    so the bytes match; non-finite floats still raise ``ValueError`` exactly
    like ``allow_nan=False``.

    Containers are classified by EXACT type and traversed through the unbound
    built-in methods rather than the instance's own: a ``dict``/``list``
    subclass can override ``items``, ``keys``, ``__iter__``, ``__len__``, or
    ``__getitem__``, and the validators only see the container it subclasses,
    so an instance-method call here could emit different data than the walk
    that metered and approved it. ``_check_done_value`` and
    ``_lossless_json_violation`` reject subclasses outright, so this path only
    ever sees exact containers; classifying on exact type keeps that agreement
    checkable at one glance instead of resting on the caller.
    """

    chunks: list[str] = []
    # Each frame is either a literal string to emit or a value to expand.
    stack: list[Any] = [value]
    while stack:
        current = stack.pop()
        current_type = type(current)
        if current_type is _Emit:
            chunks.append(current.text)
        elif current_type is list or current_type is tuple:
            count = len(current)
            chunks.append("[")
            stack.append(_Emit("]"))
            for index in range(count - 1, -1, -1):
                if index < count - 1:
                    stack.append(_Emit(","))
                stack.append(current[index])
        elif current_type is dict:
            chunks.append("{")
            stack.append(_Emit("}"))
            items = list(dict.items(current))
            for index in range(len(items) - 1, -1, -1):
                key, item = items[index]
                if index < len(items) - 1:
                    stack.append(_Emit(","))
                stack.append(item)
                stack.append(_Emit(_dump_scalar(key) + ":"))
        else:
            chunks.append(_dump_scalar(current))
    return "".join(chunks)


def _dump_scalar(value: Any) -> str:
    """One scalar as compact JSON, byte-compatible with the host's encoder.

    ``ensure_ascii=False`` keeps non-ASCII text as raw UTF-8 — the default
    backslash-u escaping would make the child count ``"é"`` as 8 bytes where
    the host meter (and the worker backend) count its UTF-8 JSON form as 4,
    splitting the budget the two sides are supposed to share. Strings route
    through :func:`_dump_string`, which restores the escaping for the one class
    of character UTF-8 cannot hold. Floats route through :func:`_dump_float`
    because CPython's ``repr`` and ECMAScript's Number-to-String disagree on
    spelling.

    Dispatch is on EXACT type, matching the validators: a ``float`` subclass
    reaching :func:`_dump_float` would have its overridden ``__repr__`` read as
    the number's digits, so ``F(2.5)`` whose ``__repr__`` returns ``"1.0"``
    would serialize as ``1``. ``json.dumps`` then refuses any subclass by
    ``TypeError`` instead of emitting a value nothing validated; the callers
    reject subclasses first, so this is the encoder refusing to be the place a
    validation gap turns into corrupted output.
    """

    if type(value) is float:
        return _dump_float(value)
    if type(value) is str:
        return _dump_string(value)
    if value is None or type(value) is bool or type(value) is int:
        return json.dumps(value, ensure_ascii=False, allow_nan=False)
    raise TypeError(f"unsupported type ({type(value).__name__})")


# A surrogate code unit, and an adjacent high-low pair. Python stores an astral
# character as ONE code point, so a surrogate reaching these patterns is either
# lone or half of a pair the program spelled out code unit by code unit.
_SURROGATE = re.compile("[\ud800-\udfff]")
_SURROGATE_PAIR = re.compile("[\ud800-\udbff][\udc00-\udfff]")


def _combine_surrogate_pair(match: re.Match[str]) -> str:
    """Fold one spelled-out high-low pair into the astral code point it names."""

    high, low = match.group(0)
    return chr(0x10000 + ((ord(high) - 0xD800) << 10) + (ord(low) - 0xDC00))


def _dump_string(text: str) -> str:
    """One string as compact JSON, byte-identical to the host's ``JSON.stringify``.

    ``ensure_ascii=False`` cannot render a surrogate code unit: UTF-8 has no
    encoding for one, so the frame write would raise and the run would strand
    until the wall clock. JSON carries it as the ASCII escape ``\\ud800``, which
    the host's ``JSON.parse`` reads back as the same UTF-16 code unit and its
    ``JSON.stringify`` re-emits identically — so the shared seam
    (``CodeJsonValue``, ``snapshotJsonValue``, the worker backend) keeps a
    lone-surrogate string instead of failing the value. An adjacent high-low
    pair is folded into its astral code point FIRST: the host holds strings as
    UTF-16, where those two code units and the single character are the same
    string, and the raw 4-byte form is what the host would emit — escaping the
    halves separately would charge 12 bytes against a budget the host meters at
    4. Every remaining surrogate is lone and becomes six ASCII bytes, matching
    the host exactly.
    @param text: the string to encode.
    @return: its compact JSON form, always UTF-8-encodable.
    """

    rendered = json.dumps(text, ensure_ascii=False)
    if _SURROGATE.search(rendered) is None:
        return rendered
    return _SURROGATE.sub(
        lambda match: "\\u%04x" % ord(match.group(0)),
        _SURROGATE_PAIR.sub(_combine_surrogate_pair, rendered),
    )


# How many bytes each byte that needs escaping adds beyond its raw self, as a
# ready-made (byte, surcharge) list so :func:`_json_string_cost` walks no
# branches per pass. ``"`` and ``\\`` take a one-character prefix; the five C0
# controls with a shorthand (``\\b\\f\\n\\r\\t``) likewise; every other C0
# control becomes a six-character ``\\uXXXX``.
_JSON_ESCAPE_SURCHARGES = [
    (bytes((byte,)), 1 if byte in b'"\\\b\f\n\r\t' else 5)
    for byte in [*range(0x20), ord('"'), ord("\\")]
]


def _json_string_cost(raw: bytes) -> int:
    """UTF-8 byte length of one string's JSON form, WITHOUT building that form.

    Used by :class:`LogBuffer` to charge a log entry what it will actually cost
    on the wire. Building ``json.dumps(text)`` to measure it would allocate a
    second copy up to six times the original — the very allocation the ledger's
    cheap pre-check exists to avoid, and enough to breach ``RLIMIT_AS`` on a
    large control-heavy line. Counts exactly what :func:`_dump_scalar`'s
    ``ensure_ascii=False`` output holds: the two quotes, each escaped byte's
    surcharge from :data:`_JSON_ESCAPE_SURCHARGES`, and the raw bytes themselves
    (non-ASCII stays raw, so its UTF-8 length already counts). Uses a fixed
    number of C-level ``count`` passes — allocating nothing, unlike a
    ``translate`` filter — because the caller admits up to ~4x the remaining
    budget of bytes here and a per-byte Python loop over it would cost more than
    the encode being avoided.
    @param raw: the entry's UTF-8 bytes.
    @return: the byte length of its JSON string form, quotes included.
    """

    extra = 0
    for byte, surcharge in _JSON_ESCAPE_SURCHARGES:
        extra += raw.count(byte) * surcharge
    return len(raw) + 2 + extra


def _dump_float(value: float) -> str:
    """One finite float in ECMAScript ``Number::toString`` spelling.

    CPython's ``repr`` and the host's ``String(number)`` name the same double
    differently: ``1.0`` is ``"1.0"`` here but ``"1"`` there, ``1e-07`` pads the
    exponent the host writes as ``1e-7``, and ``1e+21``/``2**60`` differ again.
    Since the child meters the completion value against ``maxValueBytes`` and
    the host re-meters the frame it parses, any spelling difference splits the
    shared budget: ``return 1.0`` under ``maxValueBytes: 1`` used to be reported
    as ``output-limit`` by the child while the host would have counted the
    one-byte ``1`` it actually receives. Both sides also emit these bytes (the
    child through :func:`_encode_json_plain`, the host through
    ``encodeJsonPlain``), so the fix has to be in the shared speller, not in the
    meter.

    Implements ECMA-262 ``Number::toString`` radix 10 directly: ``repr``
    already yields the shortest round-tripping decimal digits, and ``Decimal``
    splits them into the significand ``s`` (``digits``, ``k`` of them) and
    decimal exponent ``n`` the spec's cases select on. The integral values above
    the JS safe range take the host's BigInt branch, whose exact digits differ
    from the shortest-round-trip form (``2**60`` prints ``...846976``, not
    ``...847000``).
    """

    if value != value or value in (float("inf"), float("-inf")):
        # json.dumps(allow_nan=False) raises the same way; the callers reject
        # non-finite floats before metering, so this is unreachable defense.
        raise ValueError("Out of range float values are not JSON compliant")
    if value == 0.0:
        # Covers -0.0 too; callers reject it as non-lossless before this point.
        return "0"
    if value < 0:
        return "-" + _dump_float(-value)
    if value.is_integer() and value > float(2**53 - 1):
        # The host's BigInt branch: exact digits, not shortest-round-trip.
        return str(int(value))
    parts = Decimal(repr(value)).normalize().as_tuple()
    digits = "".join(str(digit) for digit in parts.digits)
    k = len(digits)
    n = parts.exponent + k
    if k <= n <= 21:
        return digits + "0" * (n - k)
    if 0 < n <= 21:
        return digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return "0." + "0" * -n + digits
    exponent = ("+" if n - 1 >= 0 else "-") + str(abs(n - 1))
    return (digits if k == 1 else digits[0] + "." + digits[1:]) + "e" + exponent


def _check_done_value(value: Any, max_bytes: int):
    """Meter a completion value's JSON byte size AND validate its lossless-JSON
    shape in one bounded post-order walk; return ``None`` when it passes.

    Folds what was formerly a losslessness walk followed by a separate byte
    meter into one pass. Running the losslessness walk first materialized one
    traversal tuple per element before any size cap: ``return [0] * 2000000``
    under ``maxValueBytes: 64`` allocated millions of frames (an RLIMIT_AS
    death) before the meter could reject it. Folding the byte bound into the
    walk rejects over-budget BEFORE enqueuing a container's children — every
    element is at least one JSON byte — so the walk stays O(cap). Same
    JS-double-exact integer boundary, cycle detection (a leave marker pops each
    container off ``on_path``), and type rejections as
    :func:`_lossless_json_violation`, and the same byte accounting as
    :func:`_encode_json_plain`. :func:`_lossless_json_violation` stays for the
    binding-argument path, which carries no size cap.

    EVERY type here is matched EXACTLY, containers and scalars alike, so a
    subclass is rejected as an unsupported type rather than admitted by
    ``isinstance``. A subclass can override the operators and methods this walk
    and the encoder call, and they need not agree: a populated ``dict``
    subclass whose ``items()`` returns ``[]`` would meter as ``{}``; a ``float``
    subclass overriding ``__repr__`` passes the non-finite and negative-zero
    checks by its real value but serializes as whatever the override says, since
    :func:`_dump_float` reads ``repr``; an ``int`` subclass overriding ``__gt__``
    and ``__lt__`` slips past the JS-safe-range bound while ``json.dumps``
    emits its true C-level digits, so ``2**53 + 1`` reaches the host as
    ``...992``; a ``str`` subclass overriding ``__len__`` returns 0 from the
    pre-encode lower bound and admits an arbitrarily large string. In each case
    the value the host receives differs from the one this walk approved. The
    worker backend rejects the equivalent shapes by prototype identity and
    ``typeof`` (``hasPlainObjectPrototype`` in ``worker-json.ts``); a ``bool``
    is checked before ``int`` because it is an ``int`` subclass that IS
    lossless JSON.

    Returns ``("invalid-output", message)`` for a non-lossless value,
    ``("output-limit", message)`` once the size crosses ``max_bytes``, or
    ``None`` when the value is lossless JSON within budget.
    """

    js_safe = 2**53 - 1

    def invalid(reason: str):
        return ("invalid-output", f"program completion must be lossless JSON ({reason})")

    over_budget = ("output-limit", f"completion value exceeded {max_bytes} bytes")

    total = 0
    on_path: set[int] = set()
    # Each frame is (value, is_leave): a leave frame pops its container off the path.
    stack: list[tuple[Any, bool]] = [(value, False)]
    while stack:
        current, is_leave = stack.pop()
        if is_leave:
            on_path.discard(id(current))
            continue
        if current is None or type(current) is bool:
            total += len(_dump_scalar(current).encode("utf-8"))
        elif type(current) is str:
            # Lower-bound BEFORE materializing the escaped form: every character
            # is at least one UTF-8 byte plus the two quotes, so a huge or
            # control-heavy string (whose escaped copy expands severalfold) is
            # rejected without allocating that copy.
            if total + len(current) + 2 > max_bytes:
                return over_budget
            # A lone surrogate has no UTF-8 form but a lossless JSON one — the
            # ASCII ``\uXXXX`` escape :func:`_dump_string` emits — so it is
            # metered, not rejected, matching the shared seam.
            total += len(_dump_string(current).encode("utf-8"))
        elif type(current) is int:
            # The canonical boundary accepts every JS-double-exact value: an int
            # outside +-2**53-1 is fine IFF the double round-trip is exact.
            if current > js_safe or current < -js_safe:
                try:
                    exact = int(float(current)) == current
                except OverflowError:
                    exact = False
                if not exact:
                    return invalid("integer not exactly representable as a JavaScript number")
            total += len(_dump_scalar(current).encode("utf-8"))
        elif type(current) is float:
            if current != current or current in (float("inf"), float("-inf")):
                return invalid("non-finite float")
            # JSON turns -0.0 into a sign the host parses back to JS -0; the
            # canonical boundary rejects it, so this side must too.
            if current == 0.0 and math.copysign(1.0, current) < 0:
                return invalid("negative zero")
            total += len(_dump_scalar(current).encode("utf-8"))
        elif type(current) is list:
            if id(current) in on_path:
                return invalid("circular reference")
            count = len(current)
            total += 2 + (count - 1 if count > 1 else 0)
            # Reject over-budget BEFORE enqueuing children: every element
            # serializes to at least one byte, so a wide flat forgery fails here
            # without materializing millions of leave frames first.
            if total + count > max_bytes:
                return over_budget
            on_path.add(id(current))
            stack.append((current, True))
            stack.extend((child, False) for child in current)
        elif type(current) is dict:
            if id(current) in on_path:
                return invalid("circular reference")
            # ``len`` without materializing ``current.items()``: that list
            # allocates one tuple per member before the bound below could run,
            # recreating the spike the bound exists to stop.
            count = len(current)
            total += 2 + (count - 1 if count > 1 else 0)
            # Same pre-enqueue bound: each entry contributes a quoted key
            # (>= 2 bytes), a colon, and a >= 1-byte value.
            if total + count * 4 > max_bytes:
                return over_budget
            on_path.add(id(current))
            stack.append((current, True))
            for key, item in current.items():
                # Only an EXACT str key survives: bool and int coerce or raise,
                # and a str SUBCLASS can override the ``__len__`` the bound
                # below reads while the encoder emits its real characters.
                if type(key) is not str:
                    return invalid(f"non-string dict key ({type(key).__name__})")
                # The same string lower bound, before escaping the key.
                if total + len(key) + 3 > max_bytes:
                    return over_budget
                total += len(_dump_scalar(key).encode("utf-8")) + 1
                stack.append((item, False))
        else:
            # tuple, set, or any other type: not round-trippable JSON.
            return invalid(f"unsupported type ({type(current).__name__})")
        if total > max_bytes:
            return over_budget
    return None


class _Emit:
    """A pre-rendered fragment on :func:`_encode_json_plain`'s explicit stack."""

    __slots__ = ("text",)

    def __init__(self, text: str) -> None:
        self.text = text


def _lossless_json_violation(value: Any) -> str | None:
    """Return why ``value`` is not lossless JSON, or ``None`` when it is.

    ``json.dumps`` succeeding is NOT proof of losslessness: it coerces a
    non-string ``dict`` key to its string form (``{1: "a", "1": "b"}`` collapses
    to one key, silently dropping data), emits non-standard ``NaN``/``Infinity``
    tokens without ``allow_nan=False``, and accepts integers outside JavaScript's
    safe range (``9007199254740993`` becomes ``...992`` once the host parses the
    frame into a JS number). Validate the shape up front so a coercive or lossy
    value fails as ``invalid-output`` instead of round-tripping to something the
    program did not compute. Iterative so deep nesting cannot overflow the stack,
    and it tracks the container ancestry on the current path so a cyclic value is
    reported at once rather than spinning until the CPU budget. Only JSON-plain
    types survive: ``None``/``bool``/JS-safe ``int``/finite ``float``/``str``,
    exact ``list``, and exact ``dict`` with ``str`` keys. Every type matches
    EXACTLY, containers and scalars alike, for the reason
    :func:`_check_done_value` documents: a subclass can override the operators
    and methods a traversal calls, so an ``isinstance`` admission here would
    approve one shape and let the encoder emit another.
    """

    # The canonical boundary accepts every JS-double-exact value: an int
    # outside +-2**53-1 is fine IFF the double round-trip is exact (2**53 or
    # 2**60 survive; 2**53+1 rounds), matching the worker backend.
    js_safe = 2**53 - 1
    # Post-order walk with an explicit "leave" marker: a container's id is added
    # to `on_path` when entered and removed when left, so a back-edge to an
    # ancestor (a cycle) is detected without rejecting a legitimately shared
    # acyclic subtree.
    on_path: set[int] = set()
    # Each frame is (value, is_leave): a leave frame pops its container off the path.
    stack: list[tuple[Any, bool]] = [(value, False)]
    while stack:
        current, is_leave = stack.pop()
        if is_leave:
            on_path.discard(id(current))
            continue
        if current is None or type(current) is bool:
            continue
        if type(current) is str:
            # Every string is lossless JSON. A lone surrogate has no UTF-8 form,
            # but JSON carries the code unit as its ASCII ``\uXXXX`` escape and
            # :func:`_dump_string` emits exactly that, so the host receives the
            # same code unit the program passed — the same acceptance
            # ``CodeJsonValue``, ``snapshotJsonValue``, and the worker backend
            # already give it.
            continue
        if type(current) is int:
            if current > js_safe or current < -js_safe:
                try:
                    exact = int(float(current)) == current
                except OverflowError:
                    exact = False
                if not exact:
                    return "integer not exactly representable as a JavaScript number"
            continue
        if type(current) is float:
            if current != current or current in (float("inf"), float("-inf")):
                return "non-finite float"
            # JSON serialization turns -0.0 into 0 (or "-0.0" text that the
            # host parses to JS -0), silently changing the sign bit either
            # way; the repository's canonical lossless-JSON boundary and the
            # worker backend both reject it, so this side must too.
            if current == 0.0 and math.copysign(1.0, current) < 0:
                return "negative zero"
            continue
        if type(current) is list or type(current) is dict:
            if id(current) in on_path:
                return "circular reference"
            on_path.add(id(current))
            stack.append((current, True))
            if type(current) is dict:
                for key in current:
                    # Only an EXACT str key survives: int, float, None, and
                    # tuple keys coerce or raise, and a str subclass can carry
                    # overrides the encoder does not honor.
                    if type(key) is not str:
                        return f"non-string dict key ({type(key).__name__})"
                stack.extend((child, False) for child in current.values())
            else:
                stack.extend((child, False) for child in current)
            continue
        return f"unsupported type ({type(current).__name__})"
    return None


def _make_cpu_enforcer() -> Any:
    """Build the CPU post-check over closure-held primitives.

    This bootstrap IS ``__main__``, so model code can reach every one of its
    module globals: ``import __main__; __main__._X = ...`` rebinds the name the
    enforcement would otherwise read at call time, which a plain module-level
    function plus module-level captures made a one-line defeat. The primitives
    therefore live in this factory's locals, which become closure cells of the
    returned function, and :func:`_run` binds the returned function into a
    local of its own frame BEFORE executing the program, so no assignment to
    ``__main__`` changes which callable runs or what it calls. Capture happens
    at import time, before model code runs, so the captured
    ``resource.getrusage``/``signal.signal``/``os.kill`` are the real builtins.

    This raises the cost of defeating the check; it does not make it
    unreachable, and nothing in-process could. A cell is writable through
    ``fn.__closure__[i].cell_contents``, and ``sys._getframe`` walks to
    :func:`_run`'s frame and reads its locals, so a program determined to
    tamper still can — consistent with this backend's documented posture, where
    the in-process interpreter is containment rather than a security boundary
    (§Trust posture in the Code Mode RFC). The bounds that model code cannot
    forge are outside the interpreter: the RLIMIT_CPU HARD limit at
    ``cpuSeconds + 1``, whose SIGKILL is undeliverable to a handler and
    unraisable by a process that cannot raise its own hard limit, and the
    host's wall-clock ceiling. This check exists to convert the two cases those
    miss — a program that traps SIGXCPU and settles inside the soft-to-hard
    gap, and a program that spends the budget in DESCENDANTS the kernel never
    charged to this process — from a reported SUCCESS into the same `timeout`
    an untrapped program gets.

    @returns The one-argument enforcement callable, taking `cpuSeconds`.
    """

    getrusage = resource.getrusage
    rusage_self = resource.RUSAGE_SELF
    rusage_children = resource.RUSAGE_CHILDREN
    set_signal = signal.signal
    sig_dfl = signal.SIG_DFL
    sigxcpu = signal.SIGXCPU
    kill = os.kill
    getpid = os.getpid

    def die_if_cpu_exhausted(cpu_seconds: int) -> None:
        """Die by re-delivered SIGXCPU when the CPU budget is already spent.

        Two cases reach here as a would-be SUCCESS. A model program can trap
        SIGXCPU and return during the one-second soft-to-hard gap. And
        ``RLIMIT_CPU`` is PER-PROCESS, inherited fresh by every child, so a
        program calling ``subprocess`` or ``os.fork`` multiplies the run's CPU
        budget by the number of descendants it starts: measured with
        ``cpuSeconds: 1``, two sequential busy children burned 2.0
        CPU-seconds and the parent, which had accrued almost no CPU of its own
        while blocked in ``subprocess.wait``, still returned a completion.
        The meter is therefore ``RUSAGE_SELF + RUSAGE_CHILDREN``, the kernel's
        own aggregate, which accumulates the CPU of every REAPED descendant
        (grandchildren included, verified).

        ``getrusage`` is the kernel's own meter (unforgeable from model code),
        and dying by SIGXCPU with the default disposition restored gives the
        host the same kernel-authoritative close signal as the untrapped soft
        limit — classified as `timeout`, after which the host's process-group
        SIGTERM/SIGKILL teardown reaches any surviving descendants. Runs AFTER
        the model program settled, so a program can re-trap SIGXCPU between
        this SIG_DFL and the kill only by running more code, which it no longer
        does. A program that tampers with this callable instead (see
        :func:`_make_cpu_enforcer` on why in-process state cannot be hidden)
        buys at most the remaining soft-to-hard gap: one more CPU second, after
        which the hard limit's SIGKILL lands with no handler possible.

        Checking at settle time rather than sampling mid-run is deliberate:
        both mid-run designs perturb the run they measure. A sampling thread
        cost 72 MiB of virtual address space in the child (8 MiB stack plus a
        64 MiB glibc per-thread malloc arena reservation; measured 30.23 MiB of
        mappings without it against 102.37 MiB with it), and ``RLIMIT_AS``
        counts reserved space, so it silently shrank every run's
        `addressSpaceMb`. A ``SIGALRM`` interval timer costs no mappings but
        makes the program's own syscalls return short under PEP 475 — measured
        a 64 MiB ``os.write`` returning 65536 — which corrupts fd-3 framing.
        The cost of checking only at settle time is that a descendant's CPU is
        detected after it is spent, not while it runs; the host's wall-clock
        ceiling bounds that interval, and a program that never reaps its child
        is bounded by the wall clock alone, since ``RUSAGE_CHILDREN`` counts
        only reaped descendants (verified: a still-running child contributes
        0.0).

        @param cpu_seconds The `cpuSeconds` budget the soft RLIMIT_CPU used.
        """

        own = getrusage(rusage_self)
        kids = getrusage(rusage_children)
        spent = own.ru_utime + own.ru_stime + kids.ru_utime + kids.ru_stime
        if spent >= cpu_seconds:
            set_signal(sigxcpu, sig_dfl)
            kill(getpid(), sigxcpu)

    return die_if_cpu_exhausted


_DIE_IF_CPU_EXHAUSTED = _make_cpu_enforcer()


_TRUNCATION_MARKER = "… [truncated]"

# The marker's own UTF-8 size, reserved out of the cap rather than added on top
# of it. Byte-identical to the host's TRUNCATION_MARKER_BYTES; the ellipsis is
# three bytes, so this is 15, not the string's 13 characters.
_TRUNCATION_MARKER_BYTES = len(_TRUNCATION_MARKER.encode("utf-8"))


def _cap_message(message: str, max_bytes: int) -> str:
    """Byte-cap a diagnostic, appending the same marker the host uses.

    Encoded with ``errors="replace"`` first: a model exception message can
    contain an unpaired surrogate (``raise Exception("\\ud800")``), and a
    strict encode would throw while BUILDING the failure frame — the run
    would then strand until the wall clock instead of reporting the
    exception. Then a UTF-8 slice with a trailing partial sequence dropped
    by ``errors="ignore"``; the marker text matches the host-side
    ``capMessage`` so a truncated diagnostic reads identically wherever the
    cap was applied.

    The marker's bytes come OUT of ``max_bytes``, so the returned string as a
    whole honors the cap; retaining a full cap of text and then appending the
    marker would exceed the bound this function enforces, and the host meters
    the same field again on arrival. A ``max_bytes`` below the marker's own
    size leaves no room for message text and yields the marker alone, so the
    true bound is ``max(max_bytes, 15)`` — reporting that truncation happened
    is worth those 15 bytes.
    """

    raw = message.encode("utf-8", errors="replace")
    if len(raw) <= max_bytes:
        return raw.decode("utf-8")
    budget = max(0, max_bytes - _TRUNCATION_MARKER_BYTES)
    return raw[:budget].decode("utf-8", errors="ignore") + _TRUNCATION_MARKER


# Fixed safety/liveness bound, not a tunable: a model can raise an exception
# with an arbitrarily deep __cause__/__context__ chain, and both the rendering
# walk and format() are linear in chain length. Capping how many links get
# RENDERED keeps traceback formatting from consuming the whole wall budget.
# 100 links is far beyond any legible human traceback.
_MAX_TRACEBACK_CHAIN = 100

# Diagnostic used when rendering the failure itself fails. Built from a fixed
# literal plus the exception CLASS name, never from the exception's own str.
_UNRENDERABLE_DIAGNOSTIC = "<diagnostic rendering failed>"


def _model_traceback(exc: BaseException, max_bytes: int) -> str:
    """Format a model-program failure with only the MODEL's own frames.

    Bootstrap frames carry host-absolute paths — meaningless to the model and
    unstable across machines, so transcripts pinning them cannot replay. They
    appear not only as a leading prefix (the bootstrap's ``exec``/``await``)
    but also interleaved and trailing: an uncaught binding rejection re-raised
    by ``dispatch`` puts bootstrap frames AFTER the model's, and chained
    ``__cause__``/``__context__`` exceptions carry their own stacks. Filter
    every non-``<model>`` frame across the whole chain rather than trimming a
    prefix. A failure with no model frame anywhere (e.g. a SyntaxError raised
    by ``compile``) keeps the standard exception-only rendering.

    Rendering is bounded to ``_MAX_TRACEBACK_CHAIN`` links, cut on the
    ``TracebackException`` COPY, and a marker line announces the truncation.
    Nothing here touches the live exception: an exception class overriding
    ``__setattr__`` would run MODEL code from inside the caller's failure
    handler, and a throw there costs the ``done`` frame (see
    ``_safe_model_traceback``). ``TracebackException`` instances hold no such
    hooks, so clearing their links runs no model code. The walk is iterative,
    so a deep chain cannot overflow the recursion limit.

    ``from_exception`` still copies the WHOLE live chain, at a higher per-link
    cost than building it took. That is bounded by the child's ``RLIMIT_AS``:
    the model must materialize every link (exception object plus traceback)
    before raising, so a chain long enough for the copy to matter is already
    near the address-space cap, and a ``MemoryError`` in the copy lands in the
    caller's fallback rather than stranding the run.
    """

    te = traceback.TracebackException.from_exception(exc)
    # One iterative pass over the copy does both jobs: keep only <model> frames
    # on every linked exception and group member, and cut the chain at the cap.
    found = False
    truncated = False
    pending = [(te, 1)]
    while pending:
        entry, depth = pending.pop()
        kept = [f for f in entry.stack if f.filename == "<model>"]
        entry.stack = traceback.StackSummary.from_list(kept)
        found = found or bool(kept)
        # 3.11+ exception groups (a binding failure inside asyncio.TaskGroup)
        # carry member stacks under `exceptions`, not the dunder links; a group
        # member counts as a link so the cap bounds nesting through both edges.
        members = getattr(entry, "exceptions", None) or ()
        if depth >= _MAX_TRACEBACK_CHAIN:
            if entry.__cause__ is not None or entry.__context__ is not None or members:
                truncated = True
            entry.__cause__ = None
            entry.__context__ = None
            if members:
                entry.exceptions = None
            continue
        for linked in (entry.__cause__, entry.__context__):
            if linked is not None:
                pending.append((linked, depth + 1))
        for member in members:
            pending.append((member, depth + 1))

    def emit():
        if found:
            yield from te.format()
        else:
            yield from traceback.format_exception_only(type(exc), exc)
        if truncated:
            yield f"[dsh-code-runtime-python] exception chain truncated at {_MAX_TRACEBACK_CHAIN} links\n"

    return _join_bounded(emit(), max_bytes)


def _make_failure_reporter() -> Any:
    """Build the failure-diagnostic renderer over closure-held primitives.

    The returned callable renders a model failure diagnostic that cannot itself
    raise. The caller sends the ``done`` frame AFTER its ``except BaseException``
    block, so anything thrown while rendering the diagnostic skips the send
    entirely: the host then blocks on fd 3 until ``maxWallMs`` and reports a
    timeout instead of the exception that actually happened. Rendering runs
    model code by design (``format()`` reaches ``__str__``, ``__repr__`` and
    ``__notes__``) and allocates under ``RLIMIT_AS``, so it must be treated as
    able to throw.

    The fallback names the exception CLASS and a fixed literal — no ``str(exc)``
    and no ``format_exception_only``, both of which reach the model's
    ``__str__``. A ``__name__`` that is not exactly ``str`` (a metaclass
    property can return anything, or raise) is discarded rather than
    formatted, so no override runs on this path either.

    The factory exists for the same reason :func:`_make_cpu_enforcer` does: this
    bootstrap IS ``__main__``, so ``import __main__; __main__._X = ...`` rebinds
    any module global a call-time lookup would read. On this path a rebind is
    worst — the handler's own reporter, and everything the reporter reaches,
    would run model code outside any guard, and a throw there costs the ``done``
    frame. The traceback formatter, the byte cap and the fallback literal
    therefore become closure cells captured at import time, before model code
    runs, and :func:`_run` binds the returned callable into a local of its own
    frame. A frame local is not a module attribute, so no assignment to
    ``__main__`` changes which callable runs or what it calls. This defeats the
    one-line rebind, not a determined ``sys._getframe`` walk; the unforgeable
    bound is the host wall clock.
    """

    cap_message = _cap_message
    model_traceback = _model_traceback
    unrenderable = _UNRENDERABLE_DIAGNOSTIC

    def safe_model_traceback(exc: BaseException, max_bytes: int) -> str:
        try:
            return cap_message(model_traceback(exc, max_bytes), max_bytes)
        except BaseException:  # noqa: BLE001 -- a throw here would cost the done frame
            pass
        try:
            raw_name = type(exc).__name__
            # Slice BEFORE interpolating. A metaclass `__name__` property can
            # return an arbitrarily long string, and both the f-string and
            # `cap_message`'s encode would copy it whole — under a tight
            # RLIMIT_AS either allocation can raise MemoryError, and this is the
            # LAST fallback, so a throw here costs the `done` frame outright and
            # the run misreports as an exit or a timeout. The slice is a
            # code-unit prefix, which bounds the bytes at 4x, and the following
            # `cap_message` still applies the exact byte cap.
            name = raw_name[:_MAX_FALLBACK_NAME_CHARS] if type(raw_name) is str else "<unknown>"
        except BaseException:  # noqa: BLE001 -- a raising __name__ must not cost the done frame
            name = "<unknown>"
        # Wrapped for the same reason: `cap_message` encodes, and its allocation
        # is the only step left that can still fail. The fixed literal needs no
        # budget, so it can always be delivered.
        try:
            return cap_message(f"{name}: {unrenderable}", max_bytes)
        except BaseException:  # noqa: BLE001 -- the done frame outranks the diagnostic's detail
            return unrenderable

    return safe_model_traceback


_SAFE_MODEL_TRACEBACK = _make_failure_reporter()


def _join_bounded(lines, max_bytes: int) -> str:
    """Join formatter output, stopping once the budget is comfortably passed.

    ``format()`` yields lines lazily; consuming it whole for an exception
    carrying a huge message would materialize the full text only for
    ``_cap_message`` to throw it away — enough over-shoot to exhaust
    ``RLIMIT_AS``. Stop after the accumulated CHARACTER count passes the byte
    budget (chars lower-bound UTF-8 bytes); the caller's ``_cap_message``
    does the exact byte-level cut.
    """

    chunks: list[str] = []
    total = 0
    for line in lines:
        # A single yielded line can itself dwarf the budget (the exception
        # message rides in one line): keep only the prefix it can ever need.
        if len(line) > max_bytes + 1:
            line = line[: max_bytes + 1]
        chunks.append(line)
        total += len(line)
        if total > max_bytes:
            break
    return "".join(chunks)


def _done_with_value(value: Any, max_value_bytes: int) -> dict[str, Any]:
    """Build the terminal done frame under the seam's lossless-JSON contract.

    A completion value returned by the program (``None`` when it returns
    nothing) that is not lossless JSON fails the run as ``invalid-output``; a
    serialized value beyond ``max_value_bytes`` fails as ``output-limit``.
    Substituting a ``repr`` or truncated string would be a silent lie about
    what the program computed, so both paths refuse instead (mirroring the
    worker backend's contract). ``None`` crosses as an exact JSON ``null``.
    """

    # One bounded walk folds the losslessness check and the byte meter (mirrors
    # the host's checkDoneValue): the former split ran the full losslessness
    # walk first, materializing one tuple per element for a wide completion
    # before the size cap could reject it — an RLIMIT_AS death on a value the
    # meter would have refused. send_sync later encodes the admitted value,
    # whose size the walk proved within budget. Iterative like the encoder, so a
    # valid completion deeper than the recursion limit still checks.
    rejection = _check_done_value(value, max_value_bytes)
    if rejection is not None:
        kind, message = rejection
        return {"type": "done", "error": {"kind": kind, "message": message}}
    return {"type": "done", "value": value}


def main() -> None:
    channel = ProtocolChannel(PROTOCOL_FD)
    asyncio.run(_run(channel))


if __name__ == "__main__":
    main()
