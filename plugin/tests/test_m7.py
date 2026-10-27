#!/usr/bin/env python3
"""Standalone tests for M7: model listing / switching + status push.

Covers the pure helpers ``util.model_items`` / ``util.active_llm_of`` /
``util.plan_model_switch``, the ``models`` / ``model_changed`` / ``status``
frame builders, and the handlers themselves -- driven through the real
``WebChannel`` with a recording fake local API and a recording fake relay, so
the assertions are about the frames that actually go out on the wire.

Run either way (no pytest required; needs httpx + qwenpaw for ``channel``):

    cd plugin && python3 tests/test_m7.py
    cd plugin && python3 -m pytest tests/test_m7.py -q
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
from frames import (  # noqa: E402
    model_changed_frame,
    models_frame,
    status_frame,
)
from util import active_llm_of, model_items, plan_model_switch  # noqa: E402

_ITEM_KEYS = {"provider", "model", "active"}


# --------------------------------------------------------------------------
# Fixtures / fakes
# --------------------------------------------------------------------------

def _provider(provider_id, **overrides):
    """One ``ProviderInfo``-shaped dict with the fields ``model_items`` reads."""
    provider = {
        "id": provider_id,
        "name": provider_id.title(),
        "enabled": True,
        "models": [],
        "extra_models": [],
        "hidden_model_ids": [],
        "removed_model_ids": [],
        "is_free_tier": False,
        "is_custom": False,
        "base_url": "",
        "require_api_key": True,
        "api_key": "",
    }
    provider.update(overrides)
    return provider


def _providers():
    """The fake app's provider list: openai (active), local (custom), disabled."""
    return [
        _provider(
            "openai",
            models=[{"id": "gpt-4o"}, {"id": "gpt-4o-mini"}],
            extra_models=[{"id": "o3"}],
            removed_model_ids=["gpt-4o-mini"],
            base_url="https://api.openai.com/v1",
            api_key="sk-test-not-a-real-key",
        ),
        _provider(
            "local",
            models=[{"id": "qwen3"}],
            is_custom=True,
            base_url="http://127.0.0.1:11434/v1",
        ),
        _provider(
            "off",
            models=[{"id": "ghost"}],
            api_key="sk-test-not-a-real-key",
            enabled=False,
        ),
    ]


class _FakeApp:
    """Recording stand-in for ``channel._api_json``.

    Serves the model endpoints from mutable state so a test can fail a call,
    fix it, and assert the handler recovered.
    """

    def __init__(
        self, providers=None, active=None, agent_name="Research Agent",
    ):
        self.providers = copy.deepcopy(
            _providers() if providers is None else providers,
        )
        self.active = dict(
            active or {"provider_id": "openai", "model": "gpt-4o"},
        )
        self.agent_name = agent_name
        self.calls = []
        self.models_status = 200
        self.put_status = 200
        self.put_error = None
        self.put_reply = None  # explicit PUT answer instead of an echo

    async def __call__(self, method, path, params=None, json_body=None):
        self.calls.append({
            "method": method,
            "path": path,
            "params": params,
            "json": json_body,
        })
        if method == "GET" and path == "/api/models":
            if self.models_status != 200:
                return self.models_status, None
            return 200, copy.deepcopy(self.providers)
        if method == "GET" and path == "/api/models/active":
            return 200, {
                "active_llm": dict(self.active) if self.active else None,
                "effective_max_input_length": 128000,
            }
        if method == "GET" and path.startswith("/api/agents/"):
            if self.agent_name is None:
                return 404, {"detail": "agent not found"}
            return 200, {"name": self.agent_name, "id": "agent-1"}
        if method == "PUT" and path == "/api/models/active":
            if self.put_status != 200:
                return self.put_status, self.put_error
            if self.put_reply is not None:
                return 200, copy.deepcopy(self.put_reply)
            body = json_body or {}
            self.active = {
                "provider_id": body.get("provider_id"),
                "model": body.get("model"),
            }
            return 200, {
                "active_llm": dict(self.active),
                "effective_max_input_length": 128000,
            }
        return 404, {"detail": "unexpected request %s %s" % (method, path)}


class _RecordingRelay:
    """Fake relay: records every outbound frame in order."""

    def __init__(self):
        self.sent = []

    async def send(self, frame):
        self.sent.append(frame)


def _channel(app=None, relay=None):
    """A real ``WebChannel`` wired to the fakes (no relay, no archiver work)."""
    channel = WebChannel(process=None)
    channel._agent_id = lambda: "agent-1"
    fake_app = _FakeApp() if app is None else app
    fake_relay = _RecordingRelay() if relay is None else relay
    channel._api_json = fake_app
    channel._relay = fake_relay
    return channel, fake_app, fake_relay


def _of_kind(frames, kind):
    return [frame for frame in frames if frame.get("t") == kind]


def _puts(app):
    return [call for call in app.calls if call["method"] == "PUT"]


def _assert_item_shape(items):
    """Every item is exactly ``{provider, model, active}`` -- nothing else."""
    for item in items:
        assert set(item) == _ITEM_KEYS, item
        assert isinstance(item["provider"], str) and item["provider"]
        assert isinstance(item["model"], str) and item["model"]
        assert isinstance(item["active"], bool)


def _dump(items):
    return " ".join(str(item) for item in items)


# --------------------------------------------------------------------------
# util.model_items
# --------------------------------------------------------------------------

def test_model_items_skips_disabled_provider():
    providers = [
        _provider("on", models=[{"id": "m"}], api_key="sk-x"),
        _provider("off", models=[{"id": "m"}], api_key="sk-x", enabled=False),
    ]
    items = model_items(providers)
    _assert_item_shape(items)
    assert items == [{"provider": "on", "model": "m", "active": False}]


def test_model_items_free_tier_needs_no_key():
    providers = [
        _provider("free", models=[{"id": "m"}], is_free_tier=True),
        _provider("hub-managed", models=[{"id": "h"}]),
    ]
    items = model_items(providers)
    _assert_item_shape(items)
    assert [item["provider"] for item in items] == ["free", "hub-managed"]


def test_model_items_key_required():
    missing = [_provider("p", models=[{"id": "m"}])]
    assert model_items(missing) == []

    present = [_provider("p", models=[{"id": "m"}], api_key="sk-x")]
    assert model_items(present) == [
        {"provider": "p", "model": "m", "active": False},
    ]

    # require_api_key defaulting to True also needs a key.
    implicit = _provider("p", models=[{"id": "m"}])
    del implicit["require_api_key"]
    assert model_items([implicit]) == []


def test_model_items_custom_needs_base_url():
    without = [_provider("c", models=[{"id": "m"}], is_custom=True)]
    assert model_items(without) == []

    with_url = [
        _provider(
            "c", models=[{"id": "m"}], is_custom=True,
            base_url="http://127.0.0.1:1234/v1",
        ),
    ]
    assert model_items(with_url) == [
        {"provider": "c", "model": "m", "active": False},
    ]


def test_model_items_require_api_key_false():
    providers = [
        _provider("p", models=[{"id": "m"}], require_api_key=False),
    ]
    assert model_items(providers) == [
        {"provider": "p", "model": "m", "active": False},
    ]


def test_model_items_merges_and_dedupes_models():
    providers = [
        _provider(
            "p",
            models=[{"id": "a"}, {"id": "b"}, {"id": ""}, {"name": "no id"}],
            extra_models=[{"id": "b"}, {"id": "c"}, "junk", {"id": 7}],
            api_key="sk-x",
        ),
    ]
    items = model_items(providers)
    _assert_item_shape(items)
    assert [item["model"] for item in items] == ["a", "b", "c"]


def test_model_items_excludes_removed_and_hidden():
    providers = [
        _provider(
            "p",
            models=[{"id": "a"}, {"id": "b"}],
            extra_models=[{"id": "c"}, {"id": "d"}],
            removed_model_ids=["b"],
            hidden_model_ids=["c"],
            api_key="sk-x",
        ),
    ]
    assert [item["model"] for item in model_items(providers)] == ["a", "d"]

    # Off-shape id lists are ignored rather than fatal.
    tolerant = [
        _provider(
            "p",
            models=[{"id": "a"}, {"id": "b"}],
            removed_model_ids="b",
            hidden_model_ids=None,
            api_key="sk-x",
        ),
    ]
    assert [item["model"] for item in model_items(tolerant)] == ["a", "b"]


def test_model_items_marks_active_once():
    providers = [
        _provider(
            "openai",
            models=[{"id": "gpt-4o"}, {"id": "gpt-4o-mini"}],
            api_key="sk-x",
        ),
        _provider("free", models=[{"id": "gpt-4o"}], is_free_tier=True),
    ]
    items = model_items(providers, "openai", "gpt-4o")
    _assert_item_shape(items)
    active = [item for item in items if item["active"]]
    assert active == [
        {"provider": "openai", "model": "gpt-4o", "active": True},
    ]
    assert len(items) == 3


def test_model_items_inserts_unlisted_active_pair():
    providers = [_provider("free", models=[{"id": "m"}], is_free_tier=True)]
    items = model_items(providers, "gone", "vanished")
    _assert_item_shape(items)
    assert items == [
        {"provider": "gone", "model": "vanished", "active": True},
        {"provider": "free", "model": "m", "active": False},
    ]
    assert [item["active"] for item in items] == [True, False]


def test_model_items_no_insert_without_both_active_args():
    providers = [_provider("free", models=[{"id": "m"}], is_free_tier=True)]
    assert model_items(providers, "gone", "") == [
        {"provider": "free", "model": "m", "active": False},
    ]
    assert model_items(providers, "", "vanished") == [
        {"provider": "free", "model": "m", "active": False},
    ]
    # Non-string active args are treated as absent, not compared against.
    assert model_items(providers, None, 7) == [
        {"provider": "free", "model": "m", "active": False},
    ]


def test_model_items_tolerates_garbage():
    for garbage in (None, "providers", 7, {"id": "p"}, [None, 3, "x", {}]):
        assert model_items(garbage) == []
    junk = [{"id": ""}, {"id": 5}, {"models": [{"id": "m"}]}]
    assert model_items(junk) == []
    # A provider with a broken models field simply has no usable models.
    broken = [{"id": "p", "models": "nope", "is_free_tier": True}]
    assert model_items(broken) == []


def test_model_items_never_leaks_provider_fields():
    providers = [_provider("p", models=[{"id": "m"}], api_key="sk-secret")]
    items = model_items(providers, "p", "m")
    _assert_item_shape(items)
    assert "sk-secret" not in _dump(items)
    assert "api_key" not in _dump(items)


# --------------------------------------------------------------------------
# util.active_llm_of / util.plan_model_switch
# --------------------------------------------------------------------------

def test_active_llm_of():
    assert active_llm_of(
        {"active_llm": {"provider_id": "openai", "model": "gpt-4o"}},
    ) == ("openai", "gpt-4o")
    assert active_llm_of({"active_llm": None}) == ("", "")
    assert active_llm_of({}) == ("", "")
    assert active_llm_of(None) == ("", "")
    assert active_llm_of("nope") == ("", "")
    assert active_llm_of({"active_llm": []}) == ("", "")
    assert active_llm_of({"active_llm": {"provider_id": 1, "model": None}}) == (
        "", "",
    )
    assert active_llm_of(
        {"active_llm": {"provider_id": "p", "model": "m"}, "extra": 1},
    ) == ("p", "m")


def _switch_items():
    return [
        {"provider": "openai", "model": "gpt-4o", "active": True},
        {"provider": "local", "model": "qwen3", "active": False},
    ]


def test_plan_model_switch():
    items = _switch_items()
    assert plan_model_switch(items, "openai", "gpt-4o", "", "") == (
        "error", "provider and model are required",
    )
    assert plan_model_switch(items, "openai", "gpt-4o", "openai", "")[0] == "error"
    assert plan_model_switch(items, "openai", "gpt-4o", "openai", "nope") == (
        "error", "unknown model: openai/nope",
    )
    assert plan_model_switch(
        items, "openai", "gpt-4o", "openai", "gpt-4o",
    ) == ("noop", "")
    assert plan_model_switch(
        items, "openai", "gpt-4o", "local", "qwen3",
    ) == ("put", "")
    # Nothing to compare against: the pair must still be listed.
    assert plan_model_switch([], "", "", "p", "m")[0] == "error"
    assert plan_model_switch(None, "", "", "p", "m")[0] == "error"


# --------------------------------------------------------------------------
# Frame builders
# --------------------------------------------------------------------------

def test_models_frame_shape():
    items = [{"provider": "p", "model": "m", "active": True}]
    frame = models_frame(items)
    assert frame == {"t": "models", "items": items}
    assert frame["items"] is items  # passed through untouched
    assert models_frame([]) == {"t": "models", "items": []}


def test_model_changed_frame_shape():
    assert model_changed_frame("openai", "gpt-4o") == {
        "t": "model_changed", "provider": "openai", "model": "gpt-4o",
    }


def test_status_frame_shape():
    assert status_frame("Research") == {
        "t": "status", "agent_name": "Research",
    }
    assert status_frame("Research", "openai", "gpt-4o") == {
        "t": "status", "agent_name": "Research",
        "provider": "openai", "model": "gpt-4o",
    }
    # Empty / missing values are omitted, not sent as nulls.
    assert status_frame("Research", "", None) == {
        "t": "status", "agent_name": "Research",
    }
    assert status_frame("Research", None, "gpt-4o") == {
        "t": "status", "agent_name": "Research", "model": "gpt-4o",
    }


# --------------------------------------------------------------------------
# Handlers through the real WebChannel
# --------------------------------------------------------------------------

def test_models_handler_lists_items():
    async def scenario():
        channel, app, relay = _channel()
        await channel._on_relay_frame({"t": "models"})

        frames = _of_kind(relay.sent, "models")
        assert len(frames) == 1, relay.sent
        assert relay.sent == frames  # nothing else was sent
        items = frames[0]["items"]
        _assert_item_shape(items)
        assert items == [
            {"provider": "openai", "model": "gpt-4o", "active": True},
            {"provider": "openai", "model": "o3", "active": False},
            {"provider": "local", "model": "qwen3", "active": False},
        ]
        assert [item["active"] for item in items].count(True) == 1
        # The raw provider objects (api_key included) never reach the wire.
        assert "sk-test-not-a-real-key" not in repr(relay.sent)
        # The effective-scope lookup names the bound agent.
        active_calls = [
            call for call in app.calls if call["path"] == "/api/models/active"
        ]
        assert active_calls == [{
            "method": "GET",
            "path": "/api/models/active",
            "params": {"scope": "effective", "agent_id": "agent-1"},
            "json": None,
        }]

    asyncio.run(scenario())


def test_models_handler_survives_a_failing_app():
    async def scenario():
        channel, app, relay = _channel()
        app.models_status = 0
        await channel._on_relay_frame({"t": "models"})

        errors = _of_kind(relay.sent, "error")
        assert len(errors) == 1, relay.sent
        assert errors[0]["code"] == "E_MODEL"
        assert _of_kind(relay.sent, "models") == []

        # The handler is still alive: a working app now answers normally.
        app.models_status = 200
        await channel._on_relay_frame({"t": "models"})
        frames = _of_kind(relay.sent, "models")
        assert len(frames) == 1
        assert len(frames[0]["items"]) == 3
        assert len(_of_kind(relay.sent, "error")) == 1

    asyncio.run(scenario())


def test_models_handler_rejects_a_non_list_payload():
    async def scenario():
        channel, app, relay = _channel()
        app.providers = {"not": "a list"}
        await channel._on_relay_frame({"t": "models"})
        errors = _of_kind(relay.sent, "error")
        assert len(errors) == 1 and errors[0]["code"] == "E_MODEL"
        assert "model list unavailable" in errors[0]["detail"]

    asyncio.run(scenario())


def test_set_model_switches():
    async def scenario():
        channel, app, relay = _channel()
        await channel._on_relay_frame(
            {"t": "set_model", "provider": "local", "model": "qwen3"},
        )

        puts = _puts(app)
        assert len(puts) == 1, app.calls
        assert puts[0]["path"] == "/api/models/active"
        assert puts[0]["json"] == {
            "provider_id": "local",
            "model": "qwen3",
            "scope": "agent",
            "agent_id": "agent-1",
        }
        assert app.active == {"provider_id": "local", "model": "qwen3"}

        changed = _of_kind(relay.sent, "model_changed")
        assert changed == [{
            "t": "model_changed", "provider": "local", "model": "qwen3",
        }]
        statuses = _of_kind(relay.sent, "status")
        assert len(statuses) == 1, relay.sent
        assert statuses[0]["agent_name"] == "Research Agent"
        assert statuses[0]["provider"] == "local"
        assert statuses[0]["model"] == "qwen3"
        # model_changed comes first, then the refreshed status.
        kinds = [frame["t"] for frame in relay.sent]
        assert kinds == ["model_changed", "status"]
        assert _of_kind(relay.sent, "error") == []

    asyncio.run(scenario())


def test_model_changed_uses_the_put_response_pair():
    async def scenario():
        channel, app, relay = _channel()
        # The app may answer with the pair it actually stored (normalised
        # ids); that answer -- not the request -- is what the client is told.
        app.put_reply = {
            "active_llm": {"provider_id": "local", "model": "qwen3:latest"},
            "effective_max_input_length": 4096,
        }
        app.active = {"provider_id": "local", "model": "qwen3:latest"}
        await channel._on_relay_frame(
            {"t": "set_model", "provider": "local", "model": "qwen3"},
        )
        assert _of_kind(relay.sent, "model_changed") == [{
            "t": "model_changed",
            "provider": "local",
            "model": "qwen3:latest",
        }]
        statuses = _of_kind(relay.sent, "status")
        assert statuses[0]["provider"] == "local"
        assert statuses[0]["model"] == "qwen3:latest"

    asyncio.run(scenario())


def test_model_changed_falls_back_to_the_requested_pair():
    async def scenario():
        channel, app, relay = _channel()
        app.put_reply = {"effective_max_input_length": 4096}  # no active_llm
        await channel._on_relay_frame(
            {"t": "set_model", "provider": "local", "model": "qwen3"},
        )
        assert _of_kind(relay.sent, "model_changed") == [{
            "t": "model_changed", "provider": "local", "model": "qwen3",
        }]

    asyncio.run(scenario())


def test_set_model_to_active_pair_is_a_noop():
    async def scenario():
        channel, app, relay = _channel()
        await channel._on_relay_frame(
            {"t": "set_model", "provider": "openai", "model": "gpt-4o"},
        )
        assert _puts(app) == []
        assert _of_kind(relay.sent, "model_changed") == [{
            "t": "model_changed", "provider": "openai", "model": "gpt-4o",
        }]
        assert _of_kind(relay.sent, "error") == []

    asyncio.run(scenario())


def test_set_model_unknown_pair_is_e_model():
    async def scenario():
        channel, app, relay = _channel()
        await channel._on_relay_frame(
            {"t": "set_model", "provider": "openai", "model": "does-not-exist"},
        )
        assert _puts(app) == []
        errors = _of_kind(relay.sent, "error")
        assert len(errors) == 1, relay.sent
        assert errors[0]["code"] == "E_MODEL"
        assert "unknown model: openai/does-not-exist" in errors[0]["detail"]
        assert _of_kind(relay.sent, "model_changed") == []

    asyncio.run(scenario())


def test_set_model_requires_both_fields():
    async def scenario():
        channel, app, relay = _channel()
        await channel._on_relay_frame({"t": "set_model", "provider": "local"})
        assert _puts(app) == []
        errors = _of_kind(relay.sent, "error")
        assert len(errors) == 1 and errors[0]["code"] == "E_MODEL"
        assert "provider and model are required" in errors[0]["detail"]

    asyncio.run(scenario())


def test_set_model_app_rejection_carries_app_detail():
    async def scenario():
        channel, app, relay = _channel()
        app.put_status = 400
        app.put_error = {"detail": "Model 'x' not found in provider 'y'."}
        await channel._on_relay_frame(
            {"t": "set_model", "provider": "local", "model": "qwen3"},
        )

        assert len(_puts(app)) == 1  # the PUT was attempted
        errors = _of_kind(relay.sent, "error")
        assert len(errors) == 1, relay.sent
        assert errors[0]["code"] == "E_MODEL"
        assert "Model 'x' not found in provider 'y'." in errors[0]["detail"]
        assert _of_kind(relay.sent, "model_changed") == []

    asyncio.run(scenario())


def test_set_model_unreachable_app():
    async def scenario():
        channel, app, relay = _channel()
        app.put_status = 0
        await channel._on_relay_frame(
            {"t": "set_model", "provider": "local", "model": "qwen3"},
        )
        errors = _of_kind(relay.sent, "error")
        assert len(errors) == 1 and errors[0]["code"] == "E_MODEL"
        assert "app unreachable" in errors[0]["detail"]
        assert _of_kind(relay.sent, "model_changed") == []

    asyncio.run(scenario())


def test_peer_pushes_status():
    async def scenario():
        channel, app, relay = _channel()
        await channel._on_relay_frame({"t": "peer", "clients": 1})

        assert len(relay.sent) == 1, relay.sent
        assert relay.sent[0] == {
            "t": "status",
            "agent_name": "Research Agent",
            "provider": "openai",
            "model": "gpt-4o",
        }
        agent_calls = [
            call for call in app.calls if call["path"].startswith("/api/agents/")
        ]
        assert [call["path"] for call in agent_calls] == ["/api/agents/agent-1"]

        # The name is cached: a second presence update does not re-fetch it.
        await channel._on_relay_frame({"t": "peer", "clients": 0})
        assert len(_of_kind(relay.sent, "status")) == 2
        agent_calls = [
            call for call in app.calls if call["path"].startswith("/api/agents/")
        ]
        assert len(agent_calls) == 1

    asyncio.run(scenario())


def test_ready_pushes_status():
    async def scenario():
        channel, app, relay = _channel()
        await channel._on_relay_frame({"t": "ready", "agentOnline": True})
        statuses = _of_kind(relay.sent, "status")
        assert len(statuses) == 1
        assert statuses[0]["agent_name"] == "Research Agent"

    asyncio.run(scenario())


def test_status_falls_back_to_the_agent_id():
    async def scenario():
        channel, app, relay = _channel()
        app.agent_name = None  # GET /api/agents/agent-1 answers 404
        await channel._on_relay_frame({"t": "peer", "clients": 1})
        statuses = _of_kind(relay.sent, "status")
        assert statuses == [{
            "t": "status", "agent_name": "agent-1",
            "provider": "openai", "model": "gpt-4o",
        }]
        assert channel._agent_name is None  # failures are not cached

    asyncio.run(scenario())


def test_control_frames_consume_no_seq_and_keep_the_archiver():
    async def scenario():
        channel, app, relay = _channel()
        await channel._on_relay_frame({"t": "peer", "clients": 1})
        await channel._on_relay_frame({"t": "models"})
        await channel._on_relay_frame(
            {"t": "set_model", "provider": "local", "model": "qwen3"},
        )

        assert relay.sent  # something was sent
        for frame in relay.sent:
            assert "seq" not in frame, frame
        assert channel._seq.peek("default") == 0
        assert channel._ring.since("default", 0) == []
        # M6 wiring is untouched: the archiver still exists on the channel.
        assert channel._archiver is not None

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
