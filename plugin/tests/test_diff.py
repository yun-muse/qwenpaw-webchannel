#!/usr/bin/env python3
"""Standalone tests for the WebChannel plugin's pure helpers.

Run either way (no pytest required):

    cd plugin && python3 tests/test_diff.py
    cd plugin && python3 -m pytest tests/test_diff.py -q
"""

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_PLUGIN_DIR = os.path.dirname(_HERE)
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

import frames  # noqa: E402  (module, for the private size helper in the
#               boundary test; path setup must run first)
from frames import (  # noqa: E402
    MAX_FRAME_BYTES,
    RingBuffer,
    SeqCounter,
    StreamDiffer,
    approval_frame,
    check_size,
    end_frame,
    error_frame,
    evt_frame,
    msg_frame,
    parse_inbound,
    resync_frame,
    start_frame,
)


# --------------------------------------------------------------------------
# StreamDiffer
# --------------------------------------------------------------------------

def test_diff_basic_suffixes():
    d = StreamDiffer()
    assert d.diff("k", "Hello") == "Hello"
    assert d.diff("k", "Hello world") == " world"
    assert d.diff("k", "Hello world!") == "!"


def test_diff_unchanged_returns_empty():
    d = StreamDiffer()
    assert d.diff("k", "abc") == "abc"
    assert d.diff("k", "abc") == ""


def test_diff_empty_chunk():
    d = StreamDiffer()
    # first call with empty accumulated text yields nothing
    assert d.diff("k", "") == ""
    assert d.diff("k", "") == ""
    assert d.diff("k", "x") == "x"
    # a later empty cumulative value cannot be a suffix of "x" -- it replaces
    # the segment, but the replacement itself is empty, so still nothing to send
    assert d.diff("k", "") == ""
    assert d.diff("k", "y") == "y"


def test_diff_coalesced_jump():
    # BaseChannel may skip intermediate flushes; the hook then delivers a
    # fuller cumulative string. Only the unseen suffix must be sent.
    d = StreamDiffer()
    assert d.diff("k", "Hel") == "Hel"
    assert d.diff("k", "Hello world!") == "lo world!"
    assert d.diff("k", "Hello world! done") == " done"


def test_diff_segment_reset_via_reset():
    d = StreamDiffer()
    assert d.diff("k", "first segment") == "first segment"
    d.reset("k")
    assert d.diff("k", "second") == "second"
    # reset() only clears one key, unknown keys are ignored
    d.reset("missing")
    d.reset("other")
    assert d.diff("k", "second!") == "!"
    d.clear()
    assert d.diff("k", "third") == "third"


def test_diff_non_prefix_replacement():
    d = StreamDiffer()
    assert d.diff("k", "Hello world") == "Hello world"
    # replacement that does not extend the stored text: resend the whole thing
    assert d.diff("k", "Goodbye") == "Goodbye"
    assert d.diff("k", "Goodbye now") == " now"


def test_diff_keys_are_independent():
    d = StreamDiffer()
    assert d.diff(("chat", "text"), "abc") == "abc"
    assert d.diff(("chat", "reasoning"), "xyz") == "xyz"
    assert d.diff(("chat", "text"), "abcd") == "d"
    assert d.diff(("chat", "reasoning"), "xyz!") == "!"
    d.clear()
    assert d.diff(("chat", "text"), "abc") == "abc"


# --------------------------------------------------------------------------
# SeqCounter
# --------------------------------------------------------------------------

def test_seq_monotonic_per_chat():
    c = SeqCounter()
    assert c.peek("a") == 0
    assert c.next("a") == 1
    assert c.next("a") == 2
    assert c.next("b") == 1  # independent counter per chat
    assert c.next("a") == 3
    assert c.next("b") == 2
    assert c.peek("a") == 3  # peek does not advance
    assert c.next("a") == 4
    assert c.peek("b") == 2
    assert c.peek("unknown") == 0


# --------------------------------------------------------------------------
# RingBuffer
# --------------------------------------------------------------------------

def test_ring_buffer_hit():
    buf = RingBuffer()
    frames = []
    for seq in range(1, 6):
        frame = {"t": "evt", "chat": "c", "seq": seq}
        frames.append(frame)
        buf.append("c", seq, frame)

    assert buf.since("c", 2) == frames[2:]  # seq 3,4,5
    assert buf.since("c", 1) == frames[1:]  # seq 2..5
    assert buf.since("c", 0) == frames  # full replay


def test_ring_buffer_empty_and_up_to_date():
    buf = RingBuffer()
    # unknown chat, client has seen nothing: nothing to replay
    assert buf.since("missing", 0) == []
    # unknown chat but the client claims progress we cannot serve
    # (e.g. container restart): miss -> resync
    assert buf.since("missing", 5) is None
    buf.append("c", 1, {"seq": 1})
    assert buf.since("c", 1) == []  # caught up
    assert buf.since("c", 99) == []  # beyond newest seq: still []


def test_ring_buffer_miss():
    buf = RingBuffer(maxlen=3)
    for seq in range(1, 6):
        buf.append("c", seq, {"seq": seq})
    # eviction kept only seqs 3,4,5
    # asking from 1 would leave a gap at 2 -> miss
    assert buf.since("c", 1) is None
    # oldest retained is 3, so last_seq == 2 is exactly recoverable
    assert [f["seq"] for f in buf.since("c", 2)] == [3, 4, 5]
    assert [f["seq"] for f in buf.since("c", 4)] == [5]
    # beyond newest
    assert buf.since("c", 5) == []


def test_ring_buffer_is_per_chat():
    buf = RingBuffer()
    buf.append("a", 1, {"seq": 1, "chat": "a"})
    buf.append("b", 1, {"seq": 1, "chat": "b"})
    assert buf.since("a", 0) == [{"seq": 1, "chat": "a"}]
    assert buf.since("b", 0) == [{"seq": 1, "chat": "b"}]
    assert buf.since("c", 0) == []


# --------------------------------------------------------------------------
# Frame builders / parser (smoke)
# --------------------------------------------------------------------------

def test_frame_builders():
    assert evt_frame("c", 1, "hi") == {
        "t": "evt", "chat": "c", "seq": 1, "data": {"text": "hi"},
    }
    assert start_frame("c", 1) == {"t": "start", "chat": "c", "seq": 1}
    assert start_frame("c") == {"t": "start", "chat": "c"}  # seq is optional
    assert end_frame("c", 2) == {"t": "end", "chat": "c", "seq": 2}
    assert msg_frame("c", 3, [{"type": "text", "text": "x"}]) == {
        "t": "msg", "chat": "c", "seq": 3,
        "parts": [{"type": "text", "text": "x"}],
    }
    assert approval_frame("c", "r1", seq=4, tool="shell", severity="high") == {
        "t": "approval", "chat": "c", "req_id": "r1", "seq": 4,
        "tool": "shell", "severity": "high",
    }
    # reserved key "t" cannot be overridden via kwargs (chat/req_id are
    # positional/keyword-only by construction of the signature)
    assert approval_frame("c", "r2", t="oops")["t"] == "approval"
    assert resync_frame("c") == {"t": "resync", "chat": "c"}
    assert resync_frame("c", "gap") == {"t": "resync", "chat": "c", "reason": "gap"}
    assert error_frame("E_TOOBIG") == {"t": "error", "code": "E_TOOBIG"}
    assert error_frame("E_BADFRAME", "bad json") == {
        "t": "error", "code": "E_BADFRAME", "detail": "bad json",
    }


def test_parse_inbound():
    assert parse_inbound('{"t":"ping"}') == {"t": "ping"}
    assert parse_inbound(b'{"t":"msg","chat":"c"}') == {"t": "msg", "chat": "c"}
    assert parse_inbound("not json") is None
    assert parse_inbound('["t"]') is None
    assert parse_inbound('{"t":1}') is None
    assert parse_inbound('{"chat":"c"}') is None
    assert parse_inbound(b"\xff\xfe") is None
    assert parse_inbound(None) is None


def test_check_size():
    assert check_size({"t": "ping"}) is True
    big = {"t": "msg", "parts": [{"type": "text", "text": "x" * MAX_FRAME_BYTES}]}
    assert check_size(big) is False
    assert check_size({"t": "x", "blob": object()}) is False


def test_check_size_exact_limit():
    base = msg_frame("c", 1, [{"type": "text", "text": ""}])
    filler = "a" * (MAX_FRAME_BYTES - frames._encoded_size(base))
    at = msg_frame("c", 1, [{"type": "text", "text": filler}])
    assert frames._encoded_size(at) == MAX_FRAME_BYTES
    assert check_size(at) is True
    over = msg_frame("c", 1, [{"type": "text", "text": filler + "b"}])
    assert check_size(over) is False


# --------------------------------------------------------------------------
# Runner
# --------------------------------------------------------------------------

def main():
    tests = [
        (name, obj)
        for name, obj in sorted(globals().items())
        if name.startswith("test_") and callable(obj)
    ]
    failures = 0
    for name, test in tests:
        try:
            test()
        except Exception as exc:  # noqa: BLE001 - report and continue
            failures += 1
            print("FAIL %s: %s: %s" % (name, type(exc).__name__, exc))
        else:
            print("ok   %s" % name)
    if failures:
        print("%d test(s) failed" % failures)
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
