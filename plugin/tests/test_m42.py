#!/usr/bin/env python3
"""Standalone tests for M42 part A: stopping a running turn.

What the plugin must guarantee (all against QwenPaw v2.2.2.post1):

* the stop POST carries the ``ChatSpec.id`` resolved from
  ``GET /api/chats?channel=web`` + session id, not the web chat id;
* a stop that arrives before the first turn's ChatSpec exists waits for it
  instead of being dropped;
* a stale cached id (``{"stopped": false}``) is re-resolved and retried;
* an HTTP/transport failure emits ``stop_error`` and leaves the turn alone;
* a closed turn produces exactly one ``turn`` frame and, when an answer
  stream was open, a full-text ``msg`` with ``stopped: true``;
* the runtime's own cancelled envelope (``on_event_response``) uses the
  authoritative partial text and closes the turn even when the stop handler
  did not get to it first;
* a normal completion / error closes the turn with ``state:"done"``;
* ``hist`` carries the backend's run status so a reload during a tool phase
  still offers 停止;
* a stop for a newer turn never closes the current one.

No pytest required:

    cd plugin && python3 tests/test_m42.py
    cd plugin && python3 -m pytest tests/test_m42.py -q
"""

import asyncio
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_PLUGIN_DIR = os.path.dirname(_HERE)
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

import channel as channel_module  # noqa: E402
from channel import WebChannel  # noqa: E402
from util import response_partial_text, response_status  # noqa: E402

CHAT = "chat-stop"
CHAT_UUID = "11111111-2222-3333-4444-555555555555"
SESSION = "web:web-user:%s" % CHAT


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class _RecordingRelay:
    def __init__(self):
        self.sent = []

    async def send(self, frame):
        self.sent.append(frame)


class _FakeApp:
    """``_api_json`` stand-in: chats list + stop endpoint."""

    def __init__(self, specs=None, specs_answers=None, stop_result=True,
                 stop_status=200, post_stop=None):
        self.specs = specs if specs is not None else [{
            "id": CHAT_UUID,
            "channel": "web",
            "session_id": SESSION,
        }]
        # Each GET /api/chats pops one entry; exhausted -> self.specs.
        self.specs_answers = list(specs_answers or [])
        self.stop_result = stop_result
        self.stop_status = stop_status
        # Optional callable(chat_id, call_index) -> (status, payload)
        self.post_stop = post_stop
        self.calls = []
        self.chat_calls = 0
        self.stop_calls = []

    async def __call__(self, method, path, params=None, json_body=None):
        self.calls.append({"method": method, "path": path, "params": params})
        if method == "GET" and path == "/api/chats":
            self.chat_calls += 1
            if self.specs_answers:
                return 200, self.specs_answers.pop(0)
            return 200, list(self.specs)
        if method == "POST" and path == "/api/console/chat/stop":
            chat_id = (params or {}).get("chat_id")
            self.stop_calls.append(chat_id)
            if self.post_stop is not None:
                return self.post_stop(chat_id, len(self.stop_calls))
            if self.stop_status >= 400:
                return self.stop_status, {"detail": "boom"}
            return 200, {"stopped": self.stop_result}
        return 404, {"detail": "unexpected %s %s" % (method, path)}


class _Request:
    def __init__(self, turn_id="%s#1" % CHAT):
        self.channel_meta = {"chat_id": CHAT, "turn_id": turn_id}
        self.session_id = SESSION


def _channel(app):
    ch = WebChannel(process=None)
    ch._agent_id = lambda: "agent-1"
    ch._api_json = app
    ch._relay = _RecordingRelay()
    return ch


def _of_kind(frames, kind):
    return [frame for frame in frames if frame.get("t") == kind]


async def _seed_answer_stream(ch, text="已经生成的部分回答"):
    """Open a message segment and flush *text* through the real hook."""
    # A real stream only exists after `_handle_msg` opened turn #1.
    ch._turn_serial[CHAT] = 1
    request = _Request()
    meta = {"chat_id": CHAT, "turn_id": "%s#1" % CHAT}
    await ch.on_streaming_start(request, "u", None, meta, "message")
    await ch.on_streaming_delta(request, "u", None, meta, "message", text)
    return request, meta


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------

class _Block:
    def __init__(self, type, text=None):
        self.type = type
        self.text = text


class _Msg:
    def __init__(self, content):
        self.content = content


class _Resp:
    def __init__(self, status, output):
        self.status = status
        self.output = output


def test_response_partial_text():
    resp = _Resp("cancelled", [_Msg([
        _Block("thinking", "想"),
        _Block("text", "前半"),
        {"type": "text", "text": "后半"},
        _Block("tool_call"),
    ])])
    assert response_partial_text(resp) == "前半后半"
    assert response_status(resp) == "cancelled"
    assert response_partial_text(None) == ""
    assert response_partial_text(_Resp("cancelled", [])) == ""


# ---------------------------------------------------------------------------
# Stop handler
# ---------------------------------------------------------------------------

def test_stop_posts_chatspec_id_and_closes_turn():
    async def run():
        app = _FakeApp()
        ch = _channel(app)
        await _seed_answer_stream(ch)
        await ch._handle_stop({"chat": CHAT})
        frames = ch._relay.sent
        assert app.stop_calls == [CHAT_UUID], app.stop_calls
        assert not _of_kind(frames, "stop_error"), frames
        ends = _of_kind(frames, "end")
        assert [f.get("stream_type") for f in ends] == ["message"], ends
        msgs = _of_kind(frames, "msg")
        assert len(msgs) == 1 and msgs[0].get("stopped") is True, msgs
        assert msgs[0]["parts"][0]["text"] == "已经生成的部分回答"
        turns = _of_kind(frames, "turn")
        assert len(turns) == 1 and turns[0]["state"] == "stopped", turns
        # A second stop (or the cancel hook arriving late) must not duplicate.
        await ch._handle_stop({"chat": CHAT})
        assert len(_of_kind(ch._relay.sent, "turn")) == 1

    asyncio.run(run())


def test_stop_waits_for_a_late_chatspec():
    async def run():
        old_wait = channel_module._STOP_SPEC_WAIT_S
        old_poll = channel_module._STOP_SPEC_POLL_S
        channel_module._STOP_SPEC_WAIT_S = 0.5
        channel_module._STOP_SPEC_POLL_S = 0.01
        try:
            # No spec for the first two lookups, then the real one.
            app = _FakeApp(specs_answers=[[], [], None])
            app.specs_answers[2] = app.specs
            ch = _channel(app)
            await ch._handle_stop({"chat": CHAT})
            assert app.chat_calls >= 3, app.chat_calls
            assert app.stop_calls == [CHAT_UUID], app.stop_calls
            assert _of_kind(ch._relay.sent, "turn")[-1]["state"] == "stopped"
        finally:
            channel_module._STOP_SPEC_WAIT_S = old_wait
            channel_module._STOP_SPEC_POLL_S = old_poll

    asyncio.run(run())


def test_stop_retries_a_stale_cached_id():
    async def run():
        app = _FakeApp()
        ch = _channel(app)
        ch._chat_ids[CHAT] = "old-uuid"

        def post(chat_id, index):
            return 200, {"stopped": chat_id != "old-uuid"}

        app.post_stop = post
        await ch._handle_stop({"chat": CHAT})
        assert app.stop_calls == ["old-uuid", CHAT_UUID], app.stop_calls
        assert ch._chat_ids[CHAT] == CHAT_UUID
        assert _of_kind(ch._relay.sent, "turn")[-1]["state"] == "stopped"

    asyncio.run(run())


def test_stop_http_failure_keeps_the_turn_open():
    async def run():
        app = _FakeApp(stop_status=500)
        ch = _channel(app)
        await _seed_answer_stream(ch)
        await ch._handle_stop({"chat": CHAT})
        errors = _of_kind(ch._relay.sent, "stop_error")
        assert len(errors) == 1 and errors[0]["code"] == "E_STOP", errors
        assert not _of_kind(ch._relay.sent, "turn")
        assert (CHAT, "message") in ch._active_streams

    asyncio.run(run())


def test_stop_without_any_chat_closes_the_browser_turn():
    async def run():
        app = _FakeApp(specs=[])
        ch = _channel(app)
        # Keep the test fast: no waiting window.
        original = channel_module._STOP_SPEC_WAIT_S
        channel_module._STOP_SPEC_WAIT_S = 0.0
        try:
            await ch._handle_stop({"chat": CHAT})
        finally:
            channel_module._STOP_SPEC_WAIT_S = original
        assert not app.stop_calls
        turns = _of_kind(ch._relay.sent, "turn")
        assert len(turns) == 1 and turns[0]["state"] == "done", turns

    asyncio.run(run())


def test_stopped_false_closes_without_the_badge():
    async def run():
        app = _FakeApp(stop_result=False)
        ch = _channel(app)
        await _seed_answer_stream(ch)
        await ch._handle_stop({"chat": CHAT})
        msgs = _of_kind(ch._relay.sent, "msg")
        assert len(msgs) == 1 and "stopped" not in msgs[0], msgs
        assert _of_kind(ch._relay.sent, "turn")[-1]["state"] == "done"

    asyncio.run(run())


# ---------------------------------------------------------------------------
# Runtime cancel envelope
# ---------------------------------------------------------------------------

def test_cancelled_envelope_uses_authoritative_text_and_closes_once():
    async def run():
        ch = _channel(_FakeApp())
        request, _meta = await _seed_answer_stream(ch, "flushed only")
        response = _Resp("cancelled", [_Msg([
            _Block("text", "flushed only and the unflushed tail"),
        ])])
        await ch.on_event_response(request, response)
        frames = ch._relay.sent
        msgs = _of_kind(frames, "msg")
        assert len(msgs) == 1 and msgs[0]["stopped"] is True, msgs
        assert msgs[0]["parts"][0]["text"] == "flushed only and the unflushed tail"
        evts = _of_kind(frames, "evt")
        # The tail beyond the last flushed delta was emitted before the msg.
        assert evts[-1]["data"]["text"] == " and the unflushed tail", evts
        turns = _of_kind(frames, "turn")
        assert len(turns) == 1 and turns[0]["state"] == "stopped"
        # A stop POST that lands afterwards must be a no-op for the frames.
        await ch._handle_stop({"chat": CHAT})
        assert len(_of_kind(ch._relay.sent, "turn")) == 1

    asyncio.run(run())


def test_completed_response_is_not_a_stop():
    async def run():
        ch = _channel(_FakeApp())
        request, _meta = await _seed_answer_stream(ch)
        await ch.on_event_response(
            request, _Resp("completed", [_Msg([_Block("text", "full")])]),
        )
        assert not _of_kind(ch._relay.sent, "turn")
        assert not _of_kind(ch._relay.sent, "msg")

    asyncio.run(run())


# ---------------------------------------------------------------------------
# Normal / error turn boundaries
# ---------------------------------------------------------------------------

def test_process_completed_emits_done():
    async def run():
        ch = _channel(_FakeApp())
        request, meta = await _seed_answer_stream(ch)
        await ch._on_process_completed(request, "u", meta)
        turns = _of_kind(ch._relay.sent, "turn")
        assert len(turns) == 1 and turns[0]["state"] == "done"

    asyncio.run(run())


def test_consume_error_sends_text_then_done():
    async def run():
        ch = _channel(_FakeApp())
        ch._turn_serial[CHAT] = 1
        request = _Request()
        await ch._on_consume_error(request, "u", "Error: boom")
        kinds = [frame.get("t") for frame in ch._relay.sent]
        assert kinds == ["msg", "turn"], kinds
        assert ch._relay.sent[0]["parts"][0]["text"] == "Error: boom"
        assert ch._relay.sent[1]["state"] == "done"

    asyncio.run(run())


def test_stale_turn_id_never_closes_the_newer_turn():
    async def run():
        ch = _channel(_FakeApp())
        ch._turn_serial[CHAT] = 2
        ch._turn_closed.pop(CHAT, None)
        emitted = await ch._finalize_turn(
            CHAT, "done", turn_id="%s#1" % CHAT,
        )
        assert emitted is False
        assert not _of_kind(ch._relay.sent, "turn")

    asyncio.run(run())


# ---------------------------------------------------------------------------
# hist.busy
# ---------------------------------------------------------------------------

def test_hist_carries_the_backend_run_status():
    async def run():
        ch = _channel(_FakeApp())

        async def history(chat_id):
            return {"messages": [], "status": "running"}

        ch._get_history = history
        await ch._handle_hist({"chat": CHAT})
        hist = _of_kind(ch._relay.sent, "hist")
        assert len(hist) == 1 and hist[0]["busy"] is True, hist

        async def idle(chat_id):
            return {"messages": [], "status": "idle"}

        ch._get_history = idle
        await ch._handle_hist({"chat": CHAT})
        hist = _of_kind(ch._relay.sent, "hist")
        assert hist[-1]["busy"] is False, hist

    asyncio.run(run())


def test_hist_without_status_omits_busy():
    async def run():
        ch = _channel(_FakeApp())

        async def history(chat_id):
            return {"messages": []}

        ch._get_history = history
        await ch._handle_hist({"chat": CHAT})
        hist = _of_kind(ch._relay.sent, "hist")
        assert "busy" not in hist[-1], hist

    asyncio.run(run())


# ---------------------------------------------------------------------------

def main():
    tests = [
        (name, fn) for name, fn in sorted(globals().items())
        if name.startswith("test_") and callable(fn)
    ]
    for name, fn in tests:
        fn()
        print("PASS %s" % name)
    print("ALL PASS (%d tests)" % len(tests))


if __name__ == "__main__":
    main()
