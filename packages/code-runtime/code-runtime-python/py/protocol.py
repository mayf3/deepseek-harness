"""Wire protocol vocabulary for the Python side of dsh-code-runtime-python.

Mirrors ``src/protocol.ts``. Frames travel on fd 3 as JSON-lines (one JSON
object per line). The host validates every inbound frame; this side trusts
host replies.
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict, Union

# The protocol fd from the child's perspective. Node passes
# ``stdio: [pipe, pipe, pipe, pipe]`` so the fourth entry (fd 3) is the
# framed-JSON channel; stdout/stderr stay clear for the program's own output.
PROTOCOL_FD = 3


class BootMessage(TypedDict):
    """Host → child, first frame on fd 3. Carries every cap and the namespaces."""

    type: Literal["boot"]
    cpuSeconds: int
    addressSpaceBytes: int
    maxLogBytes: int
    maxValueBytes: int
    namespaces: list["Namespace"]


class ErrorClass(TypedDict):
    """A namespace's program-visible exception class: rejected calls raise its
    instances carrying the failed member name on ``memberNameProperty``."""

    name: str
    memberNameProperty: str


class Namespace(TypedDict, total=False):
    """One binding namespace declaration: the global name, its function names,
    and an optional program-visible ``errorClass`` for rejected calls."""

    global_: str  # required; renamed on the wire: JSON field is ``global`` (Python keyword collision)
    names: list[str]  # required
    errorClass: ErrorClass  # optional — mirrors the TS `errorClass?`


class RunMessage(TypedDict):
    """Host → child, sent after ``boot-ack``. Carries only the program body."""

    type: Literal["run"]
    program: str


class BootAckMessage(TypedDict):
    """Child → host: resource limits applied, ready for the run message."""

    type: Literal["boot-ack"]


class CallMessage(TypedDict):
    """Child → host: one bridged binding call from the model program."""

    type: Literal["call"]
    id: int
    global_: str  # wire field is ``global``
    name: str
    args: Any


class LogMessage(TypedDict, total=False):
    """Child → host: one captured text chunk, streamed eagerly.

    ``truncated`` is set only on the frame that IS the child ledger's truncation
    marker (not program output), so the host stops capturing at the same point
    the child did — mirrors the TS `truncated?`.
    """

    type: Literal["log"]  # required
    text: str  # required
    truncated: bool  # optional


class DoneErrorField(TypedDict):
    """Child → host: the failure carried on a ``done`` frame. ``kind`` is one of
    the three the host validates; ``message`` is the traceback or diagnostic."""

    kind: Literal["exception", "invalid-output", "output-limit"]
    message: str


class DoneMessage(TypedDict, total=False):
    """Child → host: the program settled. ``value`` and ``error`` are optional per the TS mirror."""

    type: Literal["done"]  # required — TypedDict(total=False) allows this via a required subclass in Py 3.11+; MVP keeps it flat
    value: Any
    error: DoneErrorField


ChildToHost = Union[BootAckMessage, CallMessage, LogMessage, DoneMessage]


class ReplyOk(TypedDict):
    type: Literal["reply"]
    id: int
    ok: Literal[True]
    value: Any


class ReplyErr(TypedDict):
    type: Literal["reply"]
    id: int
    ok: Literal[False]
    message: str


ReplyMessage = Union[ReplyOk, ReplyErr]
HostToChild = ReplyMessage


def log_truncation_marker(max_bytes: int) -> str:
    """Return the in-band marker for a log ledger that exhausted its budget.

    Byte-identical text on both sides of the wire so a truncated run reads the
    same however the cap was hit.
    """

    return f"[dsh-code-runtime-python] log capture truncated at {max_bytes} bytes"
