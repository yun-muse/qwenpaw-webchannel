#!/usr/bin/env python3
"""Standalone tests for the M6 Turso archiver (``plugin/turso_archive.py``).

Covers the pure builders (URL, typed args, pipeline body, schema, title,
attachment suffix, request builders) and the ``TursoArchiver`` queue/sender
against fake transports -- a recording one, an always-failing one, and one
that must never be called because the archiver is disabled.

No network access and no pytest required:

    cd plugin && python3 tests/test_turso.py
    cd plugin && python3 -m pytest tests/test_turso.py -q
"""

import asyncio
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_PLUGIN_DIR = os.path.dirname(_HERE)
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

from turso_archive import (  # noqa: E402  (path setup must run first)
    DEFAULT_MAX_QUEUE,
    PIPELINE_PATH,
    SCHEMA_STATEMENTS,
    TITLE_MAX,
    TursoArchiver,
    assistant_requests,
    chat_upsert_request,
    execute_request,
    format_files_suffix,
    make_title,
    message_insert_request,
    now_ms,
    pipeline_body,
    pipeline_url,
    schema_requests,
    typed_arg,
    user_requests,
)

# Dummy credential material only -- tests never touch a real token.
_TEST_TOKEN = "test-token"
_TEST_URL = "libsql://db-org.turso.io"
_PIPELINE = "https://db-org.turso.io/v2/pipeline"


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def _text(value):
    return {"type": "text", "value": value}


def _integer(value):
    return {"type": "integer", "value": str(value)}


def _execute(reqs):
    return [r for r in reqs if r.get("type") == "execute"]


def _insert_args(body, role):
    """Typed ``messages`` INSERT args for *role* in a pipeline body, or None."""
    for req in body.get("requests") or []:
        if req.get("type") != "execute":
            continue
        stmt = req.get("stmt") or {}
        if "INSERT INTO messages" not in str(stmt.get("sql") or ""):
            continue
        args = [arg.get("value") for arg in stmt.get("args") or []]
        if len(args) == 4 and args[1] == role:
            return args
    return None


async def _wait_for(predicate, timeout=5.0, interval=0.01):
    """Poll *predicate* without blocking the loop the sender task needs."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        await asyncio.sleep(interval)
    return predicate()


class _RecordingTransport:
    """Fake transport: records every call and always succeeds."""

    def __init__(self):
        self.calls = []

    async def __call__(self, url, headers, body):
        self.calls.append((url, headers, body))


class _FailingTransport:
    """Fake transport: always raises, counting the attempts."""

    def __init__(self):
        self.attempts = 0

    async def __call__(self, url, headers, body):
        self.attempts += 1
        raise RuntimeError("turso is down")


# --------------------------------------------------------------------------
# Pure builders
# --------------------------------------------------------------------------

def test_pipeline_url():
    assert pipeline_url(_TEST_URL) == _PIPELINE
    assert pipeline_url("libsql://db-org.turso.io/") == _PIPELINE
    assert pipeline_url("  libsql://db-org.turso.io/  ") == _PIPELINE
    assert pipeline_url("https://x/") == "https://x" + PIPELINE_PATH
    assert pipeline_url("wss://db.turso.io") == "https://db.turso.io" + PIPELINE_PATH
    assert pipeline_url("ws://127.0.0.1:8080/") == (
        "http://127.0.0.1:8080" + PIPELINE_PATH
    )
    assert PIPELINE_PATH == "/v2/pipeline"


def test_typed_arg():
    assert typed_arg(None) == {"type": "null"}
    assert typed_arg("hello") == {"type": "text", "value": "hello"}
    assert typed_arg("") == {"type": "text", "value": ""}
    # Integers travel as their STRING form in the pipeline format.
    assert typed_arg(42) == {"type": "integer", "value": "42"}
    assert typed_arg(0) == {"type": "integer", "value": "0"}
    assert typed_arg(-7) == {"type": "integer", "value": "-7"}


def test_pipeline_body():
    a = execute_request("SELECT 1")
    b = execute_request("SELECT 2")
    body = pipeline_body([a, b])
    assert body["requests"] == [a, b, {"type": "close"}]
    assert body["requests"][-1] == {"type": "close"}
    # The input list is not mutated and order is preserved.
    assert pipeline_body([]) == {"requests": [{"type": "close"}]}
    assert pipeline_body([a])["requests"][0] is a


def test_execute_request_shape():
    req = execute_request("SELECT ?, ?", [1, "two"])
    assert req == {
        "type": "execute",
        "stmt": {
            "sql": "SELECT ?, ?",
            "args": [
                {"type": "integer", "value": "1"},
                {"type": "text", "value": "two"},
            ],
        },
    }
    assert execute_request("VACUUM")["stmt"] == {"sql": "VACUUM", "args": []}


def test_schema_requests():
    assert len(SCHEMA_STATEMENTS) == 3
    reqs = schema_requests()
    assert len(reqs) == 3
    assert all(req["type"] == "execute" for req in reqs)
    sqls = [req["stmt"]["sql"] for req in reqs]
    assert "CREATE TABLE IF NOT EXISTS chats" in sqls[0]
    assert "CREATE TABLE IF NOT EXISTS messages" in sqls[1]
    assert "idx_messages_chat" in sqls[2]
    assert all("\n" not in sql for sql in sqls)  # single-line statements


def test_make_title():
    long_text = "x" * 100
    assert len(make_title(long_text)) == TITLE_MAX == 80
    assert make_title("x" * 100) == "x" * 80
    assert make_title("  hello \n\n world\tagain  ") == "hello world again"
    assert make_title("") == ""
    assert make_title(None) == ""
    assert make_title(123) == "123"


def test_format_files_suffix():
    assert format_files_suffix([]) == ""
    assert format_files_suffix(None) == ""
    assert format_files_suffix(
        [{"name": "a.png", "mime": "image/png", "size": 12}],
    ) == "\n[attachments: a.png (image/png, 12 bytes)]"
    assert format_files_suffix(
        [{"name": "a.png", "mime": "image/png", "size": None}],
    ) == "\n[attachments: a.png (image/png)]"
    # Unnamed / non-dict entries are skipped; empty mime gets the default.
    assert format_files_suffix(
        [
            {"name": "", "mime": "image/png", "size": 1},
            {"mime": "image/png", "size": 1},
            "not-a-dict",
            {"name": "b.bin", "mime": "", "size": 3},
        ],
    ) == "\n[attachments: b.bin (application/octet-stream, 3 bytes)]"
    assert format_files_suffix(
        [
            {"name": "a.png", "mime": "image/png", "size": 12},
            {"name": "b.bin", "mime": "", "size": None},
        ],
    ) == (
        "\n[attachments: a.png (image/png, 12 bytes); "
        "b.bin (application/octet-stream)]"
    )


def test_user_requests():
    files = [{"name": "a.png", "mime": "image/png", "size": 12}]
    reqs = user_requests("c1", "agent-1", "hi there", files, 1234)
    assert len(reqs) == 2
    upsert, insert = reqs
    assert "INSERT INTO chats" in upsert["stmt"]["sql"]
    assert upsert["stmt"]["args"] == [
        _text("c1"), _text("agent-1"), _integer(1234), _integer(1234),
        _text("hi there"),
    ]
    assert "INSERT INTO messages" in insert["stmt"]["sql"]
    assert insert["stmt"]["args"] == [
        _text("c1"), _text("user"),
        _text("hi there\n[attachments: a.png (image/png, 12 bytes)]"),
        _integer(1234),
    ]


def test_user_requests_without_files():
    reqs = user_requests("c1", "agent-1", "plain", [], 7)
    assert reqs[1]["stmt"]["args"][2] == _text("plain")
    assert reqs[0]["stmt"]["args"][4] == _text("plain")


def test_assistant_requests():
    reqs = assistant_requests("c1", "agent-1", "the answer", 99)
    assert len(reqs) == 2
    upsert, insert = reqs
    assert upsert["stmt"]["args"] == [
        _text("c1"), _text("agent-1"), _integer(99), _integer(99), _text(""),
    ]
    assert insert["stmt"]["args"] == [
        _text("c1"), _text("assistant"), _text("the answer"), _integer(99),
    ]
    assert assistant_requests("c1", "a", None, 1)[1]["stmt"]["args"][2] == _text("")


def test_upsert_and_insert_builders():
    upsert = chat_upsert_request("c1", "a1", 5, "t")
    assert upsert["stmt"]["args"] == [
        _text("c1"), _text("a1"), _integer(5), _integer(5), _text("t"),
    ]
    assert "ON CONFLICT(chat_id) DO UPDATE" in upsert["stmt"]["sql"]
    insert = message_insert_request("c1", "user", "x", 6)
    assert insert["stmt"]["args"] == [
        _text("c1"), _text("user"), _text("x"), _integer(6),
    ]


def test_now_ms_is_epoch_millis():
    before = int(time.time() * 1000)
    stamp = now_ms()
    after = int(time.time() * 1000)
    assert isinstance(stamp, int)
    assert before <= stamp <= after


def test_defaults():
    assert DEFAULT_MAX_QUEUE == 200
    assert TITLE_MAX == 80


# --------------------------------------------------------------------------
# Archiver behaviour
# --------------------------------------------------------------------------

def test_archiver_disabled_is_a_no_op():
    async def scenario():
        class _Forbidden:
            def __init__(self):
                self.calls = 0

            async def __call__(self, url, headers, body):
                self.calls += 1
                raise AssertionError("transport called while disabled")

        for url, token in (("", ""), (_TEST_URL, ""), ("", _TEST_TOKEN)):
            transport = _Forbidden()
            archiver = TursoArchiver(url, token, transport=transport)
            assert archiver.enabled is False
            await archiver.start()
            archiver.archive_user("c1", "hello", [])
            archiver.archive_assistant("c1", "hi")
            await archiver.stop()
            assert transport.calls == 0
            assert archiver.sent_batches == 0
            assert archiver.dropped_batches == 0
            assert archiver._task is None
            assert len(archiver._queue) == 0

    asyncio.run(scenario())


def test_archiver_queue_bound():
    archiver = TursoArchiver(
        _TEST_URL, _TEST_TOKEN, max_queue=2,
    )
    assert archiver.enabled is True
    for index in range(5):
        archiver.archive_user("c1", "msg %d" % index, [])
    assert len(archiver._queue) == 2
    assert archiver.dropped_batches == 3
    assert archiver._pipeline == _PIPELINE
    archiver.archive_assistant("c1", "reply")  # still full -> dropped
    assert len(archiver._queue) == 2
    assert archiver.dropped_batches == 4


def test_archiver_records_schema_user_and_assistant():
    async def scenario():
        transport = _RecordingTransport()
        archiver = TursoArchiver(
            _TEST_URL, _TEST_TOKEN, agent_id="agent-1", transport=transport,
            backoff_s=0.01,
        )
        assert archiver.enabled is True
        await archiver.start()
        archiver.archive_user(
            "chat-1", "hello user",
            [{"name": "a.png", "mime": "image/png", "size": 12}], 1000,
        )
        archiver.archive_assistant("chat-1", "hello assistant", 2000)

        ok = await _wait_for(lambda: archiver.sent_batches >= 3)
        assert ok, "sent_batches=%d calls=%d" % (
            archiver.sent_batches, len(transport.calls),
        )
        await archiver.stop()

        # The schema batch went first.
        url, headers, body = transport.calls[0]
        assert url == _PIPELINE
        assert headers["Authorization"] == "Bearer " + _TEST_TOKEN
        assert headers["Content-Type"] == "application/json"
        assert body["requests"][-1] == {"type": "close"}
        schema_sqls = [req["stmt"]["sql"] for req in _execute(body["requests"])]
        assert len(schema_sqls) == 3
        assert "CREATE TABLE IF NOT EXISTS chats" in schema_sqls[0]
        assert "CREATE TABLE IF NOT EXISTS messages" in schema_sqls[1]
        assert "idx_messages_chat" in schema_sqls[2]

        # Exact texts landed in the message INSERT args.
        bodies = [call[2] for call in transport.calls]
        user_args = None
        assistant_args = None
        for recorded in bodies:
            user_args = user_args or _insert_args(recorded, "user")
            assistant_args = assistant_args or _insert_args(recorded, "assistant")
        assert user_args == [
            "chat-1", "user",
            "hello user\n[attachments: a.png (image/png, 12 bytes)]", "1000",
        ]
        assert assistant_args == [
            "chat-1", "assistant", "hello assistant", "2000",
        ]

        # Every call carries the bearer header and the pipeline URL.
        assert all(call[0] == _PIPELINE for call in transport.calls)
        assert all(
            call[1]["Authorization"] == "Bearer " + _TEST_TOKEN
            for call in transport.calls
        )
        assert archiver.dropped_batches == 0
        assert archiver._task is None

    asyncio.run(scenario())


def test_archiver_failing_transport_never_raises():
    async def scenario():
        transport = _FailingTransport()
        archiver = TursoArchiver(
            _TEST_URL, _TEST_TOKEN, transport=transport, backoff_s=0.01,
        )
        await archiver.start()
        archiver.archive_user("chat-1", "hello", [])
        ok = await _wait_for(lambda: archiver.dropped_batches >= 2)
        assert ok, "dropped=%d attempts=%d" % (
            archiver.dropped_batches, transport.attempts,
        )
        await archiver.stop()
        # 2 batches (schema + user) x 2 tries.
        assert transport.attempts >= 4
        assert archiver.sent_batches == 0
        assert len(archiver._queue) == 0

    asyncio.run(scenario())


def test_archiver_start_is_idempotent():
    async def scenario():
        transport = _RecordingTransport()
        archiver = TursoArchiver(
            _TEST_URL, _TEST_TOKEN, transport=transport, backoff_s=0.01,
        )
        await archiver.start()
        task = archiver._task
        await archiver.start()  # second start must not spawn a second task
        assert archiver._task is task
        await _wait_for(lambda: archiver.sent_batches >= 1)
        await archiver.stop()
        assert archiver._task is None

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
