#!/usr/bin/env python3
"""Read back archived WebChannel conversations from Turso.

Verification surface for the M6 archiving pipeline: talks to the same
``/v2/pipeline`` endpoint as ``plugin/turso_archive.py`` and prints archived
chats (``--list``) or one chat's transcript (``--chat <id>``).

Credentials are read at runtime from ``.secrets/turso.env`` (``--env`` to
point elsewhere); they are never printed. Stdlib only, so the tool runs
anywhere python3 does.

Usage:
    python3 tools/turso_history.py --list
    python3 tools/turso_history.py --chat chat-turso-abc123
"""

import argparse
import datetime
import json
import os
import sys
import urllib.error
import urllib.request

PIPELINE_PATH = "/v2/pipeline"
TIMEOUT_S = 60  # first connect to Turso from some networks is slow

_SCHEME_SWAPS = (
    ("libsql://", "https://"),
    ("wss://", "https://"),
    ("ws://", "http://"),
)

LIST_SQL = (
    "SELECT chat_id, agent_id, created_at, updated_at, title, "
    "(SELECT COUNT(*) FROM messages WHERE messages.chat_id = chats.chat_id) "
    "AS msg_count FROM chats ORDER BY updated_at DESC"
)

CHAT_SQL = (
    "SELECT role, content, created_at FROM messages "
    "WHERE chat_id = ? ORDER BY id ASC"
)


class ToolError(Exception):
    """Fatal, user-facing failure (the message never contains a token)."""


# -- config ----------------------------------------------------------------

def repo_root():
    """Repo root: the parent of the ``tools/`` directory holding this file."""
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_env(path):
    """Parse ``KEY=VALUE`` lines from *path* and require the Turso creds."""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            lines = handle.readlines()
    except OSError as exc:
        raise ToolError(
            "cannot read env file %s: %s" % (path, exc.strerror or exc)
        )

    env = {}
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        if key:
            env[key] = value

    missing = [name for name in ("TURSO_DB_URL", "TURSO_DB_TOKEN") if not env.get(name)]
    if missing:
        raise ToolError("missing %s in %s" % (" / ".join(missing), path))
    return env


# -- pipeline client (same wire format as plugin/turso_archive.py) ---------

def pipeline_url(db_url):
    """Turso ``/v2/pipeline`` endpoint for a ``libsql://`` style database URL."""
    url = str(db_url or "").strip()
    for prefix, replacement in _SCHEME_SWAPS:
        if url.startswith(prefix):
            url = replacement + url[len(prefix):]
            break
    return url.rstrip("/") + PIPELINE_PATH


def typed_arg(value):
    """One Turso pipeline typed value."""
    if value is None:
        return {"type": "null"}
    if isinstance(value, int) and not isinstance(value, bool):
        return {"type": "integer", "value": str(value)}
    return {"type": "text", "value": str(value)}


def execute_request(sql, args=()):
    """One pipeline ``execute`` request for *sql* with *args*."""
    return {
        "type": "execute",
        "stmt": {"sql": sql, "args": [typed_arg(arg) for arg in args]},
    }


def decode_value(cell):
    """Decode one typed pipeline value; blobs are not printable -> None."""
    kind = cell.get("type") if isinstance(cell, dict) else None
    if kind == "null":
        return None
    if kind == "integer":
        try:
            return int(cell.get("value"))
        except (TypeError, ValueError):
            return None
    if kind == "float":
        try:
            return float(cell.get("value"))
        except (TypeError, ValueError):
            return None
    if kind == "text":
        value = cell.get("value")
        if value is None:
            return ""
        return value if isinstance(value, str) else str(value)
    return None  # blob or unknown type


def run_query(env, sql, args=()):
    """Run one statement through Turso; return rows as lists of python values."""
    body = {"requests": [execute_request(sql, args), {"type": "close"}]}
    payload = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        pipeline_url(env["TURSO_DB_URL"]),
        data=payload,
        method="POST",
        headers={
            "Authorization": "Bearer %s" % env["TURSO_DB_TOKEN"],
            "Content-Type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        raise ToolError("HTTP %s" % exc.code)
    except urllib.error.URLError as exc:
        raise ToolError("request failed: %s" % (exc.reason,))
    except OSError as exc:
        raise ToolError("request failed: %s" % exc)

    try:
        doc = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise ToolError("invalid JSON response from Turso")

    results = doc.get("results") or []
    if not results:
        raise ToolError("empty pipeline response from Turso")
    first = results[0]
    if first.get("type") == "error":
        message = (first.get("error") or {}).get("message") or "unknown error"
        raise ToolError("Turso error: %s" % message)

    result = ((first.get("response") or {}).get("result") or {})
    rows = result.get("rows") or []
    return [[decode_value(cell) for cell in row] for row in rows]


# -- presentation ----------------------------------------------------------

def format_ms(value):
    """Unix milliseconds -> ``YYYY-MM-DD HH:MM:SS`` in UTC."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return "?"
    try:
        stamp = datetime.datetime.fromtimestamp(
            value / 1000.0, datetime.timezone.utc,
        )
    except (OverflowError, OSError, ValueError):
        return "?"
    return stamp.strftime("%Y-%m-%d %H:%M:%S")


def _text(value):
    return "" if value is None else str(value)


def list_chats(env):
    rows = run_query(env, LIST_SQL)
    if not rows:
        print("no archived chats")
        return
    for row in rows:
        chat_id, _agent_id, _created_at, updated_at, title, msg_count = row
        print(
            "%s  msgs=%s  updated=%sZ  title=%s"
            % (
                _text(chat_id),
                msg_count if msg_count is not None else 0,
                format_ms(updated_at),
                _text(title),
            )
        )


def show_chat(env, chat_id):
    rows = run_query(env, CHAT_SQL, [chat_id])
    if not rows:
        sys.stderr.write("no archived messages for chat %s\n" % chat_id)
        raise SystemExit(2)
    print("chat %s (%d messages)" % (chat_id, len(rows)))
    for row in rows:
        role, content, _created_at = row
        print("%s: %s" % (_text(role), _text(content)))


# -- entry point -----------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Print archived WebChannel chats/messages from Turso.",
    )
    parser.add_argument(
        "--env", default=None,
        help="credentials file (default: <repo>/.secrets/turso.env)",
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "--list", action="store_true", dest="list_chats",
        help="list archived chats, newest first",
    )
    group.add_argument(
        "--chat", metavar="CHAT_ID", default=None,
        help="print the archived transcript of CHAT_ID",
    )
    args = parser.parse_args(argv)

    path = args.env or os.path.join(repo_root(), ".secrets", "turso.env")
    try:
        env = load_env(path)
        if args.list_chats:
            list_chats(env)
        else:
            show_chat(env, args.chat)
    except ToolError as exc:
        sys.stderr.write("turso_history: %s\n" % exc)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
