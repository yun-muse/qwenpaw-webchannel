#!/usr/bin/env python3
"""Standalone tests for the M2 decisions in the WebChannel plugin.

Covers A1 (trailing full-text ``msg``, message segment only -- reasoning
segments are labelled but never echoed), A3 (history extraction + 256 KB frame
splitting), A4 (inbound file decoding) and A5 (approval ownership). Every case
goes through the helpers ``channel.py`` actually calls, so the tests exercise
the shipped logic rather than a copy of it.

Run either way (no pytest required):

    cd plugin && python3 tests/test_m2.py
    cd plugin && python3 -m pytest tests/test_m2.py -q
"""

import base64
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_PLUGIN_DIR = os.path.dirname(_HERE)
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

import frames  # noqa: E402  (path setup must run before these imports)
from frames import (  # noqa: E402
    MAX_FRAME_BYTES,
    StreamDiffer,
    check_size,
    end_frame,
    evt_frame,
    hist_frame,
    start_frame,
)
from util import (  # noqa: E402
    ANSWER_STREAM_TYPE,
    DEFAULT_HIST_LIMIT,
    approval_owner_ok,
    decode_file_entry,
    hist_limit,
    history_messages,
    pack_history,
    trailing_msg_text,
)


def _text_message(role, *texts):
    """One ``ChatHistory.messages[]`` entry (qwenpaw.schemas.Message shape)."""
    return {"role": role, "content": [{"type": "text", "text": t} for t in texts]}


# --------------------------------------------------------------------------
# A1 -- trailing full-text msg after ``end``
# --------------------------------------------------------------------------

def test_trailing_msg_when_streamed_only():
    # A streamed answer: deltas reached the browser, send() never ran, so the
    # segment must be closed with the full text.
    assert trailing_msg_text("message", "Hello world", False) == "Hello world"


def test_trailing_msg_skipped_when_already_sent():
    # Non-streamed reply (or a send that already delivered the text).
    assert trailing_msg_text("message", "Hello world", True) == ""


def test_trailing_msg_skipped_when_nothing_streamed():
    assert trailing_msg_text("message", "", False) == ""
    assert trailing_msg_text("message", None, False) == ""


def test_trailing_msg_skipped_for_reasoning():
    # Reasoning is streamed as evt frames but is not the answer.
    assert trailing_msg_text("reasoning", "thinking out loud", False) == ""


def test_trailing_msg_uses_full_text_from_differ():
    # Same path as on_streaming_end: cumulative deltas -> differ, then the
    # stored full text decides the msg body (the concatenation of the deltas).
    differ = StreamDiffer()
    key = ("chat-1", "message")
    sent = []
    for cumulative in ("Hel", "Hello", "Hello wor", "Hello world"):
        delta = differ.diff(key, cumulative)
        if delta:
            sent.append(delta)
    assert sent == ["Hel", "lo", " wor", "ld"]
    assert differ.last(key) == "Hello world"
    assert trailing_msg_text("message", differ.last(key), False) == "".join(sent)
    differ.reset(key)
    assert differ.last(key) == ""


def test_trailing_msg_ordering_after_end():
    # evt tail -> end -> msg: reproduce the hook's frame sequence.
    differ = StreamDiffer()
    key = ("chat-1", "message")
    differ.diff(key, "partial")
    frames_out = []
    tail = differ.diff(key, "partial done")
    if tail:
        frames_out.append(("evt", tail))
    frames_out.append(("end", None))
    trailing = trailing_msg_text("message", differ.last(key), False)
    if trailing:
        frames_out.append(("msg", trailing))
    assert frames_out == [
        ("evt", " done"),
        ("end", None),
        ("msg", "partial done"),
    ]


def test_two_segments_never_mix():
    # One reply = reasoning segment + message segment, each diffed under its
    # own (chat, stream_type) key. Reasoning text was streamed and send()
    # never fired, yet only the message segment gets a trailing msg.
    differ = StreamDiffer()
    reasoning_key = ("chat-1", "reasoning")
    message_key = ("chat-1", ANSWER_STREAM_TYPE)
    assert differ.diff(reasoning_key, "Let me think") == "Let me think"
    assert differ.diff(message_key, "The answer") == "The answer"
    assert differ.diff(reasoning_key, "Let me think about it") == " about it"

    assert trailing_msg_text(
        "reasoning", differ.last(reasoning_key), False,
    ) == ""
    assert trailing_msg_text(
        ANSWER_STREAM_TYPE, differ.last(message_key), False,
    ) == "The answer"


def test_stream_segment_frames_label_their_type():
    # Every frame of a segment says which segment it belongs to, so clients
    # never concatenate reasoning deltas into the answer.
    assert evt_frame("c", 1, "hmm", "reasoning") == {
        "t": "evt", "chat": "c", "seq": 1,
        "data": {"text": "hmm", "stream_type": "reasoning"},
    }
    assert evt_frame("c", 2, "answer", ANSWER_STREAM_TYPE)["data"] == {
        "text": "answer", "stream_type": "message",
    }
    assert start_frame("c", 3, stream_type="reasoning") == {
        "t": "start", "chat": "c", "seq": 3, "stream_type": "reasoning",
    }
    assert end_frame("c", 3, stream_type=ANSWER_STREAM_TYPE) == {
        "t": "end", "chat": "c", "seq": 3, "stream_type": "message",
    }
    # Legacy callers keep the old frame shape (stream_type is additive).
    assert evt_frame("c", 4, "x")["data"] == {"text": "x"}
    assert "stream_type" not in start_frame("c", 5)
    assert "stream_type" not in end_frame("c", 5)


# --------------------------------------------------------------------------
# A3 -- history extraction
# --------------------------------------------------------------------------

def test_history_messages_extracts_role_and_text():
    history = {
        "messages": [
            _text_message("user", "hi"),
            _text_message("assistant", "Hello", " there"),
            {"role": "assistant", "content": [{"type": "data", "data": {}}]},
            {"role": "tool", "content": [{"type": "text", "text": "42"}]},
            {"role": "assistant", "content": []},
            {"role": "user", "content": ["plain string part"]},
        ],
        "status": "idle",
    }
    assert history_messages(history) == [
        {"role": "user", "text": "hi"},
        {"role": "assistant", "text": "Hello there"},
        {"role": "tool", "text": "42"},
        {"role": "user", "text": "plain string part"},
    ]


def test_history_messages_skips_textless_messages():
    history = {
        "messages": [
            {"role": "assistant", "content": [{"type": "text", "text": ""}]},
            {"role": "assistant", "content": [{"type": "image", "image_url": "x"}]},
            {"content": [{"type": "text", "text": "no role"}]},
        ],
    }
    assert history_messages(history) == [{"role": "", "text": "no role"}]


def test_history_messages_limit_and_default():
    history = {"messages": [_text_message("user", "m%d" % i) for i in range(60)]}
    default = history_messages(history)
    assert len(default) == DEFAULT_HIST_LIMIT == 50
    assert default[0]["text"] == "m10"  # last N, not first N
    assert default[-1]["text"] == "m59"
    assert history_messages(history, 3) == [
        {"role": "user", "text": "m57"},
        {"role": "user", "text": "m58"},
        {"role": "user", "text": "m59"},
    ]
    assert len(history_messages(history, 1000)) == 60


def test_history_messages_tolerates_bad_shapes():
    assert history_messages(None) == []
    assert history_messages({}) == []
    assert history_messages({"messages": "nope"}) == []
    assert history_messages({"messages": [None, 7, "x"]}) == []


def test_hist_limit_normalisation():
    assert hist_limit(None) == DEFAULT_HIST_LIMIT
    assert hist_limit("") == DEFAULT_HIST_LIMIT
    assert hist_limit("7") == 7
    assert hist_limit(7) == 7
    assert hist_limit(0) == DEFAULT_HIST_LIMIT
    assert hist_limit(-3) == DEFAULT_HIST_LIMIT
    assert hist_limit("abc") == DEFAULT_HIST_LIMIT
    assert hist_limit(True) == 1  # bool is an int; harmless


# --------------------------------------------------------------------------
# A3 -- 256 KB frame splitting
# --------------------------------------------------------------------------

def _chunk_frame(chunk):
    """Widest variant: non-final hist frames carry ``more: true``."""
    return hist_frame("chat-1", chunk, more=True)


def test_pack_history_keeps_frames_under_limit():
    messages = [
        {"role": "assistant", "text": "%03d" % i + "x" * 10_000}
        for i in range(40)
    ]
    chunks = pack_history(messages, lambda c: check_size(_chunk_frame(c)))
    assert len(chunks) > 1, "10k-char messages must not all fit in one frame"
    assert [m for chunk in chunks for m in chunk] == messages  # order kept
    assert all(chunk for chunk in chunks)
    for index, chunk in enumerate(chunks):
        frame = hist_frame("chat-1", chunk, more=index < len(chunks) - 1)
        assert check_size(frame) is True
        assert frames._encoded_size(frame) <= MAX_FRAME_BYTES
        # "more" is set on every frame but the last
        assert ("more" in frame) is (index < len(chunks) - 1)


def test_pack_history_single_frame_when_small():
    def fits(chunk):
        return check_size(_chunk_frame(chunk))

    messages = [{"role": "user", "text": "hi"}]
    assert pack_history(messages, fits) == [messages]
    assert pack_history([], fits) == []


def test_pack_history_oversize_message_alone():
    # A single message bigger than the limit cannot be split without changing
    # its text: it still becomes its own (oversized) chunk for the caller.
    huge = [{"role": "assistant", "text": "y" * (MAX_FRAME_BYTES + 1)}]
    chunks = pack_history(huge, lambda c: check_size(_chunk_frame(c)))
    assert chunks == [huge]


def test_hist_frame_shape():
    assert hist_frame("c", [{"role": "user", "text": "hi"}]) == {
        "t": "hist", "chat": "c", "messages": [{"role": "user", "text": "hi"}],
    }
    assert hist_frame("c", [], more=True, seq=4) == {
        "t": "hist", "chat": "c", "messages": [], "more": True, "seq": 4,
    }


# --------------------------------------------------------------------------
# A4 -- inbound file decoding
# --------------------------------------------------------------------------

def test_decode_file_entry():
    payload = base64.b64encode(b"hello file").decode("ascii")
    assert decode_file_entry(
        {"name": "notes.txt", "mime": "text/plain", "data": payload},
    ) == ("notes.txt", "text/plain", b"hello file")


def test_decode_file_entry_wrapped_base64():
    payload = base64.encodebytes(b"x" * 120).decode("ascii")  # has newlines
    assert decode_file_entry({"name": "a.txt", "data": payload}) == (
        "a.txt", "application/octet-stream", b"x" * 120,
    )


def test_decode_file_entry_defaults_and_rejects():
    assert decode_file_entry({"data": base64.b64encode(b"z").decode()}) == (
        "file", "application/octet-stream", b"z",
    )
    assert decode_file_entry(
        {"name": "  ", "mime": "", "data": "!!notbase64!!"},
    ) is None
    assert decode_file_entry({"name": "a.txt"}) is None
    assert decode_file_entry({"name": "a.txt", "data": ""}) is None
    assert decode_file_entry({"name": "a.txt", "data": "   "}) is None
    empty = base64.b64encode(b"").decode()
    assert decode_file_entry({"name": "a.txt", "data": empty}) is None
    assert decode_file_entry({"name": "a.txt", "data": 42}) is None
    assert decode_file_entry("a.txt") is None
    assert decode_file_entry(None) is None


# --------------------------------------------------------------------------
# A5 -- approval ownership
# --------------------------------------------------------------------------

def test_approval_allow_when_owner_matches():
    pending = {
        "request_id": "r1", "owner_agent_id": "agent-a", "agent_id": "agent-a",
    }
    assert approval_owner_ok(pending, "agent-a") is True


def test_approval_deny_when_not_found():
    # Not pending (or the /api/approval/list call failed): never POST.
    assert approval_owner_ok(None, "agent-a") is False
    assert approval_owner_ok({}, "agent-a") is True  # present, no owner field
    assert approval_owner_ok("nope", "agent-a") is False


def test_approval_deny_on_agent_mismatch():
    assert approval_owner_ok({"owner_agent_id": "agent-b"}, "agent-a") is False
    assert approval_owner_ok({"agent_id": "agent-b"}, "agent-a") is False
    # owner_agent_id wins over agent_id when both are present
    assert approval_owner_ok(
        {"owner_agent_id": "agent-b", "agent_id": "agent-a"}, "agent-a",
    ) is False


def test_approval_falls_back_to_agent_id():
    assert approval_owner_ok(
        {"owner_agent_id": None, "agent_id": "agent-a"}, "agent-a",
    ) is True
    assert approval_owner_ok(
        {"owner_agent_id": None, "agent_id": "agent-b"}, "agent-a",
    ) is False


def test_approval_presence_only_without_owner_fields():
    # Neither field determinable: accept on presence alone (A5, keep it simple).
    assert approval_owner_ok({"request_id": "r1"}, "agent-a") is True
    assert approval_owner_ok(
        {"request_id": "r1", "owner_agent_id": "", "agent_id": ""}, "agent-a",
    ) is True


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
