#!/usr/bin/env python3
"""Standalone tests for the uncovered edges of ``plugin/turso_search.py``.

``test_m13`` covers the normal path (LIKE escaping, snippet offsets, a happy
pipeline response). This suite pins the parts that decide what a *broken*
archive answer looks like: a malformed count or page half must raise instead
of masquerading as "no hits", and the snippet helpers must keep UTF-16
offsets meaningful for empty queries, astral characters and case folding.

No live Turso, no network and no pytest required:

    cd plugin && python3 tests/test_search_edges.py
    cd plugin && python3 -m pytest tests/test_search_edges.py -q
"""

import asyncio
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_PLUGIN_DIR = os.path.dirname(_HERE)
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

from turso_search import (  # noqa: E402  (path setup must run first)
    TursoSearchError,
    TursoSearcher,
    _ascii_fold,
    _result_rows,
    _utf16_units,
    make_snippet,
)

_URL = "libsql://unit-test.turso.io"
_TOKEN = "token"


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def _integer(value):
    return {"type": "integer", "value": str(value)}


def _float(value):
    return {"type": "float", "value": str(value)}


def _text(value):
    return {"type": "text", "value": value}


def _null():
    return {"type": "null"}


def _entry(rows):
    return {"type": "ok", "response": {"result": {"rows": rows}}}


def _doc(count_rows, page_rows):
    return {"results": [_entry(count_rows), _entry(page_rows)]}


class _Transport:
    """Recording fake transport: returns a document or raises on demand."""

    def __init__(self, document=None, exc=None):
        self.document = document
        self.exc = exc
        self.calls = []

    async def __call__(self, url, headers, body):
        self.calls.append((url, headers, body))
        if self.exc is not None:
            raise self.exc
        return self.document


def _run(searcher, query="hello", limit=10, agent_id=""):
    return asyncio.run(searcher.search(query, limit, agent_id=agent_id))


def _args_of(transport):
    return transport.calls[0][2]["requests"][0]["stmt"]["args"]


def _expect_turso_error(fn, fragment=""):
    try:
        fn()
    except TursoSearchError as exc:
        assert fragment in str(exc), (fragment, str(exc))
        return exc
    raise AssertionError("expected TursoSearchError")


# --------------------------------------------------------------------------
# make_snippet / folding
# --------------------------------------------------------------------------

def test_empty_query_returns_the_prefix_and_no_match():
    assert make_snippet("hello world", "", radius=3) == ("hello ", -1, 0)
    assert make_snippet("hello", None) == ("hello", -1, 0)


def test_non_string_content_and_query_are_treated_as_empty():
    assert make_snippet(None, "x") == ("", -1, 0)
    assert make_snippet(123, "1") == ("", -1, 0)
    assert make_snippet("abc", 123) == ("abc", -1, 0)


def test_radius_zero_returns_exactly_the_match():
    assert make_snippet("aaTARGETbb", "TARGET", radius=0) == ("TARGET", 0, 6)


def test_missing_hit_prefix_uses_two_radii_plus_query_length():
    assert make_snippet("abcdefgh", "zz", radius=2) == ("abcdef", -1, 0)
    assert make_snippet("ab", "abcdef", radius=0) == ("ab", -1, 0)


def test_whitespace_mismatch_is_not_located():
    # SQL's LIKE can match across what the raw content spells as a newline;
    # the snippet must then report "not located" instead of a wrong offset.
    assert make_snippet("a\nb", "a b", radius=4) == ("a\nb", -1, 0)


def test_astral_character_inside_the_match_counts_two_units():
    assert make_snippet("x😀y", "😀", radius=1) == ("x😀y", 1, 2)


def test_astral_context_offsets_stay_in_utf16_units():
    snippet, start, length = make_snippet("😀😀abc😀", "abc", radius=1)
    assert snippet == "😀abc😀"
    assert start == 2
    assert _utf16_units(snippet[:1]) == 2
    assert snippet.encode("utf-16-le")[2 * start:][: 2 * length] == b"a\x00b\x00c\x00"


def test_ascii_fold_leaves_non_ascii_code_points_alone():
    # str.lower() would turn "İ" into "i" + U+0307 and shift every offset.
    assert _ascii_fold("ABC") == "abc"
    assert _ascii_fold("İÄÖÜ") == "İÄÖÜ"
    assert len(_ascii_fold("İÄÖÜ")) == len("İÄÖÜ")


def test_turkish_dotted_capital_keeps_offsets():
    snippet, start, length = make_snippet("İİabc", "abc", radius=1)
    assert snippet == "İabc"
    assert start == 1
    assert length == 3


def test_utf16_units_counts_code_units():
    assert _utf16_units("") == 0
    assert _utf16_units("abc") == 3
    assert _utf16_units("😀") == 2
    assert _utf16_units("\ud800") == 1  # lone surrogate from parsed JSON


# --------------------------------------------------------------------------
# _result_rows taxonomy
# --------------------------------------------------------------------------

def test_result_rows_accepts_missing_rows_as_empty():
    assert _result_rows({"response": {"result": {}}}) == []
    assert _result_rows({"response": {"result": {"rows": None}}}) == []


def test_result_rows_raises_on_every_malformed_shape():
    for entry in (
        "nope",
        None,
        {},
        {"type": "ok"},
        {"type": "ok", "response": None},
        {"type": "ok", "response": {}},
        {"type": "ok", "response": {"result": []}},
        {"type": "ok", "response": {"result": {"rows": "x"}}},
    ):
        _expect_turso_error(lambda entry=entry: _result_rows(entry), "malformed")


def test_result_rows_surfaces_turso_error_text():
    entry = {"type": "error", "error": {"message": "no such table"}}
    _expect_turso_error(lambda: _result_rows(entry), "turso error: no such table")
    _expect_turso_error(lambda: _result_rows({"type": "error"}), "unknown error")
    _expect_turso_error(
        lambda: _result_rows({"type": "error", "error": "plain string"}),
        "unknown error",
    )


# --------------------------------------------------------------------------
# TursoSearcher failure modes
# --------------------------------------------------------------------------

def test_search_rejects_a_malformed_document():
    for document in (None, [], {}, {"results": []}, {"results": "x"}, {"results": [{}]}):
        searcher = TursoSearcher(_URL, _TOKEN, transport=_Transport(document))
        _expect_turso_error(
            lambda searcher=searcher: _run(searcher), "malformed pipeline response",
        )


def test_search_raises_when_the_count_half_is_unusable():
    # A broken count must never look like "zero hits".
    document = {"results": ["nope", _entry([])]}
    searcher = TursoSearcher(_URL, _TOKEN, transport=_Transport(document))
    _expect_turso_error(lambda: _run(searcher), "malformed")


def test_search_raises_when_the_page_half_is_unusable():
    document = {"results": [_entry([[ _integer(1) ]]), {"type": "error"}]}
    searcher = TursoSearcher(_URL, _TOKEN, transport=_Transport(document))
    _expect_turso_error(lambda: _run(searcher), "turso error")


def test_search_wraps_transport_failures_and_keeps_the_cause():
    boom = RuntimeError("offline")
    searcher = TursoSearcher(_URL, _TOKEN, transport=_Transport(exc=boom))
    exc = _expect_turso_error(lambda: _run(searcher), "pipeline request failed: offline")
    assert exc.__cause__ is boom


def test_search_ignores_totals_that_decoded_to_something_else():
    for count_rows in (
        [],
        [[]],
        [[_text("7")]],
        [[_null()]],
        [[_float("7.0")]],
        ["not-a-row"],
    ):
        transport = _Transport(_doc(count_rows, []))
        searcher = TursoSearcher(_URL, _TOKEN, transport=transport)
        items, total = _run(searcher)
        assert (items, total) == ([], 0), count_rows


def test_search_skips_malformed_page_rows():
    rows = [
        "not-a-row",
        None,
        ["too-short"],
        [_text("c1"), _text("user"), _text("needle"), _integer(5), _text("T")],
    ]
    transport = _Transport(_doc([[ _integer(1) ]], rows))
    items, total = _run(TursoSearcher(_URL, _TOKEN, transport=transport))
    assert total == 1
    assert len(items) == 1
    assert items[0]["chat"] == "c1"
    assert items[0]["snippet"] == "needle"


def test_search_decodes_row_fallbacks():
    rows = [
        [_null(), _null(), _integer(42), _null(), _text("   ")],
        [_text("c2"), _text("assistant"), _null(), _text("2026-01-01"), _text("Title")],
    ]
    transport = _Transport(_doc([[ _integer(2) ]], rows))
    items, _ = _run(TursoSearcher(_URL, _TOKEN, transport=transport))

    first, second = items
    assert first["chat"] == ""
    assert first["role"] == ""
    assert first["title"] == ""  # whitespace-only title falls back to chat id
    assert first["snippet"] == "42"
    assert first["match_start"] == -1 and first["match_len"] == 0
    assert first["ts"] is None

    assert second["chat"] == "c2"
    assert second["title"] == "Title"
    assert second["snippet"] == ""
    assert second["ts"] == "2026-01-01"


def test_search_escapes_backslash_and_wildcards_together():
    transport = _Transport(_doc([[ _integer(0) ]], []))
    searcher = TursoSearcher(_URL, _TOKEN, transport=transport)
    _run(searcher, query="a\\%_b", limit=5)
    expected = "%" + "a" + "\\\\" + "\\%" + "\\_" + "b" + "%"
    assert _args_of(transport) == [{"type": "text", "value": expected}]


def test_search_omits_a_non_string_agent_id():
    transport = _Transport(_doc([[ _integer(0) ]], []))
    searcher = TursoSearcher(_URL, _TOKEN, transport=transport)
    _run(searcher, limit=5, agent_id=7)
    assert _args_of(transport) == [{"type": "text", "value": "%hello%"}]
    assert "agent_id" not in transport.calls[0][2]["requests"][0]["stmt"]["sql"]


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
