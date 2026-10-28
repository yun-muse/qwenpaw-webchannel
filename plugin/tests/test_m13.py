#!/usr/bin/env python3
"""Standalone tests for M13: full-text search over the Turso archive.

Covers the pure search helpers (``escape_like`` / ``like_pattern`` /
``normalize_query`` / ``make_snippet`` / ``decode_value``), ``TursoSearcher``
against a recording fake transport, the ``search_results`` frame builder and
the ``search`` handler driven through the real ``WebChannel`` with a fake
searcher and a recording relay.

Run either way (no pytest required; needs httpx for ``channel``):

    cd plugin && python3 tests/test_m13.py
    cd plugin && python3 -m pytest tests/test_m13.py -q
"""

import asyncio
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_PLUGIN_DIR = os.path.dirname(_HERE)
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

from channel import WebChannel  # noqa: E402  (path setup must run first)
from frames import search_results_frame  # noqa: E402
from turso_search import (  # noqa: E402
    TursoSearcher,
    TursoSearchError,
    decode_value,
    escape_like,
    like_pattern,
    make_snippet,
    normalize_query,
)

# Dummy credential material only -- tests never touch a real token.
_TEST_TOKEN = "test-token"
_TEST_URL = "libsql://db-org.turso.io"
_PIPELINE = "https://db-org.turso.io/v2/pipeline"
_TS = 1700000000000
_FIRST_CHAT = "11111111-1111-1111-1111-111111111111"
_SECOND_CHAT = "22222222-2222-2222-2222-222222222222"


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------

def _text(value):
    return {"type": "text", "value": value}


def _integer(value):
    return {"type": "integer", "value": str(value)}


def _null():
    return {"type": "null"}


def _ok(rows):
    return {
        "type": "ok",
        "response": {"type": "execute", "result": {"rows": rows}},
    }


def _turso_error(message="boom"):
    return {"type": "error", "error": {"message": message}}


def _doc(count_rows, page_rows):
    return {"results": [_ok(count_rows), _ok(page_rows)]}


class _RecordingTransport:
    """Fake transport: records every call, then answers (or raises)."""

    def __init__(self, document=None, error=None):
        self.calls = []
        self.document = document
        self.error = error

    async def __call__(self, url, headers, body):
        self.calls.append((url, headers, body))
        if self.error is not None:
            raise self.error
        return self.document


class _FakeSearcher:
    """Stand-in for ``channel._searcher``."""

    def __init__(self, enabled=True, items=None, total=0, error=None):
        self.enabled = enabled
        self.items = items if items is not None else []
        self.total = total
        self.error = error
        self.calls = []

    async def search(self, query, limit, agent_id=""):
        self.calls.append({
            "query": query, "limit": limit, "agent_id": agent_id,
        })
        if self.error is not None:
            raise self.error
        return self.items, self.total


class _RecordingRelay:
    """Fake relay: records every outbound frame in order."""

    def __init__(self):
        self.sent = []

    async def send(self, frame):
        self.sent.append(frame)


def _channel(searcher):
    channel = WebChannel(process=None)
    channel._agent_id = lambda: "agent-1"
    channel._searcher = searcher
    channel._relay = _RecordingRelay()
    return channel


def _executes(body):
    return [req for req in body.get("requests") or []
            if req.get("type") == "execute"]


# --------------------------------------------------------------------------
# LIKE escaping / query normalisation
# --------------------------------------------------------------------------

def test_escape_like_specials():
    assert escape_like("%") == "\\%"
    assert escape_like("_") == "\\_"
    assert escape_like("\\") == "\\\\"


def test_escape_like_mixed():
    # a, \, %, _, b -> the backslash doubles and each wildcard gains one.
    assert escape_like("a\\%_b") == "a\\\\\\%\\_b"


def test_escape_like_plain_text_unchanged():
    assert escape_like("hello 世界 100%") == "hello 世界 100\\%"
    assert escape_like("plain text") == "plain text"
    assert escape_like("") == ""


def test_like_pattern_wraps():
    assert like_pattern("abc") == "%abc%"
    assert like_pattern("50%") == "%50\\%%"
    assert like_pattern("a_b") == "%a\\_b%"


def test_normalize_query_strips_and_collapses():
    assert normalize_query("  hello \n\t world  ") == "hello world"
    assert normalize_query("a   b\n\nc") == "a b c"


def test_normalize_query_truncates_to_100_chars():
    assert normalize_query("x" * 150) == "x" * 100
    # Collapsing happens before the cut, so padding never eats the budget.
    assert normalize_query("  " + "y" * 120 + "  ") == "y" * 100


def test_normalize_query_rejects_non_strings():
    assert normalize_query(None) == ""
    assert normalize_query(123) == ""
    assert normalize_query(["a"]) == ""
    assert normalize_query("   ") == ""


# --------------------------------------------------------------------------
# Snippets
# --------------------------------------------------------------------------

def _units(text):
    return len(text.encode("utf-16-le")) // 2


def test_snippet_hit_at_start():
    snippet, start, length = make_snippet("hello world", "hello", radius=5)
    assert snippet == "hello worl"
    assert (start, length) == (0, 5)


def test_snippet_hit_in_middle():
    snippet, start, length = make_snippet("aaTARGETbb", "TARGET", radius=3)
    assert snippet == "aaTARGETbb"
    assert (start, length) == (2, 6)


def test_snippet_hit_at_end():
    snippet, start, length = make_snippet("xxneedle", "needle", radius=2)
    assert snippet == "xxneedle"
    assert (start, length) == (2, 6)


def test_snippet_chinese_text():
    content = "这是一个测试句子"
    snippet, start, length = make_snippet(content, "测试", radius=2)
    assert snippet == "一个测试句子"
    assert (start, length) == (2, 2)
    assert snippet[start:start + length] == "测试"


def test_snippet_before_emoji_uses_utf16_units():
    content = "😀😀abc"
    snippet, start, length = make_snippet(content, "abc", radius=1)
    assert snippet == "😀abc"
    # Each emoji is one code point but two UTF-16 code units.
    assert (start, length) == (2, 3)

    raw = snippet.encode("utf-16-le")
    matched = raw[start * 2:(start + length) * 2].decode("utf-16-le")
    assert matched == "abc"


def test_snippet_ascii_case_insensitive_keeps_original_case():
    snippet, start, length = make_snippet("Hello World", "hello", radius=6)
    assert snippet == "Hello World"
    assert (start, length) == (0, 5)
    assert snippet[start:start + length] == "Hello"


def test_snippet_short_content_keeps_everything():
    snippet, start, length = make_snippet("hi", "hi", radius=40)
    assert snippet == "hi"
    assert (start, length) == (0, 2)


def test_snippet_missing_hit_falls_back():
    snippet, start, length = make_snippet("no needle here", "absent", radius=3)
    # 2 * radius + len(query) = 12 code points of the content.
    assert snippet == "no needle he"
    assert (start, length) == (-1, 0)


def test_snippet_never_splits_emoji():
    content = "😀" * 50 + "hit" + "😀" * 50
    snippet, start, length = make_snippet(content, "hit", radius=3)
    assert snippet == "😀😀😀hit😀😀😀"
    # Three astral code points are six UTF-16 units before the hit.
    assert _units(snippet[:3]) == start == 6
    raw = snippet.encode("utf-16-le")
    assert raw[start * 2:(start + length) * 2].decode("utf-16-le") == "hit"


# --------------------------------------------------------------------------
# Typed cell decoding
# --------------------------------------------------------------------------

def test_decode_value():
    assert decode_value({"type": "null"}) is None
    assert decode_value({"type": "integer", "value": "42"}) == 42
    assert decode_value({"type": "integer", "value": "-7"}) == -7
    assert decode_value({"type": "integer", "value": "nope"}) is None
    assert decode_value({"type": "float", "value": "1.5"}) == 1.5
    assert decode_value({"type": "float", "value": "nope"}) is None
    assert decode_value({"type": "text", "value": "x"}) == "x"
    assert decode_value({"type": "text"}) == ""
    assert decode_value({"type": "blob", "value": "AA=="}) is None
    assert decode_value("not-a-cell") is None


# --------------------------------------------------------------------------
# TursoSearcher
# --------------------------------------------------------------------------

def test_searcher_disabled_without_both_credentials():
    for url, token in (("", ""), (_TEST_URL, ""), ("", _TEST_TOKEN)):
        searcher = TursoSearcher(url, token)
        assert searcher.enabled is False
        try:
            asyncio.run(searcher.search("hello", 10))
        except TursoSearchError:
            pass
        else:  # pragma: no cover - the assertion below reports it
            raise AssertionError("disabled searcher did not raise")


def test_searcher_builds_count_and_page_in_one_pipeline():
    async def scenario():
        transport = _RecordingTransport(_doc(
            [[_integer(7)]],
            [
                [
                    _text(_FIRST_CHAT), _text("user"),
                    _text("Hello 世界 " * 20), _integer(_TS), _text("标题"),
                ],
                [
                    _text(_SECOND_CHAT), _text("assistant"),
                    _text("second hello match"), _integer(_TS + 1), _null(),
                ],
            ],
        ))
        searcher = TursoSearcher(_TEST_URL, _TEST_TOKEN, transport=transport)
        assert searcher.enabled is True

        items, total = await searcher.search("hello", 20, agent_id="agent-1")

        assert total == 7
        assert len(items) == 2
        # Only snippets travel; the message body never leaves the plugin.
        assert "content" not in items[0]
        assert items[0]["chat"] == _FIRST_CHAT
        assert items[0]["title"] == "标题"
        assert items[0]["role"] == "user"
        assert items[0]["ts"] == _TS
        assert items[0]["snippet"].startswith("Hello 世界")
        assert (items[0]["match_start"], items[0]["match_len"]) == (0, 5)
        # An empty title falls back to the chat id.
        assert items[1]["title"] == _SECOND_CHAT
        assert items[1]["ts"] == _TS + 1
        assert items[1]["match_start"] == 7

        assert len(transport.calls) == 1
        url, headers, body = transport.calls[0]
        assert url == _PIPELINE
        assert headers["Authorization"] == "Bearer " + _TEST_TOKEN
        assert headers["Content-Type"] == "application/json"

        executes = _executes(body)
        assert len(executes) == 2
        assert body["requests"][-1] == {"type": "close"}

        count_sql = executes[0]["stmt"]["sql"]
        page_sql = executes[1]["stmt"]["sql"]
        assert count_sql.startswith("SELECT COUNT(*) FROM messages m")
        assert "JOIN chats c ON c.chat_id = m.chat_id" in count_sql
        assert "LIKE ? ESCAPE '\\'" in count_sql
        assert "LIKE ? ESCAPE '\\'" in page_sql
        assert "LEFT JOIN chats c" in page_sql
        assert page_sql.endswith("LIMIT ?")
        assert "ORDER BY m.created_at DESC, m.id DESC" in page_sql

        pattern = {"type": "text", "value": "%hello%"}
        agent = {"type": "text", "value": "agent-1"}
        assert executes[0]["stmt"]["args"] == [pattern, agent]
        assert executes[1]["stmt"]["args"] == [
            pattern, agent, {"type": "integer", "value": "20"},
        ]

    asyncio.run(scenario())


def test_searcher_without_agent_omits_agent_clause():
    async def scenario():
        transport = _RecordingTransport(_doc([[ _integer(0) ]], []))
        searcher = TursoSearcher(_TEST_URL, _TEST_TOKEN, transport=transport)
        items, total = await searcher.search("_50%", 5)

        assert items == []
        assert total == 0
        url, _headers, body = transport.calls[0]
        executes = _executes(body)
        for request in executes:
            assert "c.agent_id" not in request["stmt"]["sql"]
        assert executes[0]["stmt"]["args"] == [
            {"type": "text", "value": "%\\_50\\%%"},
        ]
        assert executes[1]["stmt"]["args"] == [
            {"type": "text", "value": "%\\_50\\%%"},
            {"type": "integer", "value": "5"},
        ]

    asyncio.run(scenario())


def test_searcher_raises_on_turso_error_result():
    async def scenario():
        transport = _RecordingTransport({
            "results": [_turso_error("boom"), _ok([])],
        })
        searcher = TursoSearcher(_TEST_URL, _TEST_TOKEN, transport=transport)
        try:
            await searcher.search("hello", 10)
        except TursoSearchError as exc:
            assert "boom" in str(exc)
        else:  # pragma: no cover
            raise AssertionError("count error did not raise")

        # A failing page half must not look like "zero hits" either.
        transport = _RecordingTransport({
            "results": [_ok([[_integer(3)]]), _turso_error("nope")],
        })
        searcher = TursoSearcher(_TEST_URL, _TEST_TOKEN, transport=transport)
        try:
            await searcher.search("hello", 10)
        except TursoSearchError as exc:
            assert "nope" in str(exc)
        else:  # pragma: no cover
            raise AssertionError("page error did not raise")

    asyncio.run(scenario())


def test_searcher_wraps_transport_failure_without_retry():
    async def scenario():
        transport = _RecordingTransport(error=RuntimeError("turso is down"))
        searcher = TursoSearcher(_TEST_URL, _TEST_TOKEN, transport=transport)
        try:
            await searcher.search("hello", 10)
        except TursoSearchError as exc:
            assert "turso is down" in str(exc)
        else:  # pragma: no cover
            raise AssertionError("transport failure did not raise")
        # HTTP is tried exactly once; there is no retry on the read path.
        assert len(transport.calls) == 1

    asyncio.run(scenario())


def test_searcher_rejects_malformed_response():
    async def scenario():
        for document in (
            {}, {"results": []}, {"results": [_ok([])]}, "nope",
        ):
            searcher = TursoSearcher(
                _TEST_URL, _TEST_TOKEN,
                transport=_RecordingTransport(document),
            )
            try:
                await searcher.search("hello", 10)
            except TursoSearchError:
                pass
            else:  # pragma: no cover
                raise AssertionError("malformed %r did not raise" % (document,))

    asyncio.run(scenario())


# --------------------------------------------------------------------------
# Frame builder
# --------------------------------------------------------------------------

def test_search_results_frame_shape():
    items = [{"chat": "c1", "title": "t", "role": "user",
              "snippet": "x", "match_start": 0, "match_len": 1, "ts": 1}]
    frame = search_results_frame("s1", "q", items, 4)
    assert frame == {
        "t": "search_results",
        "id": "s1",
        "q": "q",
        "items": items,
        "total": 4,
    }
    assert "seq" not in frame
    assert "chat" not in frame


# --------------------------------------------------------------------------
# search handler
# --------------------------------------------------------------------------

def test_search_handler_disabled():
    searcher = _FakeSearcher(enabled=False)
    channel = _channel(searcher)
    asyncio.run(channel._on_relay_frame(
        {"t": "search", "id": "s1", "q": "hello"},
    ))

    frames = channel._relay.sent
    assert len(frames) == 1
    assert frames[0] == {
        "t": "error",
        "code": "E_SEARCH",
        "detail": "archive not configured",
        "id": "s1",
        "reason": "disabled",
    }
    assert "chat" not in frames[0]
    assert "seq" not in frames[0]
    assert searcher.calls == []


def test_search_handler_rejects_empty_query():
    searcher = _FakeSearcher(enabled=True)
    channel = _channel(searcher)
    for index, raw in enumerate(("   ", None, 42)):
        asyncio.run(channel._on_relay_frame(
            {"t": "search", "id": "bad-%d" % index, "q": raw},
        ))

    frames = channel._relay.sent
    assert len(frames) == 3
    for index, frame in enumerate(frames):
        assert frame["t"] == "error"
        assert frame["code"] == "E_SEARCH"
        assert frame["reason"] == "bad_query"
        assert frame["id"] == "bad-%d" % index
        assert "chat" not in frame
    assert searcher.calls == []


def test_search_handler_success_is_a_control_frame():
    items = [{
        "chat": "chat-9", "title": "旧会话", "role": "assistant",
        "snippet": "a needle b", "match_start": 2, "match_len": 6,
        "ts": _TS,
    }]
    searcher = _FakeSearcher(items=items, total=3)
    channel = _channel(searcher)

    asyncio.run(channel._on_relay_frame(
        {"t": "search", "id": "s3", "q": "  needle  ", "limit": 999},
    ))

    frames = channel._relay.sent
    assert len(frames) == 1
    assert frames[0] == {
        "t": "search_results",
        "id": "s3",
        "q": "needle",
        "items": items,
        "total": 3,
    }
    assert "seq" not in frames[0]
    assert searcher.calls == [
        {"query": "needle", "limit": 50, "agent_id": "agent-1"},
    ]
    # Control frame: no seq consumed and nothing ring-buffered.
    assert channel._seq.peek("chat-9") == 0
    assert channel._ring.since("chat-9", 0) == []


def test_search_handler_clamps_limit():
    searcher = _FakeSearcher(enabled=True)
    channel = _channel(searcher)

    asyncio.run(channel._on_relay_frame(
        {"t": "search", "id": "s4", "q": "x", "limit": 0},
    ))
    asyncio.run(channel._on_relay_frame(
        {"t": "search", "id": "s5", "q": "x", "limit": -3},
    ))
    asyncio.run(channel._on_relay_frame(
        {"t": "search", "id": "s6", "q": "x", "limit": "7"},
    ))
    asyncio.run(channel._on_relay_frame(
        {"t": "search", "id": "s7", "q": "x", "limit": True},
    ))

    assert [call["limit"] for call in searcher.calls] == [1, 1, 50, 50]


def test_search_handler_searcher_failure_is_unavailable():
    searcher = _FakeSearcher(error=RuntimeError("turso down"))
    channel = _channel(searcher)

    asyncio.run(channel._on_relay_frame(
        {"t": "search", "id": "s8", "q": "hello"},
    ))

    frames = channel._relay.sent
    assert len(frames) == 1
    frame = frames[0]
    assert frame["t"] == "error"
    assert frame["code"] == "E_SEARCH"
    assert frame["reason"] == "unavailable"
    assert frame["id"] == "s8"
    assert "chat" not in frame
    assert "seq" not in frame


def test_search_handler_without_id_is_dropped():
    searcher = _FakeSearcher(enabled=True)
    channel = _channel(searcher)

    asyncio.run(channel._on_relay_frame({"t": "search", "q": "hello"}))
    asyncio.run(channel._on_relay_frame(
        {"t": "search", "id": 7, "q": "hello"},
    ))

    assert channel._relay.sent == []
    assert searcher.calls == []


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
