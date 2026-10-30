#!/usr/bin/env python3
"""Standalone tests for M31: attachments that survive history and come back.

Covers the four shipped gaps:

* G1 -- ``hist.messages[].files`` projection (dedupe by URL, attachment-only
  turns kept, no absolute path, size best effort, turn anchoring unchanged);
* G2 -- ``image/*`` uploads emit ``FileContent`` *then* ``ImageContent`` with
  the same URL, the ``models`` frame carries a boolean ``vision`` only, and a
  turn built that way projects to history without the media hook's
  "already downloaded to <path>" notice;
* G3 -- opaque attachment refs, the media-directory guard and the
  ``att_get`` / ``att_begin`` / ``att_chunk`` / ``att_end`` stream, including
  every traversal/expiry/cross-chat case;
* G4 -- chunked uploads keep their name/mime/size for the archive.

Run either way (no pytest required; needs httpx for ``channel``):

    cd plugin && ~/workspace/qwenpaw-local/venv/bin/python tests/test_m31.py
    cd plugin && python3 -m pytest tests/test_m31.py -q
"""

import asyncio
import base64
import hashlib
import json
import os
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
from frames import (  # noqa: E402
    MAX_FILE_BYTES,
    TRANSFER_TTL_S,
    FileTransfers,
    att_begin_frame,
    att_chunk_frame,
    att_end_frame,
)
from util import (  # noqa: E402
    ATTACH_REF_TTL_S,
    AttachmentRefs,
    history_has_attachment,
    history_messages,
    media_file_path,
    model_items,
)

WEB_CHAT = "chat-31"
CHAT_UUID = "33333333-3333-3333-3333-333333333333"
SESSION_ID = "web:web-user:%s" % WEB_CHAT


# --------------------------------------------------------------------------
# Fixtures / fakes
# --------------------------------------------------------------------------

def _text(value):
    return {"type": "text", "text": value}


def _file(name, url, part_type="file"):
    field = "file_url" if part_type == "file" else "%s_url" % part_type
    return {"type": part_type, "filename": name, field: url}


def _history(messages):
    return {"messages": messages, "status": "idle"}


def _message(role, content, oid=None, usage=None, mtype="MESSAGE"):
    metadata = {}
    if oid is not None:
        metadata["original_id"] = oid
    if usage is not None:
        metadata["metadata"] = {"qwenpaw_turn_usage": {"usage": usage}}
    return {
        "role": role,
        "type": mtype,
        "content": content,
        "metadata": metadata,
    }


class _RecordingRelay:
    def __init__(self):
        self.sent = []

    async def send(self, frame):
        self.sent.append(frame)


class _FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}

    def json(self):
        return self._payload


class _FakeUploadClient:
    """Stands in for ``httpx.AsyncClient`` during ``_store_file``."""

    calls = []
    payload = {"url": "/tmp/console-media/abc_uploaded.png"}

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, files=None, headers=None):
        _FakeUploadClient.calls.append({"url": url, "files": files})
        return _FakeResponse(200, dict(_FakeUploadClient.payload))


def _channel():
    channel = WebChannel(process=None)
    channel._agent_id = lambda: "agent-31"
    channel._relay = _RecordingRelay()
    channel_module._ATT_CHUNK_PACE_S = 0.0
    channel_module._EXPORT_CHUNK_PACE_S = 0.0
    return channel


def _frames_of(frames, kind):
    return [frame for frame in frames if frame.get("t") == kind]


def _messages_of(frames):
    return [
        message
        for frame in _frames_of(frames, "hist")
        for message in frame.get("messages", [])
    ]


# --------------------------------------------------------------------------
# G1 -- history projection
# --------------------------------------------------------------------------

def test_attachment_only_turn_is_kept():
    messages = history_messages(_history([
        _message("user", [_file("报告.pdf", "/media/u1.pdf")], oid="m1"),
        _message("assistant", [_text("收到")], oid="m2"),
    ]))
    assert messages[0] == {
        "role": "user",
        "text": "",
        "files": [{"name": "报告.pdf", "kind": "file", "mime": "application/pdf"}],
    }
    assert messages[1] == {"role": "assistant", "text": "收到"}


def test_every_attachment_part_type_is_projected():
    messages = history_messages(_history([
        _message("user", [
            _file("图.png", "/media/a.png", "image"),
            _file("片.mp4", "/media/b.mp4", "video"),
            _file("声.mp3", "/media/c.mp3", "audio"),
            _file("文.txt", "/media/d.txt", "file"),
        ]),
    ]))
    files = messages[0]["files"]
    assert [item["name"] for item in files] == ["图.png", "片.mp4", "声.mp3", "文.txt"]
    assert [item["kind"] for item in files] == ["image", "file", "file", "file"]
    assert [item["mime"] for item in files] == [
        "image/png", "video/mp4", "audio/mpeg", "text/plain",
    ]


def test_absolute_paths_never_leak():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "media"
        root.mkdir()
        path = root / "secret_name.png"
        path.write_bytes(b"png")
        messages = history_messages(_history([
            _message("user", [
                {"type": "file", "filename": "secret_name.png", "file_url": str(path)},
            ]),
        ]))
    wire = json.dumps(messages, ensure_ascii=False)
    assert str(root) not in wire
    assert "secret_name.png" in wire
    assert messages[0]["files"][0]["size"] == 3


def test_message_without_text_and_without_files_is_skipped():
    messages = history_messages(_history([
        _message("user", []),
        _message("assistant", [{"type": "thinking", "thinking": "x"}]),
        _message("user", [_text("你好")]),
    ]))
    assert messages == [{"role": "user", "text": "你好"}]


def test_duplicate_file_and_image_parts_merge_by_url():
    messages = history_messages(_history([
        _message("user", [
            {"type": "file", "filename": "喵.png", "file_url": "/media/u_喵.png"},
            {"type": "image", "image_url": "/media/u_喵.png"},
        ]),
    ]))
    files = messages[0]["files"]
    assert files == [{"name": "喵.png", "kind": "image", "mime": "image/png"}]


def test_turn_anchor_is_still_the_last_assistant_text():
    messages = history_messages(_history([
        _message(
            "user", [_file("a.png", "/media/a.png")], oid="u1",
            usage={"prompt_tokens": 10, "completion_tokens": 1},
        ),
        _message(
            "assistant", [_text("答案")], oid="a1",
            usage={"prompt_tokens": 100, "completion_tokens": 20},
        ),
    ]))
    assert "turn" not in messages[0]
    assert messages[1]["turn"]["id"] == "a1"
    assert messages[0]["files"]


def test_unknown_size_is_omitted_not_zero():
    messages = history_messages(_history([
        _message("user", [_file("无尺寸.bin", "/media/missing.bin")]),
    ]))
    assert "size" not in messages[0]["files"][0]


# --------------------------------------------------------------------------
# G2 -- image content parts, vision flag, clean history
# --------------------------------------------------------------------------

def _with_upload(payload, fn):
    """Run *fn* with ``httpx.AsyncClient`` replaced by the upload fake."""
    original = channel_module.httpx.AsyncClient
    _FakeUploadClient.calls = []
    _FakeUploadClient.payload = payload
    channel_module.httpx.AsyncClient = _FakeUploadClient
    try:
        return fn()
    finally:
        channel_module.httpx.AsyncClient = original


def test_image_upload_emits_file_then_image_with_same_url():
    channel = _channel()

    async def run():
        return await channel._store_file("c", "喵.png", "image/png", b"png")

    parts = _with_upload({"url": "/tmp/console-media/u_喵.png"}, lambda: asyncio.run(run()))
    assert [part.type for part in parts] == ["file", "image"]
    assert parts[0].file_url == parts[1].image_url
    assert parts[0].filename == "喵.png"
    assert _FakeUploadClient.calls[0]["files"]["file"][0] == "喵.png"


def test_non_image_upload_stays_a_single_file_part():
    channel = _channel()

    async def run():
        return await channel._store_file("c", "a.pdf", "application/pdf", b"%PDF")

    parts = _with_upload({"url": "/tmp/console-media/u_a.pdf"}, lambda: asyncio.run(run()))
    assert [part.type for part in parts] == ["file"]


def test_models_frame_carries_only_boolean_vision():
    providers = [{
        "id": "p1",
        "api_key": "sk-secret",
        "models": [
            {"id": "vision-yes", "supports_image": True, "api_key": "model-secret"},
            {"id": "vision-no", "supports_image": False},
            {"id": "vision-unknown", "supports_image": None},
            {"id": "multimodal", "supports_multimodal": True},
        ],
    }]
    items = model_items(providers, "p1", "vision-no")
    by_model = {item["model"]: item for item in items}
    assert by_model["vision-yes"]["vision"] is True
    assert by_model["vision-no"]["vision"] is False
    assert "vision" not in by_model["vision-unknown"]
    assert by_model["multimodal"]["vision"] is True
    wire = json.dumps(items)
    assert "sk-secret" not in wire
    assert "model-secret" not in wire
    assert "api_key" not in wire


def test_image_turn_history_has_no_media_hook_notice():
    """Reverse check for G2-A (documented in the M31 report).

    QwenPaw only persists ``qwenpaw_original_user_content`` when the request
    contains a ``file`` part with a ``file_url`` (message_convert.py:34-38).
    The two-part image turn must therefore contain such a part -- that is the
    precondition this test asserts -- and the resulting history projection
    must not contain the media hook's path notice (the text the persisted Msg
    would otherwise gain from message_processing.py:133-134).
    """
    channel = _channel()

    async def run():
        return await channel._store_file(
            "c", "喵.png", "image/png", b"png",
        )

    parts = _with_upload({"url": "/media/u_喵.png"}, lambda: asyncio.run(run()))
    saved = [
        {"type": "file", "filename": "喵.png", "file_url": "/media/u_喵.png"},
        {"type": "image", "image_url": "/media/u_喵.png"},
    ]
    assert any(
        part["type"] == "file" and part.get("file_url") for part in saved
    ), "a file part is what keeps qwenpaw_original_user_content"
    assert [part["type"] for part in saved] == [part.type for part in parts]

    messages = history_messages(_history([
        _message("user", saved, oid="m1"),
        _message("assistant", [_text("看到了")], oid="m2"),
    ]))
    wire = json.dumps(messages, ensure_ascii=False)
    assert "已经下载到" not in wire
    assert "downloaded to" not in wire
    assert len(messages[0]["files"]) == 1


# --------------------------------------------------------------------------
# G3 -- refs, the media guard and the att_* stream
# --------------------------------------------------------------------------

def test_refs_are_opaque_chat_bound_and_expire():
    refs = AttachmentRefs(ttl=10)
    ref = refs.issue("c1", "/media/a.png", "m1", 0, now=100.0)
    assert ref and "/media" not in ref and "m1" not in ref
    assert refs.resolve(ref, 105.0)["chat"] == "c1"
    assert refs.resolve(ref, 111.0) is None
    assert refs.resolve("nope", 105.0) is None


def test_media_guard_blocks_traversal_symlink_and_oversize():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "media"
        root.mkdir()
        inside = root / "ok.txt"
        inside.write_bytes(b"ok")
        outside = Path(tmp) / "outside.txt"
        outside.write_bytes(b"secret")

        assert media_file_path(str(inside), root) == inside.resolve()
        assert media_file_path(str(root / ".." / "outside.txt"), root) is None
        assert media_file_path(str(outside), root) is None

        link = root / "link.txt"
        link.symlink_to(outside)
        assert media_file_path(str(link), root) is None

        big = root / "big.bin"
        with big.open("wb") as handle:
            handle.truncate(MAX_FILE_BYTES + 1)
        assert media_file_path(str(big), root) is None
        assert media_file_path(str(big), root, max_bytes=MAX_FILE_BYTES + 1)


def test_history_has_attachment_needs_the_same_message_and_url():
    history = _history([
        _message("user", [_file("a.png", "/media/a.png")], oid="m1"),
    ])
    assert history_has_attachment(history, "m1", "/media/a.png")
    assert not history_has_attachment(history, "m2", "/media/a.png")
    assert not history_has_attachment(history, "m1", "/media/b.png")
    assert not history_has_attachment(history, "", "")


def _serve(channel, media_dir, history, chat=WEB_CHAT):
    """Drive hist -> ref -> att_get; returns (hist_messages, frames)."""
    channel._media_dir = lambda: Path(media_dir)
    channel._resolve_chat_id = lambda _chat: _async(CHAT_UUID)
    channel._get_history = lambda _cid: _async(history)
    frames = channel._relay.sent
    asyncio.run(channel._handle_hist({"t": "hist", "chat": chat}))
    messages = _messages_of(frames)
    return messages


def _async(value):
    async def run():
        return value
    return run()


def _att_get(channel, ref, chat=WEB_CHAT, att_id="req-1"):
    before = len(channel._relay.sent)
    asyncio.run(channel._handle_att_get(
        {"t": "att_get", "chat": chat, "id": att_id, "ref": ref},
    ))
    return channel._relay.sent[before:]


def _reassembled(frames):
    chunks = _frames_of(frames, "att_chunk")
    return b"".join(base64.b64decode(frame["data"]) for frame in chunks)


def test_att_get_streams_bytes_with_matching_digest():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "media"
        root.mkdir()
        payload = bytes(range(256)) * 800  # 204 800 bytes -> 3 chunks
        path = root / "u_图.png"
        path.write_bytes(payload)
        history = _history([
            _message("user", [_file("图.png", str(path))], oid="m1"),
        ])
        channel = _channel()
        messages = _serve(channel, root, history)
        ref = messages[0]["files"][0]["ref"]
        assert ref
        frames = _att_get(channel, ref)
        begin = _frames_of(frames, "att_begin")[0]
        assert begin["bytes"] == len(payload)
        assert begin["chunks"] == len(_frames_of(frames, "att_chunk"))
        assert begin["sha256"] == hashlib.sha256(payload).hexdigest()
        assert begin["name"] == "图.png"
        assert begin["mime"] == "image/png"
        assert _reassembled(frames) == payload
        assert _frames_of(frames, "att_end")
        for frame in frames:
            assert "seq" not in frame


def test_att_get_rejects_client_supplied_paths_and_old_refs():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "media"
        root.mkdir()
        path = root / "a.txt"
        path.write_bytes(b"x")
        history = _history([
            _message("user", [_file("a.txt", str(path))], oid="m1"),
        ])
        channel = _channel()
        _serve(channel, root, history)
        # A raw path is not a ref.
        frames = _att_get(channel, str(path))
        assert _frames_of(frames, "error")[0]["code"] == "E_ATT"
        # A very old ref is expired before it can be resolved.
        channel._attachments = AttachmentRefs()
        old = channel._attachments.issue(
            WEB_CHAT, str(path), "m1", 0,
            now=time.monotonic() - ATTACH_REF_TTL_S - 1,
        )
        frames = _att_get(channel, old, att_id="req-old")
        error = _frames_of(frames, "error")[0]
        assert error["code"] == "E_ATT"
        assert error["id"] == "req-old"


def test_att_get_rejects_cross_chat_traversal_symlink_and_oversize():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "media"
        root.mkdir()
        path = root / "a.txt"
        path.write_bytes(b"x")
        outside = Path(tmp) / "secret.txt"
        outside.write_bytes(b"secret")
        link = root / "link.txt"
        link.symlink_to(outside)
        big = root / "big.bin"
        with big.open("wb") as handle:
            handle.truncate(MAX_FILE_BYTES + 1)

        history = _history([
            _message("user", [_file("a.txt", str(path))], oid="m1"),
        ])
        channel = _channel()
        messages = _serve(channel, root, history)
        ref = messages[0]["files"][0]["ref"]

        # Cross-chat use of a valid ref.
        frames = _att_get(channel, ref, chat="other-chat")
        assert _frames_of(frames, "error")[0]["code"] == "E_ATT"

        for target in (str(root / ".." / "secret.txt"), str(link), str(big)):
            issued = channel._attachments.issue(
                WEB_CHAT, target, "m1", 0, name="x",
            )
            frames = _att_get(channel, issued, att_id="t")
            assert _frames_of(frames, "error")[0]["code"] == "E_ATT", target
            assert not _frames_of(frames, "att_begin"), target


def test_att_get_revalidates_the_message_still_exists():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "media"
        root.mkdir()
        path = root / "a.txt"
        path.write_bytes(b"x")
        history = _history([
            _message("user", [_file("a.txt", str(path))], oid="m1"),
        ])
        channel = _channel()
        messages = _serve(channel, root, history)
        ref = messages[0]["files"][0]["ref"]

        channel._get_history = lambda _cid: _async(_history([]))
        frames = _att_get(channel, ref)
        assert _frames_of(frames, "error")[0]["code"] == "E_ATT"


def test_att_get_without_id_is_ignored():
    channel = _channel()
    asyncio.run(channel._handle_att_get(
        {"t": "att_get", "chat": WEB_CHAT, "ref": "x"},
    ))
    assert channel._relay.sent == []


# --------------------------------------------------------------------------
# G4 -- chunked metadata in the archive
# --------------------------------------------------------------------------

def test_peek_reads_staged_metadata_without_consuming():
    files = FileTransfers()
    data = b"hello"
    files.begin("t1", {
        "name": "报告.pdf", "mime": "application/pdf", "size": len(data),
        "chunks": 1, "sha256": hashlib.sha256(data).hexdigest(),
    }, 0.0)
    files.chunk("t1", 0, base64.b64encode(data).decode("ascii"), 1.0)
    assert files.end("t1", 2.0)[0] is True
    assert files.peek("t1", 3.0) == {
        "name": "报告.pdf", "mime": "application/pdf", "size": len(data),
    }
    assert files.peek("t1", 3.0) is not None, "peek must not consume"
    assert files.take("t1", 3.0) == ("报告.pdf", "application/pdf", data)
    assert files.peek("t1", 4.0) is None
    assert files.peek("unknown", 4.0) is None
    assert files.peek("t1", TRANSFER_TTL_S + 2.0) is None


def test_chunked_message_gets_name_from_the_staged_record():
    channel = _channel()
    data = b"payload"
    now = time.monotonic()
    channel._files.begin("t9", {
        "name": "长截图.png", "mime": "image/png", "size": len(data),
        "chunks": 1, "sha256": hashlib.sha256(data).hexdigest(),
    }, now)
    channel._files.chunk(
        "t9", 0, base64.b64encode(data).decode("ascii"), now,
    )
    channel._files.end("t9", now)

    archived = []

    class _Archiver:
        def archive_user(self, chat, text, files_meta, ts):
            archived.append(list(files_meta))

    channel._archiver = _Archiver()
    channel._enqueue = lambda payload: None

    async def fake_store(_chat, _name, _mime, _data):
        return [{"type": "file"}]

    channel._store_file = fake_store
    asyncio.run(channel._handle_msg({
        "t": "msg", "chat": WEB_CHAT, "text": "", "files": [{"ref": "t9"}],
    }))
    assert archived == [[{
        "name": "长截图.png", "mime": "image/png", "size": len(data),
    }]]
    # The ref is one-shot: a second message cannot reuse it.
    asyncio.run(channel._handle_msg({
        "t": "msg", "chat": WEB_CHAT, "text": "再试一次",
        "files": [{"ref": "t9"}],
    }))
    assert archived[1] == []


def test_archive_title_falls_back_to_first_attachment():
    from turso_archive import user_requests

    batch = user_requests("c1", "a1", "", [{"name": "截图.png"}], 1)
    assert batch[0]["stmt"]["args"][4]["value"] == "截图.png"
    batch = user_requests("c1", "a1", "你好", [{"name": "截图.png"}], 1)
    assert batch[0]["stmt"]["args"][4]["value"] == "你好"


# --------------------------------------------------------------------------
# G5 -- export placeholder (also asserted in test_m12)
# --------------------------------------------------------------------------

def test_export_placeholder_dedupes_a_two_part_image():
    from util import build_export_markdown

    doc = build_export_markdown(_history([
        _message("user", [
            {"type": "file", "filename": "喵.png", "file_url": "/media/u_喵.png"},
            {"type": "image", "image_url": "/media/u_喵.png"},
        ]),
    ]), WEB_CHAT, "t", "now")
    assert doc.count("[附件:") == 1
    assert "[附件: 喵.png · image/png]" in doc
    assert "/media" not in doc


def test_att_frames_have_the_export_shape():
    assert att_begin_frame("c", "i", 2, 1, "ab", "n", "text/plain") == {
        "t": "att_begin", "chat": "c", "id": "i", "bytes": 2,
        "chunks": 1, "sha256": "ab", "name": "n", "mime": "text/plain",
    }
    assert att_chunk_frame("c", "i", 0, "AA==") == {
        "t": "att_chunk", "chat": "c", "id": "i", "i": 0, "data": "AA==",
    }
    assert att_end_frame("c", "i") == {"t": "att_end", "chat": "c", "id": "i"}


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
