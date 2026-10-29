#!/usr/bin/env python3
"""Standalone tests for the plugin file log (``plugin/filelog.py``).

``test_m72`` already proves that a FileLog written by RelayClient mentions the
lifecycle events; this suite pins the log's own contract: one event per line,
predictable rotation/backup naming, the ``backups`` and ``max_bytes`` knobs,
and the promise that ``write`` never raises no matter where it points.

No network and no pytest required:

    cd plugin && python3 tests/test_filelog.py
    cd plugin && python3 -m pytest tests/test_filelog.py -q
"""

import os
import re
import sys
import tempfile
import threading
from pathlib import Path

_HERE = os.path.dirname(os.path.abspath(__file__))
_PLUGIN_DIR = os.path.dirname(_HERE)
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

from filelog import (  # noqa: E402  (path setup must run first)
    DEFAULT_BACKUPS,
    DEFAULT_MAX_BYTES,
    FileLog,
    _clean,
    _timestamp,
)

_LINE_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \S+"
)


def _lines(path):
    return [line for line in path.read_text(encoding="utf-8").splitlines() if line]


def _events(path):
    """Event names of one log file (the third space-separated column)."""
    return [line.split(" ")[2] for line in _lines(path)]


def _backups(tmp):
    return sorted(
        item for item in Path(tmp).iterdir()
        if re.search(r"\.log\.\d+$", item.name)
    )


# --------------------------------------------------------------------------
# line format
# --------------------------------------------------------------------------

def test_defaults_match_the_documented_budget():
    assert DEFAULT_MAX_BYTES == 262144
    assert DEFAULT_BACKUPS == 2


def test_construction_touches_nothing():
    with tempfile.TemporaryDirectory(prefix="wc-flog-") as tmp:
        path = Path(tmp) / "deep" / "webchannel.log"
        FileLog(path)
        assert not path.exists()
        assert not path.parent.exists()


def test_clean_flattens_field_separators():
    assert _clean("a b") == "a_b"
    assert _clean("a\nb") == "a_b"
    assert _clean("a\rb") == "a_b"
    assert _clean("plain") == "plain"
    assert _clean(3) == "3"
    assert _clean(None) == "None"


def test_timestamp_shape_and_milliseconds():
    text = _timestamp(1234567890.25)
    assert re.match(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$", text), text
    assert text.endswith(".250")
    assert _timestamp(0.0).endswith(".000")


def test_write_one_line_with_fields():
    with tempfile.TemporaryDirectory(prefix="wc-flog-") as tmp:
        path = Path(tmp) / "webchannel.log"
        FileLog(path).write("connect", agent="default", attempt=1)
        lines = _lines(path)
        assert len(lines) == 1
        assert _LINE_RE.match(lines[0]), lines[0]
        assert " connect " in " " + lines[0] + " "
        assert " agent=default" in lines[0]
        assert " attempt=1" in lines[0]
        assert path.read_bytes().endswith(b"\n")


def test_write_sanitizes_event_keys_and_values():
    with tempfile.TemporaryDirectory(prefix="wc-flog-") as tmp:
        path = Path(tmp) / "webchannel.log"
        FileLog(path).write("bad event\nname", **{"odd key": "v 1"}, normal="ok")
        line = _lines(path)[0]
        assert "bad_event_name" in line
        assert "odd_key=v_1" in line
        assert "normal=ok" in line
        assert "\n" not in line


def test_write_appends_in_order():
    with tempfile.TemporaryDirectory(prefix="wc-flog-") as tmp:
        path = Path(tmp) / "webchannel.log"
        flog = FileLog(path)
        for index in range(4):
            flog.write("tick", i=index)
        assert _events(path) == ["tick"] * 4
        assert [line.rsplit(" i=", 1)[1] for line in _lines(path)] == ["0", "1", "2", "3"]


def test_write_creates_missing_parent_directories():
    with tempfile.TemporaryDirectory(prefix="wc-flog-") as tmp:
        path = Path(tmp) / "a" / "b" / "webchannel.log"
        FileLog(path).write("hello")
        assert path.is_file()
        assert _events(path) == ["hello"]


def test_write_keeps_unicode():
    with tempfile.TemporaryDirectory(prefix="wc-flog-") as tmp:
        path = Path(tmp) / "webchannel.log"
        FileLog(path).write("msg", text="café世界😀")
        assert "café世界😀" in _lines(path)[0]


def test_lone_surrogate_is_replaced_not_raised():
    with tempfile.TemporaryDirectory(prefix="wc-flog-") as tmp:
        path = Path(tmp) / "webchannel.log"
        FileLog(path).write("bad", value="\ud800")
        assert path.is_file()
        assert "?" in _lines(path)[0]


# --------------------------------------------------------------------------
# rotation
# --------------------------------------------------------------------------

def test_rotation_chain_and_backup_names():
    with tempfile.TemporaryDirectory(prefix="wc-flog-") as tmp:
        path = Path(tmp) / "webchannel.log"
        flog = FileLog(path)
        flog.write("first")
        first_size = path.stat().st_size

        # One byte of headroom: every following line overflows and rotates.
        flog = FileLog(path, max_bytes=first_size + 1, backups=2)
        flog.write("second")
        assert _events(path) == ["second"]
        assert _events(Path(str(path) + ".1")) == ["first"]
        assert not Path(str(path) + ".2").exists()

        flog.write("third")
        assert _events(path) == ["third"]
        assert _events(Path(str(path) + ".1")) == ["second"]
        assert _events(Path(str(path) + ".2")) == ["first"]

        # A fourth rotation drops the oldest backup.
        flog.write("fourth")
        assert _events(path) == ["fourth"]
        assert _events(Path(str(path) + ".1")) == ["third"]
        assert _events(Path(str(path) + ".2")) == ["second"]
        assert not Path(str(path) + ".3").exists()
        assert len(_backups(tmp)) == 2


def test_single_backup_keeps_only_one_old_file():
    with tempfile.TemporaryDirectory(prefix="wc-flog-") as tmp:
        path = Path(tmp) / "webchannel.log"
        flog = FileLog(path)
        flog.write("first")
        flog = FileLog(path, max_bytes=flog.path.stat().st_size + 1, backups=1)
        flog.write("second")
        flog.write("third")
        assert _events(path) == ["third"]
        assert _events(path.with_name("webchannel.log.1")) == ["second"]
        assert not path.with_name("webchannel.log.2").exists()
        assert len(_backups(tmp)) == 1


def test_zero_backups_deletes_the_old_file():
    with tempfile.TemporaryDirectory(prefix="wc-flog-") as tmp:
        path = Path(tmp) / "webchannel.log"
        flog = FileLog(path)
        flog.write("first")
        flog = FileLog(path, max_bytes=flog.path.stat().st_size + 1, backups=0)
        flog.write("second")
        assert _events(path) == ["second"]
        assert _backups(tmp) == []


def test_non_positive_max_bytes_disables_rotation():
    for limit in (0, -1):
        with tempfile.TemporaryDirectory(prefix="wc-flog-") as tmp:
            path = Path(tmp) / "webchannel.log"
            flog = FileLog(path, max_bytes=limit, backups=2)
            for index in range(40):
                flog.write("tick", i=index, pad="x" * 80)
            assert len(_lines(path)) == 40
            assert _backups(tmp) == []


def test_oversized_first_record_is_written_then_rotated():
    with tempfile.TemporaryDirectory(prefix="wc-flog-") as tmp:
        path = Path(tmp) / "webchannel.log"
        flog = FileLog(path, max_bytes=64, backups=1)
        flog.write("big", pad="x" * 500)
        # No pre-existing file means nothing to rotate: the line is not lost.
        assert _events(path) == ["big"]
        assert path.stat().st_size > 64

        flog.write("small")
        assert _events(path) == ["small"]
        assert _events(path.with_name("webchannel.log.1")) == ["big"]


def test_rotation_keeps_the_total_size_bounded():
    with tempfile.TemporaryDirectory(prefix="wc-flog-") as tmp:
        path = Path(tmp) / "webchannel.log"
        flog = FileLog(path, max_bytes=1024, backups=2)
        for index in range(300):
            flog.write("tick", i=index, pad="x" * 60)
        files = [path] + _backups(tmp)
        assert len(files) <= 3
        # Each file may exceed max_bytes by at most one line, never by a batch.
        for item in files:
            assert item.stat().st_size <= 1024 + 300, item


# --------------------------------------------------------------------------
# hostile paths / values
# --------------------------------------------------------------------------

def test_directory_path_never_raises():
    with tempfile.TemporaryDirectory(prefix="wc-flog-") as tmp:
        flog = FileLog(Path(tmp), max_bytes=64, backups=2)
        flog.write("tick", value="x")  # must not raise
        assert Path(tmp).is_dir()
        assert list(Path(tmp).iterdir()) == []


def test_parent_that_is_a_file_never_raises():
    with tempfile.TemporaryDirectory(prefix="wc-flog-") as tmp:
        blocker = Path(tmp) / "blocker"
        blocker.write_text("x", encoding="utf-8")
        FileLog(blocker / "child.log").write("tick")  # must not raise


def test_value_whose_str_raises_never_propagates():
    class Boom:
        def __str__(self):
            raise RuntimeError("boom")

    with tempfile.TemporaryDirectory(prefix="wc-flog-") as tmp:
        path = Path(tmp) / "webchannel.log"
        FileLog(path).write("event", value=Boom())  # must not raise
        assert not path.exists()


def test_concurrent_writes_do_not_interleave_lines():
    with tempfile.TemporaryDirectory(prefix="wc-flog-") as tmp:
        path = Path(tmp) / "webchannel.log"
        flog = FileLog(path, max_bytes=0)  # rotation off keeps the count exact
        workers = 8
        per_worker = 40

        def work(worker):
            for index in range(per_worker):
                flog.write("thread", worker=worker, i=index)

        threads = [threading.Thread(target=work, args=(w,)) for w in range(workers)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        lines = _lines(path)
        assert len(lines) == workers * per_worker
        assert all(_LINE_RE.match(line) for line in lines)
        assert all(" thread worker=" in line for line in lines)


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
