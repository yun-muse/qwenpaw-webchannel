#!/usr/bin/env python3
"""Standalone tests for M35: the real attachment path, and multi-attachment.

Part 1 -- the hosted acceptance rendered a history image as a file chip even
though the mock e2e rendered a thumbnail. The fixtures here are the *real*
wire shapes: ``tests/fixtures/real_history_m35.json`` is a
``GET /api/chats/{id}`` body captured from QwenPaw v2.2.2.post1 through
``ConsoleChannel.stream_one`` + ``Agent._handle_incoming_messages`` +
``SafeJSONSession`` + ``chats.api.get_chat``, and its ``hist`` block is the
projection of that body. The tests below pin that projection and pin the
media-root resolution the byte fetch uses (the only check that can fail while
hist still shows the original name and the exact size).

Part 2 -- one message may carry several attachments: the 10-per-message cap
and the 10 MB per-message budget, both mirrored in the SPA.

Run either way (no pytest required; needs httpx for ``channel``):

    cd plugin && ~/workspace/qwenpaw-local/venv/bin/python tests/test_m35.py
    cd plugin && python3 -m pytest tests/test_m35.py -q
"""

import asyncio
import base64
import hashlib
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

_HERE = os.path.dirname(os.path.abspath(__file__))
_PLUGIN_DIR = os.path.dirname(_HERE)
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

import channel as channel_module  # noqa: E402  (path setup must run first)
from channel import WebChannel  # noqa: E402
from util import (  # noqa: E402
    MAX_MESSAGE_ATTACHMENTS,
    MAX_MESSAGE_ATTACHMENT_BYTES,
    attachment_media_dir,
    history_messages,
    media_file_path_in,
)

REPO = Path(_PLUGIN_DIR).parent
FIXTURE = REPO / "tests" / "fixtures" / "real_history_m35.json"
SAMPLE_PNG = REPO / "tests" / "fixtures" / "m31-acceptance.png"

WEB_CHAT = "chat-35"
CHAT_UUID = "35353535-3535-3535-3535-353535353535"


# --------------------------------------------------------------------------
# Fakes
# --------------------------------------------------------------------------

class _RecordingRelay:
    def __init__(self):
        self.sent = []

    async def send(self, frame):
        self.sent.append(frame)
        return True


def _channel():
    channel = WebChannel(process=None)
    channel._agent_id = lambda: "agent-35"
    channel._relay = _RecordingRelay()
    # No network in a unit test: the config lookup is reported as done.
    channel._console_media_dir_checked = True
    channel_module._ATT_CHUNK_PACE_S = 0.0
    return channel


def _async(value):
    async def run():
        return value
    return run()


def _history(messages):
    return {"messages": messages, "status": "idle"}


def _serve(channel, media_dir, history, chat=WEB_CHAT):
    channel._media_dir = lambda: Path(media_dir)
    channel._resolve_chat_id = lambda _chat: _async(CHAT_UUID)
    channel._get_history = lambda _cid: _async(history)
    asyncio.run(channel._handle_hist({"t": "hist", "chat": chat}))
    return [
        message
        for frame in channel._relay.sent
        if frame.get("t") == "hist"
        for message in frame.get("messages", [])
    ]


def _att_get(channel, ref, chat=WEB_CHAT, att_id="req-35"):
    before = len(channel._relay.sent)
    asyncio.run(channel._handle_att_get(
        {"t": "att_get", "chat": chat, "id": att_id, "ref": ref},
    ))
    return channel._relay.sent[before:]


def _kinds(frames):
    return [frame.get("t") for frame in frames]


def _fixture(which):
    """``{"messages": [...], "status": "idle"}`` plus the expected projection."""
    with FIXTURE.open(encoding="utf-8") as handle:
        block = json.load(handle)[which]
    return {
        "history": {"messages": block["history"], "status": "idle"},
        "hist": block["hist"],
    }


def _materialise(history, names):
    """Copy the sample PNG into a temp media dir and rewrite every path.

    The fixture records the hosted container paths; a test needs files that
    exist, so each placeholder becomes ``<tmp>/media/<name>``. Only the URL
    fields change -- every other field stays exactly as captured.
    """
    tmp = tempfile.mkdtemp(prefix="m35-hist-")
    root = Path(tmp) / "media"
    root.mkdir()
    mapping = {}
    for placeholder, name in names.items():
        target = root / name
        if name.endswith(".txt"):
            target.write_text("notes", encoding="utf-8")
        else:
            shutil.copyfile(SAMPLE_PNG, target)
        mapping[placeholder] = str(target)
    text = json.dumps(history, ensure_ascii=False)
    for placeholder, target in mapping.items():
        text = text.replace(placeholder, target)
    return json.loads(text), root, mapping


# --------------------------------------------------------------------------
# Part 1 -- the real history shape, and where the bytes are resolved
# --------------------------------------------------------------------------

def test_real_single_image_history_projects_to_the_wire_entry():
    """The captured body -> exactly the entry the SPA turns into a thumbnail."""
    fixture = _fixture("single")
    history, root, mapping = _materialise(
        fixture["history"],
        {"/app/workspaces/default/media/3f9c1e0a6b7d4c2e8a5f0b1d2c3e4f5a_m31-acceptance.png":
         "3f9c1e0a6b7d4c2e8a5f0b1d2c3e4f5a_m31-acceptance.png"},
    )
    path = mapping[
        "/app/workspaces/default/media/3f9c1e0a6b7d4c2e8a5f0b1d2c3e4f5a_m31-acceptance.png"
    ]
    messages = history_messages(history, 50, ref_factory=lambda *a, **k: "ref-1")
    assert messages == fixture["hist"], json.dumps(messages, ensure_ascii=False)
    # The fields that make the SPA take the thumbnail path, not the chip path.
    entry = messages[0]["files"][0]
    assert entry["kind"] == "image"
    assert entry["mime"] == "image/png"
    assert entry["size"] == os.path.getsize(path) == 179
    # No path, no data URL, no bytes.
    wire = json.dumps(messages, ensure_ascii=False)
    assert str(root) not in wire
    assert "file_url" not in wire and "image_url" not in wire
    # Key order is the projection's own (name, kind, mime, size, ref) -- the
    # e2e mock asserts the same order so a drift is caught on both sides.
    assert list(entry) == ["name", "kind", "mime", "size", "ref"]


def test_real_multi_attachment_history_keeps_every_file_in_order():
    fixture = _fixture("multi")
    history, _root, _mapping = _materialise(
        fixture["history"],
        {
            "/app/workspaces/default/media/3f9c1e0a6b7d4c2e8a5f0b1d2c3e4f5a_m31-acceptance.png":
                "3f9c1e0a6b7d4c2e8a5f0b1d2c3e4f5a_m31-acceptance.png",
            "/app/workspaces/default/media/8b2d4c6e0f1a3b5c7d9e2f4a6b8c0d1e_second.png":
                "8b2d4c6e0f1a3b5c7d9e2f4a6b8c0d1e_second.png",
            "/app/workspaces/default/media/c1d2e3f4a5b60718293a4b5c6d7e8f90_notes.txt":
                "c1d2e3f4a5b60718293a4b5c6d7e8f90_notes.txt",
        },
    )
    counter = {"n": 0}

    def issue(*_args, **_kwargs):
        counter["n"] += 1
        return "ref-%d" % counter["n"]

    messages = history_messages(history, 50, ref_factory=issue)
    assert messages == fixture["hist"]
    names = [entry["name"] for entry in messages[0]["files"]]
    assert names == ["m31-acceptance.png", "second.png", "notes.txt"]
    assert [entry["kind"] for entry in messages[0]["files"]] == [
        "image", "image", "file",
    ]


def test_hist_always_reissues_a_ref_for_a_stored_attachment():
    """The M31 suspicion: refs are NOT limited to a just-uploaded file.

    Every ``hist`` request mints a fresh ref for a file that lives on disk,
    independent of any upload state -- the plugin keeps no per-connection
    attachment table.
    """
    history, root, _mapping = _materialise(
        _fixture("single")["history"],
        {"/app/workspaces/default/media/3f9c1e0a6b7d4c2e8a5f0b1d2c3e4f5a_m31-acceptance.png":
         "3f9c1e0a6b7d4c2e8a5f0b1d2c3e4f5a_m31-acceptance.png"},
    )
    channel = _channel()
    first = _serve(channel, root, history)
    channel._relay.sent.clear()
    second = _serve(channel, root, history)
    assert first[0]["files"][0]["ref"]
    assert second[0]["files"][0]["ref"]
    assert first[0]["files"][0]["ref"] == second[0]["files"][0]["ref"]


def test_att_get_reads_from_the_directory_qwenpaw_uploaded_to():
    """The upload's own parent is a media root even when the guess is wrong."""
    history, root, _mapping = _materialise(
        _fixture("single")["history"],
        {"/app/workspaces/default/media/3f9c1e0a6b7d4c2e8a5f0b1d2c3e4f5a_m31-acceptance.png":
         "3f9c1e0a6b7d4c2e8a5f0b1d2c3e4f5a_m31-acceptance.png"},
    )
    elsewhere = Path(tempfile.mkdtemp(prefix="m35-elsewhere-"))
    channel = _channel()
    channel._upload_media_root = str(root)  # learned from POST /console/upload
    messages = _serve(channel, elsewhere, history)
    assert messages[0]["files"][0]["size"] == 179
    ref = messages[0]["files"][0]["ref"]
    frames = _att_get(channel, ref)
    assert _kinds(frames) == ["att_begin", "att_chunk", "att_end"]
    begin = frames[0]
    assert begin["bytes"] == 179
    assert begin["sha256"] == hashlib.sha256(SAMPLE_PNG.read_bytes()).hexdigest()
    assert frames[1]["data"] == base64.b64encode(SAMPLE_PNG.read_bytes()).decode()


def test_att_get_reads_from_the_console_media_dir_qwenpaw_reports():
    """``channels.console.media_dir`` is honoured (and looked up only once)."""
    history, root, _mapping = _materialise(
        _fixture("single")["history"],
        {"/app/workspaces/default/media/3f9c1e0a6b7d4c2e8a5f0b1d2c3e4f5a_m31-acceptance.png":
         "3f9c1e0a6b7d4c2e8a5f0b1d2c3e4f5a_m31-acceptance.png"},
    )
    elsewhere = Path(tempfile.mkdtemp(prefix="m35-elsewhere-"))
    channel = _channel()
    channel._console_media_dir_checked = False
    calls = []

    async def api_json(method, path, params=None, json_body=None):
        calls.append(path)
        return 200, {"console": {"media_dir": str(root), "enabled": True}}

    channel._api_json = api_json
    messages = _serve(channel, elsewhere, history)
    ref = messages[0]["files"][0]["ref"]
    frames = _att_get(channel, ref)
    assert _kinds(frames) == ["att_begin", "att_chunk", "att_end"]
    assert calls == ["/api/config/channels"]
    # A second fetch reuses the cached value.
    frames = _att_get(channel, ref, att_id="req-35b")
    assert _kinds(frames) == ["att_begin", "att_chunk", "att_end"]
    assert calls == ["/api/config/channels"]


def test_att_get_still_refuses_a_file_outside_every_media_root():
    """M31 containment is not weakened by the extra roots."""
    history, root, _mapping = _materialise(
        _fixture("single")["history"],
        {"/app/workspaces/default/media/3f9c1e0a6b7d4c2e8a5f0b1d2c3e4f5a_m31-acceptance.png":
         "3f9c1e0a6b7d4c2e8a5f0b1d2c3e4f5a_m31-acceptance.png"},
    )
    outside = Path(tempfile.mkdtemp(prefix="m35-outside-"))
    secret = outside / "secret.txt"
    secret.write_text("secret", encoding="utf-8")
    channel = _channel()
    messages = _serve(channel, root, history)
    ref = messages[0]["files"][0]["ref"]
    # Replace the ref's path with a file in a directory that is no root.
    entry = channel._attachments.resolve(ref, time.monotonic())
    assert entry is not None
    forged = channel._attachments.issue(
        WEB_CHAT, str(secret), entry["msg_id"], 0, name="secret.txt",
    )
    frames = _att_get(channel, forged, att_id="req-out")
    assert _kinds(frames) == ["error"]
    assert frames[0]["code"] == "E_ATT"
    assert frames[0]["chat"] == WEB_CHAT and frames[0]["id"] == "req-out"


def test_media_file_path_in_keeps_traversal_and_symlink_guards():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "media"
        root.mkdir()
        inside = root / "a.txt"
        inside.write_text("a", encoding="utf-8")
        outside = Path(tmp) / "secret.txt"
        outside.write_text("secret", encoding="utf-8")
        link = root / "link.txt"
        link.symlink_to(outside)
        second = Path(tmp) / "media2"
        second.mkdir()
        (second / "b.txt").write_text("b", encoding="utf-8")

        roots = [second, root]
        assert media_file_path_in(str(inside), roots) == inside.resolve()
        assert media_file_path_in(str(second / "b.txt"), roots) == (second / "b.txt").resolve()
        assert media_file_path_in(str(outside), roots) is None
        assert media_file_path_in(str(root / ".." / "secret.txt"), roots) is None
        assert media_file_path_in(str(link), roots) is None
        assert media_file_path_in(str(inside), []) is None
        assert media_file_path_in("", roots) is None


def test_attachment_media_dir_never_returns_a_remote_or_data_url():
    assert attachment_media_dir("/a/b/media/u_x.png") == "/a/b/media"
    assert attachment_media_dir("file:///a/b/media/u_x.png") == "/a/b/media"
    assert attachment_media_dir("https://example.test/u_x.png") == ""
    assert attachment_media_dir("data:image/png;base64,AAAA") == ""
    assert attachment_media_dir("") == ""


# --------------------------------------------------------------------------
# Part 2 -- several attachments in one message
# --------------------------------------------------------------------------

class _FakeUploadClient:
    calls = []
    payload = {"url": "/tmp/console-media/u.png"}

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, files=None, headers=None):
        _FakeUploadClient.calls.append({"url": url, "files": files})
        return _FakeResponse(_FakeUploadClient.payload)


class _FakeResponse:
    status_code = 200

    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


def _with_upload(payload, fn):
    original = channel_module.httpx.AsyncClient
    _FakeUploadClient.calls = []
    _FakeUploadClient.payload = payload
    channel_module.httpx.AsyncClient = _FakeUploadClient
    try:
        return fn()
    finally:
        channel_module.httpx.AsyncClient = original


def _msg_channel():
    channel = _channel()
    channel._enqueue = lambda native: None
    return channel


def _inline(name, size):
    return {"name": name, "mime": "text/plain", "data": base64.b64encode(b"x" * size).decode()}


def test_message_accepts_several_attachments_in_order():
    channel = _msg_channel()
    seen = []

    async def fake_store(chat, name, mime, data):
        seen.append(name)
        return []

    channel._store_file = fake_store
    asyncio.run(channel._handle_msg({
        "t": "msg", "chat": "c", "text": "hi",
        "files": [_inline("a.txt", 1), _inline("b.txt", 2), _inline("c.txt", 3)],
    }))
    assert seen == ["a.txt", "b.txt", "c.txt"]


def test_message_caps_attachments_per_message():
    channel = _msg_channel()
    seen = []

    async def fake_store(chat, name, mime, data):
        seen.append(name)
        return []

    channel._store_file = fake_store
    files = [_inline("f%02d.txt" % index, 1) for index in range(MAX_MESSAGE_ATTACHMENTS + 3)]
    asyncio.run(channel._handle_msg({"t": "msg", "chat": "c", "files": files}))
    assert len(seen) == MAX_MESSAGE_ATTACHMENTS
    assert seen[-1] == "f%02d.txt" % (MAX_MESSAGE_ATTACHMENTS - 1)


def test_message_caps_the_total_bytes_per_message():
    channel = _msg_channel()
    seen = []

    async def fake_store(chat, name, mime, data):
        seen.append(name)
        return []

    channel._store_file = fake_store
    # Three 4 MB entries: the third would cross the 10 MB per-message budget.
    four_mb = 4 * 1024 * 1024
    files = [_inline("big%d.bin" % index, four_mb) for index in range(3)]
    asyncio.run(channel._handle_msg({"t": "msg", "chat": "c", "files": files}))
    assert seen == ["big0.bin", "big1.bin"]
    assert len(files) == 3


def test_entry_size_prefers_inline_bytes_then_declared_then_staged():
    assert WebChannel._entry_size({"data": base64.b64encode(b"abcd").decode()}) == 4
    assert WebChannel._entry_size({"size": 7}) == 7
    assert WebChannel._entry_size({"ref": "r"}, {"size": 9}) == 9
    assert WebChannel._entry_size({"ref": "r"}) is None
    assert WebChannel._entry_size({"data": "!!not-base64!!", "size": 3}) == 3


def test_message_budget_constants_match_the_product_rule():
    assert MAX_MESSAGE_ATTACHMENTS == 10
    assert MAX_MESSAGE_ATTACHMENT_BYTES == 10 * 1024 * 1024


# --------------------------------------------------------------------------

def main():
    tests = [
        (name, value)
        for name, value in sorted(globals().items())
        if name.startswith("test_") and callable(value)
    ]
    failed = 0
    for name, fn in tests:
        try:
            fn()
        except AssertionError as exc:
            failed += 1
            print("FAIL %s: %s" % (name, exc))
        except Exception as exc:  # noqa: BLE001 - report and keep going
            failed += 1
            print("ERROR %s: %r" % (name, exc))
        else:
            print("ok   %s" % name)
    print("ALL PASS" if not failed else "%d FAILED" % failed)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
