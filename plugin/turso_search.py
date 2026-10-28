# -*- coding: utf-8 -*-
"""Read-only full-text search over the Turso archive (M13).

The mirror image of ``turso_archive.py``: that module writes chat/message
rows best-effort and never raises, while this one answers one browser
``search`` request and *must* let failures out, because a caller that cannot
tell "no hit" from "archive unreachable" would lie to the user.

Only stdlib + httpx here (no qwenpaw imports) so the module can be imported
by the plugin loader as a top-level module or as part of the package.
"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

import httpx

try:  # package-relative (tests, ``python -m plugin...``)
    from .turso_archive import execute_request, pipeline_body, pipeline_url
except ImportError:  # loaded as a top-level module by the plugin loader
    from turso_archive import execute_request, pipeline_body, pipeline_url

# Search is a human-in-the-loop request, so a stuck Turso call must give up
# quickly and let the SPA show "unavailable" instead of hanging the query.
DEFAULT_TIMEOUT_S = 10.0

# Longest query the plugin will look for; the SPA's input is a search box,
# not an essay, and an unbounded LIKE pattern would scan far more than needed.
QUERY_MAX_CHARS = 100

# How many code points of context make_snippet keeps on each side of a hit.
SNIPPET_RADIUS = 40

# -- SQL -------------------------------------------------------------------
#
# Statements are built by concatenating constants, never by formatting: the
# ESCAPE clause is a SQL string literal holding one backslash, and a stray
# escape in an f-string is exactly the kind of thing that silently turns
# ``ESCAPE '\'`` into ``ESCAPE ''``.
#
# ``messages`` is the table with the content; ``chats`` adds the display
# title and the agent scoping. The count uses an inner join because a
# message without its chat row is not a searchable conversation row either.

_COUNT_SQL = (
    "SELECT COUNT(*) FROM messages m JOIN chats c ON c.chat_id = m.chat_id "
    "WHERE "
)

_PAGE_SQL = (
    "SELECT m.chat_id, m.role, m.content, m.created_at, c.title "
    "FROM messages m LEFT JOIN chats c ON c.chat_id = m.chat_id WHERE "
)

_ORDER_SQL = " ORDER BY m.created_at DESC, m.id DESC LIMIT ?"

_LIKE_SQL = "m.content LIKE ? ESCAPE '\\'"

_AGENT_SQL = " AND c.agent_id = ?"


class TursoSearchError(Exception):
    """The archive could not answer a search (network, HTTP, Turso, JSON)."""


# -- pure helpers ----------------------------------------------------------

def decode_value(cell: Any) -> Any:
    """Decode one typed Turso pipeline value.

    Mirrors ``tools/turso_history.py`` (the tool is not a plugin runtime
    dependency). Blobs and unknown types degrade to None; a text cell with no
    value decodes to ``""`` so callers never have to special-case it.
    """
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


def escape_like(text: Any) -> str:
    """Escape ``\\``, ``%`` and ``_`` for a LIKE pattern with ESCAPE '\\'."""
    value = text if isinstance(text, str) else str(text or "")
    # The backslash must be escaped first, or the escapes added below would
    # be escaped again.
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def like_pattern(query: Any) -> str:
    """``"%<escaped query>%"`` -- the parameter for ``LIKE ? ESCAPE '\\'``."""
    return "%" + escape_like(query) + "%"


def normalize_query(raw: Any) -> str:
    """Trim, collapse internal whitespace, cut to QUERY_MAX_CHARS.

    A non-string or blank input normalises to ``""``, which the channel turns
    into ``E_SEARCH``/``bad_query`` before any Turso call is made.
    """
    if not isinstance(raw, str):
        return ""
    return " ".join(raw.split())[:QUERY_MAX_CHARS]


# SQLite LIKE folds ASCII A-Z only, and this table does the same thing
# without changing any character's length. ``str.lower`` must NOT be used for
# the search: some code points change length when lower-cased (for example
# U+0130 becomes "i" + U+0307), which would shift every later index.
_ASCII_LOWER = str.maketrans(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz",
)


def _ascii_fold(text: str) -> str:
    """Lower-case ASCII letters only; every other code point is untouched."""
    return text.translate(_ASCII_LOWER)


def _utf16_units(text: str) -> int:
    """Length of *text* in UTF-16 code units (what JavaScript indexes by)."""
    # ``surrogatepass`` keeps a lone surrogate (possible in parsed JSON) from
    # raising; a normal astral character still counts as two units.
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def make_snippet(
    content: Any, q: Any, radius: int = SNIPPET_RADIUS,
) -> Tuple[str, int, int]:
    """``(snippet, match_start, match_len)`` for the first hit of *q*.

    The hit is located on an ASCII-folded copy that is length-preserving per
    code point, so its index is also the index into *content* (the same
    case-insensitive semantics as SQLite's LIKE). Slicing is by code point,
    so an emoji is never cut in half. ``match_start`` / ``match_len`` are
    returned in UTF-16 code units because the SPA slices the snippet as a JS
    string; both are ``-1`` / ``0`` when the hit cannot be located (for
    example whitespace that SQL's LIKE matched but the raw content spells
    differently).
    """
    text = content if isinstance(content, str) else ""
    query = q if isinstance(q, str) else ""

    hit = -1
    if query:
        hit = _ascii_fold(text).find(_ascii_fold(query))
    if hit < 0:
        return (text[: 2 * radius + len(query)], -1, 0)

    start = max(0, hit - radius)
    end = min(len(text), hit + len(query) + radius)
    return (
        text[start:end],
        _utf16_units(text[start:hit]),
        _utf16_units(text[hit:hit + len(query)]),
    )


def _result_rows(entry: Any) -> List[Any]:
    """Rows of one pipeline result, raising TursoSearchError when unusable."""
    if not isinstance(entry, dict):
        raise TursoSearchError("malformed pipeline result")
    if entry.get("type") == "error":
        error = entry.get("error")
        message = error.get("message") if isinstance(error, dict) else None
        raise TursoSearchError("turso error: %s" % (message or "unknown error"))
    response = entry.get("response")
    result = response.get("result") if isinstance(response, dict) else None
    if not isinstance(result, dict):
        raise TursoSearchError("malformed pipeline result")
    rows = result.get("rows")
    if rows is None:
        return []
    if not isinstance(rows, list):
        raise TursoSearchError("malformed pipeline result")
    return rows


# -- searcher --------------------------------------------------------------

class TursoSearcher:
    """One-shot read queries against the same ``/v2/pipeline`` endpoint."""

    def __init__(
        self, url: str, token: str, transport=None,
        timeout: float = DEFAULT_TIMEOUT_S,
    ):
        self._url = url or ""
        self._token = token or ""
        self._timeout_s = timeout
        self._pipeline = pipeline_url(self._url)
        self._transport = (
            transport if transport is not None else self._httpx_transport
        )
        # Both halves of the credential are required, exactly like the
        # archiver: a half-configured channel simply has no searchable data.
        self.enabled = bool(url and token)

    # -- transport ------------------------------------------------------

    async def _httpx_transport(
        self, url: str, headers: Dict[str, str], body: Dict[str, Any],
    ) -> Any:
        """Default transport: one POST returning the decoded JSON document."""
        async with httpx.AsyncClient(timeout=self._timeout_s) as client:
            response = await client.post(url, json=body, headers=headers)
            response.raise_for_status()
            return response.json()

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": "Bearer %s" % self._token,
            "Content-Type": "application/json",
        }

    # -- public API (raises on failure) ---------------------------------

    async def search(
        self, query: str, limit: int, agent_id: str = "",
    ) -> Tuple[List[Dict[str, Any]], int]:
        """Run COUNT + page in one pipeline; return ``(items, total)``.

        ``total`` is the number of rows the predicate matches overall, while
        ``items`` holds at most *limit* newest hits. Every hit carries a
        snippet and the UTF-16 offset/length of the match inside it -- the
        message content itself never crosses the wire.
        """
        if not self.enabled:
            raise TursoSearchError("archive not configured")

        where = _LIKE_SQL
        args: List[Any] = [like_pattern(query)]
        agent = agent_id if isinstance(agent_id, str) else ""
        if agent:
            where += _AGENT_SQL
            args.append(agent)

        body = pipeline_body([
            execute_request(_COUNT_SQL + where, list(args)),
            execute_request(_PAGE_SQL + where + _ORDER_SQL, [*args, limit]),
        ])
        try:
            document = await self._transport(
                self._pipeline, self._headers(), body,
            )
        except Exception as exc:  # noqa: BLE001 - re-raised as our own type
            raise TursoSearchError("pipeline request failed: %s" % exc) from exc

        results = document.get("results") if isinstance(document, dict) else None
        if not isinstance(results, list) or len(results) < 2:
            raise TursoSearchError("malformed pipeline response")

        # Both halves are checked before anything is decoded: a failing page
        # query must not look like "zero hits".
        count_rows = _result_rows(results[0])
        page_rows = _result_rows(results[1])

        total = 0
        if count_rows and isinstance(count_rows[0], list) and count_rows[0]:
            value = decode_value(count_rows[0][0])
            if isinstance(value, int) and not isinstance(value, bool):
                total = value

        items: List[Dict[str, Any]] = []
        for row in page_rows:
            if not isinstance(row, list) or len(row) < 5:
                continue
            chat = decode_value(row[0])
            role = decode_value(row[1])
            content = decode_value(row[2])
            created_at = decode_value(row[3])
            title = decode_value(row[4])
            chat_id = "" if chat is None else str(chat)
            text = content if isinstance(content, str) else (
                "" if content is None else str(content)
            )
            snippet, match_start, match_len = make_snippet(text, query)
            label = title if isinstance(title, str) and title.strip() else chat_id
            items.append({
                "chat": chat_id,
                "title": label,
                "role": "" if role is None else str(role),
                "snippet": snippet,
                "match_start": match_start,
                "match_len": match_len,
                "ts": created_at,
            })
        return items, total
