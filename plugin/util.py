"""Pure-stdlib helpers shared by the WebChannel plugin.

No third-party or QwenPaw imports: this module is deliberately standalone so
it can be unit-tested without the host application installed.
"""

from collections import deque


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
