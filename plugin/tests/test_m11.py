#!/usr/bin/env python3
"""Standalone tests for M11: per-session token usage.

Covers the pure usage helpers (``message_usage`` / ``session_messages`` /
``session_usage`` / ``session_identity`` / ``SessionUsageStore``), the
``active_llm_detail`` projection, the ``usage`` frame builder, and the
``get_usage`` handler driven through the real ``WebChannel`` with a recording
fake local API and relay.

Run either way (no pytest required; needs httpx for ``channel``):

    cd plugin && python3 tests/test_m11.py
    cd plugin && python3 -m pytest tests/test_m11.py -q
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
    active_llm_detail,
    message_usage,
    session_identity,
    session_messages,
    session_usage,
)

WEB_CHAT = "chat-1"
CHAT_UUID = "11111111-1111-1111-1111-111111111111"
SESSION_ID = "web:web-user:%s" % WEB_CHAT


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------

def _usage_message(prompt=100, completion=20, role="assistant", **extra):
    """One assistant message carrying QwenPaw's turn-usage metadata."""
    usage = {}
    if prompt is not None:
        usage["prompt_tokens"] = prompt
    if completion is not None:
        usage["completion_tokens"] = completion
    usage.update(extra)
    return {
        "role": role,
        "content": [{"type": "text", "text": "…"}],
        "metadata": {TURN_USAGE_META_KEY: {"usage": usage}},
    }


def _session_data(messages, session_id=SESSION_ID):
    """A QwenPaw 2.x session file body around *messages*."""
    data = {"agent": {"state": {"context": messages}}}
    if session_id is not None:
        data["session_id"] = session_id
    return data


def _write_session(directory, name, data):
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


class _FakeApp:
    """Recording stand-in for ``channel._api_json``."""

    def __init__(self, specs=None, active=None):
        self.calls = []
        self.specs = specs if specs is not None else [{
            "id": CHAT_UUID,
            "channel": "web",
            "session_id": SESSION_ID,
        }]
        self.specs_status = 200
        self.active = active if active is not None else {
            "active_llm": {"provider_id": "openai", "model": "gpt-4o"},
            "effective_max_input_length": 200000,
        }
        self.active_status = 200

    async def __call__(self, method, path, params=None, json_body=None):
        self.calls.append({
            "method": method,
            "path": path,
            "params": params,
            "json": json_body,
        })
        if method == "GET" and path == "/api/chats":
            if self.specs_status != 200:
                return self.specs_status, None
            return 200, json.loads(json.dumps(self.specs))
        if method == "GET" and path == "/api/models/active":
            if self.active_status != 200:
                return self.active_status, None
            return 200, json.loads(json.dumps(self.active))
        return 404, {"detail": "unexpected request %s %s" % (method, path)}


class _RecordingRelay:
    """Fake relay: records every outbound frame in order."""

    def __init__(self):
        self.sent = []

    async def send(self, frame):
        self.sent.append(frame)


class _Workspace:
    def __init__(self, workspace_dir):
        self.workspace_dir = str(workspace_dir)


def _channel(workspace_dir, app=None):
    channel = WebChannel(process=None)
    channel._agent_id = lambda: "agent-1"
    channel._workspace = _Workspace(workspace_dir)
    fake_app = _FakeApp() if app is None else app
    fake_relay = _RecordingRelay()
    channel._api_json = fake_app
    channel._relay = fake_relay
    return channel, fake_app, fake_relay


def _of_kind(frames, kind):
    return [frame for frame in frames if frame.get("t") == kind]


# --------------------------------------------------------------------------
# Metadata parsing / accumulation
# --------------------------------------------------------------------------

def test_message_usage_shapes():
    assert message_usage(_usage_message()) == {
        "prompt_tokens": 100, "completion_tokens": 20,
    }
    assert message_usage({"role": "assistant"}) is None
    assert message_usage({"role": "assistant", "metadata": None}) is None
    assert message_usage({
        "role": "assistant", "metadata": {TURN_USAGE_META_KEY: "nope"},
    }) is None
    assert message_usage({
        "role": "assistant",
        "metadata": {TURN_USAGE_META_KEY: {"usage": []}},
    }) is None
    assert message_usage(None) is None


def test_session_usage_sums_assistant_turns():
    messages = [
        {"role": "user", "content": [{"type": "text", "text": "hi"}]},
        _usage_message(prompt=100, completion=20),
        {"role": "assistant", "content": [{"type": "text", "text": "no meta"}]},
        _usage_message(prompt=150, completion=30),
    ]
    assert session_usage(messages) == {
        "input_total": 250,
        "output_total": 50,
        "context_tokens": 150,
    }


def test_session_usage_ignores_non_assistant_metadata():
    messages = [
        _usage_message(prompt=999, completion=999, role="user"),
        _usage_message(prompt=10, completion=5),
    ]
    assert session_usage(messages) == {
        "input_total": 10,
        "output_total": 5,
        "context_tokens": 10,
    }


def test_session_usage_dirty_fields():
    messages = [
        # A float is truncated; a numeric string is accepted.
        _usage_message(prompt=10.9, completion=None),
        _usage_message(prompt="1200", completion="30"),
    ]
    assert session_usage(messages) == {
        "input_total": 1210,
        "output_total": 30,
        "context_tokens": 1200,
    }

    bad = [
        _usage_message(prompt="abc", completion="-5"),
        _usage_message(prompt=True, completion=None),
        _usage_message(prompt=None, completion=None),
        _usage_message(prompt=float("nan"), completion=float("inf")),
    ]
    # No usable field anywhere -> no keys at all (never zero-filled).
    assert session_usage(bad) == {}


def test_session_usage_missing_one_side():
    # If no turn ever recorded a prompt, input_total/context_tokens stay out.
    assert session_usage([_usage_message(prompt=None, completion=42)]) == {
        "output_total": 42,
    }
    assert session_usage([_usage_message(prompt=42, completion=None)]) == {
        "input_total": 42,
        "context_tokens": 42,
    }
    assert session_usage([]) == {}
    assert session_usage(None) == {}


def test_session_usage_zero_is_not_unknown():
    messages = [_usage_message(prompt=0, completion=0)]
    assert session_usage(messages) == {"input_total": 0, "output_total": 0}
    # 0 is not a usable context size, so no context_tokens.
    assert "context_tokens" not in session_usage(messages)


def test_session_usage_last_prompt_wins():
    messages = [
        _usage_message(prompt=100, completion=1),
        _usage_message(prompt=500, completion=2),
        _usage_message(prompt=0, completion=3),
    ]
    usage = session_usage(messages)
    assert usage["context_tokens"] == 500
    assert usage["input_total"] == 600


def test_session_messages_shapes():
    data = _session_data([{"role": "user", "content": []}])
    assert session_messages(data) == [{"role": "user", "content": []}]

    # Legacy 1.x memory fallback.
    legacy = {"agent": {"memory": {"memories": [{"role": "assistant"}]}}}
    assert session_messages(legacy) == [{"role": "assistant"}]

    # Tuple-wrapped message entries are unwrapped, junk is dropped.
    wrapped = _session_data([
        [{"role": "assistant", "metadata": {}}],
        "junk",
        None,
    ])
    assert session_messages(wrapped) == [
        {"role": "assistant", "metadata": {}},
    ]

    assert session_messages(None) == []
    assert session_messages({"agent": {}}) == []
    assert session_messages({"agent": {"state": {"context": []}}}) == []


def test_session_identity():
    assert session_identity({"session_id": SESSION_ID}) == SESSION_ID
    assert session_identity({"session": {"session_id": "s-2"}}) == "s-2"
    assert session_identity({"agent": {"session_id": "s-3"}}) == "s-3"
    # An id nested in the agent state is not trusted as the session identity.
    assert session_identity({"agent": {"state": {"session_id": "s-4"}}}) == ""
    assert session_identity({"agent": {}}) == ""
    assert session_identity(None) == ""


# --------------------------------------------------------------------------
# Session file matching (temporary directories)
# --------------------------------------------------------------------------

def test_store_matches_by_recorded_session_id():
    root = Path(tempfile.mkdtemp(prefix="m11-sessions-"))
    try:
        _write_session(root / "web", "other.json", _session_data(
            [_usage_message(prompt=1, completion=1)], session_id="web:web-user:other",
        ))
        _write_session(root / "web", "mine.json", _session_data(
            [_usage_message(prompt=100, completion=20),
             _usage_message(prompt=150, completion=30)],
        ))
        store = SessionUsageStore()
        assert store.usage_for(root, SESSION_ID, WEB_CHAT, CHAT_UUID) == {
            "input_total": 250,
            "output_total": 50,
            "context_tokens": 150,
        }
        # Unknown session -> nothing, not the other file's numbers.
        assert store.usage_for(root, "web:web-user:nope", "nope", "") == {}
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_store_identity_accepts_chat_id_and_chat():
    root = Path(tempfile.mkdtemp(prefix="m11-identity-"))
    try:
        _write_session(root / "web", "by-uuid.json", _session_data(
            [_usage_message(prompt=5, completion=1)], session_id=CHAT_UUID,
        ))
        assert SessionUsageStore().usage_for(
            root, SESSION_ID, WEB_CHAT, CHAT_UUID,
        )["input_total"] == 5

        _write_session(root / "web", "by-chat.json", _session_data(
            [_usage_message(prompt=6, completion=1)], session_id=WEB_CHAT,
        ))
        assert SessionUsageStore().usage_for(
            root, SESSION_ID, WEB_CHAT, "",
        )["input_total"] == 6
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_store_matches_by_stem_and_chat_id():
    root = Path(tempfile.mkdtemp(prefix="m11-stems-"))
    try:
        # No session_id inside: the file name carries it.
        _write_session(root / "web", "%s.json" % SESSION_ID, _session_data(
            [_usage_message(prompt=70, completion=7)], session_id=None,
        ))
        store = SessionUsageStore()
        assert store.usage_for(root, SESSION_ID, WEB_CHAT, "")["input_total"] == 70

        # A ChatSpec-id-named file is found through chat_id.
        root2 = Path(tempfile.mkdtemp(prefix="m11-stems2-"))
        try:
            _write_session(root2 / "web", "%s.json" % CHAT_UUID, _session_data(
                [_usage_message(prompt=90, completion=9)], session_id=None,
            ))
            store2 = SessionUsageStore()
            assert store2.usage_for(
                root2, SESSION_ID, WEB_CHAT, CHAT_UUID,
            )["input_total"] == 90
            # Without the chat id the UUID name is not guessable.
            assert SessionUsageStore().usage_for(
                root2, SESSION_ID, WEB_CHAT, "",
            ) == {}
        finally:
            shutil.rmtree(root2, ignore_errors=True)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_store_bad_and_missing_files():
    root = Path(tempfile.mkdtemp(prefix="m11-bad-"))
    try:
        (root / "web").mkdir(parents=True)
        (root / "web" / "broken.json").write_text("{not json", encoding="utf-8")
        store = SessionUsageStore()
        assert store.usage_for(root, SESSION_ID, WEB_CHAT, "") == {}
        assert store.usage_for(root / "missing", SESSION_ID, WEB_CHAT, "") == {}
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_store_cache_invalidates_on_change():
    root = Path(tempfile.mkdtemp(prefix="m11-cache-"))
    try:
        path = _write_session(root / "web", "mine.json", _session_data(
            [_usage_message(prompt=10, completion=1)],
        ))
        store = SessionUsageStore()
        assert store.usage_for(root, SESSION_ID, WEB_CHAT, "")["input_total"] == 10

        data = _session_data([_usage_message(prompt=50, completion=5)])
        path.write_text(json.dumps(data), encoding="utf-8")
        # Same mtime second is possible; force a distinct stamp.
        stat = path.stat()
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
        assert store.usage_for(root, SESSION_ID, WEB_CHAT, "")["input_total"] == 50
    finally:
        shutil.rmtree(root, ignore_errors=True)


# --------------------------------------------------------------------------
# Model projection / frame builder
# --------------------------------------------------------------------------

def test_active_llm_detail():
    payload = {
        "active_llm": {"provider_id": "openai", "model": "gpt-4o"},
        "effective_max_input_length": 200000,
    }
    assert active_llm_detail(payload) == ("openai", "gpt-4o", 200000)
    assert active_llm_detail({"active_llm": None}) == ("", "", 0)
    assert active_llm_detail({
        "active_llm": {"provider_id": "p", "model": "m"},
        "effective_max_input_length": "200000",
    }) == ("p", "m", 0)
    assert active_llm_detail({
        "effective_max_input_length": True,
    }) == ("", "", 0)
    assert active_llm_detail({
        "effective_max_input_length": 0,
    }) == ("", "", 0)
    assert active_llm_detail(None) == ("", "", 0)


def test_usage_frame_shape():
    frame = usage_frame(
        "c",
        req_id="usage-get",
        input_total=12,
        output_total=3,
        context_tokens=68000,
        context_limit=200000,
    )
    assert frame == {
        "t": "usage",
        "chat": "c",
        "id": "usage-get",
        "input_total": 12,
        "output_total": 3,
        "context_tokens": 68000,
        "context_limit": 200000,
    }
    assert "seq" not in frame

    empty = usage_frame("c")
    assert empty == {"t": "usage", "chat": "c"}

    # Missing / invalid fields never appear, not even as 0.
    sparse = usage_frame(
        "c", input_total=None, output_total=-1,
        context_tokens="68000", context_limit=True,
    )
    assert sparse == {"t": "usage", "chat": "c"}


# --------------------------------------------------------------------------
# get_usage handler
# --------------------------------------------------------------------------

def _seed_workspace(root):
    _write_session(root / "sessions" / "web", "mine.json", _session_data([
        _usage_message(prompt=1000, completion=200),
        _usage_message(prompt=1500, completion=300),
    ]))


def test_get_usage_handler():
    root = Path(tempfile.mkdtemp(prefix="m11-handler-"))
    try:
        _seed_workspace(root)
        channel, app, relay = _channel(root)
        asyncio.run(channel._on_relay_frame(
            {"t": "get_usage", "chat": WEB_CHAT, "id": "usage-get"},
        ))

        frames = _of_kind(relay.sent, "usage")
        assert len(frames) == 1, relay.sent
        assert frames[0] == {
            "t": "usage",
            "chat": WEB_CHAT,
            "id": "usage-get",
            "input_total": 2500,
            "output_total": 500,
            "context_tokens": 1500,
            "context_limit": 200000,
        }
        assert "seq" not in frames[0]
        assert channel._seq.peek(WEB_CHAT) == 0
        assert channel._ring.since(WEB_CHAT, 0) == []
        assert [call["path"] for call in app.calls] == [
            "/api/chats", "/api/models/active",
        ]
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_get_usage_without_session_file():
    root = Path(tempfile.mkdtemp(prefix="m11-empty-"))
    try:
        channel, app, relay = _channel(root)
        asyncio.run(channel._on_relay_frame(
            {"t": "get_usage", "chat": WEB_CHAT},
        ))
        frames = _of_kind(relay.sent, "usage")
        assert frames == [{
            "t": "usage",
            "chat": WEB_CHAT,
            "context_limit": 200000,
        }]
        assert "seq" not in frames[0]
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_get_usage_survives_unreadable_data():
    root = Path(tempfile.mkdtemp(prefix="m11-broken-"))
    try:
        (root / "sessions" / "web").mkdir(parents=True)
        (root / "sessions" / "web" / "mine.json").write_text(
            "{not json", encoding="utf-8",
        )
        channel, app, relay = _channel(root)
        asyncio.run(channel._on_relay_frame(
            {"t": "get_usage", "chat": WEB_CHAT, "id": "usage-get"},
        ))
        frames = _of_kind(relay.sent, "usage")
        assert len(frames) == 1, relay.sent
        assert "input_total" not in frames[0]
        assert "context_tokens" not in frames[0]
        assert frames[0]["id"] == "usage-get"
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_get_usage_without_chatspec_still_reads_session():
    root = Path(tempfile.mkdtemp(prefix="m11-nospec-"))
    try:
        _seed_workspace(root)
        app = _FakeApp(specs=[])
        channel, app, relay = _channel(root, app)
        asyncio.run(channel._on_relay_frame(
            {"t": "get_usage", "chat": WEB_CHAT},
        ))
        frames = _of_kind(relay.sent, "usage")
        assert len(frames) == 1
        assert frames[0]["input_total"] == 2500
        assert frames[0]["context_tokens"] == 1500
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_get_usage_without_active_model():
    root = Path(tempfile.mkdtemp(prefix="m11-nomodel-"))
    try:
        _seed_workspace(root)
        app = _FakeApp()
        app.active_status = 500
        channel, app, relay = _channel(root, app)
        asyncio.run(channel._on_relay_frame(
            {"t": "get_usage", "chat": WEB_CHAT},
        ))
        frames = _of_kind(relay.sent, "usage")
        assert len(frames) == 1
        assert "context_limit" not in frames[0]
        assert frames[0]["input_total"] == 2500
    finally:
        shutil.rmtree(root, ignore_errors=True)


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
