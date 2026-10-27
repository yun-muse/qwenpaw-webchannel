#!/usr/bin/env python3
"""Standalone tests for M9: per-session thinking effort.

Covers the pure conversion helpers (``util.effort_budget`` /
``effort_level_for_budget`` / ``effort_supported`` / ``effort_view_fields``),
the ``effort`` frame builder, and both handlers driven through the real
``WebChannel`` with a recording fake local API and relay.

Run either way (no pytest required; needs httpx for ``channel``):

    cd plugin && python3 tests/test_m9.py
    cd plugin && python3 -m pytest tests/test_m9.py -q
"""

import asyncio
import copy
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_PLUGIN_DIR = os.path.dirname(_HERE)
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

from channel import WebChannel  # noqa: E402  (path setup must run first)
from frames import effort_frame, error_frame  # noqa: E402
from util import (  # noqa: E402
    effort_budget,
    effort_level_for_budget,
    effort_supported,
    effort_view_fields,
)

WEB_CHAT = "chat-1"
CHAT_UUID = "11111111-1111-1111-1111-111111111111"
MODEL_KEY = "openai:gpt-4o"
THINKING_PATH = "/api/chats/%s/thinking" % CHAT_UUID

_EFFORT_FOUR = ["low", "medium", "high", "max"]


# --------------------------------------------------------------------------
# Fixtures / fakes
# --------------------------------------------------------------------------

def _control(kind="effort", efforts=None, budget_min=None, budget_max=None):
    """One ``ThinkingControl``-shaped dict."""
    return {
        "kind": kind,
        "efforts": list(efforts or []),
        "supports_off": False,
        "budget_min": budget_min,
        "budget_max": budget_max,
        "budget_default": None,
        "wire": "native",
    }


def _view(
    level="inherit", budget_tokens=None, control=None, effective=None,
    reason=None, model_key=MODEL_KEY,
):
    """One ``GET|PUT /chats/{id}/thinking`` (``thinking_view``) response."""
    value = {"level": level}
    if budget_tokens is not None:
        value["budget_tokens"] = budget_tokens
    if effective is None:
        effective = dict(value)
    return {
        "model_source": "session",
        "model": "gpt-4o",
        "model_name": "GPT-4o",
        "provider_id": "openai",
        "model_key": model_key,
        "effective_max_input_length": 128000,
        "control": _control() if control is None else copy.deepcopy(control),
        "value": value,
        "effective": effective,
        "source": "session" if level != "inherit" else "model",
        "reason": reason,
    }


class _FakeApp:
    """Recording stand-in for ``channel._api_json``.

    Serves ``GET /api/chats`` (one web ChatSpec), the thinking endpoint, and
    can fail either method with an arbitrary status, mirroring the app.
    """

    def __init__(self, view=None):
        self.view = copy.deepcopy(_view() if view is None else view)
        self.calls = []
        self.specs = [{
            "id": CHAT_UUID,
            "channel": "web",
            "session_id": "web:web-user:%s" % WEB_CHAT,
        }]
        self.specs_status = 200
        self.get_status = 200
        self.get_error = None
        self.put_status = 200
        self.put_error = None
        self.put_reply = None  # explicit PUT answer instead of applying body

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
            return 200, copy.deepcopy(self.specs)
        if path != THINKING_PATH:
            return 404, {"detail": "unexpected request %s %s" % (method, path)}
        if method == "GET":
            if self.get_status != 200:
                return self.get_status, copy.deepcopy(self.get_error)
            return 200, copy.deepcopy(self.view)
        if method == "PUT":
            if self.put_status != 200:
                return self.put_status, copy.deepcopy(self.put_error)
            if self.put_reply is not None:
                self.view = copy.deepcopy(self.put_reply)
                return 200, copy.deepcopy(self.view)
            body = dict(json_body or {})
            self.view["value"] = body
            self.view["effective"] = dict(body)
            self.view["source"] = (
                "model" if body.get("level") == "inherit" else "session"
            )
            self.view["reason"] = None
            return 200, copy.deepcopy(self.view)
        return 404, {"detail": "unexpected method %s" % method}


class _RecordingRelay:
    """Fake relay: records every outbound frame in order."""

    def __init__(self):
        self.sent = []

    async def send(self, frame):
        self.sent.append(frame)


def _channel(app=None):
    """A real ``WebChannel`` wired to the fakes (no relay, no archiver work)."""
    channel = WebChannel(process=None)
    channel._agent_id = lambda: "agent-1"
    fake_app = _FakeApp() if app is None else app
    fake_relay = _RecordingRelay()
    channel._api_json = fake_app
    channel._relay = fake_relay
    return channel, fake_app, fake_relay


def _of_kind(frames, kind):
    return [frame for frame in frames if frame.get("t") == kind]


def _thinking_calls(app, method):
    return [
        call for call in app.calls
        if call["method"] == method and call["path"] == THINKING_PATH
    ]


# --------------------------------------------------------------------------
# Pure conversion helpers
# --------------------------------------------------------------------------

def test_effort_budget_ladder():
    low, high = 1000, 11000
    assert effort_budget("low", low, high) == 2500
    assert effort_budget("medium", low, high) == 5000
    assert effort_budget("high", low, high) == 8500
    assert effort_budget("max", low, high) == 11000
    # Not a selectable level / unusable range.
    assert effort_budget("default", low, high) is None
    assert effort_budget("minimal", low, high) is None
    assert effort_budget("medium", None, high) is None
    assert effort_budget("medium", 0, high) is None
    assert effort_budget("medium", high, low) is None
    assert effort_budget("medium", True, high) is None  # bool is not an int


def test_effort_budget_reverse_mapping():
    low, high = 1000, 11000
    assert effort_level_for_budget(1000, low, high) == "low"   # minimal -> low
    assert effort_level_for_budget(2500, low, high) == "low"   # 0.15
    assert effort_level_for_budget(4000, low, high) == "medium"
    assert effort_level_for_budget(5000, low, high) == "medium"  # 0.4
    assert effort_level_for_budget(8500, low, high) == "high"    # 0.75
    assert effort_level_for_budget(11000, low, high) == "max"    # 1.0
    assert effort_level_for_budget(500, low, high) == "low"      # below range
    assert effort_level_for_budget(20000, low, high) == "max"    # above range
    assert effort_level_for_budget(None, low, high) is None
    assert effort_level_for_budget(5, 1000, 1000) == "low"
    assert effort_level_for_budget(1001, 1000, 1000) == "max"


def test_effort_supported():
    assert effort_supported(
        _control("effort", efforts=["minimal", "low", "high"]),
    ) == ["low", "high"]
    assert effort_supported(
        _control("budget", budget_min=1, budget_max=10),
    ) == _EFFORT_FOUR
    assert effort_supported(_control("budget")) == []  # no usable range
    assert effort_supported(_control("unknown")) == []
    assert effort_supported(_control("unsupported")) == []
    assert effort_supported(None) == []


def test_effort_view_fields_effort_value():
    view = _view(
        level="high",
        control=_control("effort", efforts=["low", "medium", "high"]),
    )
    assert effort_view_fields(view) == {
        "level": "high",
        "effective_level": "high",
        "budget_tokens": None,
        "supported": ["low", "medium", "high"],
        "kind": "effort",
        "model_key": MODEL_KEY,
    }


def test_effort_view_fields_budget_value():
    view = _view(
        level="budget",
        budget_tokens=5000,
        control=_control("budget", budget_min=1000, budget_max=11000),
        effective={"level": "budget", "budget_tokens": 5000},
    )
    fields = effort_view_fields(view)
    assert fields["level"] == "medium"
    assert fields["effective_level"] == "budget"
    assert fields["budget_tokens"] == 5000
    assert fields["supported"] == _EFFORT_FOUR
    assert fields["kind"] == "budget"


def test_effort_view_fields_inherit_and_out_of_vocabulary():
    assert effort_view_fields(_view(level="inherit"))["level"] == "default"
    minimal = _view(
        level="minimal", control=_control("effort", efforts=["minimal"]),
    )
    assert effort_view_fields(minimal)["level"] == "low"
    xhigh = _view(
        level="xhigh", control=_control("effort", efforts=["xhigh"]),
    )
    assert effort_view_fields(xhigh)["level"] == "max"
    # Garbage never invents a level.
    assert effort_view_fields(None)["level"] == "default"
    assert effort_view_fields({"value": {"level": "off"}})["level"] == "default"
    budget_without_range = {
        "value": {"level": "budget", "budget_tokens": 10},
        "effective": {"level": "budget", "budget_tokens": 10},
        "control": _control("budget"),
    }
    assert effort_view_fields(budget_without_range)["level"] == "default"


# --------------------------------------------------------------------------
# Frame builder
# --------------------------------------------------------------------------

def test_effort_frame_shape():
    frame = effort_frame(
        "c", "high", effective_level="high", supported=["low", "high"],
        kind="effort", model_key=MODEL_KEY,
    )
    assert frame == {
        "t": "effort",
        "chat": "c",
        "level": "high",
        "effective": "high",
        "supported": ["low", "high"],
        "kind": "effort",
        "model_key": MODEL_KEY,
    }
    assert "seq" not in frame

    # effective defaults to the SPA level; optional keys stay out.
    minimal = effort_frame("c", "max", budget_tokens=11000, kind="budget")
    assert minimal == {
        "t": "effort",
        "chat": "c",
        "level": "max",
        "effective": "max",
        "budget_tokens": 11000,
        "kind": "budget",
    }
    # A supported list is copied, not aliased.
    supported = ["low"]
    copied = effort_frame("c", "low", supported=supported)
    copied["supported"].append("max")
    assert supported == ["low"]


# --------------------------------------------------------------------------
# get_effort handler
# --------------------------------------------------------------------------

def test_get_effort_maps_effort_view():
    async def scenario():
        app = _FakeApp(_view(
            level="high",
            control=_control("effort", efforts=["low", "medium", "high"]),
        ))
        channel, app, relay = _channel(app)
        await channel._on_relay_frame(
            {"t": "get_effort", "chat": WEB_CHAT, "id": "effort-get"},
        )

        frames = _of_kind(relay.sent, "effort")
        assert len(frames) == 1, relay.sent
        assert frames[0] == {
            "t": "effort",
            "chat": WEB_CHAT,
            "level": "high",
            "effective": "high",
            "supported": ["low", "medium", "high"],
            "kind": "effort",
            "model_key": MODEL_KEY,
        }
        assert "seq" not in frames[0]
        assert channel._seq.peek(WEB_CHAT) == 0
        assert channel._ring.since(WEB_CHAT, 0) == []
        assert [call["path"] for call in app.calls] == [
            "/api/chats", THINKING_PATH,
        ]
        assert app.calls[0]["params"] == {"channel": "web"}

    asyncio.run(scenario())


def test_get_effort_reverse_maps_budget():
    async def scenario():
        for tokens, expected in (
            (1000, "low"), (5000, "medium"), (8500, "high"), (11000, "max"),
        ):
            view = _view(
                level="budget",
                budget_tokens=tokens,
                control=_control(
                    "budget", budget_min=1000, budget_max=11000,
                ),
                effective={"level": "budget", "budget_tokens": tokens},
            )
            channel, app, relay = _channel(_FakeApp(view))
            await channel._on_relay_frame(
                {"t": "get_effort", "chat": WEB_CHAT},
            )
            frames = _of_kind(relay.sent, "effort")
            assert len(frames) == 1, relay.sent
            assert frames[0]["level"] == expected
            assert frames[0]["effective"] == "budget"
            assert frames[0]["budget_tokens"] == tokens
            assert frames[0]["supported"] == _EFFORT_FOUR
            assert frames[0]["kind"] == "budget"

    asyncio.run(scenario())


def test_get_effort_inherit_is_default():
    async def scenario():
        channel, app, relay = _channel(_FakeApp(_view(level="inherit")))
        await channel._on_relay_frame({"t": "get_effort", "chat": WEB_CHAT})
        frames = _of_kind(relay.sent, "effort")
        assert len(frames) == 1
        assert frames[0]["level"] == "default"
        assert frames[0]["effective"] == "inherit"

    asyncio.run(scenario())


def test_get_effort_without_chat_spec_is_404():
    async def scenario():
        app = _FakeApp()
        app.specs = []  # the chat has never received a message
        channel, app, relay = _channel(app)
        await channel._on_relay_frame(
            {"t": "get_effort", "chat": WEB_CHAT, "id": "effort-get"},
        )

        assert _of_kind(relay.sent, "effort") == []
        errors = _of_kind(relay.sent, "error")
        assert len(errors) == 1, relay.sent
        assert errors[0]["t"] == "error"
        assert errors[0]["code"] == "E_EFFORT"
        assert errors[0]["chat"] == WEB_CHAT
        assert errors[0]["status"] == 404
        assert errors[0]["id"] == "effort-get"
        assert "no QwenPaw chat" in errors[0]["detail"]
        assert _thinking_calls(app, "GET") == []

    asyncio.run(scenario())


def test_get_effort_http_404_is_e_effort():
    async def scenario():
        app = _FakeApp()
        app.get_status = 404
        app.get_error = {"detail": "Chat not found"}
        channel, app, relay = _channel(app)
        await channel._on_relay_frame({"t": "get_effort", "chat": WEB_CHAT})

        errors = _of_kind(relay.sent, "error")
        assert len(errors) == 1, relay.sent
        assert errors[0]["code"] == "E_EFFORT"
        assert errors[0]["status"] == 404
        assert "Chat not found" in errors[0]["detail"]
        assert _of_kind(relay.sent, "effort") == []

    asyncio.run(scenario())


# --------------------------------------------------------------------------
# set_effort handler
# --------------------------------------------------------------------------

def test_set_effort_default_puts_inherit_without_probe():
    async def scenario():
        app = _FakeApp(_view(
            level="high",
            control=_control("effort", efforts=["low", "high"]),
        ))
        channel, app, relay = _channel(app)
        await channel._on_relay_frame({
            "t": "set_effort", "chat": WEB_CHAT, "level": "default",
            "id": "effort-set",
        })

        puts = _thinking_calls(app, "PUT")
        assert len(puts) == 1, app.calls
        assert puts[0]["json"] == {"level": "inherit"}
        # default never needs the capability probe.
        assert _thinking_calls(app, "GET") == []

        frames = _of_kind(relay.sent, "effort")
        assert len(frames) == 1, relay.sent
        assert frames[0]["level"] == "default"
        assert frames[0]["effective"] == "inherit"
        assert _of_kind(relay.sent, "error") == []

    asyncio.run(scenario())


def test_set_effort_effort_kind_supported():
    async def scenario():
        app = _FakeApp(_view(
            level="inherit",
            control=_control("effort", efforts=["low", "medium", "high"]),
        ))
        channel, app, relay = _channel(app)
        await channel._on_relay_frame({
            "t": "set_effort", "chat": WEB_CHAT, "level": "high",
        })

        gets = _thinking_calls(app, "GET")
        puts = _thinking_calls(app, "PUT")
        assert len(gets) == 1 and len(puts) == 1, app.calls
        assert puts[0]["json"] == {"level": "high"}

        frames = _of_kind(relay.sent, "effort")
        assert len(frames) == 1, relay.sent
        assert frames[0]["level"] == "high"
        assert frames[0]["effective"] == "high"
        assert frames[0]["supported"] == ["low", "medium", "high"]
        assert frames[0]["kind"] == "effort"

    asyncio.run(scenario())


def test_set_effort_effort_kind_unsupported():
    async def scenario():
        app = _FakeApp(_view(
            level="inherit",
            control=_control("effort", efforts=["low", "medium"]),
        ))
        channel, app, relay = _channel(app)
        await channel._on_relay_frame({
            "t": "set_effort", "chat": WEB_CHAT, "level": "max",
            "id": "effort-set",
        })

        assert len(_thinking_calls(app, "GET")) == 1
        assert _thinking_calls(app, "PUT") == []
        errors = _of_kind(relay.sent, "error")
        assert len(errors) == 1, relay.sent
        assert errors[0]["code"] == "E_EFFORT"
        assert "does not support" in errors[0]["detail"]
        assert "max" in errors[0]["detail"]
        assert errors[0]["chat"] == WEB_CHAT
        assert errors[0]["id"] == "effort-set"
        assert _of_kind(relay.sent, "effort") == []

    asyncio.run(scenario())


def test_set_effort_budget_kind_converts_tokens():
    async def scenario():
        app = _FakeApp(_view(
            level="inherit",
            control=_control(
                "budget", budget_min=1000, budget_max=11000,
            ),
        ))
        channel, app, relay = _channel(app)
        await channel._on_relay_frame({
            "t": "set_effort", "chat": WEB_CHAT, "level": "high",
        })

        puts = _thinking_calls(app, "PUT")
        assert len(puts) == 1, app.calls
        assert puts[0]["json"] == {"level": "budget", "budget_tokens": 8500}

        frames = _of_kind(relay.sent, "effort")
        assert len(frames) == 1, relay.sent
        # The PUT answer stores 8500, which reverse-maps to "high".
        assert frames[0]["level"] == "high"
        assert frames[0]["effective"] == "budget"
        assert frames[0]["budget_tokens"] == 8500
        assert frames[0]["supported"] == _EFFORT_FOUR
        assert frames[0]["kind"] == "budget"

    asyncio.run(scenario())


def test_set_effort_budget_uses_returned_view():
    async def scenario():
        app = _FakeApp(_view(
            level="inherit",
            control=_control("budget", budget_min=1000, budget_max=11000),
        ))
        # The app may clamp/normalise the budget; its answer is authoritative.
        app.put_reply = _view(
            level="budget",
            budget_tokens=9000,
            control=_control("budget", budget_min=1000, budget_max=11000),
            effective={"level": "budget", "budget_tokens": 9000},
        )
        channel, app, relay = _channel(app)
        await channel._on_relay_frame({
            "t": "set_effort", "chat": WEB_CHAT, "level": "high",
        })

        frames = _of_kind(relay.sent, "effort")
        assert len(frames) == 1
        assert frames[0]["level"] == "high"
        assert frames[0]["budget_tokens"] == 9000

    asyncio.run(scenario())


def test_set_effort_unknown_and_unsupported_kinds():
    async def scenario():
        for kind in ("unknown", "unsupported"):
            app = _FakeApp(_view(level="inherit", control=_control(kind)))
            channel, app, relay = _channel(app)
            await channel._on_relay_frame({
                "t": "set_effort", "chat": WEB_CHAT, "level": "low",
            })

            assert _thinking_calls(app, "PUT") == []
            errors = _of_kind(relay.sent, "error")
            assert len(errors) == 1, relay.sent
            assert errors[0]["code"] == "E_EFFORT"
            assert _of_kind(relay.sent, "effort") == []

    asyncio.run(scenario())


def test_set_effort_without_chat_spec_is_404():
    async def scenario():
        app = _FakeApp()
        app.specs = []
        channel, app, relay = _channel(app)
        await channel._on_relay_frame({
            "t": "set_effort", "chat": WEB_CHAT, "level": "high",
            "id": "effort-set",
        })

        assert _thinking_calls(app, "GET") == []
        assert _thinking_calls(app, "PUT") == []
        errors = _of_kind(relay.sent, "error")
        assert len(errors) == 1, relay.sent
        assert errors[0]["code"] == "E_EFFORT"
        assert errors[0]["status"] == 404
        assert errors[0]["id"] == "effort-set"
        assert _of_kind(relay.sent, "effort") == []

    asyncio.run(scenario())


def test_set_effort_http_422_carries_server_detail():
    async def scenario():
        app = _FakeApp(_view(
            level="inherit",
            control=_control("effort", efforts=["low", "high"]),
        ))
        app.put_status = 422
        app.put_error = {"detail": "Thinking setting is invalid for this model"}
        channel, app, relay = _channel(app)
        await channel._on_relay_frame({
            "t": "set_effort", "chat": WEB_CHAT, "level": "high",
        })

        puts = _thinking_calls(app, "PUT")
        assert len(puts) == 1  # the write was attempted
        errors = _of_kind(relay.sent, "error")
        assert len(errors) == 1, relay.sent
        assert errors[0]["code"] == "E_EFFORT"
        assert errors[0]["status"] == 422
        assert "Thinking setting is invalid for this model" in errors[0]["detail"]
        assert _of_kind(relay.sent, "effort") == []

    asyncio.run(scenario())


def test_set_effort_invalid_level_never_calls_the_app():
    async def scenario():
        for level in (None, "", "MEDIUM", "xhigh", "minimal", 7):
            channel, app, relay = _channel()
            await channel._on_relay_frame({
                "t": "set_effort", "chat": WEB_CHAT, "level": level,
                "id": "effort-set",
            })

            assert app.calls == [], (level, app.calls)
            errors = _of_kind(relay.sent, "error")
            assert len(errors) == 1, (level, relay.sent)
            assert errors[0]["code"] == "E_EFFORT"
            assert errors[0]["chat"] == WEB_CHAT
            assert errors[0]["id"] == "effort-set"
            assert "unknown effort level" in errors[0]["detail"]
            assert _of_kind(relay.sent, "effort") == []

    asyncio.run(scenario())


def test_effort_errors_use_the_generic_error_shape():
    frame = error_frame("E_EFFORT", "boom")
    assert frame == {"t": "error", "code": "E_EFFORT", "detail": "boom"}


def test_effort_frames_are_control_frames():
    async def scenario():
        app = _FakeApp(_view(
            level="high",
            control=_control("effort", efforts=["low", "high"]),
        ))
        channel, app, relay = _channel(app)
        await channel._on_relay_frame({"t": "get_effort", "chat": WEB_CHAT})
        await channel._on_relay_frame({
            "t": "set_effort", "chat": WEB_CHAT, "level": "default",
        })

        assert relay.sent
        for frame in relay.sent:
            assert "seq" not in frame, frame
        assert channel._seq.peek(WEB_CHAT) == 0
        assert channel._ring.since(WEB_CHAT, 0) == []

    asyncio.run(scenario())


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
