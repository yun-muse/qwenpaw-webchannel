"""WebChannel frame builders/parser -- protocol/frames.md v1 (+ v2 files, v6 export).

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
        PROMPT_FILES,
        TRANSFER_TTL_S,
        FileTransfers,
        RingBuffer,
        SeqCounter,
        StreamDiffer,
        extract_skill_items,
        extract_web_chats,
    )
except ImportError:  # loaded as a top-level module by the plugin loader
    from util import (
        CHUNK_RAW_BYTES,
        MAX_FILE_BYTES,
        PROMPT_FILES,
        TRANSFER_TTL_S,
        FileTransfers,
        RingBuffer,
        SeqCounter,
        StreamDiffer,
        extract_skill_items,
        extract_web_chats,
    )

__all__ = [
    "CHUNK_RAW_BYTES",
    "FileTransfers",
    "MAX_FILE_BYTES",
    "MAX_FRAME_BYTES",
    "PROMPT_FILES",
    "RingBuffer",
    "SeqCounter",
    "StreamDiffer",
    "TRANSFER_TTL_S",
    "approval_frame",
    "chat_deleted_frame",
    "chat_renamed_frame",
    "chats_frame",
    "check_size",
    "effort_frame",
    "end_frame",
    "error_frame",
    "evt_frame",
    "export_begin_frame",
    "export_chunk_frame",
    "export_end_frame",
    "extract_skill_items",
    "extract_web_chats",
    "file_error_frame",
    "file_ready_frame",
    "hist_frame",
    "model_changed_frame",
    "models_frame",
    "msg_frame",
    "parse_inbound",
    "prompt_saved_frame",
    "prompts_frame",
    "resync_frame",
    "skills_frame",
    "start_frame",
    "status_frame",
    "usage_frame",
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


# ---------------------------------------------------------------------------
# M12 -- conversation export (protocol/frames.md section 12)
#
# ``export_begin`` / ``export_chunk`` / ``export_end`` are control frames:
# no ``seq``, never ring-buffered, never replayed on ``resume``.
# ---------------------------------------------------------------------------


def export_begin_frame(chat, export_id, size, chunks, sha256):
    """Export snapshot: ``{t:"export_begin", chat, id, bytes, chunks, sha256}``.

    *size* is the exact UTF-8 byte length of the whole Markdown document,
    *chunks* the number of ``export_chunk`` frames that follow and *sha256*
    its lower-case hex digest. Sent only after the document is complete and
    inside the 10 MB limit, so a failed export never emits a partial stream.
    """
    return {
        "t": "export_begin",
        "chat": chat,
        "id": export_id,
        "bytes": size,
        "chunks": chunks,
        "sha256": sha256,
    }


def export_chunk_frame(chat, export_id, index, data):
    """One export chunk: ``{t:"export_chunk", chat, id, i, data}``.

    *data* is base64 of at most ``CHUNK_RAW_BYTES`` raw bytes; chunks are a
    pure byte-stream split and never cut a UTF-8 code point.
    """
    return {
        "t": "export_chunk",
        "chat": chat,
        "id": export_id,
        "i": index,
        "data": data,
    }


def export_end_frame(chat, export_id):
    """Export finished: ``{t:"export_end", chat, id}`` (client verifies + saves)."""
    return {"t": "export_end", "chat": chat, "id": export_id}


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


def effort_frame(
    chat, level, effective_level=None, budget_tokens=None,
    supported=None, kind=None, model_key=None,
):
    """Session thinking effort: ``{t:"effort", chat, level, effective?, ...}``.

    ``level`` is the SPA vocabulary (``default|low|medium|high|max``), where
    ``default`` means "no session override" (QwenPaw's ``inherit``).
    ``effective`` is the server's resolved ``effective.level`` -- it may be a
    value the SPA does not offer (``budget``, ``off``, ...). ``budget_tokens``
    is added for budget-mode preferences, ``supported`` lists the selectable
    SPA levels (``default`` is never listed because it is always legal), and
    ``kind`` / ``model_key`` are the server's control kind and
    ``provider:model`` key. Like the M7 control frames this one carries no
    ``seq``.
    """
    frame = {
        "t": "effort",
        "chat": chat,
        "level": level,
        "effective": level if effective_level is None else effective_level,
    }
    if budget_tokens is not None:
        frame["budget_tokens"] = budget_tokens
    if supported is not None:
        frame["supported"] = list(supported)
    if kind:
        frame["kind"] = kind
    if model_key:
        frame["model_key"] = model_key
    return frame


def chats_frame(items):
    """Server-side chat list reply: ``{t:"chats", items:[{chat, title, updated_at}]}``."""
    return {"t": "chats", "items": items}


def chat_deleted_frame(chat):
    """Chat deletion confirmation: ``{t:"chat_deleted", chat}``."""
    return {"t": "chat_deleted", "chat": chat}


def chat_renamed_frame(chat, title):
    """Chat rename confirmation: ``{t:"chat_renamed", chat, title}``."""
    return {"t": "chat_renamed", "chat": chat, "title": title}


def prompts_frame(files_dict):
    """Workspace prompt files reply: ``{t:"prompts", files:{name: content}}``."""
    return {"t": "prompts", "files": files_dict}


def prompt_saved_frame(filename):
    """Workspace prompt file saved confirmation: ``{t:"prompt_saved", file}``."""
    return {"t": "prompt_saved", "file": filename}


def skills_frame(items):
    """Available skills reply: ``{t:"skills", items:[{id, name, description}]}``."""
    return {"t": "skills", "items": items}


def usage_frame(
    chat, req_id=None, input_total=None, output_total=None,
    context_tokens=None, context_limit=None,
):
    """Session usage: ``{t:"usage", chat, id?, input_total?, ...}`` (M11).

    Every numeric field is optional and only appears when the data source
    actually provided it -- a missing field means "unknown", never 0. The
    handler always answers, so an empty frame (``{"t":"usage","chat":...}``)
    is the documented "no data" reply. ``id`` echoes the requesting frame's
    envelope id when it had one. Like the other control frames this one is
    sent without ``seq`` (see protocol/frames.md §11).
    """
    frame = {"t": "usage", "chat": chat}
    if isinstance(req_id, str) and req_id:
        frame["id"] = req_id
    for key, value in (
        ("input_total", input_total),
        ("output_total", output_total),
        ("context_tokens", context_tokens),
        ("context_limit", context_limit),
    ):
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            frame[key] = value
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
