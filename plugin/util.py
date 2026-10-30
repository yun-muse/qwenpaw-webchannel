"""Pure-stdlib helpers shared by the WebChannel plugin.

No third-party or QwenPaw imports: this module is deliberately standalone so
it can be unit-tested without the host application installed.
"""

import base64
import binascii
import datetime
import hashlib
import json
import math
import mimetypes
import os
import secrets
import threading
from collections import deque
from pathlib import Path
from urllib.parse import unquote, urlsplit

# Protocol §2.4 ``hist`` frames carry at most the last 50 messages unless the
# client asks for another count.
DEFAULT_HIST_LIMIT = 50


class StreamDiffer:
    """Turn cumulative streaming text into per-delta suffixes.

    QwenPaw's ``on_streaming_delta`` hook receives ALL text accumulated so
    far for a stream, not just the newest chunk (docs/source-notes.md Q1).
    The WebChannel protocol carries per-delta text, so each call is diffed
    against the previously seen accumulated value for the same key
    (typically ``"<chat>:<stream_type>"``).
    """

    def __init__(self):
        self._prev = {}

    def diff(self, key, accumulated):
        """Return only the text not yet sent for *key*.

        - ``""`` when *accumulated* adds nothing new (unchanged value).
        - the new suffix ``accumulated[len(prev):]`` when *accumulated*
          extends the stored value (this also absorbs coalesced jumps,
          where BaseChannel skipped intermediate flushes and the cumulative
          text grew by several chunks at once).
        - the whole *accumulated* when the stored value is no longer a
          prefix (segment replaced, e.g. a content-index change we never
          saw a start frame for).

        The first sight of a key behaves as if an empty value was stored.
        """
        if not isinstance(accumulated, str):
            accumulated = "" if accumulated is None else str(accumulated)

        prev = self._prev.get(key, "")
        if accumulated == prev:
            return ""

        if accumulated.startswith(prev):
            new = accumulated[len(prev):]
        else:
            # Segment replaced: cannot be expressed as a suffix, resend all.
            new = accumulated

        self._prev[key] = accumulated
        return new

    def last(self, key):
        """Full accumulated text last seen for *key* (``""`` when unknown)."""
        return self._prev.get(key, "")

    def reset(self, key):
        """Forget the stored text for one key (start of a new segment)."""
        self._prev.pop(key, None)

    def clear(self):
        """Forget every key."""
        self._prev.clear()


class SeqCounter:
    """Per-chat monotonically increasing outbound sequence numbers, starting at 1."""

    def __init__(self):
        self._seqs = {}

    def next(self, chat):
        """Next ``seq`` for *chat* (1, 2, 3, ...)."""
        seq = self._seqs.get(chat, 0) + 1
        self._seqs[chat] = seq
        return seq

    def peek(self, chat):
        """Last handed-out ``seq`` for *chat* (0 if none yet); does not advance."""
        return self._seqs.get(chat, 0)


class RingBuffer:
    """Per-chat replay buffer supporting ``resume`` (protocol/frames.md section 4).

    Holds the *maxlen* most recent ``(seq, frame)`` pairs per chat.
    """

    def __init__(self, maxlen=400):
        self.maxlen = maxlen
        self._frames = {}

    def append(self, chat, seq, frame):
        """Store one outbound frame for *chat* (oldest evicted beyond maxlen)."""
        buf = self._frames.get(chat)
        if buf is None:
            buf = deque(maxlen=self.maxlen)
            self._frames[chat] = buf
        buf.append((seq, frame))

    def since(self, chat, last_seq):
        """Replay list for ``resume{chat, last_seq}``: frames with ``seq > last_seq``.

        Returns:
            list: frames to resend, oldest first. ``[]`` when the client is
            already caught up (``last_seq >= newest seq``).
            None: buffer miss -- ``last_seq`` is older than the oldest
            retained seq minus one, so a gap would remain between what the
            client has seen and what we can replay; the caller must send
            ``resync{chat}`` instead. An unknown/empty chat counts as
            caught-up only when ``last_seq == 0`` (nothing was ever buffered
            for it); any other ``last_seq`` without a buffer (e.g. container
            restart) is a miss.
        """
        buf = self._frames.get(chat)
        if not buf:
            return [] if last_seq == 0 else None

        oldest = buf[0][0]
        newest = buf[-1][0]

        if last_seq >= newest:
            return []
        if last_seq < oldest - 1:
            return None
        return [frame for seq, frame in buf if seq > last_seq]


# ---------------------------------------------------------------------------
# M2 decisions
# ---------------------------------------------------------------------------

# Stream types whose text is the user-visible answer. ``reasoning`` text is
# streamed as ``evt`` deltas but must never be echoed back as a ``msg``.
ANSWER_STREAM_TYPE = "message"


def trailing_msg_text(stream_type, streamed_text, text_sent):
    """Text for the A1 trailing ``msg`` frame, or ``""`` for none.

    QwenPaw's streaming path consumes the completed message event itself
    (``base.py::_on_stream_msg_end`` returns True), so ``send()`` never runs
    for a streamed reply and the browser would keep only the ``evt`` deltas.
    The plugin therefore closes a streamed answer with a full-text ``msg``
    *unless* a text ``msg`` was already delivered for that segment.

    Args:
        stream_type: ``"message"`` (the answer) or ``"reasoning"``.
        streamed_text: everything the differ saw for the segment.
        text_sent: True when ``send``/``send_content_parts`` already sent text
            for this chat in the current segment.
    """
    if text_sent or stream_type != ANSWER_STREAM_TYPE:
        return ""
    return streamed_text if isinstance(streamed_text, str) else ""


def hist_limit(value, default=DEFAULT_HIST_LIMIT):
    """Normalise an inbound ``hist.limit``: positive int, else *default*."""
    try:
        limit = int(value)
    except (TypeError, ValueError):
        return default
    return limit if limit > 0 else default


def _part_texts(content):
    """Yield the text of every text part in one message's ``content`` list."""
    if not isinstance(content, list):
        return
    for part in content:
        if isinstance(part, str):
            yield part
            continue
        if not isinstance(part, dict):
            continue
        if part.get("type") != "text":
            continue
        text = part.get("text")
        if isinstance(text, str) and text:
            yield text


def _history_turn_usage(message):
    """The ``qwenpaw_turn_usage`` dict of one raw ``Message``, or ``None``.

    Current 2.x converters copy the original ``Msg.metadata`` into the inner
    ``metadata.metadata``; older shapes keep the key on the outer metadata.
    Both are accepted, inner first.
    """
    metadata = message.get("metadata")
    if not isinstance(metadata, dict):
        return None
    inner = metadata.get("metadata")
    if isinstance(inner, dict):
        turn = inner.get(TURN_USAGE_META_KEY)
        if isinstance(turn, dict):
            return turn
    turn = metadata.get(TURN_USAGE_META_KEY)
    return turn if isinstance(turn, dict) else None


def _history_original_id(message):
    """The persisted ``Msg.id`` shared by every split segment, or ``""``."""
    metadata = message.get("metadata")
    if not isinstance(metadata, dict):
        return ""
    value = metadata.get("original_id")
    return value if isinstance(value, str) and value else ""


def _make_turn(turn_id, usage):
    """One ``turn`` receipt from a usage dict, or ``None`` without tokens.

    Missing fields are omitted, never zero-filled; ``estimated`` is written
    only when the source explicitly marked the usage as an estimate.

    No duration is included: QwenPaw's ``finished_at`` is stamped at the
    first ``REPLY_END`` of a reply, so the span against ``timestamp`` is
    always ~0 and does not measure the turn (M20 removed ``duration_ms``).
    """
    prompt = _token_count(usage.get("prompt_tokens"))
    completion = _token_count(usage.get("completion_tokens"))
    if prompt is None and completion is None:
        return None

    turn = {"id": turn_id}
    if prompt is not None:
        turn["input"] = prompt
    if completion is not None:
        turn["output"] = completion
    total = _token_count(usage.get("total_tokens"))
    if total is None and prompt is not None and completion is not None:
        total = prompt + completion
    if total is not None:
        turn["total"] = total
    if usage.get("estimated") is True:
        turn["estimated"] = True
    return turn


def _attach_history_turns(entries):
    """Attach one ``turn`` per persisted message to the *entries* projection.

    Every ``Message`` split from the same persisted ``Msg`` shares one
    ``metadata.original_id`` and repeats the same ``qwenpaw_turn_usage``. The
    receipt belongs to the group's last assistant text segment (the answer),
    never to reasoning/tool cards or to every split segment. A group with two
    different usages, or without a text anchor, gets no receipt.
    """
    groups = {}
    order = []
    for entry in entries:
        original_id = _history_original_id(entry["message"])
        if not original_id:
            continue
        bucket = groups.get(original_id)
        if bucket is None:
            bucket = groups[original_id] = []
            order.append(original_id)
        bucket.append(entry)

    for original_id in order:
        members = groups[original_id]
        usages = []
        for entry in members:
            turn_meta = _history_turn_usage(entry["message"])
            if turn_meta is None:
                continue
            usage = turn_meta.get("usage")
            if isinstance(usage, dict):
                usages.append(usage)
        if not usages or any(usage != usages[0] for usage in usages[1:]):
            continue

        anchor = None
        for entry in members:
            if entry["role"] != "assistant":
                continue
            if entry["type"] != "MESSAGE":
                continue
            if not entry["text"].strip():
                continue
            anchor = entry
        if anchor is None:
            continue

        turn = _make_turn(original_id, usages[0])
        if turn is not None:
            anchor["turn"] = turn


def _part_mime(part):
    """Declared MIME of one content part, or "" (never guessed here)."""
    for field in ("mime", "media_type", "content_type"):
        value = part.get(field)
        if not (isinstance(value, str) and value.strip()):
            continue
        mime = value.split(";", 1)[0].strip().lower()
        if "/" in mime:
            return mime
    return ""


def _data_url_mime(url):
    """Media type of a ``data:`` URL, or "" for any other URL."""
    if not (isinstance(url, str) and url.startswith("data:")):
        return ""
    header = url[5:].split(",", 1)[0]
    mime = header.split(";", 1)[0].strip().lower()
    return mime if "/" in mime else ""


def _part_url(part):
    """The attachment URL of one part (any URL field, else a data URL)."""
    for field in _ATTACHMENT_URL_FIELDS:
        value = part.get(field)
        if isinstance(value, str) and value:
            return value
    data = part.get("data")
    if isinstance(data, str) and data.startswith("data:"):
        return data
    return ""


def _local_attachment_path(url):
    """Filesystem path behind a local attachment URL, else None.

    Only absolute container paths and ``file:`` URLs are local. ``http(s)``,
    ``data:`` and relative values return None, so no caller can turn a URL
    into a fetch of something outside the agent's media directory.
    """
    if not (isinstance(url, str) and url):
        return None
    if url.startswith("data:"):
        return None
    if url.startswith("file:"):
        try:
            parsed = urlsplit(url)
        except ValueError:
            return None
        if parsed.netloc not in ("", "localhost"):
            return None
        path = unquote(parsed.path)
        return path if os.path.isabs(path) else None
    if "://" in url:
        return None
    return url if os.path.isabs(url) else None


def _attachment_size(url):
    """``os.stat`` size of a local attachment, or None (unknown, not 0)."""
    path = _local_attachment_path(url)
    if not path:
        return None
    try:
        stat = os.stat(path)
    except OSError:
        return None
    return stat.st_size if stat.st_size >= 0 else None


def _explicit_file_name(part):
    """True when the part itself names the file (not just its URL)."""
    for field in ("filename", "name"):
        value = part.get(field)
        if isinstance(value, str) and value.strip():
            return True
    return False


def _history_files(message):
    """Project one Message's attachment parts to ``[{name, mime?, size?, kind}]``.

    Uses the same attachment detection as the Markdown export
    (``_is_attachment`` / ``_attachment_name``, defined below -- Python
    resolves them at call time). Only the bare file name is published: an
    absolute container path or a data URL never leaves the plugin. ``mime``
    and ``size`` are omitted when unknown (never zero-filled, M11 rule).

    Parts are deduplicated by URL. G2-A sends an image as ``FileContent``
    followed by ``ImageContent`` with the same ``file_url``, so the two parts
    collapse into one entry that keeps ``kind="image"`` and the FileContent's
    original (non-uuid) name.

    Each returned dict also carries private ``_path`` / ``_url`` / ``_index``
    / ``_explicit`` keys for the channel (ref issuance); ``history_messages``
    strips them.
    """
    content = message.get("content")
    if not isinstance(content, list):
        return []

    files = []
    by_url = {}
    for index, part in enumerate(content):
        if isinstance(part, str) or not isinstance(part, dict):
            continue
        if not _is_attachment(part):
            continue

        url = _part_url(part)
        key = url or "part:%d" % index
        name = _attachment_name(part)
        mime = _part_mime(part) or _data_url_mime(url)
        if not mime:
            guessed, _encoding = mimetypes.guess_type(name)
            mime = (guessed or "").lower()
        is_image = (
            _part_type(part) == "image"
            or mime.startswith("image/")
            or (
                isinstance(part.get("image_url"), str)
                and bool(part.get("image_url"))
            )
        )
        size = _attachment_size(url)

        existing = by_url.get(key)
        if existing is not None:
            # Same file twice (G2-A): keep one entry, prefer the image kind
            # and the part that carried an explicit filename.
            if is_image:
                existing["kind"] = "image"
            if mime and not existing.get("mime"):
                existing["mime"] = mime
            if size is not None and "size" not in existing:
                existing["size"] = size
            if _explicit_file_name(part) and not existing["_explicit"]:
                existing["name"] = name
                existing["_explicit"] = True
            continue

        entry = {"name": name, "kind": "image" if is_image else "file"}
        if mime:
            entry["mime"] = mime
        if size is not None:
            entry["size"] = size
        entry["_path"] = _local_attachment_path(url) or ""
        entry["_url"] = url
        entry["_index"] = index
        entry["_explicit"] = _explicit_file_name(part)
        files.append(entry)
        by_url[key] = entry
    return files


def _hist_entries(raw_messages):
    """``_history_entries`` plus attachment-only messages (M31).

    ``_history_entries`` deliberately drops every message without text
    because turn receipts are anchored on assistant text. A pure attachment
    turn has no text at all and would vanish from ``hist``, so the history
    projection uses this superset instead. Turn anchoring itself is still
    computed on the old, text-only projection (see ``history_messages``), so
    adding attachments never changes which message owns a receipt.
    """
    entries = []
    if not isinstance(raw_messages, list):
        return entries
    for index, message in enumerate(raw_messages):
        if not isinstance(message, dict):
            continue
        text = "".join(_part_texts(message.get("content")))
        files = _history_files(message)
        if not text and not files:
            continue
        role = message.get("role")
        role = getattr(role, "value", role)
        entries.append({
            "role": str(role or ""),
            "text": text,
            "type": _message_type(message),
            "message": message,
            "index": index,
            "files": files,
        })
    return entries


def _project_history_files(files, message, ref_factory):
    """Public ``files[]`` of one message; private keys never cross the wire."""
    out = []
    msg_id = _history_original_id(message)
    for entry in files or []:
        item = {"name": entry["name"], "kind": entry["kind"]}
        if entry.get("mime"):
            item["mime"] = entry["mime"]
        if "size" in entry:
            item["size"] = entry["size"]
        if ref_factory is not None and entry.get("_path"):
            try:
                ref = ref_factory(
                    entry["_path"], msg_id, entry.get("_index", 0),
                    entry["name"], entry.get("mime", ""),
                    entry.get("_url", ""),
                )
            except Exception:  # noqa: BLE001 - a ref is best effort
                ref = None
            if isinstance(ref, str) and ref:
                item["ref"] = ref
        out.append(item)
    return out


def history_messages(history, limit=DEFAULT_HIST_LIMIT, ref_factory=None):
    """Extract ``[{role, text, files?, turn?}]`` from ``ChatHistory``.

    ``GET /api/chats/{id}`` answers ``{messages: [Message...], status}`` where
    every ``Message`` (qwenpaw.schemas) is ``{role, content: [parts]...}``.
    Text parts of one message are concatenated. A message with no text is
    kept when it carries an attachment (M31): a pure attachment turn is a
    real user turn and must not disappear from history. Messages with neither
    text nor attachments (tool calls, empty turns) are skipped.

    ``files`` lists attachment metadata, deduplicated by URL and never a
    path. *ref_factory*, when given, is called as
    ``(path, msg_id, part_index, name, mime)`` for every file that lives on
    the container filesystem; its return value becomes ``ref`` (G3). The
    factory belongs to the channel and is what keeps raw paths out of the
    wire format.

    Each persisted ``Msg`` becomes one or more ``Message`` segments sharing
    ``metadata.original_id``. Its per-turn usage is attached once, as
    ``turn``, to the group's last assistant text segment (M15); the anchor
    rules are computed on the text-only projection, so attachments can never
    move a receipt. Turns are attached to the full projection first and only
    then truncated, so a receipt survives a window that starts inside its
    turn.
    """
    if not isinstance(history, dict):
        return []
    raw = history.get("messages")
    if not isinstance(raw, list):
        return []

    # Turn anchoring: exactly the old, text-only rule.
    text_entries = _history_entries(raw)
    _attach_history_turns(text_entries)
    turns = {
        entry["index"]: entry["turn"]
        for entry in text_entries
        if "turn" in entry
    }

    entries = _hist_entries(raw)
    for entry in entries:
        if entry["index"] in turns:
            entry["turn"] = turns[entry["index"]]

    limit = hist_limit(limit)
    messages = []
    for entry in entries[-limit:]:
        projected = {"role": entry["role"], "text": entry["text"]}
        files = _project_history_files(
            entry["files"], entry["message"], ref_factory,
        )
        if files:
            projected["files"] = files
        if "turn" in entry:
            projected["turn"] = entry["turn"]
        messages.append(projected)
    return messages


def _history_entries(raw_messages):
    """Project raw ``ChatHistory.messages`` to ``{role, text, type, ...}``.

    One entry per message that carries text; ``index`` points back at the raw
    list so callers that render the original messages can find the turn
    anchor again. Shared by ``hist`` and the Markdown export so both derive
    per-turn receipts from exactly the same rules.
    """
    entries = []
    if not isinstance(raw_messages, list):
        return entries
    for index, message in enumerate(raw_messages):
        if not isinstance(message, dict):
            continue
        text = "".join(_part_texts(message.get("content")))
        if not text:
            continue
        role = message.get("role")
        role = getattr(role, "value", role)
        entries.append({
            "role": str(role or ""),
            "text": text,
            "type": _message_type(message),
            "message": message,
            "index": index,
        })
    return entries


def pack_history(messages, fits):
    """Group *messages* in order into chunks where ``fits(chunk)`` is True.

    Used to keep every ``hist`` frame within the 256 KB wire limit: *fits* is
    called with the candidate chunk (and is expected to measure the real
    serialized frame). Order and content are preserved; a single message that
    cannot fit on its own still becomes its own chunk so the caller decides.
    """
    chunks = []
    current = []
    for message in messages:
        candidate = current + [message]
        if current and not fits(candidate):
            chunks.append(current)
            current = [message]
        else:
            current = candidate
    if current:
        chunks.append(current)
    return chunks


def decode_file_entry(entry):
    """Decode one inbound ``msg.files[]`` item to ``(name, mime, data)``.

    Returns None when the item is not a dict, carries no base64 ``data``
    string, or that string is not valid (or non-empty) base64.
    """
    if not isinstance(entry, dict):
        return None

    name = entry.get("name")
    name = name.strip() if isinstance(name, str) and name.strip() else "file"
    mime = entry.get("mime")
    if not (isinstance(mime, str) and mime.strip()):
        mime = "application/octet-stream"

    raw = entry.get("data")
    if not isinstance(raw, str):
        return None
    compact = "".join(raw.split())
    if not compact:
        return None
    try:
        data = base64.b64decode(compact, validate=True)
    except (binascii.Error, ValueError):
        return None
    if not data:
        return None
    return name, mime, data


def approval_owner_ok(pending, agent_id):
    """True when pending approval *pending* belongs to *agent_id*.

    ``GET /api/approval/list`` entries carry ``owner_agent_id`` (the agent that
    owns the run) and ``agent_id`` (the executing agent). The first present one
    decides; when neither is present the request is accepted on presence alone
    (A5: keep it simple). A missing entry (``None``, e.g. not found or the list
    call failed) is never accepted.
    """
    if not isinstance(pending, dict):
        return False
    for field in ("owner_agent_id", "agent_id"):
        owner = pending.get(field)
        if owner:
            return str(owner) == str(agent_id)
    return True


# ---------------------------------------------------------------------------
# M5 / protocol v2 -- chunked file transfer
# ---------------------------------------------------------------------------

# One file may be far larger than the 256 KB frame budget when it travels in
# ``file_chunk`` frames; both ends enforce this ceiling.
MAX_FILE_BYTES = 10 * 1024 * 1024
# Raw bytes per ``file_chunk`` (96 KB -> ~128 KB of base64, well inside a
# 256 KB frame).
CHUNK_RAW_BYTES = 96 * 1024
# Staged files and half-received transfers expire after 10 minutes.
TRANSFER_TTL_S = 600

_DEFAULT_FILE_NAME = "file"
_DEFAULT_FILE_MIME = "application/octet-stream"


def _is_int(value):
    """True for a JSON integer; booleans do not count as sizes/counters."""
    return isinstance(value, int) and not isinstance(value, bool)


def _file_name(meta):
    """``meta.name`` defaulted exactly like ``decode_file_entry``."""
    name = meta.get("name")
    if isinstance(name, str) and name.strip():
        return name.strip()
    return _DEFAULT_FILE_NAME


def _file_mime(meta):
    """``meta.mime`` defaulted exactly like ``decode_file_entry``."""
    mime = meta.get("mime")
    if not (isinstance(mime, str) and mime.strip()):
        return _DEFAULT_FILE_MIME
    return mime


def _decode_chunk(raw):
    """Raw bytes of one base64 ``file_chunk.data``; None when invalid."""
    if not isinstance(raw, str):
        return None
    compact = "".join(raw.split())
    try:
        return base64.b64decode(compact, validate=True)
    except (binascii.Error, ValueError):
        return None


class FileTransfers:
    """In-progress chunked uploads plus the staged (consumable) files.

    Protocol v2 (``protocol/frames.md`` section 8): the browser splits a file
    into ``file_chunk`` frames after a ``file_begin`` and closes with a
    ``file_end``; the assembled bytes are verified against the declared size
    and sha256, then staged until a ``msg.files[].ref`` consumes them.

    Every method takes an explicit *now* (float seconds, ``time.monotonic()``
    in the channel) so tests control expiry. Expiry is lazy: ``begin`` /
    ``chunk`` / ``end`` / ``take`` treat an entry older than
    ``TRANSFER_TTL_S`` as absent, and ``purge`` reclaims them eagerly.

    Memory is bounded: the received chunks of one transfer never hold more
    than ``MAX_FILE_BYTES`` (a ``file_chunk`` that would cross the limit is
    rejected with ``E_TOOBIG`` and drops the transfer).
    """

    def __init__(self):
        # id -> {name, mime, size, chunks, sha256, started, received, bytes}
        self._active = {}
        # id -> {name, mime, data, staged}
        self._staged = {}

    def begin(self, tid, meta, now):
        """Start (or restart) the transfer *tid* from a ``file_begin`` frame.

        Returns ``(ok, code)``: ``(True, None)`` when the declared metadata is
        usable, else ``(False, "E_TOOBIG" | "E_STATE")``. A ``begin`` for an
        id that already exists -- in progress or staged -- discards that state
        and starts over, which is what makes the client's whole-file retry
        (same id, after ``E_CHECKSUM``) work.
        """
        if not isinstance(meta, dict):
            meta = {}

        size = meta.get("size")
        if _is_int(size) and size > MAX_FILE_BYTES:
            return False, "E_TOOBIG"
        if not (_is_int(size) and 0 < size <= MAX_FILE_BYTES):
            return False, "E_STATE"

        chunks = meta.get("chunks")
        if not (_is_int(chunks) and chunks >= 1):
            return False, "E_STATE"

        digest = meta.get("sha256")
        if not (
            isinstance(digest, str)
            and len(digest) == 64
            and all(char in "0123456789abcdefABCDEF" for char in digest)
        ):
            return False, "E_STATE"

        self._active.pop(tid, None)
        self._staged.pop(tid, None)
        self._active[tid] = {
            "name": _file_name(meta),
            "mime": _file_mime(meta),
            "size": size,
            "chunks": chunks,
            "sha256": digest.lower(),
            "started": now,
            "received": {},
            "bytes": 0,
        }
        return True, None

    def chunk(self, tid, index, data_b64, now):
        """Store one ``file_chunk`` payload; ``(ok, code)``.

        A bad index or payload drops the whole transfer (``E_STATE``): the
        stream can no longer be trusted. A repeated index overwrites (last
        wins), so identical retransmits are harmless -- the final sha256 check
        in ``end`` is the arbiter.
        """
        entry = self._live(tid, now)
        if entry is None:
            return False, "E_STATE"

        if not _is_int(index) or not 0 <= index < entry["chunks"]:
            del self._active[tid]
            return False, "E_STATE"

        data = _decode_chunk(data_b64)
        if data is None:
            del self._active[tid]
            return False, "E_STATE"

        received = entry["received"]
        total = entry["bytes"] - len(received.get(index, b"")) + len(data)
        if total > MAX_FILE_BYTES:
            del self._active[tid]
            return False, "E_TOOBIG"

        received[index] = data
        entry["bytes"] = total
        return True, None

    def end(self, tid, now):
        """Assemble and verify *tid*; ``(ok, code, info)``.

        Any missing chunk, an assembled length that differs from the declared
        ``size``, or a sha256 mismatch is ``(False, "E_CHECKSUM", None)`` and
        drops the transfer. Success moves the bytes to the staged store and
        returns ``(True, None, {"name", "mime", "size"})``.
        """
        entry = self._live(tid, now)
        if entry is None:
            return False, "E_STATE", None

        received = entry["received"]
        parts = []
        for index in range(entry["chunks"]):
            part = received.get(index)
            if part is None:
                del self._active[tid]
                return False, "E_CHECKSUM", None
            parts.append(part)

        data = b"".join(parts)
        if len(data) != entry["size"]:
            del self._active[tid]
            return False, "E_CHECKSUM", None
        if hashlib.sha256(data).hexdigest() != entry["sha256"]:
            del self._active[tid]
            return False, "E_CHECKSUM", None

        del self._active[tid]
        self._staged[tid] = {
            "name": entry["name"],
            "mime": entry["mime"],
            "data": data,
            "staged": now,
        }
        return True, None, {
            "name": entry["name"],
            "mime": entry["mime"],
            "size": len(data),
        }

    def take(self, tid, now):
        """Pop a staged file -- ``(name, mime, data)``, or None.

        One-shot by design: a ``ref`` may be used by exactly one ``msg``.
        Unknown, already-consumed and expired ids all return None.
        """
        staged = self._staged.pop(tid, None)
        if staged is None:
            return None
        if now - staged["staged"] > TRANSFER_TTL_S:
            return None
        return staged["name"], staged["mime"], staged["data"]

    def purge(self, now):
        """Drop every entry older than the TTL; returns dropped active ids.

        Staged ids are dropped silently (nothing is waiting on them); the
        returned in-progress ids are logged by the channel so an abandoned
        upload is visible.
        """
        dropped = []
        for tid, entry in list(self._active.items()):
            if now - entry["started"] > TRANSFER_TTL_S:
                del self._active[tid]
                dropped.append(tid)
        for tid, staged in list(self._staged.items()):
            if now - staged["staged"] > TRANSFER_TTL_S:
                del self._staged[tid]
        return dropped

    def peek(self, tid, now):
        """Staged metadata of *tid* without consuming it (M31 / G4).

        A chunked message only carries ``{ref: id}``; the archive title and
        the attachment suffix still want the name/mime/size the staged record
        already knows. Read-only: a later ``take`` still consumes the bytes.
        Unknown or expired ids return None.
        """
        staged = self._staged.get(tid)
        if staged is None:
            return None
        if now - staged["staged"] > TRANSFER_TTL_S:
            return None
        return {
            "name": staged["name"],
            "mime": staged["mime"],
            "size": len(staged["data"]),
        }

    def _live(self, tid, now):
        """The in-progress entry for *tid* unless unknown or expired."""
        entry = self._active.get(tid)
        if entry is None:
            return None
        if now - entry["started"] > TRANSFER_TTL_S:
            del self._active[tid]
            return None
        return entry


# ---------------------------------------------------------------------------
# M31 -- attachment retrieval (opaque refs + a media-directory guard)
# ---------------------------------------------------------------------------

# A ref lives as long as a staged upload: ten minutes, refreshed while it is
# re-issued by a newer ``hist`` answer.
ATTACH_REF_TTL_S = TRANSFER_TTL_S


class AttachmentRefs:
    """Opaque, short-lived handles for attachments shown in ``hist`` (G3).

    The browser never sends a path: it gets ``ref`` values from history and
    asks for them by that value alone. A ref is bound to one chat (and to the
    persisted message it came from), so a leaked ref cannot read another
    session's file. Every method takes an explicit *now* so tests control
    expiry, exactly like ``FileTransfers``.

    The token is random and carries no path or message id, so a ref reveals
    nothing and cannot be forged into another entry.
    """

    def __init__(self, ttl=ATTACH_REF_TTL_S):
        self._ttl = ttl
        # ref -> {chat, path, url, msg_id, part_index, name, mime, issued}
        self._by_ref = {}
        # (chat, path, msg_id, part_index) -> ref (reused while still live)
        self._by_key = {}

    def issue(self, chat, path, msg_id="", part_index=0, name="", mime="",
              url="", now=0.0):
        """Return the live ref for this attachment, minting one if needed."""
        resolved = str(path)
        key = (str(chat), resolved, str(msg_id or ""), int(part_index or 0))
        ref = self._by_key.get(key)
        if ref is not None:
            entry = self._by_ref.get(ref)
            if entry is not None and now - entry["issued"] <= self._ttl:
                return ref
            self._drop(ref)

        ref = secrets.token_urlsafe(12)
        self._by_ref[ref] = {
            "chat": str(chat),
            "path": resolved,
            "url": str(url or ""),
            "msg_id": str(msg_id or ""),
            "part_index": int(part_index or 0),
            "name": str(name or ""),
            "mime": str(mime or ""),
            "issued": now,
        }
        self._by_key[key] = ref
        return ref

    def resolve(self, ref, now=0.0):
        """The entry behind *ref*, or None when unknown/expired."""
        if not (isinstance(ref, str) and ref):
            return None
        entry = self._by_ref.get(ref)
        if entry is None:
            return None
        if now - entry["issued"] > self._ttl:
            self._drop(ref)
            return None
        return dict(entry)

    def purge(self, now):
        """Drop every expired ref; returns how many were removed."""
        dropped = 0
        for ref, entry in list(self._by_ref.items()):
            if now - entry["issued"] > self._ttl:
                self._drop(ref)
                dropped += 1
        return dropped

    def _drop(self, ref):
        entry = self._by_ref.pop(ref, None)
        if entry is None:
            return
        key = (
            entry["chat"], entry["path"],
            entry["msg_id"], entry["part_index"],
        )
        if self._by_key.get(key) == ref:
            del self._by_key[key]


def media_file_path(raw_path, media_dir, max_bytes=MAX_FILE_BYTES):
    """Resolved path of *raw_path* only when it is a regular file inside *media_dir*.

    Guards, in order: the path resolves at all (symlinks followed), it stays
    inside the media directory, it is a regular file, and it is at most
    *max_bytes*. ``..`` traversal and a symlink pointing outside both fail the
    containment check. Returns a ``Path`` or None; never raises.
    """
    if not (isinstance(raw_path, str) and raw_path):
        return None
    try:
        root = Path(media_dir).expanduser().resolve()
        target = Path(raw_path).expanduser().resolve()
    except (OSError, RuntimeError, ValueError):
        return None
    if target == root or not target.is_relative_to(root):
        return None
    try:
        if not target.is_file():
            return None
        if target.stat().st_size > max_bytes:
            return None
    except OSError:
        return None
    return target


def history_has_attachment(history, msg_id="", url=""):
    """True when *history* still contains the referenced attachment (G3).

    A ref is re-validated against a fresh ``GET /api/chats/{id}``: the
    persisted message (``metadata.original_id``) must still be there and must
    still carry the same attachment URL. A deleted or edited turn therefore
    cannot be fetched through an old ref. When *msg_id* is empty the URL alone
    decides; with neither, nothing is accepted.
    """
    if not (msg_id or url):
        return False
    raw = history.get("messages") if isinstance(history, dict) else None
    if not isinstance(raw, list):
        return False
    for message in raw:
        if not isinstance(message, dict):
            continue
        if msg_id and _history_original_id(message) != msg_id:
            continue
        content = message.get("content")
        if not isinstance(content, list):
            continue
        if not url:
            return True
        for part in content:
            if isinstance(part, dict) and _part_url(part) == url:
                return True
    return False



# ---------------------------------------------------------------------------
# M7 -- model listing / switching
# ---------------------------------------------------------------------------


def _text(value):
    """True for a non-empty string (the only shape the protocol accepts)."""
    return isinstance(value, str) and bool(value)


def _id_set(value):
    """A set of non-empty string ids from ``removed_model_ids``/``hidden_*``."""
    if not isinstance(value, list):
        return set()
    return {item for item in value if isinstance(item, str) and item}


def _provider_model_ids(provider):
    """Visible model ids of one ``ProviderInfo`` dict, in console order.

    ``models`` then ``extra_models`` (each a list of dicts with an ``id``),
    deduped in first-seen order, minus anything the provider reports as
    ``removed_model_ids`` or ``hidden_model_ids``.
    """
    removed = _id_set(provider.get("removed_model_ids"))
    hidden = _id_set(provider.get("hidden_model_ids"))

    ids = []
    seen = set()
    for field in ("models", "extra_models"):
        entries = provider.get(field)
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            model_id = entry.get("id")
            if not _text(model_id) or model_id in seen:
                continue
            seen.add(model_id)
            ids.append(model_id)
    return [
        model_id
        for model_id in ids
        if model_id not in removed and model_id not in hidden
    ]


def _provider_eligible(provider, model_count):
    """Mirror the console's ``buildEligibleProviders`` for one provider.

    ``hub-managed`` and free-tier providers are always usable; every other
    provider needs models plus working credentials for its kind (custom ->
    ``base_url``; API-key-based -> a key; no key required -> anything).
    """
    if provider.get("id") == "hub-managed":
        return True
    if provider.get("is_free_tier"):
        return True
    if model_count <= 0:
        return False
    if provider.get("is_custom"):
        return _text(provider.get("base_url"))
    if provider.get("require_api_key", True):
        return _text(provider.get("api_key"))
    return True


def _model_vision(entry):
    """Vision capability of one model metadata dict: True / False / None.

    Only a real boolean is copied out of ``supports_image`` (or
    ``supports_multimodal`` as a fallback); ``None`` means "not probed" and
    becomes an omitted field, never ``false``. This is the whole of the M31
    capability projection -- no other metadata leaves ``ProviderInfo``.
    """
    if not isinstance(entry, dict):
        return None
    for field in ("supports_image", "supports_multimodal"):
        value = entry.get(field)
        if isinstance(value, bool):
            return value
    return None


def model_items(providers, active_provider="", active_model=""):
    """Project ``ProviderInfo`` dicts to ``[{provider, model, active, vision?}]``.

    Only the console-eligible providers/models are listed (see
    ``_provider_eligible``), and only ``provider`` / ``model`` / ``active`` /
    ``vision`` are copied out -- credential material such as ``api_key`` never
    reaches the client. ``vision`` is the model's boolean picture capability
    and is omitted when the app has not probed it (M31).

    *active* is True on the single item matching ``(active_provider,
    active_model)``. When both are given but that pair is not in the list
    (e.g. the provider is no longer eligible), it is inserted at index 0 so
    the client always has one active entry to display.
    """
    active_provider = active_provider if isinstance(active_provider, str) else ""
    active_model = active_model if isinstance(active_model, str) else ""

    items = []
    if isinstance(providers, list):
        for provider in providers:
            if not isinstance(provider, dict):
                continue
            provider_id = provider.get("id")
            if not _text(provider_id):
                continue
            if provider.get("enabled") is False:
                continue
            model_ids = _provider_model_ids(provider)
            if not _provider_eligible(provider, len(model_ids)):
                continue
            metadata = {}
            for field in ("models", "extra_models"):
                for entry in provider.get(field) or []:
                    if not isinstance(entry, dict):
                        continue
                    model_id = entry.get("id")
                    if _text(model_id) and model_id not in metadata:
                        metadata[model_id] = entry
            for model_id in model_ids:
                item = {
                    "provider": provider_id,
                    "model": model_id,
                    "active": (
                        provider_id == active_provider
                        and model_id == active_model
                    ),
                }
                vision = _model_vision(metadata.get(model_id))
                if vision is not None:
                    item["vision"] = vision
                items.append(item)

    if active_provider and active_model:
        if not any(item["active"] for item in items):
            items.insert(0, {
                "provider": active_provider,
                "model": active_model,
                "active": True,
            })
    return items


def active_llm_of(payload):
    """``(provider, model)`` from an ``ActiveModelsInfo``-shaped dict.

    Reads ``payload["active_llm"]["provider_id"/"model"]``; a null
    ``active_llm`` or any off-shape input yields ``("", "")``.
    """
    if not isinstance(payload, dict):
        return ("", "")
    slot = payload.get("active_llm")
    if not isinstance(slot, dict):
        return ("", "")

    provider = slot.get("provider_id")
    model = slot.get("model")
    return (
        provider if isinstance(provider, str) else "",
        model if isinstance(model, str) else "",
    )


def active_llm_detail(payload):
    """``(provider, model, effective_max_input_length)`` from an active-model view.

    Same payload as ``active_llm_of`` plus the model's context window
    (``effective_max_input_length``), which the usage line needs as its
    denominator. The length is ``0`` when the app omits it or it is not a
    positive integer -- callers must treat that as "limit unknown" and never
    invent a window size.
    """
    provider, model = active_llm_of(payload)
    limit = 0
    if isinstance(payload, dict):
        value = payload.get("effective_max_input_length")
        if _is_int(value) and value > 0:
            limit = value
    return provider, model, limit


def plan_model_switch(
    items, active_provider, active_model, provider, model,
):
    """Decide what a ``set_model`` request needs: ``(action, detail)``.

    ``action`` is ``"error"`` (nothing to switch to, *detail* explains),
    ``"noop"`` (the pair is already active -- answer ``model_changed``
    without a PUT) or ``"put"`` (validate-then-PUT ``/api/models/active``).
    The pair must be one the client was just offered, which is what makes the
    "validate before switch" rule enforceable without a second source of
    truth.
    """
    if not (_text(provider) and _text(model)):
        return ("error", "provider and model are required")

    pairs = set()
    if isinstance(items, list):
        for item in items:
            if not isinstance(item, dict):
                continue
            item_provider = item.get("provider")
            item_model = item.get("model")
            if _text(item_provider) and _text(item_model):
                pairs.add((item_provider, item_model))
    if (provider, model) not in pairs:
        return ("error", "unknown model: %s/%s" % (provider, model))

    active_provider = active_provider if isinstance(active_provider, str) else ""
    active_model = active_model if isinstance(active_model, str) else ""
    if (provider, model) == (active_provider, active_model):
        return ("noop", "")
    return ("put", "")


# ---------------------------------------------------------------------------
# M8 -- server-side chat list & workspace prompt files
# ---------------------------------------------------------------------------

PROMPT_FILES = ("SOUL.md", "AGENTS.md", "PROFILE.md", "MEMORY.md")


def extract_web_chats(specs, channel="web", sender_id="web-user"):
    """Extract ``[{"chat", "title", "updated_at"}]`` from ``GET /api/chats``."""
    if not isinstance(specs, list):
        return []
    prefix = f"{channel}:{sender_id}:"
    items = []
    for spec in specs:
        if not isinstance(spec, dict):
            continue
        if spec.get("channel") != channel:
            continue
        session_id = spec.get("session_id")
        if not (isinstance(session_id, str) and session_id.startswith(prefix)):
            continue
        chat = session_id.split(":", 2)[2]
        if not chat:
            continue
        title = str(spec.get("name") or spec.get("title") or "").strip()
        updated_at = spec.get("updated_at") or spec.get("created_at") or ""
        items.append({
            "chat": chat,
            "title": title,
            "updated_at": str(updated_at) if updated_at else "",
        })
    return items


# ---------------------------------------------------------------------------
# M9 -- session reasoning effort (SPA vocabulary over QwenPaw thinking)
# ---------------------------------------------------------------------------

# The SPA only ever shows these five. ``default`` means "no session override"
# (QwenPaw's ``inherit``); the other four are effort levels. ``minimal`` and
# ``xhigh`` exist server-side but are deliberately not offered here.
EFFORT_LEVELS = ("default", "low", "medium", "high", "max")
EFFORT_RATIOS = {"low": 0.15, "medium": 0.4, "high": 0.75, "max": 1.0}

# QwenPaw's budget ladder is minimal(0) / low(.15) / medium(.4) / high(.75) /
# xhigh|max(1). ``minimal`` is not in the SPA vocabulary, so position 0 reads
# as ``low``; 1.0 is shared by xhigh/max, both of which mean "maximum".
_BUDGET_LADDER = (
    (0.0, "low"),
    (0.15, "low"),
    (0.4, "medium"),
    (0.75, "high"),
    (1.0, "max"),
)


def is_effort_level(value):
    """True for one of the five wire levels the SPA may send."""
    return isinstance(value, str) and value in EFFORT_LEVELS


def effort_budget(level, budget_min, budget_max):
    """``budget_tokens`` for one SPA level, or None when unusable.

    QwenPaw resolves a budget-mode preference by placing the level on the
    ``[budget_min, budget_max]`` ladder at 15/40/75/100 %, so the plugin sends
    the already-converted number: ``{level:"budget", budget_tokens:N}`` is the
    only budget-mode request the server accepts without adapting it (and a
    non-inherit preference whose resolved ``reason`` is non-empty is a 422).
    """
    ratio = EFFORT_RATIOS.get(level) if isinstance(level, str) else None
    if ratio is None:
        return None
    if not (
        _is_int(budget_min)
        and _is_int(budget_max)
        and 1 <= budget_min <= budget_max
    ):
        return None
    return int(round(budget_min + (budget_max - budget_min) * ratio))


def effort_level_for_budget(tokens, budget_min, budget_max):
    """Nearest SPA level for an effective budget, or None when unusable.

    The server stores a budget-mode preference as ``budget_tokens``; the SPA
    selector still needs a level, so the token count is placed back on the
    same ladder and the closest rung wins (ties go to the lower rung).
    """
    if not (
        _is_int(tokens)
        and _is_int(budget_min)
        and _is_int(budget_max)
        and 1 <= budget_min <= budget_max
    ):
        return None
    if budget_max == budget_min:
        return "low" if tokens <= budget_min else "max"
    ratio = (tokens - budget_min) / float(budget_max - budget_min)
    return min(_BUDGET_LADDER, key=lambda item: abs(item[0] - ratio))[1]


def effort_supported(control):
    """SPA levels selectable for a ``ThinkingControl``-shaped dict.

    ``default`` is always selectable (it clears the override) and therefore
    never listed. A budget-mode model with a usable range can express all four
    levels; effort-mode models only the ones they declare; unknown/unsupported
    models (and a budget card without a range) none.
    """
    if not isinstance(control, dict):
        return []
    kind = control.get("kind")
    if kind == "budget":
        low = control.get("budget_min")
        high = control.get("budget_max")
        if not (_is_int(low) and _is_int(high) and 1 <= low <= high):
            return []
        return ["low", "medium", "high", "max"]
    if kind == "effort":
        efforts = control.get("efforts")
        if not isinstance(efforts, list):
            return []
        return [level for level in EFFORT_LEVELS[1:] if level in efforts]
    return []


def effort_level_of_view(view):
    """SPA level for a ``/thinking`` view's requested value.

    ``inherit`` (no session override) is ``default``; effort levels pass
    through when they are in the SPA vocabulary; a budget-mode value is
    reverse-mapped from the effective token count; anything else degrades to
    ``default`` rather than inventing a level the server never stored.
    """
    if not isinstance(view, dict):
        return "default"
    value = view.get("value")
    value = value if isinstance(value, dict) else {}
    level = value.get("level")
    if level is None or level == "inherit":
        return "default"
    if level in EFFORT_LEVELS[1:]:
        return level
    if level == "minimal":
        return "low"
    if level == "xhigh":
        return "max"
    if level == "budget":
        effective = view.get("effective")
        effective = effective if isinstance(effective, dict) else {}
        tokens = effective.get("budget_tokens")
        if not _is_int(tokens):
            tokens = value.get("budget_tokens")
        control = view.get("control")
        control = control if isinstance(control, dict) else {}
        nearest = effort_level_for_budget(
            tokens, control.get("budget_min"), control.get("budget_max"),
        )
        return nearest or "default"
    return "default"


def effort_view_fields(view):
    """Keyword arguments for ``frames.effort_frame`` from a thinking view."""
    if not isinstance(view, dict):
        view = {}
    control = view.get("control")
    control = control if isinstance(control, dict) else {}
    effective = view.get("effective")
    effective = effective if isinstance(effective, dict) else {}

    effective_level = effective.get("level")
    if not (isinstance(effective_level, str) and effective_level):
        effective_level = None
    budget_tokens = None
    tokens = effective.get("budget_tokens")
    if effective_level == "budget" and _is_int(tokens) and tokens >= 1:
        budget_tokens = tokens

    kind = control.get("kind")
    if not (isinstance(kind, str) and kind):
        kind = None
    model_key = view.get("model_key")
    if not (isinstance(model_key, str) and model_key):
        model_key = None

    return {
        "level": effort_level_of_view(view),
        "effective_level": effective_level,
        "budget_tokens": budget_tokens,
        "supported": effort_supported(control),
        "kind": kind,
        "model_key": model_key,
    }


def extract_skill_items(payload):
    """Extract ``[{"id", "name", "description"}]`` from ``/api/skills`` payload."""
    raw = None
    if isinstance(payload, list):
        raw = payload
    elif isinstance(payload, dict):
        for key in ("skills", "items"):
            val = payload.get(key)
            if isinstance(val, list):
                raw = val
                break
    if not isinstance(raw, list):
        return []

    items = []
    seen = set()
    for entry in raw:
        if isinstance(entry, str):
            sid = entry.strip()
            if sid and sid not in seen:
                seen.add(sid)
                items.append({"id": sid, "name": sid, "description": ""})
            continue
        if not isinstance(entry, dict):
            continue
        if entry.get("enabled") is False:
            continue
        sid = str(entry.get("id") or entry.get("name") or "").strip()
        if not sid or sid in seen:
            continue
        seen.add(sid)
        name = str(entry.get("name") or entry.get("label") or sid).strip() or sid
        desc = str(entry.get("description") or entry.get("desc") or "").strip()
        items.append({
            "id": sid,
            "name": name,
            "description": desc,
        })
    return items


# ---------------------------------------------------------------------------
# M11 -- per-session token usage from the persisted agent session
# ---------------------------------------------------------------------------

# QwenPaw records each turn's provider usage on the closing assistant message
# as ``metadata[TURN_USAGE_META_KEY]["usage"]`` (see
# token_usage/turn_usage.py). The plugin only ever reads it; nothing here
# writes or mutates host state.
TURN_USAGE_META_KEY = "qwenpaw_turn_usage"

# Sessions of this channel live in ``<workspace>/sessions/web/*.json``.
_SESSION_CHANNEL = "web"

# M28: cache accounting. A turn contributes to the cache numerator and
# denominator only when the provider actually reported cache usage
# (``cache_observed is True``) **and** its eligible-input denominator is
# positive. Every other turn is "not reported": it must not add a fake 0 hit
# or miss, and it must not dilute a hit rate. ``session_cache_*`` is a
# cumulative snapshot of the whole session (turn_usage.py) and is never read
# here -- summing it would square the numbers.
_CACHE_KEYS = ("cache_hit", "cache_miss", "cache_eligible")

# Display name of the bucket that collects turns whose model is missing,
# empty or the literal "unknown" (probe: docs/m28-report.md §3.3).
STATS_UNKNOWN_MODEL = "未知模型"


def _token_count(value):
    """Non-negative int from one usage field, else ``None``.

    ``None`` means "the source did not give a number", so callers omit the
    field instead of showing a made-up 0. Numeric strings are accepted (older
    files may store them that way); booleans, negatives, NaN/inf and anything
    else are rejected.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, float):
        if not math.isfinite(value) or value < 0:
            return None
        return int(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            number = int(text)
        except ValueError:
            try:
                return _token_count(float(text))
            except (TypeError, ValueError):
                return None
        return number if number >= 0 else None
    return None


def _message_dict(item):
    """One message dict from a persisted context entry (dict or ``[dict]``)."""
    if isinstance(item, dict):
        return item
    if isinstance(item, (list, tuple)) and item and isinstance(item[0], dict):
        return item[0]
    return None


def message_turn_usage(message):
    """The whole ``qwenpaw_turn_usage`` dict recorded on one message."""
    if not isinstance(message, dict):
        return None
    metadata = message.get("metadata")
    if not isinstance(metadata, dict):
        return None
    turn = metadata.get(TURN_USAGE_META_KEY)
    return turn if isinstance(turn, dict) else None


def message_usage(message):
    """The per-turn ``usage`` dict recorded on one message, or ``None``."""
    turn = message_turn_usage(message)
    if turn is None:
        return None
    usage = turn.get("usage")
    return usage if isinstance(usage, dict) else None


def _turn_cache(usage):
    """``(hit, miss, eligible)`` of one turn, or ``None`` when unusable.

    Conversion rules (protocol/frames.md §14.5, probe §5.1):

    - only ``cache_observed is True`` counts -- a missing flag (legacy record)
      or ``false`` means the provider did not report cache usage, so the turn
      contributes **nothing** (not a 0 hit and not a 0 miss);
    - ``eligible`` must be positive, otherwise there is no denominator;
    - ``miss = eligible - hit``: never ``prompt_tokens - hit``, because
      Anthropic's ``prompt_tokens`` excludes cache reads/writes while
      OpenAI/DeepSeek include them (probe §2.2);
    - a hit larger than the denominator is not trustworthy and is dropped.
    """
    if not isinstance(usage, dict) or usage.get("cache_observed") is not True:
        return None
    hit = _token_count(usage.get("cache_read_tokens"))
    eligible = _token_count(usage.get("cache_eligible_input_tokens"))
    if hit is None or eligible is None or eligible <= 0 or hit > eligible:
        return None
    return hit, eligible - hit, eligible


def _turn_model(usage):
    """``(provider, model)`` of one turn; ``("", "")`` means "unknown model".

    QwenPaw records the model instance that was actually called, so this is
    the turn's own attribution -- never the chat's current model. A missing,
    empty or literal ``"unknown"`` model (the wrapper's fallback when the
    model object has no name) is not a real name and goes to the unknown
    bucket instead of being displayed as fact (probe §3.3).
    """
    provider = usage.get("provider_id") if isinstance(usage, dict) else None
    model = usage.get("model_name") if isinstance(usage, dict) else None
    provider = provider.strip() if isinstance(provider, str) else ""
    model = model.strip() if isinstance(model, str) else ""
    if not model or model.lower() == "unknown":
        return "", ""
    return provider, model


def session_messages(session_data):
    """Message dicts of a persisted session state (2.0 context, 1.x memory).

    Mirrors ``agent_stats.service._extract_session_messages``: QwenPaw 2.x
    keeps them under ``agent.state.context`` (a list of dicts or ``[dict]``),
    1.x under ``agent.memory.memories``/``content``. Anything off-shape yields
    ``[]`` -- callers degrade to "no data" rather than raising.
    """
    if not isinstance(session_data, dict):
        return []
    agent = session_data.get("agent")
    agent = agent if isinstance(agent, dict) else {}

    state = agent.get("state")
    if isinstance(state, dict):
        context = state.get("context")
        if isinstance(context, list) and context:
            return [
                message
                for message in (_message_dict(item) for item in context)
                if message is not None
            ]

    memory = agent.get("memory")
    if isinstance(memory, dict):
        raw = memory.get("memories") or memory.get("content") or []
        if isinstance(raw, list):
            return [
                message
                for message in (_message_dict(item) for item in raw)
                if message is not None
            ]
    return []


def session_identity(session_data):
    """Session id recorded inside a persisted session file, or ``""``.

    The on-disk shape is not part of any public API, so every plausible
    location is checked; when none carries an id the caller falls back to the
    file name (see ``_stem_matches``). Only containers that name the *session*
    are inspected -- an id nested inside the agent state could belong to
    something else and would wrongly veto a file-name match.
    """
    if not isinstance(session_data, dict):
        return ""
    holders = [session_data]
    for key in ("session", "agent"):
        nested = session_data.get(key)
        if isinstance(nested, dict):
            holders.append(nested)
    for holder in holders:
        for key in ("session_id", "sessionId"):
            value = holder.get(key)
            if isinstance(value, str) and value:
                return value
    return ""


def _context_token_candidate(usage, context_usage, prompt):
    """Best context-size estimate of one turn, or ``None`` when unusable.

    ``prompt_tokens`` accumulates every model call of a turn, so a turn with
    several tool calls would overstate the context. The last call's prompt
    (``last_prompt_tokens``) is the closest recorded size; the state estimate
    and finally the accumulated prompt are the fallbacks. Only a positive
    value is a usable context size.
    """
    last_prompt = _token_count(usage.get("last_prompt_tokens"))
    estimated = (
        _token_count(context_usage.get("estimated_tokens"))
        if isinstance(context_usage, dict) else None
    )
    for count in (last_prompt, estimated):
        if count is not None and count > 0:
            return count
    return prompt if prompt is not None and prompt > 0 else None


def session_usage(messages):
    """Cumulative token usage of one session's messages.

    Returns only the keys the data actually supports:

    - ``input_total`` / ``output_total``: sums of every assistant turn's
      ``prompt_tokens`` / ``completion_tokens``. A field is present when at
      least one recorded turn carried it (a real 0 is therefore distinct from
      "unknown").
    - ``context_tokens``: the latest recorded turn's context estimate, in
      priority order ``last_prompt_tokens``, ``context_usage.estimated_tokens``
      and ``prompt_tokens`` (``basis=last_turn_prompt`` in
      protocol/frames.md §11.2). The accumulated prompt is only a fallback
      because a turn with several tool calls adds every prompt together.

    ``{}`` means "no usage data", never "zero".
    """
    if not isinstance(messages, (list, tuple)):
        return {}

    prompt_total = 0
    completion_total = 0
    saw_prompt = False
    saw_completion = False
    context_tokens = None

    for item in messages:
        message = _message_dict(item)
        if message is None:
            continue
        role = message.get("role")
        role = getattr(role, "value", role)
        if role != "assistant":
            continue
        turn = message_turn_usage(message)
        if turn is None:
            continue
        usage = turn.get("usage")
        if not isinstance(usage, dict):
            continue

        prompt = _token_count(usage.get("prompt_tokens"))
        completion = _token_count(usage.get("completion_tokens"))
        candidate = _context_token_candidate(
            usage, turn.get("context_usage"), prompt,
        )
        if candidate is not None:
            context_tokens = candidate
        if prompt is not None:
            saw_prompt = True
            prompt_total += prompt
        if completion is not None:
            saw_completion = True
            completion_total += completion

    result = {}
    if saw_prompt:
        result["input_total"] = prompt_total
    if saw_completion:
        result["output_total"] = completion_total
    if context_tokens is not None:
        result["context_tokens"] = context_tokens
    return result


def session_last_turn(messages):
    """Receipt for the session's newest assistant reply, or ``None``.

    Only the **last** assistant message may answer: when it carries no usable
    usage (still being written, a failed/cancelled turn, or a legacy record)
    the result is ``None``. Falling back to an earlier message would pin the
    previous turn's numbers onto the new bubble. The shape matches ``hist``'s
    ``turn``; the id is the persisted ``Msg.id`` clients use for deduplication.
    """
    if not isinstance(messages, (list, tuple)):
        return None

    last = None
    for item in messages:
        message = _message_dict(item)
        if message is None:
            continue
        role = message.get("role")
        role = getattr(role, "value", role)
        if role == "assistant":
            last = message
    if last is None:
        return None

    usage = message_usage(last)
    if usage is None:
        return None
    turn_id = last.get("id")
    if not isinstance(turn_id, str) or not turn_id:
        return None

    return _make_turn(turn_id, usage)


def _stem_matches(path, session_id, chat, chat_id):
    """True when a session file name identifies *session_id* / *chat*.

    Used only for files that do not record their own session id. The exact
    session id is preferred; the plain chat id, the ``ChatSpec.id`` and the
    usual ``:``/``_``/``-`` separators are also accepted so a renamed or
    sanitised store keeps working.
    """
    name = os.path.basename(path)
    stem = name[:-5] if name.endswith(".json") else os.path.splitext(name)[0]
    if not stem:
        return False

    if isinstance(session_id, str) and session_id:
        compact = session_id.replace(":", "_")
        for candidate in (session_id, compact, compact.replace("_", "-")):
            if stem == candidate:
                return True

    for value in (chat, chat_id):
        if not (isinstance(value, str) and value):
            continue
        if stem == value:
            return True
        for separator in (":", "_", "-"):
            if stem.endswith(separator + value):
                return True
    return False


def _copy_turn(turn):
    """Defensive shallow copy of a cached ``turn`` receipt (or ``None``)."""
    return dict(turn) if isinstance(turn, dict) else None


class SessionUsageStore:
    """Read-only per-session usage, cached by file ``mtime`` + size.

    ``usage_for`` / ``usage_and_last_turn_for`` scan ``<sessions_root>/web``
    (plus legacy ``*.json`` files directly under the root), pick the file that
    belongs to *session_id* and return ``session_usage`` of it (and the newest
    turn's receipt). Every failure (missing directory, bad JSON, unreadable
    file, unexpected shape) degrades to ``{}`` / ``None``; the caller's chat
    path must never see an exception.

    Parsing is cached per path and invalidated by ``(mtime_ns, size)``, so the
    per-turn refresh only re-reads the file that actually changed.
    """

    # Bounded so a long-lived process cannot accumulate stale paths forever.
    _MAX_ENTRIES = 512

    def __init__(self):
        self._cache = {}
        self._lock = threading.Lock()

    def usage_for(self, sessions_root, session_id, chat="", chat_id=""):
        """Usage dict for one session; ``{}`` when there is nothing usable."""
        usage, _last_turn = self.usage_and_last_turn_for(
            sessions_root, session_id, chat, chat_id,
        )
        return usage

    def usage_and_last_turn_for(
        self, sessions_root, session_id, chat="", chat_id="",
    ):
        """``(usage, last_turn)`` for one session, both best-effort.

        ``usage`` is exactly what ``usage_for`` returns (the cumulative keys);
        ``last_turn`` is the newest assistant reply's ``turn`` receipt or
        ``None``. Both come from the same cached parse of one file.
        """
        session_id = session_id if isinstance(session_id, str) else ""
        chat = chat if isinstance(chat, str) else ""
        chat_id = chat_id if isinstance(chat_id, str) else ""
        try:
            root = os.fspath(sessions_root)
        except TypeError:
            return {}, None
        try:
            with self._lock:
                return self._lookup_locked(root, session_id, chat, chat_id)
        except Exception:  # noqa: BLE001 - usage is best-effort, never fatal
            return {}, None

    def _lookup_locked(self, root, session_id, chat, chat_id):
        wrapped = {
            value for value in (session_id, chat, chat_id)
            if isinstance(value, str) and value
        }
        stem_match = None
        for path in self._paths(root):
            entry = self._entry(path)
            if entry is None:
                continue
            identity, usage, last_turn, _summary = entry
            if identity:
                # A file that names a session only ever answers for that one.
                # Depending on the store version that name is the session id,
                # the chat id or the ChatSpec id; all three identify this chat.
                if identity in wrapped:
                    return dict(usage), _copy_turn(last_turn)
                continue
            if stem_match is None and _stem_matches(
                path, session_id, chat, chat_id,
            ):
                stem_match = (usage, last_turn)
        if stem_match is None:
            return {}, None
        usage, last_turn = stem_match
        return dict(usage), _copy_turn(last_turn)

    def stats_entries(
        self, sessions_root, sender_id="web-user", channel="web",
        chat_ids=None, chat_by_session=None, chat_by_spec=None,
    ):
        """Turn summaries of every usable session file, one entry per file.

        Returns ``[{"path", "chat", "summary"}]`` for files that recorded at
        least one turn. Malformed, empty and usage-less files are skipped
        silently. The parse is shared with ``usage_for`` through the same
        ``(mtime_ns, size)`` cache, so opening the dashboard re-stats cheap
        files but never re-reads an unchanged one.

        Every failure degrades to the entries collected so far; the stats
        path must never raise.
        """
        try:
            root = os.fspath(sessions_root)
        except TypeError:
            return []
        known = (
            set(chat for chat in chat_ids if isinstance(chat, str) and chat)
            if isinstance(chat_ids, (list, tuple, set)) else None
        )
        entries = []
        try:
            with self._lock:
                for path in self._paths(root):
                    entry = self._entry(path)
                    if entry is None:
                        continue
                    identity, _usage, _last_turn, summary = entry
                    if not isinstance(summary, dict):
                        continue
                    turns = summary.get("turns")
                    if not isinstance(turns, int) or turns <= 0:
                        continue
                    chat = session_file_chat(
                        path, identity, sender_id, channel, known,
                        chat_by_session, chat_by_spec,
                    )
                    if not chat:
                        continue
                    entries.append({
                        "path": path,
                        "chat": chat,
                        "summary": _copy_turn_summary(summary),
                    })
        except Exception:  # noqa: BLE001 - best-effort, partial is fine
            return entries
        return entries

    @staticmethod
    def _paths(root):
        """Candidate ``*.json`` files, channel directory first."""
        paths = []
        for directory in (os.path.join(root, _SESSION_CHANNEL), root):
            try:
                names = sorted(os.listdir(directory))
            except OSError:
                continue
            for name in names:
                if name.endswith(".json"):
                    paths.append(os.path.join(directory, name))
        return paths

    def _entry(self, path):
        """``(identity, usage, last_turn, turn_summary)`` for one file, cached."""
        try:
            stat = os.stat(path)
        except OSError:
            self._cache.pop(path, None)
            return None

        stamp = (stat.st_mtime_ns, stat.st_size)
        cached = self._cache.get(path)
        if cached is not None and cached[0] == stamp:
            return cached[1], cached[2], cached[3], cached[4]

        try:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                data = json.load(handle)
        except (OSError, ValueError):
            # Mid-write or corrupt: remember the stamp so we do not retry it
            # until the file changes again.
            self._cache[path] = (
                stamp, "", {}, None, _empty_turn_summary(),
            )
            return "", {}, None, _empty_turn_summary()

        identity = session_identity(data)
        messages = session_messages(data)
        usage = session_usage(messages)
        last_turn = session_last_turn(messages)
        summary = session_turn_summary(messages)
        self._cache[path] = (stamp, identity, usage, last_turn, summary)
        if len(self._cache) > self._MAX_ENTRIES:
            self._prune()
        return identity, usage, last_turn, summary

    def _prune(self):
        """Keep the cache bounded: drop missing files, then the oldest entries."""
        for path in list(self._cache):
            if not os.path.exists(path):
                self._cache.pop(path, None)
        while len(self._cache) > self._MAX_ENTRIES:
            self._cache.pop(next(iter(self._cache)))


# ---------------------------------------------------------------------------
# M24 -- all-chats usage dashboard
# ---------------------------------------------------------------------------

# A dashboard is a summary, not a dump: only this many chats are sent.
STATS_TOP_CHATS = 10


def _empty_turn_summary():
    """Zeroed per-file summary (the ``days`` / ``models`` maps own their keys)."""
    return {"turns": 0, "days": {}, "models": {}, "undated_turns": 0}


def _turn_day(message):
    """Container-local ISO date of one message, or ``""`` when unknown.

    QwenPaw (via AgentScope) stamps ``Msg.created_at`` with
    ``datetime.now().isoformat()``: a **naive local wall-clock** value with no
    offset. The date prefix is therefore the container's local calendar day,
    which is what the dashboard's day buckets use. An offset-aware value
    (some imports carry one) is converted to local time first;
    ``finished_at`` is the fallback. Unparseable values are trusted only as a
    date prefix when they at least look like one.
    """
    for key in ("created_at", "finished_at"):
        raw = message.get(key)
        if not isinstance(raw, str):
            continue
        text = raw.strip()
        if not text:
            continue
        try:
            parsed = datetime.datetime.fromisoformat(
                text[:-1] + "+00:00" if text[-1] in ("Z", "z") else text,
            )
        except ValueError:
            head = text[:10]
            try:
                datetime.date.fromisoformat(head)
            except ValueError:
                continue
            return head
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone()
        return parsed.date().isoformat()
    return ""


def _add_count(slot, key, value):
    """Add a recorded token count to ``slot[key]``; ``None`` stays absent."""
    if value is None:
        return
    slot[key] = slot.get(key, 0) + value


def _add_cache(slot, cache):
    """Add one usable turn's ``(hit, miss, eligible)`` to ``slot``.

    ``None`` (not reported / unusable) leaves the keys absent, so a bucket
    with no observed turn never claims a 0% hit rate.
    """
    if cache is None:
        return
    hit, miss, eligible = cache
    _add_count(slot, "cache_hit", hit)
    _add_count(slot, "cache_miss", miss)
    _add_count(slot, "cache_eligible", eligible)


def _cache_rate(slot):
    """Hit rate (percent, 0-100) recomputed from integer sums, or ``None``.

    Never averages the per-turn ``cache_hit_rate``: a large turn must weigh
    more than a small one (probe §2.5). ``None`` means "no usable
    denominator", which callers omit instead of reporting 0.
    """
    hit = _token_count(slot.get("cache_hit"))
    eligible = _token_count(slot.get("cache_eligible"))
    if hit is None or eligible is None or eligible <= 0:
        return None
    return round(hit / eligible * 100, 2)


def _set_cache_rate(slot):
    """Add ``cache_hit_rate`` to ``slot`` when its integer sums support it."""
    rate = _cache_rate(slot)
    if rate is not None:
        slot["cache_hit_rate"] = rate
    return slot


def _model_bucket(summary, provider, model):
    """Per-model accumulator inside one file summary, created on demand."""
    models = summary["models"]
    key = (provider, model)
    bucket = models.get(key)
    if bucket is None:
        bucket = {"turns": 0, "model": model}
        if provider:
            bucket["provider"] = provider
        models[key] = bucket
    return bucket


def _copy_turn_summary(summary):
    """Defensive copy of one cached per-file summary."""
    buckets = summary.get("days")
    models = summary.get("models")
    copied = {
        "turns": summary.get("turns", 0),
        "days": {
            day: dict(bucket) for day, bucket in buckets.items()
        } if isinstance(buckets, dict) else {},
        "models": {
            key: dict(bucket) for key, bucket in models.items()
        } if isinstance(models, dict) else {},
        "undated_turns": summary.get("undated_turns", 0),
    }
    for key in ("input", "output") + _CACHE_KEYS:
        if key in summary:
            copied[key] = summary[key]
    return copied


def session_turn_summary(messages):
    """Turn totals, per-day buckets and per-model buckets of one session.

    A **turn** is one assistant message carrying a usable
    ``qwenpaw_turn_usage.usage`` receipt with at least one of
    ``prompt_tokens`` / ``completion_tokens``. The result is::

        {"turns": 3, "input": 120, "output": 30,
         "cache_hit": 40, "cache_miss": 60, "cache_eligible": 100,
         "days": {"2026-10-26": {"turns": 2, "input": 100, "output": 20,
                                 "cache_hit": 40, "cache_miss": 60,
                                 "cache_eligible": 100}},
         "models": {("kilo", "openrouter/free"): {"turns": 2, ..., "model": ...}},
         "undated_turns": 1}

    ``input`` / ``output`` are absent when no turn recorded that side (a real
    0 is kept), and the same rule applies per day and per model. Cache keys
    exist only when at least one turn actually reported cache usage (§14.5).
    A turn without a timestamp is counted in the totals but never in a
    made-up day bucket; ``undated_turns`` says how many. Model keys are the
    normalised ``(provider_id, model_name)`` pair, ``("", "")`` for the
    unknown bucket.
    """
    summary = _empty_turn_summary()
    if not isinstance(messages, (list, tuple)):
        return summary

    for item in messages:
        message = _message_dict(item)
        if message is None:
            continue
        role = message.get("role")
        role = getattr(role, "value", role)
        if role != "assistant":
            continue
        usage = message_usage(message)
        if usage is None:
            continue
        prompt = _token_count(usage.get("prompt_tokens"))
        completion = _token_count(usage.get("completion_tokens"))
        if prompt is None and completion is None:
            continue

        cache = _turn_cache(usage)
        summary["turns"] += 1
        _add_count(summary, "input", prompt)
        _add_count(summary, "output", completion)
        _add_cache(summary, cache)

        provider, model = _turn_model(usage)
        model_bucket = _model_bucket(summary, provider, model)
        model_bucket["turns"] += 1
        _add_count(model_bucket, "input", prompt)
        _add_count(model_bucket, "output", completion)
        _add_cache(model_bucket, cache)

        day = _turn_day(message)
        if not day:
            summary["undated_turns"] += 1
            continue
        bucket = summary["days"].setdefault(day, {"turns": 0})
        bucket["turns"] += 1
        _add_count(bucket, "input", prompt)
        _add_count(bucket, "output", completion)
        _add_cache(bucket, cache)
    return summary


def _session_file_stem(path):
    """File name without its ``.json`` suffix."""
    name = os.path.basename(path)
    return name[:-5] if name.lower().endswith(".json") else os.path.splitext(name)[0]


def session_file_chat(
    path, identity="", sender_id="web-user", channel="web",
    chat_ids=None, chat_by_session=None, chat_by_spec=None,
):
    """Chat id a session file belongs to, or ``""`` when unresolvable.

    Resolution order:

    1. the session id recorded inside the file, either as the channel form
       (``web:web-user:<chat>``) or QwenPaw's filename-safe form
       (``web--web-user--<chat>``);
    2. an exact recorded identity that matches a known ChatSpec id, session
       id or chat id (the caller supplies those maps from ``GET /api/chats``);
    3. the QwenPaw file name, ``<sender>_<sanitized session id>.json`` --
       ``web-user_web--web-user--<chat>.json``;
    4. the bare file stem, for legacy stores that name a file after its chat.

    The file name is usually the only usable mapping: QwenPaw stores an opaque
    32-hex ``agent.state.session_id`` that is *not* the channel session id, so
    ``session_identity`` deliberately ignores it.
    """
    stem = _session_file_stem(path)
    prefixes = []
    if isinstance(channel, str) and channel and isinstance(sender_id, str) and sender_id:
        prefixes = [
            "%s:%s:" % (channel, sender_id),
            "%s--%s--" % (channel, sender_id),
        ]

    for value in (identity, stem):
        if not isinstance(value, str) or not value:
            continue
        for prefix in prefixes:
            if value.startswith(prefix) and len(value) > len(prefix):
                return value[len(prefix):]

    known = chat_ids if isinstance(chat_ids, (list, tuple, set)) else ()
    for value in (identity, stem):
        if not isinstance(value, str) or not value:
            continue
        if value in known:
            return value
        for mapping in (chat_by_session, chat_by_spec):
            if not isinstance(mapping, dict):
                continue
            hit = mapping.get(value)
            if isinstance(hit, str) and hit:
                return hit

    name_prefixes = []
    if isinstance(sender_id, str) and sender_id and isinstance(channel, str) and channel:
        name_prefixes.append("%s_%s--%s--" % (sender_id, channel, sender_id))
    if prefixes:
        name_prefixes.append(prefixes[1])
    for prefix in name_prefixes:
        if stem.startswith(prefix):
            return stem[len(prefix):]
    return stem


def _summary_models(summary):
    """``[((provider, model), bucket)]`` of one file summary.

    Keys are re-normalised here so a hand-built summary cannot smuggle an
    empty model or the literal ``"unknown"`` into a real model row: those
    turns land in the unknown bucket and still count in the totals.
    """
    buckets = summary.get("models")
    if not isinstance(buckets, dict):
        return []
    pairs = []
    for bucket in buckets.values():
        if not isinstance(bucket, dict):
            continue
        provider = bucket.get("provider")
        provider = provider.strip() if isinstance(provider, str) else ""
        model = bucket.get("model")
        model = model.strip() if isinstance(model, str) else ""
        if not model or model.lower() == "unknown":
            provider, model = "", ""
        pairs.append(((provider, model), bucket))
    return pairs


def _add_cache_fields(slot, source):
    """Fold the cache triple of *source* into *slot*, all three or nothing.

    An incomplete triple (one field missing) is dropped whole, so a consumer
    can never see ``cache_hit`` without the denominator or rate that explains
    it. ``_set_cache_rate`` later derives the rate from these integer sums.
    """
    values = [_token_count(source.get(key)) for key in _CACHE_KEYS]
    if any(value is None for value in values):
        return
    for key, value in zip(_CACHE_KEYS, values):
        _add_count(slot, key, value)


def _model_rank(item):
    """Stable ``by_model`` order: input desc, turns desc, model, provider."""
    return (
        -(item.get("input") or 0),
        -(item.get("turns") or 0),
        item.get("model") or "",
        item.get("provider") or "",
    )


def aggregate_usage_stats(entries, known_chats=None, titles=None):
    """Fold per-file turn summaries into the ``stats`` payload body.

    *entries* is an iterable of ``{"chat", "summary"}`` dicts (see
    ``session_turn_summary``). Returns::

        {"totals": {"turns": 95, "input": 1648974, "output": 12314,
                    "cache_hit": 341141, "cache_miss": 1307833,
                    "cache_eligible": 1648974, "cache_hit_rate": 20.69},
         "by_model": [{"provider": "kilo", "model": "openrouter/free", ...}],
         "covered_chats": 37,
         "days": [{"date": "2026-10-26", "turns": 20, ...}, ...],
         "chats": [{"chat": "...", "title": "...", "turns": 1, ...}, ...],
         "uncovered_chats": 0}

    ``uncovered_chats`` is the number of *known* chats (the server's web chat
    list) that have no usable data. It is **omitted when the list is unknown**
    (the API call failed): an unknown count must not be reported as 0. Top
    chats are capped at ``STATS_TOP_CHATS`` and sorted by recorded tokens,
    then turns, then chat id. ``undated_turns`` appears only when some counted
    turn had no timestamp (such turns are in the totals but not in ``days``).

    Cache keys are folded **only from turns that reported cache usage**
    (§14.5): totals/days/models without any observed turn simply lack them.
    Every hit rate is recomputed from the integer sums -- per-turn rates are
    never averaged. ``by_model`` is sorted by ``input`` descending (then
    turns, model, provider) and includes the 未知模型 bucket, so
    ``Σ by_model.input/output/turns == totals`` always holds.
    """
    totals = {"turns": 0}
    days = {}
    chats = {}
    models = {}
    covered = set()
    undated = 0

    for entry in entries or ():
        if not isinstance(entry, dict):
            continue
        chat = entry.get("chat")
        summary = entry.get("summary")
        if not (isinstance(chat, str) and chat) or not isinstance(summary, dict):
            continue
        turns = _token_count(summary.get("turns"))
        if turns is None or turns <= 0:
            continue
        covered.add(chat)
        totals["turns"] += turns

        item = chats.setdefault(chat, {"chat": chat, "turns": 0})
        item["turns"] += turns
        for key in ("input", "output"):
            value = _token_count(summary.get(key))
            if value is None:
                continue
            _add_count(totals, key, value)
            _add_count(item, key, value)
        _add_cache_fields(totals, summary)

        for model_key, model_bucket in _summary_models(summary):
            bucket_turns = _token_count(model_bucket.get("turns"))
            if bucket_turns is None or bucket_turns <= 0:
                continue
            provider, model = model_key
            target = models.setdefault(model_key, {"turns": 0, "model": model})
            if provider:
                target["provider"] = provider
            target["turns"] += bucket_turns
            for field in ("input", "output"):
                _add_count(target, field, _token_count(model_bucket.get(field)))
            _add_cache_fields(target, model_bucket)

        undated += _token_count(summary.get("undated_turns")) or 0

        buckets = summary.get("days")
        if not isinstance(buckets, dict):
            continue
        for day, bucket in buckets.items():
            if not isinstance(day, str) or not isinstance(bucket, dict):
                continue
            try:
                datetime.date.fromisoformat(day)
            except ValueError:
                continue
            day_turns = _token_count(bucket.get("turns"))
            if day_turns is None or day_turns <= 0:
                continue
            target = days.setdefault(day, {"date": day, "turns": 0})
            target["turns"] += day_turns
            for key in ("input", "output"):
                _add_count(target, key, _token_count(bucket.get(key)))
            _add_cache_fields(target, bucket)

    _set_cache_rate(totals)
    for target in days.values():
        _set_cache_rate(target)

    title_map = titles if isinstance(titles, dict) else {}
    for chat, item in chats.items():
        title = title_map.get(chat)
        if isinstance(title, str) and title.strip():
            item["title"] = title.strip()

    by_model = []
    for (provider, model), item in models.items():
        entry = {"model": model or STATS_UNKNOWN_MODEL, "turns": item["turns"]}
        if provider:
            entry["provider"] = provider
        for key in ("input", "output") + _CACHE_KEYS:
            if key in item:
                entry[key] = item[key]
        _set_cache_rate(entry)
        by_model.append(entry)
    by_model.sort(key=_model_rank)

    def rank_key(item):
        tokens = (item.get("input") or 0) + (item.get("output") or 0)
        return (-tokens, -item["turns"], item["chat"])

    top = sorted(chats.values(), key=rank_key)[:STATS_TOP_CHATS]
    result = {
        "totals": totals,
        "by_model": by_model,
        "covered_chats": len(covered),
        "days": [days[day] for day in sorted(days)],
        "chats": top,
    }
    if known_chats is not None:
        known = {
            chat for chat in known_chats
            if isinstance(chat, str) and chat
        }
        result["uncovered_chats"] = len(known - covered)
    if undated > 0:
        result["undated_turns"] = undated
    return result


# ---------------------------------------------------------------------------
# M12 -- conversation export (Markdown snapshot)
# ---------------------------------------------------------------------------

# One export may be up to the same 10 MB ceiling as a chunked upload; the
# plugin checks the finished document before the first frame leaves.
MAX_EXPORT_BYTES = MAX_FILE_BYTES
# Titles are single-line and capped by code point, so a hostile chat name
# cannot inject document structure or flood the header.
EXPORT_TITLE_MAX_CHARS = 120
# Tool output is the one field that may be megabytes long; the transcript
# stays readable by cutting it. Message text and reasoning are never cut.
EXPORT_TOOL_OUTPUT_MAX_CHARS = 8000
# One line stating what the document is (and is not) based on.
EXPORT_BASIS = (
    "基于 QwenPaw 会话历史导出；上下文若已被后端压缩，早期轮次以历史接口返回为准；"
    "思考过程以折叠形式附后（若包含）；附件仅记录文件名等元信息，不含附件内容。"
)

_EXPORT_ROLE_LABELS = {
    "user": "用户",
    "assistant": "助手",
    "system": "系统",
    "tool": "工具",
}
_ATTACHMENT_TYPES = ("file", "image", "audio", "video", "attachment")
_ATTACHMENT_URL_FIELDS = ("file_url", "image_url", "video_url", "audio_url")


def _one_line(value):
    """Collapse *value* to one line without control characters.

    Newlines, tabs, NULs and the Unicode line separators all become spaces;
    runs of whitespace collapse. Used for anything that is spliced into a
    heading or an attachment line (titles, timestamps, file names).
    """
    if not isinstance(value, str):
        return ""
    chars = []
    for char in value:
        code = ord(char)
        if code < 0x20 or 0x7F <= code <= 0x9F or char in ("\u2028", "\u2029"):
            chars.append(" ")
        else:
            chars.append(char)
    return " ".join("".join(chars).split())


def safe_export_title(value, fallback=""):
    """Single-line title for the document header, or *fallback*.

    Control characters (including CR/LF) are replaced before the title is
    truncated by Unicode code point, so a title can neither break the Markdown
    structure nor end in the middle of a surrogate pair.
    """
    text = _one_line(value)
    if not text:
        text = _one_line(fallback)
    if not text:
        return ""
    if len(text) > EXPORT_TITLE_MAX_CHARS:
        return text[:EXPORT_TITLE_MAX_CHARS] + "…"
    return text


def _export_label(value, limit=200):
    """One safe, bounded label for a file/attachment line."""
    text = _one_line(value).replace("[", "(").replace("]", ")")
    if len(text) > limit:
        return text[:limit] + "…"
    return text


def _part_type(part):
    """Lower-case content-part discriminator (enum-safe)."""
    raw = part.get("type")
    raw = getattr(raw, "value", raw)
    text = str(raw or "").strip()
    if "." in text:
        text = text.rsplit(".", 1)[-1]
    return text.lower()


def _message_type(message):
    """Upper-case ``Message.type`` (``MESSAGE`` unless absent)."""
    raw = message.get("type")
    raw = getattr(raw, "value", raw)
    if raw is None:
        return "MESSAGE"
    text = str(raw).strip()
    if "." in text:
        text = text.rsplit(".", 1)[-1]
    return text.upper() or "MESSAGE"


def _message_role(message):
    raw = message.get("role")
    raw = getattr(raw, "value", raw)
    return _one_line(str(raw or "")).lower()


def _message_timestamp(message):
    metadata = message.get("metadata")
    if not isinstance(metadata, dict):
        return ""
    return _one_line(metadata.get("timestamp"))


def _fenced(text, lang=""):
    """Fence *text* with a backtick run longer than anything inside it."""
    fence = "```"
    while fence in text:
        fence += "`"
    return "%s%s\n%s\n%s" % (fence, lang, text, fence)


def _tool_name(data):
    name = _one_line(data.get("name")).replace("`", "'")
    return (name or "工具")[:80]


def _json_text(value):
    """String form of a tool argument/output value."""
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError):
        return str(value)


def _render_tool_call(data):
    body = _json_text(data.get("arguments")) or "{}"
    return "**工具调用** `%s`\n\n%s" % (
        _tool_name(data), _fenced(body, "json"),
    )


def _render_tool_output(data):
    body = _json_text(data.get("output"))
    original = len(body)
    truncated = original > EXPORT_TOOL_OUTPUT_MAX_CHARS
    if truncated:
        body = body[:EXPORT_TOOL_OUTPUT_MAX_CHARS]
    block = "**工具结果** `%s`\n\n%s" % (
        _tool_name(data), _fenced(body or "（无输出）"),
    )
    if truncated:
        block += "\n\n…（输出过长，已截断；原始 %d 个字符）" % original
    return block


def _folded_reasoning(text):
    """Collapsible thinking block; Markdown inside a raw HTML block."""
    return "<details>\n<summary>思考过程</summary>\n\n%s\n\n</details>" % text


def _is_attachment(part):
    if _part_type(part) in _ATTACHMENT_TYPES:
        return True
    filename = part.get("filename")
    if isinstance(filename, str) and filename.strip():
        return True
    for field in _ATTACHMENT_URL_FIELDS:
        if isinstance(part.get(field), str) and part.get(field):
            return True
    return False


def _attachment_name(part):
    """Bare file name of an attachment part (never a hosted absolute path)."""
    for field in ("filename", "name"):
        value = part.get(field)
        if isinstance(value, str) and value.strip():
            # A "filename" that is really a path still loses its directories.
            name = value.strip().replace("\\", "/").rsplit("/", 1)[-1]
            return _export_label(name)
    for field in _ATTACHMENT_URL_FIELDS + ("data",):
        value = part.get(field)
        if not (isinstance(value, str) and value):
            continue
        if value.startswith("data:"):
            return "内嵌附件"
        try:
            path = urlsplit(value).path
        except ValueError:
            path = value
        name = path.rstrip("/").replace("\\", "/").rsplit("/", 1)[-1]
        if name:
            return _export_label(name)
    return "附件"


def _attachment_mime(part):
    """Display MIME of an attachment: declared, data-URL or extension guess."""
    mime = _part_mime(part) or _data_url_mime(_part_url(part))
    if not mime:
        guessed, _encoding = mimetypes.guess_type(_attachment_name(part))
        mime = (guessed or "").lower()
    return mime or _DEFAULT_FILE_MIME


def _attachment_label(part):
    """One export placeholder: ``[附件: name · mime · size bytes]`` (M31).

    Never a path and never file content: the name is bare, the MIME is a
    label, and the size is the metadata ``os.stat`` reported (omitted when
    the file could not be measured).
    """
    text = "%s · %s" % (_attachment_name(part), _attachment_mime(part))
    size = _attachment_size(_part_url(part))
    if size is not None:
        text += " · %d bytes" % size
    return "[附件: %s]" % text


def _content_blocks(message, message_type):
    """Markdown blocks of one Message's content list, in order."""
    content = message.get("content")
    if isinstance(content, str):
        content = [{"type": "text", "text": content}]
    if not isinstance(content, list):
        return []

    blocks = []
    seen_attachments = set()
    for part in content:
        if isinstance(part, str):
            if part.strip():
                blocks.append(part)
            continue
        if not isinstance(part, dict):
            continue

        part_type = _part_type(part)
        data = part.get("data")

        if part_type == "text":
            text = part.get("text")
            if isinstance(text, str) and text.strip():
                blocks.append(text)
        elif part_type == "thinking":
            text = part.get("thinking")
            if isinstance(text, str) and text.strip():
                blocks.append(_folded_reasoning(text))
        elif part_type == "data" and isinstance(data, dict):
            if message_type == "PLUGIN_CALL_OUTPUT" or (
                "output" in data and "arguments" not in data
            ):
                blocks.append(_render_tool_output(data))
            elif message_type == "PLUGIN_CALL" or "arguments" in data:
                blocks.append(_render_tool_call(data))
        elif part_type in ("function_call", "tool_call", "tool_use"):
            blocks.append(_render_tool_call(part))
        elif part_type in (
            "function_call_output", "tool_result", "tool_output",
        ):
            blocks.append(_render_tool_output(part))
        elif _is_attachment(part):
            # G2-A stores an image as FileContent + ImageContent with the
            # same URL; one file must not become two placeholder lines.
            url = _part_url(part)
            if url:
                if url in seen_attachments:
                    continue
                seen_attachments.add(url)
            blocks.append(_attachment_label(part))
        else:
            text = part.get("text")
            if isinstance(text, str) and text.strip():
                blocks.append(text)
    return blocks


def _reasoning_text(message):
    """Concatenated thinking text of a REASONING message."""
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    texts = []
    for part in content:
        if isinstance(part, str):
            if part.strip():
                texts.append(part)
            continue
        if not isinstance(part, dict):
            continue
        part_type = _part_type(part)
        if part_type not in ("text", "thinking"):
            continue
        text = part.get("text") if part_type == "text" else part.get("thinking")
        if isinstance(text, str) and text.strip():
            texts.append(text)
    return "\n\n".join(texts)


def _turn_footnote(turn):
    """One blockquote line for a ``turn`` receipt, or "" without numbers.

    Rendered from the same receipt ``hist`` carries, so a footnote can never
    show a number the history projection does not report. Absent fields are
    skipped (never shown as 0); ``estimated`` appends a marker.
    """
    parts = []
    for key, label in (
        ("input", "输入"), ("output", "输出"), ("total", "合计"),
    ):
        value = turn.get(key)
        if not isinstance(value, int) or isinstance(value, bool):
            continue
        if value >= 0:
            parts.append("%s %s" % (label, format(value, ",")))
    if not parts:
        return ""
    line = "> 本轮用量：%s tokens" % " · ".join(parts)
    if turn.get("estimated") is True:
        line += "（估算）"
    return line


def _with_footnote(block, turn):
    """Append *turn*'s usage footnote to *block* when both exist."""
    footnote = _turn_footnote(turn) if isinstance(turn, dict) else ""
    return "%s\n\n%s" % (block, footnote) if footnote else block


def _render_message(message, turn=None):
    """One message as Markdown, or "" when it carries nothing to export.

    *turn* is the per-turn usage receipt attached to this message, if any;
    it becomes a footnote below the body.
    """
    message_type = _message_type(message)

    if message_type == "REASONING":
        text = _reasoning_text(message)
        return _with_footnote(_folded_reasoning(text), turn) if text else ""

    blocks = _content_blocks(message, message_type)
    if not blocks:
        return ""
    if message_type in ("PLUGIN_CALL", "PLUGIN_CALL_OUTPUT"):
        return _with_footnote("\n\n".join(blocks), turn)

    role = _message_role(message)
    heading = "### %s" % _EXPORT_ROLE_LABELS.get(role, "消息")
    timestamp = _message_timestamp(message)
    if timestamp:
        heading += " · %s" % timestamp
    return _with_footnote("%s\n\n%s" % (heading, "\n\n".join(blocks)), turn)


def build_export_markdown(
    history, chat, title, exported_at, agent="", model="",
):
    """Render a ``ChatHistory`` response as the export Markdown document.

    The header names the agent, the model when known, the export time, the
    number of rendered messages and the one-line basis statement. Messages
    keep their original order and type: ``MESSAGE`` becomes a role heading
    with body text, ``REASONING`` a ``<details>`` block, ``PLUGIN_CALL`` /
    ``PLUGIN_CALL_OUTPUT`` compact tool blocks, and attachments a
    ``[附件: name · mime · size bytes]`` metadata line (M31; one line per
    file, deduplicated by URL). An assistant message that carries a
    ``qwenpaw_turn_usage`` receipt gets one 本轮用量 footnote. An empty
    conversation yields the header only.
    """
    raw_messages = history.get("messages") if isinstance(history, dict) else None
    if not isinstance(raw_messages, list):
        raw_messages = []

    # Turn receipts follow the same rules as `hist`: one per persisted Msg,
    # anchored to its last assistant text segment.
    entries = _history_entries(raw_messages)
    _attach_history_turns(entries)
    turns = {
        entry["index"]: entry["turn"]
        for entry in entries
        if "turn" in entry
    }

    blocks = []
    for index, message in enumerate(raw_messages):
        if not isinstance(message, dict):
            continue
        block = _render_message(message, turns.get(index))
        if block:
            blocks.append(block)

    title_text = (
        safe_export_title(title)
        or safe_export_title(chat)
        or "会话"
    )
    header_lines = ["# %s" % title_text, ""]
    agent_text = safe_export_title(agent)
    if agent_text:
        header_lines.append("- 智能体：%s" % agent_text)
    model_text = safe_export_title(model)
    if model_text:
        header_lines.append("- 模型：%s" % model_text)
    header_lines.extend((
        "- 导出时间：%s" % (_one_line(exported_at) or "未知"),
        "- 消息条数：%d" % len(blocks),
        "- 导出口径：%s" % EXPORT_BASIS,
    ))
    return "\n\n".join(["\n".join(header_lines), *blocks]) + "\n"


def chunk_utf8(data, size=CHUNK_RAW_BYTES):
    """Split *data* into ``size``-byte chunks without splitting a code point.

    This is a pure byte-stream split (not aligned to messages). When a cut
    would land inside a multi-byte UTF-8 sequence, the boundary backs up to
    the start of that code point, so every chunk decodes on its own and the
    concatenation is byte-identical to *data*.
    """
    if isinstance(data, str):
        data = data.encode("utf-8")
    if not isinstance(data, (bytes, bytearray)):
        return []
    data = bytes(data)
    if not (_is_int(size) and size > 0):
        size = CHUNK_RAW_BYTES
    if not data:
        return []

    chunks = []
    start = 0
    total = len(data)
    while start < total:
        end = min(start + size, total)
        if end < total:
            # 0b10xxxxxx is a continuation byte: move back to the code point.
            while end > start and (data[end] & 0xC0) == 0x80:
                end -= 1
            if end == start:
                # A single sequence longer than *size* (impossible at 96 KB);
                # four bytes always cover one UTF-8 code point.
                end = min(start + 4, total)
        chunks.append(data[start:end])
        start = end
    return chunks


def sha256_hex(data):
    """Lower-case hex sha256 of *data* (``str`` inputs are UTF-8 encoded)."""
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(bytes(data)).hexdigest()


