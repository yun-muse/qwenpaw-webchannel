"""WebChannel frame builders/parser -- protocol/frames.md v1 (+ v2 files, v6 export, v7 search, v9 stats).

Pure stdlib only. Frame builders return plain dicts ready for
``json.dumps``; the relay forwards them verbatim.

Import note: this package may be imported as ``plugin.frames`` during
development/tests or as a top-level ``frames`` module by the QwenPaw plugin
loader, so imports fall back to absolute form.
"""

import datetime
import json

try:  # package-relative (tests, ``python -m plugin...``)
    from .util import (
        CHUNK_RAW_BYTES,
        MAX_FILE_BYTES,
        PROMPT_FILES,
        STATS_TOP_CHATS,
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
        STATS_TOP_CHATS,
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
    "STATS_TOP_CHATS",
    "SeqCounter",
    "StreamDiffer",
    "TRANSFER_TTL_S",
    "approval_frame",
    "att_begin_frame",
    "att_chunk_frame",
    "att_end_frame",
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
    "search_results_frame",
    "skills_frame",
    "start_frame",
    "stats_frame",
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


# ---------------------------------------------------------------------------
# M31 -- attachment retrieval (protocol/frames.md section 15)
#
# ``att_begin`` / ``att_chunk`` / ``att_end`` are control frames exactly like
# the export stream: no ``seq``, never ring-buffered, never replayed.
# ---------------------------------------------------------------------------


def att_begin_frame(chat, att_id, size, chunks, sha256, name, mime=""):
    """Attachment snapshot: ``{t:"att_begin", chat, id, bytes, chunks, sha256, name, mime?}``.

    *size* is the exact byte length of the file, *chunks* the number of
    ``att_chunk`` frames that follow and *sha256* its lower-case hex digest.
    *name* is the bare display name; *mime* is omitted when unknown. Sent only
    after the file passed every check (exists, inside the media directory,
    within the 10 MB limit), so a refused request never emits a partial stream.
    """
    frame = {
        "t": "att_begin",
        "chat": chat,
        "id": att_id,
        "bytes": size,
        "chunks": chunks,
        "sha256": sha256,
        "name": name,
    }
    if mime:
        frame["mime"] = mime
    return frame


def att_chunk_frame(chat, att_id, index, data):
    """One attachment chunk: ``{t:"att_chunk", chat, id, i, data}``.

    *data* is base64 of at most ``CHUNK_RAW_BYTES`` raw bytes; chunks are a
    pure byte-stream split (binary safe).
    """
    return {
        "t": "att_chunk",
        "chat": chat,
        "id": att_id,
        "i": index,
        "data": data,
    }


def att_end_frame(chat, att_id):
    """Attachment finished: ``{t:"att_end", chat, id}`` (client verifies)."""
    return {"t": "att_end", "chat": chat, "id": att_id}


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
    context_tokens=None, context_limit=None, last_turn=None,
):
    """Session usage: ``{t:"usage", chat, id?, input_total?, ...}`` (M11/M15).

    Every numeric field is optional and only appears when the data source
    actually provided it -- a missing field means "unknown", never 0. The
    handler always answers, so an empty frame (``{"t":"usage","chat":...}``)
    is the documented "no data" reply. ``id`` echoes the requesting frame's
    envelope id when it had one. ``last_turn`` (M15) is the newest assistant
    reply's receipt, in the same shape as ``hist``'s ``turn``; it is omitted
    when the newest reply has no usable usage. Like the other control frames
    this one is sent without ``seq`` (see protocol/frames.md §11).
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
    if isinstance(last_turn, dict) and last_turn:
        frame["last_turn"] = last_turn
    return frame


def _stats_count(value):
    """Non-negative int for one stats field, else ``None``."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value >= 0:
        return value
    return None


def _stats_cache(raw):
    """Validated cache group of one stats row, or ``None``.

    All three integer sums must be present and consistent
    (``cache_hit + cache_miss == cache_eligible > 0``). ``cache_hit_rate`` is
    **recomputed** from them, so a per-turn average can never reach the wire;
    a sent rate is advisory only. An incomplete or contradictory group is
    dropped whole -- "the provider did not report cache usage" must stay
    absent, never become 0% (protocol/frames.md §14.5).
    """
    if not isinstance(raw, dict):
        return None
    hit = _stats_count(raw.get("cache_hit"))
    miss = _stats_count(raw.get("cache_miss"))
    eligible = _stats_count(raw.get("cache_eligible"))
    if hit is None or miss is None or eligible is None:
        return None
    if eligible <= 0 or hit + miss != eligible:
        return None
    return {
        "cache_hit": hit,
        "cache_miss": miss,
        "cache_eligible": eligible,
        "cache_hit_rate": round(hit / eligible * 100, 2),
    }


def _stats_totals(raw):
    """Cleaned ``{turns, input?, output?, cache_*?}`` object, or ``None``."""
    if not isinstance(raw, dict):
        return None
    cleaned = {}
    turns = _stats_count(raw.get("turns"))
    if turns is not None:
        cleaned["turns"] = turns
    for key in ("input", "output"):
        value = _stats_count(raw.get(key))
        if value is not None:
            cleaned[key] = value
    cache = _stats_cache(raw)
    if cache is not None:
        cleaned.update(cache)
    return cleaned or None


def _stats_models(raw):
    """Cleaned, ``input``-descending ``by_model`` rows, or ``None``.

    A row without a non-empty ``model`` or a ``turns`` count is dropped; the
    unknown-model bucket arrives as the literal ``未知模型`` from
    ``util.STATS_UNKNOWN_MODEL`` and is kept like any other row.
    """
    if not isinstance(raw, (list, tuple)):
        return None
    rows = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        model = item.get("model")
        if not isinstance(model, str) or not model.strip():
            continue
        turns = _stats_count(item.get("turns"))
        if turns is None:
            continue
        row = {"model": model.strip(), "turns": turns}
        provider = item.get("provider")
        if isinstance(provider, str) and provider.strip():
            row["provider"] = provider.strip()
        for key in ("input", "output"):
            value = _stats_count(item.get(key))
            if value is not None:
                row[key] = value
        cache = _stats_cache(item)
        if cache is not None:
            row.update(cache)
        rows.append(row)
    rows.sort(key=_stats_model_rank)
    return rows


def _stats_model_rank(row):
    """Contract order of ``by_model``: input desc, turns desc, model, provider."""
    return (
        -(row.get("input") or 0),
        -row["turns"],
        row["model"],
        row.get("provider") or "",
    )


def stats_frame(
    req_id=None, totals=None, days=None, chats=None, covered_chats=None,
    uncovered_chats=None, undated_turns=None, day_tz=None, by_model=None,
):
    """All-chats usage dashboard: ``{t:"stats", id?, totals, days[], chats[]}``.

    A **control frame** like ``usage``: no ``seq``, never ring-buffered and
    never replayed on ``resume`` (protocol/frames.md §14). The payload is a
    summary of every chat that has usable persisted turns:

    - ``totals`` — ``{turns, input?, output?}`` plus, when at least one turn
      reported cache usage, ``{cache_hit, cache_miss, cache_eligible,
      cache_hit_rate}``. A missing token side means "no turn recorded it",
      never 0.
    - ``by_model`` — ``[{provider?, model, turns, input?, output?, cache_*?}]``
      sorted by ``input`` descending, including the ``未知模型`` bucket so
      the rows sum to the totals (§14.6).
    - ``covered_chats`` — how many chats contribute to the numbers (a real 0
      when there is no data yet).
    - ``uncovered_chats`` — known web chats with no usable data. Omitted when
      the server chat list could not be read: unknown is not 0.
    - ``days`` — ``[{date, turns, input?, output?, cache_*?}]`` ascending by
      ISO date, bucketed by the **container's local calendar day**
      (``created_at`` is a naive local wall clock).
    - ``chats`` — top chats by recorded tokens, capped at
      ``STATS_TOP_CHATS``; ``title`` appears only when the chat list resolved
      one.
    - ``undated_turns`` — present only when some counted turn had no usable
      timestamp; those turns are in the totals but not in ``days``.

    Every malformed field is dropped rather than sent as a placeholder; the
    handler always answers, so ``{"t":"stats"}`` is the documented "nothing
    to report" reply.
    """
    frame = {"t": "stats", "day_basis": "container-local"}
    if isinstance(req_id, str) and req_id:
        frame["id"] = req_id

    cleaned_totals = _stats_totals(totals)
    if cleaned_totals is not None:
        frame["totals"] = cleaned_totals

    cleaned_models = _stats_models(by_model)
    if cleaned_models is not None:
        frame["by_model"] = cleaned_models

    if isinstance(days, (list, tuple)):
        cleaned_days = []
        for raw in days:
            if not isinstance(raw, dict):
                continue
            date = raw.get("date")
            if not isinstance(date, str):
                continue
            try:
                datetime.date.fromisoformat(date)
            except ValueError:
                continue
            item = {"date": date}
            turns = _stats_count(raw.get("turns"))
            if turns is not None:
                item["turns"] = turns
            for key in ("input", "output"):
                value = _stats_count(raw.get(key))
                if value is not None:
                    item[key] = value
            cache = _stats_cache(raw)
            if cache is not None:
                item.update(cache)
            cleaned_days.append(item)
        frame["days"] = cleaned_days

    if isinstance(chats, (list, tuple)):
        cleaned_chats = []
        for raw in list(chats)[:STATS_TOP_CHATS]:
            if not isinstance(raw, dict):
                continue
            chat = raw.get("chat")
            if not isinstance(chat, str) or not chat:
                continue
            item = {"chat": chat}
            title = raw.get("title")
            if isinstance(title, str) and title.strip():
                item["title"] = title.strip()
            turns = _stats_count(raw.get("turns"))
            if turns is not None:
                item["turns"] = turns
            for key in ("input", "output"):
                value = _stats_count(raw.get(key))
                if value is not None:
                    item[key] = value
            cleaned_chats.append(item)
        frame["chats"] = cleaned_chats

    for key, value, allow_zero in (
        ("covered_chats", covered_chats, True),
        ("uncovered_chats", uncovered_chats, True),
        ("undated_turns", undated_turns, False),
    ):
        count = _stats_count(value)
        if count is None:
            continue
        if count == 0 and not allow_zero:
            continue
        frame[key] = count

    if isinstance(day_tz, str) and day_tz.strip():
        frame["day_tz"] = day_tz.strip()
    return frame


def search_results_frame(req_id, query, items, total):
    """Archive search reply: ``{t:"search_results", id, q, items, total}`` (M13).

    ``id`` echoes the requesting ``search`` frame's envelope id (the same
    correlation field the export/effort replies use), ``q`` the normalised
    query the hits were found for, ``items`` the page of hits and ``total``
    the overall match count. Like the other control frames this one carries
    no ``seq`` (see protocol/frames.md §13).
    """
    return {
        "t": "search_results",
        "id": req_id,
        "q": query,
        "items": items,
        "total": total,
    }


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
