#!/usr/bin/env python3
"""Standalone tests for M28: cache tokens, hit rate and per-model breakdown.

Covers the conversion rules of ``docs/m28-report.md`` §5 / protocol
``frames.md`` §14.5:

- DeepSeek-style (``prompt_cache_hit_tokens`` → ``cache_read_tokens``,
  eligible == prompt), OpenAI-style (``prompt_tokens_details.cached_tokens``)
  and Anthropic-style (prompt excludes read/write, so eligible > prompt)
  receipts all arrive in QwenPaw's normalised shape and are summed the same
  way;
- a turn whose provider did not report cache usage (``cache_observed`` false)
  or a legacy turn without cache keys contributes **nothing** to the cache
  numerator/denominator -- the fields are omitted, never sent as 0;
- ``session_cache_*`` is a cumulative snapshot and is never summed;
- the hit rate is always recomputed from integer sums, never averaged;
- ``by_model`` groups by ``(provider_id, model_name)``, puts empty /
  ``"unknown"`` models in one ``未知模型`` bucket and still sums to the
  totals.

Run either way (no pytest required; needs httpx for ``channel``):

    cd plugin && python3 tests/test_m28.py
    cd plugin && python3 -m pytest tests/test_m28.py -q
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
    STATS_UNKNOWN_MODEL,
    TURN_USAGE_META_KEY,
    SessionUsageStore,
    _turn_cache,
    aggregate_usage_stats,
    session_turn_summary,
)

WEB_CHAT = "chat-cache"
SESSION_ID = "web:web-user:%s" % WEB_CHAT
FILE_PREFIX = "web-user_web--web-user--"


# --------------------------------------------------------------------------
# Fixtures -- one builder per provider style
# --------------------------------------------------------------------------

def _turn(
    prompt=100, completion=10, provider="kilo", model="openrouter/free",
    cache=None, day="2026-10-26", created=True, session_cache=None,
):
    """One assistant message carrying a ``qwenpaw_turn_usage.usage`` receipt.

    ``cache``:
      * ``None`` -- legacy receipt: the cache keys are absent entirely;
      * ``False`` -- provider did not report: ``cache_observed=False`` and
        zero read/eligible, exactly what QwenPaw writes in that case;
      * ``(hit, write, eligible)`` -- provider reported cache usage.
    """
    usage = {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "provider_id": provider,
        "model_name": model,
    }
    if provider is None:
        usage.pop("provider_id")
    if model is None:
        usage.pop("model_name")
    if cache is False:
        usage.update({
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "cache_eligible_input_tokens": 0,
            "cache_observed": False,
            "cache_hit_rate": None,
        })
    elif cache is not None:
        hit, write, eligible = cache
        usage.update({
            "cache_read_tokens": hit,
            "cache_write_tokens": write,
            "cache_eligible_input_tokens": eligible,
            "cache_observed": True,
            "cache_hit_rate": round(hit / eligible * 100, 2),
        })
    if session_cache is not None:
        session_hit, session_eligible = session_cache
        usage.update({
            "session_cache_read_tokens": session_hit,
            "session_cache_eligible_input_tokens": session_eligible,
            "session_cache_observed": True,
            "session_cache_hit_rate": round(
                session_hit / session_eligible * 100, 2,
            ),
        })
    message = {
        "role": "assistant",
        "content": [{"type": "text", "text": "…"}],
        "metadata": {TURN_USAGE_META_KEY: {"usage": usage}},
    }
    if created and day is not None:
        message["created_at"] = "%sT12:00:00.123456" % day
    return message


def _plain(role="user", text="hi"):
    return {"role": role, "content": [{"type": "text", "text": text}]}


def _session(messages, session_id=None):
    data = {"agent": {"state": {"context": messages}}}
    if session_id is not None:
        data["session_id"] = session_id
    return data


def _write(root, chat, messages, session_id=None):
    directory = root / "sessions" / "web"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / ("%s%s.json" % (FILE_PREFIX, chat))
    path.write_text(
        json.dumps(_session(messages, session_id=session_id)),
        encoding="utf-8",
    )
    return path


def _mixed_messages():
    """Five turns: DeepSeek, OpenAI, Anthropic, not-reported and legacy.

    Numbers are chosen so every rule is visible:

    - DeepSeek:  prompt 1000, hit 400, eligible 1000  -> miss 600
    - OpenAI:    prompt  500, hit 100, eligible  500  -> miss 400
    - Anthropic: prompt  200, hit 120, eligible  350  -> miss 230 (prompt
      excludes the 120 read + 30 written tokens, so eligible = 200+120+30)
    - not reported: prompt 300, observed false        -> nothing
    - legacy:    prompt 100, no cache keys            -> nothing
    """
    return [
        _plain(),
        _turn(prompt=1000, completion=50, provider="deepseek",
              model="deepseek-chat", cache=(400, 0, 1000)),
        _turn(prompt=500, completion=20, provider="kilo",
              model="openrouter/free", cache=(100, 0, 500)),
        _turn(prompt=200, completion=10, provider="anthropic",
              model="claude-sonnet", cache=(120, 30, 350)),
        _turn(prompt=300, completion=5, provider="kilo",
              model="kilo-auto/free", cache=False),
        _turn(prompt=100, completion=1, provider="kilo",
              model="kilo-auto/free", cache=None),
    ]


# --------------------------------------------------------------------------
# Per-turn conversion
# --------------------------------------------------------------------------

def test_turn_cache_requires_observed_and_positive_eligible():
    assert _turn_cache({
        "cache_observed": True, "cache_read_tokens": 40,
        "cache_eligible_input_tokens": 100,
    }) == (40, 60, 100)
    # A reported 0 is a real 0% turn: it stays in the denominator.
    assert _turn_cache({
        "cache_observed": True, "cache_read_tokens": 0,
        "cache_eligible_input_tokens": 100,
    }) == (0, 100, 100)
    # Not reported, legacy, zero denominator, bad hit, missing flag.
    assert _turn_cache({"cache_observed": False, "cache_read_tokens": 0,
                        "cache_eligible_input_tokens": 0}) is None
    assert _turn_cache({"cache_read_tokens": 5,
                        "cache_eligible_input_tokens": 10}) is None
    assert _turn_cache({"cache_observed": True, "cache_read_tokens": 5,
                        "cache_eligible_input_tokens": 0}) is None
    assert _turn_cache({"cache_observed": True, "cache_read_tokens": 50,
                        "cache_eligible_input_tokens": 10}) is None
    assert _turn_cache({"cache_observed": True,
                        "cache_eligible_input_tokens": 10}) is None
    assert _turn_cache(None) is None


# --------------------------------------------------------------------------
# Per-file summary
# --------------------------------------------------------------------------

def test_summary_sums_all_provider_styles():
    summary = session_turn_summary(_mixed_messages())
    assert summary["turns"] == 5
    # ``input`` stays the M24 baseline: sum(prompt_tokens), unchanged.
    assert summary["input"] == 2100
    assert summary["output"] == 86
    assert summary["cache_hit"] == 620
    assert summary["cache_miss"] == 1230
    assert summary["cache_eligible"] == 1850
    # hit + miss == eligible. ``input`` still counts the two unreported
    # turns' prompt tokens, so the totals' eligible may be *smaller* than
    # input; for Anthropic alone the denominator is larger than its prompt.
    assert summary["cache_hit"] + summary["cache_miss"] == summary["cache_eligible"]
    assert summary["cache_eligible"] < summary["input"]

    day = summary["days"]["2026-10-26"]
    assert day == {
        "turns": 5, "input": 2100, "output": 86,
        "cache_hit": 620, "cache_miss": 1230, "cache_eligible": 1850,
    }

    models = {(bucket.get("provider"), bucket["model"]): bucket
              for bucket in summary["models"].values()}
    assert models[("deepseek", "deepseek-chat")]["cache_hit"] == 400
    assert models[("kilo", "openrouter/free")]["cache_hit"] == 100
    assert models[("anthropic", "claude-sonnet")]["cache_miss"] == 230
    # Anthropic's prompt excludes cache reads/writes: eligible > prompt.
    assert models[("anthropic", "claude-sonnet")]["cache_eligible"] > \
        models[("anthropic", "claude-sonnet")]["input"]
    # Two turns of one model merge, and neither adds cache numbers.
    merged = models[("kilo", "kilo-auto/free")]
    assert merged["turns"] == 2
    assert merged["input"] == 400
    assert "cache_hit" not in merged and "cache_eligible" not in merged


def test_summary_omits_cache_when_nothing_was_reported():
    summary = session_turn_summary([
        _turn(prompt=10, completion=1, cache=False),
        _turn(prompt=20, completion=2, cache=None),
        _turn(prompt=30, completion=3, cache=False, day="2026-10-27"),
    ])
    assert summary["turns"] == 3
    assert summary["input"] == 60 and summary["output"] == 6
    for key in ("cache_hit", "cache_miss", "cache_eligible"):
        assert key not in summary
        assert key not in summary["days"]["2026-10-26"]
        assert key not in summary["days"]["2026-10-27"]
        for bucket in summary["models"].values():
            assert key not in bucket


def test_summary_never_sums_session_cache_snapshots():
    # Turn 1 saw 10 hits, turn 2's cumulative snapshot says 30 -- adding the
    # snapshot too would count turn 1 twice (probe §2.5).
    messages = [
        _turn(prompt=100, completion=1, cache=(10, 0, 100),
              session_cache=(10, 100)),
        _turn(prompt=100, completion=1, cache=(20, 0, 100),
              session_cache=(30, 200)),
    ]
    summary = session_turn_summary(messages)
    assert summary["cache_hit"] == 30
    assert summary["cache_eligible"] == 200
    assert summary["cache_miss"] == 170


def test_summary_days_with_partial_cache_coverage():
    # The second day only has unobserved turns: its cache fields are absent,
    # while the first day keeps an eligible smaller than nothing weird.
    summary = session_turn_summary([
        _turn(prompt=100, completion=1, cache=(40, 0, 100)),
        _turn(prompt=200, completion=1, cache=False, day="2026-10-27"),
    ])
    first = summary["days"]["2026-10-26"]
    second = summary["days"]["2026-10-27"]
    assert first["cache_eligible"] == 100
    assert second["turns"] == 1 and second["input"] == 200
    assert "cache_hit" not in second and "cache_eligible" not in second


def test_summary_unknown_model_bucket():
    summary = session_turn_summary([
        _turn(prompt=10, completion=1, provider="kilo", model=None),
        _turn(prompt=20, completion=2, provider="kilo", model=""),
        _turn(prompt=30, completion=3, provider="", model="unknown"),
        _turn(prompt=40, completion=4, provider="kilo", model="UNKNOWN"),
        _turn(prompt=50, completion=5, provider="kilo",
              model="openrouter/free"),
    ])
    buckets = list(summary["models"].values())
    unknown = [bucket for bucket in buckets if not bucket.get("model")]
    assert len(unknown) == 1
    assert unknown[0]["turns"] == 4
    assert unknown[0]["input"] == 100
    assert sum(bucket["turns"] for bucket in buckets) == summary["turns"] == 5


# --------------------------------------------------------------------------
# Cross-file aggregation
# --------------------------------------------------------------------------

def _entry(chat, messages):
    return {"chat": chat, "summary": session_turn_summary(messages)}


def test_aggregate_totals_and_hit_rate_from_integer_sums():
    entries = [
        _entry("a", [
            # 1/100 = 1% and 900/1000 = 90%: the naive mean is 45.5%, the
            # correct weighted rate is 901/1100 = 81.91%.
            _turn(prompt=100, completion=1, cache=(1, 0, 100)),
            _turn(prompt=1000, completion=1, cache=(900, 0, 1000)),
        ]),
    ]
    stats = aggregate_usage_stats(entries)
    assert stats["totals"] == {
        "turns": 2, "input": 1100, "output": 2,
        "cache_hit": 901, "cache_miss": 199, "cache_eligible": 1100,
        "cache_hit_rate": 81.91,
    }
    assert stats["by_model"][0]["cache_hit_rate"] == 81.91

    # Cross-chat sums use the same rule: (901+10) / (1100+50).
    stats = aggregate_usage_stats(entries + [
        _entry("b", [_turn(prompt=50, completion=1, cache=(10, 0, 50))]),
    ])
    assert stats["totals"]["cache_hit"] == 911
    assert stats["totals"]["cache_eligible"] == 1150
    assert stats["totals"]["cache_miss"] == 239
    assert stats["totals"]["cache_hit_rate"] == 79.22


def test_aggregate_omits_cache_when_no_turn_reported_it():
    stats = aggregate_usage_stats([
        _entry("a", [_turn(cache=False), _turn(cache=None)]),
        _entry("b", [_turn(prompt=5, completion=1, cache=False)]),
    ])
    assert stats["totals"] == {"turns": 3, "input": 205, "output": 21}
    assert "cache_hit" not in stats["totals"]
    assert "cache_hit_rate" not in stats["totals"]
    for day in stats["days"]:
        assert "cache_hit" not in day
    for model in stats["by_model"]:
        assert "cache_hit" not in model
        assert "cache_hit_rate" not in model


def test_aggregate_by_model_matches_totals_exactly():
    entries = [
        _entry("a", _mixed_messages()),
        _entry("b", [
            _turn(prompt=70, completion=7, provider="deepseek",
                  model="deepseek-chat", cache=(30, 0, 70)),
            _turn(prompt=80, completion=8, provider="kilo", model=None),
        ]),
        _entry("c", [_turn(prompt=90, completion=9, cache=False)]),
    ]
    stats = aggregate_usage_stats(entries)
    totals = stats["totals"]
    models = stats["by_model"]

    assert sum(item.get("input", 0) for item in models) == totals["input"]
    assert sum(item.get("output", 0) for item in models) == totals["output"]
    assert sum(item["turns"] for item in models) == totals["turns"]
    assert sum(item.get("cache_hit", 0) for item in models) == totals["cache_hit"]
    assert sum(item.get("cache_miss", 0) for item in models) == totals["cache_miss"]
    assert sum(item.get("cache_eligible", 0) for item in models) == totals["cache_eligible"]

    # Day buckets cover every turn here, so they must add up too.
    assert sum(day["turns"] for day in stats["days"]) == totals["turns"]
    assert sum(day.get("input", 0) for day in stats["days"]) == totals["input"]
    assert sum(day.get("output", 0) for day in stats["days"]) == totals["output"]
    assert sum(day.get("cache_hit", 0) for day in stats["days"]) == totals["cache_hit"]
    assert sum(day.get("cache_eligible", 0) for day in stats["days"]) == totals["cache_eligible"]


def test_aggregate_unknown_bucket_counts_in_totals():
    stats = aggregate_usage_stats([
        _entry("a", [
            _turn(prompt=10, completion=1, provider="kilo", model=None),
            _turn(prompt=20, completion=2, provider="", model="unknown"),
        ]),
        _entry("b", [
            _turn(prompt=30, completion=3, provider="kilo",
                  model="openrouter/free"),
        ]),
    ])
    rows = {item["model"]: item for item in stats["by_model"]}
    assert rows[STATS_UNKNOWN_MODEL] == {
        "model": STATS_UNKNOWN_MODEL, "turns": 2, "input": 30, "output": 3,
    }
    assert stats["totals"]["turns"] == 3
    assert sum(item["turns"] for item in stats["by_model"]) == 3
    assert sum(item.get("input", 0) for item in stats["by_model"]) == 60


def test_aggregate_by_model_merges_conflicting_cache_data():
    # One chat reported cache for a model, the other did not: the merged row
    # keeps the reported numbers only, and its rate uses those sums.
    stats = aggregate_usage_stats([
        _entry("a", [_turn(prompt=100, completion=1, cache=(25, 0, 100))]),
        _entry("b", [_turn(prompt=300, completion=1, cache=False)]),
    ])
    row = stats["by_model"][0]
    assert row["turns"] == 2 and row["input"] == 400
    assert row["cache_hit"] == 25
    assert row["cache_eligible"] == 100
    assert row["cache_miss"] == 75
    assert row["cache_hit_rate"] == 25.0
    # Totals still equal the per-model row.
    assert stats["totals"]["cache_eligible"] == 100


def test_aggregate_by_model_order():
    stats = aggregate_usage_stats([
        _entry("a", [
            _turn(prompt=100, completion=1, provider="p", model="b-model"),
            _turn(prompt=100, completion=1, provider="p", model="a-model"),
            _turn(prompt=300, completion=1, provider="p", model="big-model"),
            _turn(prompt=100, completion=3, provider="p", model="many-turns"),
            _turn(prompt=100, completion=1, provider="p", model="many-turns"),
        ]),
    ])
    assert [item["model"] for item in stats["by_model"]] == [
        "big-model", "many-turns", "a-model", "b-model",
    ]
    # Ties on input and turns fall back to the model string ascending.
    assert stats["by_model"][2]["turns"] == stats["by_model"][3]["turns"] == 1


def test_aggregate_ignores_junk_model_buckets():
    stats = aggregate_usage_stats([
        {"chat": "a", "summary": {
            "turns": 2, "input": 30, "output": 3, "undated_turns": 0,
            "models": {
                ("", ""): {"turns": 1, "model": "", "input": 10},
                ("x", "z"): "not a dict",
                ("x", "y"): {"turns": 0, "model": "zero"},
            },
        }},
    ])
    # Only the usable bucket survives; a zero-turn row never appears, and the
    # non-dict value is skipped without raising.
    assert stats["by_model"] == [
        {"model": STATS_UNKNOWN_MODEL, "turns": 1, "input": 10},
    ]


# --------------------------------------------------------------------------
# Frame builder
# --------------------------------------------------------------------------

def test_stats_frame_extends_totals_backwards_compatibly():
    frame = stats_frame(totals={
        "turns": 2, "input": 1100, "output": 2,
        "cache_hit": 901, "cache_miss": 199, "cache_eligible": 1100,
        # A hostile/naive rate must be replaced by the integer-sum one.
        "cache_hit_rate": 45.5,
    })
    assert frame["totals"] == {
        "turns": 2, "input": 1100, "output": 2,
        "cache_hit": 901, "cache_miss": 199, "cache_eligible": 1100,
        "cache_hit_rate": 81.91,
    }


def test_stats_frame_drops_incomplete_or_inconsistent_cache():
    for bad in (
        {"cache_hit": 10},                                    # incomplete
        {"cache_hit": 10, "cache_miss": 5},                   # no denominator
        {"cache_hit": 10, "cache_miss": 5, "cache_eligible": 0},
        {"cache_hit": 10, "cache_miss": 5, "cache_eligible": 20},  # 15 != 20
        {"cache_hit": True, "cache_miss": 5, "cache_eligible": 6},
        {"cache_hit": -1, "cache_miss": 5, "cache_eligible": 4},
    ):
        frame = stats_frame(totals={"turns": 1, **bad})
        assert frame["totals"] == {"turns": 1}, bad


def test_stats_frame_by_model_is_cleaned_and_sorted():
    frame = stats_frame(by_model=[
        {"model": "small", "turns": 1, "input": 10, "output": 1},
        {"model": "big", "provider": " kilo ", "turns": 2, "input": 100,
         "output": 2, "cache_hit": 30, "cache_miss": 70,
         "cache_eligible": 100, "cache_hit_rate": 1},
        {"model": "  "},                       # no model
        {"model": "no-turns", "input": 999},    # no turns
        {"model": STATS_UNKNOWN_MODEL, "turns": 1, "input": 20},
        "junk",
    ])
    assert frame["by_model"] == [
        {"model": "big", "turns": 2, "provider": "kilo", "input": 100,
         "output": 2, "cache_hit": 30, "cache_miss": 70,
         "cache_eligible": 100, "cache_hit_rate": 30.0},
        {"model": STATS_UNKNOWN_MODEL, "turns": 1, "input": 20},
        {"model": "small", "turns": 1, "input": 10, "output": 1},
    ]
    # No by_model in the request -> the field is omitted (old plugin shape).
    assert "by_model" not in stats_frame()


def test_stats_frame_per_day_cache_is_optional():
    frame = stats_frame(days=[
        {"date": "2026-10-26", "turns": 1, "input": 100,
         "cache_hit": 40, "cache_miss": 60, "cache_eligible": 100},
        {"date": "2026-10-27", "turns": 1, "input": 200},
    ])
    assert frame["days"][0]["cache_hit_rate"] == 40.0
    assert "cache_hit" not in frame["days"][1]


# --------------------------------------------------------------------------
# Cached scan
# --------------------------------------------------------------------------

def test_stats_entries_copies_model_buckets():
    root = Path(tempfile.mkdtemp(prefix="m28-stats-"))
    try:
        _write(root, "chat-cache", [
            _turn(prompt=100, completion=1, cache=(40, 0, 100)),
        ])
        store = SessionUsageStore()
        first = store.stats_entries(root / "sessions")
        first[0]["summary"]["models"].clear()
        first[0]["summary"]["cache_hit"] = 999
        second = store.stats_entries(root / "sessions")
        assert second[0]["summary"]["cache_hit"] == 40
        assert len(second[0]["summary"]["models"]) == 1
    finally:
        shutil.rmtree(root, ignore_errors=True)


# --------------------------------------------------------------------------
# get_stats handler
# --------------------------------------------------------------------------

class _FakeApp:
    async def __call__(self, method, path, params=None, json_body=None):
        if method == "GET" and path == "/api/chats":
            return 200, [
                {"id": "spec-1", "channel": "web", "session_id": SESSION_ID,
                 "name": "Cache chat"},
                {"id": "spec-2", "channel": "web",
                 "session_id": "web:web-user:chat-empty", "name": "Empty"},
            ]
        return 404, {"detail": "unexpected"}


class _RecordingRelay:
    def __init__(self):
        self.sent = []

    async def send(self, frame):
        self.sent.append(frame)


class _Workspace:
    def __init__(self, workspace_dir):
        self.workspace_dir = str(workspace_dir)


def test_get_stats_handler_carries_cache_and_models():
    root = Path(tempfile.mkdtemp(prefix="m28-handler-"))
    try:
        _write(root, WEB_CHAT, _mixed_messages(), session_id=None)
        channel = WebChannel(process=None)
        channel._agent_id = lambda: "agent-1"
        channel._workspace = _Workspace(root)
        channel._api_json = _FakeApp()
        relay = _RecordingRelay()
        channel._relay = relay

        asyncio.run(channel._on_relay_frame({"t": "get_stats", "id": "s-1"}))

        frames = [frame for frame in relay.sent if frame.get("t") == "stats"]
        assert len(frames) == 1, relay.sent
        stats = frames[0]
        assert stats["id"] == "s-1"
        assert stats["totals"] == {
            "turns": 5, "input": 2100, "output": 86,
            "cache_hit": 620, "cache_miss": 1230, "cache_eligible": 1850,
            "cache_hit_rate": 33.51,
        }
        assert [row["model"] for row in stats["by_model"]] == [
            "deepseek-chat", "openrouter/free", "kilo-auto/free",
            "claude-sonnet",
        ]
        assert sum(row["turns"] for row in stats["by_model"]) == 5
        assert "seq" not in stats
        assert channel._seq.peek(WEB_CHAT) == 0
        assert channel._ring.since(WEB_CHAT, 0) == []
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
