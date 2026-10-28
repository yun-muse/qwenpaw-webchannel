#!/usr/bin/env python3
"""Standalone tests for M15: per-turn usage receipts and the context meter.

Covers the ``hist`` projection (``history_messages`` attaching one ``turn``
per persisted ``Msg``), the ``usage`` frame's ``last_turn``, the revised
``context_tokens`` numerator (``last_prompt_tokens`` first) and the newest
assistant lookup in ``SessionUsageStore``.

Run either way (no pytest required; needs httpx for ``channel``):

    cd plugin && python3 tests/test_m15.py
    cd plugin && python3 -m pytest tests/test_m15.py -q
"""

import asyncio
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

_HERE = os.path.dirname(os.path.abspath(__file__))
_PLUGIN_DIR = os.path.dirname(_HERE)
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

from channel import WebChannel  # noqa: E402  (path setup must run first)
from frames import usage_frame  # noqa: E402
from util import (  # noqa: E402
    TURN_USAGE_META_KEY,
    SessionUsageStore,
    history_messages,
    message_usage,
    session_last_turn,
    session_usage,
)

WEB_CHAT = "chat-15"
CHAT_UUID = "22222222-2222-2222-2222-222222222222"
SESSION_ID = "web:web-user:%s" % WEB_CHAT


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------

def _usage(prompt=100, completion=20, **extra):
    usage = {}
    if prompt is not None:
        usage["prompt_tokens"] = prompt
    if completion is not None:
        usage["completion_tokens"] = completion
    usage.update(extra)
    return usage


def _history_message(
    role, text, oid=None, mtype="message", usage=None,
    context_usage=None, timestamp=None, finished_at=None, outer=False,
):
    """One raw ``Message`` as ``GET /api/chats/{id}`` returns it."""
    metadata = {}
    if oid is not None:
        metadata["original_id"] = oid
    if timestamp is not None:
        metadata["timestamp"] = timestamp
    if finished_at is not None:
        metadata["finished_at"] = finished_at
    if usage is not None or context_usage is not None:
        turn = {}
        if usage is not None:
            turn["usage"] = usage
        if context_usage is not None:
            turn["context_usage"] = context_usage
        if outer:
            metadata[TURN_USAGE_META_KEY] = turn
        else:
            metadata["metadata"] = {TURN_USAGE_META_KEY: turn}
    return {
        "role": role,
        "type": mtype,
        "content": [{"type": "text", "text": text}],
        "metadata": metadata,
    }


def _session_message(role, mid=None, usage=None, created=None, finished=None):
    message = {
        "role": role,
        "content": [{"type": "text", "text": "…"}],
        "metadata": {},
    }
    if mid is not None:
        message["id"] = mid
    if usage is not None:
        message["metadata"][TURN_USAGE_META_KEY] = {"usage": usage}
    if created is not None:
        message["created_at"] = created
    if finished is not None:
        message["finished_at"] = finished
    return message


def _session_data(messages, session_id=SESSION_ID):
    return {"agent": {"state": {"context": messages}}, "session_id": session_id}


class _FakeApp:
    """Recording stand-in for ``channel._api_json``."""

    def __init__(self):
        self.calls = []

    async def __call__(self, method, path, params=None, json_body=None):
        self.calls.append({"method": method, "path": path})
        if method == "GET" and path == "/api/chats":
            return 200, [{
                "id": CHAT_UUID,
                "channel": "web",
                "session_id": SESSION_ID,
            }]
        if method == "GET" and path == "/api/models/active":
            return 200, {
                "active_llm": {"provider_id": "openai", "model": "gpt-4o"},
                "effective_max_input_length": 200000,
            }
        return 404, {"detail": "unexpected request %s %s" % (method, path)}


class _RecordingRelay:
    def __init__(self):
        self.sent = []

    async def send(self, frame):
        self.sent.append(frame)


class _Workspace:
    def __init__(self, workspace_dir):
        self.workspace_dir = str(workspace_dir)


def _channel(workspace_dir):
    channel = WebChannel(process=None)
    channel._agent_id = lambda: "agent-1"
    channel._workspace = _Workspace(workspace_dir)
    channel._api_json = _FakeApp()
    channel._relay = _RecordingRelay()
    return channel


# --------------------------------------------------------------------------
# hist: one receipt per persisted Msg, on the text anchor
# --------------------------------------------------------------------------

def test_history_turn_attached_once_to_text_anchor():
    usage = _usage(prompt=1234, completion=567, total_tokens=1801)
    history = {"messages": [
        _history_message("user", "question"),
        _history_message(
            "assistant", "thinking…", oid="m1", mtype="reasoning",
            usage=usage,
        ),
        _history_message(
            "assistant", '{"tool":"search"}', oid="m1", mtype="plugin_call",
            usage=usage,
        ),
        _history_message("assistant", "the answer", oid="m1", usage=usage),
    ]}
    messages = history_messages(history)
    assert [m["role"] for m in messages] == [
        "user", "assistant", "assistant", "assistant",
    ]
    assert "turn" not in messages[1]
    assert "turn" not in messages[2]
    assert messages[3]["turn"] == {
        "id": "m1", "input": 1234, "output": 567, "total": 1801,
    }
    # Exactly one receipt for the whole split Msg.
    assert sum("turn" in m for m in messages) == 1


def test_history_anchor_is_last_text_segment():
    usage = _usage(prompt=10, completion=2)
    history = {"messages": [
        _history_message("assistant", "first paragraph", oid="m1", usage=usage),
        _history_message("assistant", "last paragraph", oid="m1", usage=usage),
        _history_message(
            "assistant", "tool output card", oid="m1",
            mtype="plugin_call_output", usage=usage,
        ),
    ]}
    messages = history_messages(history)
    assert "turn" not in messages[0]
    assert messages[1]["turn"]["id"] == "m1"
    assert "turn" not in messages[2]


def test_history_turns_per_original_id():
    history = {"messages": [
        _history_message("user", "q1"),
        _history_message(
            "assistant", "a1", oid="m1", usage=_usage(prompt=100, completion=10),
        ),
        _history_message("user", "q2"),
        _history_message(
            "assistant", "a2", oid="m2", usage=_usage(prompt=200, completion=20),
        ),
    ]}
    messages = history_messages(history)
    assert messages[1]["turn"] == {
        "id": "m1", "input": 100, "output": 10, "total": 110,
    }
    assert messages[3]["turn"] == {
        "id": "m2", "input": 200, "output": 20, "total": 220,
    }
    assert "turn" not in messages[0]
    assert "turn" not in messages[2]


def test_history_without_usage_keeps_exact_shape():
    history = {"messages": [
        _history_message("user", "hi"),
        _history_message("assistant", "hello", oid="m1"),
        {"role": "tool", "content": [{"type": "text", "text": "42"}]},
    ]}
    assert history_messages(history) == [
        {"role": "user", "text": "hi"},
        {"role": "assistant", "text": "hello"},
        {"role": "tool", "text": "42"},
    ]


def test_history_conflicting_usage_drops_the_turn():
    history = {"messages": [
        _history_message(
            "assistant", "part", oid="m1",
            usage=_usage(prompt=10, completion=1),
        ),
        _history_message(
            "assistant", "answer", oid="m1",
            usage=_usage(prompt=99, completion=9),
        ),
    ]}
    assert "turn" not in history_messages(history)[1]

    same = {"messages": [
        _history_message(
            "assistant", "part", oid="m1",
            usage=_usage(prompt=10, completion=1),
        ),
        _history_message(
            "assistant", "answer", oid="m1",
            usage=_usage(prompt=10, completion=1),
        ),
    ]}
    assert history_messages(same)[1]["turn"]["input"] == 10


def test_history_limit_keeps_anchor_turn():
    history = {"messages": [
        _history_message("user", "q1"),
        _history_message(
            "assistant", "a1", oid="m1", usage=_usage(prompt=10, completion=1),
        ),
        _history_message("user", "q2"),
        _history_message(
            "assistant", "a2", oid="m2", usage=_usage(prompt=20, completion=2),
        ),
    ]}
    # Window contains both turns: both receipts survive.
    assert history_messages(history, 2) == [
        {"role": "user", "text": "q2"},
        {
            "role": "assistant", "text": "a2",
            "turn": {"id": "m2", "input": 20, "output": 2, "total": 22},
        },
    ]
    # The anchor itself is the only visible message.
    assert history_messages(history, 1)[0]["turn"]["id"] == "m2"


def test_history_estimated_and_partial_fields():
    partial = {"messages": [
        _history_message(
            "assistant", "a", oid="m1",
            usage=_usage(prompt=10, completion=None, estimated=True),
        ),
    ]}
    assert history_messages(partial)[0]["turn"] == {
        "id": "m1", "input": 10, "estimated": True,
    }

    exact = {"messages": [
        _history_message(
            "assistant", "a", oid="m1",
            usage=_usage(
                prompt="12", completion=3, total_tokens=99, estimated=False,
            ),
        ),
    ]}
    assert history_messages(exact)[0]["turn"] == {
        "id": "m1", "input": 12, "output": 3, "total": 99,
    }

    no_tokens = {"messages": [
        _history_message(
            "assistant", "a", oid="m1",
            usage=_usage(prompt=None, completion=None),
        ),
    ]}
    assert "turn" not in history_messages(no_tokens)[0]


def test_history_duration_needs_both_timestamps():
    def history_for(timestamp, finished_at):
        return {"messages": [_history_message(
            "assistant", "a", oid="m1",
            usage=_usage(prompt=10, completion=1),
            timestamp=timestamp, finished_at=finished_at,
        )]}

    full = history_messages(history_for(
        "2026-10-28T10:00:00+08:00", "2026-10-28T10:00:12.500+08:00",
    ))
    assert full[0]["turn"]["duration_ms"] == 12500

    assert "duration_ms" not in history_messages(history_for(
        "2026-10-28T10:00:00+08:00", None,
    ))[0]["turn"]
    assert "duration_ms" not in history_messages(history_for(
        "not-a-time", "2026-10-28T10:00:12+08:00",
    ))[0]["turn"]
    assert "duration_ms" not in history_messages(history_for(
        "2026-10-28T10:00:12+08:00", "2026-10-28T10:00:00+08:00",
    ))[0]["turn"]
    assert "duration_ms" not in history_messages(history_for(
        "2026-10-28T10:00:00", "2026-10-28T10:00:12+08:00",
    ))[0]["turn"]


def test_history_accepts_outer_usage_metadata():
    history = {"messages": [
        _history_message(
            "assistant", "a", oid="m1", outer=True,
            usage=_usage(prompt=7, completion=1),
        ),
    ]}
    assert history_messages(history)[0]["turn"]["input"] == 7


def test_history_without_original_id_gets_no_turn():
    history = {"messages": [
        _history_message(
            "assistant", "a", usage=_usage(prompt=10, completion=1),
        ),
    ]}
    assert history_messages(history) == [{"role": "assistant", "text": "a"}]


# --------------------------------------------------------------------------
# usage.last_turn: newest assistant only, never an older one
# --------------------------------------------------------------------------

def test_session_last_turn_is_the_newest_assistant():
    messages = [
        _session_message(
            "assistant", "a1", _usage(prompt=100, completion=10),
            created="2026-10-28T10:00:00+08:00",
            finished="2026-10-28T10:00:01.250+08:00",
        ),
        _session_message("user"),
        _session_message(
            "assistant", "a2",
            _usage(prompt=200, completion=20, total_tokens=250),
            created="2026-10-28T10:01:00+08:00",
            finished="2026-10-28T10:01:02+08:00",
        ),
    ]
    assert session_last_turn(messages) == {
        "id": "a2", "input": 200, "output": 20, "total": 250,
        "duration_ms": 2000,
    }


def test_session_last_turn_without_usage_is_none():
    messages = [
        _session_message(
            "assistant", "a1", _usage(prompt=100, completion=10),
        ),
        _session_message("assistant", "a2"),
    ]
    # The newest assistant reply has no usage: no fallback to a1.
    assert session_last_turn(messages) is None
    assert session_last_turn([]) is None
    assert session_last_turn(None) is None


def test_session_last_turn_requires_an_id():
    messages = [
        _session_message(
            "assistant", None, _usage(prompt=100, completion=10),
        ),
    ]
    assert session_last_turn(messages) is None


def test_session_last_turn_partial_and_estimated():
    messages = [
        _session_message(
            "assistant", "a1",
            _usage(prompt=10, completion=None, estimated=True),
        ),
    ]
    assert session_last_turn(messages) == {
        "id": "a1", "input": 10, "estimated": True,
    }


# --------------------------------------------------------------------------
# context_tokens numerator
# --------------------------------------------------------------------------

def test_context_prefers_last_prompt_tokens():
    messages = [
        _session_message("assistant", "a1", _usage(
            prompt=3000, completion=200, last_prompt_tokens=900,
        )),
        _session_message("assistant", "a2", _usage(
            prompt=5000, completion=100, last_prompt_tokens=1200,
        )),
    ]
    usage = session_usage(messages)
    assert usage["input_total"] == 8000  # accumulated prompts still sum
    assert usage["context_tokens"] == 1200  # but the meter uses the last call
    assert usage["input_total"] > usage["context_tokens"]


def test_context_falls_back_to_estimate_then_prompt():
    estimate = [
        _session_message("assistant", "a", _usage(prompt=800)),
    ]
    # No last_prompt_tokens, context_usage carries the state estimate.
    estimate[0]["metadata"][TURN_USAGE_META_KEY]["context_usage"] = {
        "estimated_tokens": 650,
    }
    assert session_usage(estimate)["context_tokens"] == 650

    prompt = [
        _session_message("assistant", "a", _usage(prompt=700)),
    ]
    assert session_usage(prompt)["context_tokens"] == 700

    # A 0 last_prompt_tokens is not a usable size: fall through.
    zero = [
        _session_message("assistant", "a", _usage(
            prompt=640, last_prompt_tokens=0,
        )),
    ]
    assert session_usage(zero)["context_tokens"] == 640


def test_context_keeps_previous_value_when_last_turn_has_none():
    messages = [
        _session_message("assistant", "a1", _usage(
            prompt=500, last_prompt_tokens=400,
        )),
        _session_message("assistant", "a2", _usage(
            prompt=0, completion=5,
        )),
    ]
    assert session_usage(messages)["context_tokens"] == 400


def test_session_usage_keeps_its_keys():
    # The revision must not add/remove keys on the cumulative dict.
    assert set(session_usage([
        _session_message("assistant", "a", _usage(prompt=1, completion=1)),
    ])) == {"input_total", "output_total", "context_tokens"}


# --------------------------------------------------------------------------
# Frames and the get_usage handler
# --------------------------------------------------------------------------

def test_usage_frame_with_last_turn():
    turn = {"id": "m1", "input": 12, "output": 3, "total": 15}
    frame = usage_frame("c", req_id="usage-get", last_turn=turn)
    assert frame == {
        "t": "usage", "chat": "c", "id": "usage-get", "last_turn": turn,
    }
    assert "seq" not in frame
    assert "last_turn" not in usage_frame("c", last_turn={})
    assert "last_turn" not in usage_frame("c", last_turn=["nope"])


def test_get_usage_handler_includes_last_turn():
    root = Path(tempfile.mkdtemp(prefix="m15-handler-"))
    try:
        session = root / "sessions" / "web"
        session.mkdir(parents=True)
        (session / "mine.json").write_text(json.dumps(_session_data([
            _session_message("user"),
            _session_message(
                "assistant", "a1",
                _usage(prompt=3000, completion=200, last_prompt_tokens=900),
                created="2026-10-28T10:00:00+08:00",
                finished="2026-10-28T10:00:04+08:00",
            ),
        ])), encoding="utf-8")

        channel = _channel(root)
        asyncio.run(channel._on_relay_frame(
            {"t": "get_usage", "chat": WEB_CHAT, "id": "usage-get"},
        ))
        frames = [f for f in channel._relay.sent if f.get("t") == "usage"]
        assert len(frames) == 1, channel._relay.sent
        assert frames[0] == {
            "t": "usage",
            "chat": WEB_CHAT,
            "id": "usage-get",
            "input_total": 3000,
            "output_total": 200,
            "context_tokens": 900,
            "context_limit": 200000,
            "last_turn": {
                "id": "a1", "input": 3000, "output": 200, "total": 3200,
                "duration_ms": 4000,
            },
        }
        assert "seq" not in frames[0]
        # Control frame: nothing entered the replay ring.
        assert channel._seq.peek(WEB_CHAT) == 0
        assert channel._ring.since(WEB_CHAT, 0) == []
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_store_usage_for_unchanged_and_last_turn_available():
    root = Path(tempfile.mkdtemp(prefix="m15-store-"))
    try:
        session = root / "web"
        session.mkdir(parents=True)
        (session / "mine.json").write_text(json.dumps(_session_data([
            _session_message(
                "assistant", "a1",
                _usage(prompt=100, completion=10),
            ),
        ])), encoding="utf-8")
        store = SessionUsageStore()
        assert store.usage_for(root, SESSION_ID, WEB_CHAT, "") == {
            "input_total": 100,
            "output_total": 10,
            "context_tokens": 100,
        }
        usage, last_turn = store.usage_and_last_turn_for(
            root, SESSION_ID, WEB_CHAT, "",
        )
        assert usage["input_total"] == 100
        assert last_turn == {"id": "a1", "input": 100, "output": 10, "total": 110}
        # Unknown session still yields nothing at all.
        assert store.usage_and_last_turn_for(root, "nope", "nope", "") == ({}, None)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_message_usage_unchanged():
    message = _session_message("assistant", "a", _usage(prompt=5, completion=1))
    assert message_usage(message) == {
        "prompt_tokens": 5, "completion_tokens": 1,
    }
    assert message_usage(None) is None


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
