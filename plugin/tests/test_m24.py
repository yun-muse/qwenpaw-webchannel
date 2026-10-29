#!/usr/bin/env python3
"""Standalone tests for M24: all-chats usage dashboard.

Covers the pure aggregation helpers (``session_turn_summary`` /
``session_file_chat`` / ``aggregate_usage_stats``), the cached multi-file scan
(``SessionUsageStore.stats_entries``), the ``stats`` frame builder, and the
``get_stats`` handler driven through the real ``WebChannel`` with a recording
fake local API and relay.

Run either way (no pytest required; needs httpx for ``channel``):

    cd plugin && python3 tests/test_m24.py
    cd plugin && python3 -m pytest tests/test_m24.py -q
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
from frames import stats_frame  # noqa: E402
from util import (  # noqa: E402
    STATS_TOP_CHATS,
    TURN_USAGE_META_KEY,
    SessionUsageStore,
    aggregate_usage_stats,
    session_file_chat,
    session_turn_summary,
)

WEB_CHAT = "chat-alpha"
SESSION_ID = "web:web-user:%s" % WEB_CHAT
FILE_PREFIX = "web-user_web--web-user--"


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------

def _turn(prompt=100, completion=20, day="2026-10-26", role="assistant",
          created=True, finished=None, **extra):
    """One message carrying QwenPaw's per-turn usage metadata."""
    usage = {}
    if prompt is not None:
        usage["prompt_tokens"] = prompt
    if completion is not None:
        usage["completion_tokens"] = completion
    usage.update(extra)
    message = {
        "role": role,
        "content": [{"type": "text", "text": "…"}],
        "metadata": {TURN_USAGE_META_KEY: {"usage": usage}},
    }
    if created and day is not None:
        message["created_at"] = "%sT12:00:00.123456" % day
    if finished is not None:
        message["finished_at"] = finished
    return message


def _plain(role="user", text="hi"):
    return {"role": role, "content": [{"type": "text", "text": text}]}


def _session(messages, session_id=None):
    data = {"agent": {"state": {"context": messages}}}
    if session_id is not None:
        data["session_id"] = session_id
    return data


def _write(root, chat, messages, session_id=None, name=None):
    directory = root / "sessions" / "web"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / (name or ("%s%s.json" % (FILE_PREFIX, chat)))
    path.write_text(
        json.dumps(_session(messages, session_id=session_id)),
        encoding="utf-8",
    )
    return path


def _entry(chat, summary):
    return {"chat": chat, "summary": summary}


def _summary(turns=1, input_total=100, output_total=10, days=None,
             undated=0):
    summary = {"turns": turns, "days": days or {}, "undated_turns": undated}
    if input_total is not None:
        summary["input"] = input_total
    if output_total is not None:
        summary["output"] = output_total
    return summary


class _FakeApp:
    """Recording stand-in for ``channel._api_json``."""

    def __init__(self, specs=None):
        self.calls = []
        self.specs = specs if specs is not None else [
            {
                "id": "11111111-1111-1111-1111-111111111111",
                "channel": "web",
                "session_id": SESSION_ID,
                "name": "Alpha chat",
            },
            {
                "id": "22222222-2222-2222-2222-222222222222",
                "channel": "web",
                "session_id": "web:web-user:chat-beta",
                "name": "Beta chat",
            },
            {
                "id": "33333333-3333-3333-3333-333333333333",
                "channel": "web",
                "session_id": "web:web-user:chat-gamma",
                "name": "Gamma untouched",
            },
        ]
        self.specs_status = 200

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
        return 404, {"detail": "unexpected request %s %s" % (method, path)}


class _ExplodingApp:
    async def __call__(self, method, path, params=None, json_body=None):
        raise RuntimeError("local API is down")


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


def _tmp():
    return Path(tempfile.mkdtemp(prefix="m24-stats-"))


# --------------------------------------------------------------------------
# Per-file summary / day bucketing
# --------------------------------------------------------------------------

def test_turn_summary_buckets_by_local_day():
    messages = [
        _plain(),
        _turn(prompt=100, completion=10, day="2026-10-26"),
        _plain("assistant", "no usage at all"),
        _turn(prompt=200, completion=20, day="2026-10-27"),
        _turn(prompt=999, completion=99, day="2026-10-27", role="user"),
    ]
    summary = session_turn_summary(messages)
    assert summary["turns"] == 2
    assert summary["input"] == 300
    assert summary["output"] == 30
    assert summary["undated_turns"] == 0
    assert summary["days"] == {
        "2026-10-26": {"turns": 1, "input": 100, "output": 10},
        "2026-10-27": {"turns": 1, "input": 200, "output": 20},
    }


def test_turn_summary_finished_at_fallback_and_undated():
    messages = [
        # No created_at: finished_at is the bucket.
        _turn(prompt=10, completion=1, created=False,
              finished="2026-10-28T09:30:00"),
        # No timestamp at all: totals yes, day no.
        _turn(prompt=5, completion=1, created=False),
        # Unparseable timestamp behaves like none.
        _turn(prompt=7, completion=1, day=None, created=True),
    ]
    messages[2]["created_at"] = "not-a-time"
    summary = session_turn_summary(messages)
    assert summary["turns"] == 3
    assert summary["input"] == 22
    assert summary["undated_turns"] == 2
    assert summary["days"] == {
        "2026-10-28": {"turns": 1, "input": 10, "output": 1},
    }


def test_turn_summary_keeps_real_zero_and_missing_sides():
    zero = session_turn_summary([_turn(prompt=0, completion=0)])
    assert zero["turns"] == 1
    assert zero["input"] == 0 and zero["output"] == 0
    assert zero["days"]["2026-10-26"]["input"] == 0

    only_completion = session_turn_summary([_turn(prompt=None, completion=42)])
    assert "input" not in only_completion
    assert only_completion["output"] == 42

    only_prompt = session_turn_summary([_turn(prompt="1200", completion=None)])
    assert only_prompt["input"] == 1200
    assert "output" not in only_prompt

    junk = session_turn_summary([
        _turn(prompt="abc", completion="-5"),
        _turn(prompt=None, completion=None),
        _turn(prompt=True, completion=None),
        _turn(prompt=float("nan"), completion=float("inf")),
    ])
    assert junk["turns"] == 0
    assert junk["days"] == {}
    assert "input" not in junk and "output" not in junk

    assert session_turn_summary(None)["turns"] == 0
    assert session_turn_summary([])["turns"] == 0


def test_turn_summary_accepts_legacy_memory_shape():
    data = {
        "agent": {"memory": {"memories": [
            _turn(prompt=30, completion=3, day="2026-10-25"),
        ]}},
    }
    from util import session_messages
    summary = session_turn_summary(session_messages(data))
    assert summary["turns"] == 1
    assert summary["days"]["2026-10-25"] == {
        "turns": 1, "input": 30, "output": 3,
    }


# --------------------------------------------------------------------------
# File name / identity -> chat
# --------------------------------------------------------------------------

def test_file_chat_resolution():
    assert session_file_chat(
        "/x/%s%s.json" % (FILE_PREFIX, WEB_CHAT),
    ) == WEB_CHAT
    # QwenPaw's sanitized session id without the sender prefix (legacy root).
    assert session_file_chat("/x/web--web-user--beta.json") == "beta"
    # A file that records its own channel session id wins over its name.
    assert session_file_chat(
        "/x/mine.json", identity="web:web-user:gamma",
    ) == "gamma"
    # ChatSpec id -> chat via the chat-list map.
    assert session_file_chat(
        "/x/mine.json", identity="spec-1", chat_by_spec={"spec-1": "delta"},
    ) == "delta"
    # A recorded chat id that is known.
    assert session_file_chat(
        "/x/mine.json", identity="epsilon", chat_ids={"epsilon"},
    ) == "epsilon"
    # A full recorded session id can also map through the session map.
    assert session_file_chat(
        "/x/mine.json", identity="web:web-user:zeta",
        chat_by_session={"web:web-user:zeta": "zeta"},
    ) == "zeta"
    # Legacy bare stem.
    assert session_file_chat("/x/eta.json") == "eta"
    assert session_file_chat("") == ""


# --------------------------------------------------------------------------
# Cross-file aggregation
# --------------------------------------------------------------------------

def test_aggregate_totals_days_and_titles():
    days_a = {
        "2026-10-26": {"turns": 1, "input": 100, "output": 10},
        "2026-10-27": {"turns": 1, "input": 200, "output": 20},
    }
    entries = [
        _entry("alpha", _summary(2, 300, 30, days_a)),
        _entry("beta", _summary(1, 50, 5, {
            "2026-10-27": {"turns": 1, "input": 50, "output": 5},
        })),
    ]
    stats = aggregate_usage_stats(
        entries,
        known_chats=["alpha", "beta", "gamma"],
        titles={"alpha": "Alpha chat", "beta": "  "},
    )
    assert stats["totals"] == {"turns": 3, "input": 350, "output": 35}
    assert stats["covered_chats"] == 2
    assert stats["uncovered_chats"] == 1
    assert stats["days"] == [
        {"date": "2026-10-26", "turns": 1, "input": 100, "output": 10},
        {"date": "2026-10-27", "turns": 2, "input": 250, "output": 25},
    ]
    assert stats["chats"][0] == {
        "chat": "alpha", "turns": 2, "input": 300, "output": 30,
        "title": "Alpha chat",
    }
    assert "title" not in stats["chats"][1]
    assert "undated_turns" not in stats


def test_aggregate_unknown_chat_list_omits_uncovered():
    stats = aggregate_usage_stats([_entry("alpha", _summary())], None, {})
    assert "uncovered_chats" not in stats
    assert stats["covered_chats"] == 1


def test_aggregate_top_cap_and_order():
    entries = []
    for index in range(12):
        chat = "chat-%02d" % index
        # Earlier chats have more tokens, so the cap keeps 00..09.
        entries.append(_entry(chat, _summary(
            turns=1, input_total=1000 - index * 10, output_total=10,
            days={"2026-10-26": {
                "turns": 1, "input": 1000 - index * 10, "output": 10,
            }},
        )))
    stats = aggregate_usage_stats(entries)
    assert len(stats["chats"]) == STATS_TOP_CHATS == 10
    assert [item["chat"] for item in stats["chats"]] == [
        "chat-%02d" % index for index in range(10)
    ]
    assert stats["covered_chats"] == 12
    assert stats["totals"]["turns"] == 12

    # Token ties fall back to turns, then chat id.
    tie = aggregate_usage_stats([
        _entry("b", _summary(1, 10, 0)),
        _entry("a", _summary(1, 10, 0)),
        _entry("c", _summary(2, 5, 5)),
    ])
    assert [item["chat"] for item in tie["chats"]] == ["c", "a", "b"]


def test_aggregate_ignores_junk_and_bad_days():
    entries = [
        None,
        {},
        {"chat": "", "summary": _summary()},
        {"chat": "x"},
        _entry("zero", _summary(0, 99, 99, {"2026-10-26": {"turns": 0}})),
        _entry("negative", _summary(-2, 5, 5)),
        _entry("good", _summary(1, 10, 1, {
            "2026-02-30": {"turns": 1, "input": 9},
            "not-a-day": {"turns": 1},
            "2026-10-26": {"turns": 1, "input": 10, "output": 1},
        }, undated=1)),
    ]
    stats = aggregate_usage_stats(entries)
    assert stats["totals"] == {"turns": 1, "input": 10, "output": 1}
    assert stats["covered_chats"] == 1
    assert stats["days"] == [
        {"date": "2026-10-26", "turns": 1, "input": 10, "output": 1},
    ]
    assert stats["undated_turns"] == 1
    assert [item["chat"] for item in stats["chats"]] == ["good"]


# --------------------------------------------------------------------------
# Cached multi-file scan
# --------------------------------------------------------------------------

def test_stats_entries_scans_and_skips_malformed():
    root = _tmp()
    try:
        _write(root, "chat-alpha", [
            _turn(prompt=100, completion=10, day="2026-10-26"),
            _turn(prompt=200, completion=20, day="2026-10-27"),
        ], session_id=None)
        _write(root, "chat-beta", [
            _turn(prompt=50, completion=5, day="2026-10-27"),
        ], session_id=None)
        _write(root, "chat-empty", [_plain()])
        broken = root / "sessions" / "web" / ("%schat-broken.json" % FILE_PREFIX)
        broken.write_text("{not json", encoding="utf-8")

        store = SessionUsageStore()
        entries = store.stats_entries(root / "sessions", "web-user", "web")
        assert sorted(entry["chat"] for entry in entries) == [
            "chat-alpha", "chat-beta",
        ]
        stats = aggregate_usage_stats(entries)
        assert stats["totals"] == {"turns": 3, "input": 350, "output": 35}
        assert stats["covered_chats"] == 2
        # The malformed file is remembered by its stamp, not retried.
        assert len(store._cache) == 4
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_stats_entries_cache_invalidates_on_change():
    root = _tmp()
    try:
        path = _write(root, "chat-alpha", [
            _turn(prompt=10, completion=1),
        ], session_id=None)
        store = SessionUsageStore()
        assert store.stats_entries(root / "sessions")[0]["summary"]["input"] == 10

        path.write_text(json.dumps(_session([
            _turn(prompt=10, completion=1),
            _turn(prompt=40, completion=4),
        ])), encoding="utf-8")
        stat = path.stat()
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
        assert store.stats_entries(root / "sessions")[0]["summary"]["input"] == 50
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_stats_entries_bad_root_and_missing_dir():
    store = SessionUsageStore()
    assert store.stats_entries(None) == []
    root = _tmp()
    try:
        assert store.stats_entries(root) == []
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_stats_entries_uses_chat_list_maps():
    root = _tmp()
    try:
        _write(root, "ignored", [
            _turn(prompt=9, completion=1),
        ], session_id="spec-7", name="spec-7.json")
        store = SessionUsageStore()
        entries = store.stats_entries(
            root / "sessions", "web-user", "web", ["chat-omega"],
            {}, {"spec-7": "chat-omega"},
        )
        assert entries[0]["chat"] == "chat-omega"
    finally:
        shutil.rmtree(root, ignore_errors=True)


# --------------------------------------------------------------------------
# Frame builder
# --------------------------------------------------------------------------

def test_stats_frame_shape():
    frame = stats_frame(
        req_id="stats-get",
        totals={"turns": 95, "input": 1648974, "output": 12314},
        days=[{"date": "2026-10-26", "turns": 20, "input": 406196,
               "output": 4556}],
        chats=[{"chat": "c", "title": " Chat ", "turns": 2, "input": 10,
                "output": 1}],
        covered_chats=37,
        uncovered_chats=0,
        undated_turns=2,
        day_tz=" UTC ",
    )
    assert frame == {
        "t": "stats",
        "day_basis": "container-local",
        "id": "stats-get",
        "totals": {"turns": 95, "input": 1648974, "output": 12314},
        "days": [{"date": "2026-10-26", "turns": 20, "input": 406196,
                  "output": 4556}],
        "chats": [{"chat": "c", "title": "Chat", "turns": 2, "input": 10,
                   "output": 1}],
        "covered_chats": 37,
        "uncovered_chats": 0,
        "undated_turns": 2,
        "day_tz": "UTC",
    }
    assert "seq" not in frame
    assert stats_frame() == {"t": "stats", "day_basis": "container-local"}


def test_stats_frame_drops_invalid_fields():
    frame = stats_frame(
        req_id="",
        totals={"turns": -1, "input": "10", "output": True},
        days=[
            {"date": "2026-02-30", "turns": 1},
            {"date": "2026-10-27", "turns": -1, "input": "9"},
            {"turns": 1},
            None,
        ],
        chats=[
            {"chat": "", "turns": 1},
            {"chat": "c", "turns": True, "input": None, "output": -2},
            "junk",
        ],
        covered_chats=-1,
        uncovered_chats="4",
        undated_turns=0,
        day_tz="   ",
    )
    assert frame == {
        "t": "stats",
        "day_basis": "container-local",
        "days": [{"date": "2026-10-27"}],
        "chats": [{"chat": "c"}],
    }


def test_stats_frame_caps_top_chats():
    frame = stats_frame(chats=[
        {"chat": "c%d" % index, "turns": 1} for index in range(14)
    ])
    assert len(frame["chats"]) == STATS_TOP_CHATS
    assert frame["chats"][0] == {"chat": "c0", "turns": 1}


# --------------------------------------------------------------------------
# get_stats handler
# --------------------------------------------------------------------------

def _seed(root):
    _write(root, "chat-alpha", [
        _turn(prompt=1000, completion=100, day="2026-10-26"),
        _turn(prompt=2000, completion=200, day="2026-10-27"),
    ], session_id=None)
    _write(root, "chat-beta", [
        _turn(prompt=500, completion=50, day="2026-10-27"),
    ], session_id=None)


def test_get_stats_handler():
    root = _tmp()
    try:
        _seed(root)
        channel, app, relay = _channel(root)
        asyncio.run(channel._on_relay_frame(
            {"t": "get_stats", "id": "stats-get"},
        ))

        frames = _of_kind(relay.sent, "stats")
        assert len(frames) == 1, relay.sent
        stats = frames[0]
        assert stats["id"] == "stats-get"
        assert stats["totals"] == {
            "turns": 3, "input": 3500, "output": 350,
        }
        assert stats["covered_chats"] == 2
        assert stats["uncovered_chats"] == 1
        assert stats["day_basis"] == "container-local"
        assert stats["days"] == [
            {"date": "2026-10-26", "turns": 1, "input": 1000,
             "output": 100},
            {"date": "2026-10-27", "turns": 2, "input": 2500,
             "output": 250},
        ]
        assert stats["chats"] == [
            {"chat": "chat-alpha", "title": "Alpha chat", "turns": 2,
             "input": 3000, "output": 300},
            {"chat": "chat-beta", "title": "Beta chat", "turns": 1,
             "input": 500, "output": 50},
        ]
        assert "seq" not in stats
        assert channel._seq.peek(WEB_CHAT) == 0
        assert channel._ring.since(WEB_CHAT, 0) == []
        assert [call["path"] for call in app.calls] == ["/api/chats"]
        assert app.calls[0]["params"] == {"channel": "web"}
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_get_stats_without_chat_list():
    root = _tmp()
    try:
        _seed(root)
        app = _FakeApp()
        app.specs_status = 503
        channel, app, relay = _channel(root, app)
        asyncio.run(channel._on_relay_frame(
            {"t": "get_stats", "id": "stats-get"},
        ))

        stats = _of_kind(relay.sent, "stats")[0]
        assert stats["totals"] == {
            "turns": 3, "input": 3500, "output": 350,
        }
        assert "uncovered_chats" not in stats
        assert "title" not in stats["chats"][0]
        assert stats["id"] == "stats-get"
        assert "seq" not in stats
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_get_stats_without_sessions():
    root = _tmp()
    try:
        channel, app, relay = _channel(root)
        asyncio.run(channel._on_relay_frame({"t": "get_stats"}))
        stats = _of_kind(relay.sent, "stats")[0]
        assert stats["totals"] == {"turns": 0}
        assert stats["covered_chats"] == 0
        assert stats["uncovered_chats"] == 3
        assert stats["days"] == []
        assert stats["chats"] == []
        assert "id" not in stats
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_get_stats_survives_api_failure():
    root = _tmp()
    try:
        _seed(root)
        channel, app, relay = _channel(root, _ExplodingApp())
        asyncio.run(channel._on_relay_frame(
            {"t": "get_stats", "id": "stats-broken"},
        ))
        stats = _of_kind(relay.sent, "stats")[0]
        # The files still produce numbers; only the chat list is missing.
        assert stats["id"] == "stats-broken"
        assert stats["totals"]["turns"] == 3
        assert stats["covered_chats"] == 2
        assert "uncovered_chats" not in stats
        assert "seq" not in stats
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
