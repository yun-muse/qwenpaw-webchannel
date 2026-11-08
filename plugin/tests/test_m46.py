#!/usr/bin/env python3
"""Standalone tests for M46: reasoning identity in ``hist`` and on stop.

RC1 — ``history_messages`` must keep a QwenPaw ``Message(type="reasoning")``
distinct on the wire (``kind:"reasoning"``), join its text with the export
rule, and leave the turn receipt on the answer row only.

RC2 — ``response_partial_text`` must skip reasoning/tool messages of a
cancelled envelope and return only the partial answer.

The shapes are the real ones QwenPaw v2.2.2.post1 produces; the reasoning and
answer messages are two separate ``Message`` objects sharing one
``metadata.original_id`` (see docs/m46-report.md §1).

Run either way (no pytest required; needs httpx for ``channel``):

    cd plugin && python3 tests/test_m46.py
    cd plugin && python3 -m pytest tests/test_m46.py -q
"""

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_PLUGIN_DIR = os.path.dirname(_HERE)
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

from frames import PROTOCOL_VERSION  # noqa: E402  (path setup must run first)
from util import history_messages, response_partial_text  # noqa: E402

TURN = "m46-turn-1"
REASONING = "M46-REASONING-MARKER 先核对条件，再逐条排除。"
ANSWER = "M46-ANSWER-MARKER 结论如下。"
USAGE = {"prompt_tokens": 10, "completion_tokens": 5}


def _message(
    message_type, text, message_id="", role="assistant", usage=None,
    content=None,
):
    """One raw ``Message`` as ``GET /api/chats/{id}`` returns it."""
    metadata = {"original_id": TURN, "metadata": {}}
    if usage is not None:
        metadata["metadata"] = {"qwenpaw_turn_usage": {"usage": dict(usage)}}
    return {
        "id": message_id,
        "type": message_type,
        "role": role,
        "content": (
            content
            if content is not None
            else [{"type": "text", "text": text}]
        ),
        "status": "completed",
        "metadata": metadata,
    }


def _history():
    """The real two-message shape: user, reasoning half, answer half.

    Both assistant segments come from one persisted ``Msg`` (same
    ``original_id``) and repeat the same usage, exactly like the split in
    ``app/chats/utils.py::agentscope_msg_to_message``.
    """
    return {
        "messages": [
            _message("message", "问题", "msg-user", role="user"),
            _message("reasoning", REASONING, "msg-reasoning", usage=USAGE),
            _message("message", ANSWER, "msg-answer", usage=USAGE),
        ],
        "status": "idle",
    }


# --------------------------------------------------------------------------
# RC1 — hist carries the kind
# --------------------------------------------------------------------------

def test_hist_keeps_reasoning_kind():
    messages = history_messages(_history())
    assert [m["role"] for m in messages] == [
        "user", "assistant", "assistant",
    ]
    assert messages[1]["text"] == REASONING
    assert messages[1]["kind"] == "reasoning"
    assert "kind" not in messages[2]
    assert messages[2]["text"] == ANSWER


def test_hist_turn_receipt_anchors_to_the_answer_row_only():
    messages = history_messages(_history())
    assert "turn" not in messages[1]
    assert messages[2]["turn"] == {
        "id": TURN, "input": 10, "output": 5, "total": 15,
    }
    assert "turn" not in messages[0]
    assert sum("turn" in m for m in messages) == 1


def test_hist_reasoning_joins_like_the_export():
    """``thinking``/``text`` parts join with a blank line (M20 export rule)."""
    content = [
        {"type": "thinking", "thinking": "第一段思考"},
        {"type": "text", "text": "第二段思考"},
    ]
    messages = history_messages({"messages": [
        _message("reasoning", "", "msg-r", content=content),
    ]})
    assert messages == [
        {
            "role": "assistant",
            "text": "第一段思考\n\n第二段思考",
            "kind": "reasoning",
        },
    ]


def test_hist_non_reasoning_rows_are_unchanged():
    """A thinking *block* inside a MESSAGE row is not a reasoning row."""
    messages = history_messages({"messages": [
        _message("message", "答案", "msg-a", content=[
            {"type": "thinking", "thinking": "块级思考"},
            {"type": "text", "text": "答案"},
        ]),
    ]})
    assert messages == [{"role": "assistant", "text": "答案"}]


# --------------------------------------------------------------------------
# RC2 — stop keeps only the answer
# --------------------------------------------------------------------------

def _cancelled_response():
    """The real two-message cancelled envelope.

    Uses QwenPaw's schema types when the host package is importable; the
    dict fallback carries the same discriminator values.
    """
    try:
        from qwenpaw.schemas import (  # type: ignore
            AgentResponse,
            Message,
            MessageType,
            Role,
            RunStatus,
            TextContent,
        )
    except Exception:  # noqa: BLE001 - standalone run without the host
        return {
            "status": "cancelled",
            "output": [
                {
                    "type": "reasoning",
                    "role": "assistant",
                    "content": [{"type": "text", "text": REASONING}],
                },
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "text", "text": ANSWER}],
                },
            ],
        }

    return AgentResponse(
        output=[
            Message(
                type=MessageType.REASONING,
                role=Role.ASSISTANT,
                content=[TextContent(type="text", text=REASONING)],
                status=RunStatus.Completed,
            ),
            Message(
                type=MessageType.MESSAGE,
                role=Role.ASSISTANT,
                content=[TextContent(type="text", text=ANSWER)],
                status=RunStatus.Cancelled,
            ),
        ],
        status=RunStatus.Cancelled,
    )


def test_stop_partial_text_is_the_answer_only():
    partial = response_partial_text(_cancelled_response())
    assert partial == ANSWER
    assert "M46-REASONING-MARKER" not in partial


def test_stop_legacy_mixed_block_shape_still_filters_thinking():
    """The pre-2.x envelope: one message, thinking/tool blocks inside it."""
    response = {
        "status": "cancelled",
        "output": [{
            "content": [
                {"type": "thinking", "thinking": "想"},
                {"type": "text", "text": "前半"},
                {"type": "tool_call"},
                {"type": "text", "text": "后半"},
            ],
        }],
    }
    assert response_partial_text(response) == "前半后半"


# --------------------------------------------------------------------------
# Protocol revision
# --------------------------------------------------------------------------

def test_protocol_version_is_13():
    assert PROTOCOL_VERSION == 13


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
