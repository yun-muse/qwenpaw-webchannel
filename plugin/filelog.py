# -*- coding: utf-8 -*-
"""Best-effort append-only file log for the WebChannel plugin (M7.2).

The plugin runs inside QwenPaw with no access to the hosted relay's logs, so
the interesting lifecycle events (connect / hello / close / reconnect / ...)
are mirrored into a small rotating file next to the workspace. Logging is
strictly best effort: ``write`` never raises, so a full disk, a bogus path or
a racing process can never take the channel down.
"""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Any

DEFAULT_MAX_BYTES = 262144
DEFAULT_BACKUPS = 2


def _clean(value: Any) -> str:
    """``str(value)`` with field separators replaced: one event per line."""
    return str(value).replace(" ", "_").replace("\n", "_").replace("\r", "_")


def _timestamp(now: float) -> str:
    """``YYYY-MM-DD HH:MM:SS.mmm`` in local time."""
    stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now))
    return "%s.%03d" % (stamp, int((now % 1) * 1000))


class FileLog:
    """Append ``<ts> event k=v k=v`` lines to *path*, rotating at *max_bytes*.

    Nothing is created at construction time, so building one is free and safe
    regardless of where it ends up being pointed.
    """

    def __init__(
        self,
        path,
        max_bytes: int = DEFAULT_MAX_BYTES,
        backups: int = DEFAULT_BACKUPS,
    ):
        self.path = Path(path)
        self.max_bytes = int(max_bytes)
        self.backups = max(0, int(backups))
        self._lock = threading.Lock()

    # -- public ---------------------------------------------------------

    def write(self, event: str, **fields) -> None:
        """Append one event line. Never raises (see module docstring)."""
        try:
            suffix = "".join(
                " %s=%s" % (_clean(key), _clean(value))
                for key, value in fields.items()
            )
            line = "%s %s%s\n" % (_timestamp(time.time()), _clean(event), suffix)
            data = line.encode("utf-8", "replace")
            with self._lock:
                self._rotate_for(len(data))
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with open(self.path, "ab") as handle:
                    handle.write(data)
        except Exception:  # noqa: BLE001 - logging must never raise
            pass

    # -- internals ------------------------------------------------------

    def _rotate_for(self, incoming: int) -> None:
        """Shift the backups and drop the current file on overflow."""
        # ``is_file`` also keeps a bogus directory path from being renamed.
        if self.max_bytes <= 0 or not self.path.is_file():
            return
        try:
            size = self.path.stat().st_size
        except OSError:  # pragma: no cover - vanished under us
            return
        if size + incoming <= self.max_bytes:
            return
        for index in range(self.backups - 1, 0, -1):
            source = self._backup(index)
            try:
                if source.is_file():
                    os.replace(source, self._backup(index + 1))
            except OSError:  # pragma: no cover - best effort
                pass
        if self.backups >= 1:
            try:
                os.replace(self.path, self._backup(1))
            except OSError:  # pragma: no cover - best effort
                pass
        else:
            try:
                self.path.unlink()
            except OSError:  # pragma: no cover - best effort
                pass

    def _backup(self, index: int) -> Path:
        """``path.<index>`` next to the live file."""
        return self.path.with_name("%s.%d" % (self.path.name, index))
