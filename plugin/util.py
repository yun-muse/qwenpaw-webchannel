"""Pure-stdlib helpers shared by the WebChannel plugin.

No third-party or QwenPaw imports: this module is deliberately standalone so
it can be unit-tested without the host application installed.
"""

import base64
import binascii
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
