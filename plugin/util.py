"""Pure-stdlib helpers shared by the WebChannel plugin.

No third-party or QwenPaw imports: this module is deliberately standalone so
it can be unit-tested without the host application installed.
"""

import base64
import binascii
import hashlib
from collections import deque

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


def history_messages(history, limit=DEFAULT_HIST_LIMIT):
    """Extract ``[{role, text}]`` from a ``ChatHistory``-shaped dict.

    ``GET /api/chats/{id}`` answers ``{messages: [Message...], status}`` where
    every ``Message`` (qwenpaw.schemas) is ``{role, content: [parts]...}``.
    Text parts of one message are concatenated; messages without text (tool
    calls, empty turns) are skipped. Only the last *limit* messages are kept.
    """
    if not isinstance(history, dict):
        return []
    raw = history.get("messages")
    if not isinstance(raw, list):
        return []

    messages = []
    for message in raw:
        if not isinstance(message, dict):
            continue
        text = "".join(_part_texts(message.get("content")))
        if not text:
            continue
        role = message.get("role")
        role = getattr(role, "value", role)
        messages.append({"role": str(role or ""), "text": text})

    limit = hist_limit(limit)
    return messages[-limit:]


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


def model_items(providers, active_provider="", active_model=""):
    """Project ``ProviderInfo`` dicts to ``[{provider, model, active}]``.

    Only the console-eligible providers/models are listed (see
    ``_provider_eligible``), and only ``provider`` / ``model`` / ``active``
    are copied out -- credential material such as ``api_key`` never reaches
    the client.

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
            for model_id in model_ids:
                items.append({
                    "provider": provider_id,
                    "model": model_id,
                    "active": (
                        provider_id == active_provider
                        and model_id == active_model
                    ),
                })

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


