#!/usr/bin/env python3
"""Standalone tests for M12: conversation export (Markdown).

Covers the pure export helpers (``safe_export_title`` /
``build_export_markdown`` / ``chunk_utf8`` / ``sha256_hex``), the
``export_*`` frame builders, and the ``export`` handler driven through the
real ``WebChannel`` with a recording fake local API and relay.

Run either way (no pytest required; needs httpx for ``channel``):

    cd plugin && python3 tests/test_m12.py
    cd plugin && python3 -m pytest tests/test_m12.py -q
"""

import asyncio
import base64
import hashlib
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_PLUGIN_DIR = os.path.dirname(_HERE)
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

import channel as channel_module  # noqa: E402  (path setup must run first)
from channel import WebChannel  # noqa: E402
from frames import (  # noqa: E402
    export_begin_frame,
    export_chunk_frame,
    export_end_frame,
)
from util import (  # noqa: E402
    CHUNK_RAW_BYTES,
    EXPORT_BASIS,
    EXPORT_TITLE_MAX_CHARS,
    EXPORT_TOOL_OUTPUT_MAX_CHARS,
    build_export_markdown,
    chunk_utf8,
    safe_export_title,
    sha256_hex,
)

WEB_CHAT = "chat-1"
CHAT_UUID = "11111111-1111-1111-1111-111111111111"
SESSION_ID = "web:web-user:%s" % WEB_CHAT
EXPORTED_AT = "2026-10-27T12:00:00+08:00"
TS = "2026-10-27T10:00:00+08:00"


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------

def _message(mtype, role, content, ts=TS):
    """One ChatHistory ``Message`` (only the fields the exporter reads)."""
    message = {"type": mtype, "role": role, "content": content}
    if ts is not None:
        message["metadata"] = {"timestamp": ts}
    return message


def _text(value):
    return {"type": "text", "text": value}


def _file(name, url):
    return {"type": "file", "filename": name, "file_url": url}


def _call(name, arguments, call_id="c1"):
    return {
        "type": "data",
        "data": {"call_id": call_id, "name": name, "arguments": arguments},
    }


def _output(name, output, call_id="c1"):
    return {
        "type": "data",
        "data": {"call_id": call_id, "name": name, "output": output},
    }


def _history(messages):
    return {"messages": messages, "status": "idle"}


def _usage_message(role, text, oid="m1", usage=None, estimated=False):
    """Assistant ``Message`` carrying QwenPaw's per-turn usage metadata."""
    message = _message("MESSAGE", role, [_text(text)])
    inner = {}
    if usage is not None:
        payload = dict(usage)
        if estimated:
            payload["estimated"] = True
        inner["qwenpaw_turn_usage"] = {"usage": payload}
    message["metadata"] = {
        "timestamp": TS,
        "original_id": oid,
        "metadata": inner,
    }
    return message


def _mixed_history():
    return _history([
        _message("MESSAGE", "user", [_text("你好")]),
        _message("MESSAGE", "user", [
            _file("报告.pdf", "/home/agent/.qwenpaw/media/uuid/报告.pdf"),
        ]),
        _message("REASONING", "assistant", [_text("先分析问题")]),
        _message("PLUGIN_CALL", "assistant", [
            _call("web_search", '{"q": "x"}'),
        ]),
        _message("PLUGIN_CALL_OUTPUT", "assistant", [
            _output("web_search", '{"ok": true}'),
        ]),
        _message("MESSAGE", "assistant", [_text("最终答案")]),
    ])


class _FakeApp:
    """Recording stand-in for ``channel._api_json``."""

    def __init__(self, specs=None, name="测试会话"):
        self.calls = []
        self.specs = specs if specs is not None else [{
            "id": CHAT_UUID,
            "channel": "web",
            "session_id": SESSION_ID,
            "name": name,
        }]

    async def __call__(self, method, path, params=None, json_body=None):
        self.calls.append({
            "method": method,
            "path": path,
            "params": params,
            "json": json_body,
        })
        if method == "GET" and path == "/api/chats":
            return 200, json.loads(json.dumps(self.specs))
        return 404, {"detail": "unexpected request %s %s" % (method, path)}


class _RecordingRelay:
    """Fake relay: records every outbound frame in order."""

    def __init__(self):
        self.sent = []

    async def send(self, frame):
        self.sent.append(frame)


def _channel(app=None):
    channel = WebChannel(process=None)
    channel._agent_id = lambda: "agent-1"
    channel._api_json = _FakeApp() if app is None else app
    channel._relay = _RecordingRelay()
    # Tests do not need real pacing; keep the happy path instant.
    channel_module._EXPORT_CHUNK_PACE_S = 0.0
    return channel


def _of_kind(frames, kind):
    return [frame for frame in frames if frame.get("t") == kind]


def _exported_text(frames):
    """Reassemble one export's document bytes from its chunk frames."""
    chunks = _of_kind(frames, "export_chunk")
    return b"".join(base64.b64decode(frame["data"]) for frame in chunks)


# --------------------------------------------------------------------------
# Markdown assembly
# --------------------------------------------------------------------------

def test_markdown_mixed_conversation():
    doc = build_export_markdown(
        _mixed_history(), WEB_CHAT, "测试会话", EXPORTED_AT,
    )

    assert doc.startswith("# 测试会话\n")
    assert "- 导出时间：%s" % EXPORTED_AT in doc
    assert "- 消息条数：6" in doc
    assert EXPORT_BASIS in doc

    assert "### 用户 · %s" % TS in doc
    assert "你好" in doc
    assert "[附件: 报告.pdf]" in doc
    # An attachment only ever leaks its bare file name.
    assert "/home/agent" not in doc

    assert "<summary>思考过程</summary>" in doc
    assert "先分析问题" in doc

    assert "**工具调用** `web_search`" in doc
    assert '"q": "x"' in doc
    assert "**工具结果** `web_search`" in doc
    assert '"ok": true' in doc

    assert "### 助手 · %s" % TS in doc
    assert "最终答案" in doc
    # Original message order is preserved.
    assert doc.index("先分析问题") < doc.index("最终答案")


def test_markdown_empty_session_has_only_header():
    doc = build_export_markdown(
        _history([]), WEB_CHAT, "", EXPORTED_AT,
    )
    # No title -> the chat id is the fallback.
    assert doc.startswith("# %s\n" % WEB_CHAT)
    assert "- 消息条数：0" in doc
    assert EXPORT_BASIS in doc
    assert "###" not in doc
    assert "<details>" not in doc


def test_markdown_header_names_agent_and_model():
    doc = build_export_markdown(
        _history([]), WEB_CHAT, "测试会话", EXPORTED_AT,
        agent="小爪", model="openai/gpt-4o",
    )
    assert "- 智能体：小爪" in doc
    assert "- 模型：openai/gpt-4o" in doc
    assert (
        doc.index("- 智能体：")
        < doc.index("- 模型：")
        < doc.index("- 导出时间：")
        < doc.index("- 消息条数：")
    )


def test_markdown_header_omits_unknown_agent_and_model():
    doc = build_export_markdown(_history([]), WEB_CHAT, "t", EXPORTED_AT)
    assert "- 智能体：" not in doc
    assert "- 模型：" not in doc
    assert "- 导出时间：" in doc

    # A one-line safety cap: a hostile name cannot inject document structure.
    doc = build_export_markdown(
        _history([]), WEB_CHAT, "t", EXPORTED_AT,
        agent="a\n## b", model="m\n# n",
    )
    assert "- 智能体：a ## b" in doc
    assert "- 模型：m # n" in doc


def test_markdown_turn_usage_footnote():
    doc = build_export_markdown(_history([
        _message("MESSAGE", "user", [_text("你好")]),
        _usage_message(
            "assistant", "答", usage={"prompt_tokens": 1234,
                                      "completion_tokens": 567},
        ),
    ]), WEB_CHAT, "t", EXPORTED_AT)

    assert doc.count("> 本轮用量：") == 1
    assert "> 本轮用量：输入 1,234 · 输出 567 · 合计 1,801 tokens" in doc
    # The footnote sits under the answer, not under the user message.
    assert doc.index("> 本轮用量：") > doc.index("答")


def test_markdown_turn_usage_footnote_marks_estimated_and_partial():
    doc = build_export_markdown(_history([
        _usage_message(
            "assistant", "a", usage={"prompt_tokens": 10}, estimated=True,
        ),
    ]), WEB_CHAT, "t", EXPORTED_AT)
    assert "> 本轮用量：输入 10 tokens（估算）" in doc
    assert "输出" not in doc.split("> 本轮用量：", 1)[1]


def test_markdown_turn_usage_footnote_once_per_persisted_turn():
    # One persisted Msg split into reasoning + answer segments, both carrying
    # the same usage: only the answer text segment is an anchor.
    reasoning = _message("REASONING", "assistant", [_text("思考")])
    reasoning["metadata"] = {
        "timestamp": TS,
        "original_id": "m9",
        "metadata": {"qwenpaw_turn_usage": {"usage": {
            "prompt_tokens": 5, "completion_tokens": 2,
        }}},
    }
    doc = build_export_markdown(_history([
        reasoning,
        _usage_message(
            "assistant", "答案", oid="m9",
            usage={"prompt_tokens": 5, "completion_tokens": 2},
        ),
    ]), WEB_CHAT, "t", EXPORTED_AT)
    assert doc.count("> 本轮用量：") == 1
    assert doc.index("> 本轮用量：") > doc.index("答案")


def test_markdown_without_usage_has_no_footnote():
    doc = build_export_markdown(_mixed_history(), WEB_CHAT, "t", EXPORTED_AT)
    assert "本轮用量" not in doc


def test_markdown_attachment_only_message():
    doc = build_export_markdown(_history([
        _message("MESSAGE", "user", [
            _file("a.png", "data:image/png;base64,AAAA"),
        ]),
        _message("MESSAGE", "user", [
            {"type": "image", "image_url": "/tmp/media/pic one.png"},
        ]),
    ]), WEB_CHAT, "t", EXPORTED_AT)

    assert "- 消息条数：2" in doc
    assert "[附件: a.png]" in doc
    assert "[附件: pic one.png]" in doc
    assert "data:image" not in doc
    assert "/tmp/media" not in doc


def test_tool_output_truncated_but_text_not():
    body_text = "y" * (EXPORT_TOOL_OUTPUT_MAX_CHARS + 5000)
    tool_output = "x" * (EXPORT_TOOL_OUTPUT_MAX_CHARS + 5000)
    doc = build_export_markdown(_history([
        _message("MESSAGE", "assistant", [_text(body_text)]),
        _message("PLUGIN_CALL_OUTPUT", "assistant", [
            _output("run", tool_output),
        ]),
    ]), WEB_CHAT, "t", EXPORTED_AT)

    # Message text is never cut, while the tool copy is.
    assert body_text in doc
    assert tool_output not in doc
    assert "x" * EXPORT_TOOL_OUTPUT_MAX_CHARS in doc
    assert "已截断" in doc
    assert "原始 %d 个字符" % len(tool_output) in doc


def test_title_is_single_line_and_codepoint_truncated():
    assert safe_export_title("标题\n## 注入\x00", "fb") == "标题 ## 注入"
    assert safe_export_title("", "fb") == "fb"
    assert safe_export_title("   ", "fb") == "fb"

    long_title = safe_export_title("😀" * 300, "fb")
    assert long_title == "😀" * EXPORT_TITLE_MAX_CHARS + "…"
    assert long_title.count("�") == 0

    doc = build_export_markdown(
        _history([]), WEB_CHAT, "a\n# b", EXPORTED_AT,
    )
    assert doc.splitlines()[0] == "# a # b"


def test_attachment_without_name_uses_url_basename():
    doc = build_export_markdown(_history([
        _message("MESSAGE", "assistant", [{
            "type": "file",
            "file_url": "https://example.test/a/b/report.txt?token=1",
        }]),
    ]), WEB_CHAT, "t", EXPORTED_AT)
    assert "[附件: report.txt]" in doc
    assert "example.test" not in doc


# --------------------------------------------------------------------------
# Chunking
# --------------------------------------------------------------------------

def test_chunk_utf8_never_splits_code_points():
    data = ("前缀" + "😀" * 50000).encode("utf-8")
    chunks = chunk_utf8(data, CHUNK_RAW_BYTES)

    assert len(chunks) > 1
    assert b"".join(chunks) == data
    for chunk in chunks:
        assert len(chunk) <= CHUNK_RAW_BYTES
        assert chunk
        # Never starts on a continuation byte.
        assert chunk[0] & 0xC0 != 0x80
        chunk.decode("utf-8")


def test_chunk_utf8_backs_off_a_split_boundary():
    data = ("a" + "中" * 10).encode("utf-8")  # 1 + 3 * 10 bytes
    chunks = chunk_utf8(data, 11)

    assert b"".join(chunks) == data
    assert all(len(chunk) <= 11 for chunk in chunks)
    # 11 lands inside the 4th code point; the cut backs up to 10.
    assert len(chunks[0]) == 10
    for chunk in chunks:
        chunk.decode("utf-8")

    assert chunk_utf8(b"", 11) == []


def test_document_chunks_reassemble_with_multibyte_text():
    messages = [
        _message("MESSAGE", "assistant", [_text("中文内容😀" * 80)])
        for _ in range(300)
    ]
    doc = build_export_markdown(
        _history(messages), WEB_CHAT, "长文档", EXPORTED_AT,
    )
    data = doc.encode("utf-8")
    assert len(data) > CHUNK_RAW_BYTES * 2

    chunks = chunk_utf8(data)
    assert len(chunks) >= 2
    assert b"".join(chunks) == data
    assert b"".join(chunks).decode("utf-8") == doc
    for chunk in chunks:
        chunk.decode("utf-8")


def test_sha256_hex():
    assert sha256_hex(b"abc") == hashlib.sha256(b"abc").hexdigest()
    assert sha256_hex("中文") == hashlib.sha256(
        "中文".encode("utf-8"),
    ).hexdigest()


# --------------------------------------------------------------------------
# Frame builders
# --------------------------------------------------------------------------

def test_export_frame_shapes():
    begin = export_begin_frame("c", "e1", 1234, 2, "a" * 64)
    assert begin == {
        "t": "export_begin",
        "chat": "c",
        "id": "e1",
        "bytes": 1234,
        "chunks": 2,
        "sha256": "a" * 64,
    }
    chunk = export_chunk_frame("c", "e1", 0, "QUJD")
    assert chunk == {
        "t": "export_chunk", "chat": "c", "id": "e1", "i": 0, "data": "QUJD",
    }
    end = export_end_frame("c", "e1")
    assert end == {"t": "export_end", "chat": "c", "id": "e1"}
    for frame in (begin, chunk, end):
        assert "seq" not in frame


# --------------------------------------------------------------------------
# export handler
# --------------------------------------------------------------------------

def test_export_handler_happy_path():
    app = _FakeApp()
    channel = _channel(app)
    history = _mixed_history()

    async def fake_history(chat_id):
        assert chat_id == CHAT_UUID
        return history

    channel._get_history = fake_history
    asyncio.run(channel._on_relay_frame(
        {"t": "export", "chat": WEB_CHAT, "id": "exp-1"},
    ))

    frames = channel._relay.sent
    assert frames[0]["t"] == "export_begin"
    assert frames[-1]["t"] == "export_end"
    assert _of_kind(frames, "export_begin")[0] == frames[0]
    assert len(_of_kind(frames, "export_begin")) == 1
    assert len(_of_kind(frames, "export_end")) == 1

    begin = frames[0]
    assert begin["chat"] == WEB_CHAT
    assert begin["id"] == "exp-1"
    chunks = _of_kind(frames, "export_chunk")
    assert len(chunks) >= 1
    assert begin["chunks"] == len(chunks)
    assert [frame["i"] for frame in chunks] == list(range(len(chunks)))

    data = _exported_text(frames)
    assert len(data) == begin["bytes"]
    assert sha256_hex(data) == begin["sha256"]
    doc = data.decode("utf-8")
    assert doc.startswith("# 测试会话\n")
    assert "最终答案" in doc
    # Identity lookup succeeded for neither agent name nor model: the agent id
    # is the fallback and the model line is omitted entirely.
    assert "- 智能体：agent-1" in doc
    assert "- 模型：" not in doc

    for frame in frames:
        assert "seq" not in frame
    assert channel._seq.peek(WEB_CHAT) == 0
    assert channel._ring.since(WEB_CHAT, 0) == []
    # One lookup for the ChatSpec id, one for its title, then identity.
    assert [call["path"] for call in app.calls] == [
        "/api/chats", "/api/chats",
        "/api/agents/agent-1", "/api/models/active",
    ]


def test_export_handler_header_uses_agent_name_and_model():
    class _IdentityApp(_FakeApp):
        async def __call__(self, method, path, params=None, json_body=None):
            if method == "GET" and path == "/api/agents/agent-1":
                self.calls.append({
                    "method": method, "path": path,
                    "params": params, "json": json_body,
                })
                return 200, {"id": "agent-1", "name": "小爪"}
            if method == "GET" and path == "/api/models/active":
                self.calls.append({
                    "method": method, "path": path,
                    "params": params, "json": json_body,
                })
                return 200, {
                    "active_llm": {"provider_id": "openai", "model": "gpt-4o"},
                }
            return await super().__call__(method, path, params, json_body)

    channel = _channel(_IdentityApp())

    async def history(chat_id):
        return _history([])

    channel._get_history = history
    asyncio.run(channel._on_relay_frame(
        {"t": "export", "chat": WEB_CHAT, "id": "exp-identity"},
    ))

    doc = _exported_text(channel._relay.sent).decode("utf-8")
    assert "- 智能体：小爪" in doc
    assert "- 模型：openai/gpt-4o" in doc


def test_export_handler_empty_chat_still_exports_header():
    channel = _channel()

    async def empty_history(chat_id):
        return _history([])

    channel._get_history = empty_history
    asyncio.run(channel._on_relay_frame(
        {"t": "export", "chat": WEB_CHAT, "id": "exp-empty"},
    ))

    doc = _exported_text(channel._relay.sent).decode("utf-8")
    assert doc.startswith("# 测试会话\n")
    assert "- 消息条数：0" in doc
    assert "###" not in doc


def test_export_handler_multi_chunk_matches_begin():
    channel = _channel()
    messages = [
        _message("MESSAGE", "assistant", [_text("分块内容😀" * 2000)])
        for _ in range(4)
    ]

    async def large_history(chat_id):
        return _history(messages)

    channel._get_history = large_history
    asyncio.run(channel._on_relay_frame(
        {"t": "export", "chat": WEB_CHAT, "id": "exp-big"},
    ))

    frames = channel._relay.sent
    begin = _of_kind(frames, "export_begin")[0]
    assert begin["chunks"] > 1
    data = _exported_text(frames)
    assert len(data) == begin["bytes"]
    assert sha256_hex(data) == begin["sha256"]
    assert data.decode("utf-8").count("分块内容😀") == 4 * 2000


def test_export_handler_no_chat():
    app = _FakeApp(specs=[])
    channel = _channel(app)
    asyncio.run(channel._on_relay_frame(
        {"t": "export", "chat": WEB_CHAT, "id": "exp-404"},
    ))

    assert len(channel._relay.sent) == 1
    error = channel._relay.sent[0]
    assert error["t"] == "error"
    assert error["code"] == "E_EXPORT"
    assert error["chat"] == WEB_CHAT
    assert error["id"] == "exp-404"
    assert "seq" not in error


def test_export_handler_history_unavailable():
    channel = _channel()

    async def no_history(chat_id):
        return None

    channel._get_history = no_history
    asyncio.run(channel._on_relay_frame(
        {"t": "export", "chat": WEB_CHAT, "id": "exp-none"},
    ))

    frames = channel._relay.sent
    assert _of_kind(frames, "export_begin") == []
    errors = _of_kind(frames, "error")
    assert len(errors) == 1
    assert errors[0]["code"] == "E_EXPORT"
    assert errors[0]["id"] == "exp-none"


def test_export_handler_requires_id():
    channel = _channel()
    asyncio.run(channel._on_relay_frame({"t": "export", "chat": WEB_CHAT}))

    frames = channel._relay.sent
    assert len(frames) == 1
    assert frames[0]["t"] == "error"
    assert frames[0]["code"] == "E_EXPORT"
    assert frames[0]["chat"] == WEB_CHAT
    assert "id" not in frames[0]


def test_export_handler_too_big_sends_nothing_else():
    channel = _channel()

    async def any_history(chat_id):
        return _mixed_history()

    channel._get_history = any_history
    original = channel_module.MAX_EXPORT_BYTES
    channel_module.MAX_EXPORT_BYTES = 64
    try:
        asyncio.run(channel._on_relay_frame(
            {"t": "export", "chat": WEB_CHAT, "id": "exp-big"},
        ))
    finally:
        channel_module.MAX_EXPORT_BYTES = original

    frames = channel._relay.sent
    assert len(frames) == 1
    assert frames[0]["t"] == "error"
    assert frames[0]["code"] == "E_TOOBIG"
    assert frames[0]["id"] == "exp-big"


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
