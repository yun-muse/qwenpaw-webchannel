"""WebChannel frame builders/parser -- protocol/frames.md v1 (+ v2 files).

Pure stdlib only. Frame builders return plain dicts ready for
``json.dumps``; the relay forwards them verbatim.

Import note: this package may be imported as ``plugin.frames`` during
development/tests or as a top-level ``frames`` module by the QwenPaw plugin
loader, so imports fall back to absolute form.
"""

import json

try:  # package-relative (tests, ``python -m plugin...``)
    from .util import (
        CHUNK_RAW_BYTES,
        MAX_FILE_BYTES,
        TRANSFER_TTL_S,
        FileTransfers,
        RingBuffer,
        SeqCounter,
        StreamDiffer,
    )
except ImportError:  # loaded as a top-level module by the plugin loader
    from util import (
        CHUNK_RAW_BYTES,
        MAX_FILE_BYTES,
        TRANSFER_TTL_S,
        FileTransfers,
        RingBuffer,
        SeqCounter,
        StreamDiffer,
    )

__all__ = [
    "CHUNK_RAW_BYTES",
    "FileTransfers",
    "MAX_FILE_BYTES",
    "MAX_FRAME_BYTES",
    "RingBuffer",
    "SeqCounter",
    "StreamDiffer",
    "TRANSFER_TTL_S",
    "approval_frame",
    "check_size",
    "end_frame",
    "error_frame",
    "evt_frame",
    "file_error_frame",
    "file_ready_frame",
    "hist_frame",
    "model_changed_frame",
    "models_frame",
    "msg_frame",
    "parse_inbound",
    "resync_frame",
    "start_frame",
    "status_frame",
]

# 256 KB of serialized JSON, UTF-8. See protocol/frames.md section 5.
MAX_FRAME_BYTES = 256 * 1024


def _encoded_size(frame):
    """UTF-8 byte length of the serialized frame (compact separators)."""
    return len(
        json.dumps(frame, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    )


def check_size(frame):
    """True when *frame* fits the 256 KB wire limit, False otherwise.

    Size is measured exactly as the sender would put it on the wire (compact
    JSON, UTF-8); unserializable frames count as over the limit.
    """
    try:
        return _encoded_size(frame) <= MAX_FRAME_BYTES
    except (TypeError, ValueError):
        return False


def evt_frame(chat, seq, text, stream_type=None):
    """Per-delta streaming event: ``{t:"evt", chat, seq, data:{text, stream_type?}}``.

    *text* must be only the NEW suffix of the cumulative stream text (see
    ``util.StreamDiffer``); callers send nothing at all when it is empty.
    *stream_type* (``"reasoning"`` or ``"message"``) says which segment the
    delta belongs to; clients concatenate only ``"message"`` deltas into the
    answer. It is omitted (instead of defaulted) so legacy callers keep the
    original ``data`` shape.
    """
    data = {"text": text}
    if stream_type is not None:
        data["stream_type"] = stream_type
    return {
        "t": "evt",
        "chat": chat,
        "seq": seq,
        "data": data,
    }


def start_frame(chat, seq=None, stream_type=None):
    """Streaming segment starts: ``{t:"start", chat, seq?, stream_type?}``."""
    frame = {"t": "start", "chat": chat}
    if seq is not None:
        frame["seq"] = seq
    if stream_type is not None:
        frame["stream_type"] = stream_type
    return frame


def end_frame(chat, seq=None, stream_type=None):
    """Streaming segment finished: ``{t:"end", chat, seq?, stream_type?}``."""
    frame = {"t": "end", "chat": chat}
    if seq is not None:
        frame["seq"] = seq
    if stream_type is not None:
        frame["stream_type"] = stream_type
    return frame


def msg_frame(chat, seq, parts):
    """Complete message / tool result / attachment reference.

    ``{t:"msg", chat, seq, parts[]}`` where *parts* are content parts;
    v1 defines ``{"type":"text","text":...}`` and
    ``{"type":"file","name","mime","data"}`` (base64 *data*); other part
    types are forwarded as-is.
    """
    frame = {"t": "msg", "chat": chat, "parts": parts}
    if seq is not None:
        frame["seq"] = seq
    return frame


def approval_frame(chat, req_id, **kw):
    """Approval request: ``{t:"approval", chat, req_id, tool, severity, summary}``.

    Protocol fields ``tool`` / ``severity`` / ``summary`` (plus anything
    else the SPA should render) are passed as keyword arguments; ``seq``
    may be given the same way when the frame should be numbered.
    Reserved keys (``t`` / ``chat`` / ``req_id``) cannot be overridden.
    """
    frame = {"t": "approval", "chat": chat, "req_id": req_id}
    for key, value in kw.items():
        if key not in frame:
            frame[key] = value
    return frame


def resync_frame(chat, reason=None):
    """Ring-buffer miss: ``{t:"resync", chat, reason?}`` -- client reloads history."""
    frame = {"t": "resync", "chat": chat}
    if reason:
        frame["reason"] = reason
    return frame


def hist_frame(chat, messages, more=False, seq=None):
    """History reply: ``{t:"hist", chat, messages:[{role, text}...], more?}``.

    One frame carries as many messages as fit in the 256 KB limit; the caller
    adds ``more=True`` to every frame but the last (see ``util.pack_history``).
    ``seq`` is optional because history is a reply to a client request rather
    than part of the streaming sequence, yet the plugin still numbers it.
    """
    frame = {"t": "hist", "chat": chat, "messages": messages}
    if more:
        frame["more"] = True
    if seq is not None:
        frame["seq"] = seq
    return frame


def file_ready_frame(chat, transfer_id, seq=None):
    """Chunked upload staged: ``{t:"file_ready", chat, id}`` (+``seq``).

    Sent after ``file_end`` once the sha256 and size verified. The client may
    then reference the file as ``{ref: <id>}`` in a ``msg.files[]`` entry.
    """
    frame = {"t": "file_ready", "chat": chat, "id": transfer_id}
    if seq is not None:
        frame["seq"] = seq
    return frame


def file_error_frame(chat, transfer_id, code, msg="", seq=None):
    """Chunked upload failed: ``{t:"file_error", chat, id, code, msg?}``.

    *code* is ``E_CHECKSUM`` / ``E_TOOBIG`` / ``E_STATE``; *msg* is a short
    human-readable explanation and is omitted when empty.
    """
    frame = {"t": "file_error", "chat": chat, "id": transfer_id, "code": code}
    if msg:
        frame["msg"] = msg
    if seq is not None:
        frame["seq"] = seq
    return frame


def error_frame(code, detail=""):
    """Protocol error: ``{t:"error", code, ...}`` (protocol/frames.md section 6).

    ``detail`` is a locally useful human-readable string and is omitted when
    empty; the ``id`` of the offending frame may be added by callers that
    have one.
    """
    frame = {"t": "error", "code": code}
    if detail:
        frame["detail"] = detail
    return frame


# ---------------------------------------------------------------------------
# M7 -- control frames (protocol/frames.md section 9)
#
# ``models`` / ``model_changed`` / ``status`` are sent WITHOUT ``seq``: they
# belong to no chat stream, so they are never ring-buffered or replayed.
# ---------------------------------------------------------------------------


def models_frame(items):
    """Model list reply: ``{t:"models", items:[{provider, model, active}]}``.

    *items* is passed through exactly as built by ``util.model_items`` -- the
    plugin's projection of ``ProviderInfo``, which never carries credentials.
    """
    return {"t": "models", "items": items}


def model_changed_frame(provider, model):
    """A ``set_model`` succeeded: ``{t:"model_changed", provider, model}``.

    The pair is the agent's active model from now on (the app's answer when it
    normalised the ids, else the requested pair).
    """
    return {"t": "model_changed", "provider": provider, "model": model}


def status_frame(agent_name, provider=None, model=None):
    """Identity push: ``{t:"status", agent_name, provider?, model?}``.

    Sent when the agent attaches and whenever a client joins/leaves; the header
    displays it. ``provider`` / ``model`` are omitted unless they are non-empty
    strings, so an unknown active model degrades to the name alone.
    """
    frame = {"t": "status", "agent_name": agent_name}
    if isinstance(provider, str) and provider:
        frame["provider"] = provider
    if isinstance(model, str) and model:
        frame["model"] = model
    return frame


def parse_inbound(raw):
    """Parse one inbound WebSocket text/binary message.

    Returns:
        dict: the frame when *raw* is JSON for an object holding a string
        ``"t"`` field.
        None: otherwise (not JSON, not an object, missing/non-string ``t``,
        undecodable bytes); invalid frames are dropped per ``E_BADFRAME``.
    """
    if isinstance(raw, (bytes, bytearray)):
        try:
            raw = bytes(raw).decode("utf-8")
        except UnicodeDecodeError:
            return None
    if not isinstance(raw, str):
        return None

    try:
        frame = json.loads(raw)
    except (ValueError, TypeError):
        return None

    if not isinstance(frame, dict):
        return None
    if not isinstance(frame.get("t"), str):
        return None
    return frame
