#!/usr/bin/env python3
"""Standalone tests for the M5 chunked file transfer (protocol v2).

Drives ``util.FileTransfers`` -- the state machine ``channel.py`` uses for
``file_begin`` / ``file_chunk`` / ``file_end`` -- with synthetic ``now`` values
and small payloads, plus the ``file_ready`` / ``file_error`` frame builders and
the untouched v1 inline path.

Run either way (no pytest required):

    cd plugin && python3 tests/test_m5.py
    cd plugin && python3 -m pytest tests/test_m5.py -q
"""

import base64
import hashlib
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_PLUGIN_DIR = os.path.dirname(_HERE)
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

from frames import (  # noqa: E402  (path setup must run before these imports)
    CHUNK_RAW_BYTES,
    MAX_FILE_BYTES,
    TRANSFER_TTL_S,
    FileTransfers,
    check_size,
    file_error_frame,
    file_ready_frame,
)
from util import decode_file_entry  # noqa: E402


def _b64(data):
    """Base64 text exactly as a ``file_chunk.data`` field carries it."""
    return base64.b64encode(data).decode("ascii")


def _payload(size, seed=7):
    """Deterministic byte string (no randomness, so failures reproduce)."""
    return bytes((seed + index * 31) % 251 for index in range(size))


def _split(data, chunk_size=100):
    return [data[i:i + chunk_size] for i in range(0, len(data), chunk_size)]


def _meta(tid, data, chunk_size=100, **overrides):
    """``file_begin`` meta + the matching chunk list for *data*."""
    parts = _split(data, chunk_size)
    meta = {
        "t": "file_begin",
        "chat": "c1",
        "id": tid,
        "name": "report.bin",
        "mime": "application/octet-stream",
        "size": len(data),
        "chunks": len(parts),
        "sha256": hashlib.sha256(data).hexdigest(),
    }
    meta.update(overrides)
    return meta, parts


# --------------------------------------------------------------------------
# Reassembly
# --------------------------------------------------------------------------

def test_reassembly_out_of_order():
    files = FileTransfers()
    data = _payload(1000)
    meta, parts = _meta("t1", data)
    assert files.begin("t1", meta, 0.0) == (True, None)

    for index in (7, 2, 9, 0, 5, 1, 8, 3, 6, 4):
        assert files.chunk("t1", index, _b64(parts[index]), 1.0) == (True, None)

    ok, code, info = files.end("t1", 2.0)
    assert (ok, code) == (True, None)
    assert info == {
        "name": "report.bin", "mime": "application/octet-stream", "size": 1000,
    }
    assert files.take("t1", 3.0) == (
        "report.bin", "application/octet-stream", data,
    )


def test_duplicate_chunk_tolerated():
    # A retransmit is the normal duplicate case: last one wins, sha256 decides.
    files = FileTransfers()
    data = _payload(300)
    meta, parts = _meta("t1", data)
    assert files.begin("t1", meta, 0.0) == (True, None)

    assert files.chunk("t1", 0, _b64(parts[0]), 1.0) == (True, None)
    assert files.chunk("t1", 1, _b64(parts[1]), 1.1) == (True, None)
    assert files.chunk("t1", 1, _b64(parts[1]), 1.2) == (True, None)  # repeat
    assert files.chunk("t1", 2, _b64(parts[2]), 1.3) == (True, None)

    assert files.end("t1", 2.0) == (
        True, None,
        {"name": "report.bin", "mime": "application/octet-stream", "size": 300},
    )
    assert files.take("t1", 3.0)[2] == data


def test_chunk_size_constant_fits_wire_limit():
    # One 96 KB chunk (base64'd) must stay inside the 256 KB frame budget.
    data = _payload(CHUNK_RAW_BYTES, seed=3)
    frame = {
        "t": "file_chunk", "chat": "c1", "id": "u1", "i": 0, "data": _b64(data),
    }
    assert check_size(frame) is True


def test_chunked_at_96k():
    files = FileTransfers()
    data = _payload(CHUNK_RAW_BYTES * 2 + 17, seed=11)
    meta, parts = _meta("t1", data, chunk_size=CHUNK_RAW_BYTES)
    assert len(parts) == 3
    assert files.begin("t1", meta, 0.0) == (True, None)
    for index in reversed(range(len(parts))):
        assert files.chunk("t1", index, _b64(parts[index]), 1.0) == (True, None)
    assert files.end("t1", 2.0)[0] is True
    assert files.take("t1", 3.0)[2] == data


def test_name_and_mime_defaults():
    files = FileTransfers()
    data = _payload(10)
    meta, parts = _meta("t1", data)
    del meta["name"]
    del meta["mime"]
    assert files.begin("t1", meta, 0.0) == (True, None)
    assert files.chunk("t1", 0, _b64(parts[0]), 1.0) == (True, None)
    ok, _, info = files.end("t1", 2.0)
    assert ok is True
    assert info == {"name": "file", "mime": "application/octet-stream", "size": 10}


def test_sha256_any_case_accepted():
    files = FileTransfers()
    data = _payload(50)
    digest = hashlib.sha256(data).hexdigest()
    meta, parts = _meta("t1", data, sha256=digest.upper())
    assert files.begin("t1", meta, 0.0) == (True, None)
    assert files.chunk("t1", 0, _b64(parts[0]), 1.0) == (True, None)
    assert files.end("t1", 2.0)[0] is True


# --------------------------------------------------------------------------
# Verification failures
# --------------------------------------------------------------------------

def test_sha256_mismatch_is_e_checksum():
    files = FileTransfers()
    data = _payload(200)
    wrong = hashlib.sha256(b"not the same bytes").hexdigest()
    meta, parts = _meta("t1", data, sha256=wrong)
    assert files.begin("t1", meta, 0.0) == (True, None)
    for index, part in enumerate(parts):
        assert files.chunk("t1", index, _b64(part), 1.0) == (True, None)
    assert files.end("t1", 2.0) == (False, "E_CHECKSUM", None)
    assert files.take("t1", 3.0) is None  # dropped, nothing staged


def test_declared_size_mismatch_is_e_checksum():
    files = FileTransfers()
    data = _payload(200)
    meta, parts = _meta("t1", data, size=len(data) + 1)
    assert files.begin("t1", meta, 0.0) == (True, None)
    for index, part in enumerate(parts):
        assert files.chunk("t1", index, _b64(part), 1.0) == (True, None)
    assert files.end("t1", 2.0) == (False, "E_CHECKSUM", None)


def test_missing_chunk_is_e_checksum():
    files = FileTransfers()
    data = _payload(300)
    meta, parts = _meta("t1", data)
    assert files.begin("t1", meta, 0.0) == (True, None)
    for index in (0, 2):  # chunk 1 never arrives
        assert files.chunk("t1", index, _b64(parts[index]), 1.0) == (True, None)
    assert files.end("t1", 2.0) == (False, "E_CHECKSUM", None)


def test_begin_declared_too_big():
    files = FileTransfers()
    oversized = {
        "size": MAX_FILE_BYTES + 1,
        "chunks": 1,
        "sha256": hashlib.sha256(b"x").hexdigest(),
    }
    assert files.begin("t1", oversized, 0.0) == (False, "E_TOOBIG")


def test_accumulated_too_big():
    # Chunk bytes are capped even when the declared size looked legal.
    files = FileTransfers()
    meta = {
        "size": MAX_FILE_BYTES,
        "chunks": 2,
        "sha256": hashlib.sha256(b"x").hexdigest(),
    }
    assert files.begin("big", meta, 0.0) == (True, None)
    assert files.chunk(
        "big", 0, _b64(b"\x00" * (MAX_FILE_BYTES + 1)), 1.0,
    ) == (False, "E_TOOBIG")
    # ... and the transfer is gone.
    assert files.chunk("big", 1, _b64(b"x"), 1.1) == (False, "E_STATE")


# --------------------------------------------------------------------------
# State errors
# --------------------------------------------------------------------------

def test_chunk_and_end_without_begin():
    files = FileTransfers()
    assert files.chunk("nope", 0, _b64(b"x"), 0.0) == (False, "E_STATE")
    assert files.end("nope", 0.0) == (False, "E_STATE", None)


def test_chunk_index_out_of_range():
    files = FileTransfers()
    data = _payload(200)
    meta, parts = _meta("t1", data)
    assert files.begin("t1", meta, 0.0) == (True, None)

    assert files.chunk("t1", 2, _b64(parts[0]), 1.0) == (False, "E_STATE")
    # the transfer was dropped, so even a good index is now E_STATE
    assert files.chunk("t1", 0, _b64(parts[0]), 1.1) == (False, "E_STATE")
    assert files.end("t1", 2.0) == (False, "E_STATE", None)


def test_chunk_bad_base64_and_bad_index_type():
    files = FileTransfers()
    data = _payload(200)
    meta, parts = _meta("t1", data)
    assert files.begin("t1", meta, 0.0) == (True, None)
    assert files.chunk("t1", 0, "!!not base64!!", 1.0) == (False, "E_STATE")
    assert files.end("t1", 2.0) == (False, "E_STATE", None)

    assert files.begin("t2", meta, 0.0) == (True, None)
    assert files.chunk("t2", "0", _b64(parts[0]), 1.0) == (False, "E_STATE")
    assert files.end("t2", 2.0) == (False, "E_STATE", None)

    assert files.begin("t3", meta, 0.0) == (True, None)
    assert files.chunk("t3", 0, 42, 1.0) == (False, "E_STATE")


def test_begin_rejects_malformed_meta():
    files = FileTransfers()
    digest = hashlib.sha256(b"x").hexdigest()
    good = {"size": 10, "chunks": 1, "sha256": digest}
    assert files.begin("a", good, 0.0) == (True, None)

    for bad in (
        {},
        {"chunks": 1, "sha256": digest},                       # no size
        {"size": 0, "chunks": 1, "sha256": digest},
        {"size": -5, "chunks": 1, "sha256": digest},
        {"size": "10", "chunks": 1, "sha256": digest},
        {"size": 10, "sha256": digest},                        # no chunks
        {"size": 10, "chunks": 0, "sha256": digest},
        {"size": 10, "chunks": "1", "sha256": digest},
        {"size": 10, "chunks": 1},                             # no sha256
        {"size": 10, "chunks": 1, "sha256": "abc"},
        {"size": 10, "chunks": 1, "sha256": "z" * 64},
    ):
        assert files.begin("bad", bad, 0.0) == (False, "E_STATE")
    assert files.begin("bad", None, 0.0) == (False, "E_STATE")


def test_begin_restarts_same_id():
    # The client's whole-file retry after E_CHECKSUM reuses the id.
    files = FileTransfers()
    data = _payload(300)
    good, parts = _meta("t1", data)

    bad = dict(good, sha256=hashlib.sha256(b"other").hexdigest())
    assert files.begin("t1", bad, 0.0) == (True, None)
    assert files.chunk("t1", 0, _b64(parts[0]), 1.0) == (True, None)
    for index in range(1, len(parts)):
        assert files.chunk("t1", index, _b64(parts[index]), 1.1) == (True, None)
    assert files.end("t1", 2.0) == (False, "E_CHECKSUM", None)

    assert files.begin("t1", good, 3.0) == (True, None)
    for index, part in enumerate(parts):
        assert files.chunk("t1", index, _b64(part), 4.0) == (True, None)
    assert files.end("t1", 5.0)[0] is True
    assert files.take("t1", 6.0)[2] == data


def test_begin_restarts_a_staged_id():
    files = FileTransfers()
    data = _payload(100)
    meta, parts = _meta("t1", data)
    assert files.begin("t1", meta, 0.0) == (True, None)
    assert files.chunk("t1", 0, _b64(parts[0]), 1.0) == (True, None)
    assert files.end("t1", 2.0)[0] is True

    # A second begin discards the staged copy and starts over.
    other = _payload(120, seed=99)
    meta2, parts2 = _meta("t1", other)
    assert files.begin("t1", meta2, 3.0) == (True, None)
    assert files.take("t1", 3.5) is None  # nothing staged until this end
    for index, part in enumerate(parts2):
        assert files.chunk("t1", index, _b64(part), 4.0) == (True, None)
    assert files.end("t1", 5.0)[0] is True
    assert files.take("t1", 6.0)[2] == other


# --------------------------------------------------------------------------
# Staged refs + TTL
# --------------------------------------------------------------------------

def _stage(files, tid="t1", size=100, now=0.0):
    data = _payload(size)
    meta, parts = _meta(tid, data)
    assert files.begin(tid, meta, now) == (True, None)
    for index, part in enumerate(parts):
        assert files.chunk(tid, index, _b64(part), now) == (True, None)
    assert files.end(tid, now)[0] is True
    return data


def test_take_is_one_shot():
    files = FileTransfers()
    data = _stage(files)
    assert files.take("t1", 1.0)[2] == data
    assert files.take("t1", 2.0) is None  # already consumed


def test_take_unknown_id():
    files = FileTransfers()
    assert files.take("never-seen", 0.0) is None


def test_staged_ttl():
    files = FileTransfers()
    _stage(files, now=10.0)
    assert files.take("t1", 10.0 + TRANSFER_TTL_S + 0.5) is None


def test_staged_take_just_inside_ttl():
    files = FileTransfers()
    data = _stage(files, now=10.0)
    assert files.take("t1", 10.0 + TRANSFER_TTL_S)[2] == data


def test_purge_in_progress():
    files = FileTransfers()
    data = _payload(200)
    meta, parts = _meta("t1", data)
    assert files.begin("t1", meta, 0.0) == (True, None)
    assert files.chunk("t1", 0, _b64(parts[0]), 1.0) == (True, None)

    assert files.purge(TRANSFER_TTL_S) == []  # exactly at the TTL: not expired
    assert files.purge(TRANSFER_TTL_S + 1.0) == ["t1"]
    assert files.chunk("t1", 1, _b64(parts[1]), TRANSFER_TTL_S + 2.0) == (
        False, "E_STATE",
    )
    assert files.end("t1", TRANSFER_TTL_S + 3.0) == (False, "E_STATE", None)


def test_purge_staged_expires_silently():
    files = FileTransfers()
    _stage(files, now=0.0)
    assert files.purge(TRANSFER_TTL_S + 1.0) == []  # staged ids are not returned
    assert files.take("t1", TRANSFER_TTL_S + 2.0) is None


def test_lazy_expiry_on_end():
    # No purge call at all: end itself must treat the stale transfer as gone.
    files = FileTransfers()
    data = _payload(100)
    meta, parts = _meta("t1", data)
    assert files.begin("t1", meta, 0.0) == (True, None)
    assert files.chunk("t1", 0, _b64(parts[0]), 1.0) == (True, None)
    assert files.end("t1", TRANSFER_TTL_S + 1.0) == (False, "E_STATE", None)


# --------------------------------------------------------------------------
# v1 inline path + frame builders
# --------------------------------------------------------------------------

def test_v1_inline_decode_unchanged():
    assert decode_file_entry(
        {"name": "notes.txt", "mime": "text/plain", "data": _b64(b"hello file")},
    ) == ("notes.txt", "text/plain", b"hello file")
    assert decode_file_entry(
        {"data": _b64(b"z")},
    ) == ("file", "application/octet-stream", b"z")
    assert decode_file_entry({"ref": "t1"}) is None


def test_constants():
    assert MAX_FILE_BYTES == 10 * 1024 * 1024
    assert CHUNK_RAW_BYTES == 96 * 1024
    assert TRANSFER_TTL_S == 600


def test_file_ready_frame_shape():
    assert file_ready_frame("c1", "u1") == {
        "t": "file_ready", "chat": "c1", "id": "u1",
    }
    assert file_ready_frame("c1", "u1", seq=5) == {
        "t": "file_ready", "chat": "c1", "id": "u1", "seq": 5,
    }
    assert file_ready_frame("c1", "u1", seq=0)["seq"] == 0


def test_file_error_frame_shape():
    assert file_error_frame("c1", "u1", "E_CHECKSUM") == {
        "t": "file_error", "chat": "c1", "id": "u1", "code": "E_CHECKSUM",
    }
    assert file_error_frame("c1", "u1", "E_TOOBIG", "", seq=7) == {
        "t": "file_error", "chat": "c1", "id": "u1", "code": "E_TOOBIG",
        "seq": 7,
    }
    assert file_error_frame("c1", "u1", "E_STATE", "bad state", seq=8) == {
        "t": "file_error", "chat": "c1", "id": "u1", "code": "E_STATE",
        "msg": "bad state", "seq": 8,
    }


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
