#!/usr/bin/env python3
"""Standalone tests for the pure decision helpers in ``plugin/relay_client.py``.

The relay suites (M7.1/M7.2/M7.3) drive real sockets; these cases pin the
small pieces those scenarios only hit indirectly: compact frame encoding, the
auth-error classification, the 4000 close-code capture, queue re-insertion
order, and the generation/session invariants of a client.

No relay, no network and no pytest required (only ``websockets``, a plugin
runtime dependency):

    cd plugin && python3 tests/test_relay_pure.py
    cd plugin && python3 -m pytest tests/test_relay_pure.py -q
"""

import asyncio
import json
import os
import re
import socket
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_PLUGIN_DIR = os.path.dirname(_HERE)
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

from websockets.exceptions import ConnectionClosed  # noqa: E402
from websockets.frames import Close  # noqa: E402

from relay_client import RelayClient, _encode, _task_detail  # noqa: E402


def _client(**kwargs):
    return RelayClient("ws://127.0.0.1:1/ws/agent", "tok", **kwargs)


def _drain(client):
    frames = []
    while True:
        try:
            frames.append(client._queue.get_nowait())
        except asyncio.QueueEmpty:
            return frames


# --------------------------------------------------------------------------
# _encode
# --------------------------------------------------------------------------

def test_encode_uses_compact_json_and_keeps_unicode():
    text = _encode({"t": "msg", "chat": "c1", "text": "世界 😀"})
    assert text == '{"t":"msg","chat":"c1","text":"世界 😀"}'
    assert "\\u4e16" not in text


def test_encode_preserves_key_order():
    assert _encode({"b": 1, "a": 2}) == '{"b":1,"a":2}'


def test_encode_is_valid_json():
    frame = {"t": "evt", "chat": "c1", "seq": 3, "data": {"text": "x\ny"}}
    assert json.loads(_encode(frame)) == frame


# --------------------------------------------------------------------------
# _task_detail
# --------------------------------------------------------------------------

def test_task_detail_clean_cancelled_and_failed():
    async def scenario():
        async def ok():
            return 1

        async def boom():
            raise ValueError("kaput")

        clean = asyncio.create_task(ok())
        await clean
        assert _task_detail(clean) == ""

        failed = asyncio.create_task(boom())
        try:
            await failed
        except ValueError:
            pass
        detail = _task_detail(failed)
        assert "ValueError" in detail and "kaput" in detail

        parked = asyncio.create_task(asyncio.sleep(30))
        parked.cancel()
        try:
            await parked
        except asyncio.CancelledError:
            pass
        assert _task_detail(parked) == "cancelled"

    asyncio.run(scenario())


# --------------------------------------------------------------------------
# _is_auth_error
# --------------------------------------------------------------------------

class _Response:
    def __init__(self, status):
        self.status_code = status


class _HttpError(Exception):
    def __init__(self, status=None, response=None):
        super().__init__("http")
        if status is not None:
            self.status_code = status
        if response is not None:
            self.response = response


def test_is_auth_error_reads_response_status():
    assert RelayClient._is_auth_error(_HttpError(response=_Response(401))) is True
    assert RelayClient._is_auth_error(_HttpError(response=_Response(403))) is True
    assert RelayClient._is_auth_error(_HttpError(response=_Response(500))) is False


def test_is_auth_error_reads_direct_status():
    assert RelayClient._is_auth_error(_HttpError(status=401)) is True
    assert RelayClient._is_auth_error(_HttpError(status=403)) is True
    assert RelayClient._is_auth_error(_HttpError(status=404)) is False


def test_is_auth_error_is_false_without_a_status():
    assert RelayClient._is_auth_error(RuntimeError("offline")) is False
    assert RelayClient._is_auth_error(_HttpError()) is False


# --------------------------------------------------------------------------
# _note_close_code
# --------------------------------------------------------------------------

class _CodedError(Exception):
    def __init__(self, code):
        super().__init__("coded")
        self.code = code


def test_note_close_code_reads_a_generic_exception():
    client = _client()
    client._note_close_code(_CodedError(4000))
    assert client._close_code == 4000


def test_note_close_code_reads_connection_closed():
    client = _client()
    client._note_close_code(ConnectionClosed(Close(4000, "replaced"), None))
    assert client._close_code == 4000


def test_note_close_code_keeps_the_first_value():
    client = _client()
    client._note_close_code(ConnectionClosed(Close(4000, "replaced"), None))
    client._note_close_code(ConnectionClosed(Close(1011, "later"), None))
    assert client._close_code == 4000


def test_note_close_code_ignores_exceptions_without_a_code():
    client = _client()
    client._note_close_code(RuntimeError("no code"))
    assert client._close_code is None


# --------------------------------------------------------------------------
# _requeue / send
# --------------------------------------------------------------------------

def test_requeue_prepends_the_failed_frame_and_keeps_order():
    client = _client()
    client._queue.put_nowait({"t": "a"})
    client._queue.put_nowait({"t": "b"})
    client._requeue({"t": "failed"})
    assert _drain(client) == [{"t": "failed"}, {"t": "a"}, {"t": "b"}]


def test_requeue_on_an_empty_queue_puts_only_the_frame():
    client = _client()
    client._requeue({"t": "failed"})
    assert _drain(client) == [{"t": "failed"}]


def test_send_drops_an_oversize_frame():
    async def scenario():
        client = _client()
        await client.send({"t": "msg", "text": "x" * (300 * 1024)})
        assert _drain(client) == []

    asyncio.run(scenario())


def test_send_ignores_non_dict_frames():
    async def scenario():
        client = _client()
        await client.send("not a frame")
        await client.send(None)
        assert _drain(client) == []

    asyncio.run(scenario())


def test_send_drops_the_oldest_frame_when_the_queue_is_full():
    async def scenario():
        client = _client(queue_maxsize=2)
        await client.send({"t": "a"})
        await client.send({"t": "b"})
        await client.send({"t": "c"})
        assert _drain(client) == [{"t": "b"}, {"t": "c"}]

    asyncio.run(scenario())


# --------------------------------------------------------------------------
# generation / constructor invariants
# --------------------------------------------------------------------------

def test_session_is_32_hex_chars():
    client = _client()
    assert re.fullmatch(r"[0-9a-f]{32}", client.session), client.session
    assert client.session != _client().session


def test_started_us_is_an_integer_that_fits_a_js_double():
    first = _client()
    second = _client()
    assert isinstance(first.started_us, int)
    assert 0 < first.started_us <= 2 ** 53
    assert second.started_us >= first.started_us


def test_agent_id_blank_falls_back_to_default():
    assert RelayClient("ws://x", "t", agent_id="").agent_id == "default"
    assert RelayClient("ws://x", "t", agent_id="other").agent_id == "other"


def test_instance_defaults_to_hostname_and_accepts_an_override():
    assert _client().instance == socket.gethostname()
    assert _client(instance="workspace-a").instance == "workspace-a"


def test_hb_max_missed_is_floored_at_one():
    assert _client(hb_max_missed=0).hb_max_missed == 1
    assert _client(hb_max_missed=-5).hb_max_missed == 1
    assert _client(hb_max_missed=3).hb_max_missed == 3
    assert _client(hb_max_missed=2.9).hb_max_missed == 2


def test_tokens_and_urls_are_kept_verbatim():
    client = RelayClient("ws://relay/ws/agent", "secret")
    assert client.relay_url == "ws://relay/ws/agent"
    assert client.token == "secret"


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
